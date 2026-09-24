/**
 * FragmentCrusher — conservative dedup-style compression of *structural*
 * text fragments (work packages A2 + A3).
 *
 * Target: a block that is a SLICE of a larger document — an indented JSON
 * file read in chunks, a truncated file, a single-line minified array, a
 * key-value dump — which does not parse as a whole, so the full-document
 * compressors cannot run.
 *
 * Strategy (conservative by design rule):
 *  - decompose into rows (bracket-stack tracked for JSON-ish text; one line
 *    per row for key-value-ish text);
 *  - keep: first/last boundary rows, one instance per distinct row shape,
 *    anomaly rows (error-like content, 2σ numeric outliers), rows whose
 *    first value is unique; verbatim-duplicate rows collapse to a count;
 *  - dropped interior rows become a *counted* gap note (the model can still
 *    reason about totals);
 *  - refuse (null) unless the result is strictly smaller than the input.
 *
 * The engine stores the whole original in CCR and re-attaches the tool
 * wrapper, so every dropped byte is retrievable; and the engine never
 * re-compresses a block that already carries ctxroom markers, so a second
 * pass is a stable no-op.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const MIN_LINES = 25;
const MIN_ROWS = 15;
const BOUNDARY_KEEP = 5;
/** Max keep-set sizes at document scale; each is capped proportionally below. */
const MAX_SHAPE_EXAMPLES = 15;
const MAX_ANOMALIES = 25;
const MAX_UNIQUE_VALUES = 30;
const SHAPE_FRAC = 0.05;
const ANOMALY_FRAC = 0.1;
const UNIQUE_FRAC = 0.15;
/** Hard keep cap (headroom `max_items_after_crush`): the final keep-set is
 *  never larger than this fraction of the document, capped absolutely. */
const KEEP_CAP_ABS = 40;
const KEEP_CAP_N_FRAC = 0.25;
const MIN_STRUCT_FRAC = 0.5; // json-ish
const MIN_KV_FRAC = 0.7; // key-value-ish
const MAX_SHAPE_DIVERSITY_FRAC = 0.25;
const MIN_TOP_SHAPE_FRAC = 0.05;
const MAX_PARSE_CHARS = 512 * 1024;
const MAX_VERBATIM_FRAC = 0.35; // preamble/trailing floor
const KEEP_CAP_FRAC = 0.6; // refuse when keeping ≥ 60% (not worth the risk)

const ERRORISH_RE = /error|exception|fail|fatal|denied|refused|timeout|timed out|traceback|\b5[0-9]{2}\b/i;

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const QKEY_LINE_RE = /^\s*"(?:[^"\\]|\\.)*"\s*:(?:\s|$)/;
const KV_LINE_RE = /^\s*[\w.$-]+\s*[:=]\s*\S/;
const STRUCT_LINE_RE = /^\s*[{}\[\],]+/;
const VAL_LINE_RE = /^\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*,?\s*$/;

/** True when the line is a structural line of a JSON-ish document. */
function isJsonishLine(line: string): boolean {
  return QKEY_LINE_RE.test(line) || STRUCT_LINE_RE.test(line) || VAL_LINE_RE.test(line);
}

/** True when the line is a key-value-ish line (unquoted key + value). */
function isKvLine(line: string): boolean {
  return KV_LINE_RE.test(line) && !line.trim().startsWith('"');
}

const NUM_TOKEN_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/**
 * A line's *shape*: string values → `$V`, numbers → `$N`; keys, structure,
 * whitespace, and literals (true/false/null) survive. Two lines with the
 * same shape are "the same kind of line" with different values.
 */
export function shapeOf(line: string): string {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '"') {
      // find the string end (escape-aware)
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          closed = true;
          break;
        }
        j++;
      }
      const end = closed ? j + 1 : n;
      let k = end;
      while (k < n && (line[k] === " " || line[k] === "\t")) k++;
      out += line[k] === ":" ? line.slice(i, end) : '"$V"'; // key vs value
      i = end;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9.]/.test(line[i + 1] ?? ""))) {
      const m = NUM_TOKEN_RE.exec(line.slice(i));
      if (m) {
        out += "$N";
        i += m[0].length;
        continue;
      }
    }
    let consumed = 0;
    for (const w of ["true", "false", "null"]) {
      if (line.startsWith(w, i)) {
        out += w;
        consumed = w.length;
        break;
      }
    }
    if (consumed > 0) {
      i += consumed;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Shape statistics over a set of lines. Used for ROUTING (does this block
 * look like a repetitive structural fragment?) and for the crush decision.
 */
export interface ShapeStats {
  lines: number;
  structuralFrac: number; // json-ish fraction of non-blank lines
  kvFrac: number; // key-value fraction of non-blank lines
  distinctShapes: number;
  topShapeFrac: number;
  /** "json" | "kv" | null — null when the block is not a repetitive fragment. */
  mode: "json" | "kv" | null;
}

export function shapeStats(lines: string[]): ShapeStats {
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  const total = nonBlank.length;
  if (total === 0) return { lines: 0, structuralFrac: 0, kvFrac: 0, distinctShapes: 0, topShapeFrac: 0, mode: null };
  let struct = 0;
  let kv = 0;
  const shapeCounts = new Map<string, number>();
  for (const l of nonBlank) {
    if (isJsonishLine(l)) struct++;
    else if (isKvLine(l)) kv++;
    const s = shapeOf(l);
    shapeCounts.set(s, (shapeCounts.get(s) ?? 0) + 1);
  }
  let top = 0;
  for (const c of shapeCounts.values()) top = Math.max(top, c);
  const structuralFrac = struct / total;
  const kvFrac = kv / total;
  const distinct = shapeCounts.size;
  const topFrac = top / total;
  const diversified = distinct > Math.max(20, total * MAX_SHAPE_DIVERSITY_FRAC);
  let mode: "json" | "kv" | null = null;
  if (structuralFrac >= MIN_STRUCT_FRAC && !diversified && topFrac >= MIN_TOP_SHAPE_FRAC) mode = "json";
  else if (kvFrac >= MIN_KV_FRAC && !diversified && topFrac >= MIN_TOP_SHAPE_FRAC) mode = "kv";
  return { lines: total, structuralFrac, kvFrac, distinctShapes: distinct, topShapeFrac: topFrac, mode };
}

// ---------------------------------------------------------------------------
// Row decomposition
// ---------------------------------------------------------------------------

interface Row {
  /** First line index of the row (inclusive). */
  start: number;
  /** Last line index of the row (inclusive); -1 when the row is unbalanced. */
  end: number;
  /** True when the row's container opened AND closed inside the block. */
  complete: boolean;
}

/** Bracket characters of a line, string-aware (null = inside string / other). */
function scanBrackets(line: string): (string | null)[] {
  const out: (string | null)[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      out.push(null);
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out.push(null);
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Leading-space count. */
function indentOf(line: string): number {
  let i = 0;
  while (line[i] === " ") i++;
  return i;
}

const PURE_OPEN_RE = /^\s*[{[]\s*$/;
const PURE_CLOSE_RE = /^\s*[}\]][,]?\s*$/;

/** True when a (bracket-only) line is a one-line complete object: `{ ... }`. */
function isOneLineObject(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{") || !(t.endsWith("}") || t.endsWith("},"))) return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth === 0 && !inStr;
}

/**
 * Decompose a JSON-ish block into rows using the *sibling-run* model: a
 * container that opens on its own line and closes again at the same indent.
 *
 * This is deliberately parent-agnostic: a MIDDLE chunk of a larger document
 * (the `results` array's opening bracket was in the previous chunk) still
 * shows the record `{` / `},` sibling pattern, so chunks of any position
 * decompose identically. The row level is the indent level with the most
 * runs — for a whole top-level object that is the record level, not the root.
 */
function findJsonRows(lines: string[]): { rows: Row[]; preambleEnd: number; trailingStart: number } {
  const n = lines.length;
  const runs: { start: number; end: number; indent: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!PURE_OPEN_RE.test(lines[i])) continue;
    const d = indentOf(lines[i]);
    let j = i + 1;
    while (j < n) {
      if (indentOf(lines[j]) <= d && PURE_CLOSE_RE.test(lines[j])) break;
      j++;
    }
    if (j < n) {
      runs.push({ start: i, end: j, indent: d });
      i = j; // the close line is not a new open
    }
  }
  if (runs.length === 0) return { rows: [], preambleEnd: 0, trailingStart: n };

  // Pick the indent level with the most runs (the record level).
  const byIndent = new Map<number, number>();
  for (const r of runs) byIndent.set(r.indent, (byIndent.get(r.indent) ?? 0) + 1);
  let best = -1;
  let bestCount = 0;
  for (const [ind, c] of byIndent) {
    if (c > bestCount || (c === bestCount && ind > best)) {
      best = ind;
      bestCount = c;
    }
  }
  const rows: Row[] = runs.filter((r) => r.indent === best).map((r) => ({ start: r.start, end: r.end, complete: true }));
  const preambleEnd = rows[0].start;
  const trailingStart = rows[rows.length - 1].end + 1;
  return { rows, preambleEnd, trailingStart };
}

// ---------------------------------------------------------------------------
// The crusher
// ---------------------------------------------------------------------------

interface URow {
  text: string;
  lineStart: number;
  /** Exclusive line index past the row. */
  lineEnd: number;
  shape: string;
}

export class FragmentCrusher implements BlockCompressor {
  readonly name = "fragment-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    // Never re-crush our own output (idempotence: a second pass is a no-op).
    if (text.includes("[ctxroom:")) return null;
    // A block that parses whole belongs to the JSON compressor.
    const trimmed = text.trimStart();
    if (trimmed.length >= 200 && (trimmed[0] === "{" || trimmed[0] === "[")) {
      if (text.length < MAX_PARSE_CHARS) {
        try {
          JSON.parse(text);
          return null;
        } catch {
          /* a fragment — continue */
        }
      }
    }

    const lines = text.split(/\r?\n/);
    if (lines.length >= MIN_LINES) return this.crushLines(lines, text);
    if (text.length >= 500) return this.crushSingleLine(text);
    return null;
  }

  private crushLines(lines: string[], input: string): string | null {
    const stats = shapeStats(lines);
    if (stats.mode === null) return null;

    const rows: URow[] = [];
    let preambleEnd = 0;
    let trailingStart = lines.length;

    if (stats.mode === "json") {
      const fr = findJsonRows(lines);
      preambleEnd = fr.preambleEnd;
      trailingStart = fr.trailingStart;
      for (const r of fr.rows) {
        rows.push({
          text: lines.slice(r.start, r.end + 1).join("\n"),
          lineStart: r.start,
          lineEnd: r.end + 1,
          shape: rowShape(lines, r.start),
        });
      }
      if (rows.length < MIN_ROWS) {
        // No sibling-run rows: the only other honest granularities are
        // one-element-per-line arrays — scalars (`"a",`) or one-line objects
        // (`{...}`). Detect that; otherwise refuse (a small or
        // freshly-truncated indented document is not safe to crush, and a
        // bare field line is NOT a row).
        const nonBlank = lines.filter((l) => l.trim().length > 0);
        const elementFrac =
          nonBlank.filter((l) => VAL_LINE_RE.test(l) || isOneLineObject(l)).length / Math.max(1, nonBlank.length);
        if (elementFrac < 0.5) return null;
        rows.length = 0;
        preambleEnd = 0;
        trailingStart = lines.length;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === "") continue;
          if (isJsonishLine(lines[i]) || isKvLine(lines[i])) {
            rows.push({ text: lines[i], lineStart: i, lineEnd: i + 1, shape: shapeOf(lines[i]) });
          }
        }
      }
    } else {
      // kv-ish: one row per non-blank line.
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        rows.push({ text: lines[i], lineStart: i, lineEnd: i + 1, shape: shapeOf(lines[i]) });
      }
    }

    if (rows.length < MIN_ROWS) return null;
    const verbatim = preambleEnd + Math.max(0, lines.length - trailingStart);
    if (verbatim > lines.length * MAX_VERBATIM_FRAC) return null; // not a clean row document

    const selection = selectRows(rows);
    if (selection === null) return null;
    const keep = selection.keep;
    const { dupCollapsed, gapCount } = selection;
    const keptTotal = keep.filter(Boolean).length;

    // Render in original order. Dropped runs become a cheap "…" marker line
    // (position stays visible); the single summary note carries the counts.
    const out: string[] = [];
    let run = 0;
    let idx = 0;
    const flushGap = () => {
      if (run > 0) {
        out.push("…");
        run = 0;
      }
    };
    for (let i = 0; i < rows.length; i++) {
      while (idx < rows[i].lineStart) {
        out.push(lines[idx]); // blanks / partial-row lines between rows: verbatim
        idx++;
      }
      if (keep[i]) {
        flushGap();
        out.push(rows[i].text);
      } else {
        run++;
      }
      idx = Math.max(idx, rows[i].lineEnd);
    }
    for (; idx < lines.length; idx++) out.push(lines[idx]);
    flushGap();

    const result =
      out.join("\n") +
      `\n[ctxroom:fragment kept ${keptTotal} of ${rows.length} row(s)` +
      (dupCollapsed > 0 ? `, ${dupCollapsed} duplicate line(s) collapsed` : "") +
      (gapCount > 0 ? `; ${gapCount} row(s) omitted (see …)` : "") +
      ` — original is retrievable]`;
    if (result.length >= input.length) return null;
    return result;
  }

  /**
   * Single-line structural fragment (minified array/object, whole or
   * truncated): split on element boundaries (bracket-depth tracked,
   * string-aware) and apply the same keep logic. The join is cosmetic — the
   * engine never re-parses its own output (the marker guard), and CCR holds
   * the exact original.
   */
  private crushSingleLine(text: string): string | null {
    const trimmed = text.trimStart();
    if (!(trimmed[0] === "[" || trimmed[0] === "{")) return null;
    if (shapeStats([text]).mode === null) return null;

    const elements: string[] = [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = 1; // after the container opener
    let closed = false;
    for (let i = 1; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 1 && i + 2 < trimmed.length && trimmed[i + 1] === "," && (trimmed[i + 2] === "{" || trimmed[i + 2] === "[")) {
          elements.push(trimmed.slice(start, i + 1));
          start = i + 2;
        } else if (depth === 0) {
          elements.push(trimmed.slice(start, i + 1)); // includes the closing bracket
          start = i + 1;
          closed = true;
        }
      }
    }
    if (start < trimmed.length) elements.push(trimmed.slice(start)); // unbalanced tail (truncated)
    const body = elements.filter((e) => e.length > 0);
    if (body.length < MIN_ROWS) return null;

    const selection = selectRows(
      body.map((t) => ({ text: t, lineStart: 0, lineEnd: 1, shape: shapeOf(t) }))
    );
    if (selection === null) return null;
    const { keep, dupCollapsed } = selection;
    const keptTotal = keep.filter(Boolean).length;

    const out: string[] = [];
    let gap = 0;
    for (let i = 0; i < body.length; i++) {
      if (keep[i]) {
        if (gap > 0) {
          out.push(`…[ctxroom:omitted ${gap} element(s) — original is retrievable]…`);
          gap = 0;
        }
        out.push(body[i]);
      } else {
        gap++;
      }
    }
    if (gap > 0) out.push(`…[ctxroom:omitted ${gap} element(s) — original is retrievable]…`);

    // The last body element includes the container's closing bracket when the
    // document was whole; a truncated tail simply ends mid-element.
    let result = trimmed[0] + out.join(",");
    if (dupCollapsed > 0) result += `\n[ctxroom:fragment ${dupCollapsed} duplicate element(s) collapsed — original is retrievable]`;
    if (result.length >= text.length) return null;
    return result;
  }

  // ------------------------------------------------------------------
  // Selection + anomaly statistics
  // ------------------------------------------------------------------

  private fieldStats(rows: { text: string }[]): Map<string, { mean: number; sd: number }> {
    const sums = new Map<string, { n: number; sum: number; sumSq: number }>();
    const seen = new Map<string, number>();
    const RE = /"([\w$-]+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
    let scanned = 0;
    for (const r of rows) {
      if (scanned++ >= 2000) break;
      for (const m of r.text.matchAll(RE)) {
        const s = sums.get(m[1]) ?? { n: 0, sum: 0, sumSq: 0 };
        s.n++;
        s.sum += Number(m[2]);
        s.sumSq += Number(m[2]) ** 2;
        sums.set(m[1], s);
        seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
      }
    }
    const out = new Map<string, { mean: number; sd: number }>();
    for (const [k, s] of sums) {
      if ((seen.get(k) ?? 0) < scanned * 0.5 || s.n < 10) continue;
      const mean = s.sum / s.n;
      const sd = Math.sqrt(Math.max(0, s.sumSq / s.n - mean * mean));
      if (sd > 0) out.set(k, { mean, sd });
    }
    return out;
  }

  private isAnomaly(row: { text: string }, stats: Map<string, { mean: number; sd: number }>): boolean {
    if (ERRORISH_RE.test(row.text)) return true;
    const RE = /"([\w$-]+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
    for (const m of row.text.matchAll(RE)) {
      const s = stats.get(m[1]);
      if (!s) continue;
      if (Math.abs(Number(m[2]) - s.mean) > 2 * s.sd) return true;
    }
    return false;
  }
}

/**
 * The conservative keep-selection shared by both modes: boundaries, one
 * example per distinct shape, anomalies, unique first values; verbatim
 * duplicates collapse. Returns null when it would keep ≥ KEEP_CAP_FRAC of
 * the rows (nothing worth saving) or keep too little to be useful.
 */
function selectRows(rows: URow[]): { keep: boolean[]; dupCollapsed: number; gapCount: number } | null {
  const n = rows.length;
  // Fast path (headroom `n <= 8 → keep all`): too small to crush safely.
  if (n <= 8) return null;

  const keep = new Array<boolean>(n).fill(false);
  // Which keep-class set each index (drives the hard-cap trim order).
  const classOf = new Array<string>(n).fill("");
  const mark = (i: number, cls: string) => {
    keep[i] = true;
    classOf[i] = cls;
  };

  // Every keep-class scales with the row count (floored so a small fragment
  // still gets a useful skeleton, capped so a huge one stays lean) — modeled
  // on headroom's max_items_after_crush budget.
  const bKeep = Math.min(BOUNDARY_KEEP, Math.max(2, Math.floor(n * 0.1)));
  const shapeCap = Math.min(MAX_SHAPE_EXAMPLES, Math.max(1, Math.floor(n * SHAPE_FRAC)));
  const anomalyCap = Math.min(MAX_ANOMALIES, Math.max(1, Math.floor(n * ANOMALY_FRAC)));
  const uniqueCap = Math.min(MAX_UNIQUE_VALUES, Math.max(2, Math.floor(n * UNIQUE_FRAC)));

  for (let i = 0; i < Math.min(bKeep, n); i++) mark(i, "boundary");
  for (let i = Math.max(0, n - bKeep); i < n; i++) mark(i, "boundary");

  let shapes = 0;
  const shapeFirst = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    if (!shapeFirst.has(rows[i].shape) && shapes < shapeCap) {
      shapeFirst.set(rows[i].shape, i);
      shapes++;
      mark(i, "shape");
    }
  }

  // Anomalies need field statistics (json rows only carry quoted fields).
  const fieldStats = fieldStatsOf(rows);
  let anomalies = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    if (anomalies >= anomalyCap) break;
    if (isAnomalyRow(rows[i], fieldStats)) {
      mark(i, "anomaly");
      anomalies++;
    }
  }

  // Identity-bearing rows: unique first value.
  const seenValues = new Set<string>();
  let uniqueKept = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    if (uniqueKept >= uniqueCap) break;
    const v = firstValue(rows[i]);
    if (v === null) continue;
    if (!seenValues.has(v)) {
      seenValues.add(v);
      uniqueKept++;
      mark(i, "unique");
    }
  }

  // Verbatim duplicates collapse to a single representative — this overrides
  // every earlier keep (an identical row carries no new signal; the count
  // note carries the multiplicity). The representative is a boundary
  // occurrence when one exists, else the first.
  let dupCollapsed = 0;
  const dupMembers = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const arr = dupMembers.get(rows[i].text) ?? [];
    arr.push(i);
    dupMembers.set(rows[i].text, arr);
  }
  for (const members of dupMembers.values()) {
    if (members.length < 2) continue;
    const rep = members.find((i) => classOf[i] === "boundary") ?? members[0];
    for (const i of members) {
      if (i !== rep) {
        keep[i] = false;
        classOf[i] = "";
      }
    }
    mark(rep, classOf[rep] || "dup");
    dupCollapsed += members.length - 1;
  }

  // Hard cap (headroom `max_items_after_crush`): trim the keep-set down to
  // the budget, dropping the LEAST critical classes first — identity values,
  // then shape exemplars. Boundary anchors and anomaly rows are critical and
  // survive the trim.
  const hardCap = Math.max(bKeep * 2, Math.min(KEEP_CAP_ABS, Math.floor(n * KEEP_CAP_N_FRAC)));
  {
    let kept = keep.filter(Boolean).length;
    if (kept > hardCap) {
      for (const cls of ["unique", "shape"] as const) {
        for (let i = 0; i < n && kept > hardCap; i++) {
          if (keep[i] && classOf[i] === cls) {
            keep[i] = false;
            classOf[i] = "";
            kept--;
          }
        }
      }
    }
  }

  const keptTotal = keep.filter(Boolean).length;
  if (keptTotal >= n * KEEP_CAP_FRAC) return null;
  const gapCount = n - keptTotal;
  if (gapCount < 1) return null;
  return { keep, dupCollapsed, gapCount };
}

function fieldStatsOf(rows: URow[]): Map<string, { mean: number; sd: number }> {
  const sums = new Map<string, { n: number; sum: number; sumSq: number }>();
  const seen = new Map<string, number>();
  const RE = /"([\w$-]+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let scanned = 0;
  for (const r of rows) {
    if (scanned++ >= 2000) break;
    for (const m of r.text.matchAll(RE)) {
      const s = sums.get(m[1]) ?? { n: 0, sum: 0, sumSq: 0 };
      s.n++;
      s.sum += Number(m[2]);
      s.sumSq += Number(m[2]) ** 2;
      sums.set(m[1], s);
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
  }
  const out = new Map<string, { mean: number; sd: number }>();
  for (const [k, s] of sums) {
    if ((seen.get(k) ?? 0) < scanned * 0.5 || s.n < 10) continue;
    const mean = s.sum / s.n;
    const sd = Math.sqrt(Math.max(0, s.sumSq / s.n - mean * mean));
    if (sd > 0) out.set(k, { mean, sd });
  }
  return out;
}

function isAnomalyRow(row: URow, stats: Map<string, { mean: number; sd: number }>): boolean {
  if (ERRORISH_RE.test(row.text)) return true;
  const RE = /"([\w$-]+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of row.text.matchAll(RE)) {
    const s = stats.get(m[1]);
    if (!s) continue;
    if (Math.abs(Number(m[2]) - s.mean) > 2 * s.sd) return true;
  }
  return false;
}

/** The shape of a row's first *key* line (object rows open with a bare `{`). */
function rowShape(lines: string[], start: number): string {
  for (let i = start; i < Math.min(lines.length, start + 3); i++) {
    if (QKEY_LINE_RE.test(lines[i])) return shapeOf(lines[i]);
  }
  return shapeOf(lines[start]);
}

/** The first field value of a row (identity-bearing), or null. */
function firstValue(row: URow): string | null {
  const m = /"[\w$-]+"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/.exec(row.text);
  return m ? m[1] : null;
}

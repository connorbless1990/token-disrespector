/**
 * Tool-output wrapper detection (work package A1).
 *
 * Agent tooling does not always deliver a document as a bare document:
 *
 *   - a leading path header line
 *       /abs/path/file.json
 *       /abs/path/file.json:42        (a line or range hint)
 *       /abs/path/file.json:          (trailing-colon form)
 *       file.json (lines 1-700 of 3605)
 *   - a trailing truncation notice / pointer
 *       [Output truncated… Full output saved to /var/folders/…/copilot-tool-output-x.txt]
 *       (output truncated, 41234 chars, saved to /tmp/x.txt)
 *   - per-line "path:line:content" or "path:content" prefixes (cat -n style)
 *
 * Design rule: **compress the document, keep the wrapper honest, store the
 * whole original.** The router routes on the *inner document*; the engine
 * re-assembles the wrapper around the shrunk body; CCR stores the entire
 * original block, so retrieve() reconstructs every byte.
 *
 * Detection is conservative: a wrapper is accepted only when it is a thin
 * edge of the block (the inner document is ≥ ~90% of the bytes), so a file
 * whose *content* merely contains path-like or "truncated"-like lines is
 * never silently re-shaped.
 */

export type WrapperKind = "span" | "lines";

export interface WrapperSpec {
  kind: WrapperKind;
  /**
   * Text to emit *before* the compressed inner document. For "span": the
   * leading header line (as it appeared, including its trailing newline).
   * For "lines": the header line rendered from the detected path.
   */
  prefix: string;
  /** Text to emit *after* the compressed inner document (trailing notice). */
  suffix: string;
  /** [start, end) span of the inner document in the original (kind "span"). */
  innerStart: number;
  innerEnd: number;
  /** True when the wrapper says the tool cut the inner document. */
  truncated: boolean;
  /** The file path from the header / line prefix, when recognized. */
  path?: string;
  /** Kind "lines": whether prefixes carried a line number (path:line:content). */
  numbered?: boolean;
  /** Kind "lines": the number of content lines in the original. */
  lineCount?: number;
  /** A short honest note for the replacement (kind "lines"). */
  note?: string;
  /** The inner document ready for routing (span slice, or de-prefixed lines). */
  inner: string;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A path token: absolute (any segment depth), relative-with-slash, or a filename with an extension. */
const PATH_TOKEN = String.raw`(?:/[A-Za-z0-9_.$@+-]+(?:/[A-Za-z0-9_.$@+-]+)*|[A-Za-z0-9_.$@+-]+(?:/[A-Za-z0-9_.$@+-]+)+|[A-Za-z0-9_.$-]+\.[A-Za-z0-9]{1,8})`;

/**
 * A header line: a path token, optionally followed by a line/range hint or a
 * "lines N-M of T" annotation. Nothing else.
 */
const HEADER_RE = new RegExp(
  `^(${PATH_TOKEN})` +
    `(?:` +
    `:\\d{1,7}(?:-\\d{1,7})?` + // :42 or :42-700
    `|[\\s(][\\s(]?[A-Za-z0-9_.$@+/\\ -]*\\d[A-Za-z0-9_.$@+/\\ -]*[).]?` + // (lines 1-700 of 3605) etc.
    `|:` + // bare trailing colon ("path:" form)
    `)?$`
);

/** A trailing truncation / pointer notice line. */
function isNoticeLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 400) return false;
  if (/copilot-tool-output/i.test(t)) return true;
  if (/\btruncat\w*\b/i.test(t) && /output|…|\.{3}|chars?|lines?|bytes?/i.test(t)) return true;
  if (/\b(full|complete|entire)\s+output\b/i.test(t)) return true;
  if (/\bsaved\s+(to|in)\s+\S/i.test(t)) return true;
  return false;
}

/** True when a path token looks like a path (has a slash or an extension). */
function isPathLike(token: string): boolean {
  if (token.includes("/")) return true;
  const dot = token.lastIndexOf(".");
  return dot > 0 && dot < token.length - 1 && /^[A-Za-z0-9_.$@-]+$/.test(token);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const MIN_INNER_FRACTION = 0.9;
const MAX_NOTICE_LINES = 40;

/**
 * Detect a tool-output wrapper. Returns null when the block does not look
 * wrapped (or the wrapper would swallow too much of the block).
 */
/** Start offset of line `i` in `text` (0 for the first line). */
function lineStart(text: string, lines: string[], i: number): number {
  if (i <= 0) return 0;
  let pos = 0;
  for (let k = 0; k < i; k++) pos += lines[k].length + 1;
  return pos;
}

export function detectWrapper(text: string): WrapperSpec | null {
  if (text.length < 200) return null;
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  // --- trailing notice run (walk from the bottom up) -------------------------
  let end = text.length;
  let suffix = "";
  let sawNotice = false;
  {
    let pos = text.length;
    let seen = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t === "") {
        if (seen > 0) {
          pos = lineStart(text, lines, i); // trailing blanks ride the suffix
          continue;
        }
        break;
      }
      if (isNoticeLine(lines[i])) {
        pos = lineStart(text, lines, i);
        seen++;
        if (seen > MAX_NOTICE_LINES) break;
        continue;
      }
      break;
    }
    if (seen > 0) {
      // The separating newline belongs to the SUFFIX: compressor output may
      // not end in a newline, but the notice must never glue onto the last
      // content line. Inner ends just before the separator.
      const sep = pos > 0 ? pos - 1 : 0;
      end = sep;
      suffix = text.slice(sep);
      sawNotice = true;
    }
  }

  // --- leading header line -----------------------------------------------------
  let start = 0;
  let headerPath: string | undefined;
  let hasHeader = false;
  if (lines[0].trim() !== "" && text.length > Math.max(400, lines[0].length + 200)) {
    const hm = HEADER_RE.exec(lines[0].trim());
    if (hm && isPathLike(hm[1])) {
      const nl = text.indexOf("\n");
      if (nl !== -1) {
        start = nl + 1;
        hasHeader = true;
        headerPath = hm[1];
      }
    }
  }

  if (!hasHeader && !sawNotice) return null; // not wrapped at all

  const inner = text.slice(start, end);
  if (inner.length < text.length * MIN_INNER_FRACTION) return null; // wrapper too fat

  return {
    kind: "span",
    prefix: text.slice(0, start),
    suffix,
    innerStart: start,
    innerEnd: end,
    truncated: sawNotice,
    path: headerPath,
    inner,
  };
}

// ---------------------------------------------------------------------------
// Per-line prefixes (cat -n / single-file "path:content")
// ---------------------------------------------------------------------------

const NUMBERED_PREFIX_RE = /^(\S+?):(\d{1,7}):(.*)$/;
const PLAIN_PREFIX_RE = /^(\S+?):(.+)$/;

/**
 * Detect per-line path prefixes (cat -n / single-file "path:content" form).
 * Requires the SAME path on ≥ 90% of non-blank lines (a ripgrep-style dump
 * has a different path per match — that is the search shape, not a wrapper).
 * Returns a spec whose `inner` is the de-prefixed document, ready for routing.
 */
export function detectLinePrefixes(text: string): WrapperSpec | null {
  if (text.length < 200) return null;
  const lines = text.split("\n");
  if (lines.length < 20) return null;
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length < 20) return null;

  // Pass 1: classify the dominant prefix form (numbered beats plain when both
  // occur, because a numbered match also satisfies the plain shape).
  let numberedHits = 0;
  let plainHits = 0;
  for (const l of nonBlank) {
    if (NUMBERED_PREFIX_RE.test(l)) numberedHits++;
    else if (PLAIN_PREFIX_RE.test(l)) plainHits++;
  }
  const numbered = numberedHits >= plainHits && numberedHits > 0;
  if (numberedHits + plainHits < nonBlank.length * 0.9) return null;

  // Pass 2: collect the path and de-prefix.
  const paths = new Map<string, number>();
  const deprefixed: string[] = [];
  let matched = 0;
  for (const l of lines) {
    if (l.trim() === "") {
      deprefixed.push(l);
      continue;
    }
    const m = (numbered ? NUMBERED_PREFIX_RE : PLAIN_PREFIX_RE).exec(l);
    if (!m) {
      deprefixed.push(l); // will fail the 90% rule
      continue;
    }
    const p = m[1];
    if (!isPathLike(p)) {
      deprefixed.push(l);
      continue;
    }
    paths.set(p, (paths.get(p) ?? 0) + 1);
    matched++;
    deprefixed.push(m[3] ?? m[2] ?? "");
  }

  if (matched < nonBlank.length * 0.9) return null; // not a single-file prefixing
  let dominant: string | null = null;
  let dominantCount = 0;
  for (const [p, c] of paths) {
    if (c > dominantCount) {
      dominant = p;
      dominantCount = c;
    }
  }
  if (!dominant || dominantCount < matched * 0.95) return null; // multi-file → search shape

  const inner = deprefixed.join("\n");
  if (inner.length < text.length * 0.5) return null; // the prefixes WERE the document

  // The engine emits: header line + compressed document + honest note. CCR
  // keeps the exact original (with prefixes), so retrieve is byte-exact.
  return {
    kind: "lines",
    prefix: `${dominant}\n`,
    suffix: "",
    innerStart: 0,
    innerEnd: 0,
    truncated: false,
    path: dominant,
    numbered,
    lineCount: lines.length,
    note: `[ctxroom:stripped ${numbered ? "path:line:" : "path:"} prefixes (${lines.length} lines in the original); original is retrievable]`,
    inner,
  };
}

/**
 * Full wrapper detection: the thin span wrapper first (read-tool form), then
 * per-line prefixes (cat -n form). The span form wins when both are present
 * (a header line is the outermost wrapper).
 */
export function detectAnyWrapper(text: string): WrapperSpec | null {
  const span = detectWrapper(text);
  if (span) return span;
  return detectLinePrefixes(text);
}

/**
 * Re-attach the wrapper around a compressed inner document:
 *   span  → header + body + trailing notice (exactly the original layout)
 *   lines → header line + body + honest "prefixes stripped" note
 */
export function reassembleWrapper(spec: WrapperSpec, body: string): string {
  if (spec.kind === "span") {
    return spec.prefix + body + spec.suffix;
  }
  return spec.prefix + body + (spec.note ? `\n${spec.note}` : "");
}

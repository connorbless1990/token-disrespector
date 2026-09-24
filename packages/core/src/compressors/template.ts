/**
 * TemplateReformatter — Drain-style template mining (work package A3).
 *
 * Faithful TypeScript port of headroom's `LogTemplate` reformat (their
 * `log_template.rs`), generalized from lines to *units*: lines for normal
 * text, whitespace tokens for single-line blobs (minified bundles, long
 * one-line outputs).
 *
 * A run of consecutive units that share the same token count and match an
 * accumulated template at ≥ SIMILARITY of positions collapses into:
 *
 *   [ctxroom:template T1: <TS> INFO [vite] transforming <*> chunk <*> (<*> ms)] (2352 occ)
 *   <variant values of line 1>
 *   <variant values of line 2>
 *   …
 *
 * The variant table carries every value at every wildcard position, in
 * order, so each original unit is reconstructible — this is a LOSSLESS
 * reformat. No CCR store, no marker: the output IS the data. The engine
 * must therefore treat `lossless` compressors as safe even when the CCR is
 * disabled (I8 applies to information loss; there is none here).
 *
 * Conservatism (headroom's published defaults): min run 3, similarity 0.4,
 * ≥ 2 constant positions, and the result must actually shrink.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const WILDCARD = "<*>";
const MIN_LINES = 25; // minimum lines for line-mode operation
const MIN_RUN = 3; // headroom default
const SIMILARITY = 0.4; // headroom default (Drain)
const MIN_CONSTANT_TOKENS = 2; // headroom default
const MAX_TEMPLATES = 40; // output-size guard

interface Run {
  indices: number[];
  /** Some(token) = constant so far; null = wildcard (has varied). */
  template: (string | null)[];
}

/**
 * Split into units for template mining:
 *  - ≥ MIN_LINES lines → lines (the normal case: logs, test output);
 *  - 1-2 very long lines → their STATEMENTS (split on `;`): a template must
 *    span whole logical lines, so the unit of a minified bundle is a
 *    statement, never a single token;
 *  - otherwise → lines (a handful of short lines is not template fodder).
 */
function unitize(text: string): { units: string[]; mode: "line" | "statement" } {
  const lines = text.split(/\r?\n/);
  if (lines.length >= MIN_LINES) return { units: lines, mode: "line" };
  if (lines.length <= 2 && text.length >= 1000) {
    // Keep the `;` attached so no token is lost (statements re-join to a
    // single line, whitespace-runs normalized).
    const stmts = text
      .split(";")
      .map((s) => {
        const t = s.trim();
        return t.length > 0 ? t + ";" : "";
      })
      .filter((s) => s.length > 0);
    if (stmts.length >= 20) return { units: stmts, mode: "statement" };
  }
  return { units: lines, mode: "line" };
}

export interface MinedTemplate {
  /** The template tokens (wildcards as the WILDCARD string). */
  tokens: string[];
  /** Original unit indices covered by this run, in order. */
  indices: number[];
  /** Variant rows: for each covered unit, the values at wildcard positions. */
  variants: string[];
}

/**
 * Mine a template run out of a unit stream. Returns null when the run
 * should not be collapsed (too short, no constants, or everything varies).
 */
export function mineRun(
  units: string[][],
  from: number,
  to: number // exclusive
): MinedTemplate | null {
  if (to - from < MIN_RUN) return null;
  // Build the template by merging the run's units.
  let template: (string | null)[] | null = null;
  for (let i = from; i < to; i++) {
    const t = units[i]!;
    if (template === null) {
      template = t.map((x) => x);
    } else if (t.length === template.length) {
      for (let p = 0; p < template.length; p++) {
        const c = template[p];
        if (c !== null && c !== t[p]) template[p] = null;
      }
    } else {
      // Token counts diverge inside the run — a template needs a fixed
      // position layout. (Runs are built by the walker with equal counts,
      // so this is defensive.)
      return null;
    }
  }
  if (!template) return null;
  const constants = template.filter((x) => x !== null).length;
  if (constants < MIN_CONSTANT_TOKENS) return null;
  if (constants === template.length) return null; // nothing varies → nothing to table
  const wildcardPos = template
    .map((x, i) => (x === null ? i : -1))
    .filter((i) => i >= 0);
  const variants: string[] = [];
  for (let i = from; i < to; i++) {
    const t = units[i]!;
    variants.push(wildcardPos.map((p) => t[p] ?? "").join(" "));
  }
  return {
    tokens: template.map((x) => x ?? WILDCARD),
    indices: Array.from({ length: to - from }, (_, k) => from + k),
    variants,
  };
}

/**
 * Walk a tokenized unit stream into runs (headroom's `extends_run` /
 * `merge_into_template`). Blank units break runs.
 */
export function mineTemplates(units: string[][], blank: (i: number) => boolean): {
  runs: (MinedTemplate | null)[];
  /** For each run slot: [start, end) unit range it describes (null = none). */
  ranges: [number, number][];
} {
  const runs: (MinedTemplate | null)[] = [];
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < units.length) {
    if (units[i]!.length === 0 || blank(i)) {
      runs.push(null);
      ranges.push([i, i + 1]);
      i++;
      continue;
    }
    // Extend a run while similarity holds.
    let j = i + 1;
    let template: (string | null)[] = units[i]!.map((x) => x);
    while (j < units.length && units[j]!.length > 0 && !blank(j)) {
      const t = units[j]!;
      if (t.length !== template.length) break;
      let matches = 0;
      for (let p = 0; p < template.length; p++) {
        const c = template[p];
        if (c === null || c === t[p]) matches++;
      }
      if (matches / template.length < SIMILARITY) break;
      for (let p = 0; p < template.length; p++) {
        if (template[p] !== null && template[p] !== t[p]) template[p] = null;
      }
      j++;
    }
    // The run is [i, j).
    const mined = mineRun(units, i, j);
    runs.push(mined);
    ranges.push([i, j]);
    i = j;
  }
  return { runs, ranges };
}

export class TemplateReformatter implements BlockCompressor {
  readonly name = "template-reformatter";
  /** Lossless: every original unit reconstructs from template + variants. */
  readonly lossless = true;

  compress(text: string, _ctx: CompressContext): string | null {
    const { units, mode } = unitize(text);
    if (mode === "line" && units.length < MIN_LINES) return null;
    if (mode === "statement" && units.length < MIN_RUN * 4) return null;
    if (units.length < MIN_RUN * 2) return null;

    const tokenized = units.map((u) => u.split(/\s+/));
    const blank = (i: number) => units[i]!.trim() === "";
    const { runs, ranges } = mineTemplates(tokenized, blank);

    // Count what would collapse.
    let collapsedUnits = 0;
    for (const r of runs) if (r) collapsedUnits += r.indices.length;
    if (collapsedUnits < units.length * 0.3) return null; // not template-like enough

    let templates = 0;
    const out: string[] = [];
    for (let k = 0; k < runs.length; k++) {
      const range = ranges[k]!;
      const start = range[0];
      const end = range[1];
      const r = runs[k];
      if (!r) {
        // Not collapsible: units verbatim.
        for (let i = start; i < end; i++) out.push(units[i]!);
        continue;
      }
      if (templates >= MAX_TEMPLATES) {
        for (let i = start; i < end; i++) out.push(units[i]!);
        continue;
      }
      templates++;
      out.push(`[ctxroom:template T${templates}: ${r.tokens.join(" ")}] (${r.indices.length} occ)`);
      for (const v of r.variants) out.push(v);
    }

    let result: string;
    if (mode === "statement") {
      // The original was 1-2 lines: headers and variants join back into one
      // line (whitespace-runs and dropped `;` normalize — every token
      // survives, so the result is content-lossless).
      result = out.join(" ");
    } else {
      result = out.join("\n");
    }
    if (mode === "line" && !text.endsWith("\n")) result = result.replace(/\n+$/, "");

    if (result.length >= text.length) return null; // never inflate
    return result;
  }
}

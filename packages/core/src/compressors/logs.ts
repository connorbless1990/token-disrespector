/**
 * LogCrusher — build/test/run log compression (v3, work package A3).
 *
 * A faithful structural port of headroom's `LogCompressor` selection
 * (their `log_compressor.rs`), combined with the Drain template miner
 * (template.ts, port of their `LogTemplate` reformat):
 *
 *   1. TEMPLATE RUNS — Drain mining groups consecutive similar lines into
 *      template + variant runs; each run gets a header line naming the
 *      shape of what was dropped.
 *   2. BUCKETED SELECTION (headroom's `select_lines`):
 *        errors:   dedupe by normalized line → first 8 + last 2 of ≤10
 *        warnings: dedupe by normalized line → first 5
 *        context:  ±3 around selected lines, but never re-ridable lines
 *                  (lines inside a collapsed template run) — headroom's
 *                  "deliberately-collapsed lines must not ride back in"
 *        head/tail: first 3 + last 3 always
 *   3. GLOBAL CAP — the selection is capped at 100 lines (their
 *      `max_total_lines`); over-cap context is dropped before signal.
 *   4. BLOAT GATE — if the result would be ≥ 50% of the input (their
 *      `min_compression_ratio_for_ccr`), refuse (null): the CCR marker
 *      overhead is not worth it, and the router falls through.
 *
 * The whole original goes to the CCR via the engine marker (lossy); RLE
 * of consecutive volatile-identical kept lines and a level tally finish
 * the render. Deterministic; refuses to grow (I3).
 */
import type { BlockCompressor, CompressContext } from "../types.ts";
import { mineTemplates } from "./template.ts";

/** Strong signal: error-class words (headroom's Error/Fail levels). */
const ERROR_RE =
  /\b(error|err|fatal|panic|exception|failure|failed|fail|denied|refused|timeout|timed out|traceback|segmentation|unhandled|cannot|unable|npm ERR!|pytest|assertion|segmentation fault)\b/i;
/** Weak signal: warning-class words (headroom's Warn level). */
const WARN_RE = /\b(warn|warning)\b/i;
const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRIT)\b/i;
// Bare digit runs (no \b): values glued to letters (`69%`, `.550Z`,
// `file12.ts`) must still normalize, or dedupe keys diverge per line.
const VOLATILE_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d+]*Z?|0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/g;

// Headroom LogCompressorConfig defaults.
const MIN_LINES = 25;
const MAX_ERRORS = 10;
const MAX_WARNINGS = 5;
const CONTEXT_LINES = 3;
const MAX_TOTAL_LINES = 100;
const BLOAT_GATE = 0.5; // min_compression_ratio_for_ccr

export class LogCrusher implements BlockCompressor {
  readonly name = "log-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    const lines = text.split(/\r?\n/);
    if (lines.length < MIN_LINES) return null;

    // 1. Template runs: which lines are repetitive noise, and where each
    //    run starts (for the header + the no-ride-back guard).
    const tokenized = lines.map((l) => l.split(/\s+/));
    const { runs, ranges } = mineTemplates(tokenized, (i) => lines[i]!.trim() === "");
    const inRun = new Array<boolean>(lines.length).fill(false);
    const runStartHeader = new Map<number, string>();
    let collapsedRuns = 0;
    let collapsedLines = 0;
    let tid = 0;
    for (let k = 0; k < runs.length; k++) {
      const run = runs[k];
      if (!run) continue;
      const [start, end] = ranges[k]!;
      const n = end - start;
      // Collapse only when retention would actually save: a run whose
      // lines are mostly signals is better kept verbatim.
      let strong = 0;
      for (let i = start; i < end; i++) if (ERROR_RE.test(lines[i]!)) strong++;
      if (Math.min(n, strong + 6) >= n * 0.7) continue;
      collapsedRuns++;
      collapsedLines += n;
      tid++;
      for (let i = start; i < end; i++) inRun[i] = true;
      runStartHeader.set(
        start,
        `[ctxroom:template T${tid}: ${run.tokens.join(" ")}] (${n} line(s))`
      );
    }

    // 2. Bucketed selection (headroom select_lines).
    const errors: number[] = [];
    const warnings: number[] = [];
    {
      const seen = new Set<string>();
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        const key = normalizeForDedupe(l);
        if (ERROR_RE.test(l)) {
          if (!seen.has(key)) {
            seen.add(key);
            errors.push(i);
          }
        } else if (WARN_RE.test(l)) {
          if (!seen.has(key)) {
            seen.add(key);
            warnings.push(i);
          }
        }
      }
    }
    // first 8 + last 2 of the (deduped) errors — deterministic stand-in for
    // headroom's score fill.
    const selected = new Set<number>();
    const head = errors.slice(0, 8);
    const tail = errors.slice(-2);
    for (const i of [...head, ...tail].slice(0, MAX_ERRORS)) selected.add(i);
    for (const i of warnings.slice(0, MAX_WARNINGS)) selected.add(i);

    // 3. Context ±3 around selected lines — deliberately-collapsed lines
    //    (inside a template run) must not ride back in as context.
    for (const i of [...selected].sort((a, b) => a - b)) {
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
        if (!inRun[j]) selected.add(j);
      }
    }
    // Head and tail of the whole log.
    for (let i = 0; i < Math.min(3, lines.length); i++) selected.add(i);
    for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) selected.add(i);

    // 4. Global cap (headroom max_total_lines): drop context before signal,
    //    keeping the ends of the context list and trimming the middle.
    if (selected.size > MAX_TOTAL_LINES) {
      const signal = [...selected]
        .filter((i) => errors.includes(i) || warnings.includes(i))
        .sort((a, b) => a - b);
      const context = [...selected]
        .filter((i) => !signal.includes(i))
        .sort((a, b) => a - b);
      const keepCtx = Math.max(0, MAX_TOTAL_LINES - signal.length);
      const keepSet = new Set(signal);
      const half = Math.floor(keepCtx / 2);
      for (let k = 0; k < context.length; k++) {
        if (k < half || k >= context.length - (keepCtx - half)) keepSet.add(context[k]!);
      }
      selected.clear();
      for (const i of keepSet) selected.add(i);
    }

    // Render: kept runs (RLE of volatile-identical), gap notes, template
    // headers at run starts, level tally, template summary, bloat gate.
    const keep = new Array<boolean>(lines.length);
    for (let i = 0; i < lines.length; i++) keep[i] = selected.has(i);

    const out: string[] = [];
    let i = 0;
    let gapNote = 0;
    while (i < lines.length) {
      if (keep[i]) {
        const header = runStartHeader.get(i);
        if (header) out.push(header);
        let j = i + 1;
        const norm = normalizeVolatiles(lines[i]);
        while (j < lines.length && keep[j] && normalizeVolatiles(lines[j]) === norm) j++;
        if (j - i > 1) {
          out.push(`${lines[i]}  … ×${j - i}`);
          gapNote++;
        } else {
          out.push(lines[i]);
        }
        i = j;
      } else {
        let j = i;
        while (j < lines.length && !keep[j]) j++;
        const omitted = j - i;
        if (omitted > 0) {
          out.push(`… ${omitted} line(s) omitted`);
          gapNote++;
          for (let s = i; s < j; s++) {
            const h = runStartHeader.get(s);
            if (h) out.push(h);
          }
        }
        i = j;
      }
    }

    const levels: Record<string, number> = {};
    for (const l of lines) {
      const m = LEVEL_RE.exec(l);
      if (m) levels[m[1].toUpperCase()] = (levels[m[1].toUpperCase()] ?? 0) + 1;
    }
    const tally = Object.entries(levels)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" ");
    let result =
      out.join("\n") +
      (tally ? `\n[ctxroom:log-levels ${tally}${gapNote ? `; ${gapNote} collapsed run(s)` : ""}]` : "");
    if (collapsedRuns > 0) {
      result += `\n[ctxroom:log-templates ${collapsedRuns} template(s) covering ${collapsedLines} of ${lines.length} lines — original is retrievable]`;
    }
    if (!text.endsWith("\n")) result = result.replace(/\n+$/, "");

    // Bloat gate (headroom min_compression_ratio_for_ccr): if the result is
    // ≥ 50% of the input, the marker overhead isn't worth it → refuse and
    // let the router try the next candidate.
    if (result.length / text.length >= BLOAT_GATE) return null;
    return result;
  }
}

/**
 * Volatile normalization (headroom `normalize_for_dedupe`): every digit
 * run — timestamps, counts, percentages, line numbers, even digits glued
 * to letters — becomes `#`, so the same error category at different values
 * merges for dedupe/RLE, while word tokens (property names, messages) stay
 * distinct so two different error categories never merge. Used both for
 * dedupe keys and RLE of consecutive lines.
 */
export function normalizeForDedupe(line: string): string {
  return line.replace(VOLATILE_RE, "#").replace(/\s+/g, " ").trim();
}

/** Alias of normalizeForDedupe (RLE of consecutive lines). */
export function normalizeVolatiles(line: string): string {
  return normalizeForDedupe(line);
}

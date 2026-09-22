/**
 * LogCrusher — build/test/run log compression.
 *
 * Preservation rules:
 *  - ERROR/WARN/FATAL/panic/exception/fail lines and ≤3 lines of context
 *    around each (deduplicated);
 *  - first and last lines of the log;
 *  - consecutive repeated lines (after normalizing volatile numbers and
 *    timestamps) collapse to a `… ×N` count;
 *  - a per-level tally is appended.
 *
 * Headroom measures ~85–95% on clustered-error logs; we keep the same
 * contract and refuse (null) when the result would not shrink.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const SIGNAL_RE =
  /\b(error|err|fatal|panic|exception|warn|failure|failed|fail|denied|refused|timeout|timed out|traceback|segmentation|unhandled|cannot|unable|e2e|npm ERR!|pytest|assertion)\b/i;
const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRIT)\b/i;
const VOLATILE_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d+]*Z?|\b0x[0-9a-f]+\b|\b\d{4,}\b|\b\d+(\.\d+)?\b)/g;

const CONTEXT_LINES = 3;
const MIN_LINES = 25;
const MAX_SIGNALS = 120;

export class LogCrusher implements BlockCompressor {
  readonly name = "log-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    const lines = text.split(/\r?\n/);
    if (lines.length < MIN_LINES) return null;

    // Quick reject: logs with almost no signal compress to almost nothing —
    // verify there is enough signal to survive, otherwise we'd keep only the
    // head/tail and lose whatever the user actually asked about.
    let signalCount = 0;
    for (const l of lines) if (SIGNAL_RE.test(l)) signalCount++;
    if (signalCount === 0 && lines.length < 60) return null;

    const keep = new Array<boolean>(lines.length).fill(false);
    const levels: Record<string, number> = {};

    for (let i = 0; i < lines.length; i++) {
      const m = LEVEL_RE.exec(lines[i]);
      if (m) levels[m[1].toUpperCase()] = (levels[m[1].toUpperCase()] ?? 0) + 1;
      if (SIGNAL_RE.test(lines[i])) {
        keep[i] = true;
      }
    }

    // Context windows around signals (bounded total).
    let windows = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!keep[i]) continue;
      if (windows > MAX_SIGNALS) break;
      windows++;
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
        keep[j] = true;
      }
    }

    // Head and tail.
    for (let i = 0; i < Math.min(3, lines.length); i++) keep[i] = true;
    for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) keep[i] = true;

    // Collapse consecutive non-signal runs into a single gap line, and
    // identical consecutive lines into a count.
    const out: string[] = [];
    let i = 0;
    let gapNote = 0;
    while (i < lines.length) {
      if (keep[i]) {
        // run of consecutive identical lines
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
        out.push(`… ${j - i} line(s) omitted`);
        i = j;
      }
    }

    const tally = Object.entries(levels)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" ");
    const result =
      out.join("\n") +
      (tally ? `\n[ctxroom:log-levels ${tally}${gapNote ? `; ${gapNote} repeated run(s) collapsed` : ""}]` : "");

    if (result.length >= text.length) return null;
    return result;
  }
}

/** Normalize volatile tokens so "repeated" detection works across timestamps/addresses. */
export function normalizeVolatiles(line: string): string {
  return line.replace(VOLATILE_RE, "#").replace(/\s+/g, " ").trim();
}

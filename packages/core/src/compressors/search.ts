/**
 * SearchCrusher — grep/ripgrep-style `path:line:content` result dumps.
 *
 * Headroom measures 80–95% on ripgrep-style corpora. We reproduce the
 * contract: every `path:line` reference survives; the content column is what
 * gets trimmed; per-file tallies; referenced files (named in the latest user
 * message) are never dropped from the results.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const MATCH_RE = /^(\S+):(\d{1,7})(?::|\t)(.*)$/;
const MAX_MATCH_CONTENT = 120;
const MAX_MATCHES_PER_FILE = 15;
const MIN_MATCHES = 10;

interface Match {
  path: string;
  line: number;
  content: string;
  referenced: boolean;
}

export class SearchCrusher implements BlockCompressor {
  readonly name = "search-crusher";

  compress(text: string, ctx: CompressContext): string | null {
    const lines = text.split(/\r?\n/);
    const matches: Match[] = [];
    let nonMatchLines = 0;
    for (const l of lines) {
      const m = MATCH_RE.exec(l);
      if (m) {
        const referenced = ctx.referencedPaths.some((p) => p && m[1].includes(p));
        matches.push({ path: m[1], line: Number(m[2]), content: m[3] ?? "", referenced });
      } else if (l.trim().length > 0) {
        nonMatchLines++;
      }
    }
    // Must be predominantly match lines to qualify.
    if (matches.length < MIN_MATCHES || nonMatchLines > matches.length * 0.25) return null;

    const byFile = new Map<string, Match[]>();
    for (const m of matches) {
      const arr = byFile.get(m.path);
      if (arr) arr.push(m);
      else byFile.set(m.path, [m]);
    }

    const out: string[] = [];
    let droppedTotal = 0;
    // Deterministic order: original file first-appearance order.
    const files: string[] = [];
    for (const m of matches) if (!files.includes(m.path)) files.push(m.path);

    for (const file of files) {
      const ms = byFile.get(file)!;
      // Dedupe identical content within a file (common: same import line hit many places).
      const seen = new Set<string>();
      const unique = ms.filter((m) => {
        const k = m.content.trim();
        if (!k) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const dups = ms.length - unique.length;

      const keep: Match[] = [];
      for (const m of unique) {
        if (m.referenced || keep.length < MAX_MATCHES_PER_FILE) keep.push(m);
        else droppedTotal++;
      }
      // Referenced files are exempt from the per-file cap entirely.
      if (unique.every((m) => m.referenced)) droppedTotal -= Math.max(0, unique.length - MAX_MATCHES_PER_FILE);

      for (const m of keep) {
        const c = m.content.length > MAX_MATCH_CONTENT ? m.content.slice(0, MAX_MATCH_CONTENT) + "…" : m.content;
        out.push(`${m.path}:${m.line}:${c}`);
      }
      const extras = dups + Math.max(0, unique.length - keep.length);
      if (extras > 0) out.push(`${file}: (… ${extras} more match(es) omitted)`);
    }

    const result =
      out.join("\n") +
      (droppedTotal > 0 ? `\n[ctxroom:kept all matches in ${files.filter((f) => byFile.get(f)!.some((m) => m.referenced)).length || 0} referenced file(s); ${droppedTotal} match line(s) trimmed/dropped]` : "");

    if (result.length >= text.length) return null;
    return result;
  }
}

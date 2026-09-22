/**
 * DiffCrusher — unified diff compression.
 *
 * Preservation: every file header and hunk header survives; all added/removed
 * lines (the actual change) survive; unchanged context is collapsed; in
 * multi-file diffs the largest files are kept whole and the rest reduced to
 * a header + change tally. Headroom measures ~60–80%; we match the contract.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_RE = /^diff --git /;
const MAX_CONTEXT = 3;
const MAX_FILES = 12;

interface Hunk {
  header: string;
  lines: string[];
  changed: number;
}
interface File {
  name: string;
  lines: string[];
  changed: number;
}

export class DiffCrusher implements BlockCompressor {
  readonly name = "diff-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    const lines = text.split(/\r?\n/);
    if (lines.length < 40) return null;
    const files = this.parseFiles(lines);
    if (files.length === 0 || files.every((f) => f.changed === 0)) return null;

    // Rank by change size; keep the largest whole, reduce the rest.
    const ranked = [...files].sort((a, b) => b.changed - a.changed);
    const keepWhole = new Set(ranked.slice(0, MAX_FILES));

    const out: string[] = [];
    for (const f of files) {
      if (keepWhole.has(f)) {
        out.push(...this.renderFile(f, true));
      } else {
        const name = f.name || "(unnamed)";
        out.push(`diff --git ${name} ${name}  [ctxroom: ${f.changed} changed line(s), ${f.lines.length} line(s) omitted]`);
      }
    }
    const result = out.join("\n");
    if (result.length >= text.length) return null;
    return result;
  }

  private parseFiles(lines: string[]): File[] {
    const files: File[] = [];
    let cur: File | null = null;
    let hunk: Hunk | null = null;
    let inHeader = false;

    for (const line of lines) {
      if (FILE_RE.test(line) || (/^--- /.test(line) && !cur)) {
        if (cur) {
          this.closeHunk(cur, hunk);
          hunk = null;
          files.push(cur);
        }
        const name = FILE_RE.test(line)
          ? line
              .replace(/^diff --git /, "")
              .split(" ")
              .map((s) => s.replace(/^a\//, ""))
              .filter((s, i, a) => a.indexOf(s) === i)
              .join(" ")
          : line.replace(/^--- /, "").replace(/^b\//, "");
        cur = { name, lines: [], changed: 0 };
        hunk = null;
        inHeader = true;
        cur.lines.push(line);
        continue;
      }
      if (!cur) {
        // preamble lines before the first file header
        cur = { name: "", lines: [line], changed: 0 };
        continue;
      }
      if (inHeader && (/^\+\+\+ /.test(line) || /^index /.test(line) || /^--- /.test(line))) {
        cur.lines.push(line);
        if (/^\+\+\+ /.test(line)) inHeader = false;
        continue;
      }
      inHeader = false;
      const hm = HUNK_RE.exec(line);
      if (hm) {
        this.closeHunk(cur, hunk);
        hunk = { header: line, lines: [], changed: 0 };
        cur.lines.push(line);
        continue;
      }
      if (hunk) {
        const isChange = line.startsWith("+") || line.startsWith("-");
        if (isChange && !line.startsWith("+++") && !line.startsWith("---")) {
          hunk.changed++;
          cur.changed++;
        }
        hunk.lines.push(line);
      } else {
        cur.lines.push(line);
      }
    }
    if (cur) {
      this.closeHunk(cur, hunk);
      files.push(cur);
    }
    // Re-attach hunks (kept in order during parse via cur.lines push of header only)
    return files;
  }

  private closeHunk(file: File, hunk: Hunk | null): void {
    if (!hunk) return;
    file.lines.push(...hunk.lines);
  }

  private renderFile(f: File, whole: boolean): string[] {
    const out: string[] = [];
    let i = 0;
    const lines = f.lines;
    while (i < lines.length) {
      const line = lines[i];
      if (HUNK_RE.test(line)) {
        out.push(line);
        i++;
        // hunk body: keep changes, collapse long context runs
        let contextRun: string[] = [];
        while (i < lines.length && !HUNK_RE.test(lines[i]) && !FILE_RE.test(lines[i])) {
          const l = lines[i];
          const isChange =
            (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---");
          if (isChange) {
            if (contextRun.length > 0) out.push(...this.collapseContext(contextRun));
            out.push(l);
            contextRun = [];
          } else {
            contextRun.push(l);
          }
          i++;
        }
        if (contextRun.length > 0) out.push(...this.collapseContext(contextRun));
      } else {
        out.push(line);
        i++;
      }
    }
    if (!whole && out.length > 40) {
      // safety: if a "reduced" file rendered large, trim its body
      const head = out.slice(0, 12);
      return [...head, `[ctxroom: ${out.length - head.length} diff line(s) omitted]`];
    }
    return out;
  }

  private collapseContext(run: string[]): string[] {
    if (run.length <= MAX_CONTEXT * 2) return run;
    const head = run.slice(0, MAX_CONTEXT);
    const tail = run.slice(-MAX_CONTEXT);
    const omitted = run.length - head.length - tail.length;
    return [...head, `… ${omitted} context line(s) omitted`, ...tail];
  }
}

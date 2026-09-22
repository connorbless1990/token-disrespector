/**
 * CodeCompressor — heuristic AST-approximation compression for source code
 * (v1; a tree-sitter WASM implementation is the v1.1 upgrade path).
 *
 * Preservation rules (mirror Headroom's CodeCompressor contract):
 *  - import/export/require lines kept whole;
 *  - function/class/interface/type declarations kept (signature lines);
 *  - blank-line runs collapsed; comment-only lines dropped (except doc
 *    comments directly attached to a kept signature);
 *  - identical consecutive lines beyond a small run collapsed to a count.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const SIGNATURE_RE =
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)*\s*(function\*?\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|struct\s+\w+|impl\s+\w+|pub\s+fn\s+\w+|fn\s+\w+|def\s+\w+|\w+(\.\w+)*\s*\([^)]*\)\s*(:\s*[\w<>\[\]| ]+)?\s*\{$)/;
const IMPORT_RE =
  /^(import\s|from\s|export\s+\{|require\(|\#\s*include\s|\@\w+|use\s+\w|package\s+\w)/;
const DOC_RE = /^\s*(\/\*\*|\/\*|\/\/\s|#+\s|\/)/;
const IDENT_DUP_MAX = 2;
const MIN_LINES = 40;

export class CodeCompressor implements BlockCompressor {
  readonly name = "code-compressor";

  compress(text: string, _ctx: CompressContext): string | null {
    const lines = text.split("\n");
    if (lines.length < MIN_LINES) return null;

    // Language sniff: need some structure to trust signature detection.
    const sigCount = lines.filter((l) => SIGNATURE_RE.test(l.trim()) || IMPORT_RE.test(l.trim())).length;
    if (sigCount < lines.length * 0.05) return null;

    const out: string[] = [];
    let lastKept = "";
    let dupRun = 0;
    let pendingDoc: string[] = [];
    let stripped = 0;

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const trimmed = line.trim();

      if (trimmed === "") {
        if (out.length > 0 && out[out.length - 1] !== "") out.push("");
        continue;
      }

      if (IMPORT_RE.test(trimmed)) {
        this.flushDoc(out, pendingDoc);
        out.push(line);
        lastKept = trimmed;
        dupRun = 1;
        continue;
      }

      if (SIGNATURE_RE.test(trimmed)) {
        this.flushDoc(out, pendingDoc);
        out.push(line);
        lastKept = "";
        dupRun = 0;
        continue;
      }

      // comment-only line: buffer for possible doc attachment, else drop
      if (DOC_RE.test(trimmed) && !/[a-zA-Z0-9]{4,}/.test(trimmed.replace(/^["'#*\/\s-]+/, ""))) {
        pendingDoc.push(line);
        if (pendingDoc.length > 3) {
          out.push(...pendingDoc.slice(0, 1));
          stripped += pendingDoc.length - 1;
          pendingDoc = [pendingDoc[0]];
        }
        continue;
      }
      pendingDoc = [];

      // normal body line: dedupe long identical runs
      if (trimmed === lastKept) {
        dupRun++;
        if (dupRun > IDENT_DUP_MAX) stripped++;
        continue;
      }
      lastKept = trimmed;
      dupRun = 1;
      out.push(line);
    }
    this.flushDoc(out, pendingDoc);

    const result = out.join("\n").replace(/\n{3,}/g, "\n\n");
    if (result.length >= text.length) return null;
    return result;
  }

  private flushDoc(out: string[], pendingDoc: string[]): void {
    for (const d of pendingDoc) out.push(d);
    pendingDoc.length = 0;
  }
}

/**
 * TabularCrusher — CSV / TSV / markdown tables → JsonCrusher.
 *
 * Bridges structured tables into the JSON pipeline (Headroom does the same:
 * TabularCompressor bridges to SmartCrusher). Column headers survive;
 * repeated rows are deduped by the JSON crusher.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";
import { JsonCrusher } from "./json.ts";

const json = new JsonCrusher();

export class TabularCrusher implements BlockCompressor {
  readonly name = "tabular-crusher";

  compress(text: string, ctx: CompressContext): string | null {
    const rows = this.parseRows(text);
    if (!rows || rows.data.length < 10) return null;
    const { header, data } = rows;
    const records = data.map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = r[i] ?? ""));
      return o;
    });
    const asJson = JSON.stringify({ columns: header, rows: records });
    const crushed = json.compress(asJson, ctx);
    // The JSON form must still beat the original table text.
    const candidate = crushed ?? asJson;
    if (candidate.length >= text.length) return null;
    return candidate;
  }

  /** Detect a delimited or markdown table; returns header + data rows or null. */
  parseRows(text: string): { header: string[]; data: string[][] } | null {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return null;

    const delim = this.detectDelimiter(lines[0]);
    if (delim) {
      const split = (l: string): string[] =>
        delim === "\t"
          ? l.split("\t")
          : l.split(delim).map((s) => s.replace(/^"|"$/g, ""));
      const header = split(lines[0]);
      if (header.length < 2) return null;
      const data = lines.slice(1).map(split).filter((r) => r.length === header.length);
      if (data.length < lines.length * 0.6) return null; // inconsistent shape
      return { header, data };
    }

    // markdown table: | a | b |  with a |---|---| separator
    if (lines[0].includes("|") && /^\s*\|?[\s:|-]+\|/.test(lines[1] ?? "")) {
      const split = (l: string): string[] =>
        l.split("|").map((s) => s.trim()).filter((s, i, a) => !(s === "" && (i === 0 || i === a.length - 1)));
      const header = split(lines[0]);
      if (header.length < 2) return null;
      const data = lines
        .slice(2)
        .map(split)
        .filter((r) => r.length === header.length && !r.every((c) => /^[\s:|-]+$/.test(c)));
      if (data.length < lines.length * 0.5) return null;
      return { header, data };
    }
    return null;
  }

  private detectDelimiter(line: string): string | null {
    for (const d of [",", "\t", ";", "|"]) {
      const count = line.split(d).length - 1;
      if (count >= 2) return d;
    }
    return null;
  }
}

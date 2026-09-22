/**
 * Compressor registry and the ContentRouter.
 *
 * The router inspects a block (sampled, cheap) and returns an ordered list
 * of candidate compressors. The engine tries them in order and accepts the
 * first result that strictly shrinks the block; if none do, the block
 * passes through unchanged (fallback chain → passthrough, per the Headroom
 * contract).
 */
import type { BlockCompressor, ContentType } from "../types.ts";
import { JsonCrusher } from "./json.ts";
import { LogCrusher } from "./logs.ts";
import { SearchCrusher } from "./search.ts";
import { DiffCrusher } from "./diff.ts";
import { ConfigCrusher } from "./config.ts";
import { HtmlExtractor } from "./html.ts";
import { TabularCrusher } from "./tabular.ts";
import { TextCompressor } from "./text.ts";
import { CodeCompressor } from "./code.ts";

export { JsonCrusher, LogCrusher, SearchCrusher, DiffCrusher, ConfigCrusher, HtmlExtractor, TabularCrusher, TextCompressor, CodeCompressor };

const SAMPLE_CHARS = 12_000;

const DIFF_HEADER_RE = /^(diff --git |--- |\+\+\+ |@@ |index [0-9a-f]{7,} )/;
const SEARCH_LINE_RE = new RegExp("^[^\\s:]{1,200}:\\d{1,7}(:|\\t)");
const LOG_LINE_RE = new RegExp(
  "^(\\s*)(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2})?([.+-]\\d+)?Z?|\\[\\d{4}-\\d{2}-\\d{2}[^\\]]*\\]|(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\\b)",
  "i"
);
const YAML_KEY_RE = /^\s*[\w.$-]+:(\s|$)/;
const CODE_KW_RE =
  /\b(function|def |class |interface |import |from .+ import|const |let |var |package |struct |impl |fn |public |private |export )\b/;

export interface RouterResult {
  type: ContentType;
  /** Ordered candidates; the engine tries each until one shrinks. */
  candidates: BlockCompressor[];
}

export interface CompressorSet {
  json: BlockCompressor;
  logs: BlockCompressor;
  search: BlockCompressor;
  diff: BlockCompressor;
  config: BlockCompressor;
  html: BlockCompressor;
  tabular: BlockCompressor;
  text: BlockCompressor;
  code: BlockCompressor;
}

export class ContentRouter {
  public readonly compressors: CompressorSet;

  constructor(compressors: CompressorSet) {
    this.compressors = compressors;
  }

  static create(): ContentRouter {
    return new ContentRouter({
      json: new JsonCrusher(),
      logs: new LogCrusher(),
      search: new SearchCrusher(),
      diff: new DiffCrusher(),
      config: new ConfigCrusher(),
      html: new HtmlExtractor(),
      tabular: new TabularCrusher(),
      text: new TextCompressor(),
      code: new CodeCompressor(),
    });
  }

  route(text: string): RouterResult {
    if (text.length < 200) return { type: "text", candidates: [this.compressors.text] };
    const sample = text.slice(0, SAMPLE_CHARS);
    const lines = sample.split("\n");
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const frac = (re: RegExp) =>
      nonEmpty.length === 0 ? 0 : nonEmpty.filter((l) => re.test(l)).length / nonEmpty.length;

    const trimmed = sample.trimStart();
    const first = trimmed[0];

    // 1. JSON (only if it actually parses — cheap at sample size)
    if ((first === "{" || first === "[") && text.length < 512 * 1024) {
      try {
        JSON.parse(text);
        return {
          type: "json",
          candidates: [this.compressors.json, this.compressors.text],
        };
      } catch {
        // not valid JSON; continue to other detectors
      }
    }

    // 2. Unified diff — `@@` hunks and `diff --git` headers are the signal.
    // The ratio threshold stays low because unchanged context dominates
    // large diffs; requiring both kinds of header avoids misrouting code
    // that contains markdown `---` rules or decorator lines.
    const gitHdr = nonEmpty.filter((l) => l.startsWith("diff --git ")).length;
    const aHdr = nonEmpty.filter((l) => /^--- a\//.test(l)).length;
    const bHdr = nonEmpty.filter((l) => /^\+\+\+ b\//.test(l)).length;
    const hunk = nonEmpty.filter((l) => l.startsWith("@@")).length;
    const diffish =
      (aHdr >= 1 && bHdr >= 1 && hunk >= 2) ||
      (gitHdr >= 2 && hunk >= 2 && (gitHdr + hunk) / nonEmpty.length > 0.05) ||
      frac(DIFF_HEADER_RE) > 0.3;
    if (diffish) {
      return { type: "diff", candidates: [this.compressors.diff, this.compressors.text] };
    }

    // 3. Logs — checked BEFORE search: ISO-timestamped lines
    // (`2026-09-21T10:00:01.123Z ...`) also match the search `path:line:`
    // pattern, and a timestamp+level is the stronger signal.
    if (frac(LOG_LINE_RE) > 0.4) {
      return { type: "log", candidates: [this.compressors.logs, this.compressors.text] };
    }

    // 4. Search results (file:line:content)
    if (frac(SEARCH_LINE_RE) > 0.6) {
      return { type: "search", candidates: [this.compressors.search, this.compressors.logs, this.compressors.text] };
    }

    // 5. HTML
    if ((sample.match(/<[a-zA-Z]/g) ?? []).length > 8 && sample.includes("</")) {
      return { type: "html", candidates: [this.compressors.html, this.compressors.text] };
    }

    // 6. Tabular
    const firstLine = nonEmpty[0] ?? "";
    const delim = [",", "\t", ";"].find((d) => {
      const firstCount = firstLine.split(d).length - 1;
      if (firstCount < 2) return false;
      const consistent = nonEmpty.slice(0, 20).filter((l) => l.split(d).length - 1 === firstCount).length;
      return consistent > nonEmpty.slice(0, 20).length * 0.7;
    });
    if (delim || (firstLine.includes("|") && nonEmpty[1]?.match(/^\s*\|?[\s:|-]+\|/))) {
      return {
        type: "tabular",
        candidates: [this.compressors.tabular, this.compressors.json, this.compressors.text],
      };
    }

    // 7. Config (YAML/TOML/INI)
    if (frac(YAML_KEY_RE) > 0.5) {
      return { type: "config", candidates: [this.compressors.config, this.compressors.text] };
    }

    // 8. Code
    if (frac(CODE_KW_RE) > 0.04 && lines.some((l) => /^\s{2,}\S/.test(l))) {
      return { type: "code", candidates: [this.compressors.code, this.compressors.text] };
    }

    // 9. Plain text
    return { type: "text", candidates: [this.compressors.text] };
  }
}

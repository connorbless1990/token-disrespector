/**
 * HtmlExtractor — web page → readable text.
 *
 * Strips scripts/styles/nav chrome, tag attributes, and whitespace runs.
 * Keeps headings and visible text. Only used when the result is at least
 * half the size of the input (invariant I3, with margin).
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const STRIP_BLOCK_RE = /<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi;
const NAV_BLOCK_RE = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const TAG_RE = /<[^>]+>/g;

export class HtmlExtractor implements BlockCompressor {
  readonly name = "html-extractor";

  compress(text: string, _ctx: CompressContext): string | null {
    if (text.length < 500 || !text.includes("<")) return null;
    let out = text
      .replace(STRIP_BLOCK_RE, "\n")
      .replace(NAV_BLOCK_RE, "")
      .replace(COMMENT_RE, "");

    // headings become lines
    out = out.replace(HEADING_RE, (_m, level: string, body: string) => `\n[H${level}] ${body.replace(TAG_RE, "")}`);
    out = out.replace(TAG_RE, " ");
    out = out
      .split(/\n/)
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter((l) => l.length > 0)
      .join("\n")
      .trim();

    if (out.length * 2 > text.length) return null; // need ≥50% reduction
    return out;
  }
}

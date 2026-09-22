/**
 * ConfigCrusher — YAML / TOML / INI configuration files.
 *
 * Keeps every key and value; strips comments and blank lines; collapses
 * runs of identical list items. Headroom measures ~40–70% on
 * comment/blank-heavy config.
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

export class ConfigCrusher implements BlockCompressor {
  readonly name = "config-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    const lines = text.split(/\r?\n/);
    if (lines.length < 20) return null;

    const out: string[] = [];
    let stripped = 0;
    let lastKept = "";
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const trimmed = line.trim();
      const isComment =
        trimmed === "" ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith(";") ||
        trimmed.startsWith("<!--");
      if (isComment) {
        stripped++;
        continue;
      }
      // collapse consecutive identical lines (e.g. repeated list items)
      if (trimmed === lastKept) {
        stripped++;
        continue;
      }
      out.push(line);
      lastKept = trimmed;
    }

    if (out.length === lines.length) return null;
    const result =
      out.join("\n") +
      (stripped > 0 ? `\n[ctxroom:${stripped} comment/blank/duplicate line(s) removed]` : "");
    if (result.length >= text.length) return null;
    return result;
  }
}

/**
 * TextCompressor — extractive prose compression (v1) with optional LLM
 * summarization (v1.1, off by default).
 *
 * Extractive rules:
 *  - first and last paragraphs always kept;
 *  - paragraphs containing high-entropy signal (paths, URLs, identifiers,
 *    numbers, error words) kept;
 *  - everything else dropped with a marker;
 *  - refuse (null) unless the result shrinks.
 *
 * This is the deliberately conservative v1: Headroom's trained Kompress model
 * does this better for prose; the deterministic version guarantees zero
 * latency, zero model calls, and predictable behavior on air-gapped machines.
 */
import type { BlockCompressor, CompressContext, ResolvedEngineConfig } from "../types.ts";

const SIGNAL_RE =
  /([/\\][\w./-]{3,}|https?:\/\/\S{8,}|\b[a-z_][\w-]{4,}\.[a-z]{1,5}\b|\b\d{3,}\b|\b(error|fail|fatal|exception|warn|denied|timeout)\b)/i;
const MIN_PARAS = 6;
const MIN_CHARS = 800;

export class TextCompressor implements BlockCompressor {
  readonly name = "text-compressor";

  compress(text: string, ctx: CompressContext): string | null {
    if (text.length < MIN_CHARS) return null;
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (paras.length < MIN_PARAS) return null;

    const keep = paras.map((p, i) => {
      if (i === 0 || i === paras.length - 1) return true;
      return SIGNAL_RE.test(p);
    });
    const keptCount = keep.filter(Boolean).length;
    if (keptCount >= paras.length * 0.85) return null; // nothing to save

    const out: string[] = [];
    let run = 0;
    paras.forEach((p, i) => {
      if (keep[i]) {
        if (run > 0) out.push(`[ctxroom:${run} paragraph(s) omitted]`);
        run = 0;
        out.push(p);
      } else {
        run++;
      }
    });
    if (run > 0) out.push(`[ctxroom:${run} paragraph(s) omitted]`);

    const result = out.join("\n\n");
    if (result.length >= text.length) return null;
    return result;
  }

  /**
   * Optional LLM summarization for prose (used when the engine is configured
   * with an `llmSummarizer`). Returns `null` on any failure so the caller
   * falls back to the extractive path or passthrough.
   */
  async llmSummarize(text: string, ctx: CompressContext, cfg: ResolvedEngineConfig): Promise<string | null> {
    const llm = cfg.llmSummarizer;
    if (!llm) return null;
    if (text.length < MIN_CHARS) return null;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), llm.timeoutMs);
      const res = await fetch(`${llm.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: llm.maxTokens,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "You are a context-compression engine. Condense the provided text into a terse engineering summary. " +
                "Preserve: decisions, file paths, commands, error strings, identifiers, numeric values, constraints, " +
                "and the user's intent. Drop: pleasantries, restatements, verbose narration. Output summary text only.",
            },
            { role: "user", content: text },
          ],
        }),
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = body.choices?.[0]?.message?.content?.trim();
      if (!content) return null;
      return `## Compressed summary (original ${Math.round(text.length / 4)} tok)\n${content}\n[ctxroom:llm-summarized · retrieve original with ctxroom_retrieve]`;
    } catch {
      return null;
    }
  }
}

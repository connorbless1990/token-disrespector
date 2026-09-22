/**
 * compressMessages — the engine's public entry point.
 *
 * Pipeline per request:
 *   1. reconcile against the session's remembered send forms
 *   2. apply stored replacements to the frozen prefix (byte-stability, I2)
 *   3. new zone: safety gates → ContentRouter → first compressor that
 *      shrinks wins → CCR store of the original + marker
 *   4. record send forms for the next request
 *
 * Invariants: I1 system/developer never touched · I2 frozen prefix
 * byte-identical · I3 no growth · I4 below-min-size untouched ·
 * I5 any failure ⇒ passthrough · I8 CCR off ⇒ no lossy compression ·
 * I10 protected-pattern passthrough.
 */
import { CcrStore, renderMarker } from "./ccr.ts";
import { ContentRouter } from "./compressors/index.ts";
import { countWords, estimateTokens } from "./estimate.ts";
import {
  budgetEligible,
  messageText,
  originalParts,
  SessionRegistry,
  type ForwardText,
} from "./livezone.ts";
import type {
  CompressContext,
  CompressResult,
  EngineMessage,
  ResolvedEngineConfig,
  TransformRecord,
} from "./types.ts";

export interface CompressOptions {
  config: ResolvedEngineConfig;
  /** Inject a shared registry (the proxy keeps one process-wide). */
  registry?: SessionRegistry;
  /** Inject a shared CCR store (tests use a temp dir). */
  ccr?: CcrStore;
  router?: ContentRouter;
  /** Paths referenced in the latest user message (search-compressor protection). */
  referencedPaths?: string[];
  /** Filename hint for file-read style blocks. */
  fileHint?: string;
}

export interface CompressOutput extends CompressResult {
  /** Per-message forwarded text (null = unchanged original). */
  forwardTexts: ForwardText[];
}

export class Engine {
  private readonly registry: SessionRegistry;
  private readonly ccr: CcrStore;
  private readonly router: ContentRouter;

  readonly config: ResolvedEngineConfig;

  constructor(config: ResolvedEngineConfig, options: Partial<CompressOptions> = {}) {
    this.config = config;
    this.registry = options.registry ?? new SessionRegistry();
    this.ccr = options.ccr ?? new CcrStore({
      dir: config.ccr.dir,
      ttlMs: config.ccr.ttlMs,
      maxEntryBytes: config.ccr.maxEntryBytes,
    });
    this.router = options.router ?? ContentRouter.create();
  }

  get sessionRegistry(): SessionRegistry {
    return this.registry;
  }

  /** Exposed for tests and diagnostics. */
  get ccrStore(): CcrStore {
    return this.ccr;
  }

  async compress(
    messages: EngineMessage[],
    extra: Partial<CompressOptions> = {}
  ): Promise<CompressOutput> {
    const { config } = this;
    const ctx: CompressContext = {
      referencedPaths: extra.referencedPaths ?? this.extractReferencedPaths(messages),
      fileHint: extra.fileHint,
    };

    const { forwardTexts, liveStart } = this.registry.reconcile(messages);
    const out: EngineMessage[] = messages.map((m) => ({ ...m }));

    // Snapshot of what goes out BEFORE any new-zone compression: frozen
    // messages use their stored send form; new messages their original text.
    // (forwardTexts is mutated below for compressed new messages, so this
    // snapshot is the "before" side of the accounting.)
    const beforeTexts = forwardTexts.map((f, i) =>
      f === null ? messageText(messages[i]) : Array.isArray(f) ? f.join("\n") : f
    );

    // 1. Frozen prefix: re-apply stored send forms (byte-stability).
    for (let i = 0; i < liveStart && i < out.length; i++) {
      const fwd = forwardTexts[i];
      if (fwd === null || fwd === undefined) continue;
      this.applyForward(out[i], messages[i], fwd);
    }

    // 2. New zone (+ optional budget zone).
    let budgetSet = new Set<number>();
    if (config.budget.enabled) {
      budgetSet = new Set(
        budgetEligible(
          messages,
          forwardTexts,
          this.registry.latestForms(),
          (t) => estimateTokens(t),
          config.budget.tokenBudget
        )
      );
    }

    const transforms: TransformRecord[] = [];
    let ccrStored = 0;
    let replaced = 0;

    for (let i = 0; i < messages.length; i++) {
      if (i < liveStart) continue; // frozen — handled above
      if (!budgetSet.has(i) && config.budget.enabled) continue; // budget mode: only eligible zones
      const m = messages[i];
      if (config.protectedRoles.includes(m.role)) continue; // I1

      const parts = this.toParts(m);
      if (parts.length === 0) continue;

      let anyChanged = false;
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (part === null || part.length === 0) continue;
        if (countWords(part) < config.minInputWords) continue; // I4
        if (part.length > config.maxBlockChars) continue;
        if (config.protectedRegexes.some((re) => re.test(part))) continue; // I10

        const routed = this.router.route(part);
        let result: string | null = null;
        for (const comp of routed.candidates) {
          try {
            const r = comp.compress(part, ctx);
            if (r !== null && r.length < part.length) result = r; // I3
          } catch {
            /* I5 */
          }
          if (result !== null) break;
        }

        // Optional LLM summarizer — budget-zone text only (latency).
        if (result === null && config.llmSummarizer && budgetSet.has(i) && routed.type === "text") {
          const r = await (this.router.compressors.text as { llmSummarize?: (t: string, c: CompressContext, cfg: ResolvedEngineConfig) => Promise<string | null> }).llmSummarize?.(
            part,
            ctx,
            config
          ).catch(() => null);
          if (r && r.length < part.length) result = r;
        }

        if (result === null) {
          transforms.push({
            transform: "passthrough",
            type: routed.type,
            tokensBefore: estimateTokens(part),
            tokensAfter: estimateTokens(part),
            messageIndex: i,
            partIndex: pi,
          });
          continue;
        }

        // I8 — lossy compression requires the original to be stored.
        let hash12: string | null = null;
        if (config.ccr.enabled) {
          hash12 = await this.ccr.store(part);
        }
        if (!hash12) {
          transforms.push({
            transform: "ccr-unavailable",
            type: routed.type,
            tokensBefore: estimateTokens(part),
            tokensAfter: estimateTokens(part),
            messageIndex: i,
            partIndex: pi,
          });
          continue;
        }

        const marked = `${result}\n${renderMarker(hash12, estimateTokens(part), estimateTokens(result))}`;
        parts[pi] = marked;
        anyChanged = true;
        ccrStored++;
        replaced++;
        transforms.push({
          transform: result.includes("llm-summarized") ? "llm-summarizer" : "compressor",
          type: routed.type,
          tokensBefore: estimateTokens(part),
          tokensAfter: estimateTokens(marked),
          messageIndex: i,
          partIndex: pi,
          ccrHash: hash12,
        });
      }

      if (anyChanged) {
        this.writeParts(out[i], m, parts);
        forwardTexts[i] = this.forwardForm(out[i]);
      }
    }

    // 3. Accounting: before = the pre-compression snapshot, after = what we
    // actually forward (compressed new zones + re-applied frozen forms).
    let tokensBefore = 0;
    let tokensAfter = 0;
    for (let i = 0; i < messages.length; i++) {
      tokensBefore += estimateTokens(beforeTexts[i] ?? "");
      tokensAfter += estimateTokens(this.forwardTextOf(out[i]));
    }

    // 4. Remember send forms for the next request.
    this.registry.record(messages, forwardTexts);

    return {
      messages: out,
      tokensBefore,
      tokensAfter,
      transforms,
      replaced,
      ccrStored,
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      forwardTexts,
    };
  }

  /** The text this message object currently carries (string or joined parts). */
  private forwardTextOf(m: EngineMessage): string {
    return messageText(m);
  }

  private forwardForm(m: EngineMessage): ForwardText {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""));
    }
    return null;
  }

  private applyForward(target: EngineMessage, original: EngineMessage, fwd: ForwardText): void {
    if (typeof original.content === "string") {
      target.content = typeof fwd === "string" ? fwd : Array.isArray(fwd) ? fwd.join("\n") : original.content;
      return;
    }
    if (Array.isArray(original.content) && Array.isArray(fwd)) {
      target.content = original.content.map((p, j) => {
        if (p.type !== "text" || !fwd[j]) return p;
        return { ...p, text: fwd[j] };
      });
    }
  }

  private toParts(m: EngineMessage): (string | null)[] {
    if (typeof m.content === "string") return [m.content];
    if (Array.isArray(m.content)) return originalParts(m);
    return [];
  }

  private writeParts(target: EngineMessage, original: EngineMessage, parts: (string | null)[]): void {
    if (typeof original.content === "string") {
      target.content = parts[0] ?? original.content;
      return;
    }
    if (Array.isArray(original.content)) {
      target.content = original.content.map((p, i) => {
        if (p.type !== "text" || parts[i] === null || parts[i] === p.text) return p;
        return { ...p, text: parts[i] };
      });
    }
  }

  private extractReferencedPaths(messages: EngineMessage[]): string[] {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      const text = messageText(m);
      const paths = new Set<string>();
      for (const match of text.matchAll(/([/\\][\w.$-]{2,}[/\\.\w-]{2,})/g)) paths.add(match[1]);
      for (const match of text.matchAll(/\b([\w-]+\.\w{1,5})(?![\w.])\b/g)) paths.add(match[1]);
      return [...paths].slice(0, 25);
    }
    return [];
  }
}

/**
 * Convenience wrapper matching the Headroom `compress(messages)` shape.
 */
import { resolveEngineConfig } from "./config.ts";

export async function compressMessages(
  messages: EngineMessage[],
  options: Omit<CompressOptions, "config"> = {}
): Promise<CompressOutput> {
  const engine = new Engine(resolveEngineConfig(), options);
  return engine.compress(messages);
}

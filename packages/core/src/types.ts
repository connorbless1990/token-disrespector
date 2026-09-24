/**
 * Shared vocabulary for the ctxroom compression engine.
 *
 * The wire vocabulary is deliberately OpenAI-compatible (what the Copilot API
 * speaks): messages with string or part-array content. Normalization of other
 * wire shapes (Anthropic /responses) happens upstream of the engine.
 */
import type { WrapperSpec } from "./unwrap.ts";

/** One part of a message content array. */
export interface ContentPart {
  type: string;
  /** Present for `type: "text"`. */
  text?: string;
  /** Present for image parts; never touched by the engine. */
  image_url?: unknown;
  [key: string]: unknown;
}

/** One chat-completions-style message. */
export interface EngineMessage {
  role: string;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

/** A detected content type routed by the ContentRouter. */
export type ContentType =
  | "json"
  | "code"
  | "log"
  | "search"
  | "diff"
  | "tabular"
  | "config"
  | "html"
  | "fragment"
  | "text";

/** Context available to a compressor for one text block. */
export interface CompressContext {
  /**
   * Paths/identifiers mentioned in the most recent user message. Compressors
   * that can lose signal (e.g. search match drops) keep these verbatim.
   */
  readonly referencedPaths: readonly string[];
  /**
   * Best-effort filename hint when the block is a file read (from the
   * surrounding tool call, when the proxy can see it).
   */
  readonly fileHint?: string;
}

/** A text compressor. `null` means "cannot shrink; pass through". */
export interface BlockCompressor {
  readonly name: string;
  /**
   * Compress one text block.
   *
   * Invariants the engine relies on:
   * - must return `null` when it cannot produce output strictly smaller than
   *   the input (no growth);
   * - must be deterministic for identical input;
   * - must never throw for arbitrary input (return `null` instead).
   */
  compress(text: string, ctx: CompressContext): string | null;
  /**
   * True when the output is a REFORMAT: every information-bearing unit of
   * the input survives in the result (whitespace may normalize). Such a
   * result is safe even with the CCR disabled (I8 governs information loss,
   * of which there is none) and needs no marker: the output IS the data.
   */
  readonly lossless?: boolean;
}

/** Result of routing one block through the ContentRouter. */
export interface RoutedBlock {
  type: ContentType;
  compressor: BlockCompressor;
  /**
   * A detected tool-output wrapper (leading path header, trailing truncation
   * notice, per-line prefixes). When present, compressors run on
   * `spec.inner` and the engine re-attaches the wrapper around the result.
   */
  unwrap?: WrapperSpec;
}

/** One recorded transformation, for stats and diagnostics. */
export interface TransformRecord {
  /** Compressor that produced the replacement. */
  transform: string;
  /** Detected content type. */
  type: ContentType | "passthrough";
  /** Estimated tokens before. */
  tokensBefore: number;
  /** Estimated tokens after. */
  tokensAfter: number;
  /** Message index + part index the transform applied to. */
  messageIndex: number;
  partIndex: number;
  /** CCR hash (12-hex) when the original was stored, else undefined. */
  ccrHash?: string;
}

/** Aggregate result of compressing a message list. */
export interface CompressResult {
  /** Messages with compressed replacements applied (new array; untouched input objects). */
  messages: EngineMessage[];
  /** Estimated input tokens across all text blocks. */
  tokensBefore: number;
  /** Estimated output tokens across all text blocks. */
  tokensAfter: number;
  /** Every transform considered (including passthroughs) — for stats. */
  transforms: TransformRecord[];
  /** Number of blocks actually replaced. */
  replaced: number;
  /** Number of originals stored in CCR. */
  ccrStored: number;
  /** Estimated savings. */
  tokensSaved: number;
}

/** CCR (compress–cache–retrieve) settings. */
export interface CcrConfig {
  /** Master switch. Lossy compression is disabled entirely when off (invariant I8-safe). */
  enabled: boolean;
  /** Store root; defaults to `<home>/cache` (home = $CTXROOM_HOME or ~/.ctxroom). */
  dir?: string;
  /** Time-to-live for unreferenced originals. Default 7 days. */
  ttlMs?: number;
  /** Refuse to store originals larger than this. Default 20 MiB. */
  maxEntryBytes?: number;
}

/** Token-budget (aggressive history) settings. */
export interface BudgetConfig {
  enabled: boolean;
  /** Target input-token ceiling for a request; compression of older zones begins above it. */
  tokenBudget?: number;
}

/** Engine configuration (resolved from defaults + env + explicit overrides). */
export interface EngineConfig {
  /** Blocks below this many words are never compressed (invariant I4). Default 120. */
  minInputWords: number;
  /** Roles whose content is never modified (invariant I1). */
  protectedRoles: readonly string[];
  /**
   * Content patterns (regex source) that mark a block protected: matched
   * blocks pass through regardless of type. v1 default: approval/plan markers.
   */
  protectedPatterns: readonly string[];
  /** Max characters of one text block routed through a compressor. Larger passes through. Default 1_000_000. */
  maxBlockChars: number;
  ccr: CcrConfig;
  budget: BudgetConfig;
  /**
   * Optional LLM summarizer for prose (off by default — deterministic-first
   * keeps zero extra model calls on resource-constrained local setups).
   */
  llmSummarizer?: {
    baseURL: string;
    model: string;
    apiKey?: string;
    /** Name of an env var to read the API key from (falls back to empty). */
    apiKeyEnv?: string;
    /** Max tokens for the summary output. Default 400. */
    maxTokens?: number;
    /** Timeout per call. Default 15_000 ms. */
    timeoutMs?: number;
  };
}

/** Resolved runtime configuration (all fields concrete). */
export interface ResolvedEngineConfig {
  minInputWords: number;
  protectedRoles: readonly string[];
  protectedRegexes: readonly RegExp[];
  maxBlockChars: number;
  ccr: {
    enabled: boolean;
    dir: string;
    ttlMs: number;
    maxEntryBytes: number;
  };
  budget: {
    enabled: boolean;
    tokenBudget: number;
  };
  llmSummarizer?: {
    baseURL: string;
    model: string;
    apiKey: string;
    maxTokens: number;
    timeoutMs: number;
  };
}

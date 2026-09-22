/**
 * Engine configuration resolution: defaults + environment + explicit overrides.
 * The same resolver is used by the proxy, the MCP server, and (later) the DSH
 * plugin, so all surfaces behave identically.
 */
import os from "node:os";
import path from "node:path";
import type { BudgetConfig, CcrConfig, EngineConfig, ResolvedEngineConfig } from "./types.ts";

export interface EnvLike {
  [key: string]: string | undefined;
}

const DEFAULT_PROTECTED_ROLES = ["system", "developer"];
/**
 * Content patterns that mark a block protected (never compressed):
 * approval prompts, plan-mode markers — content where the model must see
 * every byte to make a decision.
 */
const DEFAULT_PROTECTED_PATTERNS = [
  "approval required",
  "plan mode",
  "awaiting user",
];

export function defaultHome(): string {
  return process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
}

export function resolveEngineConfig(
  overrides: Partial<EngineConfig> = {},
  env: EnvLike = process.env
): ResolvedEngineConfig {
  const envNum = (name: string, fallback: number): number => {
    const raw = env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const envBool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.toLowerCase();
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
    return fallback;
  };

  const ccr: Partial<CcrConfig> = overrides.ccr ?? {};
  const budget: Partial<BudgetConfig> = overrides.budget ?? {};
  const llm = overrides.llmSummarizer;

  return {
    minInputWords: overrides.minInputWords ?? envNum("CTXROOM_MIN_INPUT_WORDS", 120),
    protectedRoles:
      overrides.protectedRoles ??
      DEFAULT_PROTECTED_ROLES,
    protectedRegexes: (
      overrides.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS
    ).map((p) => new RegExp(p, "i")),
    maxBlockChars: envNum("CTXROOM_MAX_BLOCK_CHARS", 1_000_000),
    ccr: {
      enabled: envBool("CTXROOM_CCR", true) && ccr.enabled !== false,
      dir: ccr.dir ? path.resolve(ccr.dir) : path.join(defaultHome(), "cache"),
      ttlMs: ccr.ttlMs ?? envNum("CTXROOM_CCR_TTL_MS", 7 * 24 * 60 * 60 * 1000),
      maxEntryBytes:
        ccr.maxEntryBytes ?? envNum("CTXROOM_CCR_MAX_ENTRY", 20 * 1024 * 1024),
    },
    budget: {
      enabled: budget.enabled ?? envBool("CTXROOM_BUDGET", false),
      tokenBudget: budget.tokenBudget ?? envNum("CTXROOM_TOKEN_BUDGET", 120_000),
    },
    llmSummarizer: llm
      ? {
          baseURL: llm.baseURL,
          model: llm.model,
          apiKey: llm.apiKey ?? env[llm.apiKeyEnv ?? ""] ?? "",
          maxTokens: llm.maxTokens ?? 400,
          timeoutMs: llm.timeoutMs ?? 15_000,
        }
      : undefined,
  };
}

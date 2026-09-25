/**
 * Command runners: `tds proxy | stats | simulate | retrieve`.
 * Each takes already-parsed flag values (arg parsing lives in index.ts) so
 * they stay unit-testable.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { CcrStore, Engine, resolveEngineConfig, type EngineConfig, type EngineMessage } from "@ctxroom/core";
import { PROXY_VERSION, StatsWriter, startProxy } from "@ctxroom/proxy";

// ---------------------------------------------------------------------------
// tds proxy [--port N] [--ccr on|off] [--budget N]
// ---------------------------------------------------------------------------

export interface ProxyFlags {
  port?: number;
  /** "on" | "off" (default: on). */
  ccr?: string;
  /** token budget that enables aggressive history compression. */
  budget?: number;
}

/** Run the proxy in the foreground until interrupted. */
export async function runProxy(flags: ProxyFlags = {}): Promise<void> {
  const config: Partial<EngineConfig> = {};
  if (flags.ccr !== undefined) config.ccr = { enabled: flags.ccr === "on" || flags.ccr === "1" || flags.ccr === "true" };
  if (flags.budget !== undefined) config.budget = { enabled: true, tokenBudget: flags.budget };

  const running = await startProxy({
    port: flags.port,
    // env flows through process.env: CTXROOM_HOME, CTXROOM_COPILOT_API_URL,
    // GITHUB_COPILOT_ENTERPRISE_*, NODE_EXTRA_CA_CERTS (fetch honors it).
    config,
  });

  const engine = running.engine;
  console.log(
    [
      `tds proxy v${PROXY_VERSION} listening on http://127.0.0.1:${running.port} (loopback only)`,
      `  upstream:   ${running.upstreamBase}`,
      `  ccr:        ${engine.config.ccr.enabled ? `on (${engine.config.ccr.dir})` : "off (lossy compression disabled)"}`,
      `  budget:     ${engine.config.budget.enabled ? `on (${engine.config.budget.tokenBudget} tok)` : "off"}`,
      `  health:     http://127.0.0.1:${running.port}/health`,
      `  stats:      ${running.stats.dir}`,
      "",
      "  press ctrl-c to stop; the copilot wrapper starts/stops this process",
    ].join("\n")
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      running.close().then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// ---------------------------------------------------------------------------
// tds stats [--days 7] [--model M]
// ---------------------------------------------------------------------------

export interface StatsFlags {
  days?: number;
  model?: string;
}

/** Aggregate the local stats JSONL and print per-day / model / project totals. */
export async function runStats(flags: StatsFlags = {}): Promise<number> {
  const home = process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
  const writer = new StatsWriter(undefined, home);
  try {
    const s = await writer.summary(flags.days ?? 7);
    const models = Object.entries(s.byModel)
      .filter(([m]) => !flags.model || m === flags.model)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));
    if (s.requests === 0) {
      console.log(`no proxied requests recorded in the last ${flags.days ?? 7} days (stats dir: ${writer.dir})`);
      return 0;
    }
    console.log(`tds stats — last ${flags.days ?? 7} day(s), ${s.requests} request(s), ${s.pct.toFixed(1)}% saved overall`);
    console.log("");
    console.log("by day:");
    for (const [day, a] of Object.entries(s.byDay).sort((x, y) => (x[0] < y[0] ? 1 : -1))) {
      console.log(`  ${day}  ${String(a.requests).padStart(4)} reqs  ${a.tokensBefore} → ${a.tokensAfter} tok  (saved ${a.tokensSaved})`);
    }
    if (models.length > 0) {
      console.log("");
      console.log("by model:");
      for (const [m, a] of models) {
        console.log(`  ${m.padEnd(28)} ${String(a.requests).padStart(4)} reqs  ${a.tokensBefore} → ${a.tokensAfter} tok  (saved ${a.tokensSaved})`);
      }
    }
    if (Object.keys(s.byProject).length > 0) {
      console.log("");
      console.log("by project:");
      for (const [p, a] of Object.entries(s.byProject).sort((x, y) => (x[0] < y[0] ? 1 : -1))) {
        console.log(`  ${p.padEnd(28)} ${String(a.requests).padStart(4)} reqs  ${a.tokensBefore} → ${a.tokensAfter} tok  (saved ${a.tokensSaved})`);
      }
    }
    return 0;
  } catch (e) {
    console.error(`stats: ${String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// tds simulate --file prompt.json
// ---------------------------------------------------------------------------

/**
 * Offline engine run: load a chat-completions (or responses) request body,
 * run the real engine, and print what would be forwarded. No network.
 */
export async function runSimulate(file: string): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`simulate: cannot read ${file}: ${String(e)}`);
    return 1;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error(`simulate: ${file} is not valid JSON: ${String(e)}`);
    return 1;
  }

  let messages: EngineMessage[];
  if (Array.isArray(body)) messages = body as EngineMessage[];
  else if (Array.isArray(body.messages)) messages = body.messages as EngineMessage[];
  else if (typeof body.input === "string") messages = [{ role: "user", content: body.input }];
  else if (Array.isArray(body.input)) {
    messages = (body.input as unknown[])
      .map((it) => {
        if (typeof it === "string") return { role: "user", content: it } as EngineMessage;
        if (it && typeof it === "object" && !Array.isArray(it)) {
          const o = it as Record<string, unknown>;
          if (typeof o.type === "string" && o.type !== "message") return null;
          if (typeof o.content !== "string" && !Array.isArray(o.content)) return null;
          return { ...(o as object), role: typeof o.role === "string" ? o.role : "user" } as EngineMessage;
        }
        return null;
      })
      .filter((m): m is EngineMessage => m !== null);
  } else {
    console.error("simulate: expected { messages: [...] }, { input: ... }, or a messages array");
    return 1;
  }

  const engine = new Engine(resolveEngineConfig());
  const result = await engine.compress(messages);

  console.log(`tds simulate — ${messages.length} message(s), ${result.replaced} compressed, ${result.ccrStored} CCR store(s)`);
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i];
    const transforms = result.transforms.filter((t) => t.messageIndex === i);
    if (transforms.length === 0) continue; // fully untouched
    for (const t of transforms) {
      const pct = t.tokensBefore > 0 ? ((t.tokensBefore - t.tokensAfter) / t.tokensBefore) * 100 : 0;
      console.log(`  [${i}] ${m.role.padEnd(10)} ${t.transform.padEnd(16)} ${t.type.padEnd(8)} ${t.tokensBefore} → ${t.tokensAfter} tok (${pct.toFixed(0)}%)${t.ccrHash ? `  ccr:${t.ccrHash}` : ""}`);
    }
  }
  console.log(`  tokens: ${result.tokensBefore} → ${result.tokensAfter} (saved ${result.tokensSaved}, ${result.tokensBefore > 0 ? ((result.tokensSaved / result.tokensBefore) * 100).toFixed(1) : "0.0"}%)`);
  return 0;
}

// ---------------------------------------------------------------------------
// tds retrieve <hash> [maxChars]
// ---------------------------------------------------------------------------

export async function runRetrieve(hash: string, maxChars?: number): Promise<number> {
  const store = new CcrStore();
  const result = await store.retrieve(hash, { maxChars: maxChars ?? 20_000 });
  if (!result) {
    console.error(`retrieve: no original found for "${hash}" (TTL expired, evicted, or CTXROOM_HOME mismatch)`);
    return 1;
  }
  process.stdout.write(result.text);
  if (!result.text.endsWith("\n")) process.stdout.write("\n");
  if (result.truncated) {
    console.error(`retrieve: showing ${result.offset}..${result.offset + result.text.length} of ${result.totalChars} chars — pass a larger maxChars or use an offset`);
    return 1;
  }
  return 0;
}

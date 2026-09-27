#!/usr/bin/env node
/**
 * tds (token-disrespector) — CLI entry point. Hand-rolled arg parsing (zero dependencies).
 *
 *   tds copilot [args…]   run copilot through the compression proxy
 *   tds dsh [--upstream URL] [--port N] [--provider P] [--model M] [--undo]
 *                         wire DSH through tds (or undo it); opt-in, no daemons
 *   tds unwrap            remove the marked MCP block; stop the proxy
 *   tds doctor            environment checklist (exit 1 if broken)
 *   tds proxy [--port N] [--ccr on|off] [--budget N]
 *   tds stats [--days 7] [--model M]
 *   tds simulate --file prompt.json
 *   tds retrieve <hash> [maxChars]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StatsWriter } from "@ctxroom/proxy";
import {
  DEFAULT_PORT,
  buildLaunchEnv,
  copilotEnvMatrix,
  defaultMcpConfigPath,
  classifyBuild,
  detectBuildKind,
  ensureProxy,
  findCopilot,
  mergeMcpConfig,
  mcpEntry,
  resolveCopilotRealPath,
  resolveMcpServerPath,
  scanBundle,
  stopProxy,
  unwrapMcpConfig,
  type BundleScanResult,
  type LaneMode,
} from "./copilot.ts";
import os from "node:os";
import { printDoctor, runDoctor } from "./doctor.ts";
import { runDsh, type DshRunOptions } from "./dsh.ts";
import { runProxy, runRetrieve, runSimulate, runStats } from "./commands.ts";

// ---------------------------------------------------------------------------
// Arg parsing (hand-rolled)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  flags: Record<string, string | number | boolean>;
  positional: string[];
}

/**
 * Minimal flag parser: `--key value`, `--key=value`, boolean `--flag`,
 * and `--` (everything after → positional passthrough).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | number | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        flags[key] = val;
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function flagNumber(flags: Record<string, string | number | boolean>, key: string, fallback?: number): number | undefined {
  const v = flags[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// copilot command
// ---------------------------------------------------------------------------

export interface CopilotRunOptions {
  port?: number;
  mcpConfigPath?: string;
  /** Args forwarded to copilot after the binary. */
  spawnArgs?: string[];
  copilotPath?: string | null; // null = not found
  scan?: BundleScanResult | null; // null = run a real scan
  /** Force a lane (native | byok) instead of auto-detecting. */
  lane?: LaneMode;
  stopProxyOnExit?: boolean;
  /** ctxroom home dir; defaults to $CTXROOM_HOME or ~/.ctxroom. */
  home?: string;
  env?: Record<string, string | undefined>;
  spawn?: (cmd: string, args: string[], env: Record<string, string>) => Promise<number>;
  log?: (line: string) => void;
}

/**
 * The full copilot flow:
 *   1. locate copilot   2. classify the build + feature-detect the bundle
 *   3. ensure proxy     4. pick the lane (native vs BYOK) + build env
 *   5. merge the MCP config (marked block, backed up)
 *   6. spawn copilot, pass through the exit code, keep the proxy running
 *      (unless --stop-proxy).
 */
export async function runCopilot(opts: CopilotRunOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const port = opts.port ?? DEFAULT_PORT;
  const home = opts.home ?? process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");

  // 1. locate (--copilot flag / CTXROOM_COPILOT_PATH override the search;
  //    existence of a user-supplied path is validated by cmdCopilot, so
  //    injected test paths keep flowing through the full pipeline)
  const copilotPath = opts.copilotPath === undefined ? findCopilot() : opts.copilotPath;
  if (!copilotPath) {
    log("error: could not find the `copilot` binary — searched every $PATH dir,");
    log("       ~/.local/bin, /opt/homebrew/bin, /usr/local/bin for an executable named 'copilot'.");
    log("       point at yours:  tds copilot --copilot /path/to/your/binary");
    log("       (or export CTXROOM_COPILOT_PATH=/path/to/your/binary)");
    return 1;
  }
  const realPath = resolveCopilotRealPath(copilotPath);
  const buildKind = classifyBuild(realPath) ?? "js";

  // 2. feature detection (string grep of the install tree / platform binary)
  const scan = opts.scan === undefined ? scanBundle({ realPath }) : opts.scan;
  const native = scan?.markers["COPILOT_API_URL"] === true;
  const byok = scan?.markers["COPILOT_PROVIDER_BASE_URL"] === true;
  let mode: LaneMode | null = opts.lane ?? (native ? "native" : byok ? "byok" : null);
  if (mode === null) {
    if (buildKind === "native") {
      // The current CLI (v1.0.x) is a compiled binary: its JS is embedded
      // compressed, so the string grep above cannot see the env knobs even
      // though the build honors them (verified live: COPILOT_API_URL and
      // COPILOT_PROVIDER_* both work on v1.0.88). Assume the native lane.
      mode = "native";
      log("note: current native binary build — the redirect knobs are compiled into the");
      log("      executable (compressed) and invisible to the string scan. Proceeding on");
      log("      the NATIVE lane. For a local/self-hosted model, force BYOK:");
      log("        tds copilot --lane byok   (with CTXROOM_COPILOT_API_URL=<your endpoint>)");
    } else {
      log("error: this copilot build exposes neither COPILOT_API_URL nor COPILOT_PROVIDER_* —");
      log("       the proxy cannot be wired in. Try upgrading the CLI (headroom-style redirect).");
      return 1;
    }
  }
  if (mode === "byok") {
    if (opts.lane) {
      log("lane: BYOK (forced) — the provider base URL points at the tds proxy;");
      log("      set CTXROOM_COPILOT_API_URL to the endpoint the proxy should forward to");
      log("      (default: your normal Copilot upstream).");
    } else if (!native) {
      log("warning: this copilot build does not support COPILOT_API_URL — falling back to the");
      log("         BYOK provider lane. NOTE: BYOK is a single-model lane (no model picker;");
      log("         the CLI's provider model is what runs).");
    }
  }

  // 3. proxy
  const ensured = await ensureProxy({ port, home, log });

  // 4. launch env
  const baseEnv = opts.env ?? process.env;
  const launchEnv = buildLaunchEnv(baseEnv, ensured.port, mode);

  // 5. MCP config (marked block; pristine original backed up once)
  const mcpKind = buildKind === "native" ? "native" : "js";
  const configPath = opts.mcpConfigPath ?? defaultMcpConfigPath(os.homedir(), mcpKind);
  const merge = mergeMcpConfig(configPath, mcpEntry(resolveMcpServerPath(fileURLToPath(import.meta.url)), mcpKind));
  if (!merge.ok) {
    log(`warning: MCP config merge at ${configPath}: ${merge.detail} (continuing without MCP tools)`);
  } else {
    log(`mcp: retrieval tool registered in ${configPath} (${merge.detail})`);
  }

  // 6. spawn + pass through the exit code
  const doSpawn =
    opts.spawn ??
    ((cmd: string, args: string[], env: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const child = spawn(cmd, args, { stdio: "inherit", env });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      }));

  const writer = new StatsWriter(undefined, home);
  const rowsBefore = (await writer.readAll(0)).length;
  const code = await doSpawn(copilotPath, opts.spawnArgs ?? [], launchEnv);

  // 6.5 — A4: zero-requests diagnostic. copilot exited, but the proxy
  // recorded nothing for this run ⇒ the wiring never engaged (the most
  // common real-world mystery: "tds ran, but I see no savings").
  {
    // The proxy appends stats rows fire-and-forget; give it a beat to flush.
    await new Promise((r) => setTimeout(r, 250));
    const rowsAfter = (await writer.readAll(0)).length;
    const newRows = rowsAfter - rowsBefore;
    const spawnArgs = opts.spawnArgs ?? [];
    const trivial = spawnArgs.some((a) => a === "--version" || a === "-v" || a === "--help" || a === "-h");
    if (newRows === 0 && !trivial) {
      log(`note: copilot exited (code ${code}) but the tds proxy recorded ZERO requests —`);
      log("      nothing was compressed. Most likely causes, in order:");
      log(`        1. this copilot build did not honor the ${mode === "byok" ? "COPILOT_PROVIDER_* (BYOK)" : "COPILOT_API_URL (native)"} env — check \`tds doctor\`;`);
      log("        2. copilot failed before its first API call (auth, missing model, bad flags) — see its output above;");
      log(`        3. the upstream (${mode === "byok" ? process.env.CTXROOM_COPILOT_API_URL || "your endpoint" : "api.githubcopilot.com"}) is unreachable from this machine.`);
      log(`      stats so far: ${rowsAfter} request(s) in ${home}/stats — \`tds stats --days 1\``);
    }
  }

  // 7. proxy lifecycle
  if (opts.stopProxyOnExit) {
    await stopProxy({ port: ensured.port, log });
  } else if (ensured.started) {
    log(`tds proxy left running on 127.0.0.1:${ensured.port} (stop it with \`tds copilot --stop-proxy\` or \`tds unwrap\`)`);
  }
  return code;
}

/** `--copilot <path>` flag (or CTXROOM_COPILOT_PATH) overrides the search. */
export function copilotPathOverride(flags: Record<string, string | number | boolean>, env: Record<string, string | undefined> = process.env): string | undefined {
  const flag = typeof flags.copilot === "string" ? flags.copilot : undefined;
  return flag ?? (env.CTXROOM_COPILOT_PATH || undefined);
}

/** `--lane native|byok` flag (or CTXROOM_COPILOT_LANE) forces the lane. */
export function laneOverride(flags: Record<string, string | number | boolean>, env: Record<string, string | undefined> = process.env): LaneMode | undefined {
  const v = typeof flags.lane === "string" ? flags.lane : env.CTXROOM_COPILOT_LANE;
  return v === "native" || v === "byok" ? v : undefined;
}

/** The flags tds itself consumes; everything else is forwarded to copilot. */
const CTXROOM_FLAGS = new Set(["port", "lane", "copilot", "config", "doctor", "stop-proxy"]);

/**
 * What copilot actually receives: every positional plus every flag that is
 * NOT tds's own. This is how `tds copilot -p "…" --model x` works —
 * tds's parser would otherwise swallow `--model`.
 */
export function copilotSpawnArgs(flags: Record<string, string | number | boolean>, positional: string[]): string[] {
  const out = [...positional];
  for (const [k, v] of Object.entries(flags)) {
    if (CTXROOM_FLAGS.has(k)) continue;
    out.push(`--${k}`);
    if (v !== true) out.push(String(v));
  }
  return out;
}

export async function cmdCopilot(args: string[]): Promise<number> {
  const { flags, positional } = parseArgs(args);
  const copilotPath = copilotPathOverride(flags);
  if (copilotPath && !existsSync(copilotPath)) {
    console.error(`error: the copilot path you gave does not exist: ${copilotPath}`);
    return 1;
  }
  const lane = laneOverride(flags);
  if (flags.doctor) {
    const report = await runDoctor({ port: flagNumber(flags, "port"), copilotPath, lane });
    printDoctor(report);
    return report.broken ? 1 : 0;
  }
  const port = flagNumber(flags, "port") ?? DEFAULT_PORT;
  return runCopilot({
    port,
    copilotPath,
    lane,
    spawnArgs: copilotSpawnArgs(flags, positional),
    stopProxyOnExit: flags["stop-proxy"] === true || flags["stop-proxy"] === "true",
  });
}

// ---------------------------------------------------------------------------
// Other commands
// ---------------------------------------------------------------------------

export async function cmdUnwrap(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  // The user's --config wins; otherwise operate on whichever known location
  // actually holds our marked block (native builds: mcp-config.json, older:
  // mcp.json), falling back to the native one.
  const known = [defaultMcpConfigPath(), defaultMcpConfigPath(os.homedir(), "native")];
  let configPath = typeof flags.config === "string" ? (flags.config as string) : null;
  if (!configPath) {
    configPath = known.find((p) => existsSync(p) && readFileSync(p, "utf8").includes("ctxroom:begin"))
      ?? known.find((p) => existsSync(p))
      ?? known[1];
  }
  const result = unwrapMcpConfig(configPath);
  console.log(`mcp: ${result.detail} (${configPath})`);
  const ensured = await stopProxy({ port: flagNumber(flags, "port") ?? DEFAULT_PORT });
  console.log(ensured.stopped ? "proxy: stopped" : "proxy: not running (nothing to stop)");
  return result.ok ? 0 : 1;
}

export async function cmdDoctor(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const report = await runDoctor({
    port: flagNumber(flags, "port"),
    copilotPath: copilotPathOverride(flags),
    lane: laneOverride(flags),
    dsh: flags["dsh"] === true || flags["dsh"] === "true",
    dshHome: typeof flags["dsh-home"] === "string" ? flags["dsh-home"] : undefined,
    dshUpstream: typeof flags["dsh-upstream"] === "string" ? flags["dsh-upstream"] : undefined,
  });
  printDoctor(report);
  return report.broken ? 1 : 0;
}

/** `tds dsh` — wire DSH through tds (or undo it). */
export async function cmdDsh(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  return runDsh({
    upstream: typeof flags["upstream"] === "string" ? flags["upstream"] : undefined,
    port: flagNumber(flags, "port"),
    provider: typeof flags["provider"] === "string" ? flags["provider"] : undefined,
    model: typeof flags["model"] === "string" ? flags["model"] : undefined,
    name: typeof flags["name"] === "string" ? flags["name"] : undefined,
    noMcp: flags["no-mcp"] === true || flags["no-mcp"] === "true",
    undo: flags["undo"] === true || flags["undo"] === "true",
    dshHome: typeof flags["dsh-home"] === "string" ? flags["dsh-home"] : undefined,
    ctxroomHomeDir: typeof flags["home"] === "string" ? flags["home"] : undefined,
  });
}

async function cmdProxy(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  await runProxy({
    port: flagNumber(flags, "port") ?? DEFAULT_PORT,
    ccr: typeof flags.ccr === "string" ? (flags.ccr as string) : undefined,
    budget: flagNumber(flags, "budget"),
  });
  return 0;
}

async function cmdStats(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  return runStats({
    days: flagNumber(flags, "days") ?? 7,
    model: typeof flags.model === "string" ? (flags.model as string) : undefined,
  });
}

async function cmdSimulate(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const file = typeof flags.file === "string" ? (flags.file as string) : undefined;
  if (!file) {
    console.error("usage: tds simulate --file prompt.json");
    return 1;
  }
  return runSimulate(file);
}

async function cmdRetrieve(args: string[]): Promise<number> {
  const { flags, positional } = parseArgs(args);
  const hash = positional[0];
  if (!hash) {
    console.error("usage: tds retrieve <hash> [maxChars]");
    return 1;
  }
  const maxChars = flagNumber(flags, "max-chars") ?? (positional[1] ? Number(positional[1]) : undefined);
  return runRetrieve(hash, maxChars);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export const USAGE = `tds — token-disrespector · local-first context compression for AI coding agents

Usage:
  tds copilot [args…]            run copilot through the compression proxy
                                     [--port N] [--stop-proxy] [--config PATH]
                                     [--doctor] [--copilot PATH] [--lane native|byok]
                                     (everything else — -p, --model, prompts — is
                                      forwarded to copilot verbatim)
  tds dsh [--upstream URL]       wire DSH through tds (opt-in; nothing runs
        [--port N]               uninvited): ensures the proxy, adds the provider
        [--provider P]           twin + agent-default flip to settings.yaml, and
        [--model M]              the ctxroom MCP entry. After a reboot, re-run it.
        [--undo]                 remove everything (restore backups, stop proxy)
  tds unwrap [--config PATH]     remove the marked MCP block, restore backup, stop proxy
  tds doctor [--port N]          environment checklist (exit 1 if broken)
                                     [--copilot PATH] [--lane native|byok]
                                     [--dsh] [--dsh-home DIR] [--dsh-upstream URL]
  tds proxy [--port N] [--ccr on|off] [--budget N]
  tds stats [--days 7] [--model M]
  tds simulate --file prompt.json  offline engine run (no network)
  tds retrieve <hash> [maxChars]   fetch a compressed original from CCR

Environment:
  CTXROOM_HOME            base dir (default ~/.ctxroom): cache/ + stats/
  CTXROOM_COPILOT_PATH    where the copilot binary lives (same as --copilot)
  CTXROOM_COPILOT_LANE    native|byok — same as --lane (local models: byok)
  CTXROOM_COPILOT_API_URL where the PROXY forwards (upstream) — e.g. a local
                          OpenAI-compatible endpoint like http://localhost:8000
  CTXROOM_CCR             on|off (default on) — off disables lossy compression
  CTXROOM_BUDGET / CTXROOM_TOKEN_BUDGET  aggressive history compression
  CTXROOM_MIN_INPUT_WORDS blocks below this many words are never compressed
  GITHUB_COPILOT_ENTERPRISE_URL / _DOMAIN, GITHUB_COPILOT_ACCOUNT
  NODE_EXTRA_CA_CERTS     corporate TLS roots (honored by the proxy's fetch)
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "copilot":
      return cmdCopilot(rest);
    case "unwrap":
      return cmdUnwrap(rest);
    case "dsh":
      return cmdDsh(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "proxy":
      return cmdProxy(rest);
    case "stats":
      return cmdStats(rest);
    case "simulate":
      return cmdSimulate(rest);
    case "retrieve":
      return cmdRetrieve(rest);
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

// Auto-run when executed directly (node packages/cli/src/index.ts …).
// When imported (tests), main() is not invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.stack ?? e));
      process.exit(1);
    }
  );
}

export { copilotEnvMatrix };

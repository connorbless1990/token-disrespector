#!/usr/bin/env node
/**
 * ctxroom — CLI entry point. Hand-rolled arg parsing (zero dependencies).
 *
 *   ctxroom copilot [args…]   run copilot through the compression proxy
 *   ctxroom unwrap            remove the marked MCP block; stop the proxy
 *   ctxroom doctor            environment checklist (exit 1 if broken)
 *   ctxroom proxy [--port N] [--ccr on|off] [--budget N]
 *   ctxroom stats [--days 7] [--model M]
 *   ctxroom simulate --file prompt.json
 *   ctxroom retrieve <hash> [maxChars]
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_PORT,
  buildLaunchEnv,
  copilotEnvMatrix,
  defaultMcpConfigPath,
  ensureProxy,
  findCopilot,
  mergeMcpConfig,
  mcpEntry,
  resolveMcpServerPath,
  scanBundle,
  stopProxy,
  unwrapMcpConfig,
  type BundleScanResult,
  type LaneMode,
} from "./copilot.ts";
import { printDoctor, runDoctor } from "./doctor.ts";
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
  stopProxyOnExit?: boolean;
  env?: Record<string, string | undefined>;
  spawn?: (cmd: string, args: string[], env: Record<string, string>) => Promise<number>;
  log?: (line: string) => void;
}

/**
 * The full copilot flow:
 *   1. locate copilot   2. feature-detect the installed bundle
 *   3. ensure proxy     4. pick the lane (native vs BYOK) + build env
 *   5. merge the MCP config (marked block, backed up)
 *   6. spawn copilot, pass through the exit code, keep the proxy running
 *      (unless --stop-proxy).
 */
export async function runCopilot(opts: CopilotRunOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const port = opts.port ?? DEFAULT_PORT;

  // 1. locate
  const copilotPath = opts.copilotPath === undefined ? findCopilot() : opts.copilotPath;
  if (!copilotPath) {
    log("error: could not find the `copilot` binary (PATH, ~/.local/bin, brew prefix, ~/.copilot).");
    log("       install it, or reinstall ctxroom after the install so the PATH check passes.");
    return 1;
  }

  // 2. feature detection
  const scan = opts.scan === undefined ? scanBundle() : opts.scan;
  const native = scan?.markers["COPILOT_API_URL"] === true;
  const byok = scan?.markers["COPILOT_PROVIDER_BASE_URL"] === true;
  let mode: LaneMode | null = native ? "native" : byok ? "byok" : null;
  if (!mode) {
    log("error: this copilot build exposes neither COPILOT_API_URL nor COPILOT_PROVIDER_* —");
    log("       the proxy cannot be wired in. Try upgrading the CLI (headroom-style redirect).");
    return 1;
  }
  if (mode === "byok") {
    log("warning: this copilot build does not support COPILOT_API_URL — falling back to the");
    log("         BYOK provider lane. NOTE: BYOK is a single-model lane (no model picker;");
    log("         the CLI's provider model is what runs).");
  }

  // 3. proxy
  const ensured = await ensureProxy({ port, log });

  // 4. launch env
  const baseEnv = opts.env ?? process.env;
  const launchEnv = buildLaunchEnv(baseEnv, ensured.port, mode);

  // 5. MCP config (marked block; pristine original backed up once)
  const configPath = opts.mcpConfigPath ?? defaultMcpConfigPath();
  const merge = mergeMcpConfig(configPath, mcpEntry(resolveMcpServerPath(fileURLToPath(import.meta.url))));
  if (!merge.ok) {
    log(`warning: MCP config merge at ${configPath}: ${merge.detail} (continuing without MCP tools)`);
  } else {
    log(`mcp: ctxroom registered in ${configPath} (${merge.detail})`);
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

  const code = await doSpawn(copilotPath, opts.spawnArgs ?? [], launchEnv);

  // 7. proxy lifecycle
  if (opts.stopProxyOnExit) {
    await stopProxy({ port: ensured.port, log });
  } else if (ensured.started) {
    log(`ctxroom proxy left running on 127.0.0.1:${ensured.port} (stop it with \`ctxroom copilot --stop-proxy\` or \`ctxroom unwrap\`)`);
  }
  return code;
}

export async function cmdCopilot(args: string[]): Promise<number> {
  const { flags, positional } = parseArgs(args);
  if (flags.doctor) {
    const report = await runDoctor({ port: flagNumber(flags, "port") });
    printDoctor(report);
    return report.broken ? 1 : 0;
  }
  const port = flagNumber(flags, "port") ?? DEFAULT_PORT;
  return runCopilot({
    port,
    spawnArgs: positional,
    stopProxyOnExit: flags["stop-proxy"] === true || flags["stop-proxy"] === "true",
  });
}

// ---------------------------------------------------------------------------
// Other commands
// ---------------------------------------------------------------------------

export async function cmdUnwrap(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const configPath = typeof flags.config === "string" ? (flags.config as string) : defaultMcpConfigPath();
  const result = unwrapMcpConfig(configPath);
  console.log(`mcp: ${result.detail} (${configPath})`);
  const ensured = await stopProxy({ port: flagNumber(flags, "port") ?? DEFAULT_PORT });
  console.log(ensured.stopped ? "proxy: stopped" : "proxy: not running (nothing to stop)");
  return result.ok ? 0 : 1;
}

export async function cmdDoctor(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const report = await runDoctor({ port: flagNumber(flags, "port") });
  printDoctor(report);
  return report.broken ? 1 : 0;
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
    console.error("usage: ctxroom simulate --file prompt.json");
    return 1;
  }
  return runSimulate(file);
}

async function cmdRetrieve(args: string[]): Promise<number> {
  const { flags, positional } = parseArgs(args);
  const hash = positional[0];
  if (!hash) {
    console.error("usage: ctxroom retrieve <hash> [maxChars]");
    return 1;
  }
  const maxChars = flagNumber(flags, "max-chars") ?? (positional[1] ? Number(positional[1]) : undefined);
  return runRetrieve(hash, maxChars);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export const USAGE = `ctxroom — local-first context compression for AI coding agents

Usage:
  ctxroom copilot [args…]            run copilot through the compression proxy
                                     [--port N] [--stop-proxy] [--config PATH] [--doctor]
  ctxroom unwrap [--config PATH]     remove the marked MCP block, restore backup, stop proxy
  ctxroom doctor [--port N]          environment checklist (exit 1 if broken)
  ctxroom proxy [--port N] [--ccr on|off] [--budget N]
  ctxroom stats [--days 7] [--model M]
  ctxroom simulate --file prompt.json  offline engine run (no network)
  ctxroom retrieve <hash> [maxChars]   fetch a compressed original from CCR

Environment:
  CTXROOM_HOME            base dir (default ~/.ctxroom): cache/ + stats/
  CTXROOM_COPILOT_API_URL explicit upstream override for the proxy
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

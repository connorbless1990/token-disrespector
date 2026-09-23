/**
 * Copilot CLI integration — everything is injectable so the whole flow is
 * unit-testable WITHOUT the Copilot CLI installed (env-matrix builders,
 * feature detection against a path arg, MCP-config merge against a temp
 * file). The real CLI only enters at the final spawn.
 *
 * Verified Copilot-API facts (from headroomlabs-ai/headroom):
 *  - native lane: COPILOT_API_URL + COPILOT_AUTH_MODE=github-native
 *    (client-side redirect; model picker untouched, no BYOK).
 *  - BYOK lane: COPILOT_PROVIDER_BASE_URL + COPILOT_PROVIDER_TYPE
 *    (openai|anthropic) + COPILOT_PROVIDER_WIRE_API (completions|responses)
 *    [+ COPILOT_PROVIDER_BEARER_TOKEN].
 *  - The CLI cannot send custom headers → project attribution rides the
 *    /p/<name> base prefix in COPILOT_API_URL.
 *  - Feature detection (headroom's trick): grep the installed JS bundle for
 *    COPILOT_API_URL.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 8788;
export const MCP_BEGIN = "// ctxroom:begin";
export const MCP_END = "// ctxroom:end";

// ---------------------------------------------------------------------------
// 1. Locate the Copilot CLI
// ---------------------------------------------------------------------------

export interface LocateOptions {
  /** Directories to search (default: $PATH + standard install dirs). */
  dirs?: string[];
  /** Binary name (default: copilot / copilot.exe on win). */
  binName?: string;
  home?: string;
}

export function defaultCopilotDirs(home: string = os.homedir()): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, ".local", "bin"));
  if (process.platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs"));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  } else {
    dirs.push("/usr/local/bin");
  }
  return [...new Set(dirs)];
}

/** Find the copilot binary; returns an absolute path or null. */
export function findCopilot(opts: LocateOptions = {}): string | null {
  const home = opts.home ?? os.homedir();
  const bin = opts.binName ?? (process.platform === "win32" ? "copilot.exe" : "copilot");
  const dirs = opts.dirs ?? defaultCopilotDirs(home);
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      // stat, NOT lstat: the standard layouts (npm/bun/brew global bins)
      // ARE symlinks into the package tree. lstat would report the link
      // itself — "not a file" — and skip exactly those installs. stat
      // follows the link: a dangling link throws, a directory fails
      // isFile, both are skipped; a real file (direct or linked) passes.
      if (!statSync(p).isFile()) continue;
      if (process.platform !== "win32" && accessSync(p, constants.X_OK) === undefined) {
        // accessSync follows the link to the target and checks its exec
        // bit; throws on EACCES/ENOENT, success returns undefined
      }
      return path.resolve(p);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Best-effort version probe (`copilot --version`). */
export function copilotVersion(copilotPath: string, timeoutMs = 5000): string | null {
  try {
    const res = spawnSync(copilotPath, ["--version"], { timeout: timeoutMs, encoding: "utf8" });
    const out = (res.stdout ?? "").trim();
    return out || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Feature detection: grep the installed bundle for the redirect knobs
// ---------------------------------------------------------------------------

export interface BundleScanOptions {
  /** Roots to walk (injectable for tests). Default: platform install locations. */
  roots?: string[];
  /** home used to build the default roots. */
  home?: string;
  /** Markers to look for. Default: the native + BYOK env knobs. */
  markers?: string[];
  maxDepth?: number;
  /** Hard cap on files content-scanned. */
  maxFiles?: number;
  /** Skip files larger than this (minified bundles). */
  maxFileBytes?: number;
}

export interface BundleScanResult {
  /** True when at least one marker was found. */
  supported: boolean;
  /** marker → found (native lane = COPILOT_API_URL, BYOK = COPILOT_PROVIDER_BASE_URL). */
  markers: Record<string, boolean>;
  /** The bundle file that satisfied the first marker. */
  bundlePath: string | null;
  filesScanned: number;
}

export function defaultBundleRoots(home: string = os.homedir()): string[] {
  const roots = [path.join(home, ".local", "share", "copilot")];
  if (process.platform === "darwin") {
    roots.push(path.join(home, "Library"));
    roots.push("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");
  } else if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
    if (process.env.APPDATA) roots.push(process.env.APPDATA);
  } else {
    roots.push(path.join(home, ".npm-global", "lib", "node_modules"), path.join(home, ".local", "lib", "node_modules"), "/usr/local/lib/node_modules");
  }
  return roots;
}

const PRUNE_DIRS = new Set(["caches", "trash", ".trash", ".git", ".cache", ".npm", "code"]);

/**
 * Walk the install roots looking for a JS bundle containing the marker
 * strings. Breadth-first with copilot/pkg-named directories prioritized so
 * the real bundle is found before the file cap is exhausted. Best effort:
 * any failure simply reports "not found".
 */
export function scanBundle(opts: BundleScanOptions = {}): BundleScanResult {
  const home = opts.home ?? os.homedir();
  const roots = opts.roots ?? defaultBundleRoots(home);
  const markers = opts.markers ?? ["COPILOT_API_URL", "COPILOT_PROVIDER_BASE_URL"];
  const maxDepth = opts.maxDepth ?? 12;
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 25 * 1024 * 1024;

  const found: Record<string, boolean> = Object.fromEntries(markers.map((m) => [m, false]));
  let bundlePath: string | null = null;
  let filesScanned = 0;

  const queue: { dir: string; depth: number }[] = [];
  for (const r of roots) {
    try {
      if (statSync(r).isDirectory()) queue.push({ dir: r, depth: 0 });
    } catch {
      /* root missing */
    }
  }

  outer: while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // copilot/pkg directories first — that is where the bundle lives.
    entries.sort((a, b) => Number(/copilot|pkg/i.test(b.name)) - Number(/copilot|pkg/i.test(a.name)));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        if (PRUNE_DIRS.has(e.name.toLowerCase())) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && /\.(js|mjs|cjs)$/i.test(e.name)) {
        if (filesScanned >= maxFiles) break outer;
        filesScanned++;
        try {
          if (statSync(full).size > maxFileBytes) continue;
          const text = readFileSync(full, "utf8");
          for (const m of markers) {
            if (!found[m] && text.includes(m)) {
              found[m] = true;
              if (!bundlePath) bundlePath = full;
            }
          }
          if (markers.every((m) => found[m])) break outer;
        } catch {
          /* unreadable file */
        }
      }
    }
  }

  return {
    supported: Object.values(found).some(Boolean),
    markers: found,
    bundlePath,
    filesScanned,
  };
}

// ---------------------------------------------------------------------------
// 3. Launch environment (native vs BYOK lane)
// ---------------------------------------------------------------------------

export type LaneMode = "native" | "byok";

const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

/** The lane-specific env vars (pure function of port + mode). */
export function copilotEnvMatrix(port: number, mode: LaneMode): Record<string, string> {
  if (mode === "native") {
    // Client-side redirect: the CLI dials the proxy with native GitHub auth;
    // upstream we forward Authorization verbatim, so token exchange still
    // happens exactly as it would against api.githubcopilot.com.
    return {
      COPILOT_API_URL: `http://127.0.0.1:${port}`,
      COPILOT_AUTH_MODE: "github-native",
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    };
  }
  // BYOK fallback: single-model lane (the CLI picks one provider model; the
  // model picker of the native lane is unavailable). The proxy speaks
  // chat-completions under /v1, so WIRE_API=completions.
  return {
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    COPILOT_PROVIDER_WIRE_API: "completions",
    GITHUB_COPILOT_USE_TOKEN_EXCHANGE: "false",
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
  };
}

/**
 * Full spawn environment: inherited env + lane vars, with the OTHER lane's
 * variables stripped so a stale export cannot hijack the active lane.
 */
export function buildLaunchEnv(base: Record<string, string | undefined>, port: number, mode: LaneMode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || v === "") continue;
    env[k] = v;
  }
  Object.assign(env, copilotEnvMatrix(port, mode));
  for (const k of Object.keys(env)) {
    if (mode === "native" && k.startsWith("COPILOT_PROVIDER_")) delete env[k];
    else if (mode === "byok" && (k === "COPILOT_API_URL" || k === "COPILOT_AUTH_MODE")) delete env[k];
  }
  return env;
}

// ---------------------------------------------------------------------------
// 4. Proxy lifecycle (ensure running / stop)
// ---------------------------------------------------------------------------

export function pidfileFor(port: number, home: string = process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom")): string {
  return path.join(home, `proxy-${port}.json`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but is not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function healthOk(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

export interface EnsureProxyOptions {
  port?: number;
  home?: string;
  /** Absolute path to the CLI entry (for the detached spawn). Default: this file. */
  cliPath?: string;
  log?: (line: string) => void;
}

/**
 * Make sure a healthy proxy is listening on the port. If one is already
 * healthy, do nothing. Otherwise spawn a detached `ctxroom proxy`, record a
 * pidfile, and wait for /health.
 */
export async function ensureProxy(opts: EnsureProxyOptions = {}): Promise<{ port: number; started: boolean; pid?: number }> {
  const port = opts.port ?? DEFAULT_PORT;
  const home = opts.home ?? process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
  const log = opts.log ?? (() => {});
  const healthUrl = `http://127.0.0.1:${port}/health`;

  if (await healthOk(healthUrl)) return { port, started: false };

  // A recorded pid that is alive but not healthy = wedged proxy: nudge it.
  const pidfile = pidfileFor(port, home);
  try {
    const old = JSON.parse(readFileSync(pidfile, "utf8")) as { pid?: number };
    if (old.pid && isAlive(old.pid)) {
      try {
        process.kill(old.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no pidfile */
  }

  // NOTE: this module is copilot.ts, NOT the entry — the detached proxy
  // must run the real CLI entry (index.ts), which auto-runs main().
  const cliPath = opts.cliPath ?? fileURLToPath(new URL("./index.ts", import.meta.url));
  log(`starting ctxroom proxy on 127.0.0.1:${port} …`);
  const child: ChildProcess = spawn(process.execPath, [cliPath, "proxy", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CTXROOM_HOME: home },
  });
  child.unref();

  mkdirSync(home, { recursive: true });
  if (child.pid) {
    try {
      writeFileSync(pidfile, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }));
    } catch {
      /* non-fatal */
    }
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await healthOk(healthUrl)) {
      log(`proxy ready on 127.0.0.1:${port}${child.pid ? ` (pid ${child.pid})` : ""}`);
      return { port, started: true, pid: child.pid };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`ctxroom proxy did not become healthy at ${healthUrl} within 15s — run \`ctxroom doctor\` to inspect`);
}

export async function stopProxy(opts: { port?: number; home?: string; log?: (l: string) => void } = {}): Promise<{ stopped: boolean }> {
  const port = opts.port ?? DEFAULT_PORT;
  const home = opts.home ?? process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
  const log = opts.log ?? (() => {});
  const pidfile = pidfileFor(port, home);

  let pid: number | null = null;
  try {
    pid = (JSON.parse(readFileSync(pidfile, "utf8")) as { pid?: number }).pid ?? null;
  } catch {
    /* no pidfile */
  }

  if (!pid || !isAlive(pid)) {
    if (await healthOk(`http://127.0.0.1:${port}/health`)) {
      log(`note: 127.0.0.1:${port} is serving a ctxroom proxy we did not start; leaving it running`);
      return { stopped: false };
    }
    try {
      if (existsSync(pidfile)) rmSync(pidfile);
    } catch {
      /* ignore */
    }
    return { stopped: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    if (existsSync(pidfile)) rmSync(pidfile);
  } catch {
    /* ignore */
  }
  log(`proxy on 127.0.0.1:${port} stopped`);
  return { stopped: true };
}

// ---------------------------------------------------------------------------
// 5. MCP config merge / unwrap (JSONC, marked block, backup)
// ---------------------------------------------------------------------------

/** Where the copilot CLI keeps its MCP config (injectable via --config). */
export function defaultMcpConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".copilot", "mcp.json");
}

/** Absolute path of the MCP server entry the CLI should spawn. */
export function resolveMcpServerPath(cliPath: string = fileURLToPath(import.meta.url)): string {
  return path.resolve(path.dirname(cliPath), "..", "..", "mcp", "src", "index.ts");
}

export function mcpEntry(mcpSrcPath: string): Record<string, unknown> {
  return { name: "ctxroom", command: "node", args: [mcpSrcPath] };
}

// --- JSONC string/comment-aware scanner -------------------------------------

function skipLineComment(raw: string, i: number): number {
  const nl = raw.indexOf("\n", i);
  return nl === -1 ? raw.length : nl;
}

function skipBlockComment(raw: string, i: number): number {
  const end = raw.indexOf("*/", i + 2);
  return end === -1 ? raw.length : end + 2;
}

function skipString(raw: string, i: number): number {
  // raw[i] === '"'
  i++;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return raw.length;
}

function skipWsComments(raw: string, i: number): number {
  for (;;) {
    while (i < raw.length && (raw.charCodeAt(i) <= 32)) i++;
    if (raw[i] === "/" && raw[i + 1] === "/") i = skipLineComment(raw, i);
    else if (raw[i] === "/" && raw[i + 1] === "*") i = skipBlockComment(raw, i);
    else return i;
  }
}

function skipValue(raw: string, i: number): number {
  i = skipWsComments(raw, i);
  const c = raw[i];
  if (c === "{") return skipContainer(raw, i, "{", "}");
  if (c === "[") return skipContainer(raw, i, "[", "]");
  if (c === '"') return skipString(raw, i);
  while (i < raw.length && !/[,\n\r\t ]/.test(raw[i])) i++;
  return i;
}

function skipContainer(raw: string, i: number, open: string, close: string): number {
  let depth = 1;
  i++;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      i = skipString(raw, i);
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      i = skipLineComment(raw, i);
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i = skipBlockComment(raw, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return raw.length; // unbalanced — treated as "no span" by callers
}

export interface McpServersSpan {
  start: number; // first char of the value
  end: number; // char just past the value's close bracket
  kind: "array" | "object" | "other";
  rootEnd: number; // index of the root object's closing '}'
}

/** Find `mcpServers` in the ROOT object of a JSONC document, or null. */
export function findMcpServersSpan(raw: string): McpServersSpan | null {
  let i = skipWsComments(raw, 0);
  if (raw[i] !== "{") return null;
  i++;
  for (;;) {
    i = skipWsComments(raw, i);
    if (i >= raw.length) return null; // unbalanced
    if (raw[i] === "}") return null; // root ended
    if (raw[i] !== '"') return null; // malformed
    const strEnd = skipString(raw, i);
    const key = raw.slice(i + 1, strEnd - 1);
    let j = skipWsComments(raw, strEnd);
    if (raw[j] !== ":") return null;
    j = skipWsComments(raw, j + 1);
    const start = j;
    const end = skipValue(raw, j);
    if (key === "mcpServers" && end < raw.length) {
      const kind: McpServersSpan["kind"] = raw[start] === "[" ? "array" : raw[start] === "{" ? "object" : "other";
      // rootEnd: keep skipping root members until the closing brace
      let k = end;
      let rootEnd = raw.length - 1 >= 0 ? -1 : -1;
      for (;;) {
        k = skipWsComments(raw, k);
        if (raw[k] === "}") {
          rootEnd = k;
          break;
        }
        if (raw[k] === ",") {
          k++;
          continue;
        }
        if (k >= raw.length || raw[k] !== '"') break; // malformed
        const e2 = skipValue(raw, skipWsComments(raw, skipString(raw, k) + 1));
        if (e2 >= raw.length) break;
        k = e2;
      }
      return { start, end, kind, rootEnd };
    }
    j = skipWsComments(raw, end);
    if (raw[j] === ",") {
      i = j + 1;
    } else if (raw[j] === "}") {
      return null; // root ended without mcpServers
    } else {
      return null; // malformed
    }
  }
}

/** Strip // and /* *​/ comments (string-aware) for validation. */
export function stripJsoncComments(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      const end = skipString(raw, i);
      out += raw.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      const nl = raw.indexOf("\n", i);
      i = nl === -1 ? raw.length : nl;
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i = skipBlockComment(raw, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function jsoncValid(raw: string): boolean {
  try {
    JSON.parse(stripJsoncComments(raw));
    return true;
  } catch {
    return false;
  }
}

// --- block rendering & surgery ----------------------------------------------

function entryLine(entry: Record<string, unknown>, indent: string): string {
  return indent + JSON.stringify(entry);
}

/**
 * Render the marked block for the given placement:
 *  - "array" entry  → the entry object itself (list shape, spec-literal
 *    {name, command, args}).
 *  - "object" key   → "ctxroom": {command, args} (object shape: the key IS
 *    the name, per MCP convention).
 *  - "root" create  → a new "mcpServers" list (spec-literal shape).
 */
function renderBlock(entry: Record<string, unknown>, placement: "array" | "object" | "root", indent: string): string {
  const marker1 = `${indent}${MCP_BEGIN} — managed by ctxroom (add: \`ctxroom copilot\`, remove: \`ctxroom unwrap\`)`;
  const marker2 = `${indent}${MCP_END}`;
  if (placement === "root") {
    return [
      marker1,
      `${indent}"mcpServers": [`,
      entryLine(entry, indent + "  "),
      `${indent}]`,
      marker2,
    ].join("\n");
  }
  if (placement === "object") {
    const { name: _name, ...rest } = entry as { name?: string } & Record<string, unknown>;
    return [marker1, `${indent}${JSON.stringify(String(_name ?? "ctxroom"))}: ${JSON.stringify(rest)}`, marker2].join("\n");
  }
  return [marker1, entryLine(entry, indent), marker2].join("\n");
}

const BLOCK_RE = new RegExp(`${MCP_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MCP_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

function detectPlacement(raw: string): "array" | "object" | "root" {
  const span = findMcpServersSpan(raw);
  return span ? (span.kind === "array" || span.kind === "object" ? span.kind : "root") : "root";
}

interface Container {
  openIdx: number; // index of the opening { or [
  closeIdx: number; // index of the matching close
}

/**
 * Locate the insertion container: the existing mcpServers (array or object),
 * or the root object when mcpServers is absent (we then create it as a list —
 * the spec-literal {name, command, args} shape).
 */
function insertionContainer(raw: string): { container: Container; placement: "array" | "object" | "root" } | null {
  const span = findMcpServersSpan(raw);
  if (span && (span.kind === "array" || span.kind === "object")) {
    return { container: { openIdx: span.start, closeIdx: span.end - 1 }, placement: span.kind };
  }
  const rootEnd = lastRootBrace(raw);
  if (rootEnd < 0) return null;
  return { container: { openIdx: 0, closeIdx: rootEnd }, placement: "root" };
}

/**
 * Insert the marked block as the LAST member of a container, preserving
 * every other byte. The block carries no comma of its own; a comma is
 * spliced after the previous member when one exists. Indentation follows
 * the container's closing-bracket line.
 */
function insertBlockInContainer(raw: string, c: Container, placement: "array" | "object" | "root", entry: Record<string, unknown>): string {
  const head = raw.slice(0, c.closeIdx);
  const lastNl = head.lastIndexOf("\n");
  const after = lastNl === -1 ? "" : head.slice(lastNl + 1);
  // "hasTrailNl" = the bracket sits on its own line (only whitespace after the
  // last newline) — then we can drop that line's indent from `base`.
  const hasTrailNl = lastNl !== -1 && /^[ \t]*$/.test(after);
  const indent = hasTrailNl ? after : "  ";
  const baseFull = hasTrailNl ? head.slice(0, lastNl + 1) : head;
  // The comma (if any) belongs at the END of the previous content line — never
  // on a line of its own.
  const baseNoNl = baseFull.endsWith("\n") ? baseFull.slice(0, -1) : baseFull;
  const content = raw.slice(c.openIdx + 1, c.closeIdx);
  const isEmpty = stripJsoncComments(content).trim() === "" || (c.openIdx === 0 && stripJsoncComments(raw).trim() === "{}");
  const childIndent = indent + "  ";
  const block = renderBlock(entry, placement, childIndent);
  const sep = isEmpty ? "" : ",";
  return baseNoNl + sep + "\n" + indent + block + "\n" + indent + raw.slice(c.closeIdx);
}

/**
 * Merge the ctxroom MCP registration into the config.
 *
 * Safe-edit contract: the pristine original is backed up exactly once
 * (`<path>.ctxroom.bak`); only the marked block is added/replaced; every
 * other byte is preserved. Result is validated as JSONC (comment-stripped
 * JSON) before writing; on failure the backup is restored.
 */
export function mergeMcpConfig(
  configPath: string,
  entry: Record<string, unknown> = mcpEntry(resolveMcpServerPath())
): { ok: boolean; detail: string } {
  const backupPath = `${configPath}.ctxroom.bak`;
  const exists = existsSync(configPath);
  const raw = exists ? readFileSync(configPath, "utf8") : "";

  try {
    if (!existsSync(backupPath)) writeFileSync(backupPath, raw);

    let next: string;
    if (BLOCK_RE.test(raw)) {
      // Re-merge (upgrade): replace the marked block in place, keeping its
      // current position — only the block's bytes change.
      const m = BLOCK_RE.exec(raw)!;
      const head = raw.slice(0, m.index);
      const trail = head.match(/[ \t]*\r?$/)?.[0] ?? "";
      const childIndent = trail === "" ? "  " : trail + "  ";
      next = raw.replace(BLOCK_RE, () => renderBlock(entry, detectPlacement(raw), childIndent));
    } else if (raw.trim() === "") {
      next = "{\n" + renderBlock(entry, "root", "  ") + "\n}\n";
    } else {
      const loc = insertionContainer(raw);
      if (!loc) return { ok: false, detail: "could not locate a JSON object to merge into" };
      next = insertBlockInContainer(raw, loc.container, loc.placement, entry);
    }

    if (!jsoncValid(next)) {
      // Never write a broken config: restore the pristine original.
      if (existsSync(backupPath)) writeFileSync(configPath, readFileSync(backupPath, "utf8"));
      return { ok: false, detail: "merged config failed validation; original restored from backup" };
    }
    writeFileSync(configPath, next);
    return { ok: true, detail: exists ? "merged" : "created" };
  } catch (e) {
    if (exists && existsSync(backupPath)) {
      try {
        writeFileSync(configPath, readFileSync(backupPath, "utf8"));
      } catch {
        /* best effort */
      }
    }
    return { ok: false, detail: `merge failed: ${String(e)}` };
  }
}

/** Index of the ROOT object's closing brace (string/comment aware), or -1. */
function lastRootBrace(raw: string): number {
  let i = skipWsComments(raw, 0);
  if (raw[i] !== "{") return -1;
  return skipContainer(raw, i, "{", "}") - 1;
}

/**
 * Remove the ctxroom MCP registration.
 *
 *  - When a backup of the pristine original exists: restore it verbatim
 *    (the true undo — this also reverts any manual drift inside the file).
 *  - Otherwise: surgically delete the marked block and fix the surrounding
 *    comma so the remaining JSONC stays valid.
 */
export function unwrapMcpConfig(configPath: string): { ok: boolean; detail: string } {
  const backupPath = `${configPath}.ctxroom.bak`;
  if (!existsSync(configPath)) {
    try {
      if (existsSync(backupPath)) rmSync(backupPath);
    } catch {
      /* ignore */
    }
    return { ok: true, detail: "no config file; nothing to unwrap" };
  }
  const raw = readFileSync(configPath, "utf8");

  // Preferred: restore the pristine pre-merge original.
  if (existsSync(backupPath)) {
    const backup = readFileSync(backupPath, "utf8");
    if (!raw.includes(MCP_BEGIN) || jsoncValid(backup)) {
      writeFileSync(configPath, backup);
      rmSync(backupPath);
      return { ok: true, detail: "restored the pre-merge original" };
    }
    // Backup itself invalid (corrupt?) — fall through to surgical removal.
  }

  if (!raw.includes(MCP_BEGIN)) {
    return { ok: true, detail: "no ctxroom block found; nothing to remove" };
  }

  const m = BLOCK_RE.exec(raw);
  if (!m) return { ok: false, detail: "marked block found but is malformed" };
  const start = m.index;
  const end = m.index + m[0].length;

  // Extend the removal to the whole line(s) and to the start of the begin line.
  let lineStart = start;
  while (lineStart > 0 && raw[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = end;
  while (lineEnd < raw.length && raw[lineEnd] !== "\n") lineEnd++;

  let next = raw.slice(0, lineStart) + raw.slice(lineEnd);
  // Comma surgery: our block owns no comma; remove a dangling one so the
  // container stays valid ([a, <block>] → [a] and [<block>, b] → [b]).
  next = next.replace(/,(\s*)(?=[}\]])/g, "$1").replace(/([{\[]\s*),(\s*)/g, "$1$2");
  next = next.replace(/^\s*\n(?=\s*\})/, "") // cosmetic: drop the orphan line
    ;

  if (!jsoncValid(next)) {
    if (existsSync(backupPath)) writeFileSync(configPath, readFileSync(backupPath, "utf8"));
    return { ok: false, detail: "surgical removal produced invalid JSONC; original kept" };
  }
  writeFileSync(configPath, next);
  return { ok: true, detail: "marked block removed" };
}

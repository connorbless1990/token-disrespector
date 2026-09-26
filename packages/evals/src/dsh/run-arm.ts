/**
 * DSH A/B — run one arm of the experiment.
 *
 *   runArm({ arm: "T" | "C" | "P", index, load })
 *
 * Arm T = incoai-tds (proxy :8788, CCR on) + ctxroom MCP tools.
 * Arm C = incoai (direct :8000), no MCP tools.
 * Arm P = incoai-tds with the proxy at --ccr off (pure passthrough).
 *
 * One arm at a time, by construction: the caller sequences the arms.
 * Everything the run leaves behind (session JSONL, stats slice, answer,
 * manifest) is copied under evals/reports/dsh-ab/<run-id>/ (gitignored).
 *
 * The provider flip is a line-level edit of ~/.dsh/settings.yaml (backed up,
 * restored on exit); DSH hot-reloads it, so no restart is needed.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import os from "node:os";
import { join } from "node:path";
import { TASK, writeSeed } from "./gen-seed.ts";
import { scoreBattery } from "./battery.ts";
import { computeRunMetrics, readSessionEvents, statsInWindow, type RunMetrics } from "./measure.ts";

export type Arm = "T" | "C" | "P";

export interface RunArmOpts {
  arm: Arm;
  index: number;
  /** concurrent load session (copilot, E4 shape, direct :8000) during the run */
  load?: boolean;
  timeoutMs?: number;
  resultsDir?: string;
  quiet?: (label: string) => void; // progress sink
}

const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME ?? join(HOME, ".dsh");
const CTXROOM_HOME = process.env.CTXROOM_HOME ?? join(HOME, ".ctxroom");
const SETTINGS = join(DSH_HOME, "settings.yaml");
const PROXY_PORT = 8788;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const MODEL_URL = (process.env.CTXROOM_LIVE_MODEL_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const TDS_REPO = process.env.CTXROOM_DSH_AB_REPO ?? REPO_ROOT;

const providerFor: Record<Arm, string> = { T: "incoai-tds", C: "incoai", P: "incoai-tds" };
const ccrFor: Record<Arm, "on" | "off" | "n/a"> = { T: "on", C: "n/a", P: "off" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure line-level provider flip: rewrite `provider:` under the
 * `agent-default-model:` section only. Exported for hermetic tests.
 */
export function flipProviderLine(text: string, provider: string): string {
  const lines = text.split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^agent-default-model:/.test(lines[i]!)) inSection = true;
    else if (/^\S/.test(lines[i]!)) inSection = false;
    if (inSection && /^  provider:/.test(lines[i]!)) {
      lines[i] = `  provider: ${provider}`;
    }
  }
  return lines.join("\n");
}

function setProvider(provider: string): { backup: string } {
  const text = readFileSync(SETTINGS, "utf8");
  // Always re-snapshot: each run restores the state it found, so a user edit
  // between runs can never be clobbered by a stale backup.
  cpSync(SETTINGS, SETTINGS + ".ab.bak");
  writeFileSync(SETTINGS, flipProviderLine(text, provider));
  return { backup: SETTINGS + ".ab.bak" };
}

function restoreProvider(backup: string): void {
  if (existsSync(backup)) cpSync(backup, SETTINGS);
}

/**
 * Process guards: if the orchestrator is killed mid-run (timeout, Ctrl-C,
 * a dead session), the in-flight dsh child is killed and the settings flip
 * is restored — no orphaned experiment, no stale provider pointer.
 */
let activeChild: ChildProcess | null = null;
let activeRestore: (() => void) | null = null;
let guardsInstalled = false;

export function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const die = (sig: string): void => {
    process.stderr.write(`\n[run-arm] ${sig} received — killing experiment child, restoring settings\n`);
    if (activeChild) {
      try {
        activeChild.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (activeRestore) {
      try {
        activeRestore();
      } catch {
        /* best effort */
      }
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => die("SIGINT"));
  process.on("SIGTERM", () => die("SIGTERM"));
}

/** Find the port's listener pid (lsof), for proxy (re)start. */
function proxyPid(): number | null {
  try {
    const out = execFileSync("lsof", ["-nP", "-tiTCP:" + PROXY_PORT, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function proxyHealth(): Promise<{ ok: boolean; ccr?: boolean }> {
  try {
    const r = await fetch(PROXY_URL + "/health");
    return (await r.json()) as { ok: boolean; ccr?: boolean };
  } catch {
    return { ok: false };
  }
}

/** Ensure the proxy is running in the arm's mode (restart if needed). */
async function ensureProxyMode(arm: Arm): Promise<void> {
  const want = ccrFor[arm];
  if (want === "n/a") return; // control: proxy state irrelevant
  const current = await proxyHealth();
  if (current.ok && (current.ccr === (want === "on"))) return;
  // restart in the requested mode
  const pid = proxyPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 20 && proxyPid() !== null; i++) await sleep(250);
  }
  const args = [join(TDS_REPO, "packages/cli/src/index.ts"), "proxy", "--port", String(PROXY_PORT)];
  if (want === "off") args.push("--ccr", "off");
  const child = spawn(process.execPath, args, {
    cwd: TDS_REPO,
    env: { ...process.env, CTXROOM_COPILOT_API_URL: MODEL_URL, CTXROOM_HOME },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  const proxyOut = child.stdout as (import("node:stream").Readable & { on: (ev: string, fn: (d: Buffer) => void) => unknown }) | null;
  if (proxyOut) proxyOut.on("data", (d: Buffer) => process.stderr.write(`[proxy] ${d}`));
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const h = await proxyHealth();
    if (h.ok && h.ccr === (want === "on")) return;
  }
  throw new Error(`proxy did not come up in mode ccr=${want}`);
}

/** Quiet-window gate: model alive + one tiny request, TTFT reported. */
async function modelProbe(): Promise<{ alive: boolean; ttftS: number | null; latencyMs: number | null }> {
  try {
    const r = await fetch(MODEL_URL + "/v1/models");
    if (!r.ok) return { alive: false, ttftS: null, latencyMs: null };
  } catch {
    return { alive: false, ttftS: null, latencyMs: null };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(MODEL_URL + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "incoai/Qwen3.8-27B-Splash",
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const reader = res.body?.getReader();
    if (!reader) return { alive: true, ttftS: null, latencyMs: Date.now() - t0 };
    let firstByte = -1;
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte < 0) firstByte = Date.now() - t0;
      buf += Buffer.from(value).toString("utf8");
      if (buf.includes('"finish"') || buf.includes("data: [DONE]")) break;
    }
    return { alive: true, ttftS: firstByte > 0 ? firstByte / 1000 : null, latencyMs: Date.now() - t0 };
  } catch {
    return { alive: true, ttftS: null, latencyMs: Date.now() - t0 };
  }
}

function findSessionFile(sessionsRoot: string, cwd: string): string | null {
  let norm = cwd;
  try {
    norm = realpathSync(cwd);
  } catch {
    /* keep */
  }
  let best: { file: string; mtime: number } | null = null;
  const list = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const ws of list(sessionsRoot)) {
    for (const s of list(join(sessionsRoot, ws))) {
      for (const f of list(join(sessionsRoot, ws, s))) {
        if (!/session\.v\d+\.jsonl(\.zstd)?$/.test(f)) continue;
        const file = join(sessionsRoot, ws, s, f);
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        try {
          const buf = new Uint8Array(readFileSync(file));
          let first: string;
          if (f.endsWith(".zstd")) {
            let end = buf.length;
            for (let k = 4; k < buf.length - 3; k++) {
              const m = [0x28, 0xb5, 0x2f, 0xfd];
              if (buf[k] === m[0] && buf[k + 1] === m[1] && buf[k + 2] === m[2] && buf[k + 3] === m[3]) {
                end = k;
                break;
              }
            }
            first = zstdDecodeFrame(buf, 0, end);
          } else {
            first = Buffer.from(buf).toString("utf8");
          }
          const header = JSON.parse(first.split("\n", 1)[0] ?? "{}") as Record<string, unknown>;
          if (header.cwd === norm && (!best || mtime > best.mtime)) best = { file, mtime };
        } catch {
          /* skip */
        }
      }
    }
  }
  return best?.file ?? null;
}

function zstdDecodeFrame(buf: Uint8Array, start: number, end: number): string {
  return zstdDecompressSync(Buffer.from(buf.subarray(start, end))).toString("utf8");
}

/** The concurrent load session: copilot E4 shape, routed DIRECT at :8000. */
function startLoadSession(quiet: (s: string) => void): { child: ChildProcess; stop: () => void; done: Promise<{ code: number | null }> } {
  const work = mkdtempSync(join(os.tmpdir(), "ctxroom-ab-load-"));
  const repo = mkdtempSync(join(os.tmpdir(), "ctxroom-ab-loadrepo-"));
  writeFileSync(join(repo, "logs.txt"), "seed load\n".repeat(500));
  const copilot = execFileSync("which", ["copilot"], { encoding: "utf8" }).trim();
  const child = spawn(copilot, ["-p", "Read logs.txt and say the first word.", "--allow-all-tools"], {
    cwd: repo,
    env: {
      ...process.env,
      COPILOT_API_URL: "",
      COPILOT_PROVIDER_BASE_URL: MODEL_URL + "/v1",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_WIRE_API: "completions",
      COPILOT_MODEL: "incoai/Qwen3.8-27B-Splash",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  quiet(`load session started (copilot pid ${child.pid ?? "?"}, direct :8000)`);
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on("exit", (code) => resolve({ code }));
    child.on("error", () => resolve({ code: null }));
  });
  return { child, stop: () => child.kill("SIGKILL"), done };
}

export async function runArm(opts: RunArmOpts): Promise<Record<string, unknown>> {
  const { arm, index, load = false, timeoutMs = 3_600_000 } = opts;
  const quiet = opts.quiet ?? ((s: string) => console.error(`[arm-${arm}-${index}] ${s}`));
  const runId = `${arm}-${index}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const resultsDir = opts.resultsDir ?? join(REPO_ROOT, "evals", "reports", "dsh-ab");
  const runDir = join(resultsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    runId,
    arm,
    index,
    provider: providerFor[arm],
    proxyCcr: ccrFor[arm],
    load,
    startedAt: new Date().toISOString(),
    dsh: process.env.CTXROOM_LIVE_DSH ?? "dsh",
  };

  // preflight
  const probe = await modelProbe();
  manifest.modelProbe = probe;
  if (!probe.alive) throw new Error("model server unreachable — aborting arm (record, do not patch)");
  const { backup } = setProvider(providerFor[arm]);
  await sleep(1500); // hot-reload settle
  try {
    await ensureProxyMode(arm);

    // seed + overlay
    const repo = mkdtempSync(join(os.tmpdir(), `ctxroom-ab-${arm}-`));
    const seedData = writeSeed(repo);
    const work = mkdtempSync(join(os.tmpdir(), `ctxroom-ab-${arm}-work-`));
    const overlay = join(work, "overlay.yml");
    const parts = [readFileSync(join(import.meta.dirname, "overlays", "common.yml"), "utf8")];
    if (arm !== "C") parts.push(readFileSync(join(import.meta.dirname, "overlays", "mcp-ctxroom.yml"), "utf8"));
    writeFileSync(overlay, parts.join("\n\n"));

    manifest.repoChars = seedData.totalChars;

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let timedOut = false;
    const loadSession = load ? startLoadSession(quiet) : null;

    // monitor the session file for progress + to catch it early on failure
    const sessionsRoot = join(DSH_HOME, "sessions");
    const monitor = setInterval(() => {
      const f = findSessionFile(sessionsRoot, repo);
      if (!f) return;
      try {
        const ev = readSessionEventsSync(f);
        const steps = ev.filter((e) => e.type === "step/end").length;
        const retries = ev.filter((e) => e.type === "llm/retry").length;
        if (steps > 0 || retries > 0) quiet(`progress: ${steps} steps, ${retries} retries`);
      } catch {
        /* file still flushing */
      }
    }, 30_000);

    activeRestore = () => restoreProvider(backup);
    await new Promise<void>((resolve) => {
      const child = spawn(process.env.CTXROOM_LIVE_DSH ?? "dsh", ["--profile", "headless", "--patch", overlay, TASK], {
        cwd: repo,
        env: { ...process.env, DSH_TELEMETRY_DISABLED: "1", CTXROOM_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChild = child;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", () => resolve());
      child.on("exit", (c) => {
        code = c;
        clearTimeout(timer);
        resolve();
      });
    });
    clearInterval(monitor);
    if (loadSession) {
      quiet("arm run finished; draining load session…");
      const drained = new Promise<{ code: null }>((r) => setTimeout(() => r({ code: null }), 600_000));
      const ld = await Promise.race([loadSession.done, drained]);
      manifest.loadExit = ld?.code ?? null;
      loadSession.stop();
    }
    const wallS = (Date.now() - startedAt) / 1000;

    // ---- evidence ----
    const sessionFile = findSessionFile(sessionsRoot, repo);
    let run: RunMetrics | null = null;
    if (sessionFile) {
      try {
        const events = await readSessionEvents(sessionFile);
        run = computeRunMetrics(sessionFile, events);
        cpSync(sessionFile, join(runDir, "session.jsonl" + (sessionFile.endsWith(".zstd") ? ".zstd" : "")));
      } catch (e) {
        manifest.sessionReadError = String(e);
      }
    } else {
      manifest.sessionFileMissing = true;
    }
    const stats = await statsInWindow(join(CTXROOM_HOME, "stats", new Date().toISOString().slice(0, 10) + ".jsonl"), startedAt);
    if (stats.length > 0) writeFileSync(join(runDir, "stats.jsonl"), stats.map((s) => JSON.stringify(s)).join("\n") + "\n");
    writeFileSync(join(runDir, "answer.txt"), stdout);
    writeFileSync(join(runDir, "stderr.txt"), stderr.slice(-8000));
    writeFileSync(join(runDir, "ground-truth.json"), JSON.stringify(seedData.answers, null, 2) + "\n");

    const battery = scoreBattery(stdout, seedData.answers);
    const agg = run ? aggregateLite(run) : null;

    manifest.finishedAt = new Date().toISOString();
    manifest.wallS = Math.round(wallS);
    manifest.exitCode = code;
    manifest.timedOut = timedOut;
    manifest.metrics = agg;
    manifest.battery = { correct: battery.correct, total: battery.total, accuracy: Number(battery.accuracy.toFixed(3)), wrong: battery.q.filter((x) => !x.right).map((x) => x.id + "=" + x.answer) };
    manifest.proxyStats = { rows: stats.length, ccrStored: stats.reduce((a, s) => a + Number(s.ccrStored ?? 0), 0), tokensBefore: stats.reduce((a, s) => a + Number(s.tokensBefore ?? 0), 0), tokensAfter: stats.reduce((a, s) => a + Number(s.tokensAfter ?? 0), 0), tokensSaved: stats.reduce((a, s) => a + Number(s.tokensSaved ?? 0), 0) };
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    rmSync(work, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    return manifest;
  } finally {
    activeChild = null;
    activeRestore = null;
    restoreProvider(backup);
    await sleep(1000);
  }
}

function readSessionEventsSync(file: string): Record<string, unknown>[] {
  const raw = readFileSync(file);
  let text: string;
  if (file.endsWith(".zstd")) {
    const buf = new Uint8Array(raw);
    let end = buf.length;
    const m = [0x28, 0xb5, 0x2f, 0xfd];
    for (let k = 4; k < buf.length - 3; k++) {
      if (buf[k] === m[0] && buf[k + 1] === m[1] && buf[k + 2] === m[2] && buf[k + 3] === m[3]) {
        end = k;
        break;
      }
    }
    text = zstdDecodeFrame(buf, 0, end);
  } else {
    text = raw.toString("utf8");
  }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function aggregateLite(run: RunMetrics): Record<string, number | string | null> {
  const steps = run.steps;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const ttfts = steps.filter((s) => s.ttftS !== null).map((s) => s.ttftS!);
  return {
    steps: steps.length,
    totalWallS: Math.round(run.totalWallS),
    meanStepWallS: Number(mean(steps.map((s) => s.wallS)).toFixed(1)),
    meanTTFTs: Number(mean(ttfts).toFixed(1)),
    maxPromptTokens: Math.round(Math.max(0, ...steps.map((s) => s.promptTokens))),
    meanCacheHit: Number(mean(steps.map((s) => s.cacheHit)).toFixed(3)),
    retries: run.retries,
    timeouts: run.timeouts,
    turnEndReason: run.turnEndReason,
  };
}

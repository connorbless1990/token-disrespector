/**
 * E4 — live end-to-end: real copilot CLI + real local model + ctxroom proxy
 * + CCR. The one eval that touches the whole stack in production shape:
 *   seeded repo ─▶ copilot (BYOK lane) ─▶ ctxroom proxy ─▶ local model
 *                  └ tool results (big log) compressed + CCR-stored
 *
 * Gated: runs only with --live / CTXROOM_LIVE_EVAL=1. Knobs:
 *   CTXROOM_LIVE_MODEL_URL  default http://localhost:8000
 *   CTXROOM_LIVE_MODEL      default incoai/Qwen3.8-27B-Splash
 *   CTXROOM_LIVE_COPILOT    default ~/.local/bin/copilot
 *   CTXROOM_LIVE_TIMEOUT_MS default 900000 (a local reasoning model can
 *   spend most of the budget thinking; the CCR evidence is what counts)
 *
 * Never a silent failure: every precondition is checked and reported.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
const tmpdir = os.tmpdir;
import { CcrStore } from "@ctxroom/core";
import { startProxy } from "@ctxroom/proxy";

export interface E4Result {
  pass: boolean;
  text: string;
  /** structured bits for the machine-readable report */
  detail: Record<string, unknown>;
}

/** A seeded build log: a distinctive error burst FIRST (survives any partial
 * read) followed by a 150-line template/INFO flood (~18 KB ≈ 4.5k tokens —
 * comfortably above every compression threshold, and small enough for a
 * local 27B reasoning model to actually finish inside the run budget). */
function seedRepo(dir: string): { logPath: string; logContent: string } {
  const lines: string[] = [];
  // The distinctive burst the summary should be able to reference — at the
  // top of the file so every plausible Read of it contains it.
  for (let i = 0; i < 40; i++) {
    lines.push(`2026-09-21T10:59:${String(i % 60).padStart(2, "0")}Z ERROR [billing] VORTEX-7001 charge declined for item ${5000 + i}`);
  }
  for (let i = 0; i < 150; i++) {
    lines.push(
      `2026-09-21T10:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z INFO  [worker] processing item ${1000 + i} in 12ms`
    );
    if (i % 37 === 0) lines.push(`2026-09-21T10:${String(i % 60).padStart(2, "0")}:${String((i * 3) % 60).padStart(2, "0")}Z WARN  [retry] backing off for item ${1000 + i} after 3 attempts`);
    if (i % 83 === 0) lines.push(`2026-09-21T10:${String(i % 60).padStart(2, "0")}:${String((i * 11) % 60).padStart(2, "0")}Z ERROR [worker] ${pick(i)} for item ${1000 + i}`);
  }
  const logContent = lines.join("\n");
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "logs", "build.log"), logContent);
  writeFileSync(join(dir, "src", "main.ts"), "export const app = { name: 'seeded-repo', version: '1.0.0' };\nconsole.log('ok');\n");
  return { logPath: join(dir, "logs", "build.log"), logContent };
}
const pick = (i: number) => ["timeout while calling upstream", "failed to flush buffer", "connection refused on 127.0.0.1:5432", "OOM in worker pool"][i % 4]!;

async function runCopilot(copilot: string, cwd: string, env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const p = spawn(copilot, ["-p", "Read logs/build.log and tell me, briefly, what went wrong.", "--allow-all-tools", "--output-format", "json"], {
      cwd,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    p.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    p.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        p.kill("SIGKILL");
        resolve({ code: -1, stdout, stderr: stderr + "\n[e4: copilot timed out — killed]" });
      }
    }, Number(process.env.CTXROOM_LIVE_TIMEOUT_MS ?? 900_000));
    p.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr + `\n[e4: spawn error: ${String(e)}]` });
      }
    });
    p.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

export async function runE4(): Promise<E4Result> {
  const modelUrl = (process.env.CTXROOM_LIVE_MODEL_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const model = process.env.CTXROOM_LIVE_MODEL ?? "incoai/Qwen3.8-27B-Splash";
  const copilot = process.env.CTXROOM_LIVE_COPILOT ?? join(os.homedir(), ".local", "bin", "copilot");

  if (!existsSync(copilot)) {
    return { pass: false, text: `E4: copilot not found at ${copilot}`, detail: { reason: "copilot-missing" } };
  }
  // Precondition: the model must be reachable.
  try {
    const r = await fetch(`${modelUrl}/v1/models`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    return { pass: false, text: `E4: model unreachable at ${modelUrl} (${String(e)})`, detail: { reason: "model-unreachable" } };
  }

  const home = mkdtempSync(join(tmpdir(), "ctxroom-e4-home-"));
  const repo = mkdtempSync(join(tmpdir(), "ctxroom-e4-repo-"));
  const { logContent } = seedRepo(repo);
  try {
    const ccrDir = join(home, "cache");
    await mkdir(ccrDir, { recursive: true });
    const statsDir = join(home, "stats");
    await mkdir(statsDir, { recursive: true });

    // upstreamBase is the endpoint ROOT: the proxy appends the client's full
    // path (/v1/chat/completions) to it. A /v1 suffix here would double up.
    // CTXROOM_HOME pins the stats JSONL into the temp home (the StatsWriter
    // otherwise falls back to the real ~/.ctxroom of the running process).
    const proxy = await startProxy({
      port: 0,
      env: { ...process.env, CTXROOM_HOME: home },
      upstreamBase: modelUrl,
      config: { ccr: { enabled: true, dir: ccrDir } },
    });

    const result = await runCopilot(copilot, repo, {
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${proxy.port}/v1`,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_WIRE_API: "completions",
      COPILOT_MODEL: model,
      CTXROOM_HOME: home,
      COPILOT_API_URL: "", // make sure the native lane is not active
    });
    await proxy.close();

    // ---- assertions -------------------------------------------------------
    const failures: string[] = [];
    if (result.code !== 0) {
      // copilot emits its error JSON events on stdout; surface the tail.
      const tail = result.stdout.slice(-400).replace(/\n/g, " ⏎ ");
      failures.push(`copilot exit ${result.code}${result.stderr ? ` · stderr: ${result.stderr.slice(0, 150)}` : ""} · stdout tail: ${tail}`);
    }

    // Stats: a compression actually happened on the chat-completions route.
    const statsFiles = await readdir(statsDir).catch(() => [] as string[]);
    let ccrStored = 0;
    let tokensSaved = 0;
    for (const f of statsFiles) {
      const lines = (await readFile(join(statsDir, f), "utf8").catch(() => "")).split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          const row = JSON.parse(l) as Record<string, unknown>;
          ccrStored += Number(row.ccrStored ?? 0);
          tokensSaved += Number(row.tokensSaved ?? 0);
        } catch {
          /* skip */
        }
      }
    }
    // Compression happened = the CCR holds a stored original. (The stats
    // row is written when a request COMPLETES; a session killed mid-stream
    // still leaves the CCR entry, which is the stronger evidence.)
    const store = new CcrStore({ dir: ccrDir });
    const ccrStats = await store.stats();
    if (ccrStats.entries < 1) failures.push(`no original stored (ccr entries 0, stats ccrStored ${ccrStored}) — the live log read was never compressed`);
    else if (ccrStored < 1) {
      // not a failure on its own: the request was compressed (CCR proof) but
      // never completed, so the stats row never landed
    }
    const entries = await listEntries(ccrDir);
    let sawVortex = false;
    for (const h of entries.slice(0, 8)) {
      let full = "";
      for (let off = 0; ; off += 20_000) {
        const got = await store.retrieve(h, { offset: off, maxChars: 20_000 });
        if (!got) {
          failures.push(`retrieve(${h}) returned null`);
          break;
        }
        full += got.text;
        if (!got.truncated) break;
        if (off > 50_000_000) {
          failures.push(`retrieve(${h}) did not terminate`);
          break;
        }
      }
      // I9 live: a retrieved original must be a genuine, complete original —
      // prove it contains the seeded burst byte-for-byte.
      if (full.includes("VORTEX-7001 charge declined for item 5001")) sawVortex = true;
    }
    if (ccrStats.entries > 0 && !sawVortex) {
      failures.push("no stored original contains the seeded VORTEX-7001 burst — retrieve round-trip unverified");
    }

    const answer = extractAnswer(result.stdout);
    if (result.code === 0 && answer.trim().length < 40) failures.push(`answer too short (${answer.trim().length} chars) — suspicious`);

    const pass = failures.length === 0;
    return {
      pass,
      text: `E4 live: ${pass ? "PASS" : "FAIL"} · copilot exit ${result.code} · ccrStored ${ccrStored} · tokensSaved ${tokensSaved} · ccr entries ${ccrStats.entries} · answer ${answer.trim().length} chars${failures.length ? `\n   ${failures.join("\n   ")}` : ""}`,
      detail: {
        copilotExit: result.code,
        ccrStored,
        tokensSaved,
        ccrEntries: ccrStats.entries,
        ccrBytes: ccrStats.bytes,
        answerChars: answer.trim().length,
        failures,
      },
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Walk the sharded cache dir; return the 12-hex prefixes. */
async function listEntries(ccrDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(ccrDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
    if (!shard.isDirectory()) continue;
    for (const n of await readdir(join(ccrDir, shard.name)).catch(() => [] as string[])) {
      if (/^[0-9a-f]{64}$/.test(n)) out.push(n.slice(0, 12));
    }
  }
  return out;
}

/** The final result text out of copilot's JSON output (lenient). */
function extractAnswer(stdout: string): string {
  const t = stdout.trim();
  const last = t.lastIndexOf("{");
  if (last !== -1) {
    try {
      const j = JSON.parse(t.slice(last)) as Record<string, any>;
      if (typeof j.result === "string") return j.result;
    } catch {
      /* fall through */
    }
  }
  return t;
}

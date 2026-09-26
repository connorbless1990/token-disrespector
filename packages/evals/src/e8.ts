/**
 * E8 — live end-to-end through the DeepSeek Harness (DSH):
 *
 *   seeded repo ─▶ dsh --profile headless ─▶ ctxroom proxy ─▶ local model
 *                   └ mcp-client (serverName ctxroom) exposes ctxroom_retrieve
 *
 * Same production shape as E4 (copilot) with DSH as the client. Proves, in one
 * real session: (a) a stats row with ccrStored ≥ 1 and tokensSaved > 0;
 * (b) ≥ 1 CCR entry under the ctxroom home; (c) the model calling
 * ctxroom_retrieve and receiving byte-exact windows of the compressed original;
 * (d) a final answer referencing the seeded VORTEX-7001 burst.
 *
 * Gated: runs only with --live / CTXROOM_LIVE_EVAL=1. Knobs (all CTXROOM_LIVE_*):
 *   CTXROOM_LIVE_MODEL_URL   default http://localhost:8000   (endpoint root, NO /v1)
 *   CTXROOM_LIVE_PROXY       default http://127.0.0.1:8788
 *   CTXROOM_LIVE_DSH         default: `dsh` resolved on PATH
 *   CTXROOM_LIVE_TIMEOUT_MS  default 1800000 (1800000 — a shared/remote 27B
 *      can take 100+ s per step under load; 900 s measured too tight)
 *   CTXROOM_HOME             default ~/.ctxroom (the stats/CCR home under test)
 *
 * Never a silent failure: every precondition is checked and reported.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import os from "node:os";
import { join } from "node:path";
import { CcrStore } from "@ctxroom/core";
import { seedRepo } from "./e4.ts";

export interface E8Result {
  pass: boolean;
  text: string;
  detail: Record<string, unknown>;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** True when buf[pos..pos+3] is the zstd frame magic. */
function atFrame(buf: Uint8Array, pos: number): boolean {
  if (pos + 3 > buf.length) return false;
  return buf[pos] === ZSTD_MAGIC[0] && buf[pos + 1] === ZSTD_MAGIC[1] && buf[pos + 2] === ZSTD_MAGIC[2] && buf[pos + 3] === ZSTD_MAGIC[3];
}

/** Decode a session artifact: multi-frame zstd or plain JSONL → header + events. */
async function readSessionEvents(file: string): Promise<{ header: Record<string, unknown>; events: Record<string, unknown>[] }> {
  const buf = new Uint8Array(await readFile(file));
  let text: string;
  if (file.endsWith(".zstd")) {
    let out = "";
    let i = 0;
    while (i < buf.length - 3) {
      if (atFrame(buf, i)) {
        let next = buf.length;
        for (let k = i + 4; k < buf.length - 3; k++) {
          if (atFrame(buf, k)) {
            next = k;
            break;
          }
        }
        out += zstdDecompressSync(Buffer.from(buf.subarray(i, next))).toString("utf8");
        i = next;
      } else {
        i++;
      }
    }
    text = out;
  } else {
    text = Buffer.from(buf).toString("utf8");
  }
  const lines = text.split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { header, events };
}

/** Newest session file whose header cwd matches — the run's own session. */
function findSessionFile(sessionsRoot: string, cwd: string): string | null {
  let best: { file: string; mtime: number } | null = null;
  const list = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const ws of list(sessionsRoot)) {
    const wsDir = join(sessionsRoot, ws);
    for (const s of list(wsDir)) {
      for (const f of list(join(wsDir, s))) {
        if (!/session\.v\d+\.jsonl(\.zstd)?$/.test(f)) continue;
        const file = join(wsDir, s, f);
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
              if (atFrame(buf, k)) {
                end = k;
                break;
              }
            }
            first = zstdDecompressSync(Buffer.from(buf.subarray(0, end))).toString("utf8");
          } else {
            first = Buffer.from(buf).toString("utf8");
          }
          const header = JSON.parse(first.split("\n", 1)[0] ?? "{}") as Record<string, unknown>;
          // DSH normalizes cwd to its real path (/var → /private/var on macOS).
          let norm = cwd;
          try {
            norm = realpathSync(cwd);
          } catch {
            /* keep as-is */
          }
          if (header.cwd === norm && (!best || mtime > best.mtime)) best = { file, mtime };
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return best?.file ?? null;
}

/**
 * Flatten a tool/result event's text. A DSH tool result is stored as
 * data.message (a user-role message) whose content is a tool-result block
 * wrapping inner {type:"text"} parts; tolerate the bare shapes too.
 */
function resultText(e: Record<string, unknown>): string {
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return "";
  const message = data.message as Record<string, unknown> | undefined;
  const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : Array.isArray(data.content) ? (data.content as unknown[]) : [];
  return blocks
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object") {
        const o = b as { text?: unknown; content?: unknown };
        if (typeof o.text === "string") return o.text;
        if (Array.isArray(o.content)) {
          return o.content
            .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
            .join("");
        }
      }
      return "";
    })
    .join("");
}

export async function runE8(): Promise<E8Result> {
  const modelUrl = (process.env.CTXROOM_LIVE_MODEL_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const proxyUrl = (process.env.CTXROOM_LIVE_PROXY ?? "http://127.0.0.1:8788").replace(/\/$/, "");
  const home = process.env.CTXROOM_HOME ?? join(os.homedir(), ".ctxroom");
  const dshBin = process.env.CTXROOM_LIVE_DSH ?? "dsh";

  const pre: string[] = [];
  try {
    execFileSync("which", [dshBin], { stdio: "ignore" });
  } catch {
    pre.push(`dsh not found on PATH ("${dshBin}")`);
  }
  try {
    const r = await fetch(`${modelUrl}/v1/models`);
    if (!r.ok) pre.push(`model unreachable at ${modelUrl} (${r.status})`);
  } catch (e) {
    pre.push(`model unreachable at ${modelUrl} (${String(e)})`);
  }
  try {
    const r = await fetch(`${proxyUrl}/health`);
    const j = (await r.json()) as { ok?: boolean; ccr?: boolean };
    if (!j.ok) pre.push(`proxy unhealthy at ${proxyUrl}`);
    else if (!j.ccr) pre.push("proxy CCR is off — compression would not store originals");
  } catch (e) {
    pre.push(`tds proxy not reachable at ${proxyUrl} (${String(e)})`);
  }
  if (pre.length > 0) {
    return { pass: false, text: `E8 preconditions failed:\n  - ${pre.join("\n  - ")}`, detail: { reason: "preconditions" } };
  }

  const work = mkdtempSync(join(os.tmpdir(), "ctxroom-e8-"));
  const repo = mkdtempSync(join(os.tmpdir(), "ctxroom-e8-repo-"));
  seedRepo(repo);

  // The mcp-client overlay: how DSH reaches the ctxroom MCP server.
  // The tds MCP entry is resolved relative to this package (fixed repo layout).
  const mcpEntry = join(import.meta.dirname, "..", "..", "mcp", "src", "index.ts");
  const overlay = join(work, "tds-overlay.yml");
  writeFileSync(
    overlay,
    [
      "- insert:",
      "    - id: mcp-ctxroom",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: ctxroom",
      "        transport: stdio",
      "        command: node",
      `        args: ["${mcpEntry}"]`,
      "        env:",
      `          CTXROOM_HOME: ${home}`,
      "",
    ].join("\n"),
  );

  const task = [
    "Read the file logs/build.log with the read tool, then answer briefly:",
    "1. What distinct error burst appears at the TOP of the log? Name the exact error code.",
    "2. What is the exact text of the LAST line of the file?",
    "3. How many lines of the file are INFO lines?",
    "If any part of a file or tool output appears as a [ctxroom:compressed <handle>] marker,",
    "call the ctxroom_retrieve tool with that 12-hex handle to fetch the exact original",
    "before answering questions about content you have not seen verbatim.",
  ].join("\n");

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const child: ChildProcess = spawn(dshBin, ["--profile", "headless", "--patch", overlay, task], {
      cwd: repo,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: "1", CTXROOM_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number(process.env.CTXROOM_LIVE_TIMEOUT_MS ?? 1_800_000));
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", () => resolve());
    child.on("exit", (c) => {
      code = c;
      clearTimeout(timer);
      resolve();
    });
  });

  // ---- collect evidence ----------------------------------------------------
  const failures: string[] = [];
  const sessionsRoot = join(process.env.DSH_HOME ?? join(os.homedir(), ".dsh"), "sessions");
  const sessionFile = findSessionFile(sessionsRoot, repo);
  if (!sessionFile) failures.push(`no DSH session file found for cwd ${repo}`);

  if (sessionFile) {
    let events: Record<string, unknown>[] | null = null;
    try {
      events = (await readSessionEvents(sessionFile)).events;
    } catch (e) {
      failures.push(`session file unreadable: ${String(e)}`);
    }
    if (events) {
      const isRetrieve = (e: Record<string, unknown>) =>
        e.type === "tool/call" || e.type === "tool/result"
          ? JSON.stringify(e.data ?? {}).includes("ctxroom_retrieve")
          : false;
      const retrieveCalls = events.filter((e) => e.type === "tool/call" && isRetrieve(e)).length;
      const retrieveResults = events.filter((e) => e.type === "tool/result" && isRetrieve(e));
      const originals = events
        .filter((e) => e.type === "tool/result")
        .map(resultText)
        .filter((t) => t.length > 0);
      if (retrieveCalls === 0 && retrieveResults.length === 0) {
        failures.push(`model never called ctxroom_retrieve (${events.length} events in session)`);
      }
      // I9 byte-exact: every retrieved window must be an exact substring of a
      // compressed original (the session-logged read result the engine stored).
      let checked = 0;
      for (const r of retrieveResults) {
        const t = resultText(r);
        if (t.length === 0) continue;
        checked++;
        if (!originals.some((o) => o.includes(t))) {
          failures.push(`ctxroom_retrieve result is NOT byte-exact vs the stored original (first 160 chars: ${t.slice(0, 160).replace(/\n/g, "⏎")})`);
          break;
        }
      }
      if (retrieveResults.length > 0 && checked === 0) failures.push("ctxroom_retrieve results carried no text");
    }
  } else {
    failures.push("cannot verify retrieve round-trip without the session file");
  }

  let statsRows = 0;
  let ccrStored = 0;
  let tokensSaved = 0;
  let tokensBefore = 0;
  const day = new Date().toISOString().slice(0, 10);
  const statsFile = join(home, "stats", `${day}.jsonl`);
  for (const l of (await readFile(statsFile, "utf8").catch(() => "")).split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(l) as Record<string, unknown>;
      if (typeof row.ts !== "string" || Date.parse(row.ts) < startedAt) continue;
      statsRows++;
      ccrStored += Number(row.ccrStored ?? 0);
      tokensSaved += Number(row.tokensSaved ?? 0);
      tokensBefore += Number(row.tokensBefore ?? 0);
    } catch {
      /* skip */
    }
  }
  if (ccrStored < 1) failures.push(`no stats row with ccrStored ≥ 1 this run (rows=${statsRows}, ccrStored=${ccrStored}, tokensSaved=${tokensSaved})`);
  else if (tokensSaved <= 0) failures.push(`stats row has ccrStored ≥ 1 but tokensSaved = 0`);

  const store = new CcrStore({ dir: join(home, "cache") });
  const ccrStats = await store.stats().catch(() => null);
  if (!ccrStats || ccrStats.entries < 1) failures.push(`no CCR entries under ${join(home, "cache")}`);

  if (!/VORTEX-7001/.test(stdout)) failures.push("final answer does not mention the seeded VORTEX-7001 burst");
  if (code !== 0) failures.push(`dsh exited ${code}${timedOut ? " (TIMEOUT — killed)" : ""}${stderr ? ` · stderr tail: ${stderr.slice(-200)}` : ""}`);

  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  const pass = failures.length === 0;
  const answerHead = stdout.replace(/\s+/g, " ").trim().slice(0, 160);
  rmSync(work, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  return {
    pass,
    text: pass
      ? `E8 DSH live end-to-end: PASS in ${dur}s — ccrStored ${ccrStored}, tokensSaved ${tokensSaved} (of ${tokensBefore} prompt tok), CCR entries ${ccrStats?.entries ?? 0}; answer: “${answerHead}…”`
      : `E8 DSH live end-to-end: FAIL in ${dur}s — ${failures.join(" · ")}`,
    detail: {
      reason: pass ? "ok" : failures[0]!,
      durS: Number(dur),
      statsRows,
      ccrStored,
      tokensBefore,
      tokensSaved,
      ccrEntries: ccrStats?.entries ?? 0,
      exitCode: code,
      timedOut,
      answerHead,
    },
  };
}

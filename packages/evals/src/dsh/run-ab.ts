/**
 * DSH A/B — the full experiment, sequenced. NEVER concurrent arms.
 *
 *   node --experimental-strip-types packages/evals/src/dsh/run-ab.ts
 *     [--arms T C T C P]          (default: T C T C)
 *     [--no-load]                 (default: stability probe on every run)
 *     [--timeout-ms 3600000]
 *
 * Before every arm: the quiet-window gate — model alive + probe TTFT.
 * A busy model defers the run (10-min waits, 6 tries) instead of
 * polluting the data; a dead model aborts the whole sequence.
 *
 * Results: evals/reports/dsh-ab/<run-id>/ (gitignored) + a summary here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { runArm, installProcessGuards, type Arm } from "./run-arm.ts";
import { QUESTIONS, DSH_AB_SEED } from "./gen-seed.ts";
import { scoreBattery, agreement } from "./battery.ts";
import { existsSync, readFileSync } from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const RESULTS = join(REPO_ROOT, "evals", "reports", "dsh-ab");

const argv = process.argv.slice(2);
const load = !argv.includes("--no-load");
const armsArg = argv.find((a) => !a.startsWith("--"));
const arms: Arm[] = (armsArg ? armsArg.split(" ") : ["T", "C", "T", "C"]).map((a) => a.toUpperCase() as Arm);
if (arms.some((a) => !["T", "C", "P"].includes(a))) {
  console.error(`bad arm(s) in "${armsArg}" — use T (proxy+CCR), C (direct), P (proxy, CCR off)`);
  process.exit(2);
}
const timeoutFlag = argv.find((a) => a.startsWith("--timeout-ms"));
let timeoutMs: number;
if (timeoutFlag) {
  const inline = timeoutFlag.includes("=") ? timeoutFlag.split("=")[1] : argv[argv.indexOf(timeoutFlag) + 1];
  timeoutMs = Number(inline);
} else {
  timeoutMs = Number(process.env.CTXROOM_LIVE_TIMEOUT_MS ?? 3_600_000);
}
if (!Number.isFinite(timeoutMs)) {
  console.error("--timeout-ms expects a number (ms)");
  process.exit(2);
}

const quiet = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

/** Quiet-window gate: defers on a busy model, aborts on a dead one. */
async function quietWindowGate(label: string): Promise<boolean> {
  for (let i = 0; i < 7; i++) {
    // one tiny streamed request; TTFT is the shared-load signal
    const t0 = Date.now();
    let ttftS: number | null = null;
    let alive = false;
    try {
      const res = await fetch(`${(process.env.CTXROOM_LIVE_MODEL_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "incoai/Qwen3.8-27B-Splash", stream: true, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      alive = true;
      const reader = res.body?.getReader();
      if (reader) {
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ttftS === null) ttftS = (Date.now() - t0) / 1000;
          buf += Buffer.from(value).toString("utf8");
          if (buf.includes('"finish"') || buf.includes("data: [DONE]")) break;
        }
      }
    } catch {
      /* dead or refused */
    }
    if (!alive) {
      quiet(`${label}: model UNREACHABLE — aborting sequence (record in report, do not patch)`);
      return false;
    }
    if (ttftS !== null && ttftS < 30) {
      quiet(`${label}: quiet window OK (probe TTFT ${ttftS.toFixed(1)}s)`);
      return true;
    }
    quiet(`${label}: model busy (probe TTFT ${ttftS?.toFixed(1) ?? "?"}s) — waiting 10 min, try ${i + 2}/7`);
    await sleep(10 * 60_000);
  }
  quiet(`${label}: no quiet window in 60 min — skipping this arm (recorded)`);
  return false;
}

async function main() {
  installProcessGuards();
  mkdirSync(RESULTS, { recursive: true });
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    seed: DSH_AB_SEED,
    questions: Object.keys(QUESTIONS).length,
  };
  const armsOut: Record<string, unknown>[] = [];
  summary.arms = armsOut;

  const manifests: Record<string, unknown>[] = [];
  for (const arm of arms) {
    const index = manifests.filter((m) => m.arm === arm).length + 1;
    const ok = await quietWindowGate(`arm ${arm} run ${index}`);
    if (!ok) {
      armsOut.push({ arm, index, skipped: "no-quiet-window" });
      continue;
    }
    const m = await runArm({ arm, index, load, timeoutMs, quiet });
    manifests.push(m);
    armsOut.push({
      arm,
      index,
      wallS: m.wallS,
      exitCode: m.exitCode,
      timedOut: m.timedOut,
      metrics: m.metrics,
      battery: m.battery,
      proxyStats: m.proxyStats,
      loadExit: m.loadExit ?? null,
      modelProbe: m.modelProbe,
      runId: m.runId,
    });
    quiet(`arm ${arm} run ${index} done: ${m.wallS}s, exit ${m.exitCode}, battery ${(m.battery as { correct: number; total: number }).correct}/15`);
  }

  // ---- cross-arm agreement + aggregate table (the report's spine) ----------
  const byArm: Record<Arm, Record<string, unknown>[]> = { T: [], C: [], P: [] };
  for (const m of manifests) byArm[m.arm as Arm].push(m);

  summary.perArm = (["T", "C", "P"] as Arm[])
    .map((a) => {
      const ms = byArm[a];
      if (ms.length === 0) return null;
      const accs = ms.map((m) => (m.battery as { accuracy: number }).accuracy);
      const num = (m: Record<string, unknown>, k: string): number | null => {
        const v = (m.metrics as Record<string, unknown> | undefined)?.[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const meanOf = (f: (m: Record<string, unknown>) => number | null): number | null => {
        const xs = ms.map(f).filter((x): x is number => x !== null);
        return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null;
      };
      return {
        arm: a,
        runs: ms.length,
        meanWallS: Math.round(ms.reduce((x, m) => x + Number(m.wallS ?? 0), 0) / ms.length),
        meanBatteryAccuracy: Number((accs.reduce((x, y) => x + y, 0) / accs.length).toFixed(3)),
        meanSteps: meanOf((m) => num(m, "steps")),
        meanStepWallS: meanOf((m) => num(m, "meanStepWallS")),
        meanTTFTs: meanOf((m) => num(m, "meanTTFTs")),
        meanMaxPromptTokens: meanOf((m) => num(m, "maxPromptTokens")),
        meanCacheHit: meanOf((m) => num(m, "meanCacheHit")),
        totalRetries: ms.reduce((x, m) => x + Number(num(m, "retries") ?? 0), 0),
      };
    })
    .filter(Boolean);

  // T-vs-C per-question agreement (each run pair; the ≥95% gate)
  const tRuns = byArm.T.map((m) => (m.runId as string));
  const cRuns = byArm.C.map((m) => (m.runId as string));
  const tAcc = byArm.T.map((m) => (m.battery as { accuracy: number }).accuracy);
  const cAcc = byArm.C.map((m) => (m.battery as { accuracy: number }).accuracy);
  // per-question T-vs-C agreement, every T run against every C run
  const loadRun = (runId: string) => {
    const dir = join(RESULTS, runId);
    if (!existsSync(join(dir, "answer.txt"))) return null;
    const truth = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8")) as Record<string, string>;
    return scoreBattery(readFileSync(join(dir, "answer.txt"), "utf8"), truth);
  };
  const pairs: { t: string; c: string; agree: number; total: number; disagreements: { id: string; a: string; b: string; truth: string }[] }[] = [];
  for (const mT of byArm.T) for (const mC of byArm.C) {
    const a = loadRun(mT.runId as string);
    const b = loadRun(mC.runId as string);
    if (!a || !b) continue;
    const ag = agreement(a, b);
    pairs.push({ t: mT.runId as string, c: mC.runId as string, agree: ag.agree, total: ag.total, disagreements: ag.disagreements });
  }
  summary.qualityGate = {
    tMeanAccuracy: tAcc.length ? Number((tAcc.reduce((a, b) => a + b, 0) / tAcc.length).toFixed(3)) : null,
    cMeanAccuracy: cAcc.length ? Number((cAcc.reduce((a, b) => a + b, 0) / cAcc.length).toFixed(3)) : null,
    agreement: pairs.length
      ? Number((pairs.reduce((x, p) => x + p.agree / p.total, 0) / pairs.length).toFixed(3))
      : null,
    targetAgreement: 0.95,
    pairs,
    note: "any disagreement is a setup failure per the brief — fix retention or narrow scope, never fudge the scorer",
  };

  summary.finishedAt = new Date().toISOString();
  const out = join(RESULTS, "summary.json");
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  quiet(`summary written: ${out}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`run-ab fatal: ${String(e)}`);
  process.exit(1);
});

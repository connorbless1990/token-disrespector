/**
 * DSH A/B harness — hermetic plumbing tests (no model, no network).
 *
 * The A/B is expensive (shared model, hours), so its machinery must be
 * proven cheap and offline: the provider flip, the seed determinism,
 * the battery scorer, the metric math, and the task/question contract.
 * Live runs are gated separately (CTXROOM_LIVE_EVAL) like E4/E8.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { flipProviderLine } from "../src/dsh/run-arm.ts";
import { generateSeedData, DSH_AB_SEED, TASK, QUESTIONS, writeSeed } from "../src/dsh/gen-seed.ts";
import { scoreBattery, agreement } from "../src/dsh/battery.ts";
import { computeRunMetrics } from "../src/dsh/measure.ts";

// ---------------------------------------------------------------------------
// provider flip
// ---------------------------------------------------------------------------

const SETTINGS_SAMPLE = [
  "ui-onboarding:",
  "  welcomeNoticeVersion: 2026-08-13.1",
  "llm-pi-ai:",
  "  providers:",
  "    incoai:",
  "      provider: not-a-real-key", // decoy: a `provider:` OUTSIDE the section must not move
  "      baseURL: http://127.0.0.1:8000/v1",
  "    incoai-tds:",
  "      baseURL: http://127.0.0.1:8788/v1",
  "agent-default-model:",
  "  provider: incoai",
  "  model: incoai/Qwen3.8-27B-Splash",
  "",
].join("\n");

test("flipProviderLine: rewrites only the agent-default-model section", () => {
  const out = flipProviderLine(SETTINGS_SAMPLE, "incoai-tds");
  assert.match(out, /agent-default-model:\n  provider: incoai-tds/);
  assert.match(out, /provider: not-a-real-key/); // decoy untouched
  // idempotent
  assert.equal(flipProviderLine(out, "incoai-tds"), out);
  // round trip
  assert.match(flipProviderLine(out, "incoai"), /agent-default-model:\n  provider: incoai/);
});

// ---------------------------------------------------------------------------
// seed: deterministic, sized to the 50k+ target
// ---------------------------------------------------------------------------

test("seed is deterministic: same seed → byte-identical files and answers", () => {
  const a = generateSeedData(DSH_AB_SEED);
  const b = generateSeedData(DSH_AB_SEED);
  assert.deepEqual(a.files, b.files);
  assert.deepEqual(a.answers, b.answers);
});

test("seed size: a full read lands at the 50k+ token target", () => {
  const a = generateSeedData(DSH_AB_SEED);
  // ~3.8 chars/token for this shape mix
  const tokens = a.totalChars / 3.8;
  assert.ok(tokens > 45_000, `expected ≥50k-token workload, got ≈${Math.round(tokens)}`);
  assert.ok(tokens < 150_000, `workload too heavy for one run: ≈${Math.round(tokens)}`);
  assert.ok(Object.keys(a.files).length >= 10, "expected the full tool mix");
});

test("writeSeed: ground-truth.json is emitted with the repo", () => {
  const dir = join(import.meta.dirname, "..", "..", "..", "evals", "reports", "dsh-ab", ".selftest");
  writeSeed(dir, DSH_AB_SEED);
  try {
    const truth = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8")) as Record<string, string>;
    assert.equal(Object.keys(truth).length, 15);
    assert.ok(existsSync(join(dir, "ground-truth.json")));
    assert.ok(existsSync(join(dir, "logs", "build.log")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// task / question contract
// ---------------------------------------------------------------------------

test("task contains every battery question exactly once", () => {
  for (const id of Object.keys(QUESTIONS)) {
    const re = new RegExp(`^${id}: `, "mg");
    const hits = [...TASK.matchAll(re)];
    assert.equal(hits.length, 1, `question ${id} appears ${hits.length}× in the task`);
  }
});

// ---------------------------------------------------------------------------
// battery scorer
// ---------------------------------------------------------------------------

function perfectAnswer(truth: Record<string, string>): string {
  return Object.entries(truth).map(([k, v]) => `${k}: ${v}`).join("\n");
}

test("battery: perfect answers score 15/15", () => {
  const truth = generateSeedData(DSH_AB_SEED).answers;
  const s = scoreBattery(perfectAnswer(truth), truth);
  assert.equal(s.total, 15);
  assert.equal(s.correct, 15, s.q.filter((x) => !x.right).map((x) => `${x.id}: "${x.answer}" ≠ "${x.truth}"`).join("; "));
});

test("battery: one perturbed answer is detected; Q12 is order-insensitive", () => {
  const truth = generateSeedData(DSH_AB_SEED).answers;
  let a = perfectAnswer(truth);
  // perturb the INFO count (Q4)
  a = a.replace(/^Q4: .*$/m, `Q4: ${Number(truth.Q4!) + 1}`);
  // Q12 reversed order must still be right
  const [f, s2] = truth.Q12!.split(",");
  a = a.replace(/^Q12: .*$/m, `Q12: ${s2},${f}`);
  const sc = scoreBattery(a, truth);
  assert.equal(sc.correct, 14);
  assert.ok(sc.q.find((x) => x.id === "Q4")!.right === false);
  assert.ok(sc.q.find((x) => x.id === "Q12")!.right === true);
});

test("agreement: identical answers agree 100%; one difference breaks exactly that question", () => {
  const truth = generateSeedData(DSH_AB_SEED).answers;
  const a = scoreBattery(perfectAnswer(truth), truth);
  let text = perfectAnswer(truth);
  text = text.replace(/^Q5: .*$/m, `Q5: ${Number(truth.Q5!) + 2}`);
  const b = scoreBattery(text, truth);
  const ag = agreement(a, b);
  assert.equal(ag.total, 15);
  assert.equal(ag.agree, 14);
  assert.deepEqual(ag.disagreements.map((d) => d.id), ["Q5"]);
});

// ---------------------------------------------------------------------------
// measure: metric math over a synthetic session
// ---------------------------------------------------------------------------

test("measure: computes wall, TTFT, prompt tokens and cache-hit from events", () => {
  const t0 = 1_000_000;
  const events = [
    { type: "session", version: 3, id: "s", cwd: "/x" },
    { type: "turn/start", seq: 1, time: t0, data: { turn: 1 } },
    { type: "request/header", seq: 2, time: t0 + 5, data: { header: { config: { provider: "incoai" } } } },
    { type: "step/start", seq: 3, time: t0 + 5, data: { turn: 1, step: 1 } },
    {
      type: "assistant/attempt",
      seq: 4,
      time: t0 + 50,
      data: { turn: 1, step: 1, stream: [{ type: "chunk", time: t0 + 50 }] },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: t0 + 2000,
      data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 500, cacheReadTokens: 900 } },
    },
    { type: "step/end", seq: 6, time: t0 + 2100, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 7, time: t0 + 2100, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const m = computeRunMetrics("synthetic", events);
  assert.equal(m.steps.length, 1);
  const s = m.steps[0]!;
  assert.equal(s.wallS, 2.095, "step wall = step/end − step/start");
  assert.ok(s.ttftS !== null && Math.abs(s.ttftS - 0.045) < 1e-9, `TTFT = first chunk − request header (got ${s.ttftS})`);
  assert.equal(s.promptTokens, 1000, "prompt = input + cacheRead");
  assert.equal(s.cacheHit, 0.9);
  assert.equal(m.totalWallS, 2.1, "total = last event − first event (turn span)");
});

// ---------------------------------------------------------------------------
// overlays exist and are shaped for --patch
// ---------------------------------------------------------------------------

test("arm overlays exist with the expected rows", () => {
  const common = readFileSync(join(import.meta.dirname, "..", "src", "dsh", "overlays", "common.yml"), "utf8");
  assert.match(common, /- id: compaction-basic/);
  assert.match(common, /auto: false/);
  assert.match(common, /- id: session-persistence-jsonl/);
  assert.match(common, /compression: 'none'/);
  const mcp = readFileSync(join(import.meta.dirname, "..", "src", "dsh", "overlays", "mcp-ctxroom.yml"), "utf8");
  assert.match(mcp, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(mcp, /serverName: ctxroom/);
  assert.match(mcp, /packages\/mcp\/src\/index\.ts/);
});

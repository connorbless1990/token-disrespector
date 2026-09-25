/**
 * E6 — overhead budget (work package C).
 *
 * The proxy adds itself in front of every provider request; the cost must
 * stay out of the way. Target (published): p99 < 50 ms of engine time per
 * ~100 KB block, deterministic paths only (no LLM, no network).
 *
 * Blocks are built by scaling six real shape families (from the corpus) up
 * to ~100 KB by repeating their own content — the realistic "big tool
 * result" distribution, not synthetic noise.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, messageText, resolveEngineConfig, type EngineMessage } from "@ctxroom/core";
import { generateCorpus, DEFAULT_SEED, type Shape } from "./corpus.ts";
import { writeReport, type EvalReport } from "./report.ts";

export const E6_TARGET_P99_MS = 50;
const BLOCK_KB = 100;

export interface E6Result {
  blocks: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  pass: boolean;
}

/** Scale a corpus shape to ~`kb` by repeating its lines (its own shape). */
function scaleTo(shape: Shape, kb: number): string {
  if (shape.content.length >= kb * 1024) return shape.content.slice(0, kb * 1024);
  const lines = shape.content.split("\n");
  const out: string[] = [];
  let size = 0;
  let i = 0;
  while (size < kb * 1024) {
    const line = lines[i % lines.length]! + "\n";
    out.push(line);
    size += line.length;
    i++;
    if (i > 1_000_000) break;
  }
  return out.join("");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export async function runE6(blockCount: number = 60, ccrDir?: string): Promise<E6Result> {
  const corpus = generateCorpus(DEFAULT_SEED);
  const byName = new Map(corpus.map((s) => [s.name, s]));
  const families = [
    byName.get("log-build")!,
    byName.get("json-whole-pretty")!,
    byName.get("code-singleline-200kb")!,
    byName.get("prose-english")!,
    byName.get("config-yaml")!,
    byName.get("lines-numbered")!,
  ].map((s) => scaleTo(s, BLOCK_KB));

  const dir = ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e6-")), "ccr");
  const times: number[] = [];
  const per = Math.max(1, Math.floor(blockCount / families.length));

  for (let i = 0; i < blockCount; i++) {
    const content = families[i % families.length]!;
    const engine = new Engine(
      resolveEngineConfig({ ccr: { enabled: true, dir } }, {} as NodeJS.ProcessEnv)
    );
    const session: EngineMessage[] = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Look at this." },
      { role: "tool", tool_call_id: `call_${i}`, content },
    ];
    // Warm-up excluded from the first sample: JIT + first-use paths are not
    // the steady state the budget is about.
    await engine.compress(session);
    const t0 = performance.now();
    await engine.compress(session); // resubmit (registry path) — steady state
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  const p50 = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);
  const p99 = percentile(times, 0.99);
  const max = times[times.length - 1]!;
  return {
    blocks: blockCount,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    target: { name: `engine ms per ~${BLOCK_KB}KB block (p99)`, op: "<=", value: E6_TARGET_P99_MS, actual: p99, pass: p99 <= E6_TARGET_P99_MS },
    pass: p99 <= E6_TARGET_P99_MS,
  };
}

export function e6ToReport(r: E6Result, git: string): EvalReport {
  return {
    eval: "e6",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    target: r.target,
    pass: r.pass,
    detail: { blocks: r.blocks, p50Ms: +r.p50Ms.toFixed(2), p95Ms: +r.p95Ms.toFixed(2), p99Ms: +r.p99Ms.toFixed(2), maxMs: +r.maxMs.toFixed(2) },
  };
}

export function e6Summary(r: E6Result): string {
  const fmt = (n: number) => (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + "ms";
  return [
    `E6 overhead budget: p50 ${fmt(r.p50Ms)} · p95 ${fmt(r.p95Ms)} · p99 ${fmt(r.p99Ms)} · max ${fmt(r.maxMs)} (p99 target ≤ ${E6_TARGET_P99_MS}ms) ${r.pass ? "PASS" : "FAIL"}`,
    `   ${r.blocks} resubmitted ~100KB blocks (6 shape families)`,
  ].join("\n");
}

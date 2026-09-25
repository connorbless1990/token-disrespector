/**
 * E7 — drift sentinel (work package C).
 *
 * Five hand-crafted blocks with RECORDED expectations (transform tag +
 * output size band). The sentinels are part of the source: a compressor
 * change that moves behavior without updating the sentinels fails the
 * suite — the drift is visible the day it lands, not when a user's cache
 * starts busting.
 *
 * Recorded expectations must be updated deliberately (a PR that says "I
 * changed the X compressor; here is the new behavior"). Until then:
 *   - the transform tag must not change (lossless vs lossy vs passthrough);
 *   - the output size must stay within ±5% of the recorded value.
 *
 * Target (published): 100% of sentinels stable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, resolveEngineConfig, type EngineMessage } from "@ctxroom/core";
import { writeReport, type EvalReport } from "./report.ts";

export const E7_TARGET_STABLE = 1.0;
const SIZE_TOLERANCE = 0.05; // ±5% on the output size

interface Sentinel {
  id: string;
  content: string;
  /** Recorded transform tag: "template" | "fragment" | "compressed" | "passthrough" | "reformat". */
  tag: string;
  /** Recorded output characters (the recorded send-form length). */
  outChars: number;
}

/** Deterministic builders for the sentinel blocks (committed behavior). */
const t = (n: number, mid: string) =>
  Array.from({ length: n }, (_, i) => `2026-09-21T10:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z ${mid} item ${1000 + i}`).join("\n");

const TEMPLATE_LOG = t(400, "INFO  [vite] transforming packages/core/src/module" + "x".repeat(20) + ".ts chunk ");
const JSON_REPEAT = Array.from({ length: 120 }, (_, i) => JSON.stringify({ id: i, status: i % 5 === 0 ? 503 : 200, path: `/api/items/${i}`, ms: 10 + (i % 7) }, null, 2)).join("\n");
const PROSE = Array.from({ length: 30 }, (_, i) => `The compression layer stores the full original before forwarding a compact preview, so any part of the context can be retrieved byte-exact on demand. Session ${i + 1} of the experiment.`).join("\n\n");
const MINIFIED = "const A=[" + Array.from({ length: 400 }, (_, i) => `${i * 7 % 97}`).join(",") + "];for(let i=0;i<A.length;i++){if(A[i]===0){A[i]=1}}export default A;".repeat(20);
const NUMBERED = Array.from({ length: 150 }, (_, i) => `${String(i + 1).padStart(4)}  const v${i} = ${i * 3};`).join("\n");

/**
 * Recorded expectations (git rev 6b572a3, engine v0.1.0):
 *   template-log    44799 → 626   compressor   (98.6% — log v3 collapse)
 *   json-repeats     8539 → 2344  compressor   (duplicate elements collapsed)
 *   prose            5419 → 493   compressor   (head + signal + tail)
 *   minified         2526 → 2526  passthrough  (uncrushable single line)
 *   numbered-lines   3451 → 1897  reformat     (lossless template reformat)
 * Update these DELIBERATELY when a compressor change moves the behavior —
 * that update is the drift decision, on the record.
 */
export const SENTINELS: Sentinel[] = [
  { id: "template-log", content: TEMPLATE_LOG, tag: "compressor", outChars: 626 },
  { id: "json-repeats", content: JSON_REPEAT, tag: "compressor", outChars: 2344 },
  { id: "prose", content: PROSE, tag: "compressor", outChars: 493 },
  { id: "minified", content: MINIFIED, tag: "passthrough", outChars: 2526 },
  { id: "numbered-lines", content: NUMBERED, tag: "reformat", outChars: 1897 },
];

/**
 * The transform tag the engine applied to the part — taken from the engine's
 * own transform record (authoritative), not guessed from marker text:
 *   passthrough | reformat (lossless) | compressor (lossy) | llm-summarizer
 *   | already-compressed (guard) | ccr-unavailable | no-growth
 */
function tagOf(
  res: { transforms: { transform: string; messageIndex: number; partIndex: number }[] },
  messageIndex: number,
  partIndex: number
): string {
  return res.transforms.find((t) => t.messageIndex === messageIndex && t.partIndex === partIndex)?.transform ?? "passthrough";
}

export interface E7Row {
  id: string;
  inChars: number;
  outChars: number;
  ratio: number;
  tag: string;
  expectedTag: string;
  recordedOutChars: number;
  tagMatches: boolean;
  sizeStable: boolean;
  stable: boolean;
}
export interface E7Result {
  rows: E7Row[];
  stableFraction: number;
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  pass: boolean;
  /** True when the sentinels' recorded expectations are the ones in source. */
  expectationsRecorded: boolean;
}

export async function runE7(ccrDir?: string): Promise<E7Result> {
  const dir = ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e7-")), "ccr");
  // Recorded expectations live in the sentinel table (outChars ≥ 0).
  const recorded = SENTINELS.every((s) => s.outChars >= 0);

  const rows: E7Row[] = [];
  for (const s of SENTINELS) {
    const engine = new Engine(
      resolveEngineConfig({ ccr: { enabled: true, dir } }, {} as NodeJS.ProcessEnv)
    );
    const session: EngineMessage[] = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Inspect." },
      { role: "tool", tool_call_id: `call_${s.id}`, content: s.content },
    ];
    const res = await engine.compress(session);
    const out = res.forwardTexts[2];
    const outText = out === null ? s.content : typeof out === "string" ? out : (out as string[]).join("\n");
    const tag = tagOf(res, 2, 0);
    const tagMatches = tag === s.tag;
    const sizeStable = recorded ? Math.abs(outText.length - s.outChars) / Math.max(1, s.outChars) <= SIZE_TOLERANCE : true;
    rows.push({
      id: s.id,
      inChars: s.content.length,
      outChars: outText.length,
      ratio: 1 - outText.length / s.content.length,
      tag,
      expectedTag: s.tag,
      recordedOutChars: s.outChars,
      tagMatches,
      sizeStable,
      stable: tagMatches && sizeStable,
    });
  }

  const stableFraction = rows.length === 0 ? 1 : rows.filter((r) => r.stable).length / rows.length;
  return {
    rows,
    stableFraction,
    target: { name: "sentinels stable (tag + size band)", op: ">=", value: E7_TARGET_STABLE, actual: stableFraction, pass: stableFraction >= E7_TARGET_STABLE },
    pass: stableFraction >= E7_TARGET_STABLE && recorded,
    expectationsRecorded: recorded,
  };
}

export function e7ToReport(r: E7Result, git: string): EvalReport {
  return {
    eval: "e7",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    target: r.target,
    pass: r.pass,
    detail: {
      expectationsRecorded: r.expectationsRecorded,
      sentinels: r.rows.map((x) => ({ ...x, ratio: +x.ratio.toFixed(4) })),
    },
  };
}

export function e7Summary(r: E7Result): string {
  const lines = [`E7 drift sentinel: ${r.rows.filter((x) => x.stable).length}/${r.rows.length} stable ${r.pass ? "PASS" : "FAIL"}`];
  for (const x of r.rows) {
    const why = !x.tagMatches ? `tag ${x.tag} ≠ recorded ${x.expectedTag}` : `size ${x.outChars} outside ${SIZE_TOLERANCE * 100}% of ${x.recordedOutChars}`;
    lines.push(`   ${x.id.padEnd(16)} ${x.inChars} → ${x.outChars} (${(x.ratio * 100).toFixed(1)}%) tag=${x.tag} ${x.stable ? "" : "← " + why}`);
  }
  if (!r.expectationsRecorded) lines.push("   ⚠ expectations not recorded — run the record step (npm run eval -- e7:record)");
  return lines.join("\n");
}

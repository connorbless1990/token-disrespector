/**
 * E1 — real-shape compression ratio (work package C / E1).
 *
 * Runs the deterministic corpus (corpus.ts) through the engine as one
 * realistic session and measures, over the LIVE ZONE (everything except the
 * system prompt), what fraction of the characters actually reached the model
 * in their original form.
 *
 * Target (published): ≥ 60% of live-zone characters compressed.
 *
 * Honest by construction: shapes the engine refuses to touch (small files,
 * uncrushable code) count against the ratio — that is exactly the question
 * the number answers. The system prompt is excluded (I1: never touched).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  resolveEngineConfig,
  messageText,
  type EngineMessage,
} from "@ctxroom/core";
import { generateCorpus, DEFAULT_SEED, type Shape } from "./corpus.ts";
import { writeReport, pct, type EvalReport } from "./report.ts";

export const E1_TARGET_RATIO = 0.6;

export interface ShapeResult {
  name: string;
  kind: string;
  liveZone: boolean;
  inChars: number;
  outChars: number;
  ratio: number; // 1 - out/in
  compressed: boolean;
}

export interface E1Result {
  target: { name: string; value: number; actual: number; pass: boolean };
  shapes: ShapeResult[];
  inChars: number;
  outChars: number;
  ratio: number;
  i1Holds: boolean; // system prompt byte-identical
  i3Holds: boolean; // no message grew
  pass: boolean;
}

function buildSession(corpus: Shape[]): EngineMessage[] {
  const byName = new Map(corpus.map((s) => [s.name, s]));
  const sys = byName.get("system-prompt")!;
  const msgs: EngineMessage[] = [
    { role: "system", content: sys.content },
    { role: "user", content: "Investigate the API dump, the build log, and the recent changes. What should I fix first?" },
    { role: "assistant", content: "I will read the API dump and the build log first." },
    tool(1, "json-whole-pretty"),
    tool(2, "log-build"),
    tool(3, "json-first-chunk"),
    tool(4, "json-middle-chunk"),
    tool(5, "json-minified-singleline"),
    tool(6, "log-shell-test"),
    tool(7, "search-ripgrep"),
    tool(8, "lines-numbered"),
    { role: "assistant", content: byName.get("prose-english")!.content },
    { role: "user", content: "And the config? And the README?" },
    tool(9, "config-yaml"),
    tool(10, "small-file"),
    tool(11, "code-singleline-200kb"),
    { role: "assistant", content: byName.get("prose-cjk")!.content },
    { role: "user", content: "Summarize: what is broken, and in what order do I fix it?" },
  ];
  function tool(id: number, name: string): EngineMessage {
    return { role: "tool", tool_call_id: `call_${id}`, content: byName.get(name)!.content };
  }
  return msgs;
}

export async function runE1(seed: number = DEFAULT_SEED, ccrDir?: string): Promise<E1Result> {
  const corpus = generateCorpus(seed);
  const session = buildSession(corpus);
  const engine = new Engine(
    resolveEngineConfig(
      { ccr: { enabled: true, dir: ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e1-")), "ccr") } },
      {} as NodeJS.ProcessEnv
    )
  );
  // Snapshot what the client SENT before the engine runs.
  const sent = session.map((m) => messageText(m));
  const res = await engine.compress(session);
  const fwd = res.messages.map((m) => messageText(m));

  // Map messages back to corpus shapes by content identity.
  const shapeByContent = new Map<string, Shape>();
  for (const s of corpus) shapeByContent.set(s.content, s);

  const shapes: ShapeResult[] = [];
  let inChars = 0;
  let outChars = 0;
  let i1Holds = true;
  let i3Holds = true;

  for (let i = 0; i < res.messages.length; i++) {
    const isSystem = res.messages[i].role === "system" || res.messages[i].role === "developer";
    if (isSystem) {
      if (sent[i] !== fwd[i]) i1Holds = false; // I1
      continue; // excluded from the live-zone ratio
    }
    const inT = sent[i]!;
    const outT = fwd[i]!;
    inChars += inT.length;
    outChars += outT.length;
    if (outT.length > inT.length) i3Holds = false;
    const s = shapeByContent.get(inT);
    if (s) {
      shapes.push({
        name: s.name,
        kind: s.kind,
        liveZone: s.liveZone,
        inChars: inT.length,
        outChars: outT.length,
        ratio: 1 - outT.length / inT.length,
        compressed: outT !== inT,
      });
    }
  }

  const ratio = inChars === 0 ? 0 : 1 - outChars / inChars;
  return {
    target: { name: "live-zone chars compressed", value: E1_TARGET_RATIO, actual: ratio, pass: ratio >= E1_TARGET_RATIO },
    shapes,
    inChars,
    outChars,
    ratio,
    i1Holds,
    i3Holds,
    pass: ratio >= E1_TARGET_RATIO && i1Holds && i3Holds,
  };
}

export function e1ToReport(r: E1Result, seed: number, git: string): EvalReport {
  return {
    eval: "e1",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    seed,
    target: { name: r.target.name, op: ">=", value: r.target.value, actual: r.target.actual, pass: r.target.pass },
    pass: r.pass,
    detail: {
      inChars: r.inChars,
      outChars: r.outChars,
      i1Holds: r.i1Holds,
      i3Holds: r.i3Holds,
      shapes: r.shapes.map((s) => ({
        name: s.name,
        kind: s.kind,
        inChars: s.inChars,
        outChars: s.outChars,
        saved: pct(s.ratio),
        compressed: s.compressed,
      })),
    },
  };
}

export function e1Summary(r: E1Result): string {
  const lines: string[] = [];
  lines.push(`E1 live-zone ratio: ${pct(r.ratio)} (target ≥ ${pct(E1_TARGET_RATIO)}) ${r.pass ? "PASS" : "FAIL"}`);
  lines.push(`   in ${r.inChars} chars → out ${r.outChars} chars · I1 ${r.i1Holds ? "ok" : "VIOLATED"} · I3 ${r.i3Holds ? "ok" : "VIOLATED"}`);
  for (const s of [...r.shapes].sort((a, b) => b.inChars - a.inChars)) {
    lines.push(`   ${s.name.padEnd(26)} ${String(s.inChars).padStart(8)} → ${String(s.outChars).padStart(8)}  ${pct(s.ratio).padStart(7)}${s.compressed ? "" : "  (passthrough)"}`);
  }
  return lines.join("\n");
}

/** CLI entry: `npm run eval -- e1` (or `node .../e1.ts`). */
async function main() {
  const git = (await import("node:child_process"))
    .execSync("git rev-parse --short HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
  const r = await runE1();
  writeReport(e1ToReport(r, DEFAULT_SEED, git || "unknown"));
  console.log(e1Summary(r));
  process.exitCode = r.pass ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("e1.ts")) {
  void main();
}

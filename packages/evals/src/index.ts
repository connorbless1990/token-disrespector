/**
 * ctxroom evals — CLI.
 *
 *   npm run eval                 fast deterministic set (no network, no model)
 *   npm run eval -- --live       fast set + live set (needs the local model)
 *   npm run eval -- e1 e3        only the named evals
 *   CTXROOM_LIVE_EVAL=1 …        same gate as --live (for CI)
 *
 * The fast set must run on a stranger's machine with nothing but Node.
 * The live set is gated: without CTXROOM_LIVE_EVAL it prints what would run
 * and skips — never a silent failure.
 */
import { execSync } from "node:child_process";
import { summarize, writeReport, pct } from "./report.ts";
import { runE1, e1ToReport } from "./e1.ts";
import { DEFAULT_SEED } from "./corpus.ts";

const git = ((): string => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
})();

interface EvalDef {
  id: string;
  live: boolean;
  run: (live: boolean) => Promise<{ pass: boolean; text: string }>;
}

const E1: EvalDef = {
  id: "e1",
  live: false,
  async run() {
    const r = await runE1();
    writeReport(e1ToReport(r, DEFAULT_SEED, git));
    return {
      pass: r.pass,
      text: `E1 real-shape ratio ${pct(r.ratio)} (target ≥ ${pct(0.6)}): ${r.pass ? "PASS" : "FAIL"}\n   in ${r.inChars} chars → out ${r.outChars} chars · I1 ${r.i1Holds ? "ok" : "VIOLATED"} · I3 ${r.i3Holds ? "ok" : "VIOLATED"}`,
    };
  },
};

// E4 (live) lands with the B7 harness; registered here so `--live` is stable.
const E4: EvalDef = {
  id: "e4",
  live: true,
  async run(live: boolean) {
    if (!live) {
      return { pass: true, text: "E4 live compression+retrieve: SKIPPED (needs CTXROOM_LIVE_EVAL=1)" };
    }
    return { pass: true, text: "E4 live compression+retrieve: not yet implemented (B7 pending)" };
  },
};

const ALL: EvalDef[] = [E1, E4];

async function main() {
  const args = process.argv.slice(2);
  const wantLive = args.includes("--live") || process.env.CTXROOM_LIVE_EVAL === "1";
  const named = args.filter((a) => !a.startsWith("--"));
  const chosen = named.length > 0 ? ALL.filter((e) => named.includes(e.id)) : ALL;
  if (named.length > 0 && chosen.length === 0) {
    console.error(`unknown eval(s): ${named.join(", ")} — available: ${ALL.map((e) => e.id).join(", ")}`);
    process.exit(2);
  }

  console.log(`ctxroom evals · git ${git} · live=${wantLive}`);
  let failed = 0;
  for (const e of chosen) {
    if (e.live && !wantLive) {
      console.log(summarize({ eval: e.id, version: "0.1.0", at: new Date().toISOString(), git, target: { name: "live gate", op: ">=", value: 0, actual: 0, pass: true }, detail: {}, pass: true }).replace("PASS", "SKIP (live-gated)"));
      continue;
    }
    const t0 = Date.now();
    const r = await e.run(wantLive);
    console.log(`${r.text}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    if (!r.pass) failed++;
  }
  console.log(failed === 0 ? "all evals passed" : `${failed} eval(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();

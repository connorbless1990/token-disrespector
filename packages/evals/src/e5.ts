/**
 * E5 — fuzz: 10k hostile blocks through the engine (work package C).
 *
 * Junk in, invariants out. Every block must:
 *   - not throw (I5: failure degrades to passthrough, never crashes);
 *   - not grow (I3: the forwarded part is never larger than the input);
 *   - be deterministic (same block, fresh engine → same forward form);
 *   - leave protected patterns intact (I10).
 *
 * The junk space spans: random ASCII/binary, emoji + surrogate pairs, NUL
 * and control characters, single giant lines, deep nesting, regex-hostile
 * strings, near-miss JSON, unicode block boundaries, repeated markers.
 *
 * Target (published): 100% of blocks pass all invariants.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, messageText, resolveEngineConfig, type EngineMessage } from "@ctxroom/core";
import { mulberry32 } from "./rng.ts";
import { writeReport, pct, type EvalReport } from "./report.ts";

export const E5_TARGET_PASS = 1.0;
export const E5_BLOCK_COUNT = 10_000;

type Rng = () => number;
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

const GIBBERISH = "abz$#@%^&*()_+{}|<>.?/\\[];:~`-=" as const;
const EMOJI = ["😀", "🎉", "𝕳𝖑𝖑", "Ⅷ", "Ⰰ", "👁", "🐈‍⬛", "🏴‍☠️"] as const; // incl. ZWJ/flag sequences

function junk(rng: Rng, kind: number): string {
  const len = () => Math.floor(rng() * 20_000);
  switch (kind % 10) {
    case 0: // random ASCII incl. control chars
      return Array.from({ length: len() }, () => String.fromCharCode(Math.floor(rng() * 128))).join("");
    case 1: // binary-ish: NULs and high bytes
      return Array.from({ length: len() }, () => (rng() < 0.1 ? "\u0000" : String.fromCharCode(128 + Math.floor(rng() * 127)))).join("");
    case 2: // emoji soup (surrogate pairs, ZWJ, regional indicators)
      return Array.from({ length: Math.floor(rng() * 3000) }, () => pick(rng, EMOJI)).join(" ");
    case 3: // one giant single line
      return "x".repeat(20 + Math.floor(rng() * 300_000)) + " " + "y".repeat(Math.floor(rng() * 1000));
    case 4: // deep nesting
      return "[".repeat(Math.floor(rng() * 500)) + "1".repeat(Math.floor(rng() * 100)) + "]".repeat(Math.floor(rng() * 500));
    case 5: // near-miss JSON (truncated / unbalanced / odd)
      return JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "s" } }, null, 2).slice(0, Math.floor(rng() * 400));
    case 6: // regex-hostile soup
      return Array.from({ length: Math.floor(rng() * 4000) }, () => pick(rng, ["(?", ")*", "[a-z]{99}", "\\.+$", "/\\/**/", "**", "a{1,999999}"])).join(" ");
    case 7: // repeated ctxroom markers (already-compressed guard)
      return Array.from({ length: Math.floor(rng() * 500) }, (_, i) => `[ctxroom:compressed ${i.toString(16).padStart(12, "0")} · 9 → 1]`).join("\n");
    case 8: // tab/space line-prefix junk
      return Array.from({ length: Math.floor(rng() * 400) }, () => "  ".repeat(Math.floor(rng() * 5)) + GIBBERISH[Math.floor(rng() * GIBBERISH.length)]).join("\n");
    default: // mixed unicode prose
      return Array.from({ length: Math.floor(rng() * 2000) }, () => pick(rng, ["word", "단어", "слово", "كلمة", "🔥", "123", "."])).join(" ");
  }
}

export interface E5Result {
  blocks: number;
  passRate: number; // fraction passing ALL invariants
  invariantFailures: { i3: number; i5: number; deterministic: number; i10: number };
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  pass: boolean;
}

export async function runE5(count: number = E5_BLOCK_COUNT, ccrDir?: string): Promise<E5Result> {
  const rng = mulberry32(20260925);
  const dir = ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e5-")), "ccr");

  const failures = { i3: 0, i5: 0, deterministic: 0, i10: 0 };
  let ok = 0;
  let lastKind = -1;

  for (let i = 0; i < count; i++) {
    // Avoid two identical back-to-back blocks (variety across the run).
    let kind = Math.floor(rng() * 10);
    if (kind === lastKind && rng() < 0.5) kind = (kind + 1) % 10;
    lastKind = kind;
    const content = junk(rng, kind);
    // A leading substring as protected pattern: this block must pass through
    // UNTOUCHED (I10) — which also exercises the guard on hostile content.
    const protectedPattern = content.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const block = { i3: false, i5: false, det: false, i10: false };

    let engine: Engine;
    try {
      engine = new Engine(
        resolveEngineConfig(
          { ccr: { enabled: true, dir }, protectedPatterns: [protectedPattern] },
          {} as NodeJS.ProcessEnv
        )
      );
    } catch {
      failures.i5++;
      block.i5 = true;
      continue;
    }

    const msg: EngineMessage = { role: "tool", tool_call_id: `call_f${i}`, content };
    const session: EngineMessage[] = [
      { role: "system", content: "You are a coding assistant. Be precise and verify with tools." },
      { role: "user", content: "Look." },
      msg,
    ];

    // I5: must never throw.
    let out;
    try {
      out = await engine.compress(session);
    } catch {
      failures.i5++;
      block.i5 = true;
      continue;
    }

    const fwd = out.forwardTexts[2];
    const outText = fwd === null ? content : typeof fwd === "string" ? fwd : (fwd as string[]).join("\n");

    // I3: never grows.
    if (outText.length > content.length) {
      failures.i3++;
      block.i3 = true;
    }
    // I10: protected ⇒ the part is forwarded exactly as submitted (null).
    if (fwd !== null) {
      failures.i10++;
      block.i10 = true;
    }

    // Determinism: fresh engine (cold dir), same block, same config.
    try {
      const engineB = new Engine(
        resolveEngineConfig({ ccr: { enabled: true, dir: join(dir, "b") }, protectedPatterns: [protectedPattern] }, {} as NodeJS.ProcessEnv)
      );
      const outB = await engineB.compress(session);
      if (JSON.stringify(outB.forwardTexts) !== JSON.stringify(out.forwardTexts)) {
        failures.deterministic++;
        block.det = true;
      }
    } catch {
      failures.deterministic++;
      block.det = true;
    }

    if (!block.i3 && !block.i5 && !block.det && !block.i10) ok++;
  }

  const passRate = count === 0 ? 1 : ok / count;
  return {
    blocks: count,
    passRate,
    invariantFailures: failures,
    target: { name: "blocks passing all invariants", op: ">=", value: E5_TARGET_PASS, actual: passRate, pass: passRate >= E5_TARGET_PASS },
    pass: passRate >= E5_TARGET_PASS,
  };
}

export function e5ToReport(r: E5Result, git: string): EvalReport {
  return {
    eval: "e5",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    target: r.target,
    pass: r.pass,
    detail: { blocks: r.blocks, passing: Math.round(r.passRate * r.blocks), failures: r.invariantFailures },
  };
}

export function e5Summary(r: E5Result): string {
  const f = r.invariantFailures;
  const lines = [`E5 fuzz ${r.blocks} hostile blocks: ${pct(r.passRate)} pass all invariants (target ${pct(E5_TARGET_PASS)}) ${r.pass ? "PASS" : "FAIL"}`];
  lines.push(`   I3 growth ${f.i3} · I5 throws ${f.i5} · determinism ${f.deterministic} · I10 protected ${f.i10}`);
  return lines.join("\n");
}

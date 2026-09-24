/**
 * B1 — engine properties at scale (work package B).
 *
 * 1,000 seeded random blocks across the real shape space (text, minified
 * JSON, indented JSON, logs, diffs, base64, CJK, big single lines, tool
 * wrappers). For every block the invariants must hold:
 *   I1 system untouched · I2 frozen prefix byte-stable on resend ·
 *   I3 no growth · I5 never throws · I8/I9 CCR round-trips byte-exact ·
 *   I10 protected patterns intact · determinism across fresh engines.
 *
 * The corpus is generated deterministically (mulberry32 seed), so a
 * regression anywhere in the 1,000 reproduces identically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CcrStore,
  Engine,
  resolveEngineConfig,
  type EngineMessage,
} from "../src/index.ts";

// --- seeded rng (mulberry32) -------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// --- shape generators --------------------------------------------------------
const WORDS = ["alpha", "bravo", "cache", "delta", "engine", "forge", "gamma", "proxy", "query", "replay", "sigma", "token", "union", "vector", "yield"] as const;
const CJK = ["混沌", "意識", "波動", "共振", "起源", "覚醒", "回帰", "統合", "変容", "観測"] as const;

function randomText(rng: Rng, paras: number, words: number): string {
  return Array.from({ length: paras }, () =>
    Array.from({ length: int(rng, 3, words) }, () => pick(rng, WORDS)).join(" ") + "."
  ).join("\n\n");
}
function minifiedJson(rng: Rng, n: number): string {
  const recs = Array.from({ length: n }, (_, i) => ({
    id: i,
    status: pick(rng, ["ok", "retry", "error"]),
    latency: int(rng, 1, 5000),
    ref: `req_${int(rng, 0, 99999)}`,
  }));
  return JSON.stringify({ results: recs }); // one line, minified
}
function indentedJson(rng: Rng, n: number): string {
  const recs = Array.from({ length: n }, (_, i) => ({
    id: i,
    status: pick(rng, ["ok", "retry", "error"]),
    latency: int(rng, 1, 5000),
  }));
  return `GET /api/charges returned 200 OK (lines 1-${n * 4})\n` + JSON.stringify({ results: recs }, null, 2);
}
function randomLog(rng: Rng, lines: number): string {
  const levels = ["INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"] as const;
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const lvl = pick(rng, levels);
    const t = `2026-09-21T10:${String(int(rng, 0, 59)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}.${String(int(rng, 0, 999)).padStart(3, "0")}Z`;
    if (lvl === "ERROR") {
      out.push(`${t} ERROR [worker] ${pick(rng, ["timeout", "failed", "denied"])}: ${pick(rng, WORDS)} ${int(rng, 1, 999)}`);
    } else {
      out.push(`${t} ${lvl}  [worker] ${pick(rng, ["processing", "flushing", "rotating"])} ${pick(rng, WORDS)} ${int(rng, 1, 99)}`);
    }
  }
  return out.join("\n");
}
function randomDiff(rng: Rng): string {
  const files = int(rng, 1, 3);
  let s = "";
  for (let f = 0; f < files; f++) {
    const p = `packages/${pick(rng, ["core", "cli", "proxy"])}/src/${pick(rng, ["engine", "router", "store"])}.ts`;
    s += `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -${int(rng, 1, 40)},${int(rng, 2, 10)} +${int(rng, 1, 40)},${int(rng, 2, 10)} @@\n`;
    for (let i = 0; i < int(rng, 2, 6); i++) {
      const c = pick(rng, [" ", "+", "-", " ", " "]);
      s += `${c} ${pick(rng, WORDS)} ${pick(rng, WORDS)}(${pick(rng, WORDS)})\n`;
    }
  }
  return s;
}
function randomBase64(rng: Rng, bytes: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
  let s = Buffer.from(
    Array.from({ length: bytes }, () => int(rng, 0, 255))
  ).toString("base64");
  void alphabet;
  return `/assets/blob-${int(rng, 0, 999)}.bin\n${s}`;
}
function randomCjk(rng: Rng, lines: number): string {
  return Array.from({ length: lines }, () =>
    Array.from({ length: int(rng, 4, 12) }, () => pick(rng, CJK)).join("")
  ).join("\n");
}
function bigSingleLine(rng: Rng, targetBytes: number): string {
  let line = "";
  for (let i = 0; line.length < targetBytes; i++) {
    line += `const v${i} = ${(i * 7) % 991} /* ${pick(rng, WORDS)} ${i} */; `;
  }
  return `/src/generated/bundle.js\n${line}`;
}
function wrapped(rng: Rng, inner: string, path: string): string {
  // §4.1 tool wrapper shapes
  const shapes = [
    `${path}\n${inner}`,
    `${path} (lines 1-${int(rng, 50, 500)})\n${inner}`,
    `${path}\n${inner}\n\n<output truncated> — run with a larger limit to see the rest`,
    inner
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  ];
  return pick(rng, shapes);
}

type ShapeKind =
  | "text"
  | "minified"
  | "indented"
  | "log"
  | "diff"
  | "base64"
  | "cjk"
  | "bigline"
  | "wrapped"
  | "small";

function makeBlock(rng: Rng, kind: ShapeKind): { path: string; content: string } {
  const paths = ["packages/core/src/engine.ts", "packages/proxy/src/server.ts", "packages/cli/src/index.ts", "data/dump.json"] as const;
  const path = pick(rng, paths);
  switch (kind) {
    case "text":
      return { path, content: randomText(rng, int(rng, 8, 30), 12) };
    case "minified":
      return { path: "data/charges.json", content: minifiedJson(rng, int(rng, 40, 400)) };
    case "indented":
      return { path: "data/charges.json", content: indentedJson(rng, int(rng, 20, 200)) };
    case "log":
      return { path: "logs/build.log", content: randomLog(rng, int(rng, 40, 800)) };
    case "diff":
      return { path, content: randomDiff(rng) };
    case "base64":
      return { path: "assets/blob.bin", content: randomBase64(rng, int(rng, 400, 4000)) };
    case "cjk":
      return { path: "docs/notes.md", content: randomCjk(rng, int(rng, 10, 60)) };
    case "bigline":
      return { path: "src/generated/bundle.js", content: bigSingleLine(rng, 200_000) };
    case "wrapped": {
      const inner = pick(rng, [
        () => indentedJson(rng, int(rng, 30, 150)),
        () => randomLog(rng, int(rng, 30, 200)),
        () => randomText(rng, int(rng, 10, 40), 8),
        () => minifiedJson(rng, int(rng, 50, 300)),
      ])();
      return { path, content: wrapped(rng, inner, path) };
    }
    case "small":
      return { path, content: pick(rng, WORDS) + " is a " + pick(rng, WORDS) + ".\n" + pick(rng, WORDS) };
  }
}

/** Paginate a CCR retrieve until the full text is assembled. */
async function retrieveFull(store: CcrStore, hash12: string): Promise<string> {
  let text = "";
  for (let offset = 0; ; offset += 20_000) {
    const got = await store.retrieve(hash12, { offset, maxChars: 20_000 });
    if (!got) throw new Error(`retrieve returned null at offset ${offset} for ${hash12}`);
    text += got.text;
    if (!got.truncated || got.text.length === 0) break;
    if (offset > 50_000_000) throw new Error("retrieve pagination did not terminate");
  }
  return text;
}

const MARKER_RE = /\[ctxroom:compressed ([0-9a-f]{12})/;

interface CheckResult {
  i1: boolean;
  i2: boolean;
  i3: boolean;
  i9: boolean;
  i10: boolean;
  deterministic: boolean;
}

async function checkBlock(
  baseDir: string,
  content: string,
  withProtected: boolean
): Promise<CheckResult> {
  // Fresh CCR dirs per engine: engine B's dir simulates a cold restart —
  // its forward forms must still match engine A's byte-for-byte.
  const ccrDir = mkdtempSync(join(baseDir, "a-"));
  const ccrDirB = mkdtempSync(join(baseDir, "b-"));
  const protectedPattern = content
    .slice(0, 12)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mkCfg = (dir: string) =>
    resolveEngineConfig(
      {
        ccr: { enabled: true, dir },
        ...(withProtected ? { protectedPatterns: [protectedPattern] } : {}),
      },
      {} as NodeJS.ProcessEnv
    );
  const engine = new Engine(mkCfg(ccrDir));
  const system = "You are a coding agent. Be precise.";
  const msg: EngineMessage = { role: "tool", tool_call_id: "call_p1", content };
  const session: EngineMessage[] = [
    { role: "system", content: system },
    { role: "user", content: "What does " + content.slice(0, 40) + " tell us?" },
    msg,
  ];

  // I5: must never throw.
  const out = await engine.compress(session);

  // I1.
  const i1 = out.messages[0]!.content === system;

  // I3 + I9 + I10 on the tool part.
  const fwd = out.forwardTexts[2];
  // I10: a protected-pattern block must pass through completely untouched.
  const i10 = withProtected ? fwd === null : true;
  let i3 = true;
  let i9 = true;
  if (fwd !== null) {
    const texts = typeof fwd === "string" ? [fwd] : fwd;
    for (const t of texts) {
      if (t.length > content.length) i3 = false;
      const m = MARKER_RE.exec(t);
      if (m) {
        const orig = await retrieveFull(engine.ccrStore, m[1]!);
        // The stored original is the PART (wrapper included if any).
        if (orig !== content) {
          i9 = false;
          continue;
        }
      }
    }
  }

  // I2: identical resend → identical forward forms (byte stability).
  const out2 = await engine.compress(session);
  const i2 = JSON.stringify(out2.forwardTexts) === JSON.stringify(out.forwardTexts);

  // Determinism: fresh engine + cold CCR dir + same input → same forms.
  const engineB = new Engine(mkCfg(ccrDirB));
  const outB = await engineB.compress(session);
  const deterministic = JSON.stringify(outB.forwardTexts) === JSON.stringify(out.forwardTexts);

  return { i1, i2, i3, i9, i10, deterministic };
}

test("B1: 1000 seeded blocks satisfy the engine invariants", { timeout: 600_000 }, async () => {
  const rng = mulberry32(20260924);
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-b1-"));
  try {
    const kinds: ShapeKind[] = [
      "text", "minified", "indented", "log", "diff", "base64", "cjk", "wrapped",
    ];
    const failures: Partial<Record<keyof CheckResult, number>> = {};
    const shapeCounts: Record<string, number> = {};
    let checked = 0;

    for (let i = 0; i < 1000; i++) {
      // ~2% big single-line blocks (the 200 KB stress shape).
      const kind: ShapeKind =
        rng() < 0.02 ? "bigline" : rng() < 0.04 ? "small" : pick(rng, kinds);
      const { content } = makeBlock(rng, kind);
      const withProtected = rng() < 0.05; // ~5% exercise I10
      const r = await checkBlock(dir, content, withProtected);
      checked++;
      shapeCounts[kind] = (shapeCounts[kind] ?? 0) + 1;
      (["i1", "i2", "i3", "i9", "i10", "deterministic"] as const).forEach((k) => {
        if (!r[k]) failures[k] = (failures[k] ?? 0) + 1;
      });
    }

    const shapeSummary = Object.entries(shapeCounts)
      .map(([s, c]) => s + ":" + c)
      .join(", ");
    for (const [inv, n] of Object.entries(failures)) {
      assert.equal(n, 0, inv + " violated on " + n + "/" + checked + " blocks (of " + shapeSummary + ")");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: 200KB single-line bundle — I3, no marker growth, CCR round-trip", { timeout: 300_000 }, async () => {
  const rng = mulberry32(777);
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-b1-"));
  try {
    for (let i = 0; i < 3; i++) {
      const { content } = makeBlock(rng, "bigline");
      assert.ok(content.length >= 150_000);
      const r = await checkBlock(dir, content, false);
      assert.ok(r.i1 && r.i3 && r.i9 && r.i2 && r.deterministic, "invariants hold on the big single line");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

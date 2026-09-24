/**
 * E1 — the real-shape corpus (work package C / E1).
 *
 * A deterministic (seeded) generator for the tool-output shapes a coding
 * agent actually sees in a session, reconstructed from live Copilot CLI
 * 1.0.88 captures on this machine (2026-09-23): bare path header + raw
 * content, "(lines N-M)" partial reads, truncation notices, per-line
 * prefixes, minified single-line files, build logs, ripgrep dumps, diffs,
 * prose in English and CJK.
 *
 * Each shape declares `liveZone: true` (measured against the ratio target)
 * or `liveZone: false` (system-prompt class: must never be touched — I1).
 */
import { int, pick, sample, type Rng, mulberry32, gauss, shuffle } from "./rng.ts";

export const DEFAULT_SEED = 20260923;

export interface Shape {
  /** Stable identifier used in the report. */
  name: string;
  /** Measured against the E1 ratio target. */
  liveZone: boolean;
  /** The block as the agent client would send it. */
  content: string;
  /** What kind of content this is (for humans reading the report). */
  kind: string;
}

const SERVICES = ["auth", "billing", "search", "catalog", "checkout"] as const;
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"] as const;
const WORDS = [
  "the", "agent", "compressed", "context", "before", "it", "reached", "the", "model",
  "a", "single", "token", "can", "carry", "many", "bytes", "of", "structure",
  "we", "measure", "the", "difference", "honestly", "and", "publish", "the", "number",
  "deterministic", "local", "reversible", "and", "honest", "are", "the", "four", "words",
  "this", "system", "is", "built", "on", "every", "claim", "in", "the", "report",
  "must", "reproduce", "byte", "for", "byte", "on", "a", "stranger", "s", "machine",
] as const;
const CJK = [
  "上下文", "压缩", "模型", "缓存", "字节", "确定性", "本地", "可逆", "诚实",
  "一个", "标记", "携带", "大量", "结构", "信息", "我们", "测量", "差异",
  "然后", "发布", "数字", "而不是", "故事", "系统", "构建", "原则", "之上",
] as const;
const FILES = [
  "packages/core/src/engine.ts", "packages/core/src/compress.ts", "packages/proxy/src/server.ts",
  "packages/cli/src/copilot.ts", "packages/mcp/src/index.ts", "packages/core/src/ccr.ts",
] as const;

function apiRecords(rng: Rng, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `req_${100000 + i}`,
    service: pick(rng, SERVICES),
    method: pick(rng, METHODS),
    path: `/api/v2/${pick(rng, ["users", "orders", "items", "sessions"])}/${int(rng, 1, 9999)}`,
    status: rng() < 0.94 ? 200 : pick(rng, [404, 429, 500, 502]),
    duration_ms: Math.round(Math.abs(gauss(rng, 120, 180))),
    bytes: int(rng, 128, 120000),
    cached: rng() < 0.3,
    ts: `2026-09-${String(int(rng, 20, 23)).padStart(2, "0")}T${String(int(rng, 0, 23)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}Z`,
    error: rng() < 0.94 ? null : pick(rng, ["upstream timeout", "connection reset", "rate limit exceeded", "bad gateway"]),
  }));
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

function jsonWholePretty(rng: Rng): Shape {
  const doc = { generated: "2026-09-21", results: apiRecords(rng, 300) };
  return shape("json-whole-pretty", true, `/var/folders/xy/copilot/big-api-dump.json\n${JSON.stringify(doc, null, 2)}`, "indented JSON, path header");
}

function jsonFirstChunk(rng: Rng): Shape {
  const doc = { generated: "2026-09-21", results: apiRecords(rng, 360) };
  const lines = JSON.stringify(doc, null, 2).split("\n");
  const cut = lines.slice(0, 700).join("\n");
  return shape("json-first-chunk", true, `/var/folders/xy/copilot/big-api-dump.json (lines 1-700)\n${cut}`, "partial read, indented JSON");
}

function jsonMiddleChunk(rng: Rng): Shape {
  const doc = { generated: "2026-09-21", results: apiRecords(rng, 360) };
  const lines = JSON.stringify(doc, null, 2).split("\n");
  return shape("json-middle-chunk", true, lines.slice(240, 940).join("\n"), "middle window of a larger document");
}

function jsonMinified(rng: Rng): Shape {
  const minified = JSON.stringify(apiRecords(rng, 600));
  return shape("json-minified-singleline", true, `/tmp/proj/minified-dump.json\n${minified}`, "minified single-line JSON");
}

function logBuild(rng: Rng): Shape {
  const lines: string[] = [`$ npm run build --workspaces`];
  for (let i = 0; i < 2400; i++) {
    const lvl = pick(rng, LEVELS);
    const t = `${String(int(rng, 0, 23)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}.${String(int(rng, 0, 999)).padStart(3, "0")}`;
    if (lvl === "ERROR") {
      lines.push(`2026-09-21T${t}Z ERROR [tsc] error TS2339: Property '${pick(rng, ["foo", "bar", "baz"])}' does not exist on type 'Config' at ${pick(rng, FILES)}:${int(rng, 10, 900)}`);
    } else {
      lines.push(`2026-09-21T${t}Z ${lvl} [vite] transforming ${pick(rng, FILES)} chunk ${int(rng, 1, 90)} (${int(rng, 2, 300)} ms)`);
    }
  }
  return shape("log-build", true, lines.join("\n"), "build log, mostly template");
}

function logShell(rng: Rng): Shape {
  const lines: string[] = [`$ npm test -- --coverage`];
  for (let i = 0; i < 120; i++) {
    lines.push(`✔ ${pick(rng, FILES).replace(/\.ts$/, "")} ${pick(rng, ["parses", "round-trips", "evicts", "routes"])} ${pick(rng, ["input", "a record", "the marker"])} (${(rng() * 20).toFixed(1)}ms)`);
  }
  lines.push(`ℹ tests ${120 + int(rng, 0, 30)}`);
  lines.push(`ℹ pass ${120 + int(rng, 0, 30)}`);
  lines.push(`ℹ fail 0`);
  return shape("log-shell-test", true, lines.join("\n"), "test runner output");
}

function ripgrepDump(rng: Rng): Shape {
  const lines: string[] = [];
  for (let i = 0; i < 140; i++) {
    const f = pick(rng, FILES);
    lines.push(`${f}:${int(rng, 1, 1200)}:  ${pick(rng, ["if (err) {", "return compressed;", "hash12 + suffix", "const spec = detectWrapper(text);", "await ccr.store(part);"])} ${int(rng, 0, 99)}`);
  }
  return shape("search-ripgrep", true, lines.join("\n"), "ripgrep file:line:content dump");
}

function lineNumbered(rng: Rng): Shape {
  const lines = apiRecords(rng, 50).map((r, i) => `/tmp/proj/data.json:${i + 1}:${JSON.stringify(r)}`);
  return shape("lines-numbered", true, lines.join("\n"), "per-line path:line: prefixes");
}

function gitDiff(rng: Rng): Shape {
  const files = shuffle(rng, FILES).slice(0, 4);
  const parts: string[] = [];
  for (const f of files) {
    parts.push(`diff --git a/${f} b/${f}`);
    parts.push(`index 3f2a1c9..8b7d4e2 100644`);
    parts.push(`--- a/${f}`);
    parts.push(`+++ b/${f}`);
    parts.push(`@@ -${int(rng, 10, 80)},${int(rng, 4, 12)} +${int(rng, 10, 80)},${int(rng, 4, 14)} @@`);
    for (let i = 0; i < 8; i++) parts.push(`  ${pick(rng, ["const x = compute(i);", "if (spec) return spec.inner;", "// todo: tune the keep budget", "export function route(text) {"])}`);
    for (let i = 0; i < int(rng, 1, 5); i++) parts.push(`-${pick(rng, ["const old = legacy(text);", "return legacyRoute(text);"])}`);
    for (let i = 0; i < int(rng, 1, 5); i++) parts.push(`+${pick(rng, ["const spec = detectWrapper(text);", "return routeOnInner(spec);", "// work package A1"])}`);
  }
  return shape("diff-git", true, parts.join("\n"), "git diff, multi-file");
}

function proseEnglish(rng: Rng): Shape {
  const text: string[] = [];
  for (let p = 0; p < 26; p++) {
    const w = sample(rng, WORDS, int(rng, 28, 60));
    text.push(w.join(" ") + (rng() < 0.5 ? "." : ",") + " ");
  }
  return shape("prose-english", true, text.join("\n\n").trim(), "long assistant prose");
}

function proseCjk(rng: Rng): Shape {
  const text: string[] = [];
  for (let p = 0; p < 26; p++) {
    const w = sample(rng, CJK, int(rng, 18, 40));
    text.push(w.join("") + "。");
  }
  return shape("prose-cjk", true, text.join("\n"), "CJK prose (token estimation stress)");
}

function configYaml(rng: Rng): Shape {
  const lines: string[] = ["# ctxroom runtime configuration", "proxy:"];
  for (let i = 0; i < 220; i++) {
    lines.push(`  route${i}:`);
    lines.push(`    pattern: /v1/${pick(rng, ["chat", "embeddings", "responses"])}`);
    lines.push(`    compressor: ${pick(rng, ["auto", "json", "log", "text"])}`);
    lines.push(`    ttl_min: ${int(rng, 5, 240)}`);
    lines.push(`    enabled: ${rng() < 0.7 ? "true" : "false"}`);
  }
  return shape("config-yaml", true, lines.join("\n"), "large YAML config");
}

function codeSingleLine200kb(rng: Rng): Shape {
  // A single 200KB-class line of code: the no-compression stress case
  // (I3 must never GROW it; I5 must not crash on it).
  const stmts = Array.from({ length: 5300 }, (_, i) => `const v${i} = ${i % 7 === 0 ? "compute(" + i + ")" : i * 3} /* ${pick(rng, ["anchor", "budget", "signal", "token"])} ${i} */;`);
  const line = stmts.join(" ");
  return shape("code-singleline-200kb", true, `/src/generated/bundle.js\n${line}`, "200KB single line of code");
}

function smallFile(rng: Rng): Shape {
  // Below the I4 word-equivalent gate: must pass through untouched.
  const body = `# README\n\nA tiny project. ${sample(rng, WORDS, 30).join(" ")}.` + "\n\n" + sample(rng, WORDS, 24).join(" ") + ".";
  return shape("small-file", true, `/tmp/proj/README.md\n${body}`, "small file (I4 protection)");
}

function systemPrompt(_rng: Rng): Shape {
  const body =
    "You are an expert coding agent. You help the user build, debug, and " +
    "refactor software. Always verify your assumptions. When you read files, " +
    "use the provided tools. If output is truncated, retrieve the original with " +
    "ctxroom_retrieve when you need the missing part. Never fabricate file " +
    "contents. " +
    "You operate through a local compression proxy: long tool outputs may be " +
    "compressed before reaching you, and a marker tells you how to retrieve " +
    "the exact original. Prefer the compressed view for orientation; retrieve " +
    "for precision. " +
    "Your answers must be grounded in the context you are given. " +
    "When in doubt, read more. " +
    "Compression is reversible: anything you cannot see may still exist in " +
    "the context store. " +
    "Be concise, cite line numbers when referring to code, and flag anything " +
    "you could not verify. " +
    "The user's explicit instructions override all other guidance. " +
    "When a task is ambiguous, ask one clarifying question rather than " +
    "guessing. " +
    "Prefer small, verifiable steps over large rewrites. " +
    "Report measurements, not adjectives: numbers, not vibes. " +
    "If you notice a pattern in the tool outputs, name it and exploit it. " +
    "Determinism is a feature: the same input must produce the same context " +
    "on every run, which is what keeps the model's prefix cache warm. ";
  return shape("system-prompt", false, body, "system prompt (I1: never touched)");
}

function shape(name: string, liveZone: boolean, content: string, kind: string): Shape {
  return { name, liveZone, content, kind };
}

/**
 * The full E1 corpus, deterministic per seed.
 */
export function generateCorpus(seed: number = DEFAULT_SEED): Shape[] {
  const rng = mulberry32(seed);
  return [
    systemPrompt(rng),
    jsonWholePretty(rng),
    jsonFirstChunk(rng),
    jsonMiddleChunk(rng),
    jsonMinified(rng),
    logBuild(rng),
    logShell(rng),
    ripgrepDump(rng),
    lineNumbered(rng),
    gitDiff(rng),
    proseEnglish(rng),
    proseCjk(rng),
    configYaml(rng),
    codeSingleLine200kb(rng),
    smallFile(rng),
  ];
}

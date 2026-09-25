/**
 * E2 — answer-quality A/B (the flagship, work package C).
 *
 * The question the eval answers: does compression change what the model can
 * ANSWER? A/B on one seeded session × 20 questions:
 *   A — full context (the client's own bytes)
 *   B — compressed context; the mock model exercises the production
 *       contract: every CCR marker it sees is RESOLVED via retrieve()
 *       before answering (I9 gives back byte-exact originals), and it
 *       answers from whatever text remains (reformats included).
 *
 * The mock model is a deterministic fact extractor (no network, no LLM) —
 * `npm run eval` runs it offline. The live variant (real model + real
 * retrieve tool) reuses this harness under --live.
 *
 * Target (published): ≥ 95% of questions answered identically in A and B.
 *
 * The fact extractors are deliberately conservative — presence and counts of
 * distinctive tokens — so a disagreement is a genuine information-loss
 * signal, not an artifact of how prose got re-wrapped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcrStore, Engine, resolveEngineConfig, type EngineMessage } from "@ctxroom/core";
import { generateCorpus, DEFAULT_SEED, type Shape } from "./corpus.ts";
import { writeReport, pct, type EvalReport } from "./report.ts";

export const E2_TARGET_AGREEMENT = 0.95;

const MARKER_RE = /\[ctxroom:compressed ([0-9a-f]{12})/g;

/** The mock model: a deterministic fact extractor over the text it receives. */
type FactFn = (ctx: string[]) => string;

interface Question {
  q: string;
  /** Extract the answer from the message texts the model received. */
  facts: FactFn;
}

const countMatches = (ctx: string[], re: RegExp): number =>
  ctx.reduce((n, t) => n + (t.match(re) ?? []).length, 0);
const present = (ctx: string[], token: string): string =>
  [...new Set(ctx.filter((t) => t.includes(token)))].length > 0 ? "present" : "absent";

const errorServices = (c: string[]): string => {
  const names = new Set<string>();
  for (const t of c) {
    for (const l of t.split("\n")) {
      if (!/\bERROR\b/.test(l)) continue;
      for (const m of l.matchAll(/\[(\w+)\]/g)) names.add(m[1]!);
    }
  }
  return names.size > 0 ? [...names].sort().join(",") : "none";
};

const QUESTIONS: Question[] = [
  { q: "Which services appear on ERROR lines?", facts: errorServices },
  { q: "How many rate-limit errors?", facts: (c) => String(countMatches(c, /rate limit exceeded/g)) },
  { q: "How many 5xx billing responses in the API dump?", facts: (c) => String(countMatches(c, /"status":\s*5\d\d/g)) },
  { q: "How many 2xx responses in the API dump?", facts: (c) => String(countMatches(c, /"status":\s*2\d\d/g)) },
  { q: "Is the 'slow' request class present?", facts: (c) => present(c, "req_slow0") },
  { q: "What is the first API record's status?", facts: (c) => (c.join(" ").match(/"status":\s*(\d{3})/) ?? ["", "none"])[1]! },
  { q: "How many distinct WARN kinds in the build log?", facts: (c) => String(new Set((c.join("\n").match(/WARN\s+\[\w+\]\s+\S+/g) ?? [])).size) },
  { q: "Does the build log mention a crash?", facts: (c) => present(c, "crash") },
  { q: "How many config keys does the app config define?", facts: (c) => String(countMatches(c, /^[ \t]*[\w-]+:/gm)) },
  { q: "What is the configured cache TTL?", facts: (c) => (c.join(" ").match(/ttl[=:][^\s,\n}]+/g) ?? ["none"]).slice(0, 3).sort().join("|") },
  { q: "What database host is configured?", facts: (c) => (c.join(" ").match(/host[=:]\s*["']?[\w.-]+/g) ?? ["none"]).sort().join("|") },
  { q: "How many numbered lines does the file listing contain?", facts: (c) => String(countMatches(c, /^\s*\d{1,4}\s/gm)) },
  { q: "Which file paths appear in the ripgrep output?", facts: (c) => [...new Set((c.join("\n").match(/^\S*[\w./-]+\.(ts|js|json)/gm) ?? []))].sort().join(",") || "none" },
  { q: "How many hits reference engine.ts?", facts: (c) => String(countMatches(c, /engine\.ts/g)) },
  { q: "What do the prose notes say the cache does?", facts: (c) => (c.join(" ").match(/cache[^\n.]{0,80}/g) ?? ["none"]).length > 0 ? "described" : "not-described" },
  { q: "Is the CJK assistant turn about awakening?", facts: (c) => present(c, "覚醒") },
  { q: "How many statements in the minified bundle line?", facts: (c) => String(countMatches(c, /;\s*(?=[a-z])/g)) },
  { q: "What is the generated bundle's first identifier?", facts: (c) => (c.join(" ").match(/const\s+(\w+)/) ?? ["", "none"])[1]! },
  { q: "Does the diff touch the router?", facts: (c) => present(c, "router.ts") },
  { q: "How many files does the diff modify?", facts: (c) => String(countMatches(c, /^diff --git /gm)) },
];

/**
 * Mock model: given the messages it RECEIVED (as the provider would send
 * them), resolve every CCR marker via the store, then answer.
 */
async function mockAnswer(question: Question, messages: EngineMessage[], store: CcrStore, textOf: (m: EngineMessage) => string): Promise<string> {
  // Reconstruct the context the model sees, resolving markers (I9).
  // A marked part is the compressed block (preview lines + marker); the
  // production contract is that retrieve() returns the EXACT original part,
  // so the model reads the original INSTEAD of the preview — never both
  // (that would double-count everything the preview retained).
  const ctx: string[] = [];
  for (const m of messages) {
    let t = textOf(m);
    const hashes = [...new Set([...t.matchAll(MARKER_RE)].map((x) => x[1]!))];
    for (const h of hashes) {
      let full = "";
      for (let off = 0; ; off += 20_000) {
        const got = await store.retrieve(h, { offset: off, maxChars: 20_000 });
        if (!got) break; // marker unresolvable: keep the compressed form
        full += got.text;
        if (!got.truncated || got.text.length === 0) break;
        if (off > 50_000_000) break;
      }
      if (full.length > 0) {
        t = full; // the original part replaces the compressed block
        break;
      }
    }
    ctx.push(t);
  }
  return question.facts(ctx);
}

export interface E2QuestionResult {
  question: string;
  fullAnswer: string;
  compressedAnswer: string;
  agree: boolean;
}
export interface E2Result {
  agreement: number;
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  questions: E2QuestionResult[];
  pass: boolean;
}

export async function runE2(seed: number = DEFAULT_SEED, ccrDir?: string): Promise<E2Result> {
  const corpus = generateCorpus(seed);
  const byName = new Map(corpus.map((s: Shape) => [s.name, s]));
  const dir = ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e2-")), "ccr");
  const store = new CcrStore({ dir });
  const engine = new Engine(
    resolveEngineConfig({ ccr: { enabled: true, dir } }, {} as NodeJS.ProcessEnv),
    { ccr: store }
  );

  const textOf = (m: EngineMessage) => {
    const c = m.content;
    if (typeof c === "string") return c;
    return (c as { text?: string }[]).map((p) => p.text ?? "").join("\n");
  };

  // One realistic session, one question per run (the client resends its own
  // messages each time; the engine keeps the frozen prefix stable).
  const sessions: EngineMessage[][] = QUESTIONS.map((q, i) => [
    { role: "system", content: byName.get("system-prompt")!.content },
    { role: "user", content: q.q },
    { role: "tool", tool_call_id: `call_api`, content: byName.get("json-whole-pretty")!.content },
    { role: "tool", tool_call_id: `call_log`, content: byName.get("log-build")!.content },
    { role: "tool", tool_call_id: `call_cfg`, content: byName.get("config-yaml")!.content },
    { role: "tool", tool_call_id: `call_rg`, content: byName.get("search-ripgrep")!.content },
    { role: "assistant", content: byName.get("prose-english")!.content },
    { role: "tool", tool_call_id: `call_lines`, content: byName.get("lines-numbered")!.content },
    { role: "user", content: `Follow-up ${i}: also note anything else relevant.` },
  ]);

  const results: E2QuestionResult[] = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i]!;
    const session = sessions[i]!;

    // A — the client's own FULL context: the pristine messages, no
    // compression at all (this is the un-compressed baseline the provider
    // would have served today).
    const fullAnswer = await mockAnswer(q, session, store, textOf);

    // B — the same session through the real engine (CCR on). The mock
    // resolves every marker it sees via retrieve() — the production
    // contract — and answers from the rest as-is.
    const compRes = await engine.compress(session);
    const compressedAnswer = await mockAnswer(q, compRes.messages, store, textOf);

    results.push({ question: q.q, fullAnswer, compressedAnswer, agree: fullAnswer === compressedAnswer });
  }

  const agreeCount = results.filter((r) => r.agree).length;
  const agreement = agreeCount / results.length;
  return {
    agreement,
    target: { name: "answer agreement (A/B)", op: ">=", value: E2_TARGET_AGREEMENT, actual: agreement, pass: agreement >= E2_TARGET_AGREEMENT },
    questions: results,
    pass: agreement >= E2_TARGET_AGREEMENT,
  };
}

export function e2ToReport(r: E2Result, seed: number, git: string): EvalReport {
  return {
    eval: "e2",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    seed,
    target: { name: r.target.name, op: ">=", value: r.target.value, actual: r.target.actual, pass: r.target.pass },
    pass: r.pass,
    detail: {
      agree: r.questions.filter((q) => q.agree).length,
      total: r.questions.length,
      mismatches: r.questions.filter((q) => !q.agree).map((q) => ({ q: q.question, full: q.fullAnswer, compressed: q.compressedAnswer })),
    },
  };
}

export function e2Summary(r: E2Result): string {
  const miss = r.questions.filter((q) => !q.agree);
  const lines = [`E2 answer A/B agreement: ${pct(r.agreement)} (target ≥ ${pct(E2_TARGET_AGREEMENT)}) ${r.pass ? "PASS" : "FAIL"}`];
  for (const m of miss) lines.push(`   MISMATCH: ${m.question}\n     full: ${m.fullAnswer}\n     compressed: ${m.compressedAnswer}`);
  return lines.join("\n");
}

/**
 * E3 — KV-cache byte stability (work package C).
 *
 * The provider caches by exact prefix bytes; the engine's core promise is
 * that a resubmitted session forwards byte-identical messages. This eval
 * measures the property directly across many seeded sessions: every message
 * of a resubmission must equal the original forward form, byte for byte.
 *
 * Target (published): 100% — any instability busts a real provider cache.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, messageText, resolveEngineConfig, type EngineMessage } from "@ctxroom/core";
import { generateCorpus, DEFAULT_SEED } from "./corpus.ts";
import { writeReport, pct, type EvalReport } from "./report.ts";

export const E3_TARGET_STABILITY = 1.0;

interface SessionSpec {
  label: string;
  messages: EngineMessage[];
}

function buildSessions(): SessionSpec[] {
  const corpus = generateCorpus(DEFAULT_SEED);
  const byName = new Map(corpus.map((s) => [s.name, s]));
  const tool = (id: number, name: string): EngineMessage => ({
    role: "tool",
    tool_call_id: `call_${id}`,
    content: byName.get(name)!.content,
  });
  const sys: EngineMessage = { role: "system", content: byName.get("system-prompt")!.content };
  return [
    { label: "api-dump", messages: [sys, { role: "user", content: "Analyze the dump." }, tool(1, "json-whole-pretty")] },
    { label: "build-log", messages: [sys, { role: "user", content: "Why did the build fail?" }, tool(2, "log-build")] },
    { label: "json-chunks", messages: [sys, { role: "user", content: "Diff the chunks." }, tool(3, "json-first-chunk"), tool(4, "json-middle-chunk")] },
    { label: "minified", messages: [sys, { role: "user", content: "Scan this." }, tool(5, "json-minified-singleline")] },
    { label: "search", messages: [sys, { role: "user", content: "Find usages." }, tool(6, "search-ripgrep")] },
    { label: "numbered-lines", messages: [sys, { role: "user", content: "Read the file." }, tool(7, "lines-numbered")] },
    { label: "config+code", messages: [sys, { role: "user", content: "Check config and code." }, tool(8, "config-yaml"), tool(9, "code-singleline-200kb")] },
    { label: "prose", messages: [sys, { role: "user", content: "Summarize." }, { role: "assistant", content: byName.get("prose-english")!.content }, tool(10, "log-shell-test")] },
    { label: "cjk", messages: [sys, { role: "user", content: "訳して。" }, { role: "assistant", content: byName.get("prose-cjk")!.content }] },
  ];
}

export interface E3Result {
  stability: number; // fraction of resubmitted messages byte-identical
  sessions: { label: string; stable: boolean; unstableMessages: number }[];
  totalMessages: number;
  stableMessages: number;
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  pass: boolean;
}

export async function runE3(ccrDir?: string): Promise<E3Result> {
  const dir = ccrDir ?? join(mkdtempSync(join(tmpdir(), "ctxroom-e3-")), "ccr");
  const engine = new Engine(
    resolveEngineConfig({ ccr: { enabled: true, dir } }, {} as NodeJS.ProcessEnv)
  );
  const sessions = buildSessions();

  let totalMessages = 0;
  let stableMessages = 0;
  const rows: E3Result["sessions"] = [];

  for (const spec of sessions) {
    // request 1: everything is new — compresses at birth.
    const r1 = await engine.compress(spec.messages);
    const forms1 = r1.messages.map((m) => messageText(m));

    // requests 2..3: the client resends its ORIGINAL messages (its own copy);
    // the engine must re-forward the established send form byte-identically.
    let stable = true;
    let unstableMessages = 0;
    for (const req of [2, 3]) {
      const rn = await engine.compress(spec.messages);
      for (let i = 0; i < forms1.length; i++) {
        totalMessages++;
        if (messageText(rn.messages[i]) === forms1[i]!) {
          stableMessages++;
        } else {
          stable = false;
          unstableMessages++;
        }
      }
    }
    rows.push({ label: spec.label, stable, unstableMessages });
  }

  const stability = totalMessages === 0 ? 1 : stableMessages / totalMessages;
  return {
    stability,
    sessions: rows,
    totalMessages,
    stableMessages,
    target: { name: "resubmitted messages byte-identical", op: ">=", value: E3_TARGET_STABILITY, actual: stability, pass: stability >= E3_TARGET_STABILITY },
    pass: stability >= E3_TARGET_STABILITY,
  };
}

export function e3ToReport(r: E3Result, git: string): EvalReport {
  return {
    eval: "e3",
    version: process.env.npm_package_version ?? "0.1.0",
    at: new Date().toISOString(),
    git,
    target: r.target,
    pass: r.pass,
    detail: { totalMessages: r.totalMessages, stableMessages: r.stableMessages, sessions: r.sessions },
  };
}

export function e3Summary(r: E3Result): string {
  const bad = r.sessions.filter((s) => !s.stable);
  const lines = [`E3 KV-cache byte stability: ${pct(r.stability)} (target ${pct(E3_TARGET_STABILITY)}) ${r.pass ? "PASS" : "FAIL"}`];
  lines.push(`   ${r.stableMessages}/${r.totalMessages} resubmitted messages byte-identical across ${r.sessions.length} sessions × 3 requests`);
  for (const s of bad) lines.push(`   UNSTABLE: ${s.label} (${s.unstableMessages} messages)`);
  return lines.join("\n");
}

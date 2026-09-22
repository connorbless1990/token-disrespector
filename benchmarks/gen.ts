/**
 * Deterministic corpus generator (seeded PRNG).
 *
 * Produces realistic tool-output fixtures that double as the test corpus:
 * the same seed always yields the same files, so ratio claims are reproducible.
 *
 *   node benchmarks/gen.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "corpus");

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

const rng = mulberry32(20260921);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 1. JSON API results — 200 rows: repeated status payloads, one slow outlier,
//    a few error rows. (SmartCrusher-class target.)
// ---------------------------------------------------------------------------
{
  const services = ["auth", "billing", "search", "ingest", "notify"];
  const rows: object[] = [];
  for (let i = 0; i < 200; i++) {
    const svc = pick(services);
    const row: Record<string, unknown> = {
      id: `req_${(100000 + i).toString(16)}`,
      service: svc,
      method: pick(["GET", "GET", "GET", "POST", "PUT"]),
      path: `/${svc}/v2/${pick(["items", "users", "orders", "events"])}`,
      status: 200,
      duration_ms: Math.round(20 + rng() * 120),
      bytes: int(512, 8192),
      cached: rng() > 0.5,
      ts: `2026-09-21T10:${String(int(0, 59)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}Z`,
    };
    rows.push(row);
  }
  // duplicates (identical retry payloads)
  for (let i = 0; i < 40; i++) rows.push({ ...rows[int(0, 199)] });
  // out-of-range outliers
  for (let i = 0; i < 5; i++)
    rows.push({ id: `req_slow${i}`, service: "ingest", method: "POST", path: "/ingest/v2/batch", status: 200, duration_ms: int(9000, 25000), bytes: int(100000, 400000), cached: false, ts: "2026-09-21T10:59:59Z" });
  // error rows
  for (let i = 0; i < 6; i++)
    rows.push({ id: `req_err${i}`, service: pick(services), method: "POST", path: "/billing/v2/charge", status: pick([500, 502, 429]), error: pick(["upstream timeout", "charge declined", "rate limit exceeded", "connection refused"]), duration_ms: int(3000, 9000), bytes: 64, cached: false, ts: "2026-09-21T10:58:01Z" });
  const pretty = JSON.stringify({ generated: "2026-09-21T10:59:00Z", results: rows }, null, 2);
  writeFileSync(join(OUT, "json-api-results.json"), pretty);
}

// ---------------------------------------------------------------------------
// 2. Build/test log — ~1200 lines, mostly INFO, clustered test failures + FATAL.
// ---------------------------------------------------------------------------
{
  const lines: string[] = [];
  const t = (i: number) => `2026-09-21T10:${String(Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor((i % 3600) / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String((i * 137) % 1000).padStart(3, "0")}Z`;
  lines.push(`$ npm run build --workspaces`);
  lines.push(`> ctxroom@0.1.0 build`);
  lines.push("");
  for (let i = 0; i < 1200; i++) {
    if (i < 40) {
      lines.push(`${t(i)} INFO  [vite] ${pick(["transforming", "bundling", "minifying", "rendering"])} ${pick(["app", "core", "proxy", "cli"])} chunk ${int(1, 220)} (${int(5, 400)} kB)`);
    } else if (i < 300) {
      lines.push(`${t(i)} INFO  [tsc] checking workspace packages`);
    } else if (i < 900) {
      // test runner: mostly passing, a few clustered failures
      if (i % 97 === 0 && i > 500) {
        lines.push(`${t(i)} FAIL  tests/engine.test.ts > budget mode skips compressed zones`);
        lines.push(`${t(i)}   Error: expected 120_000 to be less than 120_000`);
        lines.push(`${t(i)}       at TestContext.assert (tests/engine.test.ts:88:11)`);
      } else {
        lines.push(`${t(i)} PASS  tests/${pick(["core", "proxy", "cli", "mcp"])}-${pick(["engine", "ccr", "router", "proxy"])} (${int(2, 90)}ms)`);
      }
    } else if (i < 1000) {
      lines.push(`${t(i)} WARN  [license] ${int(1, 9)} package(s) have deprecated licenses`);
    } else if (i < 1150) {
      lines.push(`${t(i)} INFO  [pack] ${pick(["tar", "sign", "verify"])} ${pick(["@ctxroom/core", "@ctxroom/proxy", "ctxroom"])} ${int(20, 300)} kB`);
    } else {
      lines.push(`${t(i)} FATAL [runner] out of memory: heap limit reached at ${int(20, 95)}%`);
      lines.push(`${t(i)}   FATAL detail: allocation of 512 MB failed for session registry LRU`);
      lines.push(`${t(i)}   Retrying with increased heap (NODE_OPTIONS=--max-old-space-size=8192)`);
    }
  }
  writeFileSync(join(OUT, "build-log.txt"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// 3. ripgrep-style search dump — ~180 matches across 45 files, long content.
// ---------------------------------------------------------------------------
{
  const dirs = ["packages/core/src", "packages/proxy/src", "packages/cli/src", "packages/mcp/src", "benchmarks", "e2e"];
  const files = [
    "engine.ts", "ccr.ts", "router.ts", "compress.ts", "config.ts", "estimate.ts",
    "livezone.ts", "server.ts", "routes.ts", "upstream.ts", "stats.ts", "index.ts",
    "doctor.ts", "copilot.ts", "mcpmerge.ts", "text.ts", "json.ts", "logs.ts",
  ];
  // A small set of long bodies repeated across files (real ripgrep dumps
  // re-hit the same import/call sites everywhere) + a few unique long lines.
  const bodies = [
    "    import { CcrStore, renderMarker, estimateTokens } from \"@ctxroom/core\"; // shared compression vocabulary",
    "    const result = await engine.compress(messages, { registry, ccr }).then((r) => { if (r.replaced > 0) stats.push(r); return r; });",
    "  if (out.length >= text.length) return null; // invariant: no growth — pass through when no safe saving",
    "    if (!this.prefixIndex.has(p)) await this.coldScan(); // cold-start index build for hash-prefix retrieval",
    "  const session = this.sessions.get(key) ?? { key, history: [] }; // per-conversation send-form memory",
    "    this.registry.record(messages, forwardTexts.map((t) => (t === null ? null : t))); // remember what we sent",
  ];
  const lines: string[] = [];
  for (let f = 0; f < 60; f++) {
    const file = `${pick(dirs)}/${pick(files)}`;
    const n = int(3, 10);
    for (let k = 0; k < n; k++) {
      const body = k % 4 === 3 ? `    const tail_${f}_${k} = compute(f, k, ${int(100, 999)}); // unique line` : pick(bodies);
      lines.push(`${file}:${int(5, 400)}:${body}`);
    }
  }
  writeFileSync(join(OUT, "ripgrep.txt"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// 4. Multi-file unified diff — 9 files, mixed context density.
// ---------------------------------------------------------------------------
{
  const parts: string[] = [];
  const names = [
    "packages/core/src/compress.ts", "packages/core/src/livezone.ts", "packages/core/src/ccr.ts",
    "packages/proxy/src/server.ts", "packages/cli/src/copilot.ts", "packages/mcp/src/index.ts",
    "packages/core/src/config.ts", "packages/core/src/estimate.ts", "packages/proxy/src/upstream.ts",
    "packages/cli/src/doctor.ts", "packages/core/src/compressors/json.ts", "packages/core/src/compressors/logs.ts",
    "packages/core/src/compressors/diff.ts", "benchmarks/gen.ts", "README.md",
  ];
  const ctxLines = [
    "  const x = resolve(i);",
    "  return out;",
    "  }",
    "  for (const item of arr) {",
    "  if (n > 0) continue;",
    "  // helper",
    "  totals.push(v);",
    "  if (a && b) merge(a, b);",
    "  const k = key + suffix;",
    "  await store(value);",
  ];
  for (const n of names) {
    parts.push(`diff --git a/${n} b/${n}`);
    parts.push(`--- a/${n}`);
    parts.push(`+++ b/${n}`);
    let ln = 1;
    const hunks = int(2, 5);
    for (let h = 0; h < hunks; h++) {
      const ctx = int(8, 24); // heavy unchanged context — what the crusher collapses
      const ctxEnd = int(1, 3);
      parts.push(`@@ -${ln + h * 30},${ctx + ctxEnd + 2} +${ln + h * 30},${ctx + ctxEnd + 4} @@`);
      for (let c = 0; c < ctx; c++) parts.push(`   ${pick(ctxLines)}${int(1, 99)}`);
      parts.push(`-  ${pick(["const old = legacy(i);", "return null;", "  foo()"])}`);
      parts.push(`+  ${pick(["const fresh = compress(i);", "return result;", "  bar()"])}`);
      parts.push(`+  ${pick(["// new: kv-cache stable", "const t = Date.now();", "  check()"])}`);
      for (let c = 0; c < ctxEnd; c++) parts.push(`   ${pick(ctxLines)}${int(1, 99)}`);
      ln += ctx + ctxEnd + 4;
    }
  }
  writeFileSync(join(OUT, "multi.diff"), parts.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// 5. HTML page — nav/script/style heavy.
// ---------------------------------------------------------------------------
{
  const nav = Array.from({ length: 30 }, (_, i) => `<a href="/docs/p${i}">Section ${i}</a>`).join("");
  const table = Array.from({ length: 40 }, (_, i) => `<tr><td>row-${i}</td><td>${int(1, 999)}</td></tr>`).join("");
  const html = `<!DOCTYPE html>
<html><head><title>Release notes — internal</title>
<script>window.__cfg={v:"1.4.2",flags:["beta"],"a":1234};console.log("boot");</script>
<style>body{font:14px sans-serif}.nav{display:flex}.x{color:red}.y{margin:0}</style>
</head><body>
<nav class="main">${nav}</nav>
<header><div class="logo">Co</div><span>menu</span><span>search</span><span>profile</span></header>
<main>
<h1>Release 1.4.2</h1>
<p>This release improves compression routing for JSON tool outputs. The content router now detects search-result shapes before logs, fixing a misroute where grep output with timestamps was treated as build logs.</p>
<h2>Changes</h2>
${table}
<h2>Notes</h2>
<p>Upstream compatibility verified against the Copilot API chat/completions and responses routes. Enterprise deployments on GHE resolve the API base from GITHUB_COPILOT_ENTERPRISE_URL. The loopback proxy binds 127.0.0.1 only.</p>
</main>
<footer>built ${int(1, 9)}m ago · rev ${Array.from({ length: 12 }, () => "0123456789abcdef"[int(0, 15)]).join("")}</footer>
</body></html>`;
  writeFileSync(join(OUT, "page.html"), html);
}

// ---------------------------------------------------------------------------
// 6. YAML config — comment/blank heavy.
// ---------------------------------------------------------------------------
{
  const lines: string[] = ["# proxy configuration", "# generated by ctxroom doctor", ""];
  for (let i = 0; i < 60; i++) {
    lines.push(`  # option ${i}`);
    lines.push(`  port: ${8000 + i}`);
    lines.push("");
  }
  lines.push("upstream:");
  lines.push("  api_url: https://api.githubcopilot.com");
  lines.push("  enterprise_domain: null");
  writeFileSync(join(OUT, "config.yaml"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// 7. CSV table.
// ---------------------------------------------------------------------------
{
  const lines = ["request_id,service,endpoint,status,duration_ms,bytes"];
  for (let i = 0; i < 150; i++) {
    lines.push(`req_${1000 + i},${pick(["auth", "billing", "search"])},/v2/${pick(["items", "users"])},${pick([200, 200, 200, 201, 404, 500])},${int(5, 900)},${int(128, 65536)}`);
  }
  writeFileSync(join(OUT, "metrics.csv"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// 8. Prose — long design document (extractive target).
// ---------------------------------------------------------------------------
{
  const paras: string[] = [];
  for (let i = 0; i < 28; i++) {
    const flavor = pick([
      `The decision to keep compression deterministic first follows from the deployment constraints: the model runs locally on a 64 GB machine, and every auxiliary summarization call is a real cost in seconds and memory. Paragraph ${i} elaborates on the tradeoff between ratio quality and latency, noting that structured content dominates real agent traffic.`,
      `We considered a trained text compressor, as some open projects ship, but the air-gapped enterprise requirement rules out model downloads. The extractive approach — keeping first and last paragraphs plus high-entropy lines — is conservative but predictable, and every rule can be audited in review.`,
      `In practice, a single session of a coding agent produces roughly 40% JSON tool outputs, 20% code, 15% logs, 10% search results, and the remainder prose. The router order is therefore tuned so that the structural compressors see their shapes before the text fallback claims them.`,
      `The KV-cache argument is the subtle one. The provider caches the prompt prefix; if we change byte k, reuse dies from k onward. Since the client resends its own copy of the history on every turn, the proxy must remember what it forwarded and forward the same bytes again. This send-form registry is the mechanism that makes compression permanent rather than a one-turn blip.`,
      `Safety invariants are enforced at the engine boundary: system prompts are never touched, blocks under the minimum word count pass through, no replacement may grow its source, and any failure anywhere in the pipeline degrades to passthrough. The tests assert each invariant against the corpus.`,
    ]);
    // Only some paragraphs carry references/numbers; the rest is pure prose,
    // so the extractive compressor has something to drop.
    const tail = rng() < 0.3 ? ` Additional context sentence ${i} carries a reference to packages/core/src/compress.ts and the value ${int(100, 9999)} for reproducibility.` : "";
    paras.push(flavor + tail);
  }
  writeFileSync(join(OUT, "prose.md"), paras.join("\n\n") + "\n");
}

// ---------------------------------------------------------------------------
// 9. TypeScript source file (code compressor target).
// ---------------------------------------------------------------------------
{
  const fn = (name: string, bodyLines: number): string => {
    const body: string[] = [`export function ${name}(input: unknown, index: number): number {`];
    for (let i = 0; i < bodyLines; i++) {
      body.push(pick([
        `  const a = readValue(input, ${i});`,
        `  if (a === null) return ${i};`,
        `  const b = transform(a, index);`,
        `  totals[${i % 7}] += b;`,
        `  if (b > limit) flags.push(index);`,
      ]));
    }
    // A realistic run of identical boilerplate lines (warm-up loop over a
    // constant) — the consecutive-duplicate rule's real target.
    for (let i = 0; i < 18; i++) body.push(`  rows.push(EMPTY_ROW);`);
    body.push(`  return totals.reduce((s, v) => s + v, 0);`, `}`);
    return body.join("\n");
  };
  const src = `import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EngineMessage } from "./types.ts";

// Internal: deterministic helpers shared by the compressors.
// These functions are pure and allocation-light by design.

export interface Bucket {
  total: number;
  count: number;
}

class Aggregate {
  private buckets = new Map<string, Bucket>();

  add(key: string, value: number): void {
    const b = this.buckets.get(key) ?? { total: 0, count: 0 };
    b.total += value;
    b.count += 1;
    this.buckets.set(key, b);
  }

  snapshot(): Record<string, Bucket> {
    return Object.fromEntries(this.buckets);
  }
}

${fn("bucketize", 22)}

${fn("normalize", 18)}

${fn("quantize", 16)}

export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export const ROOT = join(__dirname, "..");`;
  writeFileSync(join(OUT, "code.ts"), src);
}

// ---------------------------------------------------------------------------
// 10. Mixed session — a realistic copilot-style messages array (engine e2e).
// ---------------------------------------------------------------------------
{
  const fs = {
    json: readText(join(OUT, "json-api-results.json")),
    logs: readText(join(OUT, "build-log.txt")),
    search: readText(join(OUT, "ripgrep.txt")),
  };
  const messages = [
    {
      role: "system",
      content:
        "You are an expert coding agent working in the user's repository. Use the available tools to inspect and modify code. Be precise, and verify changes with the project's tooling. Never expose secrets or credentials in your output.",
    },
    { role: "user", content: "The ingest service is timing out in the build. Look at packages/core/src/compress.ts and the build log, and tell me what is failing." },
    {
      role: "assistant",
      content: "I'll start by looking at the recent API results and the build output.",
    },
    { role: "tool", tool_call_id: "call_1", content: fs.json },
    {
      role: "assistant",
      content: "The API results show a cluster of slow ingest calls. Let me check the build log next.",
    },
    { role: "tool", tool_call_id: "call_2", content: fs.logs },
    {
      role: "user",
      content: "Also grep for references to packages/core/src/compress.ts while you're at it.",
    },
    { role: "tool", tool_call_id: "call_3", content: fs.search },
  ] as const;
  writeFileSync(join(OUT, "session.json"), JSON.stringify({ messages: messages as unknown as object[] }, null, 2));
}

function readText(p: string): string {
  return readFileSync(p, "utf8");
}

console.log(`corpus written to ${OUT}`);

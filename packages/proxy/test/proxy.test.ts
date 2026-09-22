/**
 * Proxy integration tests — real ephemeral ports, real loopback sockets,
 * mock upstream = a tiny node:http server that captures the exact bytes it
 * receives (the only way to prove what the provider sees).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcrStore, Engine, resolveEngineConfig, type EngineConfig, type EngineMessage } from "@ctxroom/core";
import { startProxy, StatsWriter, type RunningProxy } from "../src/index.ts";

const corpus = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../benchmarks/corpus/${name}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------------------
// Mock upstream
// ---------------------------------------------------------------------------
export interface CapturedRequest {
  method: string;
  path: string; // pathname + search
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

function startMockUpstream(): Promise<{
  server: Server;
  port: number;
  captured: CapturedRequest[];
  close(): Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({ method: req.method ?? "", path: req.url ?? "/", rawBody: Buffer.concat(chunks), headers: req.headers });
      const body = Buffer.concat(chunks).toString("utf8");
      const wantsSse = body.includes('"stream":true') || body.includes('"stream": true');
      if (wantsSse) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunksSse = [
          'data: {"id":"1","delta":"Hel"}\n\n',
          'data: {"id":"1","delta":"lo"}\n\n',
          'data: [DONE]\n\n',
        ];
        let i = 0;
        const timer = setInterval(() => {
          if (i < chunksSse.length) {
            res.write(chunksSse[i++]);
          } else {
            clearInterval(timer);
            res.end();
          }
        }, 25);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url, upstream: "mock" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = a && typeof a === "object" ? a.port : 0;
      resolve({ server, port, captured, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ---------------------------------------------------------------------------
// Test proxy harness
// ---------------------------------------------------------------------------
interface Harness {
  proxy: RunningProxy;
  upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  home: string;
  cleanup(): Promise<void>;
}

async function makeHarness(config: Partial<EngineConfig> = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-proxy-"));
  const cfg = resolveEngineConfig({ ccr: { enabled: true, dir: join(home, "cache") }, ...config }, {} as NodeJS.ProcessEnv);
  const engine = new Engine(cfg, { ccr: new CcrStore({ dir: join(home, "cache") }) });
  const stats = new StatsWriter(join(home, "stats"), home);
  const upstream = await startMockUpstream();
  const proxy = await startProxy({
    port: 0,
    env: {},
    upstreamBase: `http://127.0.0.1:${upstream.port}`,
    engine,
    stats,
  });
  return {
    proxy,
    upstream,
    home,
    cleanup: async () => {
      await proxy.close();
      await upstream.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 3000, stepMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Find a stats row in the harness home matching the predicate (or null). */
async function findStatsRow(h: Harness, match: (row: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
  const files = await readdir(join(h.home, "stats")).catch(() => [] as string[]);
  for (const f of files) {
    const lines = (await readFile(join(h.home, "stats", f), "utf8").catch(() => "")).split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const s = JSON.parse(l) as Record<string, unknown>;
        if (match(s)) return s;
      } catch {
        /* skip malformed */
      }
    }
  }
  return null;
}

const systemMsg: EngineMessage = { role: "system", content: "You are a test harness system prompt with plenty of words to matter for the test and nothing sensitive, just filler text repeated enough times to be counted as a real system prompt body for the proxy tests." };
const smallUser: EngineMessage = { role: "user", content: "What failed?" };
const assistantMsg: EngineMessage = { role: "assistant", content: "Let me look." };
const bigJson: EngineMessage = { role: "tool", tool_call_id: "call_1", content: corpus("json-api-results.json") };

const client = (port: number, path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.headers,
    body: opts.body,
  });

// ---------------------------------------------------------------------------

test("compresses /chat/completions; upstream sees the replacement, client sees the response", async () => {
  const h = await makeHarness();
  try {
    const body = JSON.stringify({ model: "test-model", messages: [systemMsg, smallUser, assistantMsg, bigJson] });
    const res = await client(h.proxy.port, "/chat/completions", { body });
    assert.equal(res.status, 200);
    const resJson = (await res.json()) as { ok: boolean; path: string };
    assert.equal(resJson.ok, true);

    // The mock upstream received a compressed tool result.
    const upstreamBody = JSON.parse(h.upstream.captured[0].rawBody.toString("utf8")) as { messages: EngineMessage[] };
    const got = upstreamBody.messages[3].content as string;
    assert.ok(got.includes("[ctxroom:compressed"), "upstream must receive the CCR-marked replacement");
    assert.ok(got.length < (bigJson.content as string).length, "upstream bytes must be smaller");
    // The small user turn passes through (I4).
    assert.equal(upstreamBody.messages[1].content, smallUser.content);
  } finally {
    await h.cleanup();
  }
});

test("non-LLM paths are byte-transparent passthrough (exact bytes, method, query)", async () => {
  const h = await makeHarness();
  try {
    const odd = Buffer.from('{"custom":"ß∆✓","n":', "utf8"); // not even valid JSON — must pass through raw
    const res = await fetch(`http://127.0.0.1:${h.proxy.port}/v2/feedback`, { method: "POST", body: odd });
    await res.text();
    assert.deepEqual(h.upstream.captured[0].rawBody, odd, "passthrough body must be byte-identical");
    assert.equal(h.upstream.captured[0].path, "/v2/feedback");

    const res2 = await fetch(`http://127.0.0.1:${h.proxy.port}/models?limit=5`);
    await res2.text();
    assert.equal(h.upstream.captured[1].path, "/models?limit=5");
    assert.equal(h.upstream.captured[1].method, "GET");
  } finally {
    await h.cleanup();
  }
});

test("SSE responses stream back intact and in order", async () => {
  const h = await makeHarness();
  try {
    const body = JSON.stringify({ model: "m", stream: true, messages: [smallUser] });
    const res = await client(h.proxy.port, "/chat/completions", { body });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.ok(res.body);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let got = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += decoder.decode(value, { stream: true });
    }
    assert.equal(got, 'data: {"id":"1","delta":"Hel"}\n\ndata: {"id":"1","delta":"lo"}\n\ndata: [DONE]\n\n');
  } finally {
    await h.cleanup();
  }
});

test("/p/<project>/ prefix is stripped for forwarding and attributed in stats", async () => {
  const h = await makeHarness();
  try {
    const body = JSON.stringify({ model: "m", messages: [smallUser] });
    await (await client(h.proxy.port, "/p/demo-project/v1/chat/completions", { body })).text();
    assert.equal(h.upstream.captured[0].path, "/v1/chat/completions", "/p/ must be stripped before forwarding");

    const row = await waitFor(() => findStatsRow(h, (s) => s.project === "demo-project"));
    assert.equal(row.project, "demo-project");
    assert.equal(row.path, "/v1/chat/completions");
  } finally {
    await h.cleanup();
  }
});

test("Authorization and custom headers are forwarded verbatim", async () => {
  const h = await makeHarness();
  try {
    await (
      await client(h.proxy.port, "/models", {
        headers: { authorization: "Bearer tok-abc-123", "x-corp-marker": "keep-me", accept: "application/json" },
      })
    ).text();
    assert.equal(h.upstream.captured[0].headers.authorization, "Bearer tok-abc-123");
    assert.equal(h.upstream.captured[0].headers["x-corp-marker"], "keep-me");
    assert.equal(h.upstream.captured[0].headers.accept, "application/json");
  } finally {
    await h.cleanup();
  }
});

test("stats row written per request with the spec fields", async () => {
  const h = await makeHarness();
  try {
    const body = JSON.stringify({ model: "stat-model", messages: [systemMsg, smallUser, bigJson] });
    await (await client(h.proxy.port, "/chat/completions", { body })).text();
    const row = await waitFor(() => findStatsRow(h, (s) => s.model === "stat-model"));
    for (const field of ["ts", "project", "model", "path", "tokensBefore", "tokensAfter", "tokensSaved", "transforms", "ccrStored", "ms"]) {
      assert.ok(field in row, `stats row missing ${field}`);
    }
    assert.equal(row.project, "default");
    assert.equal(row.path, "/chat/completions");
    assert.ok((row.transforms as string[]).some((t) => t.startsWith("compressor:")), "must record the compression transform");
    assert.equal(row.ccrStored, 1, "must record the CCR store");
    assert.ok((row.tokensBefore as number) > (row.tokensAfter as number), "must show savings");
  } finally {
    await h.cleanup();
  }
});

test("GET /health reports upstream, ccr, sessions, version", async () => {
  const h = await makeHarness();
  try {
    const res = await client(h.proxy.port, "/health");
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.ok, true);
    assert.equal(j.version, "0.1.0");
    assert.equal(j.upstreamBase, `http://127.0.0.1:${h.upstream.port}`);
    assert.equal(j.ccr, true);
    assert.equal(typeof j.sessions, "number");
    assert.equal(j.sessions, 0);
  } finally {
    await h.cleanup();
  }
});

test("KV-cache stability through the proxy: client resends originals, upstream gets identical bytes", async () => {
  const h = await makeHarness();
  try {
    const req1 = { model: "m", messages: [systemMsg, smallUser, assistantMsg, bigJson] };
    await (await client(h.proxy.port, "/chat/completions", { body: JSON.stringify(req1) })).text();
    const upstream1 = JSON.parse(h.upstream.captured[0].rawBody.toString("utf8")) as { messages: EngineMessage[] };
    const forwarded1 = upstream1.messages[3].content as string;
    assert.ok(forwarded1.includes("[ctxroom:compressed"), "request 1 compresses at birth");

    // The client keeps its OWN copy and resends the ORIGINAL big content.
    const req2 = { model: "m", messages: [systemMsg, smallUser, assistantMsg, bigJson, { role: "user", content: "Now the log." }] };
    await (await client(h.proxy.port, "/chat/completions", { body: JSON.stringify(req2) })).text();
    const upstream2 = JSON.parse(h.upstream.captured[1].rawBody.toString("utf8")) as { messages: EngineMessage[] };
    const forwarded2 = upstream2.messages[3].content as string;

    assert.equal(forwarded2, forwarded1, "the provider's prefix must be byte-identical across requests");
    assert.notEqual(forwarded1, bigJson.content as string, "and it is the compressed form, not the original");
  } finally {
    await h.cleanup();
  }
});

test("/responses: message items compressed, non-message items untouched", async () => {
  const h = await makeHarness();
  try {
    const fnCall = { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' };
    const body = JSON.stringify({
      model: "m",
      input: [
        "short user turn",
        { type: "message", role: "tool", content: corpus("build-log.txt") },
        fnCall,
      ],
    });
    await (await client(h.proxy.port, "/responses", { body })).text();
    const upstreamBody = JSON.parse(h.upstream.captured[0].rawBody.toString("utf8")) as { input: Record<string, unknown>[] };
    const input = upstreamBody.input;
    assert.equal(input.length, 3);
    assert.equal(input[0], "short user turn", "small string item untouched");
    assert.ok((input[1].content as string).includes("[ctxroom:compressed"), "tool message compressed");
    assert.ok((input[1].content as string).length < corpus("build-log.txt").length);
    assert.deepEqual(input[2], fnCall, "function_call item must be byte-identical");
  } finally {
    await h.cleanup();
  }
});

test("upstream failure surfaces as 502 JSON, never a crash", async () => {
  const upstream = await startMockUpstream();
  await upstream.close(); // kill the upstream before starting the proxy
  const home = mkdtempSync(join(tmpdir(), "ctxroom-proxy-502-"));
  const cfg = resolveEngineConfig({ ccr: { enabled: true, dir: join(home, "cache") } }, {} as NodeJS.ProcessEnv);
  const engine = new Engine(cfg, { ccr: new CcrStore({ dir: join(home, "cache") }) });
  const stats = new StatsWriter(join(home, "stats"), home);
  const proxy = await startProxy({ port: 0, env: {}, upstreamBase: `http://127.0.0.1:${upstream.port}`, engine, stats });
  try {
    const res = await client(proxy.port, "/chat/completions", { body: JSON.stringify({ messages: [smallUser] }) });
    assert.equal(res.status, 502);
    const j = (await res.json()) as { error: { message: string } };
    assert.match(j.error.message, /upstream unreachable/);
  } finally {
    await proxy.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

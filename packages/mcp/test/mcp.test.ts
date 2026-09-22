/**
 * MCP server tests: spawn the real stdio server, drive the JSON-RPC
 * handshake, and verify retrieve returns byte-exact originals (I9) plus
 * the cross-process freshness fallback (entries stored by another process
 * after our cold scan).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcrStore } from "@ctxroom/core";
import { dispatch, TOOLS } from "../src/index.ts";

const MCP_SRC = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const ORIGINAL = "The exact original bytes.\nLine two with unicode 線 émoji 🎉\nLine three.\n" + "filler ".repeat(500);

// ---------------------------------------------------------------------------
// Spawned-server harness
// ---------------------------------------------------------------------------
class Client {
  proc: ChildProcess;
  private buffer = "";
  private waiters: ((line: string | null) => void)[] = [];
  exited: Promise<{ code: number | null }>;

  constructor(env: Record<string, string | undefined>) {
    this.proc = spawn(process.execPath, [MCP_SRC], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.buffer = line + "\n" + this.buffer; // keep last line if no waiter (should not happen)
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code) => resolve({ code }));
      this.proc.on("error", () => resolve({ code: null }));
    });
  }

  send(line: string): void {
    this.proc.stdin!.write(line + "\n");
  }

  async nextLine(timeoutMs = 5000): Promise<string> {
    if (this.buffer) {
      const nl = this.buffer.indexOf("\n");
      return nl >= 0 ? this.buffer.slice(0, nl) : (await this.nextLine()) ;
    }
    return await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mcp client: timed out waiting for a line")), timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(t);
        resolve(line as string);
      });
    });
  }

  async rpc<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.send(JSON.stringify({ jsonrpc: "2.0", id: Date.now() + Math.random(), method, params }));
    const line = await this.nextLine();
    const msg = JSON.parse(line) as { id?: unknown; result?: T; error?: { code: number; message: string } };
    if (msg.error) throw new Error(`rpc ${method} error ${msg.error.code}: ${msg.error.message}`);
    return msg.result as T;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async close(): Promise<number> {
    this.proc.stdin!.end();
    const { code } = await this.exited;
    return code ?? -1;
  }
}

async function makeHome(): Promise<{ home: string; store: CcrStore }> {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  await mkdir(join(home, "cache"), { recursive: true });
  await mkdir(join(home, "stats"), { recursive: true });
  return { home, store: new CcrStore({ dir: join(home, "cache") }) };
}

// ---------------------------------------------------------------------------

test("handshake: initialize → initialized → tools/list", async () => {
  const { home, store } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  try {
    const init = (await client.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } })) as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string };
    };
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.ok(init.capabilities.tools, "must advertise tools capability");
    assert.equal(init.serverInfo.name, "ctxroom");

    await client.notify("notifications/initialized");

    const list = (await client.rpc("tools/list")) as {
      tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
    };
    const names = list.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ctxroom_retrieve", "ctxroom_stats"]);
    const retrieve = list.tools.find((t) => t.name === "ctxroom_retrieve")!;
    assert.deepEqual((retrieve.inputSchema as { required?: string[] }).required, ["hash"]);
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("retrieve returns the exact original bytes (I9)", async () => {
  const { home, store } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  try {
    const hash = await store.store(ORIGINAL);
    const res = (await client.rpc("tools/call", { name: "ctxroom_retrieve", arguments: { hash: hash! } })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    assert.equal(res.isError, undefined, "must not be an error");
    assert.equal(res.content.length, 1, "no truncation note for small originals");
    assert.equal(res.content[0].text, ORIGINAL, "I9: byte-exact round trip");
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("retrieve windows with truncation note and offset continuation", async () => {
  const { home, store } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  try {
    const big = "B".repeat(50_000);
    const hash = await store.store(big);
    const first = (await client.rpc("tools/call", { name: "ctxroom_retrieve", arguments: { hash: hash!, maxChars: 10_000 } })) as {
      content: { type: string; text: string }[];
    };
    assert.equal(first.content[0].text, "B".repeat(10_000));
    assert.equal(first.content.length, 2, "truncation note present");
    assert.match(first.content[1].text, /offset 10000/);

    const rest = (await client.rpc("tools/call", { name: "ctxroom_retrieve", arguments: { hash: hash!, offset: 10_000, maxChars: 50_000 } })) as {
      content: { type: string; text: string }[];
    };
    assert.equal(rest.content.length, 1, "final window is not truncated");
    assert.equal(first.content[0].text + rest.content[0].text, big, "continuation must complete the original");
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("retrieve of an unknown hash is a tool error, not a crash", async () => {
  const { home } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  try {
    const res = (await client.rpc("tools/call", { name: "ctxroom_retrieve", arguments: { hash: "deadbeef0000" } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no original found/);
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("ctxroom_stats reports cache size and per-day totals", async () => {
  const { home } = await makeHome();
  await new CcrStore({ dir: join(home, "cache") }).store("one");
  await new CcrStore({ dir: join(home, "cache") }).store("two");
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(
    join(home, "stats", `${day}.jsonl`),
    JSON.stringify({ ts: `${day}T10:00:00.000Z`, project: "p", model: "m", path: "/chat/completions", tokensBefore: 1000, tokensAfter: 400, tokensSaved: 600, transforms: [], ccrStored: 1, ms: 5 }) +
      "\n" +
      JSON.stringify({ ts: `${day}T11:00:00.000Z`, project: "p", model: "m", path: "/chat/completions", tokensBefore: 2000, tokensAfter: 1500, tokensSaved: 500, transforms: [], ccrStored: 0, ms: 5 }) +
      "\n",
    "utf8"
  );
  const client = new Client({ CTXROOM_HOME: home });
  try {
    const res = (await client.rpc("tools/call", { name: "ctxroom_stats", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /2 entries/);
    assert.match(res.content[0].text, /Proxied requests: 2/);
    assert.match(res.content[0].text, /3000 → 1900/);
    assert.match(res.content[0].text, /saved 1100/);
    assert.match(res.content[0].text, new RegExp(day));
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("protocol errors: parse error, invalid request, unknown method, unknown tool", async () => {
  const { home } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  try {
    await client.notify("initialize", {}); // prime the handshake so the server is "ready"
    client.send("not json at all");
    const parseErr = JSON.parse(await client.nextLine()) as { error: { code: number } };
    assert.equal(parseErr.error.code, -32700);

    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1 })); // no method
    const invalid = JSON.parse(await client.nextLine()) as { error: { code: number } };
    assert.equal(invalid.error.code, -32600);

    client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "no/such/method" }));
    const notFound = JSON.parse(await client.nextLine()) as { error: { code: number } };
    assert.equal(notFound.error.code, -32601);

    client.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }));
    const badTool = JSON.parse(await client.nextLine()) as { error: { code: number } };
    assert.equal(badTool.error.code, -32602);
  } finally {
    await client.close();
    await rmSync(home, { recursive: true, force: true });
  }
});

test("stdin EOF exits cleanly with code 0", async () => {
  const { home } = await makeHome();
  const client = new Client({ CTXROOM_HOME: home });
  const code = await client.close();
  assert.equal(code, 0);
  await rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// In-process dispatch: cross-process freshness fallback
// ---------------------------------------------------------------------------

test("dispatch: entries stored after the shared store's cold scan still resolve", async () => {
  const { home, store } = await makeHome();
  const prevHome = process.env.CTXROOM_HOME;
  process.env.CTXROOM_HOME = home;
  try {
    // 1. Prime the shared store (cold scan happens on first lookup).
    const early = await store.store("early entry, stored before the server would cold-scan");
    await dispatch({ method: "tools/call", params: { name: "ctxroom_retrieve", arguments: { hash: early } } });

    // 2. A NEW entry stored afterwards (what the proxy does all session).
    const late = await store.store("late entry, stored after the cold scan");

    const res = (await dispatch({ method: "tools/call", params: { name: "ctxroom_retrieve", arguments: { hash: late } } })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, "late entry, stored after the cold scan");
  } finally {
    process.env.CTXROOM_HOME = prevHome;
    await rmSync(home, { recursive: true, force: true });
  }
});

test("dispatch: tool specs match the wire contract", () => {
  const retrieve = TOOLS.find((t) => t.name === "ctxroom_retrieve")!;
  const stats = TOOLS.find((t) => t.name === "ctxroom_stats")!;
  assert.ok(retrieve.description.length > 0);
  assert.ok(stats.description.length > 0);
  assert.equal((retrieve.inputSchema as { type: string }).type, "object");
});

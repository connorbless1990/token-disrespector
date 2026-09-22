#!/usr/bin/env node
/**
 * @ctxroom/mcp — minimal MCP (Model Context Protocol) server over stdio.
 *
 * Hand-rolled JSON-RPC 2.0, newline-delimited (the MCP stdio transport).
 * Zero runtime dependencies. Exposes:
 *
 *   ctxroom_retrieve {hash, maxChars?, offset?}
 *     Exact original text for a compressed block (I9: byte-exact), with
 *     windowed continuation for large originals.
 *   ctxroom_stats {}
 *     CCR cache size + per-day token totals from the local stats JSONL.
 *
 * Home resolution: $CTXROOM_HOME, else ~/.ctxroom (same as the engine).
 * Exits cleanly on stdin EOF.
 */
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CcrStore, defaultHome } from "@ctxroom/core";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "ctxroom", version: "0.1.0" };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "ctxroom_retrieve",
    description:
      "Retrieve the exact original text of a block that ctxroom compressed. Pass the 12-hex hash from a [ctxroom:compressed …] marker in the conversation. Returns byte-exact content (windowed for large blocks).",
    inputSchema: {
      type: "object",
      properties: {
        hash: { type: "string", description: "The 12-hex CCR hash from the marker" },
        maxChars: { type: "number", description: "Maximum characters to return (default 20000)" },
        offset: { type: "number", description: "Character offset for continuation reads (default 0)" },
      },
      required: ["hash"],
      additionalProperties: false,
    },
  },
  {
    name: "ctxroom_stats",
    description:
      "ctxroom savings statistics: CCR cache size (entries/bytes) and per-day token totals (before/after/saved) from the local stats log.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// NOTE: `code` is a plain property — parameter properties (readonly in a
// constructor) are not erasable TS and break Node type stripping.
class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Dispatch one parsed JSON-RPC message. Returns the `result` payload, or
 * null for notifications (no response is written).
 */
export async function dispatch(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.method) {
    case "initialize": {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case "notifications/initialized":
      return null; // notification — no response
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
      switch (params.name) {
        case "ctxroom_retrieve":
          return handleRetrieve((params.arguments ?? {}) as Record<string, unknown>);
        case "ctxroom_stats":
          return handleStats();
        default:
          throw new JsonRpcError(-32602, `unknown tool: ${String(params.name)}`);
      }
    }
    default:
      throw new JsonRpcError(-32601, `Method not found: ${String(msg.method)}`);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 20_000;

let sharedStore: CcrStore | null = null;
function store(): CcrStore {
  // One instance per process: it cold-scans the cache dir on first use.
  return (sharedStore ??= new CcrStore());
}

async function retrieve(ref: string, options: { maxChars?: number; offset?: number }) {
  const result = await store().retrieve(ref, options);
  if (result) return result;
  // A long-lived MCP process cold-scans only once, but the PROXY (a separate
  // process) keeps storing new entries for the whole session. A fresh
  // instance re-scans, so freshly stored originals resolve across processes.
  return new CcrStore().retrieve(ref, options);
}

async function handleRetrieve(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hash = typeof args.hash === "string" ? args.hash : "";
  if (!hash) {
    return { content: [{ type: "text", text: "ctxroom_retrieve: missing required argument `hash`." }], isError: true };
  }
  const maxChars = Number.isFinite(args.maxChars as number) ? (args.maxChars as number) : DEFAULT_MAX_CHARS;
  const offset = Number.isFinite(args.offset as number) ? (args.offset as number) : 0;
  const result = await retrieve(hash, { maxChars, offset });
  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `ctxroom: no original found for "${hash}" (TTL expired, evicted, or a different CTXROOM_HOME?).`,
        },
      ],
      isError: true,
    };
  }
  const content: Record<string, unknown>[] = [{ type: "text", text: result.text }];
  if (result.truncated) {
    const nextOffset = result.offset + result.text.length;
    content.push({
      type: "text",
      text: `[ctxroom: showing chars ${result.offset}..${nextOffset} of ${result.totalChars}; call ctxroom_retrieve with offset ${nextOffset} for the remainder.]`,
    });
  }
  return { content };
}

async function handleStats(): Promise<Record<string, unknown>> {
  const cache = await store().stats();
  const home = defaultHome();
  const statsDir = path.join(home, "stats");
  const days = new Map<string, { requests: number; before: number; after: number; saved: number }>();
  let requests = 0;
  let before = 0;
  let after = 0;
  let saved = 0;
  const files = (await readdir(statsDir).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const raw = await readFile(path.join(statsDir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Record<string, unknown>;
        const day = String(s.ts ?? f).slice(0, 10);
        const d = days.get(day) ?? { requests: 0, before: 0, after: 0, saved: 0 };
        d.requests++;
        d.before += Number(s.tokensBefore) || 0;
        d.after += Number(s.tokensAfter) || 0;
        d.saved += Number(s.tokensSaved) || 0;
        days.set(day, d);
        requests++;
        before += Number(s.tokensBefore) || 0;
        after += Number(s.tokensAfter) || 0;
        saved += Number(s.tokensSaved) || 0;
      } catch {
        /* skip malformed */
      }
    }
  }
  const lines = [
    `ctxroom stats (home: ${home})`,
    `CCR cache: ${cache.entries} entr${cache.entries === 1 ? "y" : "ies"}, ${(cache.bytes / 1024).toFixed(1)} KiB`,
    `Proxied requests: ${requests} (tokens ${before} → ${after}, saved ${saved}${before > 0 ? `, ${((saved / before) * 100).toFixed(1)}%` : ""})`,
  ];
  for (const [day, d] of [...days.entries()].reverse()) {
    lines.push(`  ${day}: ${d.requests} reqs, ${d.before} → ${d.after} tok, saved ${d.saved}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited)
// ---------------------------------------------------------------------------

function writeMessage(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function writeResult(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// Deliberately lenient handshake: this v1 server answers tools/list and
// tools/call even before `notifications/initialized` arrives. A strict host
// (which always initializes first) works fine against it; a host that skips
// the handshake also gets working tools. Responses to requests are otherwise
// strictly one-line JSON-RPC per the 2024-11-05 stdio transport.
export function startServer(): void {
  let buffer = "";
  let pending: Promise<void> = Promise.resolve();

  const queue = (work: () => Promise<void>): void => {
    pending = pending.then(work, work); // keep the chain alive even on failure
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      queue(() => handleLine(line));
    }
  });
  process.stdin.on("end", () => {
    queue(async () => {
      // flush any in-flight responses, then exit cleanly
    });
    pending.finally(() => process.exit(0));
  });
  process.stdin.on("close", () => process.exit(0));
  process.stdin.resume();
}

async function handleLine(line: string): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    writeError(null, -32600, "Invalid Request");
    return;
  }
  const record = msg as Record<string, unknown>;
  if (typeof record.method !== "string") {
    writeError(record.id ?? null, -32600, "Invalid Request");
    return;
  }
  const id = record.id ?? null;
  const isNotification = record.id === undefined;
  try {
    const result = await dispatch(record);
    if (isNotification) return; // e.g. notifications/initialized: no response
    writeResult(id, result);
  } catch (e) {
    if (!isNotification) {
      const err = e as { code?: number; message?: string };
      writeError(id, err instanceof JsonRpcError ? err.code : -32603, err.message ?? String(e));
    }
  }
}

// Auto-run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

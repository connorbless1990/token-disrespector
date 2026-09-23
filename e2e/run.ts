/**
 * e2e — mock-Copilot end-to-end run.
 *
 *   mock upstream (records exact bytes) ◀── proxy (engine + registry) ◀── mock copilot client
 *
 * Replays a realistic 3-request session from benchmarks/corpus/session.json:
 *   request 1 — a big JSON tool result is compressed at birth
 *   request 2 — the client resends the ORIGINALS; the upstream must receive
 *               the SAME replacement bytes for that message (the KV-cache
 *               stability proof — identical re-forwarded bytes)
 *   request 3 — budget mode: the compressed message stays frozen (identical
 *               bytes again) while the newly-arrived big tool results compress
 *
 * `npm run e2e` → exit 0 only when every assertion PASSes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcrStore, type EngineMessage } from "@ctxroom/core";
import { StatsWriter, startProxy } from "@ctxroom/proxy";

// ---------------------------------------------------------------------------
// mock upstream: records every raw request
// ---------------------------------------------------------------------------
interface Captured {
  method: string;
  path: string;
  rawBody: Buffer;
}

function startMockUpstream(): Promise<{ server: Server; port: number; captured: Captured[]; close(): Promise<void> }> {
  const captured: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      captured.push({ method: req.method ?? "", path: req.url ?? "/", rawBody });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `mock-${captured.length}`, object: "chat.completion", model: "mock-model" }));
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

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function contentOf(body: Buffer, index: number): string {
  const parsed = JSON.parse(body.toString("utf8")) as { messages: EngineMessage[] };
  const c = parsed.messages[index]?.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

async function main(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-e2e-"));
  const session = JSON.parse(
    readFileSync(fileURLToPath(new URL("../benchmarks/corpus/session.json", import.meta.url)), "utf8")
  ) as { messages: EngineMessage[] };

  return (await run({ home, session: session.messages })).code;
}

async function run(args: { home: string; session: EngineMessage[] }): Promise<{ code: number }> {
  const { home, session } = args;
  const upstream = await startMockUpstream();
  const proxy = await startProxy({
    port: 0,
    env: {},
    upstreamBase: `http://127.0.0.1:${upstream.port}`,
    config: {
      ccr: { enabled: true, dir: join(home, "cache") },
      // budget mode for the whole session: a small ceiling keeps every
      // request "over budget", which is the regime request 3 exercises.
      budget: { enabled: true, tokenBudget: 5_000 },
    },
    stats: new StatsWriter(join(home, "stats"), home),
  });

  try {
    const clientUrl = (path: string) => `http://127.0.0.1:${proxy.port}${path}`;
    const client = async (messages: EngineMessage[]) =>
      fetch(clientUrl("/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer e2e-token" },
        body: JSON.stringify({ model: "mock-model", messages }),
      });

    const originalJson = session[3].content as string; // the big JSON tool result

    // ---- request 1: system + user + assistant + big JSON tool result
    console.log("request 1: tool result arrives (live zone)");
    await client(session.slice(0, 4));
    const r1Body = upstream.captured[0].rawBody;
    const r1Json = contentOf(r1Body, 3);
    check("R1: big JSON tool result compressed at birth", r1Json.includes("[ctxroom:compressed") && r1Json.length < originalJson.length, `${originalJson.length} → ${r1Json.length} chars`);
    check("R1: system prompt untouched (I1)", contentOf(r1Body, 0) === session[0].content);
    check("R1: small user turn untouched (I4)", contentOf(r1Body, 1) === session[1].content);

    // ---- request 2: the CLIENT resends the ORIGINALS + one new assistant turn
    console.log("request 2: client resends originals (its own copy has the original tool output)");
    const clientR2Messages = [...session.slice(0, 5)];
    const r2ClientSentOriginal = (clientR2Messages[3].content as string) === originalJson;
    const r2 = await client(clientR2Messages);
    if (r2.status !== 200) throw new Error(`request 2 returned ${r2.status}`);
    await r2.text();
    const r2Body = upstream.captured[1].rawBody;
    const r2Json = contentOf(r2Body, 3);

    // THE KV-CACHE-STABILITY PROOF
    check("R2: client actually sent the original bytes to the proxy", r2ClientSentOriginal);
    check(
      "R2: upstream receives the SAME replacement bytes as request 1 (KV-cache stable)",
      r2Json === r1Json,
      `${r1Json.length} chars re-forwarded, byte-identical`
    );
    check("R2: re-forwarded bytes differ from the original (it is the compressed form)", r2Json !== originalJson);

    // ---- request 3: budget regime — frozen compressed zone + new big results
    console.log("request 3: full session under the token budget");
    await client(session.slice(0, 8));
    const r3Body = upstream.captured[2].rawBody;
    const r3Json = contentOf(r3Body, 3);
    const r3Logs = contentOf(r3Body, 5);
    const r3Search = contentOf(r3Body, 7);
    const originalLogs = session[5].content as string;
    const originalSearch = session[7].content as string;

    check("R3: the request-1 compressed message stays byte-identical (frozen under budget)", r3Json === r1Json);
    check("R3: newly-arrived log tool result compressed", r3Logs.includes("[ctxroom:compressed") && r3Logs.length < originalLogs.length, `${originalLogs.length} → ${r3Logs.length} chars`);
    check("R3: newly-arrived search tool result compressed", r3Search.includes("[ctxroom:compressed") && r3Search.length < originalSearch.length, `${originalSearch.length} → ${r3Search.length} chars`);

    // ---- CCR retrieval (I9) against the real cache dir
    const marker = /\[ctxroom:compressed ([0-9a-f]{12})/.exec(r1Json);
    const store = new CcrStore({ dir: join(home, "cache") });
    const retrieved = marker ? await store.retrieve(marker[1], { maxChars: 1_000_000 }) : null;
    check("CCR: retrieve returns the exact original bytes (I9)", retrieved?.text === originalJson && retrieved?.truncated === false, `${originalJson.length} chars round-trip`);

    // ---- stats rows
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(join(home, "stats")).catch(() => [] as string[]);
    let rows = 0;
    for (const f of files) {
      rows += (await readFile(join(home, "stats", f), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    }
    check("stats: one JSONL row per request", rows === 3, `${rows} rows`);

    await upstream.close();
    await proxy.close();
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  console.log("");
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length === 0 ? `ALL ${checks.length} CHECKS PASSED` : `${failed.length}/${checks.length} CHECKS FAILED`);
  return { code: failed.length === 0 ? 0 : 1 };
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(String((e as Error)?.stack ?? e));
    process.exit(1);
  }
);

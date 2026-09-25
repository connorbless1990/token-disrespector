/**
 * The ctxroom proxy: a loopback reverse proxy that compresses LLM request
 * bodies on the way out and passes everything else through unmodified.
 *
 *   copilot CLI ──env COPILOT_API_URL──▶ 127.0.0.1:8788 ──▶ api.githubcopilot.com
 *                                          │ compress the live zone (engine)
 *                                          │ forward Authorization verbatim
 *                                          └ stream SSE responses back unbuffered
 *
 * Routes (spec):
 *   POST /chat/completions, /v1/chat/completions, /responses → compress
 *   /p/<project>/<path>                                       → project attribution; prefix stripped before forwarding
 *   GET  /health                                              → status JSON
 *   everything else                                            → byte-transparent passthrough
 *
 * Safety: the engine's invariants apply (I1–I10); any failure at any step
 * degrades to forwarding the original request bytes (I5 at the proxy layer).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { Engine, resolveEngineConfig, type EngineConfig } from "@ctxroom/core";
import { compressibleRoute, applyBody, parseBody } from "./normalize.ts";
import { resolveUpstreamBase, type UpstreamEnv } from "./upstream.ts";
import { StatsWriter, type RequestStats } from "./stats.ts";

export const PROXY_VERSION = "0.1.0";

export interface ProxyOptions {
  /** Port. Default 8788. */
  port?: number;
  /** Bind host. Default 127.0.0.1 — loopback-only: content never leaves the machine. */
  host?: string;
  /** Upstream base URL. Default: resolved from env (see upstream.ts). */
  upstreamBase?: string;
  /** Environment used for upstream resolution + engine config. Default process.env. */
  env?: UpstreamEnv;
  /** Engine config overrides (ccr/budget/…). */
  config?: Partial<EngineConfig>;
  /** Injected engine (tests use a temp CCR dir). One engine per proxy ⇒ one process-wide SessionRegistry. */
  engine?: Engine;
  /** Injected stats writer (tests use a temp dir). */
  stats?: StatsWriter;
  /** Max request body size buffered for compression. Default 32 MiB; larger bodies pass through. */
  maxBodyBytes?: number;
}

export interface RunningProxy {
  port: number;
  host: string;
  upstreamBase: string;
  engine: Engine;
  stats: StatsWriter;
  close(): Promise<void>;
}

/** Request headers that must not be re-sent verbatim (undici recomputes them). */
const CLIENT_HEADERS = new Set(["host", "content-length", "connection", "expect"]);
/** Response headers that must not be re-sent (the body stream is re-framed by node:http). */
const RESPONSE_HEADERS = new Set(["transfer-encoding", "connection", "content-encoding", "content-length"]);

export async function startProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
  const env = options.env ?? process.env;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const upstreamBase = options.upstreamBase ?? resolveUpstreamBase(env);
  const engine = options.engine ?? new Engine(resolveEngineConfig(options.config ?? {}, env));
  const stats = options.stats ?? new StatsWriter(undefined, env.CTXROOM_HOME);
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: `ctxroom proxy error: ${String(e)}` } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    let project = "default";
    let path = url.pathname;

    // /p/<project>/<rest> — project attribution rides the path, because the
    // Copilot CLI cannot send custom headers. Strip the first segment; the
    // rest is what the upstream expects to see.
    const pMatch = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
    if (pMatch) {
      project = decodeURIComponent(pMatch[1]);
      path = pMatch[2] ?? "/";
    }

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "ctxroom-proxy",
          version: PROXY_VERSION,
          ok: true,
          upstreamBase,
          ccr: engine.config.ccr.enabled,
          budget: engine.config.budget.enabled,
          sessions: engine.sessionRegistry.size,
        })
      );
      return;
    }

    const inbound = await readBody(req, maxBodyBytes);
    const body = inbound.kind === "buffer" ? inbound.buf : null;
    const search = url.search;

    // --- Compression (only the LLM routes; anything else is byte-transparent)
    let forwardBody: Buffer | null = body;
    let statsRow: RequestStats | null = null;

    const route = req.method === "POST" ? compressibleRoute(path) : null;
    // A body over maxBodyBytes (inbound.kind === "oversized") is not parsed
    // at all — compression is skipped and it streams through verbatim (I5).
    if (route && body !== null && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        const normalized = parseBody(parsed, route);
        if (normalized) {
          // The engine auto-extracts referenced paths from the latest user
          // message; no extra options needed from the proxy.
          const result = await engine.compress(normalized.messagePairs.map((p) => p.message));
          if (applyBody(normalized, result.messages) > 0) {
            forwardBody = Buffer.from(JSON.stringify(parsed), "utf8");
          }
          const model = typeof parsed.model === "string" ? parsed.model : "";
          statsRow = {
            ts: new Date().toISOString(),
            project,
            model,
            path,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            tokensSaved: result.tokensSaved,
            transforms: result.transforms.map((t) => `${t.transform}:${t.type}`),
            ccrStored: result.ccrStored,
            ms: Date.now() - started,
          };
        }
      } catch {
        // I5: unparseable / failing body ⇒ forward the original bytes untouched.
      }
    }

    // Record stats BEFORE forwarding so the row is on disk by the time the
    // client sees any response bytes (loopback append; sub-millisecond).
    await stats.record(
      statsRow ?? {
        ts: new Date().toISOString(),
        project,
        model: "",
        path,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        transforms: [],
        ccrStored: 0,
        ms: Date.now() - started,
      }
    );

    // --- Forward to upstream
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (CLIENT_HEADERS.has(k)) continue;
      // Authorization is forwarded VERBATIM (native auth and PAT modes both
      // work upstream; we never rewrite credentials).
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    // Oversized inbound (headroom's body-limit bypass, node-flavored): the
    // request is still LIVE when readBody resolves (it switched modes the
    // moment the limit was crossed, before the client finished sending), so
    // streaming `inbound.pass` to the upstream delivers every remaining
    // byte in order — the proxy never buffers, and never fails, a body it
    // chose not to parse (I5).
    let streamBody: ReadableStream | undefined;
    if (inbound.kind === "oversized" && (req.method === "POST" || req.method === "PUT")) {
      streamBody = Readable.toWeb(inbound.pass) as ReadableStream;
    }

    const upstreamUrl = `${upstreamBase}${path === "/" ? "" : path}${search}`;
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method ?? "GET",
        headers,
        body:
          req.method === "POST" || req.method === "PUT"
            ? streamBody ?? forwardBody ?? undefined
            : undefined,
        ...(streamBody ? { duplex: "half" } : {}),
        redirect: "manual",
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `upstream unreachable: ${String(e)}` } }));
      return;
    }

    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers) {
      if (RESPONSE_HEADERS.has(k)) continue; // node:http re-frames: chunked, decoded
      res.setHeader(k, v);
    }

    if (upstream.body) {
      // Stream back unbuffered — v1 never modifies responses.
      const nodeStream = Readable.fromWeb(upstream.body as ReadableStream);
      await new Promise<void>((resolve) => {
        nodeStream.on("error", () => resolve());
        res.on("finish", resolve);
        res.on("close", resolve);
        nodeStream.pipe(res);
      });
    } else {
      res.end();
    }
  }

  const bound = server.address();
  const boundPort = bound && typeof bound === "object" ? bound.port : port;

  return {
    port: boundPort,
    host,
    upstreamBase,
    engine,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Read the request body up to `maxBytes`.
 *
 * A body LARGER than the limit is not an error (I5 — the proxy must never
 * fail a request because of its own size budget). The moment the running
 * size crosses the limit the reader switches to streaming mode: it resolves
 * EARLY with a live PassThrough that receives the pre-consumed chunks plus
 * every byte from that point on (backpressure-aware). The client is still
 * sending, so the remaining body flows into `pass` as it arrives and
 * `pass` ends exactly when the request ends — the caller can hand
 * `Readable.toWeb(pass)` straight to the upstream.
 */
export type InboundBody =
  | { kind: "buffer"; buf: Buffer }
  | { kind: "oversized"; pass: PassThrough };

function readBody(req: IncomingMessage, maxBytes: number): Promise<InboundBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let pass: PassThrough | null = null;
    req.on("data", (c: Buffer) => {
      if (pass) {
        // Streaming mode: forward everything; let backpressure reach the socket.
        if (!pass.write(c)) {
          req.pause();
          pass.once("drain", () => req.resume());
        }
        return;
      }
      size += c.length;
      if (size > maxBytes) {
        // Crossed the limit: switch modes NOW, mid-body, and resolve early.
        pass = new PassThrough();
        for (const ch of chunks) pass.write(ch);
        pass.write(c); // the flipping chunk itself — it must not be dropped
        resolve({ kind: "oversized", pass });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (pass) pass.end();
      else resolve({ kind: "buffer", buf: Buffer.concat(chunks) });
    });
    req.on("error", reject);
  });
}

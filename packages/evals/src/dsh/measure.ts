/**
 * DSH A/B measurement — parse what the run left behind.
 *
 * Sources (both arms, identical parsing):
 *   session JSONL  — per-request wall, TTFT, prompt/output tokens, cache-hit
 *                    ratio, retries. (compression: 'none' in the A/B profile;
 *                    the zstd frame decoder is kept for robustness.)
 *   proxy stats    — arm T/P only: tokensBefore/After, transforms, ms.
 *
 * All numbers here are read-only views of real session/stat bytes.
 */
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

export interface StepMetrics {
  step: number;
  /** seconds: step/end.time − step/start.time */
  wallS: number;
  /** seconds: first stream chunk − request/header (fallback step/start) */
  ttftS: number | null;
  inputTokens: number;
  outputTokens: number;
  /** prompt as the model saw it: input + cacheRead */
  promptTokens: number;
  /** KV-cache hit ratio of the prompt (0..1) */
  cacheHit: number;
  /** proxy-side, when the arm is proxied */
  tokensBefore?: number;
  tokensAfter?: number;
  tokensSaved?: number;
  transforms?: string[];
  proxyMs?: number;
}

export interface RunMetrics {
  sessionFile: string;
  steps: StepMetrics[];
  retries: number;
  timeouts: number;
  totalWallS: number;
  turnEndReason: string;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
function atFrame(buf: Uint8Array, pos: number): boolean {
  if (pos + 3 > buf.length) return false;
  return buf[pos] === ZSTD_MAGIC[0] && buf[pos + 1] === ZSTD_MAGIC[1] && buf[pos + 2] === ZSTD_MAGIC[2] && buf[pos + 3] === ZSTD_MAGIC[3];
}

export async function readSessionEvents(file: string): Promise<Record<string, unknown>[]> {
  const buf = new Uint8Array(await readFile(file));
  let text: string;
  if (file.endsWith(".zstd")) {
    let out = "";
    let i = 0;
    while (i < buf.length - 3) {
      if (atFrame(buf, i)) {
        let next = buf.length;
        for (let k = i + 4; k < buf.length - 3; k++) {
          if (atFrame(buf, k)) {
            next = k;
            break;
          }
        }
        out += zstdDecompressSync(Buffer.from(buf.subarray(i, next))).toString("utf8");
        i = next;
      } else {
        i++;
      }
    }
    text = out;
  } else {
    text = Buffer.from(buf).toString("utf8");
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** First stream-chunk time of an assistant/attempt event, if any. */
function firstChunkTime(e: Record<string, unknown>): number | null {
  const data = e.data as Record<string, unknown> | undefined;
  const stream = data?.stream;
  if (!Array.isArray(stream)) return null;
  for (const s of stream) {
    const t = (s as Record<string, unknown>)?.time;
    if (typeof t === "number") return t;
  }
  return null;
}

export function computeRunMetrics(sessionFile: string, events: Record<string, unknown>[]): RunMetrics {
  const steps: StepMetrics[] = [];
  const stepStart = new Map<number, number>();
  const headers: { time: number }[] = [];
  const lastAttemptChunk = new Map<number, number>();
  let retries = 0;
  let timeouts = 0;
  let turnEndReason = "unknown";
  let totalWallS = 0;
  const seenSteps = new Set<number>();

  for (const e of events) {
    const t = e.time as number | undefined;
    if (e.type === "request/header") headers.push({ time: t ?? 0 });
    if (e.type === "llm/retry") retries++;
    if (e.type === "assistant/attempt") {
      if (JSON.stringify(e).includes("LLM_STREAM_IDLE_TIMEOUT") || JSON.stringify(e).includes("upstream unreachable")) timeouts++;
      const step = Number((e.data as Record<string, unknown>)?.step ?? 0);
      const chunk = firstChunkTime(e);
      if (step > 0 && chunk !== null) lastAttemptChunk.set(step, chunk);
    }
    if (e.type === "turn/end") {
      const reason = (e.data as Record<string, unknown>)?.reason as Record<string, unknown> | undefined;
      turnEndReason = reason ? JSON.stringify(reason) : "completed";
    }
    if (e.type === "step/start" && typeof t === "number") {
      const step = Number((e.data as Record<string, unknown>)?.step ?? 0);
      if (step > 0) {
        stepStart.set(step, t);
        seenSteps.add(step);
      }
    }
    if (e.type === "assistant/message") {
      const data = e.data as Record<string, unknown>;
      const step = Number(data?.step ?? 0);
      const usage = data?.usage as Record<string, unknown> | undefined;
      const input = Number(usage?.inputTokens ?? 0);
      const output = Number(usage?.outputTokens ?? 0);
      const cacheRead = Number(usage?.cacheReadTokens ?? 0);
      const prompt = input + cacheRead;
      const start = stepStart.get(step);
      // message's own stream first; fall back to the step's attempt chunks
      const ownChunk = firstChunkTime(e);
      const chunk = ownChunk !== null ? ownChunk : lastAttemptChunk.get(step);
      let ttft: number | null = null;
      // nearest preceding request/header is this request's header
      let headerTime: number | null = null;
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i]!.time > 0 && headers[i]!.time <= (t ?? Infinity)) {
          headerTime = headers[i]!.time;
          break;
        }
      }
      if (typeof t === "number" && chunk !== null && chunk !== undefined && headerTime !== null) {
        ttft = (chunk - headerTime) / 1000;
      }
      steps.push({
        step,
        wallS: start !== undefined && typeof t === "number" ? (t - start) / 1000 : 0,
        ttftS: ttft,
        inputTokens: input,
        outputTokens: output,
        promptTokens: prompt,
        cacheHit: prompt > 0 ? cacheRead / prompt : 0,
      });
    }
  }
  // step wall from step/end when the message landed mid-stream
  for (const e of events) {
    if (e.type === "step/end" && typeof e.time === "number") {
      const step = Number((e.data as Record<string, unknown>)?.step ?? 0);
      const start = stepStart.get(step);
      const m = steps.find((s) => s.step === step);
      if (start !== undefined && m) {
        m.wallS = (e.time - start) / 1000;
        totalWallS = Math.max(totalWallS, m.wallS);
      }
    }
  }
  steps.sort((a, b) => a.step - b.step);
  if (events.length > 1) {
    totalWallS = Math.max(totalWallS, ((events[events.length - 1]!.time as number) - (events[1]!.time as number)) / 1000);
  }
  return { sessionFile, steps, retries, timeouts, totalWallS, turnEndReason };
}

/** Aggregate one arm across its runs for the report table. */
export function aggregate(runs: RunMetrics[]): Record<string, number | string | null> {
  const steps = runs.flatMap((r) => r.steps);
  const med = (xs: number[]) => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const ttfts = steps.filter((s) => s.ttftS !== null).map((s) => s.ttftS!);
  const warm = steps.filter((s) => s.cacheHit >= 0.9);
  const cold = steps.filter((s) => s.cacheHit < 0.9);
  return {
    runs: runs.length,
    steps: steps.length,
    totalWallS: Math.round(runs.reduce((a, r) => a + r.totalWallS, 0)),
    meanStepWallS: Number(mean(steps.map((s) => s.wallS)).toFixed(1)),
    medStepWallS: Number(med(steps.map((s) => s.wallS)).toFixed(1)),
    meanTTFTs: Number(mean(ttfts).toFixed(1)),
    medTTFTs: Number(med(ttfts).toFixed(1)),
    warmMeanStepWallS: Number(mean(warm.map((s) => s.wallS)).toFixed(1)),
    coldMeanStepWallS: Number(mean(cold.map((s) => s.wallS)).toFixed(1)),
    warmShare: warm.length / Math.max(1, steps.length),
    meanPromptTokens: Math.round(mean(steps.map((s) => s.promptTokens))),
    maxPromptTokens: Math.round(Math.max(0, ...steps.map((s) => s.promptTokens))),
    meanCacheHit: Number(mean(steps.map((s) => s.cacheHit)).toFixed(3)),
    retries: runs.reduce((a, r) => a + r.retries, 0),
    timeouts: runs.reduce((a, r) => a + r.timeouts, 0),
  };
}

/** Proxy stats rows within a window (arm T/P only). */
export async function statsInWindow(statsFile: string, sinceMs: number): Promise<Record<string, unknown>[]> {
  const raw = await readFile(statsFile, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.ts === "string" && Date.parse(r.ts) >= sinceMs);
}

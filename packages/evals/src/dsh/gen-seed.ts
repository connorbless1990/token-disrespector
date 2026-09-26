/**
 * DSH A/B workload — deterministic seeded audit repo + ground truth.
 *
 * Same philosophy as the E1/E2 corpus (mulberry32, seeded, reproducible with
 * nothing but Node) at ~0.4× scale: a full read peaks around 60–70k prompt
 * tokens — the brief's 50k+ target with a realistic audit shape:
 * build log (burst first) + indented JSON + minified JSON + 4 code files +
 * ripgrep dump + YAML config + prose (EN/CJK) + git diff.
 *
 * Ground truth is computed FROM THE GENERATED DATA (not mined from text), so
 * the battery scorer is exact: `answersFromData()` produces the 15 correct
 * answers at generation time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mulberry32, type Rng } from "../rng.ts";

export const DSH_AB_SEED = 20260925;

export const ERROR_SERVICES = ["billing", "auth", "search", "ingest"] as const;
export const ERROR_KINDS = [
  "timeout while calling upstream",
  "failed to flush buffer",
  "connection refused on 127.0.0.1:5432",
  "OOM in worker pool",
] as const;
const SERVICES = ["auth", "billing", "search", "catalog", "checkout"] as const;
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const PATHS = ["users", "orders", "items", "sessions"] as const;
const API_ERRORS = ["upstream timeout", "connection reset", "rate limit exceeded", "bad gateway"] as const;

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

export interface ApiRecord {
  id: string;
  service: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  bytes: number;
  cached: boolean;
  ts: string;
  error: string | null;
}

export interface SeedData {
  /** raw file texts, keyed by repo-relative path */
  files: Record<string, string>;
  records: ApiRecord[];
  /** the 15 battery answers, computed from the data */
  answers: Record<string, string>;
  /** total chars of all files (≈ prompt mass if fully read) */
  totalChars: number;
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function buildLog(rng: Rng): { text: string; info: number; warn: number; error: number; lastLine: string } {
  const lines: string[] = [];
  // The distinctive burst FIRST (E4 rule: survives any partial read/preview).
  for (let i = 0; i < 60; i++) {
    lines.push(`2026-09-21T10:59:${String(i % 60).padStart(2, "0")}Z ERROR [billing] VORTEX-7001 charge declined for item ${5000 + i}`);
  }
  let info = 0;
  let warn = 0;
  let error = 60;
  for (let i = 0; i < 740; i++) {
    const h = 10 + Math.floor(i / 60);
    const mm = String(i % 60).padStart(2, "0");
    const ss = String((i * 7) % 60).padStart(2, "0");
    if (i % 37 === 0) {
      warn++;
      lines.push(`2026-09-21T${h}:${mm}:${ss}Z WARN  [retry] backing off for item ${1000 + i} after 3 attempts`);
    } else if (i % 83 === 0) {
      error++;
      lines.push(`2026-09-21T${h}:${mm}:${ss}Z ERROR [worker] ${ERROR_KINDS[Math.floor(rng() * ERROR_KINDS.length)]} for item ${1000 + i}`);
    } else if (i % 97 === 0) {
      lines.push(`2026-09-21T${h}:${mm}:${ss}Z ERROR [worker] crash detected in worker pool for item ${1000 + i}`);
      error++;
    } else {
      info++;
      lines.push(`2026-09-21T${h}:${mm}:${ss}Z INFO  [worker] processing item ${1000 + i} in ${10 + (i % 30)}ms`);
    }
  }
  const text = lines.join("\n"); // no trailing newline — the "last line" question is well-defined
  return { text, info, warn, error, lastLine: lines[lines.length - 1]! };
}

function buildRecords(rng: Rng, n: number): ApiRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const ok = rng() < 0.94;
    const status = ok ? 200 : pick(rng, [404, 429, 500, 502]);
    return {
      id: `req_${100000 + i}`,
      service: pick(rng, SERVICES),
      method: pick(rng, METHODS),
      path: `/api/v2/${pick(rng, PATHS)}/${1 + Math.floor(rng() * 9999)}`,
      status,
      duration_ms: 120 + Math.floor(rng() * 900),
      bytes: 128 + Math.floor(rng() * 120000),
      cached: rng() < 0.3,
      ts: `2026-09-2${1 + (i % 3)}T${String(i % 24).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}:${String((i * 29) % 60).padStart(2, "0")}Z`,
      error: ok ? null : pick(rng, API_ERRORS),
    };
  });
}

const JSON_PRETTY = 2;
function jsonPretty(rec: ApiRecord, indent: number): string {
  const pad = " ".repeat(indent);
  return [
    `${pad}{`,
    `${pad}  "id": "${rec.id}",`,
    `${pad}  "service": "${rec.service}",`,
    `${pad}  "method": "${rec.method}",`,
    `${pad}  "path": "${rec.path}",`,
    `${pad}  "status": ${rec.status},`,
    `${pad}  "duration_ms": ${rec.duration_ms},`,
    `${pad}  "bytes": ${rec.bytes},`,
    `${pad}  "cached": ${rec.cached},`,
    `${pad}  "ts": "${rec.ts}",`,
    `${pad}  "error": ${rec.error ? `"${rec.error}"` : "null"}`,
    `${pad}}`,
  ].join("\n");
}

function codeFile(rng: Rng, name: string, nLines: number): string {
  const lines: string[] = [`// ${name} — deterministic audit seed`, `import { ${name.slice(0, 3)} } from "./${name.replace(".ts", "")}-dep";`, ""];
  for (let i = 0; i < nLines; i++) {
    const fn = Math.floor(i / 12);
    if (i % 12 === 0) lines.push(`export function handle${name.slice(0, 4)}Case${fn}(input: unknown, depth: number): string {`);
    else if (i % 12 === 6) lines.push(`  const part${fn}_${i} = decode(input, ${i}, ${fn} /* ${pick(rng, ["alpha", "beta", "gamma", "delta"])} */);`);
    else lines.push(`  if (depth > ${i % 9}) return step${fn}(${i}, ${Math.floor(rng() * 100)}); // ${pick(rng, ["route", "compress", "store", "flush"])}`);
    if (i % 12 === 11) lines.push("}\n");
  }
  return lines.join("\n");
}

function buildGrep(rng: Rng, files: Record<string, string>): string {
  const paths = Object.keys(files).filter((p) => p.startsWith("src/")).concat("logs/build.log");
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    const f = pick(rng, paths);
    const content = (files[f] ?? "").split("\n")[Math.floor(rng() * 200)] ?? "";
    lines.push(`${f}:${1 + Math.floor(rng() * 800)}:${content.trim()}`);
  }
  return lines.join("\n");
}

function buildConfig(): string {
  return [
    "app:",
    "  name: audit-service",
    "  env: production",
    "  region: eu-west-1",
    "database:",
    "  host: db.primary.internal",
    "  port: 5432",
    "  pool: 20",
    "cache:",
    "  driver: redis",
    "  ttl: 900",
    "  prefix: audit:",
    "  dedup: true",
    "features:",
    "  new-billing: true",
    "  gray-router: false",
    "  vortex-scan: true",
    "limits:",
    "  qps: 500",
    "  burst: 800",
    "  queue: 4096",
    ...Array.from({ length: 160 }, (_, i) => `  flag_${i.toString(36).padStart(4, "0")}: ${i % 3 === 0}`),
    "",
  ].join("\n");
}

function buildNotes(rng: Rng): string {
  const paras = [
    "## Design notes",
    "",
    "The cache layer deduplicates repeated lookups so that a hot key is resolved once per TTL window.",
    "Every worker flushes its buffer to the queue on a fixed cadence; the router balances depth against latency.",
    "Compression of request context is an orthogonal concern: it shrinks what travels to the model without changing what was stored.",
    "",
    "We measure the difference honestly and publish the number. Deterministic, local, reversible, and honest.",
    "",
    "## 中文说明",
    "",
    "上下文压缩在请求到达模型之前进行。一个标记携带大量结构信息。我们测量差异，然后发布数字。",
    "系统构建在确定性、本地、可逆与诚实的原则之上。缓存去重并在 TTL 窗口内复用结果。",
    "",
  ];
  return paras.join("\n");
}

function buildDiff(): string {
  return [
    "diff --git a/src/router.ts b/src/router.ts",
    "index 1111111..2222222 100644",
    "--- a/src/router.ts",
    "+++ b/src/router.ts",
    "@@ -10,6 +10,8 @@",
    " export function route(req: Request) {",
    "+  // vortex-scan gate added",
    "+  if (req.headers[\"x-scan\"]) return scan(req);",
    "   return dispatch(req);",
    " }",
    "diff --git a/src/engine.ts b/src/engine.ts",
    "index 3333333..4444444 100644",
    "--- a/src/engine.ts",
    "+++ b/src/engine.ts",
    "@@ -20,5 +20,6 @@",
    " export function step(n: number) {",
    "+  metrics.observe(\"step\", n);",
    "   return n * 2;",
    " }",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export function answersFromData(d: {
  log: { info: number; warn: number; error: number; lastLine: string };
  records: ApiRecord[];
  /** exact count of engine.ts references in the generated grep dump */
  q14: number;
}): Record<string, string> {
  const c5xx = d.records.filter((r) => r.status >= 500 && r.status < 600).length;
  const c2xx = d.records.filter((r) => r.status >= 200 && r.status < 300).length;
  const rate = d.records.filter((r) => r.error === "rate limit exceeded").length;
  return {
    Q1: "VORTEX-7001",
    Q2: String(d.log.error),
    Q3: String(d.log.warn),
    Q4: String(d.log.info),
    Q5: String(c5xx),
    Q6: String(c2xx),
    Q7: String(rate),
    Q8: String(d.records[0]!.status),
    Q9: d.log.lastLine,
    Q10: "900",
    Q11: "db.primary.internal",
    Q12: "router.ts,engine.ts",
    Q13: "yes",
    Q14: String(d.q14),
    Q15: "dedup",
  };
}

/** Battery questions, in the order asked in task.txt. */
export const QUESTIONS: Record<string, string> = {
  Q1: "What error code appears in the distinct error burst at the top of logs/build.log?",
  Q2: "How many ERROR lines does logs/build.log contain?",
  Q3: "How many WARN lines does logs/build.log contain?",
  Q4: "How many INFO lines does logs/build.log contain?",
  Q5: "How many records in logs/api-dump.json have a 5xx status?",
  Q6: "How many records in logs/api-dump.json have a 2xx status?",
  Q7: "How many records in logs/api-dump.json have error 'rate limit exceeded'?",
  Q8: "What is the status code of the FIRST record in logs/api-dump.json?",
  Q9: "What is the exact text of the LAST line of logs/build.log?",
  Q10: "What is the cache TTL value in config/app.yaml?",
  Q11: "What database host is configured in config/app.yaml?",
  Q12: "Which files does audit/diff.patch modify? (comma-separated basenames)",
  Q13: "Does logs/build.log mention a crash? (yes or no)",
  Q14: "How many lines in audit/grep-errors.txt reference src/engine.ts? (an integer estimate is fine)",
  Q15: "In one word, what does the cache layer do according to notes/design-notes.md? (answer: the verb)",
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateSeedData(seed: number = DSH_AB_SEED): SeedData {
  const rng = mulberry32(seed);
  const log = buildLog(rng);
  const records = buildRecords(rng, 200);
  const files: Record<string, string> = {
    "logs/build.log": log.text,
    "logs/api-dump.json": `{ "generated": "2026-09-21", "results": [\n${records.map((r) => jsonPretty(r, 4)).join(",\n")}\n  ] }`,
    "logs/api-minified.json": JSON.stringify({ generated: "2026-09-21", results: records }),
    "src/engine.ts": codeFile(rng, "engine", 260),
    "src/compress.ts": codeFile(rng, "compress", 240),
    "src/ccr.ts": codeFile(rng, "ccr", 220),
    "src/router.ts": codeFile(rng, "router", 200),
    "config/app.yaml": buildConfig(),
    "notes/design-notes.md": buildNotes(rng),
    "audit/diff.patch": buildDiff(),
  };
  // grep dump is derived from the files above
  files["audit/grep-errors.txt"] = buildGrep(rng, files);
  // exact Q14 ground truth: count engine.ts references in the generated dump
  const q14 = files["audit/grep-errors.txt"]!.split("\n").filter((l) => l.startsWith("src/engine.ts:")).length;
  const answers = answersFromData({ log, records, q14 });
  const totalChars = Object.values(files).reduce((n, t) => n + t.length, 0);
  return { files, records, answers, totalChars };
}

export const TASK = [
  "You are auditing the repository in your working directory. Before answering,",
  "read each of these files IN FULL with the read tool:",
  "logs/build.log, logs/api-dump.json, logs/api-minified.json,",
  "src/engine.ts, src/compress.ts, src/ccr.ts, src/router.ts,",
  "config/app.yaml, notes/design-notes.md, audit/diff.patch, audit/grep-errors.txt.",
  "",
  "If any part of a file or tool output appears as a [ctxroom:compressed <handle>] marker,",
  "call the ctxroom_retrieve tool with that 12-hex handle to fetch the exact original",
  "before answering questions about content you have not seen verbatim.",
  "",
  "Then answer this battery. Reply with ONLY the 15 answer lines, one per line,",
  "formatted exactly `Q<n>: <answer>`:",
  ...Object.entries(QUESTIONS).map(([k, q]) => `${k}: ${q}`),
  "",
  "Be exact. Counts are integers. Do not include commentary, tables, or markdown.",
].join("\n");

export function writeSeed(dir: string, seed: number = DSH_AB_SEED): SeedData {
  const data = generateSeedData(seed);
  for (const [rel, text] of Object.entries(data.files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  writeFileSync(join(dir, "ground-truth.json"), JSON.stringify(data.answers, null, 2) + "\n");
  return data;
}

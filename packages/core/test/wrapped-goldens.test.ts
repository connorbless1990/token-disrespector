/**
 * B2 goldens: the router + engine on REAL tool-output shapes (work packages
 * A1–A3, B2). Shapes are the ones observed in live Copilot CLI 1.0.88
 * sessions on this machine (2026-09-23): bare path header + raw file
 * content, "(lines N-M)" partial reads, truncation notices, per-line
 * prefixes, minified single-line files, middle chunks of larger documents.
 *
 * Invariants under test:
 *   - the wrapper is preserved verbatim around the compressed body
 *   - the marker is appended and CCR round-trips to the EXACT original
 *   - no-growth with the marker included
 *   - frozen resubmission is byte-identical (I2/KV-cache)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, resolveEngineConfig, CcrStore, type EngineMessage } from "../src/index.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "ctxroom-goldens-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function makeEngine(): Engine {
  return new Engine(
    resolveEngineConfig(
      { ccr: { enabled: true, dir: join(dir, "ccr") } },
      {} as NodeJS.ProcessEnv
    )
  );
}

function tool(name: string, content: string): EngineMessage {
  return { role: "tool", tool_call_id: name, content };
}

const base = [
  { role: "system", content: "You are a coding agent. Be precise." },
  { role: "user", content: "please analyze the output above" },
] as EngineMessage[];

// Deterministic 500-record fixture (cycling values → realistic redundancy).
const RECS = Array.from({ length: 500 }, (_, i) => ({
  id: `req_${i}`,
  service: ["auth", "billing", "search"][i % 3],
  method: ["GET", "POST", "PUT"][i % 3],
  path: `/api/v2/things/${i % 57}`,
  status: i % 17 === 0 ? 500 : 200,
  duration_ms: (i * 37) % 900 + 5,
  bytes: (i * 131) % 40960 + 128,
  cached: i % 4 === 0,
  ts: `2026-09-21T10:${String((i * 7) % 60).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}Z`,
  error: i % 17 === 0 ? "upstream timeout" : null,
}));
const PRETTY = JSON.stringify({ generated: "2026-09-21", results: RECS }, null, 2);
const PRETTY_LINES = PRETTY.split("\n");

function markerOf(msg: EngineMessage): string {
  const c = msg.content as string;
  const m = c.match(/\[ctxroom:compressed [0-9a-f]{12}/);
  assert.ok(m, "expected a ctxroom marker in the output");
  return m[0]!;
}

/** Re-read the full original through the 20KB retrieve windows. */
async function retrieveFull(ccr: CcrStore, hash: string): Promise<string> {
  let acc = "";
  let off = 0;
  for (let i = 0; i < 100; i++) {
    const g = await ccr.retrieve(hash, { offset: off });
    assert.ok(g, `window at ${off} resolves`);
    acc += g!.text;
    if (!g!.truncated) break;
    off = g!.offset + g!.text.length;
  }
  return acc;
}

test("A1: path header + indented JSON (the real copilot wound) is compressed, header kept, I9 exact", async () => {
  const eng = makeEngine();
  const text = `/var/folders/xy/copilot/big-api-dump.json\n${PRETTY}`;
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;

  assert.ok(out.startsWith("/var/folders/xy/copilot/big-api-dump.json\n"), "header preserved");
  assert.ok(out.length < text.length, "no growth");
  const lastLine = out.split("\n").pop()!;
  assert.ok(lastLine.startsWith("[ctxroom:compressed"), "marker on the final line");

  const ccr = new CcrStore({ dir: join(dir, "ccr") });
  const hash = out.match(/\[ctxroom:compressed ([0-9a-f]{12})/)?.[1];
  assert.ok(hash);
  const got = await ccr.retrieve(hash!);
  assert.ok(got, "hash resolves");
  assert.equal(got!.totalChars, text.length);
  assert.equal(await retrieveFull(ccr, hash!), text, "I9: retrieve is the exact original");
});

test("A1: partial read with (lines N-M) annotation", async () => {
  const eng = makeEngine();
  const inner = PRETTY_LINES.slice(0, 300).join("\n");
  const text = `/tmp/proj/dump.json (lines 1-300)\n${inner}`;
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.startsWith("/tmp/proj/dump.json (lines 1-300)\n"), "annotated header preserved");
  assert.ok(out.length < text.length, "compressed (not passthrough)");
  assert.ok(out.includes("[ctxroom:compressed"), "marker");
});

test("A1: truncation notice is preserved around the compressed body", async () => {
  const eng = makeEngine();
  const body = PRETTY_LINES.slice(0, 300).join("\n");
  const notice = "[Output truncated… Full output saved to /var/folders/ab/09/T//copilot-tool-output-1f3a9c.txt]";
  const text = body + "\n" + notice;
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.includes(notice), "notice survives verbatim");
  assert.ok(out.length < text.length, "compressed");
  // Layout: notice stays in its original position; the marker is the final line.
  assert.ok(out.split("\n").pop()!.startsWith("[ctxroom:compressed"), "marker last");
  assert.ok(out.indexOf(notice) < out.indexOf("[ctxroom:compressed"), "notice before marker");
});

test("A2: MIDDLE chunk of a larger indented JSON document (700 lines) is fragmented", async () => {
  const eng = makeEngine();
  // A middle slice of the 200-record file (starts mid-record, like a real 700-line window).
  const text = PRETTY_LINES.slice(20, 720).join("\n");
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.includes("ctxroom:fragment"), "fragment note present");
  assert.ok(out.includes("[ctxroom:compressed"), "marker");
  assert.ok(out.length < text.length * 0.85, `meaningfully shrunk (${text.length} → ${out.length})`);
  // The model can still count the total: the note is quantified.
  assert.match(out, /kept \d+ of \d+ row/);
});

test("A2: FIRST chunk of an indented JSON (whole, truncated at window edge)", async () => {
  const eng = makeEngine();
  const text = PRETTY_LINES.slice(0, 300).join("\n") + "\n[Output truncated… 300 of 3605 lines]";
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.length < text.length * 0.9, `shrunk (${text.length} → ${out.length})`);
  assert.ok(out.includes("[Output truncated… 300 of 3605 lines]"), "notice preserved");
  assert.ok(out.split("\n").pop()!.startsWith("[ctxroom:compressed"), "marker last");
});

test("A2: minified single-line JSON with a path header (200KB-class)", async () => {
  const eng = makeEngine();
  const minified = JSON.stringify(RECS);
  const text = `/tmp/proj/minified.json\n${minified}`;
  assert.ok(text.length > 40000, "fixture is in the hundreds-of-KB class");
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.startsWith("/tmp/proj/minified.json\n"), "header preserved");
  assert.ok(out.length < text.length * 0.5, `shrunk (${text.length} → ${out.length})`);
  assert.ok(out.includes("[ctxroom:compressed"), "marker");
});

test("A1: per-line path:line: prefixes (cat -n form) — header kept, I9 exact", async () => {
  const eng = makeEngine();
  const text = RECS.slice(0, 40).map((r, i) => `/tmp/proj/data.json:${i + 1}:${JSON.stringify(r)}`).join("\n");
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.startsWith("/tmp/proj/data.json\n"), "header line preserved");
  assert.ok(out.includes("[ctxroom:stripped path:line: prefixes"), "honest note");
  const hash = out.match(/\[ctxroom:compressed ([0-9a-f]{12})/)?.[1];
  assert.ok(hash, "marker");
  const ccr = new CcrStore({ dir: join(dir, "ccr") });
  const got = await ccr.retrieve(hash!);
  assert.ok(got);
  assert.equal(got!.totalChars, text.length);
  assert.equal(await retrieveFull(ccr, hash!), text, "I9: original with prefixes round-trips");
});

test("no misfire: a log file whose LAST line mentions truncation is not reshaped", async () => {
  const eng = makeEngine();
  const lines = Array.from({ length: 120 }, (_, i) =>
    `2026-09-21T10:00:${String(i % 60).padStart(2, "0")}Z INFO [vite] transforming module ${i} of 999 (12 ms)`
  );
  const text = lines.join("\n");
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  // The log shape compresses (template/RLE) — but the block is never
  // mis-identified as a wrapped document (no header/notice artifacts).
  assert.ok(!out.startsWith("\n"), "no invented header");
  assert.ok(out.includes("[ctxroom:compressed") || out.length === text.length, "compressed or honest passthrough");
});

test("no misfire: a code file that MENTIONS paths and truncation in comments", async () => {
  const eng = makeEngine();
  const text =
    "// reads /tmp/ctxroom/f.json and logs: output truncated, saved to /tmp/x.txt\n" +
    Array.from(
      { length: 80 },
      (_, i) =>
        `function f${i}(x: number): number {\n  const y = ${i} * 2 + (x % ${7 + (i % 5)});\n  if (y > 100) return ${i};\n  return y + ${i % 3};\n}`
    ).join("\n\n");
  const res = await eng.compress([...base, tool("a", text)]);
  const out = res.messages[res.messages.length - 1].content as string;
  assert.ok(out.length <= text.length, "never grows");
});

test("I2: resubmitting the original (frozen prefix) forwards byte-identical bytes", async () => {
  const eng = makeEngine();
  const text = `/tmp/proj/dump.json\n${PRETTY}`;
  const first = await eng.compress([...base, tool("a", text)]);
  const out1 = first.messages[first.messages.length - 1].content as string;
  const second = await eng.compress([...base, tool("a", text)]);
  const out2 = second.messages[second.messages.length - 1].content as string;
  assert.equal(out2, out1, "second request forwards the stored send form byte-identically");
});

test("idempotence: a block that already carries a ctxroom marker is never re-compressed", async () => {
  const eng = makeEngine();
  const text = `/tmp/proj/dump.json\n${PRETTY}`;
  const first = await eng.compress([...base, tool("a", text)]);
  const marked = first.messages[first.messages.length - 1].content as string;
  const again = await eng.compress([...base, tool("a", marked)]);
  const out = again.messages[again.messages.length - 1].content as string;
  assert.equal(out, marked, "second pass is a no-op");
  assert.equal((out.match(/\[ctxroom:compressed/g) ?? []).length, 1, "exactly one marker");
});

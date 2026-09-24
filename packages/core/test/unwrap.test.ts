/**
 * Wrapper-unwrap tests (work package A1 / B2 goldens).
 *
 * The shapes are the ones observed in real Copilot CLI 1.0.88 sessions
 * (discovered live on this machine, 2026-09-23):
 *   - the `view` (read) tool returns: a bare path header line + the raw
 *     file content; partial reads add a "(lines N-M)" annotation;
 *   - long tool output is truncated with a notice + "saved to …" pointer;
 *   - cat -n / single-file dumps carry per-line path prefixes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWrapper, detectLinePrefixes, detectAnyWrapper, reassembleWrapper } from "../src/unwrap.ts";

// ---------------------------------------------------------------------------
// span wrapper: leading path header
// ---------------------------------------------------------------------------

test("span: bare path header over indented JSON", () => {
  const doc = JSON.stringify({ results: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, n: i })) }, null, 2);
  const text = `/var/folders/xy/copilot/big-dump.json\n${doc}`;
  const spec = detectWrapper(text);
  assert.ok(spec, "must detect the header");
  assert.equal(spec!.kind, "span");
  assert.equal(spec!.path, "/var/folders/xy/copilot/big-dump.json");
  assert.equal(spec!.truncated, false);
  assert.equal(spec!.prefix, "/var/folders/xy/copilot/big-dump.json\n");
  assert.equal(spec!.suffix, "");
  assert.equal(spec!.inner, doc);
  assert.equal(spec!.innerStart, spec!.prefix.length);
  assert.equal(spec!.innerEnd, text.length);
  // reassembly round-trips the exact original
  assert.equal(reassembleWrapper(spec!, doc), text);
});

test("span: partial-read annotation (lines 1-100) — the real copilot form", () => {
  const body = Array.from({ length: 100 }, (_, i) => `2026-09-21T10:00:${String(i % 60).padStart(2, "0")}Z INFO [worker] job ${i} ok`).join("\n") + "\n";
  const text = `/tmp/proj/plain-log.txt (lines 1-100)\n${body}`;
  const spec = detectWrapper(text);
  assert.ok(spec, "must detect the annotated header");
  assert.equal(spec!.path, "/tmp/proj/plain-log.txt");
  assert.equal(spec!.inner, body);
  assert.equal(reassembleWrapper(spec!, body), text);
});

test("span: relative path with line-range hint", () => {
  const body = `x${"y".repeat(900)}\n`;
  const text = `src/pkg/data.yaml:42-700\n${body}`;
  const spec = detectWrapper(text);
  assert.ok(spec);
  assert.equal(spec!.path, "src/pkg/data.yaml");
  assert.equal(spec!.inner, body);
});

// ---------------------------------------------------------------------------
// span wrapper: trailing truncation notices
// ---------------------------------------------------------------------------

test("span: trailing truncation notice + saved-to pointer", () => {
  const body = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: `i${i}`, v: i * 3 })) }, null, 2);
  const notice = "[Output truncated… Full output saved to /var/folders/ab/09/T//copilot-tool-output-1f3a9c.txt]";
  const text = body + "\n" + notice;
  const spec = detectWrapper(text);
  assert.ok(spec, "must detect the notice");
  assert.equal(spec!.truncated, true);
  assert.equal(spec!.suffix, "\n" + notice);
  assert.equal(spec!.inner, body);
  assert.equal(spec!.prefix, "");
  assert.equal(reassembleWrapper(spec!, body), text);
});

test("span: header AND truncation notice together", () => {
  // body deliberately has NO trailing newline: the separator newline between
  // content and notice belongs to the suffix (the notice must never glue
  // onto a compressor output that lacks a trailing newline).
  const body = `{"a": 1\n  "b": 2\n  "c": 3` + Array.from({ length: 300 }, (_, i) => `\n  "k${i % 7}": ${i}`).join("");
  const text = `/tmp/f.json\n${body}\n… (output truncated, 98123 chars, saved to /tmp/ctx-out.txt)`;
  const spec = detectWrapper(text);
  assert.ok(spec);
  assert.equal(spec!.path, "/tmp/f.json");
  assert.ok(spec!.truncated);
  assert.equal(spec!.suffix, "\n… (output truncated, 98123 chars, saved to /tmp/ctx-out.txt)");
  assert.equal(spec!.inner, body);
  assert.equal(reassembleWrapper(spec!, body), text);
});

// ---------------------------------------------------------------------------
// negative cases: no wrapper, or wrapper too fat
// ---------------------------------------------------------------------------

test("span: none for a plain prose document (first line is a heading)", () => {
  const text = `# Release notes\n\n` + Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with plenty of prose text to make the block large. `).join("\n\n");
  assert.equal(detectWrapper(text), null);
});

test("span: none for a log file whose first line is a command echo", () => {
  const text = `$ npm run build --workspaces\n` + Array.from({ length: 300 }, (_, i) => `2026-09-21T10:00:00.000Z INFO [vite] transform ${i} (12 ms)`).join("\n");
  assert.equal(detectWrapper(text), null);
});

test("span: a header line is ignored on a tiny block", () => {
  const text = `/tmp/f.json\n{"a": 1}\n`;
  assert.equal(detectWrapper(text), null);
});

test("span: a fat 'wrapper' (more than 10%) is refused", () => {
  // 200 chars of 'content' but 400 chars of 'header' — the inner is < 90%.
  const text = `/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p.txt\n` + "x".repeat(250) + "\n" + "[Output truncated… saved to /tmp/z.txt]".repeat(8);
  assert.equal(detectWrapper(text), null);
});

// ---------------------------------------------------------------------------
// per-line prefixes
// ---------------------------------------------------------------------------

test("lines: single-file cat -n prefixes are stripped for routing", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `/tmp/proj/src/main.ts:${i + 1}:const value${i} = compute(${i});`);
  const text = lines.join("\n");
  const spec = detectLinePrefixes(text);
  assert.ok(spec, "must detect single-file numbering");
  assert.equal(spec!.kind, "lines");
  assert.equal(spec!.path, "/tmp/proj/src/main.ts");
  assert.equal(spec!.numbered, true);
  assert.equal(spec!.lineCount, 60);
  assert.ok(spec!.inner.startsWith("const value0 = compute(0);"));
  assert.ok(!spec!.inner.includes("main.ts:"));
  const re = reassembleWrapper(spec!, spec!.inner);
  assert.ok(re.startsWith("/tmp/proj/src/main.ts\n"));
  assert.ok(re.includes("[ctxroom:stripped path:line: prefixes (60 lines in the original)"));
});

test("lines: a ripgrep dump (many paths) is NOT a wrapper", () => {
  const files = ["packages/core/src/a.ts", "packages/core/src/b.ts", "packages/proxy/src/c.ts"];
  const text = files
    .map((f, fi) =>
      Array.from({ length: 12 }, (_, i) => `${f}:${fi * 40 + i + 1}:match ${fi}-${i} in ${f}`).join("\n")
    )
    .join("\n");
  assert.equal(detectLinePrefixes(text), null, "multi-file dumps belong to the search shape");
});

test("lines: logs with timestamps are NOT line-prefixed", () => {
  const text = Array.from({ length: 80 }, (_, i) => `2026-09-21T10:00:00.000Z INFO [vite] transforming chunk ${i} (15 ms)`).join("\n");
  assert.equal(detectLinePrefixes(text), null);
});

test("detectAnyWrapper prefers the span form when both exist", () => {
  const inner = Array.from({ length: 30 }, (_, i) => `/x/y/z.ts:${i + 1}:code ${i}`).join("\n");
  const text = `/x/y/z.ts\n${inner}\n[Output truncated… saved to /tmp/out.txt]`;
  const spec = detectAnyWrapper(text);
  assert.ok(spec);
  assert.equal(spec!.kind, "span");
  assert.equal(spec!.path, "/x/y/z.ts");
  assert.equal(spec!.inner, inner);
});

test("reassembleWrapper: span preserves exact layout", () => {
  const doc = Array.from({ length: 40 }, (_, i) => `payload line ${i} with enough text to clear the size gate`).join("\n");
  const prefix = "/p/q.json\n";
  const suffix = "\n[Output truncated… saved to /tmp/s.txt]";
  const text = prefix + doc + suffix;
  const spec = detectWrapper(text)!;
  const shrunk = "line one\n… [ctxroom:2 row(s) omitted]\nline three";
  const out = reassembleWrapper(spec, shrunk);
  assert.equal(out, prefix + shrunk + suffix);
  assert.ok(out.startsWith("/p/q.json\n"));
  assert.ok(out.endsWith("saved to /tmp/s.txt]"));
});

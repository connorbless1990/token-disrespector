/**
 * Evals harness tests: determinism, report shape, and E1 sanity.
 *
 * These keep the eval package honest in the ordinary suite (npm test):
 * a determinism break or a silent 100%-ratio (i.e. "compressed" everything,
 * the failure mode to fear) would fail CI before anyone trusts a report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCorpus, DEFAULT_SEED } from "../src/corpus.ts";
import { runE1, e1ToReport } from "../src/e1.ts";
import { E1_TARGET_RATIO } from "../src/e1.ts";

test("corpus is deterministic: same seed → byte-identical shapes", () => {
  const a = generateCorpus(DEFAULT_SEED);
  const b = generateCorpus(DEFAULT_SEED);
  assert.deepEqual(a, b);
  const c = generateCorpus(DEFAULT_SEED + 1);
  assert.notDeepEqual(a, c, "different seeds must differ");
});

test("corpus contains every required shape class", () => {
  const names = new Set(generateCorpus(DEFAULT_SEED).map((s) => s.name));
  for (const n of [
    "system-prompt",
    "json-whole-pretty",
    "json-first-chunk",
    "json-middle-chunk",
    "json-minified-singleline",
    "log-build",
    "log-shell-test",
    "search-ripgrep",
    "lines-numbered",
    "diff-git",
    "prose-english",
    "prose-cjk",
    "config-yaml",
    "code-singleline-200kb",
    "small-file",
  ]) {
    assert.ok(names.has(n), `missing shape ${n}`);
  }
});

test("corpus sizes are in the right class (not toys, not absurd)", () => {
  const c = generateCorpus(DEFAULT_SEED);
  const by = new Map(c.map((s) => [s.name, s]));
  assert.ok(by.get("json-whole-pretty")!.content.length > 60_000, "whole pretty dump is ≥ 60KB");
  assert.ok(by.get("json-whole-pretty")!.content.length < 300_000);
  assert.ok(by.get("code-singleline-200kb")!.content.length > 150_000, "code single-line is ≥ 150KB");
  assert.ok(by.get("code-singleline-200kb")!.content.split("\n").length <= 3, "still one line (+header)");
  assert.ok(by.get("small-file")!.content.length < 3_000, "small file is small");
  assert.ok(by.get("system-prompt")!.liveZone === false);
});

test(
  "E1 runs, is sane, and writes nothing to the repo",
  { timeout: 60_000 },
  async () => {
  const r = await runE1();
  // Sane bounds: the live zone must not be untouched (0%) and must not be
  // "compressed" below 5% (that would mean destruction, not compression).
  assert.ok(r.ratio > 0, "something compressed");
  assert.ok(r.ratio < 0.95, "not suspiciously total");
  assert.ok(r.inChars > 100_000, "corpus is a real session, not a toy");
  assert.ok(r.i1Holds, "I1: system prompt untouched");
  assert.ok(r.i3Holds, "I3: nothing grew");
  assert.ok(r.shapes.length >= 10, "most shapes measured");
  // The report is a well-formed machine document.
  const rep = e1ToReport(r, DEFAULT_SEED, "test");
  const doc = JSON.parse(JSON.stringify(rep));
  assert.equal(doc.eval, "e1");
  assert.equal(typeof doc.target.actual, "number");
  assert.equal(typeof doc.pass, "boolean");
  }
);

test("E1 target constant is the published one", () => {
  assert.equal(E1_TARGET_RATIO, 0.6);
});

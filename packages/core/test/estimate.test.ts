import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, countWords } from "../src/estimate.ts";

test("empty text is zero tokens", () => {
  assert.equal(estimateTokens(""), 0);
});

test("roughly 4 chars per token for ascii", () => {
  const n = 4000;
  const t = estimateTokens("a".repeat(n));
  assert.ok(t > 800 && t < 1200, `expected ~1000, got ${t}`);
});

test("cjk costs about one token per char", () => {
  const t = estimateTokens("中".repeat(100));
  assert.ok(t >= 90 && t <= 130, `expected ~100, got ${t}`);
});

test("multiline text costs more than flat text of same length", () => {
  const flat = "ab cd".repeat(100);
  const lined = Array.from({ length: 100 }, () => "ab cd").join("\n");
  assert.ok(estimateTokens(lined) > estimateTokens(flat));
});

test("countWords handles whitespace runs and empty", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("a  b\n c\t\td"), 4);
  assert.equal(countWords("   "), 0);
});

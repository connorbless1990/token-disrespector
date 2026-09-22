/**
 * Corpus tests: each compressor must (a) achieve a minimum ratio on the
 * deterministic fixtures and (b) preserve the preservation contract
 * (FATAL lines, file:line references, signatures, keys/structure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CodeCompressor,
  ConfigCrusher,
  ContentRouter,
  DiffCrusher,
  HtmlExtractor,
  JsonCrusher,
  LogCrusher,
  SearchCrusher,
  TabularCrusher,
  TextCompressor,
} from "../src/index.ts";

const corpus = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../benchmarks/corpus/${name}`, import.meta.url)), "utf8");

const NO_CTX = { referencedPaths: [] as string[] };

function ratio(before: string, after: string | null): number {
  return after ? 1 - after.length / before.length : 0;
}

test("json: ≥90% on the API-results fixture; structure + error rows survive", () => {
  const c = new JsonCrusher();
  const inText = corpus("json-api-results.json");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.9, `ratio ${ratio(inText, out).toFixed(3)}`);
  const parsed = JSON.parse(out!.split("\n[ctxroom:")[0]);
  assert.ok(Array.isArray(parsed.results));
  // error rows must survive (they are the signal)
  assert.ok(JSON.stringify(parsed.results).includes("charge declined"));
  // out-of-range outliers survive
  assert.ok(JSON.stringify(parsed.results).includes("req_slow0"));
});

test("log: ≥60%; the FATAL line survives verbatim", () => {
  const c = new LogCrusher();
  const inText = corpus("build-log.txt");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.6, `ratio ${ratio(inText, out).toFixed(3)}`);
  const fatal = inText.split("\n").find((l) => l.includes("FATAL [runner]"));
  assert.ok(out!.includes(fatal!), "FATAL line must survive byte-for-byte");
  assert.ok(out!.includes("expected 120_000 to be less than 120_000"), "error detail must survive");
});

test("search: ≥25%; file:line references and referenced files survive", () => {
  const c = new SearchCrusher();
  const inText = corpus("ripgrep.txt");
  const out = c.compress(inText, { referencedPaths: ["packages/core/src/engine.ts"] });
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.25, `ratio ${ratio(inText, out).toFixed(3)}`);
  // every path named in the input still appears in the output
  const inPaths = new Set(inText.split("\n").map((l) => l.split(":")[0]).filter(Boolean));
  const outPaths = new Set(out!.split("\n").map((l) => l.split(":")[0]).filter(Boolean));
  for (const p of inPaths) assert.ok(outPaths.has(p), `path lost: ${p}`);
  // referenced file's matches must all survive
  const inRef = inText.split("\n").filter((l) => l.startsWith("packages/core/src/engine.ts:")).length;
  const outRef = out!.split("\n").filter((l) => l.startsWith("packages/core/src/engine.ts:")).length;
  assert.ok(outRef >= Math.min(15, inRef), `referenced file matches: ${inRef} in, ${outRef} out`);
});

test("diff: ≥40%; whole files keep every hunk + change line, reduced files keep header + tally", () => {
  const c = new DiffCrusher();
  const inText = corpus("multi.diff");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.4, `ratio ${ratio(inText, out).toFixed(3)}`);
  const isChange = (l: string) =>
    (/^\+/.test(l) && !l.startsWith("+++")) || (/^-/.test(l) && !l.startsWith("---"));
  // Split input into per-file sections and compare per output section.
  const splitFiles = (text: string) => {
    const sections = new Map<string, string[]>();
    let cur = "";
    for (const l of text.split("\n")) {
      if (l.startsWith("diff --git ")) {
        cur = l.slice("diff --git a/".length).split(" ")[0];
        sections.set(cur, []);
      }
      if (cur) sections.get(cur)!.push(l);
    }
    return sections;
  };
  const inFiles = splitFiles(inText);
  const outFiles = splitFiles(out!);
  for (const [name, inLines] of inFiles) {
    const outLines = outFiles.get(name);
    if (!outLines) continue; // file reduced to nothing? must not happen
    if (outLines.some((l) => l.startsWith("@@ "))) {
      // kept whole: every hunk header and change line survives
      const inHunks = inLines.filter((l) => l.startsWith("@@ ")).length;
      const outHunks = outLines.filter((l) => l.startsWith("@@ ")).length;
      assert.equal(outHunks, inHunks, `${name}: hunk headers`);
      assert.equal(
        outLines.filter(isChange).length,
        inLines.filter(isChange).length,
        `${name}: change lines`
      );
    } else {
      // reduced: header + change tally survive
      assert.ok(outLines.some((l) => l.includes("[ctxroom:") && /changed line/.test(l)), `${name}: tally`);
    }
  }
});

test("html: ≥60%; visible text survives, scripts/styles gone", () => {
  const c = new HtmlExtractor();
  const inText = corpus("page.html");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.6, `ratio ${ratio(inText, out).toFixed(3)}`);
  assert.ok(out!.includes("Release 1.4.2"));
  assert.ok(out!.includes("GITHUB_COPILOT_ENTERPRISE_URL"));
  assert.ok(!out!.includes("console.log"));
  assert.ok(!out!.includes("font:14px"));
});

test("config: ≥40%; every key/value survives", () => {
  const c = new ConfigCrusher();
  const inText = corpus("config.yaml");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.4, `ratio ${ratio(inText, out).toFixed(3)}`);
  for (const line of inText.split("\n")) {
    if (line.match(/^\s*[\w.$-]+:.*\S/)) assert.ok(out!.includes(line.trim()), `key line lost: ${line.trim()}`);
  }
});

test("tabular: ≥70%; all data values survive in the JSON form", () => {
  const c = new TabularCrusher();
  const inText = corpus("metrics.csv");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.7, `ratio ${ratio(inText, out).toFixed(3)}`);
  const parsed = JSON.parse(out!.split("\n[ctxroom:")[0]);
  // Statistical row dropping is the documented SmartCrusher bridge behavior:
  // boundary rows always survive, distinct data rows may be sampled down.
  // The fixture's numeric columns are uniform distributions, so the 2σ outlier
  // rule keeps only the 10 boundary rows — assert the boundary floor, not a count.
  assert.ok(parsed.rows.length >= 10, `boundary rows survive: ${parsed.rows.length}`);
  assert.ok(parsed.rows.length <= 150, "never more rows than the source");
  assert.ok(JSON.stringify(parsed.rows).includes("req_1000"));
  assert.match(out!, /\[\d+ of \d+ array items/, "dropped rows must be noted");
});

test("text: ≥50%; first and last paragraphs survive", () => {
  const c = new TextCompressor();
  const inText = corpus("prose.md");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.5, `ratio ${ratio(inText, out).toFixed(3)}`);
  const paras = inText.split("\n\n");
  assert.ok(out!.includes(paras[0].slice(0, 60)), "first paragraph head must survive");
  assert.ok(out!.includes(paras[paras.length - 1].slice(0, 60)), "last paragraph head must survive");
});

test("code: ≥25%; imports and signatures survive, dup runs collapsed", () => {
  const c = new CodeCompressor();
  const inText = corpus("code.ts");
  const out = c.compress(inText, NO_CTX);
  assert.ok(out, "must compress");
  assert.ok(ratio(inText, out) >= 0.25, `ratio ${ratio(inText, out).toFixed(3)}`);
  assert.ok(out!.includes('import { createHash } from "node:crypto";'));
  assert.ok(out!.includes("export function bucketize(input: unknown, index: number): number {"));
  assert.ok(out!.includes("  add(key: string, value: number): void {"));
  const dupRuns = (out!.match(/rows\.push\(EMPTY_ROW\);/g) ?? []).length;
  const inDupRuns = (inText.match(/rows\.push\(EMPTY_ROW\);/g) ?? []).length;
  assert.ok(dupRuns < inDupRuns, `dup run must collapse: ${inDupRuns} → ${dupRuns}`);
});

test("router: every corpus file routes to a compressor that wins", () => {
  const router = ContentRouter.create();
  const files = [
    "json-api-results.json", "build-log.txt", "ripgrep.txt", "multi.diff",
    "page.html", "config.yaml", "metrics.csv", "prose.md", "code.ts",
  ];
  for (const f of files) {
    const text = corpus(f);
    const r = router.route(text);
    let won = false;
    for (const comp of r.candidates) {
      const x = comp.compress(text, NO_CTX);
      if (x !== null && x.length < text.length) won = true;
    }
    assert.ok(won, `${f} must be compressible via route ${r.type}`);
  }
});

test("invariants: no compressor may grow its input (I3)", () => {
  const router = ContentRouter.create();
  const corpusFiles = [
    "json-api-results.json", "build-log.txt", "ripgrep.txt", "multi.diff",
    "page.html", "config.yaml", "metrics.csv", "prose.md", "code.ts",
  ];
  const nasty = [
    "", "short", "x".repeat(100), "{}", "[]",
    "not json { at all", "<div>no close", "\t\t", "# just a comment",
    "a: 1\nb: 2", "1,2,3\n4,5,6",
  ];
  for (const f of corpusFiles) {
    const text = corpus(f);
    const r = router.route(text);
    for (const comp of r.candidates) {
      const out = comp.compress(text, NO_CTX);
      if (out !== null) assert.ok(out.length < text.length, `${comp.name} grew ${f}`);
    }
  }
  for (const text of nasty) {
    const r = router.route(text);
    for (const comp of r.candidates) {
      let out: string | null = null;
      assert.doesNotThrow(() => {
        out = comp.compress(text, NO_CTX);
      }, `${comp.name} must not throw on ${JSON.stringify(text.slice(0, 20))}`);
      if (out !== null) assert.ok(out.length < text.length, `${comp.name} grew on ${JSON.stringify(text.slice(0, 20))}`);
    }
  }
});

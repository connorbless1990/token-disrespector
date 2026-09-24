/**
 * TemplateReformatter (A3) — Drain-style lossless reformat.
 *
 * The core claim is LOSSLESSNESS: every original unit reconstructs from the
 * emitted template + variant stream. These tests parse the output back into
 * units and compare against the input, plus the no-growth / passthrough
 * contracts and the engine's CCR-off allowance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, TemplateReformatter, resolveEngineConfig } from "../src/index.ts";

const NO_CTX = { referencedPaths: [] as string[] };

/** Rebuild the original units from a line-mode reformat (template + variants). */
function reconstructLineMode(input: string, output: string): string {
  const outLines = output.split("\n");
  const rebuilt: string[] = [];
  let template: string[] | null = null;
  let expect = 0;
  for (const line of outLines) {
    const m = line.match(/^\[ctxroom:template T\d+: (.*)\] \((\d+) occ\)$/);
    if (m) {
      template = m[1]!.split(" ");
      expect = parseInt(m[2]!, 10);
      continue;
    }
    if (template !== null) {
      const values = line.split(" ");
      const filled = template.map((t) => (t === "<*>" ? values.shift() ?? "" : t));
      rebuilt.push(filled.join(" "));
      if (values.length > 0) throw new Error(`variant has extra values: ${values}`);
      expect--;
      if (expect === 0) template = null;
    } else {
      rebuilt.push(line);
    }
  }
  if (template !== null) throw new Error("dangling template");
  return rebuilt.join("\n");
}

test("lossless: 300-line repetitive log round-trips exactly", () => {
  const c = new TemplateReformatter();
  assert.equal(c.lossless, true);
  // Single spaces throughout: the reformat normalizes whitespace runs, so a
  // byte-exact round-trip is only promised for single-space input.
  const lines = Array.from({ length: 300 }, (_, i) =>
    `2026-09-21T10:00:${String(i % 60).padStart(2, "0")}.000Z INFO [vite] transforming src/file${i % 7}.ts chunk ${i} (1${i % 9}2 ms)`
  );
  const text = lines.join("\n");
  const out = c.compress(text, NO_CTX);
  assert.ok(out, "must shrink");
  assert.ok(out!.length < text.length);
  assert.equal(reconstructLineMode(text, out!), text, "every line must reconstruct");
});

test("diverse prose is not template-like: passes through (null)", () => {
  const c = new TemplateReformatter();
  const lines = Array.from(
    { length: 60 },
    (_, i) =>
      `The ${["river", "mountain", "city", "forest"][i % 4]} of ${["spring", "autumn", "winter", "summer"][i % 4]} was ${["quiet", "loud", "grey", "gold"][i % 4]} when the ${["wind", "rain", "fog", "dawn"][i % 4]} arrived at ${["dusk", "noon", "dawn", "midnight"][i % 4]}.` +
      // Vary the token COUNT per line (13/12/12) so runs break into pieces
      // shorter than min_run — Drain cannot template across count changes.
      (i % 3 === 0 ? " plus a trailing phrase" : i % 3 === 1 ? " trailing" : "")
  );
  const out = c.compress(lines.join("\n"), NO_CTX);
  assert.equal(out, null, "nothing collapses → refuse (never grow)");
});

test("never grows: adversarial near-repetitive input returns null, not bloat", () => {
  const c = new TemplateReformatter();
  // Two-token lines alternating: template would have 0-1 constants.
  const text = Array.from({ length: 40 }, (_, i) => (i % 2 ? "alpha" : "beta")).join("\n");
  const out = c.compress(text, NO_CTX);
  if (out !== null) assert.ok(out.length < text.length, "I3: must shrink or refuse");
});

test("statement mode: 5000-statement single-line bundle compresses, stays one line", () => {
  const c = new TemplateReformatter();
  const stmts = Array.from(
    { length: 5000 },
    (_, i) => `const v${i % 64} = ${(i * 3) % 512} /* token ${i % 7} */;`
  );
  const text = stmts.join(" ");
  const out = c.compress(text, NO_CTX);
  assert.ok(out, "must shrink");
  assert.ok(!out!.includes("\n"), "statement-mode output is a single line");
  assert.ok(out!.length < text.length, "I3");
  // Losslessness by reconstruction: fill the template's wildcards with each
  // variant row, in order, and the original token stream must reappear.
  const m = out!.match(/^\[ctxroom:template T\d+: (.*)\] \((\d+) occ\)(?: (.*))?$/);
  assert.ok(m, "one template + variant stream");
  const template = m![1]!.split(" ");
  const n = parseInt(m![2]!, 10);
  const rows = (m![3] ?? "").split(" ");
  let ri = 0;
  for (let k = 0; k < n; k++) {
    const filled: string[] = [];
    for (const t of template) {
      if (t === "<*>") filled.push(rows[ri++]!);
      else filled.push(t);
    }
    // Re-joined statement must equal the original statement (the input is
    // single-spaced, so the normalized form is byte-identical).
    assert.equal(filled.join(" "), stmts[k]!, `statement ${k} reconstructs`);
  }
  assert.equal(ri, rows.length, "every variant value consumed exactly once");
});

test("engine: lossless reformat applies with the CCR disabled (I8 refined)", async () => {
  const lines = Array.from({ length: 300 }, (_, i) =>
    `2026-09-21T10:00:${String(i % 60).padStart(2, "0")}Z INFO [vite] transforming src/file${i % 7}.ts chunk ${i} (1${i % 9}2 ms)`
  ).join("\n");
  const cfg = resolveEngineConfig(
    { ccr: { enabled: false, dir: join(mkdtempSync(join(tmpdir(), "ctxroom-tpl-")), "ccr") } },
    {} as NodeJS.ProcessEnv
  );
  const engine = new Engine(cfg);
  const out = await engine.compress([{ role: "tool", tool_call_id: "c1", content: lines }]);
  const fwd = out.forwardTexts[0];
  assert.ok(fwd !== null, "the repetitive log must be compressed even with CCR off");
  const s = typeof fwd === "string" ? fwd : Array.isArray(fwd) ? fwd[0]! : "";
  assert.ok(s.length < lines.length, "I3: strictly smaller");
  assert.ok(!s.includes("compressed "), "no CCR marker on a reformat");
  const t = out.transforms.find((x) => x.messageIndex === 0);
  assert.equal(t?.transform, "reformat");
  const stats = await engine.ccrStore.stats();
  assert.equal(stats.entries, 0, "no CCR writes for a lossless reformat");
});

test("engine: a reformat is stable on resubmission (I2 + idempotence)", async () => {
  const lines = Array.from({ length: 300 }, (_, i) =>
    `2026-09-21T10:00:${String(i % 60).padStart(2, "0")}Z INFO [vite] transforming src/file${i % 7}.ts chunk ${i} (1${i % 9}2 ms)`
  ).join("\n");
  const cfg = resolveEngineConfig(
    { ccr: { enabled: true, dir: join(mkdtempSync(join(tmpdir(), "ctxroom-tpl-")), "ccr") } },
    {} as NodeJS.ProcessEnv
  );
  const engine = new Engine(cfg);
  const m1 = { role: "tool" as const, tool_call_id: "c1", content: lines };
  const first = await engine.compress([m1]);
  const f0 = first.forwardTexts[0];
  const reformatted = typeof f0 === "string" ? f0 : Array.isArray(f0) ? f0[0]! : null;
  assert.ok(reformatted, "first pass reformats");
  // The client's second request carries the SAME original (its own copy):
  const second = await engine.compress([m1]);
  assert.deepEqual(
    second.forwardTexts[0],
    first.forwardTexts[0],
    "frozen prefix re-forwards the stored (reformatted) form byte-identically"
  );
  // And a part already containing reformat markers is never re-mined:
  const third = await engine.compress([
    { role: "tool", tool_call_id: "c2", content: reformatted! },
  ]);
  const t3 = third.transforms[0];
  assert.equal(t3?.transform, "already-compressed", "the marker guard fires");
  const fwd3 = third.forwardTexts[0];
  // null = "forward the submitted content unchanged" — exactly the reformat.
  const text3 =
    typeof fwd3 === "string" ? fwd3 : Array.isArray(fwd3) ? fwd3[0]! : reformatted!;
  assert.equal(text3, reformatted!, "already-reformatted content passes through verbatim");
});

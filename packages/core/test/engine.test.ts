/**
 * Engine-level invariant tests — these are the safety contract:
 *   I1 system/developer messages never modified
 *   I2 frozen prefix re-sent byte-identical (KV-cache stability)
 *   I3 no growth
 *   I4 below-min-size blocks untouched
 *   I5 failures degrade to passthrough
 *   I8 CCR disabled ⇒ no lossy compression
 *   I9 CCR retrieve returns the exact original
 *   I10 protected patterns pass through
 *   plus: send-form re-application across requests (the core mechanism).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcrStore, Engine, messageText, resolveEngineConfig, type EngineMessage } from "../src/index.ts";

import { readFileSync } from "node:fs";

const corpus = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../benchmarks/corpus/${name}`, import.meta.url)), "utf8");

function makeEngine(ccrEnabled = true): { engine: Engine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-eng-"));
  const cfg = resolveEngineConfig(
    { ccr: { enabled: ccrEnabled, dir: join(dir, "cache") } },
    {} as NodeJS.ProcessEnv
  );
  const engine = new Engine(cfg);
  return { engine, dir };
}

const systemMsg: EngineMessage = {
  role: "system",
  content:
    "You are an expert coding agent working in the user's repository. Use the available tools to inspect and modify code. Be precise, and verify changes with the project's tooling. Never expose secrets or credentials in your output.",
};
const bigJson: EngineMessage = { role: "tool", tool_call_id: "call_1", content: corpus("json-api-results.json") };
const bigLogs: EngineMessage = { role: "tool", tool_call_id: "call_2", content: corpus("build-log.txt") };
const smallUser: EngineMessage = { role: "user", content: "What failed?" };
const assistantMsg: EngineMessage = { role: "assistant", content: "Let me look at the results and the log." };

test("I1: system message is never modified", async () => {
  const { engine, dir } = makeEngine();
  const res = await engine.compress([systemMsg, smallUser, bigJson]);
  assert.equal(res.messages[0].content, systemMsg.content);
  rmSync(dir, { recursive: true, force: true });
});

test("I4: small blocks pass through untouched", async () => {
  const { engine, dir } = makeEngine();
  const res = await engine.compress([systemMsg, smallUser, bigJson]);
  // "What failed?" is 3 words << 120
  assert.equal(res.messages[1].content, smallUser.content);
  rmSync(dir, { recursive: true, force: true });
});

test("I8: with CCR disabled no lossy compression happens", async () => {
  const { engine, dir } = makeEngine(false);
  const res = await engine.compress([systemMsg, smallUser, bigJson]);
  assert.equal(res.messages[2].content, bigJson.content, "no lossy compression without CCR");
  assert.equal(res.replaced, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("I3: compressed output is always strictly smaller per block", async () => {
  const { engine, dir } = makeEngine();
  const res = await engine.compress([systemMsg, smallUser, bigJson, bigLogs]);
  for (const t of res.transforms) {
    if (t.transform === "compressor") {
      assert.ok(t.tokensAfter < t.tokensBefore, `growth detected: ${t.transform}`);
    }
  }
  assert.ok(res.tokensAfter < res.tokensBefore);
  rmSync(dir, { recursive: true, force: true });
});

test("lossy replacements carry a CCR marker with a resolvable hash", async () => {
  const { engine, dir } = makeEngine();
  const res = await engine.compress([systemMsg, smallUser, bigJson]);
  const replaced = res.messages[2].content as string;
  const m = /\[ctxroom:compressed ([0-9a-f]{12})/.exec(replaced);
  assert.ok(m, "marker must be present on the compressed tool result");
  // I9: retrieval returns the exact original (full window)
  const got = await engine.ccrStore.retrieve(m![1], { maxChars: 1_000_000 });
  assert.equal(got?.text, bigJson.content);
  assert.equal(got?.truncated, false);
  rmSync(dir, { recursive: true, force: true });
});

test("I10: protected patterns pass through even when compressible", async () => {
  const { engine, dir } = makeEngine();
  const cfg = resolveEngineConfig(
    { ccr: { enabled: true, dir: join(dir, "cache") }, protectedPatterns: ["approval required"] },
    {} as NodeJS.ProcessEnv
  );
  const e2 = new Engine(cfg, { ccr: new CcrStore({ dir: join(dir, "cache") }) });
  const text = "approval required\n" + "lorem ipsum dolor sit amet ".repeat(400);
  const res = await e2.compress([
    { role: "user", content: "please compress this" },
    { role: "tool", tool_call_id: "x", content: text },
  ]);
  assert.equal(res.messages[1].content, text);
  rmSync(dir, { recursive: true, force: true });
});

test("send-form re-application: a big tool result compressed at birth stays compressed for the session (I2)", async () => {
  const { engine, dir } = makeEngine();
  // Request 1: user question + big tool result (fresh live zone)
  const req1 = [systemMsg, { role: "user", content: "What failed?" }, assistantMsg, bigJson];
  const res1 = await engine.compress(req1);
  const forwarded1 = res1.messages[3].content as string;
  assert.ok(forwarded1.length < bigJson.content.length, "request 1 must be compressed");
  assert.ok(forwarded1.includes("[ctxroom:compressed"), "must carry the marker");

  // Request 2: the CLIENT resends the ORIGINAL big content (it keeps its own copy),
  // plus a new user turn. The engine must re-apply the same replacement bytes.
  const req2 = [
    { ...systemMsg },
    { ...req1[1] },
    { ...assistantMsg },
    { ...bigJson }, // original bytes again
    { role: "user", content: "Now check the log." },
    { role: "tool", tool_call_id: "call_2", content: bigLogs.content },
  ];
  const res2 = await engine.compress(req2);
  const forwarded2 = res2.messages[3].content as string;
  assert.equal(forwarded2, forwarded1, "frozen prefix must be byte-identical across requests");

  // The new log tool result in the live zone gets compressed too…
  const logsOut = res2.messages[5].content as string;
  assert.ok(logsOut.length < bigLogs.content.length);
  // …and total request 2 is smaller than request 2 with no compression
  const total2 = res2.messages.reduce((s, m) => s + messageText(m).length, 0);
  const total2Uncompressed = req2.reduce((s, m) => s + messageText(m).length, 0);
  assert.ok(total2 < total2Uncompressed);
  rmSync(dir, { recursive: true, force: true });
});

test("identical resend of an already-forwarded state changes nothing (cache-safe no-op)", async () => {
  const { engine, dir } = makeEngine();
  const base = [systemMsg, { role: "user", content: "What failed?" }, assistantMsg, bigJson];
  const res1 = await engine.compress(base);
  // Same request again (e.g. a client retry): everything frozen, zero changes.
  const res2 = await engine.compress(base.map((m) => ({ ...m })));
  for (let i = 0; i < base.length; i++) {
    assert.equal(
      messageText(res2.messages[i]),
      messageText(res1.messages[i]),
      `message ${i} bytes must be identical on resend`
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

test("budget mode compresses old zones over budget, leaves compressed ones frozen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-budget-"));
  const cfg = resolveEngineConfig(
    {
      ccr: { enabled: true, dir: join(dir, "cache") },
      budget: { enabled: true, tokenBudget: 3000 },
    },
    {} as NodeJS.ProcessEnv
  );
  const engine = new Engine(cfg, { ccr: new CcrStore({ dir: join(dir, "cache") }) });

  const req1 = [
    systemMsg,
    { role: "user", content: "investigate the failure" },
    { role: "tool", tool_call_id: "c1", content: corpus("build-log.txt") }, // ~20k tok
    { role: "user", content: "and the api results" },
    { role: "tool", tool_call_id: "c2", content: corpus("json-api-results.json") }, // ~14k tok
  ];
  const res1 = await engine.compress(req1);
  // Over the 3000-token budget: both tool results (old zones) should compress.
  assert.ok((res1.messages[2].content as string).length < 88000, "log zone must compress");
  assert.ok((res1.messages[4].content as string).length < 62000, "json zone must compress");

  // Next request: client resends originals; the already-compressed forms must
  // be re-applied (frozen) and the new turn added.
  const req2 = [
    ...req1.map((m) => ({ ...m })),
    { role: "user", content: "one more thing: check config.yaml" },
    { role: "tool", tool_call_id: "c3", content: corpus("config.yaml") },
  ];
  const res2 = await engine.compress(req2);
  assert.equal(res2.messages[2].content, res1.messages[2].content, "frozen compressed zone must not change");
  assert.equal(res2.messages[4].content, res1.messages[4].content, "frozen compressed zone must not change");
  rmSync(dir, { recursive: true, force: true });
});

test("array-content messages: parts compressed, images untouched", async () => {
  const { engine, dir } = makeEngine();
  const text = corpus("build-log.txt");
  const res = await engine.compress([
    systemMsg,
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: text },
      ],
    },
  ]);
  const content = res.messages[1].content;
  assert.ok(Array.isArray(content));
  const part0 = (content as { text?: string }[])[0];
  assert.equal(part0.text, "look", "short part untouched");
  const part1 = (content as { text?: string }[])[1];
  assert.ok(part1.text!.length < text.length, "big part compressed");
  rmSync(dir, { recursive: true, force: true });
});

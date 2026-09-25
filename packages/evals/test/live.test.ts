/**
 * B7 — live-gated tests: the §6-E4 harness as a node:test test.
 *
 * Skipped unless CTXROOM_LIVE_EVAL=1 (never runs in CI / `npm test`);
 * with the gate on it drives the FULL production stack: real copilot CLI,
 * real local model, real proxy, real CCR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runE4 } from "../src/e4.ts";

test(
  "B7: live end-to-end — copilot + model + proxy + CCR",
  {
    timeout: 1_200_000,
    skip:
      process.env.CTXROOM_LIVE_EVAL === "1"
        ? false
        : "live-gated: set CTXROOM_LIVE_EVAL=1 (and a reachable local model) to run",
  },
  async () => {
    const r = await runE4();
    assert.equal(r.pass, true, r.text);
  }
);

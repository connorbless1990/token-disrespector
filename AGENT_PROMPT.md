# Brief for the next agent: production-grade tests + evaluations, and closing the Headroom gap

You are taking over a finished-looking project that has one serious open
wound. Your job has three parts, in order: **(A)** fix the known
defects, **(B)** build the near-production test suite, **(C)** build the
evaluation harness that can honestly answer "does this match Headroom?"
You will commit per milestone. This brief is self-contained; you do not
need any other context.

---

## 1. The project

**ctxroom** — local-first context compression for AI coding agents. It
sits between an agent CLI (today: the GitHub Copilot CLI) and the model,
compresses big text blocks in the agent's *requests*, stores each
original on local disk (CCR, content-addressed), leaves a
`[ctxroom:compressed <12-hex-handle> · …]` marker in the block, and
re-forwards byte-identical replacements so the model server's
byte-prefix KV cache never breaks. A small MCP stdio server gives the
model a `ctxroom_retrieve <handle>` tool to fetch originals back.

```
repo root:   /Users/akshaysingh/Dev/Deepseek        (the whole repo IS ctxroom)
Node:        >= 23.6 (type stripping; code is erasable TypeScript, .ts imports)
runtime:     ZERO dependencies (node built-ins only) — this includes tests (use node:test)
network:     loopback-only (127.0.0.1); zero telemetry; nothing leaves the machine
```

| package | role |
|---|---|
| `packages/core` | the engine: 9 compressors + `ContentRouter` (`src/compressors/index.ts`), the engine loop (`src/compress.ts`), CCR store (`src/ccr.ts`), token/word estimates (`src/estimate.ts`), config (`src/config.ts`) |
| `packages/proxy` | loopback HTTP proxy: route matching (`src/normalize.ts` → `compressibleRoute`), request pipeline + stats JSONL (`src/server.ts`), upstream (`src/upstream.ts`) |
| `packages/mcp` | hand-rolled MCP stdio server: `ctxroom_retrieve`, `ctxroom_stats` |
| `packages/cli` | the `ctxroom` binary (`src/index.ts`), copilot integration (`src/copilot.ts`: findCopilot, classifyBuild, scanBundle, env matrix, MCP config merge), `src/doctor.ts` |
| `e2e/` | mock-Copilot end-to-end (11 checks, all pass) |
| `benchmarks/` | seeded corpus + ratio table (`npm run gen`, `npm run bench`) |

Run everything with: `npm test` (90 tests, green), `npm run check`
(typecheck), `npm run bench`, `npm run e2e`, and
`node packages/cli/src/index.ts <cmd>`.

**Hard constraints — never break these, even to make a number look
better:**

- Invariants (all currently pinned by tests): system/developer messages
  untouched; frozen prefix re-sent byte-identical; no compressor output
  may be ≥ its input (else passthrough); blocks under ~120 words
  (chars/4 floor for whitespace-free text) untouched; any failure ⇒
  byte-transparent passthrough; CCR off ⇒ no lossy compression; retrieve
  returns the exact original; protected-pattern blocks pass through.
- Responses (SSE/JSON) are never modified — requests only.
- Loopback-only; zero telemetry; zero runtime deps.

---

## 2. What already works (verified live — do not re-derive, just build on)

- The real Copilot CLI on the dev machine is **v1.0.88, a native binary**:
  an npm loader (`npm-loader.js`, 1.2 KB) that spawns a 152 MB platform
  binary (`@github/copilot-darwin-arm64/copilot`) whose embedded JS is
  *compressed* — string grepping for env knobs finds nothing. Both
  `COPILOT_API_URL` and `COPILOT_PROVIDER_*` were verified honored
  empirically (dead-port probe + a successful local-model session).
- The CLI registers MCP servers in `~/.copilot/mcp-config.json`
  (older builds: `mcp.json`); the shape it writes is
  `{"type":"local","tools":["*"],"command":…,"args":…}`. ctxroom's
  merge/unwrap handles that (marked block + `.ctxroom.bak`).
- A full live chain works: `ctxroom copilot --lane byok --model
  incoai/Qwen3.8-27B-Splash` with `CTXROOM_COPILOT_API_URL=
  http://localhost:8000` (endpoint ROOT, no `/v1` — the proxy preserves
  the client's path) ran a 12–24 minute agent session on a local Qwen
  model over Tailscale, no GitHub login. **Every request went through
  the proxy** (stats rows prove it).
- Bench on the seeded corpus: 65.0% total char savings; JSON 95.2%,
  logs 70.1%, csv 77.4%, search 32.1%, diff 44.5%, html 72.7%, config
  49.4%, prose 64.7%, code 30.2%.

## 3. The wound: live compression has never fired

Across four live copilot sessions the proxy recorded 0 tokens saved in
every request. Root causes, in the order found:

1. **Fixed (commit `5ccf729`), verify + regression-pin:** the I4
   small-block gate counted *whitespace words*; a 41 KB *minified* JSON
   line = 1 word = silently skipped. The gate now floors at chars/4.
2. **OPEN — the main fix:** the copilot read tool returns big files in
   **~700-line chunks**. An indented JSON file therefore arrives as
   fragments that are not valid JSON → `ContentRouter.route()` fails its
   `JSON.parse` check → falls through to tabular/text → no shrinker
   strictly shrinks structured text → `passthrough`.
3. **OPEN — the second fix:** copilot's tools **truncate** long output.
   The model itself reported seeing `[Output truncated…]` notices and a
   "saved to /var/folders/…/copilot-tool-output-*.txt" pointer. The
   block in the request is therefore *wrapper + shortened document*, not
   the document: the first character is not `{`/`[`, so the JSON route
   never runs. (Observed routing: `passthrough:tabular` on a 41 KB
   minified JSON block — the router even mis-classified it.)

So today ctxroom is a **reliable transparent loop with a proven engine
that has never once compressed a real session.** A "proper Headroom
product" compresses real sessions. That is the gap you close.

Also known (lower priority, evaluate first, fix if cheap):
- `cat file | copilot -p "…"` does not deliver the stdin content to the
  model on 1.0.88 (it was consumed but never appeared in context).
- The native-binary lane is a *verified assumption*: the doctor cannot
  tell if a future build stops honoring the env knobs. After a copilot
  run that exited cleanly, if the proxy saw **zero** requests for the
  session, the CLI should print that diagnosis.
- BYOK lane on 1.0.88 says `BYOK providers require an explicit model.
  Run copilot help providers` — explore that subcommand; multi-model
  BYOK (provider registry) may be the right shape.

---

## 4. Work package A — fix the shape problem

Design rule: **compress the document, keep the wrapper honest, store the
whole original.** The CCR store already stores the original block
verbatim, so losslessness is free; the problem is purely *detection*.

1. In `ContentRouter.route()`, add an unwrap step *before* type
   detection: recognize tool-output wrappers — leading path/line
   prefixes (`path:line:`, `path:`, bare filename lines), trailing or
   embedded `[Output truncated…]`-style notices, "saved to …" pointer
   lines — and route on the *inner document* when ≥ ~90% of the sample
   is document. When a compressor shrinks the inner document, the
   replacement keeps the wrapper visible (wrapper + marker + shrunk
   body) and the CCR stores the *full original block*. The block the
   model receives must remain byte-reconstructable via retrieve.
2. Add a **structural-fragment** path for chunked reads: when a block
   looks like a middle slice of a larger document (starts/ends mid-
   structure, high repeated-key density), allow a *conservative*
   dedup-style compressor (keep first/last N + distinct shapes +
   anomalies; drop verbatim repeats). It must respect no-growth and
   store the original; the model can retrieve. Gate it on an eval (§6-E1)
   before shipping it as default.
3. Make the text compressor handle repetitive *structured* text better
   (JSON-ish / key-value-ish lines) — or document precisely why it
   can't and route such blocks to the fragment compressor instead.
4. The doctor/CLI zero-requests diagnostic (§3, third bullet).

Each fix lands with tests, and **the live eval (§6-E4) must show at
least one real compression in a real copilot session** before you call
work package A done.

## 5. Work package B — the near-production test suite

All deterministic and offline by default (node:test, no new deps).

1. **Engine properties** (property-based, `packages/core/test/`): for
   1,000 random blocks (random text / minified JSON / indented JSON /
   logs / diffs / base64 / CJK / 200 KB single line / wrappers from
   §4.1): invariants hold — no growth, idempotent second pass
   (compress(compress(x)) is stable), frozen-prefix byte-stability,
   retrieve(original) == original, protected patterns intact.
2. **Router golden tests**: one file per real shape (the corpus of
   §6-E1 doubles as golden input); assert the routed *type* and the
   expected transform tag.
3. **Proxy integration** (real HTTP, real client, ephemeral ports):
   SSE streaming passthrough byte-identity; dead upstream ⇒ clean 502;
   200 MB body; malformed JSON body ⇒ passthrough; `/p/<project>/`
   attribution; two concurrent sessions; stats row per request.
4. **CCR scale**: 10k entries, TTL eviction, max-entry cap, retrieve
   correctness, disk usage bound.
5. **CLI matrix**: fake install trees (loader+binary, script, binary
   only, dangling symlink) × lanes × MCP shapes ⇒ assert exact env
   matrix, exact config file written, exact block merged, unwrap
   round-trip restores byte-identical original (comment/JSONC shapes:
   array, object, empty, comments present).
6. **MCP stdio**: initialize → tools/list → tools/call(retrieve) over a
   real pipe, including the not-found handle path.
7. **Live-gated tests** (skip unless `CTXROOM_LIVE_EVAL=1`; never in
   CI): the §6-E4 harness as a test.

## 6. Work package C — the evaluation harness

`evals/` package (zero deps; `npm run eval` runs the fast set;
`CTXROOM_LIVE_EVAL=1` adds the slow live set). Each eval prints a
machine-readable JSON report.

- **E1 real-shape corpus + ratio**: the corpus = blocks shaped exactly
  like what real CLIs send: read results (indented/minified/small/big/
  chunked), truncated tool output with wrapper, ripgrep output, shell
  success/error/permission-denied, diffs, long assistant messages,
  system prompts, CJK prose, 200 KB lines, base64. Report per-shape and
  aggregate **live-zone chars compressed**. *Target: ≥ 60% of live-zone
  chars compressed* (the bench corpus's 65% already achieves this on
  clean input; the wrapper/chunk shapes must not drag it below).
- **E2 answer-quality A/B (the flagship)**: a small seeded repo + 20
  factual tasks with known answers (counts, error ids, line quotes,
  function behavior). Run the local model (or a mock scorer) with the
  original context and with the compressed context; score agreement.
  *Target: ≥ 95% agreement; any disagreeing task is published with both
  answers and triaged — if compression changed an answer, fix the
  compressor's retention (keep the relevant rows), never the scorer.*
- **E3 KV-cache byte stability**: a mock provider that hashes request
  prefixes; 10 turns; assert the frozen prefix is byte-identical every
  turn and the live-zone replacement is byte-identical across turns for
  unchanged input. *Target: 100%.*
- **E4 live end-to-end (gated)**: real copilot + local model + seeded
  repo, scripted prompt set. Assert: proxy saw the requests; ≥ 1
  `tokensSaved > 0` row; the model can quote the marker; a retrieve
  round-trip matches the file byte-for-byte; the factual answers are
  correct; exit code propagates.
- **E5 fuzz**: 10k random/garbage bodies at the proxy + engine: no
  crash, always a response, invariants hold.
- **E6 overhead budget**: engine cost per 100 KB request, p50/p99.
  *Target: p99 < 50 ms* (make the number a named constant; if you can't
  meet it, measure honestly and say where the time goes).
- **E7 drift sentinel**: the zero-requests diagnostic from §3.

## 7. Definition of done

1. All pre-existing 90 tests still green; invariants intact (no test
   weakened to pass a number).
2. E1: wrapped and chunked document shapes compress (not passthrough);
   aggregate live-zone chars compressed ≥ 60%.
3. E2: ≥ 95% answer agreement; every disagreement published and triaged.
4. E3: 100% byte-identical re-send; E5: zero crashes; E6: p99 under
   budget; E7: diagnostic fires.
5. E4 (live, gated): at least one real compression + a verified
   retrieve + correct answers in a real copilot session.
6. README updated: the "honest limitations" section reflects what is now
   true (the §3 wound closed or precisely scoped); the proof tiers in
   §5 of the README match what the evals actually show.
7. Work tree clean; `npm test && npm run check && npm run bench &&
   npm run e2e` all green at the end.

## 8. Working rules

- Zero new dependencies, zero telemetry, loopback-only. Erasable TS
  only (no enums/param properties/decorators); relative `.ts` imports.
- Commit per milestone with an honest subject line; never amend history
  of other agents' commits; don't touch files outside this project.
- Determinism: every non-gated test passes offline, repeatably, in < 5
  minutes total. Live evals are gated and budgeted (the local Qwen over
  Tailscale takes 5–20 minutes per run — build the mock-path evals
  first, run the live set last, once).
- Honesty rule: when a target cannot be met, do not fudge it. Publish
  the number, the failing shape, and the one-line reason, and move on.
- The dev machine has: Node v24.16.0 (nvm), copilot 1.0.88 at
  `~/.local/bin/copilot` (symlink → nvm npm global; the 152 MB binary in
  its optional dep), a local OpenAI-compatible server at
  `http://localhost:8000` serving `incoai/Qwen3.8-27B-Splash` (slow).
  Use a mock OpenAI server (node built-ins) for all non-gated work.

## 9. Suggested order

1. §4.1 wrapper unwrap + router goldens (B2) — the highest-leverage fix.
2. §6-E1 corpus + ratio (this tells you the true shape of the problem
   before you write more compressors).
3. §4.2/§4.3 fragment + structured-text compressors, gated on E1.
4. §5.3–5.6 proxy/CCR/CLI/MCP production tests.
5. §6-E2 A/B (mock scorer first, live model last).
6. §6-E3/E5/E6, §4.4 diagnostic, §6-E4 live harness.
7. README truth-update + final green run.

End of brief. The project's philosophy is: **deterministic, local,
reversible, honest.** Every test and number you add should be
re-runnable by a stranger with nothing but Node.

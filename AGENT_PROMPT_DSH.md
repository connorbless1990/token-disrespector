# Brief for the next agent: adapt tds (token-disrespector) to the DeepSeek Harness (DSH) — and measure the real gains

You are taking over two working systems: **tds** (this repo — a local-first context-compression
proxy for AI coding agents) and **DSH** (the DeepSeek Harness — the agent runtime this brief is
being read from). Your mission: route DSH agent model traffic through tds — **config-first,
zero code where possible** — then run a disciplined A/B that answers one question: *how much
does request-side context compression actually speed up, and stabilize, a DSH agent session on
this shared local model, and at what quality cost?*

---

## 1. The two products

### tds (token-disrespector) — the thing being adapted
- Repo: `/Users/akshaysingh/Dev/Deepseek` (private GitHub: connorbless1990/token-disrespector).
  The whole repo IS tds.
- What it is: a loopback compression proxy between an agent CLI and the model. It compresses
  big text blocks in **requests** (never responses), stores each original byte-exact in a local
  content-addressed store (CCR), leaves a `[ctxroom:compressed <12hex-handle> …]` marker,
  re-sends the frozen prefix byte-identically (so the model server's KV cache keeps hitting),
  records per-request stats (tokensBefore/After, transforms, ccrStored, ms) as JSONL, and serves
  an MCP stdio server exposing `ctxroom_retrieve <hash>` + `ctxroom_stats` so the model can
  fetch originals back.
- Packages: `packages/core` (engine: 9 compressors, `ContentRouter`, CCR store, invariants),
  `packages/proxy` (loopback HTTP proxy, upstream, stats), `packages/mcp` (stdio MCP server),
  `packages/cli` (the `tds` binary: copilot / proxy / stats / simulate / retrieve / doctor /
  unwrap), `packages/evals` (E1–E7; **E4 = live end-to-end**, gated by `CTXROOM_LIVE_EVAL`).
- House rules: zero runtime deps, loopback only, zero telemetry, erasable TS on Node ≥ 23.6,
  143-test suite (`npm test`), `npm run check`, bench + e2e + evals.
- Brand seams (intentional — do not "fix" these): the command is `tds`, the product is
  token-disrespector; but `CTXROOM_*` vars, the `~/.ctxroom` data dir, `[ctxroom:…]` markers,
  the `// ctxroom:begin` MCP marker, the MCP server name `ctxroom`, and the `@ctxroom/*` package
  scope all keep the old codename on purpose, so working installs never break on the rename.
- Known quirk: the `npm link`ed `tds` bin **exits silently** — the entry's auto-run guard
  compares `import.meta.url` (realpath) against `pathToFileURL(process.argv[1])` (the symlink
  path), and they never match through a link. Invoke via `npm run tds -- …` or
  `node packages/cli/src/index.ts …`. (A one-line `realpath` fix is welcome as a standalone
  commit, but it is out of scope for the main mission.)
- The **copilot adapter** (`packages/cli/src/copilot.ts`) is your reference implementation for
  thinking about a DSH adapter: locate the agent, build the lane env, merge a marked block into
  the agent's MCP config (pristine backup, `.ctxroom.bak`), ensure/stop the proxy, and the
  A4 zero-requests diagnostic. For DSH, prefer its native seams (§2) over copying this file.

### DSH (DeepSeek Harness) — the thing being adapted to
- Source: https://github.com/deepseek-ai/deepseek-harness (public). On this machine it is an
  npx checkout — find yours with `which dsh` (example seen: `~/.npm/_npx/1e7f6d9597241db0`;
  the path is session-specific). Web GUI: `dsh web` → http://127.0.0.1:3080. DSH home:
  `~/.dsh/` (`settings.yaml` = user override layer, `profiles/`, `sessions/`, `storages/`).
- Architecture (cordis): `dsh` boots a **profile** = an ordered stack of plugin-bundle patch
  layers under your own overrides. `--profile <name>`, `--from-default-profile <name>` (seed a
  custom profile from a shipped template), `--patch <file>` (extra overlay, repeatable),
  `--dump-config` (print the composed tree), `dsh plugin --profile <p> add <pkg>` (plugins are
  pnpm packages per profile).
- Relevant shipped plugins: `@deepseek-ai/dsh-llm-pi-ai` (routes model requests through pi-ai
  provider catalogs / OpenAI-compatible gateways / self-hosted servers; **settings changes take
  effect on the next request, no restart**), `@deepseek-ai/dsh-agent` (agent loop),
  `@deepseek-ai/dsh-mcp-client` (connect one MCP server; its tools + instructions become
  available to the agent), `@deepseek-ai/dsh-llm-retry`, `@deepseek-ai/dsh-settings-file`,
  `@deepseek-ai/dsh-credentials-local`, `@deepseek-ai/dsh-session*` (JSONL persistence under
  `~/.dsh/sessions`), plus the **`compaction/` family — enabled by default** in the shipped base
  (auto-condenses old history under token pressure; `/compact`; trims oversized tool outputs
  first). See `docs/capability-seams.md`, `docs/config-catalog.md`, and each package README in
  the DSH repo.
- Headless: `dsh --profile headless "one task"` — answer one task, print the result, exit.
  This is your A/B driver.

---

## 2. Verified seams (2026-09-25 — confirm against your checkout, don't re-derive)

1. **Model routing is pure config.** `~/.dsh/settings.yaml` currently reads:
   ```yaml
   llm-pi-ai:
     providers:
       incoai:
         displayName: Splash
         api: openai-completions
         baseURL: http://127.0.0.1:8000/v1
         models: [{ id: incoai/Qwen3.8-27B-Splash, name: Splash }]
         apiKeyEnv: INCOAI_API_KEY
   agent-default-model:
     provider: incoai
     model: incoai/Qwen3.8-27B-Splash
   ```
   The **only** key that changes for the treatment arm is `baseURL` →
   `http://127.0.0.1:8788/v1` (the tds proxy). Add it as a *second* provider entry
   (`incoai-tds` is a fine name) and flip `agent-default-model.provider` — leave the original
   entry untouched so the control arm is a one-line flip. Model id, wire (chat-completions
   under `/v1`), and everything else stay identical across arms.
2. **The tds proxy upstream rule:** the proxy appends the *client's full path* to the upstream
   base. Start it with `CTXROOM_COPILOT_API_URL=http://127.0.0.1:8000` — **endpoint root, no
   `/v1`** (a `/v1` suffix would double up and 404). Default port 8788; pidfile
   `~/.ctxroom/proxy-8788.json`; `/health`; reuse `ensureProxy`/`stopProxy` from
   `packages/cli/src/copilot.ts` for lifecycle.
3. **The retrieve path is config too.** `@deepseek-ai/dsh-mcp-client` accepts (schema in
   `packages/mcp/mcp-client/src/index.ts` of the DSH repo):
   ```ts
   { transport: 'stdio', serverName: string, command: string, args: string[],
     env: Record<string,string>, cwd?: string, toolCallTimeoutMs?, failOnStartupError? }
   ```
   The tds MCP server entry:
   ```yaml
   # exact top-level key per the mcp-client README "Use this package" — verify, then:
   mcp-client:
     - transport: stdio
       serverName: ctxroom
       command: node
       args: ["<tds repo>/packages/mcp/src/index.ts"]
       env: { CTXROOM_HOME: /Users/akshaysingh/.ctxroom }
   ```
4. **DSH compaction is on by default and rewrites history.** That collides with tds's
   frozen-prefix byte-identity premise (a compaction rewrite busts the model's KV cache; and
   tds would then compress what compaction already condensed). Decide explicitly and document:
   keep compaction on (tds mostly no-ops over small summaries) or disable it in the A/B
   profiles. Record which arm ran with what.
5. **Measurement is already instrumented**: tds stats JSONL
   (`~/.ctxroom/stats/<date>.jsonl`: tokensBefore/After, transforms, ccrStored, ms per
   request); DSH session JSONL under `~/.dsh/sessions` (turn timestamps). The model server
   (§6) may also log per-request timings — find out and use it.

---

## 3. The hypothesis you are testing (published 2026-09-25 — score yourself against it)

Measured live that day: the local 27B model **prefills at ~450 tok/s but decodes at
~30–50 tok/s**. In a long session (50k+ token prompts — normal for a tool-heavy agent) prefill
is ~85–90% of each turn's time, and it is re-paid every turn whenever the server's prefix cache
evicts — which one 27B model serving several agents does. tds compresses 30% (code) to ~90%
(JSON) of the tool-result mass of a prompt, while never touching system/developer messages,
small blocks (<~120 words), or the model's own output.

**Published prediction:** cold-cache turns **~30–45% faster** (≈1.4–1.8×); warm-cache turns a
few–20% faster (delta-bound); plus KV-footprint shrinkage = **stability under concurrent load**
(the exact failure mode observed 2026-09-25: a copilot session 502'd when the shared model
died under dual-session load). Your A/B confirms, refutes, or bounds this — all three are valid
outcomes.

---

## 4. Mission, in order

### Phase 0 — Seam confirmation (read-only)
Confirm §2 against your checkout version: the `mcp-client` top-level YAML shape (its README
owns the worked examples), compaction config keys and whether the `web`/headless profiles
mount it, the exact headless profile mechanics, and what the session JSONL records. Commit a
one-page seam map with file:line refs to the tds repo as `docs/dsh-seams.md`.

### Phase 1 — Route DSH through tds (config-first)
1. Start the tds proxy: `CTXROOM_COPILOT_API_URL=http://127.0.0.1:8000 node
   packages/cli/src/index.ts proxy --port 8788` (detached; lifecycle via ensure/stop helpers).
2. Add the `incoai-tds` provider to `~/.dsh/settings.yaml` (§2.1) — flip
   `agent-default-model` for the treatment arm.
3. Add the mcp-client entry (§2.3) so the agent gets `ctxroom_retrieve` / `ctxroom_stats`.
4. **Prove it live:** a DSH session (headless or web GUI) that reads the seeded 13 KB log
   (reuse the `packages/evals/src/e4.ts` seed recipe verbatim) must produce: (a) ≥1 stats row
   with `ccrStored ≥ 1` and `tokensSaved > 0`; (b) ≥1 CCR entry under `~/.ctxroom/cache`;
   (c) the model calling `ctxroom_retrieve` and receiving the **byte-exact** original;
   (d) a correct final answer mentioning the seeded VORTEX-7001 burst.
5. Document the user-facing recipe in the tds README (a "Using tds with DSH" section: the two
   config snippets, proxy start/stop, and the one-line undo).

### Phase 2 — The A/B (the deliverable)
Design first, write it down (`docs/dsh-ab.md`), then run.
- **Arms:** treatment = provider `incoai-tds` (proxy, CCR on). Control = original `incoai`
  (direct `:8000`). Optional third arm: proxy with `--ccr off` (pure passthrough — verify the
  stats rows show no transforms) to isolate the proxy's own overhead against E6's p99 < 50 ms
  budget.
- **Workload:** one fixed, seeded, multi-turn scripted task run via `dsh --profile headless` —
  same seed for every run. Build it so the prompt grows to ≥50k tokens with a realistic
  tool mix (many code file reads, grep/ripgrep output, the seeded log, a JSON dump — the shape
  of a real audit session; adapt the E2/E4 seeded repo and question battery).
- **Runs:** ≥2 per arm, in **quiet windows**. The model is shared (the user's own sessions;
  possibly other agents) — check before burning 20-minute runs, and **never run arms
  concurrently**. Log any observed contention. If a run dies with `upstream unreachable`/502
  (the model server goes down under load — observed 2026-09-25), note it and re-run that arm;
  do not silently patch the data.
- **Measures:** per-turn wall time + time-to-first-token (session JSONL); prompt tokens per
  turn (treatment: stats rows; control: token count from session JSONL or server logs); the
  final factual battery (reuse the E2 approach — same questions, both arms, require ≥95%
  agreement, publish every disagreement); a **stability probe**: a parallel copilot session
  (E4 shape) running during each arm — does the treatment arm survive the concurrent load that
  killed the 2026-09-25 copilot run?
- **Quality gate:** if compression changed any battery answer, that is a setup failure, not a
  rounding error — fix the compressor's retention (keep the relevant rows) or narrow the
  compression scope for DSH (e.g. logs/JSON only). Never fudge the scorer.

### Phase 3 — Report
`docs/dsh-measured-gains.md` (or a README section): the numbers table (per arm — mean/median
turn time, TTFT, tokens, battery agreement, overhead p99, stability outcome), the verdict
against the §3 prediction, the compaction-interaction outcome, and honest limitations.

---

## 5. Hard constraints (never break, even to make a number look better)

- tds invariants: system/developer messages untouched; frozen prefix re-sent byte-identical;
  no compressor output may be ≥ its input (else passthrough); blocks under ~120 words
  untouched; any failure ⇒ byte-transparent passthrough; CCR off ⇒ no lossy compression;
  retrieve returns the exact original; protected patterns pass through; **responses are never
  modified**; loopback only; zero telemetry; zero runtime deps.
- The 143-test tds suite + `npm run check` + `npm run bench` + `npm run e2e` + evals all stay
  green at the end.
- DSH: config and overlays first. If a code seam truly is required, implement the smallest
  possible change in the DSH checkout, flag it in the commit subject and the report, and keep
  it reversible. Do not rebrand DSH, and do not ship anything into DSH's own repo.
- Shared model: one experiment arm at a time; respect the user's active use of it.

---

## 6. Environment facts (verified 2026-09-25)

- Machine: the Mac mini (Tailscale: `akshays-mac-mini.tail08477f.ts.net`). The model server at
  `http://localhost:8000` (OpenAI-compatible, single model `incoai/Qwen3.8-27B-Splash`) runs
  here — discover its real process (ps / launchctl / docker; note an `ssh -L` self-tunnel also
  listens on 8000, so don't mistake it for the server). It is **one shared instance**: it has
  died under dual-session load (502 "upstream unreachable", 2026-09-25 ~18:23 CDT).
- Node v24.16.0 (nvm); `copilot` 1.0.88 at `~/.nvm/versions/node/v24.16.0/bin/copilot`; tds
  npm-linked into the same prefix (use the node-path invocation — §1 quirk).
- DSH checkout under `~/.npm/_npx/…` (yours may differ — `which dsh`); web GUI at
  http://127.0.0.1:3080.
- The tds repo's `packages/evals/src/e4.ts` is a working template for a self-contained live
  run (temp home, temp seeded repo, in-process proxy, the full assertion set,
  `CTXROOM_LIVE_*` knobs) — borrow its shape for the DSH workload if headless turns out to be
  awkward to script.
- **If you are a DSH session, you are running on that same model.** Your own turns contend
  with your own experiments. Budget for it; go quiet during long runs.

---

## 7. Definition of done

1. A DSH session (web or headless) routes through tds **with config only** — proven by stats
   rows + CCR entry + byte-exact retrieve in a live session; undo is one config flip; README
   documents the recipe.
2. The retrieve path works inside DSH via mcp-client, byte-exact.
3. The A/B is published: numbers, verdict vs the §3 prediction, quality-gate results,
   stability probe, overhead p99 — honest, including misses.
4. tds suite / check / bench / e2e / evals all green; work tree clean; commits honest.

## 8. Working rules (house style)

Zero new deps in tds; loopback-only; deterministic offline tests (<5 min total); live runs
gated and budgeted; when a target cannot be met, publish the number, the failing shape, and
the one-line reason — and move on. The project's philosophy: **deterministic, local,
reversible, honest.** Every number you add should be re-runnable by a stranger with nothing
but Node.

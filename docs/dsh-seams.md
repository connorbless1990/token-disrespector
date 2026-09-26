# DSH seam map (verified 2026-09-25, dsh 0.1.5-rc.3)

Read-only confirmation of the seams tds needs in the DeepSeek Harness (DSH), against the
npx checkout `~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/…`. All routes
verified live with `dsh --profile headless --patch <overlay> --dump-config` and a decoded
session log. "Config-first" = nothing below requires a DSH code change.

## 1. Model routing — pure user settings (`~/.dsh/settings.yaml`)

- `dsh-settings-file` mounts at base: `$DSH_HOME/settings.yaml`, hot-reloaded
  (`dsh-settings-file/README.md` "Minimal configuration"; `dsh-base/cordis.patch.yml`, row `settings`).
- `dsh-llm-pi-ai` is mounted dormant in base; a `llm-pi-ai:` settings section registers routes
  **live, per request, no restart** (`dsh-llm-pi-ai/README.md` Summary; `lib/index.js:1010`
  — provider routes are zod-validated, `apiKeyEnv` resolves through the credential store per request).
- Route fields in use: `displayName`, `api: openai-completions`, `baseURL`, `models[{id,name}]`,
  `apiKeyEnv`. Provider dict key = route name; `agent-default-model: {provider, model}`
  selects it (`dsh-agent-default-model` row in base patch).
- **Arm flip = one settings change**: add second provider `incoai-tds`
  (`baseURL: http://127.0.0.1:8788/v1`) and switch `agent-default-model.provider`.
- Stream watchdog: `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5` (`dsh-llm-pi-ai/lib/index.js:878,1842`)
  — first byte must arrive within 300 s, else `TIMEOUT` → `dsh-llm-retry` (normal, 5 retries,
  observed in session logs) — a slow/loaded prefill is the realistic A/B failure mode.
- OTel telemetry is `FEEDBACK_ONLY` by default (`dsh-base/cordis.patch.yml`, row
  `session-telemetry-otel`); set `DSH_TELEMETRY_DISABLED=1` on experiment runs to be clean.

## 2. MCP retrieve path — one plugin row, no code

`@deepseek-ai/dsh-mcp-client` is **not** in `dsh-base` — it is added as a plugin row.
Exact shape (`dsh-mcp-client/README.md` "Minimal configuration"):

```yaml
- insert:
    - id: mcp-ctxroom
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ctxroom          # [A-Za-z0-9_-]{1,32}; tool namespace
        transport: stdio
        command: node
        args: ["<tds repo>/packages/mcp/src/index.ts"]   # needs Node >= 23.6 (type stripping)
        env: { CTXROOM_HOME: /Users/akshaysingh/.ctxroom }
```

- Tools surface as `mcp__ctxroom__ctxroom_retrieve` / `mcp__ctxroom__ctxroom_stats`
  (README "Tool naming"; `lib/index.js:59-60`). `env` merges over a scrubbed ambient env;
  `failOnStartupError` default false (a dead MCP server never blocks the harness — verify the
  tool list before trusting a run).
- The mcp-client package lives in the npx checkout `node_modules`, so a `--patch` overlay
  naming it resolves without installing anything into the profile. **Verified**: overlay
  composes into the headless tree via `--dump-config` (row lands after all bundle layers).

## 3. Compaction — on by default; explicit opt-out for the A/B

- `dsh-base/cordis.patch.yml` mounts `compaction-basic` (row `compaction-basic`),
  `command-compact`, and `compaction-tool-result-pruner`
  (`thresholdChars 8192 / headChars 4096 / tailChars 1024`) — both headless (rides base) and
  web profiles inherit it.
- `dsh-compaction-basic` config surface (`README.md` "Tuning when condensation starts"):
  `thresholdRatio 0.8`, `retainRatio 0.16`, `auto: true` default. At the 262,144-token
  context window this fires at ~209,715 tokens — well above the A/B workload, and pruning
  runs **only** after a trigger. The summary call is an extra model request that would pollute
  per-turn timing and bust tds's frozen-prefix byte-identity.
- **Decision (used in the A/B profiles):** override the row in an overlay with
  `config: { auto: false }` in **both** arms (patch replaces the whole `config`; other keys
  keep defaults). Documented as a deliberate, symmetric exclusion; the on-by-default
  interaction is reported qualitatively in `dsh-measured-gains.md`.

## 4. Headless + profiles — the A/B driver

- `dsh --profile headless "task"`: one fresh persisted session, final answer → stdout,
  reasoning → stderr, exit 0/1 (`dsh-headless/README.md`; `dsh/README.md` "Entry modes").
  Profiles auto-initialize from shipped templates on first use; headless =
  `bundles: [dsh-base, dsh-headless]`, `patchReload: startup` (`~/.dsh/profiles/headless/package.json`).
- Composition order: bundle patches → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
  → repeatable `--patch` overlays (`dsh/README.md` "Profiles"). `--dump-config` inspects the
  composed tree without booting; `--from-default-profile` seeds a custom profile.
- The "invoking directory is the default workspace root" — A/B runs pass the seeded repo
  as cwd.

## 5. Session JSONL — the free per-request instrument

- Backend `dsh-session-persistence-jsonl`: `~/.dsh/sessions/<workspace-slug>/session-<uuid>/
  session.v3.jsonl.zstd`. **Multi-frame zstd** (one frame per flushed run — `dsh-session-format`
  catalog; node `zstdDecompressSync` reads one frame only, so decode by frame-magic splitting,
  or set `compression: 'none'` for plain JSONL — the A/B profiles do the latter).
- Events carry `seq` + `time` (epoch ms) + `data` (observed in a live session):
  `turn/start`, `turn/end{reason}`, `step/start|end{turn,step}`, `request/header` (full request:
  provider/model/tools/…), `request/context{contextWindow}`, `user/message`, `assistant/message`
  with **`usage: {inputTokens, outputTokens, totalTokens, cacheReadTokens}`** per model call,
  `assistant/attempt` (stream incl. finish/error), `llm/retry`, `tool/call`, `tool/result`.
- This yields, per arm, with zero extra instrumentation: per-call wall time (step/turn
  `time` deltas), TTFT (first stream chunk `time` − `request/header` `time`), prompt size
  (`inputTokens + cacheReadTokens`), **KV-cache hit ratio** (`cacheReadTokens / prompt`),
  output tokens, and retry/stability counts.

## 6. Environment facts as seen from this machine

- Host is the MacBook Air; the model server lives on the Mac mini
  (`akshays-mac-mini.tail08477f.ts.net`, 100.121.196.111) and is reached through the user's
  `ssh -L 8000:localhost:8000` tunnel (started Sep 25 18:23). `http://127.0.0.1:8000/v1/models`
  → `incoai/Qwen3.8-27B-Splash`. One shared serving instance; it 502'd under dual-session load
  on Sep 25. All A/B timing therefore includes one tunnel hop on both arms equally;
  a dropped tunnel = instant upstream failure (record and re-run, per brief §4).
- DSH home `~/.dsh/` (settings.yaml, profiles/, sessions/, storages/); tds home `~/.ctxroom/`
  (cache/, stats/); proxy pidfile `~/.ctxroom/proxy-8788.json`
  (`packages/cli/src/copilot.ts:436`). tds baseline: 143 tests — 142 pass / 1 skip / 0 fail.

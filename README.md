# ctxroom

**Local-first context compression for AI coding agents** — a deterministic
compression engine, a loopback proxy, and a wrapper for the GitHub Copilot
CLI. Headroom-style: content-routed compression, reversible retrieval
(CCR), and KV-cache-stable send-form re-application.

Zero runtime dependencies (Node.js built-ins only). Loopback-only. Zero
telemetry — every byte stays on your machine.

## Why

A coding agent resends its whole conversation on every turn. Tool results
(JSON API dumps, logs, search hits, diffs) dominate that context and blow
through token budgets and KV-cache warm prefixes. ctxroom sits *between the
agent and the provider*:

```
 copilot CLI ──env COPILOT_API_URL──▶ 127.0.0.1:8788 (proxy) ──▶ api.githubcopilot.com
                                              │
                  content-routed compression of the live zone
                  (originals cached locally → CCR marker in the text)
```

Three properties, in one sentence each:

- **Content-routed** — each text block is inspected and routed to a
  dedicated compressor (JSON, logs, search, diff, config, HTML, tabular,
  prose, code); the first one that strictly shrinks wins, otherwise the
  block passes through untouched.
- **Reversible (CCR)** — every lossy compression stores the exact original
  on local disk (content-addressed, sha256) and appends a marker with a
  short hash + `ctxroom_retrieve("<hash>")` hint, exposed to the model as
  an MCP tool. The model can call for the original bytes back.
- **KV-cache stable** — agent clients keep their own copy of history and
  resend *original* bytes each turn. The proxy remembers, per session per
  message, what it forwarded last time, and re-forwards the same
  replacement bytes for identical content. The provider's byte-prefix KV
  cache never breaks, and a tool result compressed at birth stays
  compressed (and window-shrinking) for the whole session.

Target environments include local models and air-gapped enterprises: the
proxy forwards the `Authorization` header verbatim (native GitHub auth or a
PAT both work upstream), honors corporate TLS via `NODE_EXTRA_CA_CERTS` /
`SSL_CERT_FILE`, and the only outbound connection is to the provider you
already use.

## Quickstart

Requires **Node.js ≥ 23.6** (type stripping runs the TypeScript sources
directly — no build step).

```sh
npm install                 # workspace setup (dev-only deps)

node packages/cli/src/index.ts doctor   # environment checklist

# then just use copilot as usual — it runs through the proxy:
node packages/cli/src/index.ts copilot            # start a session
node packages/cli/src/index.ts copilot --stop-proxy   # also stop the proxy afterwards

node packages/cli/src/index.ts unwrap             # remove the MCP registration + stop proxy
```

Or via the workspace script: `npm run ctxroom -- doctor`.

What `copilot` does under the hood: locates the installed CLI, greps its
JS bundle to detect which env knobs the version supports, starts the proxy
if needed (pidfile + `/health`), rewrites the CLI's env to point at
`127.0.0.1:8788` (native redirect lane, or BYOK fallback — see
limitations), registers the ctxroom MCP server in the CLI's MCP config
(marked block, original backed up once), and spawns copilot with your
args. `doctor` checks all of this without touching your session.

Useful commands:

```sh
node packages/cli/src/index.ts proxy --port 8788 --ccr on --budget 100000
node packages/cli/src/index.ts stats --days 7 [--model gpt-5.1]
node packages/cli/src/index.ts simulate --file prompt.json   # offline engine run
node packages/cli/src/index.ts retrieve <12-hex-hash> [maxChars]
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CTXROOM_HOME` | `~/.ctxroom` | Base dir: `cache/` (CCR originals) + `stats/` (JSONL) + pidfiles |
| `CTXROOM_CCR` | `on` | `off` disables lossy compression entirely (invariant I8) |
| `CTXROOM_CCR_TTL_MS` | 7 days | TTL for unreferenced CCR originals |
| `CTXROOM_CCR_MAX_ENTRY` | 20 MiB | Refuse to store originals larger than this |
| `CTXROOM_MIN_INPUT_WORDS` | 120 | Blocks smaller than this are never touched (I4) |
| `CTXROOM_MAX_BLOCK_CHARS` | 1,000,000 | Blocks larger than this pass through |
| `CTXROOM_BUDGET` | `off` | Enable aggressive history compression above the budget |
| `CTXROOM_TOKEN_BUDGET` | 120,000 | Token ceiling that triggers budget-mode compression |
| `CTXROOM_COPILOT_API_URL` | — | Explicit proxy upstream override (tests / special deployments) |
| `GITHUB_COPILOT_ENTERPRISE_URL` | — | Full GHE API URL → upstream |
| `GITHUB_COPILOT_ENTERPRISE_DOMAIN` | — | GHE domain → `https://api.<domain>` |
| `GITHUB_COPILOT_ACCOUNT` | — | `enterprise` → `https://api.business.githubcopilot.com` |
| `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` | — | Corporate TLS roots (honored by the proxy's fetch) |

Upstream resolution order (first set wins): `CTXROOM_COPILOT_API_URL` →
`GITHUB_COPILOT_ENTERPRISE_URL` → `GITHUB_COPILOT_ENTERPRISE_DOMAIN` →
business cloud if `GITHUB_COPILOT_ACCOUNT=enterprise` → default
`https://api.githubcopilot.com`.

## Safety invariants

The engine contract (pinned by the test suite; proxy failures degrade to
byte-transparent passthrough):

| # | Invariant |
|---|---|
| I1 | `system` / `developer` messages are never modified |
| I2 | The frozen prefix is re-sent byte-identical (KV-cache stability) |
| I3 | No growth: a compressor result ≥ input size ⇒ passthrough |
| I4 | Blocks below `minInputWords` (120) are untouched |
| I5 | Any failure at any layer ⇒ passthrough |
| I8 | CCR disabled ⇒ no lossy compression happens |
| I9 | CCR retrieve returns the exact original bytes |
| I10 | Protected-pattern blocks (approval/plan markers) pass through |

## Measured compression

Deterministic compressors, `npm run bench` on the seeded corpus
(`benchmarks/gen.ts` — regenerate identically with `npm run gen`):

| file | type | compressor | in chars | out chars | saved |
|---|---|---|---|---|---|
| json-api-results.json | json | json-crusher | 62,366 | 2,979 | 95.2% |
| metrics.csv | tabular | tabular-crusher | 5,958 | 1,348 | 77.4% |
| build-log.txt | log | log-crusher | 88,239 | 26,361 | 70.1% |
| ripgrep.txt | search | search-crusher | 49,949 | 33,920 | 32.1% |
| multi.diff | diff | diff-crusher | 30,040 | 16,684 | 44.5% |
| page.html | html | html-extractor | 3,382 | 922 | 72.7% |
| config.yaml | config | config-crusher | 1,800 | 910 | 49.4% |
| prose.md | text | text-compressor | 9,838 | 3,476 | 64.7% |
| code.ts | code | code-compressor | 4,057 | 2,831 | 30.2% |
| **total** | | | **255,629** | **89,431** | **65.0%** |

Ratios are fixture-dependent — structural content (JSON/logs/tables)
compresses best; prose and code less so.

## Package layout

| package | role |
|---|---|
| `packages/core` | Engine: types, config, token estimation, CCR store, send-form registry, compressors + content router. Zero deps. |
| `packages/proxy` | Loopback HTTP proxy: compression routes, byte-transparent passthrough, `/p/<project>/` attribution, stats JSONL, `/health`. Zero deps. |
| `packages/mcp` | Hand-rolled MCP stdio server (JSON-RPC 2.0, newline-delimited): `ctxroom_retrieve`, `ctxroom_stats`. Zero deps. |
| `packages/cli` | `ctxroom` binary: `copilot` wrapper, `doctor`, `proxy`, `stats`, `simulate`, `retrieve`, `unwrap`. Zero deps. |
| `e2e/` | Mock-Copilot end-to-end: the KV-cache-stability proof. |
| `benchmarks/` | Seeded deterministic corpus + ratio table. |

Tests: `npm test` (76 tests across all packages) · `npm run check` (tsc) ·
`npm run bench` · `npm run e2e`.

## Honest limitations (v1)

- **Deterministic compressors are not a model.** Prose savings (~65% on the
  fixture) and code savings (~30%) are below what a trained summarizer
  would achieve, and the text compressor keeps conservative summaries. The
  optional LLM summarizer hook exists in core but is off by default.
- **The Copilot CLI was not verified against a live GitHub login** on the
  development machine (the CLI is not installed there). All
  copilot-integration logic is covered by unit tests against fakes;
  feature detection follows headroom's grep-the-bundle trick, and the
  native-lane env vars are the verified `COPILOT_API_URL` +
  `COPILOT_AUTH_MODE=github-native` pair.
- **BYOK fallback is a single-model lane.** Older CLI builds without
  `COPILOT_API_URL` support get the BYOK provider env instead, which drops
  the model picker — the CLI runs one provider model through the proxy.
  The wrapper prints a loud warning in that case.
- **v1 never modifies responses.** Requests are compressed; SSE/JSON
  responses stream back unbuffered and unmodified.
- **Send-form memory is in-process.** The registry lives in the proxy
  process; deterministic compressors make re-forwarded bytes identical
  across proxy restarts, but per-message memory is rebuilt from request
  content, not persisted.

## License

Internal tooling. See package manifests.

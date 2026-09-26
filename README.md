# token-disrespector

A tool that makes AI coding agents use fewer words.

It sits between two programs:

- **the agent** — a program like the GitHub Copilot CLI that writes code
- **the model** — the AI that answers the agent's questions

Every time the agent asks the model a question, it sends the whole
conversation again. Big text blocks — files, command output, search
results — take up most of that. token-disrespector shrinks those blocks on the way
out, saves the originals in a folder on your machine, and lets the model
fetch the originals back when it needs them.

Three promises:

1. **Nothing leaves your machine.** The middle program only listens on
   `127.0.0.1` (loopback). It sends data nowhere but the model server you
   point it at.
2. **The model's answers are never changed.** Only the agent's requests
   are changed.
3. **If anything fails, the request passes through unchanged.** You never
   get wrong data because of token-disrespector.

### A note on the name

The product is **token-disrespector** and the command you type is **tds**.

The machinery underneath keeps its earlier working name, `ctxroom`: the data
folder is `~/.ctxroom`, the variables start with `CTXROOM_`, and the markers
the model may quote still read `[ctxroom: …]`. The rename stops at the
surface — the part you type, read, and quote — because a rename at the seams
would break working installs for no gain. If you see `ctxroom` in the code
or in a log, that is the working name, still doing its job.

---

## Words used in this manual

Every new word, flag, and variable is defined here before it appears
later. Read this table once and the rest of the manual uses no undefined
words.

### Concepts

| Word | Meaning |
|---|---|
| **request** | one question the agent sends to the model, with the conversation attached |
| **turn** | one round of agent → model. The agent resends the whole conversation every turn |
| **token** | a word-sized piece of text. The model counts tokens, not words or letters. Roughly 1 token ≈ 4 characters |
| **message** | one entry in the conversation: the system prompt, your words, the model's answer, or a tool result |
| **block** | one piece of text inside a message. For example, the content of a file the agent read, or the output of a command |
| **proxy** | the small program that receives the agent's requests, changes some of them, and forwards them to the model server. Runs on your machine |
| **127.0.0.1 / loopback** | your machine's own local network address. A program that listens only there cannot be reached from other machines |
| **endpoint** | a web address that serves something. Here: a web server that answers model questions, like `http://localhost:8000` |
| **upstream** | the server the proxy forwards requests to |
| **environment variable (env var)** | a named value your terminal passes to a program. Set with `export NAME=value` |
| **flag** | a word a program accepts, starting with `--`. Example: `--port 8899` |
| **argument** | a plain word a program takes after the flag or the command, without a dash |
| **lane** | which set of environment variables the copilot program is told to use. Two lanes exist: `native` and `byok` (below) |
| **BYOK** | "bring your own key". Here: use a model of your choice (yours or a friend's) instead of GitHub's models |
| **native** | the lane where copilot talks to GitHub's own Copilot service |
| **CCR** | "cache and retrieve". A folder on your machine where token-disrespector saves the original of every block it shrinks |
| **original** | a block exactly as it was before token-disrespector changed it |
| **handle** | a short code (12 characters) inside a marker that identifies a saved original |
| **marker** | a short line token-disrespector adds to a shrunk block. It tells the model: "the full text was saved; here is its handle" |
| **passthrough** | sending a block unchanged. This is the default for any block token-disrespector does not shrink |
| **compressor** | a fixed program that shrinks one kind of text. There is one for JSON, one for logs, one for diffs, and so on |
| **routing** | looking at a block's text and choosing the right compressor. A block that no compressor can shrink gets a passthrough |
| **KV cache** | the model server's memory of the conversation so far. It only works when the bytes sent are identical to the bytes sent last turn |
| **MCP** | "Model Context Protocol". A standard way for a model to call outside tools. copilot supports it |
| **TTL** | "time to live". How long token-disrespector keeps a saved original before deleting it. Default: 7 days |
| **JSON** | a common text format for data, built from `{ }` objects and `[ ]` lists |
| **JSONL** | a file with one JSON object per line. Used for the stats file |
| **port** | a number that identifies a service on a machine. The proxy listens on one, default 8788 |
| **PATH** | the list of folders your terminal searches when you type a program name |
| **exit code** | the number a program returns when it finishes. 0 = success, anything else = failure |
| **native binary** | a compiled program (one fixed file). The current copilot release ships as a native binary. Older releases shipped as text scripts |
| **seed** | a fixed number passed to the test-file generator so that the generated files are byte-identical every time |
| **terminal** | the program where you type commands (the black window; on macOS it is called Terminal) |
| **shell** | the part of the terminal that runs your commands and remembers your environment variables |
| **process** | a program that is running right now. Each process has a number, its process id |
| **foreground / background** | foreground: your terminal waits until the program finishes. background: the program keeps working on its own after your command returns |
| **runtime** | the program that runs the code. Here: Node.js |
| **system prompt** | the fixed set of instructions the agent sends with every conversation |
| **PAT** | "personal access token" — a long string that proves you are you, to GitHub |

### Flags used in this manual

| Flag | Meaning |
|---|---|
| `--lane native\|byok` | use this lane even if auto-detection chooses another (see §3) |
| `--port N` | the port the proxy listens on. Default 8788 |
| `--copilot PATH` | where your copilot program lives, if it is not on the PATH |
| `--config PATH` | which copilot config file to edit (advanced) |
| `--stop-proxy` | stop the background proxy when copilot exits, instead of leaving it running |
| `--doctor` | run the checklist (§2) and stop, without starting copilot |
| `--days N` | for `stats`: how many days back to look. Default 7 |
| `--model NAME` | a **copilot** flag (not tds's): name the model to use |
| `-p "text"` | a **copilot** flag: answer one prompt and exit, instead of starting a chat |
| `--file PATH` | for `simulate`: which file holds the request to test |

### Environment variables used in this manual

| Variable | Meaning |
|---|---|
| `CTXROOM_HOME` | the folder tds uses for its data. Default `~/.ctxroom` |
| `CTXROOM_COPILOT_PATH` | where the copilot program lives. Same effect as `--copilot` |
| `CTXROOM_COPILOT_LANE` | same effect as `--lane` |
| `CTXROOM_COPILOT_API_URL` | the address the **proxy** forwards to. Example: `http://localhost:8000` |
| `GITHUB_COPILOT_ENTERPRISE_URL` | address of your own GitHub Enterprise server (if you have one) |
| `GITHUB_COPILOT_ENTERPRISE_DOMAIN` | the domain part of that address, without `https://` |
| `GITHUB_COPILOT_ACCOUNT` | set to `enterprise` to use your business GitHub cloud |
| `CTXROOM_CCR` | `on` (default) or `off`. `off` disables all shrinking |
| `CTXROOM_CCR_TTL_MS` | the TTL of saved originals, in milliseconds |
| `CTXROOM_CCR_MAX_ENTRY` | saved originals bigger than this (bytes) are not saved |
| `CTXROOM_MIN_INPUT_WORDS` | blocks smaller than this are never touched. Default 120. Size is counted in words; for text with no whitespace at all, every 4 characters count as one word |
| `CTXROOM_MAX_BLOCK_CHARS` | blocks longer than this (in characters) pass through untouched |
| `CTXROOM_BUDGET` | `on` or `off` (default). `on` adds aggressive shrinking for old turns |
| `CTXROOM_TOKEN_BUDGET` | the token count above which budget mode kicks in. Default 120000 |
| `NODE_EXTRA_CA_CERTS` | path to extra trust certificates. For corporate networks. The proxy honors it |
| `SSL_CERT_FILE` | same as above, the standard Node.js name for it |
| `COPILOT_API_URL` | **copilot's own** variable. tds sets it for the agent. Points at the proxy |
| `COPILOT_PROVIDER_TYPE` / `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_WIRE_API` | **copilot's own** BYOK variables. tds sets them. Point at the proxy |
| `PATH` | from the Concepts table. You may need it to fix a "not found" error |

---

## 1. Install (one time, about one minute)

**You need:** Node.js version 23.6 or newer. Check with:

```sh
node --version
```

If it is older, install a newer one without admin rights:

```sh
nvm install 24 && nvm use 24      # if you use nvm
# or
fnm install 24 && fnm use 24      # if you use fnm
```

**Get the code** (either one):

```sh
git clone <the-repo-url> token-disrespector
# or, if you received a zip:
unzip token-disrespector.zip
```

**Link the parts** (one command; works offline):

```sh
cd token-disrespector
npm install --omit=dev
```

There are no runtime packages to download. This command only links the four local parts together.

**Optional check** (143 tests, all run locally, about a minute):

```sh
npm test
```

From now on, "tds" means this command:

```sh
node packages/cli/src/index.ts
```

If you use the tool often, make an alias in your shell config:

```sh
alias tds="node /full/path/to/token-disrespector/packages/cli/src/index.ts"
```

---

## 2. First run: the checklist

```sh
tds doctor
```

You get one line per check. The mark at the start tells you the state:

| Mark | Meaning |
|---|---|
| `✓` | good |
| `!` | a warning. The tool can still work |
| `✗` | broken. The run will fail until you fix this |

If any line has `✗`, the command finishes with exit code 1.

Example output:

```
  ✓ node >= 23.6 (type stripping) — found v24.x
  ✓ copilot CLI found — /…/bin/copilot [native binary] (v1.0.x)
  ! redirect lane — native — assumed (native binary — its knobs are compiled
    in compressed form, invisible to the string scan; verified working on
    current builds)
  ✓ mcp config — ~/.copilot/mcp-config.json — tds adds a marked block
    here and keeps a backup
  ! GH_TOKEN / GITHUB_TOKEN present — fine for github-native login; required
    for PAT mode
  ✓ port 8788 — free
  ✓ CCR cache dir writable — ~/.ctxroom/cache
  ✓ upstream base — https://api.githubcopilot.com
```

What the lines mean:

- **node** — the runtime version. Must be 23.6 or newer. The code is
  written in a language called TypeScript; Node deletes the type labels in
  it as it reads each file (that is what "type stripping" in the line
  means). That is why there is no build step.
- **copilot CLI found** — your copilot program, and what it is built as
  (a native binary or a text script).
- **redirect lane** — which lane tds will use. For a native binary,
  the setting strings are compiled into the file in compressed form, so
  tds cannot read them. It therefore *assumes* the lane. That
  assumption has been verified working on current releases. If you see
  `neither lane detected`, your copilot release is older than both
  mechanisms. Upgrade copilot, or try `--lane byok`.
- **mcp config** — the file where tds registers its retrieval tool
  with copilot. It adds a marked block and keeps a backup (see §8).
- **GH_TOKEN** — a GitHub token. Not needed for the BYOK lane.
- **port** — the port must be free, or the proxy cannot start.
- **CCR cache dir** — the folder for saved originals must be writable.
- **upstream base** — where the proxy will forward requests.

Common fixes:

| You see | Do this |
|---|---|
| `✗ copilot CLI found — not found` | find it: `readlink -f "$(command -v copilot)"`. Then pass it: `tds doctor --copilot /that/path` (or `export CTXROOM_COPILOT_PATH=/that/path`) |
| `✗ port 8788 — in use` | use another port on every command: `tds doctor --port 8899`, `tds copilot --port 8899` |
| `✗ CCR cache dir writable` | `export CTXROOM_HOME=/some/writable/folder` |
| `! redirect lane — neither` | upgrade copilot, or add `--lane byok` |

---

## 3. Use it with your own model (no GitHub account)

This is the BYOK lane. The model server can be any OpenAI-compatible
server: vLLM, ollama, or similar. It must answer two addresses:

```
GET  <address>/v1/models
POST <address>/v1/chat/completions
```

You need the model's name. Get it:

```sh
curl http://localhost:8000/v1/models
```

Then two commands, in order:

```sh
# 1. Tell the proxy where to forward. Use the endpoint's root,
#    WITHOUT the /v1 part. The proxy keeps the path the agent sends
#    (/v1/chat/completions) and puts your root in front of it.
export CTXROOM_COPILOT_API_URL=http://localhost:8000

# 2. Start copilot through tds, BYOK lane, naming your model.
tds copilot --lane byok --model incoai/Qwen3.8-27B-Splash
```

No login. No quota. Everything stays on your machine and network.

For a one-shot question instead of a chat:

```sh
tds copilot --lane byok --model incoai/Qwen3.8-27B-Splash \
  -p "explain the bug in packages/core/src/compress.ts"
```

Notes:

- Put the `export` in your shell config to make it permanent.
- A model on another machine over your private network works the same
  way: use that machine's address, e.g. `http://100.x.y.z:8000`.
- If your server does not use the `/v1` path, put the full path in
  `CTXROOM_COPILOT_API_URL` instead.
- While copilot runs, everything you type is the normal copilot
  experience. token-disrespector only changes what travels to the model.
- When copilot exits, the proxy keeps running in the background (see
  §8). Stop it with `tds copilot --stop-proxy` or `tds unwrap`.

---

## 4. Use it with real GitHub Copilot

Log in once, if you have not:

```sh
copilot login
```

Then:

```sh
tds copilot
```

That is the whole setup. The model picker works as usual. The `native`
lane is used: tds points copilot at the proxy, and the proxy
forwards to `https://api.githubcopilot.com`.

GitHub Enterprise or a business cloud? Set the usual copilot variables
before the first run — the proxy reads them:

```sh
export GITHUB_COPILOT_ENTERPRISE_URL=https://copilot.my-company.com   # full address
# or
export GITHUB_COPILOT_ENTERPRISE_DOMAIN=copilot.my-company.com
# or
export GITHUB_COPILOT_ACCOUNT=enterprise
```

A corporate firewall that swaps in its own certificates? Export the
certificate first:

```sh
export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem
```

Everything that is not a tds flag is passed to copilot unchanged:

```sh
tds copilot -p "explain this repo" --model gpt-5.1
```

---

## 4b. Use it with the DeepSeek Harness (DSH)

DSH ([deepseek-harness](https://github.com/deepseek-ai/deepseek-harness))
routes its model traffic by configuration, so the whole setup is two YAML
edits plus the proxy. No DSH code change is needed.

One important property: **tds for DSH is opt-in and process-scoped.** The
proxy is a plain foreground process — nothing installs a service, nothing
auto-starts at login, and nothing comes back on its own. It is "on" exactly
while you have left the step-1 command running, and "off" the moment you
stop it.

### Turning it on (three steps, in this order)

**1. Start the proxy.** The endpoint root has **no** `/v1` (the proxy
appends the client's full path; a `/v1` suffix would double up and 404):

```sh
CTXROOM_COPILOT_API_URL=http://127.0.0.1:8000 \
  node /path/to/token-disrespector/packages/cli/src/index.ts proxy --port 8788
```

Leave that terminal open — the proxy lives only as long as it does.
Confirm it: `curl http://127.0.0.1:8788/health` should print
`{"ok":true, ...}`. (Port 8788 is the default; use another everywhere if
it's taken.)

**2. Point DSH at the proxy.** Edit `~/.dsh/settings.yaml`. Keep your
existing route (e.g. `incoai`) and add a twin whose only difference is
`baseURL`:

```yaml
llm-pi-ai:
  providers:
    incoai:
      displayName: Splash
      api: openai-completions
      baseURL: http://127.0.0.1:8000/v1        # direct
      models: [{ id: incoai/Qwen3.8-27B-Splash, name: Splash }]
      apiKeyEnv: INCOAI_API_KEY
    incoai-tds:
      displayName: Splash (via tds)
      api: openai-completions
      baseURL: http://127.0.0.1:8788/v1        # through tds
      models: [{ id: incoai/Qwen3.8-27B-Splash, name: Splash (via tds) }]
      apiKeyEnv: INCOAI_API_KEY
agent-default-model:
  provider: incoai-tds                          # flip this to switch arms
  model: incoai/Qwen3.8-27B-Splash
```

The flip takes effect on the next request — no DSH restart. In the web GUI
the new model appears as a second selectable entry ("Splash (via tds)");
your direct route keeps working for any model that still points at `:8000`.

**3. (Optional, recommended) Give the agent the retrieve tool.** tds
compresses big blocks and stores each original; the agent should be able to
fetch them back. `dsh-mcp-client` is **not** in DSH's shipped base bundle,
so mount it with one insert row in the active profile's `cordis.patch.yml`
(e.g. `~/.dsh/profiles/web/cordis.patch.yml`; for headless, the matching
profile file) or as a `--patch` overlay:

```yaml
- insert:
    - id: mcp-ctxroom
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ctxroom
        transport: stdio
        command: node                          # Node >= 23.6 (runs .ts directly)
        args: ["/path/to/token-disrespector/packages/mcp/src/index.ts"]
        env:
          CTXROOM_HOME: /Users/you/.ctxroom
```

The tools appear as `mcp__ctxroom__ctxroom_retrieve` and
`mcp__ctxroom__ctxroom_stats`. Without this step tds still compresses —
the agent just cannot retrieve the shrunk originals.

### Checking that it is actually on

- `curl http://127.0.0.1:8788/health` → `{"ok":true,...}` (the proxy is up)
- `tds stats --days 1` → requests are being recorded with tokens saved
- your session transcript shows `[ctxroom:compressed …]` markers where big
  blocks were shrunk
- the model calls `mcp__ctxroom__ctxroom_retrieve` and gets the original
  back byte-exact

### Turning it off

- Stop the proxy: `Ctrl-C` in its terminal (or kill it). The `incoai-tds`
  route stops answering immediately; the direct route is unaffected.
- Optionally set `agent-default-model.provider: incoai` back (DSH settings
  hot-reload; the GUI can also just select the direct model).
- Remove the `mcp-ctxroom` insert row to drop the retrieve/stats tools.
- Delete the `incoai-tds` provider entry whenever you want the config clean.

All four are reversible and idempotent; none of them touches DSH's code.

### After a reboot

Nothing in DSH or tds is a service: a reboot ends the proxy process, and
only that must be redone. The two YAML edits persist — re-run step 1 and
you are back on tds.

### The seam map and measurements

The config seams this relies on (verified against the DSH checkout) are in
[docs/dsh-seams.md](docs/dsh-seams.md); the A/B design for the shared-model
workload is in [docs/dsh-ab.md](docs/dsh-ab.md).

---

## 5. Proving it works

There are three levels of proof, from "always works" to "works when the
file arrives in the right shape". Do them in order.

### Proof 1 — the engine (always works, offline, 30 seconds)

```sh
npm run gen      # build the fixed test corpus
npm run bench    # compress it, print the savings table
```

Or run the engine over one request file:

```sh
tds simulate --file your-request.json
```

This needs no copilot, no model, no network. If the table shows the
numbers in §10, the engine works.

### Proof 2 — the loop (works today, about five minutes)

This proves the requests actually travel through token-disrespector to your model.

Terminal A: start a session (the §3 or §4 command for your mode).

Terminal B, in the token-disrespector folder:

```sh
tail -f ~/.ctxroom/stats/$(date +%F).jsonl
```

Ask the agent anything in terminal A, for example:

> List the files in this folder.

A new line appears in terminal B. The `model` field is your model and the
`path` is `/v1/chat/completions`. Every agent turn produces one such
line. **If lines appear, token-disrespector is in the loop.** (Stop the tail with
Ctrl-C. Then `tds stats` shows the same data grouped by day.)

### Proof 3 — a compression, live (best effort)

This one depends on how the agent's file tool delivers the content, so
read the expectations before you judge it.

Step 1 — plant a big file, written on one line (no indentation):

```sh
node -e '
const r = Array.from({length: 300}, (_, i) => ({ id: "req_" + i,
  service: ["auth","ingest","search"][i % 3],
  status: i % 17 === 0 ? 500 : 200,
  ms: (i * 37) % 900, path: "/v2/items" }));
require("fs").writeFileSync("big-api-dump.json", JSON.stringify(r));
'
```

Step 2 — in terminal A:

> Read `big-api-dump.json` in full. How many records does it contain?
> Does any content in your context contain a line that starts with
> `[ctxroom:compressed`? If yes, quote it exactly.

Step 3 — check the stats line for that turn in terminal B and read it
honestly:

| What you see in the stats line | What it means |
|---|---|
| `tokensSaved` is large, `transforms` names the json compressor, the model quotes a marker | the full contract worked: shrunk, saved, retrievable |
| `tokensSaved` is 0, `transforms` says `passthrough:…` | the agent's file tool delivered the content wrapped or cut into line chunks, so the block was no longer a clean JSON document. The request was inspected and safely left unchanged. The engine is fine; the shape arriving is the problem |
| no line at all | the request never reached the proxy. Your copilot release ignored the redirect. See §11 |

Three shapes, two that work and one that does not:

- Works: the whole file arrives as one valid JSON block (a single line,
  or a small enough file that the read tool returns in one call). The
  JSON compressor deduplicates the repeated records — the 300-record
  file above shrinks by about 95%.
- Works: an indented file read in chunks (the tool returns the file in
  ~70-line windows, none of which is valid JSON on its own). The
  fragment compressor recognizes the repeated record rows inside each
  chunk, keeps the ends and one example of each shape, notes how many
  rows were dropped, and saves the original. Measured on that file:
  about 29% per chunk, and every dropped record stays retrievable.
- Does not work: content with no repeated structure at all — a single
  minified blob, a binary-ish dump, or a chunk so small that it holds
  fewer than about eight complete records. The block is inspected and
  left unchanged. That is the correct safe behavior, just not the
  savings you hoped for.

If the model quotes a marker, finish the proof by asking for a row the
compressed form dropped:

> Quote record 50 exactly. If your context was compressed, first call
> `ctxroom_retrieve` with the handle from the marker, then quote it.

If your copilot release does not expose MCP tools, copy the handle from
the chat and run `tds retrieve <handle>` in terminal B. If the
returned text matches the file, the save → fetch contract works end to
end.

Finally, chat a few more turns and run `tds stats`. The client keeps
resending the original bytes every turn. If the rows keep showing the
small token count, the KV-cache promise holds: the proxy re-sends
identical replacement bytes, so the model server's memory of the
conversation stays warm.

The negative control: ask the agent to run `echo hello`, then ask whether
that output contains the word `ctxroom`. It does not. Small blocks never
get touched.

---

## 6. Every command

```
tds copilot [args…]        start copilot through the proxy.
                               All tds flags below; everything else
                               is passed to copilot unchanged.
                               --port N | --lane native|byok
                               --copilot PATH | --config PATH
                               --stop-proxy | --doctor
tds doctor                 the checklist from §2.
                               --port N | --copilot PATH | --lane …
tds proxy                  run just the proxy, in the foreground.
                               --port N | --ccr on|off | --budget N
tds stats                  token savings per day, per model, per project.
                               --days N | --model NAME
tds simulate --file PATH   run the compressor offline over one request
                               file (JSON: {"messages":[…]} or an array).
                               No network. No copilot.
tds retrieve HANDLE [N]    fetch a saved original by its handle.
                               N (optional argument) = max characters back.
tds unwrap                 remove the MCP registration, restore the
                               config backup, stop the proxy.
```

`--ccr on|off` (on the proxy command) and `--budget N` behave exactly
like the `CTXROOM_CCR` and `CTXROOM_TOKEN_BUDGET` variables.

---

## 7. Every variable

The full table is in the Words section above. The two you will actually
use:

| Variable | When | Example |
|---|---|---|
| `CTXROOM_COPILOT_API_URL` | always, for the BYOK lane | `http://localhost:8000` |
| `CTXROOM_HOME` | if `~/.ctxroom` is not writable | `/data/ctxroom` |

Everything else is optional.

---

## 8. What it touches on disk — and how to remove it

| Path | What is in it |
|---|---|
| `~/.ctxroom/cache/…` | saved originals, one file each, named by handle. Deleted after the TTL |
| `~/.ctxroom/stats/YYYY-MM-DD.jsonl` | one stats line per request, per day |
| `~/.ctxroom/proxy-8788.json` | the process id of the background proxy |
| `~/.copilot/mcp-config.json` | one marked block that registers the retrieval tool with copilot. Newer copilot releases read this file. |
| `~/.copilot/mcp-config.json.ctxroom.bak` | the file as it was before, kept as a backup |
| `~/.copilot/mcp.json` | same as above, for older copilot releases that read this file |
| `127.0.0.1:8788` | the running proxy. Loopback only — other machines cannot reach it |

Remove everything:

```sh
tds unwrap       # config back to exactly how it was + proxy stopped
rm -rf ~/.ctxroom    # the data folder
```

That is all. Nothing else is written anywhere.

---

## 9. What is guaranteed (each one has a test)

1. The system prompt and developer messages (messages with the role
   `developer`) are never changed.
2. The part of the conversation that already happened is re-sent byte for
   byte. The model server's cache keeps working.
3. A compressor that would make a block bigger is skipped. The block
   passes through instead. Nothing ever gets longer.
4. Blocks smaller than about 120 words are never touched. (For text with
   no whitespace, 4 characters count as one word, so a long single line
   is judged by its length, not read as "one word".)
5. Any failure, anywhere in the chain, results in the original bytes.
6. With `CTXROOM_CCR=off`, no shrinking happens at all.
7. `retrieve` returns the saved original, byte for byte.
8. Blocks that look like approval or plan markers pass through untouched.
9. A request that cannot be read is forwarded unchanged.
10. The proxy listens on 127.0.0.1 only.

---

## 10. How much does it save?

The test corpus is a fixed set of nine files, one per content type. The
generator is seeded, so every machine builds byte-identical files. Run it
with:

```sh
npm run gen      # build the corpus
npm run bench    # compress it and print the table
```

| file | kind | compressor used | in (chars) | out (chars) | saved |
|---|---|---|---|---|---|
| json-api-results.json | JSON | json | 62,366 | 2,979 | 95.2% |
| build-log.txt | log | log | 88,239 | 2,087 | 97.6% |
| ripgrep.txt | search output | search | 49,949 | 33,920 | 32.1% |
| metrics.csv | table | tabular | 5,958 | 1,348 | 77.4% |
| multi.diff | diff | diff | 30,040 | 16,684 | 44.5% |
| page.html | html | html | 3,382 | 922 | 72.7% |
| config.yaml | config | config | 1,800 | 910 | 49.4% |
| prose.md | prose | text | 9,838 | 3,476 | 64.7% |
| code.ts | code | code | 4,057 | 2,831 | 30.2% |
| **total** | | | **255,629** | **65,157** | **74.5%** |

"chars" = characters. Characters are not tokens; the token savings are
proportional for these files.

Structured content (JSON, logs, tables) saves the most. Prose and code
save less, because there is less structure to exploit. Your real savings
depend on what your agent actually reads — check `tds stats` after a
day of real use.

---

## 11. Troubleshooting

| You see | What it means | Do this |
|---|---|---|
| `could not find the copilot binary` | copilot is not in a folder tds searches | `readlink -f "$(command -v copilot)"`, then `tds copilot --copilot /that/path` |
| copilot works, but `tds stats` has zero lines | your copilot release ignored the redirect variables, so its requests never reached the proxy | check `tds doctor`; try `--lane byok` with `CTXROOM_COPILOT_API_URL` set |
| `BYOK providers require an explicit model` | the BYOK lane needs a model name | add `--model NAME` (the name from `curl <endpoint>/v1/models`) |
| `Failed to load models … 127.0.0.1` | the redirect works, but the model server is not reachable | start the server, or fix `CTXROOM_COPILOT_API_URL` |
| the agent read a big file, but `tokensSaved` is 0 | two causes, both about the shape the agent's tool delivers: (a) the file's content has no repeated structure (minified blob, prose) and is below the size where the text compressor engages; (b) current copilot releases truncate very long tool output (they save the full output to a side file and put a shorter copy plus a notice into the conversation) — the short copy is below the size the compressors work on | for (a) re-save the file with indentation (JSON with one field per line) and read it in chunks — the fragment compressor then deduplicates the record rows; for (b) keep files small enough to fit, or check the agent's side file. The engine is not at fault in either case |
| `tds copilot` printed a `ZERO requests` note after your session | copilot exited, but none of its requests reached the proxy — the redirect wiring never engaged, so nothing was compressed | the note lists the likely causes in order (lane not honored, copilot failed before its first API call, unreachable upstream). Run `tds doctor`, try `--lane byok` with `CTXROOM_COPILOT_API_URL` set, and re-run with a prompt that makes the agent do something |
| `port 8788 in use` | something else listens on that port | use `--port 8899` on every command |
| certificate errors against a corporate server | the firewall swaps in its own certificates | `export NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before starting |
| the model answers oddly after a turn | it saw the shrunk form and guessed | `tds retrieve <handle>` — or raise `CTXROOM_MIN_INPUT_WORDS` so less gets shrunk |
| I want it all gone | — | `tds unwrap` and `rm -rf ~/.ctxroom` |

---

## 12. What v1 does not do

- **The compressors are fixed programs, not a model.** They exploit
  structure. They are not as good at summarizing prose as a trained
  summarizer would be. (The core has a place where a model-based
  summarizer can be plugged in, but it is off by default.)
- **The BYOK lane uses one model.** A copilot release without the native
  mechanism has no model picker in this lane. Current releases support
  both mechanisms, so you rarely meet this limit.
- **The lane guess for native binaries is a verified assumption.** The
  setting strings are compiled in compressed form, so they cannot be
  read. If a future copilot release stops honoring them, you will see it
  as zero stats lines. The checklist cannot know this.
- **The model's answers are never changed.** Requests only.
- **The proxy's memory of what it sent lives in its process.** If the
  proxy restarts, it rebuilds that memory from the request content, and
  the bytes it re-sends stay identical, because the compressors are
  fixed.

---

## The four parts

| Part | What it is |
|---|---|
| `packages/core` | the engine: the nine compressors, the router, the CCR store. No dependencies. |
| `packages/proxy` | the loopback proxy: applies the engine, keeps KV-cache stability, writes the stats file. No dependencies. |
| `packages/mcp` | the retrieval tool as a small MCP server that copilot loads. No dependencies. |
| `packages/cli` | the `tds` command with all the subcommands in §6. No dependencies. |

`npm test` (143 tests) · `npm run check` (type check) · `npm run bench`
(corpus numbers) · `npm run e2e` (a fake copilot that proves the
KV-cache promise) · `npm run eval` (the seven measurement evals:
real-shape ratio, answer A/B, KV stability, fuzz, overhead, drift —
all offline; the live one runs with `--live`).

/**
 * DSH adapter tests — everything runs WITHOUT DSH installed and WITHOUT the
 * network: the yaml-subset parser against synthetic documents, the
 * settings/patch surgery against in-memory strings (injected read/write/
 * exists), the orchestration with injected lifecycle, and the doctor section
 * against a fake DSH home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import {
  TDS_BEGIN,
  TDS_END,
  buildLineModel,
  ctxroomHome,
  dshDoctorItems,
  dshHomeDir,
  findBlockSpan,
  findMcpEntryFiles,
  mergeDshPatch,
  mergeDshSettings,
  patchHasMcpEntry,
  planTwin,
  profilePatchPaths,
  readSettingsState,
  renderMcpEntry,
  runDsh,
  unmergeDshPatch,
  unmergeDshSettings,
  type SettingsFsOpts,
  type PatchFsOpts,
} from "../src/dsh.ts";
import { deepEqualYaml, diffPaths, getIn, parseYaml, pathIgnored, type YamlParse, type YamlValue } from "../src/yaml-subset.ts";
import { cmdDsh } from "../src/index.ts";
import { runDoctor } from "../src/doctor.ts";

/** Narrow a parse result to its value (tests: the docs are known-good). */
function must(r: YamlParse): YamlValue | null {
  if (!r.ok) throw new Error(`parse failed: ${r.reason} (line ${r.line})`);
  return r.value;
}

// ---------------------------------------------------------------------------
// yaml-subset
// ---------------------------------------------------------------------------

test("yaml-subset: block mapping with nested maps and sequence of maps", () => {
  const doc = [
    "llm-pi-ai:",
    "  providers:",
    "    incoai:",
    "      displayName: Splash",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:8000/v1",
    "      models:",
    "        - id: incoai/Qwen3.8-27B-Splash",
    "          name: Splash",
    "      apiKeyEnv: INCOAI_API_KEY",
    "agent-default-model:",
    "  provider: incoai",
    "  model: incoai/Qwen3.8-27B-Splash",
    "",
  ].join("\n");
  const r = parseYaml(doc);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(getIn(r.value, ["agent-default-model", "provider"])?.kind, "scalar");
  assert.equal(getIn(r.value, ["agent-default-model", "provider"])?.kind === "scalar" ? (getIn(r.value, ["agent-default-model", "provider"]) as { value: unknown }).value : null, "incoai");
  assert.equal(getIn(r.value, ["llm-pi-ai", "providers", "incoai", "baseURL"])?.kind === "scalar" ? (getIn(r.value, ["llm-pi-ai", "providers", "incoai", "baseURL"]) as { value: unknown }).value : null, "http://127.0.0.1:8000/v1");
  const models = getIn(r.value, ["llm-pi-ai", "providers", "incoai", "models"]);
  assert.equal(models?.kind, "seq");
  assert.equal(models?.kind === "seq" ? models.items.length : -1, 1);
});

test("yaml-subset: flow collections, quotes, typed scalars, comments", () => {
  const doc = [
    "a: {x: 1, y: [1, 2, 'three']}",
    "b: \"quoted: with colon\"",
    "c: 'single ''quote'''",
    "d: 42",
    "e: true",
    "f: null",
    "g: http://127.0.0.1:8000/v1 # trailing comment",
    "h:", // null
    "",
  ].join("\n");
  const r = parseYaml(doc);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const a = getIn(r.value, ["a"])!;
  assert.equal(a.kind, "map");
  assert.equal(a.kind === "map" ? a.entries.length : -1, 2);
  assert.equal(getIn(r.value, ["b"])?.kind === "scalar" ? (getIn(r.value, ["b"]) as { value: unknown }).value : null, "quoted: with colon");
  assert.equal(getIn(r.value, ["c"])?.kind === "scalar" ? (getIn(r.value, ["c"]) as { value: unknown }).value : null, "single 'quote'");
  assert.equal(getIn(r.value, ["d"])?.kind === "scalar" ? (getIn(r.value, ["d"]) as { value: unknown }).value : null, 42);
  assert.equal(getIn(r.value, ["e"])?.kind === "scalar" ? (getIn(r.value, ["e"]) as { value: unknown }).value : null, true);
  assert.equal(getIn(r.value, ["f"])?.kind === "scalar" ? (getIn(r.value, ["f"]) as { value: unknown }).value : null, null);
  assert.equal(getIn(r.value, ["g"])?.kind === "scalar" ? (getIn(r.value, ["g"]) as { value: unknown }).value : null, "http://127.0.0.1:8000/v1");
  assert.equal(getIn(r.value, ["h"])?.kind === "scalar" ? (getIn(r.value, ["h"]) as { value: unknown }).value : null, null);
});

test("yaml-subset: tagged values parse as opaque; round-trip identity", () => {
  const doc = "- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: 'none'\n";
  const r = parseYaml(doc);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const v = must(r);
  const item = v?.kind === "seq" ? v.items[0] : null;
  assert.ok(item?.kind === "map");
  const root = getIn(item, ["config", "root"]);
  assert.equal(root?.kind, "opaque");
  assert.ok((root as { raw: string }).raw.includes("!!js"));
  // identity across re-parses
  assert.ok(deepEqualYaml(v, must(parseYaml(doc))));
});

test("yaml-subset: multi-line plain scalar folds", () => {
  const doc = "key: first\n  second\n  third\nother: x\n";
  const r = parseYaml(doc);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const v = getIn(r.value, ["key"]);
  assert.equal(v?.kind === "scalar" ? (v as { value: unknown }).value : null, "first second third");
});

test("yaml-subset: rejects block scalars, anchors, aliases, tabs, markers, directives", () => {
  const cases: [string, string][] = [
    ["block scalar", "a: |\n  text\n"],
    ["block scalar >-", "a: >-\n  text\n"],
    ["anchor", "a: &x 1\nb: *x\n"],
    ["tab indent", "a:\n\tb: 1\n"],
    ["doc marker", "---\na: 1\n---\nb: 2\n"],
    ["directive", "%YAML 1.1\n---\na: 1\n"],
  ];
  for (const [label, doc] of cases) {
    const r = parseYaml(doc);
    assert.equal(r.ok, false, `${label} should be rejected`);
  }
  // single-doc with a leading marker is also rejected (we only emit single docs)
  assert.equal(parseYaml("---\na: 1\n").ok, false);
});

test("yaml-subset: duplicate keys rejected; unterminated quote rejected", () => {
  assert.equal(parseYaml("a: 1\na: 2\n").ok, false);
  assert.equal(parseYaml('a: "unterminated\n').ok, false);
});

test("yaml-subset: diffPaths + pathIgnored + null-side descent", () => {
  const a = must(parseYaml("x: 1\ny:\n  z: 2\n"));
  const b = must(parseYaml("x: 1\ny:\n  z: 3\n  w: 4\n"));
  const diffs = diffPaths(a, b);
  assert.deepEqual(diffs, ["y.z", "y.w"]);
  assert.ok(pathIgnored("y.z", ["y"]));
  assert.ok(pathIgnored("y.w", ["y"]));
  assert.ok(!pathIgnored("x", ["y"]));
  // null-side descent enumerates children
  const nullDiffs = diffPaths(null, must(parseYaml("llm-pi-ai:\n  providers:\n    t: 1\n")));
  assert.ok(nullDiffs.some((d) => d.startsWith("llm-pi-ai")), JSON.stringify(nullDiffs));
  assert.ok(nullDiffs.every((d) => pathIgnored(d, ["llm-pi-ai"])));
});

// ---------------------------------------------------------------------------
// planTwin / rendering
// ---------------------------------------------------------------------------

test("planTwin: copies the direct profile, suffixes, builds the twin route", () => {
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  assert.equal(plan.provider, "incoai-tds");
  assert.equal(plan.defaultProvider, "incoai-tds");
  assert.equal(plan.profile.displayName, "Splash (via tds)");
  assert.equal(plan.profile.api, "openai-completions");
  assert.equal(plan.profile.baseURL, "http://127.0.0.1:8788/v1");
  assert.equal(plan.profile.apiKeyEnv, "INCOAI_API_KEY");
  assert.deepEqual(plan.profile.models, [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash (via tds)" }]);
  assert.equal(plan.defaultModel, "incoai/Qwen3.8-27B-Splash");
});

test("planTwin: explicit flags override; no model → empty list (caller must error)", () => {
  const p1 = planTwin("incoai", null, { model: "foo/bar", port: 9999 });
  assert.equal(p1.provider, "incoai-tds");
  assert.equal(p1.profile.baseURL, "http://127.0.0.1:9999/v1");
  assert.deepEqual(p1.profile.models, [{ id: "foo/bar", name: "incoai (via tds)" }]);
  const p2 = planTwin("incoai", null, {});
  assert.deepEqual(p2.profile.models, []);
});

test("renderMcpEntry: DSH's canonical insert-wrapped shape", () => {
  const lines = renderMcpEntry("/usr/bin/node", "/repo/packages/mcp/src/index.ts", "/home/u/.ctxroom");
  const doc = parseYaml(lines.join("\n"));
  assert.ok(doc.ok, doc.ok ? "" : doc.reason);
  const v = must(doc);
  assert.equal(getIn(v, [0, "insert", 0, "id"])?.kind === "scalar" ? (getIn(v, [0, "insert", 0, "id"]) as { value: unknown }).value : null, "mcp-ctxroom");
  assert.equal(getIn(v, [0, "insert", 0, "config", "serverName"])?.kind === "scalar" ? (getIn(v, [0, "insert", 0, "config", "serverName"]) as { value: unknown }).value : null, "ctxroom");
  assert.equal(getIn(v, [0, "insert", 0, "config", "transport"])?.kind === "scalar" ? (getIn(v, [0, "insert", 0, "config", "transport"]) as { value: unknown }).value : null, "stdio");
  assert.ok(patchHasMcpEntry(lines.join("\n")));
});

test("patchHasMcpEntry: detects both the wrapped and the flat shape", () => {
  // wrapped (DSH's own shape, as hand-written in a profile patch)
  const wrapped = [
    "- insert:",
    "    - id: mcp-ctxroom",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: ctxroom",
    "",
  ].join("\n");
  assert.ok(patchHasMcpEntry(wrapped));
  // flat (a bare top-level entry)
  const flat = [
    "- id: mcp-ctxroom",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: ctxroom",
  ].join("\n");
  assert.ok(patchHasMcpEntry(flat));
  // a different entry is not detected
  assert.equal(patchHasMcpEntry("- id: other\n  config:\n    serverName: something\n"), false);
});

test("planTwin: re-running on an already-tds-routed default never double-suffixes", () => {
  // current default IS the twin; its base (incoai) exists
  const p = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, {});
  assert.equal(p.provider, "incoai-tds");
  assert.equal(p.profile.displayName, "Splash (via tds)");
  // base absent from settings → route and names stay the current twin's
  const p2 = planTwin("incoai-tds", { displayName: "Splash (via tds)", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash (via tds)" }] }, {});
  assert.equal(p2.provider, "incoai-tds");
  assert.equal(p2.profile.displayName, "Splash (via tds)");
  assert.deepEqual(p2.profile.models, [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash (via tds)" }]);
});

// ---------------------------------------------------------------------------
// settings.yaml surgery
// ---------------------------------------------------------------------------

/** A realistic DSH settings file (the shape DSH's yaml emitter produces). */
const SETTINGS_REAL = [
  "ui-onboarding:",
  "  welcomeNoticeVersion: 2026-08-13.1",
  "llm-pi-ai:",
  "  providers:",
  "    incoai:",
  "      displayName: Splash",
  "      api: openai-completions",
  "      baseURL: http://127.0.0.1:8000/v1",
  "      models:",
  "        - id: incoai/Qwen3.8-27B-Splash",
  "          name: Splash",
  "      apiKeyEnv: INCOAI_API_KEY",
  "agent-default-model:",
  "  provider: incoai",
  "  model: incoai/Qwen3.8-27B-Splash",
  "ui-theme:",
  "  preference: dark",
  "permission:",
  "  defaultPreset: danger-full-access",
  "",
].join("\n");

/** In-memory fs: a file map, so backup side-files behave like the real one. */
function memO(raw: string | null, file: string): { o: SettingsFsOpts; files: Map<string, string>; state: { written: string | null } } {
  const files = new Map<string, string>();
  if (raw !== null) files.set(file, raw);
  const o: SettingsFsOpts = {
    read: (p) => files.get(p) ?? null,
    write: (p, s) => {
      files.set(p, s);
    },
    exists: (p) => files.has(p),
    rm: (p) => {
      files.delete(p);
    },
  };
  return {
    o,
    files,
    state: {
      get written() {
        return files.get(file) ?? null;
      },
      set written(v: string | null) {
        if (v === null) files.delete(file);
        else files.set(file, v);
      },
    },
  };
}

test("settings merge: inserts the twin after the direct provider; flips the default; preserves every other byte", () => {
  const { o, state } = memO(SETTINGS_REAL, "s.yaml");
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  const r = mergeDshSettings("s.yaml", { ...o, plan });
  assert.ok(r.ok, r.detail);
  const next = state.written!;
  // structural: twin present, default flipped
  const parsed = parseYaml(next);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(getIn(parsed.value, ["agent-default-model", "provider"])?.kind === "scalar" ? (getIn(parsed.value, ["agent-default-model", "provider"]) as { value: unknown }).value : null, "incoai-tds");
  assert.equal(getIn(parsed.value, ["llm-pi-ai", "providers", "incoai-tds", "baseURL"])?.kind === "scalar" ? (getIn(parsed.value, ["llm-pi-ai", "providers", "incoai-tds", "baseURL"]) as { value: unknown }).value : null, "http://127.0.0.1:8788/v1");
  // untouched sections keep their exact bytes
  for (const line of ["ui-onboarding:", "  welcomeNoticeVersion: 2026-08-13.1", "ui-theme:", "  preference: dark", "permission:", "  defaultPreset: danger-full-access", "      displayName: Splash", "      baseURL: http://127.0.0.1:8000/v1"]) {
    assert.ok(next.includes(line + "\n") || next.endsWith(line), `missing preserved line: ${line}`);
  }
  // the original incoai provider is untouched (direct route survives)
  assert.match(next, /incoai:\n      displayName: Splash\n      api: openai-completions\n      baseURL: http:\/\/127\.0\.0\.1:8000\/v1/);
  // markers
  assert.ok(next.includes(TDS_BEGIN) && next.includes(TDS_END));
});

test("settings merge: idempotent (re-run produces a byte-identical file)", () => {
  const { o, state } = memO(SETTINGS_REAL, "s.yaml");
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  assert.ok(mergeDshSettings("s.yaml", { ...o, plan }).ok);
  const once = state.written!;
  const o2 = memO(once, "s.yaml");
  assert.ok(mergeDshSettings("s.yaml", { ...o2.o, plan }).ok);
  assert.equal(o2.state.written, once);
});

test("settings merge: no llm-pi-ai section → appends the full block", () => {
  const raw = "ui-theme:\n  preference: dark\nagent-default-model:\n  provider: deepseek\n  model: deepseek-chat\n";
  const { o, state } = memO(raw, "s.yaml");
  const plan = planTwin("deepseek", null, { model: "deepseek-chat", port: 8788 });
  const r = mergeDshSettings("s.yaml", { ...o, plan });
  assert.ok(r.ok, r.detail);
  const parsed = parseYaml(state.written!);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(getIn(parsed.value, ["llm-pi-ai", "providers", "deepseek-tds", "baseURL"])?.kind === "scalar" ? (getIn(parsed.value, ["llm-pi-ai", "providers", "deepseek-tds", "baseURL"]) as { value: unknown }).value : null, "http://127.0.0.1:8788/v1");
  assert.equal(getIn(parsed.value, ["agent-default-model", "provider"])?.kind === "scalar" ? (getIn(parsed.value, ["agent-default-model", "provider"]) as { value: unknown }).value : null, "deepseek-tds");
  // pre-existing untouched
  assert.match(state.written!, /ui-theme:\n  preference: dark/);
});

test("settings merge: no file → creates it around one marked block", () => {
  const { o, state } = memO(null, "s.yaml");
  const plan = planTwin("incoai", null, { model: "incoai/Qwen3.8-27B-Splash", port: 8788 });
  const r = mergeDshSettings("s.yaml", { ...o, plan });
  assert.ok(r.ok, r.detail);
  const parsed = parseYaml(state.written!);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(getIn(parsed.value, ["agent-default-model", "model"])?.kind === "scalar" ? (getIn(parsed.value, ["agent-default-model", "model"]) as { value: unknown }).value : null, "incoai/Qwen3.8-27B-Splash");
  assert.ok(state.written!.includes(TDS_BEGIN));
});

test("settings merge: refuses files with out-of-subset syntax, leaves them untouched", () => {
  const raw = SETTINGS_REAL + "notes: |\n  some block scalar\n";
  const { o, state } = memO(raw, "s.yaml");
  const plan = planTwin("incoai", null, { model: "incoai/Qwen3.8-27B-Splash", port: 8788 });
  const r = mergeDshSettings("s.yaml", { ...o, plan });
  assert.equal(r.ok, false);
  assert.equal(state.written, raw); // untouched
  assert.match(r.detail, /strict subset/);
});

test("settings undo: restores the pristine backup byte-exactly", () => {
  const { o, state } = memO(SETTINGS_REAL, "s.yaml");
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  assert.ok(mergeDshSettings("s.yaml", { ...o, plan }).ok);
  const merged = state.written!;
  assert.notEqual(merged, SETTINGS_REAL);
  // backup written on merge
  const bakRead = o.read!("s.yaml.ctxroom.bak");
  assert.equal(bakRead, SETTINGS_REAL);
  const r = unmergeDshSettings("s.yaml", o);
  assert.ok(r.ok, r.detail);
  assert.equal(state.written, SETTINGS_REAL);
});

test("settings undo without backup: removes the block surgically, parses clean", () => {
  // merge, then delete the backup, then undo
  const raw = SETTINGS_REAL;
  const { o, state } = memO(raw, "s.yaml");
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  assert.ok(mergeDshSettings("s.yaml", { ...o, plan }).ok);
  // wipe the backup from the in-memory fs
  const o2: SettingsFsOpts = {
    read: (p) => (p.endsWith(".bak") ? null : state.written),
    write: (p, s) => {
      if (!p.endsWith(".bak")) state.written = s;
    },
    exists: (p) => (p.endsWith(".bak") ? false : state.written !== null),
    rm: (p) => {
      if (p.endsWith(".bak")) return;
      if (p === "s.yaml") state.written = null;
    },
  };
  const r = unmergeDshSettings("s.yaml", o2);
  assert.ok(r.ok, r.detail);
  const parsed = parseYaml(state.written!);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  // the twin is gone
  const providers = getIn(parsed.value, ["llm-pi-ai", "providers"]);
  assert.ok(providers?.kind === "map" && !providers.entries.some(([k]) => k === "incoai-tds"));
  // the direct route is intact
  assert.equal(getIn(parsed.value, ["llm-pi-ai", "providers", "incoai", "baseURL"])?.kind === "scalar" ? (getIn(parsed.value, ["llm-pi-ai", "providers", "incoai", "baseURL"]) as { value: unknown }).value : null, "http://127.0.0.1:8000/v1");
});

test("settings re-merge: a hand-written twin with a different field order normalizes in place, ordered, idempotent", () => {
  // The user's real file shape: apiKeyEnv AFTER the models list, no markers.
  const handWritten = [
    "llm-pi-ai:",
    "  providers:",
    "    incoai:",
    "      displayName: Splash",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:8000/v1",
    "      models:",
    "        - id: incoai/Qwen3.8-27B-Splash",
    "          name: Splash",
    "      apiKeyEnv: INCOAI_API_KEY",
    "    incoai-tds:",
    "      displayName: Splash (via tds)",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:8788/v1",
    "      models:",
    "        - id: incoai/Qwen3.8-27B-Splash",
    "          name: Splash (via tds)",
    "      apiKeyEnv: INCOAI_API_KEY",
    "agent-default-model:",
    "  provider: incoai-tds",
    "  model: incoai/Qwen3.8-27B-Splash",
    "",
  ].join("\n");
  const { o } = memO(handWritten, "s.yaml");
  const plan = planTwin("incoai", { displayName: "Splash", api: "openai-completions", baseURL: "http://127.0.0.1:8000/v1", apiKeyEnv: "INCOAI_API_KEY", models: [{ id: "incoai/Qwen3.8-27B-Splash", name: "Splash" }] }, { port: 8788 });
  assert.ok(mergeDshSettings("s.yaml", { ...o, plan }).ok);
  const once = o.read!("s.yaml")!;
  // order: the model's name must sit INSIDE the block, before the end marker
  const nameLine = once.split("\n").findIndex((l) => l.includes("name: 'Splash (via tds)'"));
  const endLine = once.split("\n").findIndex((l) => l.trim() === TDS_END);
  const beginLine = once.split("\n").findIndex((l) => l.includes(TDS_BEGIN));
  assert.ok(beginLine < nameLine && nameLine < endLine, `name ${nameLine} must be inside the block (${beginLine}..${endLine})`);
  assert.ok(parseYaml(once).ok);
  // and a second run is a byte-exact no-op
  const o2 = memO(once, "s.yaml");
  assert.ok(mergeDshSettings("s.yaml", { ...o2.o, plan }).ok);
  assert.equal(o2.state.written, once);
});

test("readSettingsState: interprets the real shape (default, direct, twinPresent)", () => {
  const st = readSettingsState("s.yaml", memO(SETTINGS_REAL, "s.yaml").o);
  assert.ok(st);
  assert.equal(st.defaultProvider, "incoai");
  assert.equal(st.defaultModel, "incoai/Qwen3.8-27B-Splash");
  assert.equal(st.direct?.baseURL, "http://127.0.0.1:8000/v1");
  assert.equal(st.twinPresent, false);
  const withTwin = SETTINGS_REAL.replace(
    "agent-default-model:",
    [
      "    incoai-tds:",
      "      displayName: Splash (via tds)",
      "      api: openai-completions",
      "      baseURL: http://127.0.0.1:8788/v1",
      "      apiKeyEnv: INCOAI_API_KEY",
      "agent-default-model:",
    ].join("\n"),
  );
  const st2 = readSettingsState("s.yaml", memO(withTwin, "s.yaml").o);
  assert.equal(st2?.twinPresent, true);
});

test("line model: section/child/valueLine spans match the real shape", () => {
  const model = buildLineModel(SETTINGS_REAL);
  const sec = model.section("llm-pi-ai");
  assert.ok(sec);
  const child = model.child("llm-pi-ai", "incoai");
  assert.ok(child);
  // incoai is the LAST child in the section, so its span may reach the section end
  assert.ok(child!.start > sec!.start && child!.end <= sec!.end);
  assert.equal(SETTINGS_REAL.split("\n")[child!.start], "    incoai:");
  const vl = model.valueLine("agent-default-model", "provider");
  assert.ok(vl !== null && SETTINGS_REAL.split("\n")[vl!] === "  provider: incoai");
});

// ---------------------------------------------------------------------------
// cordis.patch.yml surgery
// ---------------------------------------------------------------------------

const MCP_ENTRY = renderMcpEntry("/usr/bin/node", "/repo/mcp.ts", "/home/u/.ctxroom");

test("patch merge: empty file → creates with entry + markers", () => {
  const { o, state } = memO(null, "p.yml");
  const r = mergeDshPatch("p.yml", { ...o, entry: MCP_ENTRY });
  assert.ok(r.ok, r.detail);
  const parsed = parseYaml(state.written!);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.ok(patchHasMcpEntry(state.written!));
  assert.ok(state.written!.includes(TDS_BEGIN) && state.written!.includes(TDS_END));
});

test("patch merge: bare [] → replaces with the entry", () => {
  const { o, state } = memO("# comment\n[]\n", "p.yml");
  const r = mergeDshPatch("p.yml", { ...o, entry: MCP_ENTRY });
  assert.ok(r.ok, r.detail);
  assert.ok(patchHasMcpEntry(state.written!));
  const parsed = parseYaml(state.written!);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
});

test("patch merge: foreign entries → appends; !!js entries survive; idempotent", () => {
  const raw = "# header\n- id: compaction-basic\n  config:\n    auto: false\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: 'none'\n";
  const { o, state } = memO(raw, "p.yml");
  assert.ok(mergeDshPatch("p.yml", { ...o, entry: MCP_ENTRY }).ok);
  const once = state.written!;
  assert.match(once, /compaction-basic/);
  assert.match(once, /!!js dshHomePath\('sessions'\)/);
  assert.ok(patchHasMcpEntry(once));
  // idempotent: second run is a no-op
  const o2 = memO(once, "p.yml");
  const r2 = mergeDshPatch("p.yml", { ...o2.o, entry: MCP_ENTRY });
  assert.ok(r2.ok, r2.detail);
  assert.match(r2.detail, /already present/);
  assert.equal(o2.state.written, once);
});

test("patch merge: re-merge replaces the block (upgrade) and keeps foreign entries", () => {
  const raw = "# header\n- id: compaction-basic\n  config:\n    auto: false\n";
  const { o, state } = memO(raw, "p.yml");
  assert.ok(mergeDshPatch("p.yml", { ...o, entry: MCP_ENTRY }).ok);
  const entry2 = renderMcpEntry("/other/node", "/repo/mcp.ts", "/home/u/.ctxroom");
  const r2 = mergeDshPatch("p.yml", { ...o, entry: entry2 });
  assert.ok(r2.ok, r2.detail);
  const next = state.written!;
  assert.match(next, /compaction-basic/);
  assert.match(next, /\/other\/node/);
  assert.doesNotMatch(next, /\/usr\/bin\/node/);
  const parsed = parseYaml(next);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
});

test("patch undo: restores the backup; without backup removes the block", () => {
  const raw = "# header\n- id: compaction-basic\n  config:\n    auto: false\n";
  const { o, state } = memO(raw, "p.yml");
  assert.ok(mergeDshPatch("p.yml", { ...o, entry: MCP_ENTRY }).ok);
  assert.equal(o.read!("p.yml.ctxroom.bak"), raw);
  const r = unmergeDshPatch("p.yml", o);
  assert.ok(r.ok, r.detail);
  assert.equal(state.written, raw);

  // no-backup path
  const { o: o2, state: state2 } = memO(raw, "p.yml");
  assert.ok(mergeDshPatch("p.yml", { ...o2, entry: MCP_ENTRY }).ok);
  const o3: PatchFsOpts = {
    read: (p) => (p.endsWith(".bak") ? null : state2.written),
    write: (p, s) => {
      if (!p.endsWith(".bak")) state2.written = s;
    },
    exists: (p) => (p.endsWith(".bak") ? false : state2.written !== null),
    rm: (p) => {
      if (p.endsWith(".bak")) return;
      if (p === "p.yml") state2.written = null;
    },
  };
  const r2 = unmergeDshPatch("p.yml", o3);
  assert.ok(r2.ok, r2.detail);
  assert.match(state2.written!, /compaction-basic/);
  assert.doesNotMatch(state2.written!, /mcp-ctxroom/);
  assert.ok(parseYaml(state2.written!).ok);
});

test("findMcpEntryFiles: home + profile patch files", () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  try {
    mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
    writeFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), MCP_ENTRY.join("\n") + "\n");
    const found = findMcpEntryFiles(home);
    assert.deepEqual(found, [path.join(home, "profiles", "web", "cordis.patch.yml")]);
    writeFileSync(path.join(home, "cordis.patch.yml"), MCP_ENTRY.join("\n") + "\n");
    assert.equal(findMcpEntryFiles(home).length, 2);
    assert.deepEqual(profilePatchPaths(home), [path.join(home, "profiles", "web", "cordis.patch.yml")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Orchestration (injected lifecycle — no network, no spawns)
// ---------------------------------------------------------------------------

test("runDsh: missing upstream → clean error, nothing written", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  const logs: string[] = [];
  try {
    const code = await runDsh({
      dshHome: home,
      ctxroomHomeDir: path.join(home, "ctx"),
      env: {},
      log: (l) => logs.push(l),
      health: async () => false,
      ensure: async () => ({ port: 8788, started: true }),
      stop: async () => ({ stopped: false }),
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /no upstream endpoint/);
    assert.equal(existsSync(path.join(home, "settings.yaml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDsh: full apply → settings + patch written, summary printed, exit 0", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  const logs: string[] = [];
  try {
    writeFileSync(path.join(home, "settings.yaml"), SETTINGS_REAL);
    const code = await runDsh({
      upstream: "http://127.0.0.1:8000",
      dshHome: home,
      ctxroomHomeDir: path.join(home, "ctx"),
      env: {},
      log: (l) => logs.push(l),
      health: async () => false,
      ensure: async () => ({ port: 8788, started: true }),
      stop: async () => ({ stopped: false }),
    });
    assert.equal(code, 0, logs.join("\n"));
    const settings = readFileSync(path.join(home, "settings.yaml"), "utf8");
    assert.ok(settings.includes("incoai-tds"));
    const parsed = parseYaml(settings);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
    assert.equal(getIn(parsed.value, ["agent-default-model", "provider"])?.kind === "scalar" ? (getIn(parsed.value, ["agent-default-model", "provider"]) as { value: unknown }).value : null, "incoai-tds");
    const patch = path.join(home, "cordis.patch.yml");
    assert.ok(existsSync(patch));
    assert.ok(patchHasMcpEntry(readFileSync(patch, "utf8")));
    assert.ok(existsSync(path.join(home, "settings.yaml.ctxroom.bak")));
    assert.match(logs.join("\n"), /tds for DSH is on/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDsh: --undo after apply restores settings, clears the patch, stops the proxy", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  const logs: string[] = [];
  let stopped = false;
  try {
    writeFileSync(path.join(home, "settings.yaml"), SETTINGS_REAL);
    const opts = {
      upstream: "http://127.0.0.1:8000",
      dshHome: home,
      ctxroomHomeDir: path.join(home, "ctx"),
      env: {} as Record<string, string | undefined>,
      log: (l: string) => logs.push(l),
      health: async () => false,
      ensure: async () => ({ port: 8788, started: true }),
      stop: async () => {
        stopped = true;
        return { stopped: true };
      },
    };
    assert.equal(await runDsh(opts), 0);
    const after = readFileSync(path.join(home, "settings.yaml"), "utf8");
    assert.notEqual(after, SETTINGS_REAL);
    assert.equal(await runDsh({ ...opts, undo: true }), 0);
    assert.equal(readFileSync(path.join(home, "settings.yaml"), "utf8"), SETTINGS_REAL);
    assert.ok(!existsSync(path.join(home, "cordis.patch.yml")));
    assert.ok(stopped);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDsh: healthy proxy with a different upstream that is not ours → refuses without touching files", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  const logs: string[] = [];
  try {
    writeFileSync(path.join(home, "settings.yaml"), SETTINGS_REAL);
    const code = await runDsh({
      upstream: "http://127.0.0.1:8000",
      dshHome: home,
      ctxroomHomeDir: path.join(home, "ctx"),
      env: {},
      log: (l) => logs.push(l),
      health: async () => true,
      healthUpstreamFn: async () => "http://127.0.0.1:9999",
      ensure: async () => ({ port: 8788, started: true }),
      stop: async () => ({ stopped: true }),
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /will not kill it/);
    assert.equal(readFileSync(path.join(home, "settings.yaml"), "utf8"), SETTINGS_REAL); // untouched
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cmdDsh: --undo against a clean home exits 0 without side effects (port 18788: unused)", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  const logs: string[] = [];
  try {
    const code = await cmdDsh(["--undo", "--dsh-home", home, "--port", "18788", "--home", path.join(home, "ctx")]);
    assert.equal(code, 0, logs.join("\n"));
    assert.ok(!existsSync(path.join(home, "settings.yaml")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doctor (DSH section)
// ---------------------------------------------------------------------------

test("doctor: DSH section against a fake home — everything resolved", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  try {
    writeFileSync(
      path.join(home, "settings.yaml"),
      SETTINGS_REAL.replace("  provider: incoai", "  provider: incoai-tds").replace("  model: incoai/Qwen3.8-27B-Splash", "  model: incoai/Qwen3.8-27B-Splash") +
        "llm-pi-ai-tds-route:\n  note: present\n",
    );
    const items = await dshDoctorItems({ port: 18788, env: {}, dshHome: home });
    const labels = items.map((i) => i.label);
    assert.ok(labels.some((l) => l.includes("dsh home")));
    assert.ok(labels.some((l) => l.includes("settings")));
    // nothing hard-broken: the DSH section is all soft
    assert.ok(items.every((i) => i.soft));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDoctor: picks up the DSH section when a DSH home exists (and --dsh forces it)", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-"));
  try {
    writeFileSync(path.join(home, "settings.yaml"), SETTINGS_REAL);
    // force-include against the fake home (port 18788: free; upstream unset → soft-only checks)
    const report = await runDoctor({ port: 18788, dsh: true, dshHome: home, env: { ...process.env }, copilotPath: null as unknown as string, scan: null });
    assert.ok(report.items.some((i) => i.label.includes("dsh home")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// homes
// ---------------------------------------------------------------------------

test("dshHomeDir/ctxroomHome: override > env > default; tilde expansion", () => {
  assert.equal(dshHomeDir(undefined, {}), path.join(os.homedir(), ".dsh"));
  assert.equal(dshHomeDir(undefined, { DSH_HOME: "/x/dsh" }), "/x/dsh");
  assert.equal(dshHomeDir("/override", { DSH_HOME: "/x/dsh" }), "/override");
  assert.equal(dshHomeDir("~", {}), os.homedir());
  assert.equal(ctxroomHome({}), path.join(os.homedir(), ".ctxroom"));
  assert.equal(ctxroomHome({ CTXROOM_HOME: "/c" }), "/c");
});

test("findBlockSpan: markers bound the block; a begin without an end is malformed", () => {
  const lines = ["a: 1", "  # tds:begin — managed by `tds dsh` (remove: `tds dsh --undo`)", "  b: 2", "  # tds:end", "c: 3"];
  const span = findBlockSpan(lines);
  assert.deepEqual(span, { start: 1, end: 3 });
  assert.equal(findBlockSpan(["# tds:begin", "x: 1"]), null);
  assert.equal(findBlockSpan(["x: 1"]), null);
});


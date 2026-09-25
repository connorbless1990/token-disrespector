/**
 * B5 — CLI matrix (work package B): fake install trees × lanes × MCP shapes.
 *
 *   trees:  loader+platform-binary (npm layout) · bare script · binary-only ·
 *           dangling symlink
 *   lanes:  native · byok  (exact env matrix, stale vars stripped)
 *   mcp:    object · array · empty · comments-present, in each shape —
 *           exact block merge, then byte-identical unwrap round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunchEnv,
  classifyBuild,
  copilotEnvMatrix,
  findCopilot,
  mergeMcpConfig,
  mcpEntry,
  stripJsoncComments,
  unwrapMcpConfig,
} from "../src/copilot.ts";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x03, 0, 0, 0]);

// ---------------------------------------------------------------------------
// Install trees
// ---------------------------------------------------------------------------

function buildTree(base: string, kind: "loader+binary" | "script" | "binary-only" | "dangling"): { dir: string; found: string | null } {
  const dir = join(base, kind);
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (kind === "loader+binary") {
    const pkg = join(dir, "node_modules", "@github", "copilot");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@github/copilot", version: "1.0", bin: { copilot: "npm-loader.js" } }));
    const loader = join(pkg, "npm-loader.js");
    writeFileSync(loader, "#!/usr/bin/env node\n// loader\n");
    chmodSync(loader, 0o755);
    const plat = join(pkg, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`);
    mkdirSync(plat, { recursive: true });
    writeFileSync(join(plat, "package.json"), JSON.stringify({ name: `@github/copilot-${process.platform}-${process.arch}`, bin: { copilot: "copilot" } }));
    const bin = join(plat, "copilot");
    writeFileSync(bin, MACHO);
    chmodSync(bin, 0o755);
    const link = join(dir, "bin", "copilot");
    symlinkSync(loader, link);
    return { dir, found: findCopilot({ dirs: [join(dir, "bin")] }) };
  }
  if (kind === "script") {
    const s = join(dir, "bin", "copilot");
    writeFileSync(s, "#!/usr/bin/env node\nconsole.log('x');\n");
    chmodSync(s, 0o755);
    return { dir, found: findCopilot({ dirs: [join(dir, "bin")] }) };
  }
  if (kind === "binary-only") {
    const b = join(dir, "bin", "copilot");
    writeFileSync(b, MACHO);
    chmodSync(b, 0o755);
    return { dir, found: findCopilot({ dirs: [join(dir, "bin")] }) };
  }
  const link = join(dir, "bin", "copilot");
  symlinkSync(join(dir, "missing-target"), link);
  return { dir, found: findCopilot({ dirs: [join(dir, "bin")] }) };
}

test("B5: install-tree matrix — detection per shape", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-matrix-"));
  try {
    const lb = buildTree(base, "loader+binary");
    assert.ok(lb.found, "npm layout loader must be found");
    assert.equal(classifyBuild(lb.found!), "native", "loader resolving to a platform binary = native");

    const script = buildTree(base, "script");
    assert.ok(script.found);
    assert.equal(classifyBuild(script.found!), "js", "bare script = js");

    const binary = buildTree(base, "binary-only");
    assert.ok(binary.found);
    assert.equal(classifyBuild(binary.found!), "native", "bare Mach-O = native");

    const dangling = buildTree(base, "dangling");
    assert.equal(dangling.found, null, "dangling symlink must be skipped");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("B5: lane matrix — exact env per lane, stale other-lane vars stripped", () => {
  const stale = {
    PATH: "/usr/bin",
    COPILOT_API_URL: "http://stale.example",
    COPILOT_AUTH_MODE: "github-native",
    COPILOT_PROVIDER_BASE_URL: "http://stale-provider.example/v1",
    COPILOT_PROVIDER_TYPE: "openai",
    GITHUB_COPILOT_USE_TOKEN_EXCHANGE: "true",
  };
  const native = buildLaunchEnv(stale, 8788, "native");
  assert.deepEqual(native, {
    PATH: "/usr/bin",
    COPILOT_API_URL: "http://127.0.0.1:8788",
    COPILOT_AUTH_MODE: "github-native",
    // neutral (non-lane-steering) base vars are inherited
    GITHUB_COPILOT_USE_TOKEN_EXCHANGE: "true",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  }, "native lane: provider vars stripped, exact matrix");

  const byok = buildLaunchEnv(stale, 8788, "byok");
  assert.deepEqual(byok, {
    PATH: "/usr/bin",
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:8788/v1",
    COPILOT_PROVIDER_WIRE_API: "completions",
    GITHUB_COPILOT_USE_TOKEN_EXCHANGE: "false",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  }, "byok lane: native vars stripped, exact matrix");

  // The two lanes are disjoint on the steering vars.
  const steerN = copilotEnvMatrix(8788, "native");
  const steerB = copilotEnvMatrix(8788, "byok");
  for (const k of Object.keys(steerN)) {
    if (k === "NO_PROXY" || k === "no_proxy") continue;
    assert.ok(!(k in steerB), `native steering var ${k} must not leak into byok`);
  }
});

// ---------------------------------------------------------------------------
// MCP config shapes (comments-present variants) × merge/unwrap round-trip
// ---------------------------------------------------------------------------

const SHAPES: Record<string, string> = {
  object: ["{", '  "mcpServers": {', '    "github": { "command": "gh" }', "  },", '  "theme": "dark"', "}", ""].join("\n"),
  array: '{\n  "mcpServers": [\n    { "name": "other", "command": "x" }\n  ]\n}\n',
  empty: "",
  "object+comments": [
    "{",
    "  // leading user comment",
    '  "mcpServers": {',
    '    "github": { "command": "gh" } // inline comment',
    "  },",
    '  "theme": "dark" /* block comment */',
    "}",
    "",
  ].join("\n"),
  "array+comments": [
    "{",
    "  // leading comment",
    '  "mcpServers": [',
    '    { "name": "other", "command": "x" } // keep me',
    "  ] /* trailing */",
    "}",
    "",
  ].join("\n"),
};

test("B5: MCP shape matrix — exact merge block, byte-identical unwrap round-trip", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-mcpmatrix-"));
  try {
    for (const [name, original] of Object.entries(SHAPES)) {
      const p = join(base, `mcp-${name}.json`);
      writeFileSync(p, original);

      // Merge (native schema: type + tools).
      const res = mergeMcpConfig(p, mcpEntry("/abs/mcp.ts", "native"));
      assert.equal(res.ok, true, `${name}: merge must succeed (${res.detail})`);
      const merged = readFileSync(p, "utf8");
      assert.equal((merged.match(/ctxroom:begin/g) ?? []).length, 1, `${name}: exactly one marked block`);
      const parsed = JSON.parse(stripJsoncComments(merged)) as { mcpServers: unknown };
      assert.ok(JSON.stringify(parsed).includes("ctxroom"), `${name}: entry present after merge`);
      assert.ok(JSON.stringify(parsed).includes('"type":"local"') || JSON.stringify(parsed).includes('"type": "local"'), `${name}: native schema carried`);

      // Re-merge must stay idempotent (block replaced, not duplicated).
      assert.equal(mergeMcpConfig(p, mcpEntry("/abs2/mcp.ts", "native")).ok, true, `${name}: re-merge`);
      assert.equal((readFileSync(p, "utf8").match(/ctxroom:begin/g) ?? []).length, 1, `${name}: still one block`);

      // Unwrap restores the exact original bytes.
      const un = unwrapMcpConfig(p);
      assert.equal(un.ok, true, `${name}: unwrap must succeed (${un.detail})`);
      assert.equal(readFileSync(p, "utf8"), original, `${name}: byte-identical round-trip`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

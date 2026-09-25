/**
 * CLI tests — everything runs without the real Copilot CLI:
 * env-matrix builders, feature detection against a temp bundle, MCP-config
 * merge/unwrap round-trips on a temp JSONC file, doctor against a fake
 * copilot stub, and the full copilot flow with an injected spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcrStore } from "@ctxroom/core";
import { startProxy, StatsWriter } from "@ctxroom/proxy";
import {
  buildLaunchEnv,
  classifyBuild,
  copilotEnvMatrix,
  defaultMcpConfigPath,
  detectBuildKind,
  findCopilot,
  mergeMcpConfig,
  mcpEntry,
  resolveCopilotPlatformBinary,
  resolveMcpServerPath,
  scanBundle,
  stripJsoncComments,
  unwrapMcpConfig,
  ensureProxy,
  stopProxy,
  pidfileFor,
} from "../src/copilot.ts";
import { runDoctor } from "../src/doctor.ts";
import { runCopilot, parseArgs, copilotPathOverride, cmdCopilot, laneOverride, copilotSpawnArgs } from "../src/index.ts";
import { runRetrieve, runSimulate, runStats } from "../src/commands.ts";

const M = "node"; // the mcp command the entry registers

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs: flags, =, booleans, and -- passthrough", () => {
  const a = parseArgs(["copilot", "--port", "9999", "--ccr=off", "--stop-proxy", "--", "-v", "--weird"]);
  assert.equal(a.flags.port, "9999");
  assert.equal(a.flags.ccr, "off");
  assert.equal(a.flags["stop-proxy"], true);
  // the command word is positional too (main() strips it before dispatch)
  assert.deepEqual(a.positional, ["copilot", "-v", "--weird"]);
  // The command word is positional too (main() strips it before dispatch).
  const b = parseArgs(["retrieve", "abc123", "500"]);
  assert.deepEqual(b.positional, ["retrieve", "abc123", "500"]);
});

// ---------------------------------------------------------------------------
// env matrix builders
// ---------------------------------------------------------------------------

test("env matrix: native lane", () => {
  const m = copilotEnvMatrix(8788, "native");
  assert.equal(m.COPILOT_API_URL, "http://127.0.0.1:8788");
  assert.equal(m.COPILOT_AUTH_MODE, "github-native");
  assert.equal(m.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(m.no_proxy, "127.0.0.1,localhost");
  assert.equal(m.COPILOT_PROVIDER_TYPE, undefined);
});

test("env matrix: BYOK lane points at the proxy's /v1 chat-completions", () => {
  const m = copilotEnvMatrix(9999, "byok");
  assert.equal(m.COPILOT_PROVIDER_TYPE, "openai");
  assert.equal(m.COPILOT_PROVIDER_BASE_URL, "http://127.0.0.1:9999/v1");
  assert.equal(m.COPILOT_PROVIDER_WIRE_API, "completions");
  assert.equal(m.GITHUB_COPILOT_USE_TOKEN_EXCHANGE, "false");
  assert.equal(m.COPILOT_API_URL, undefined);
});

test("buildLaunchEnv: native strips ALL COPILOT_PROVIDER_*; keeps the rest", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/x",
    COPILOT_PROVIDER_TYPE: "anthropic",
    COPILOT_PROVIDER_BASE_URL: "http://evil.example",
    COPILOT_PROVIDER_WIRE_API: "responses",
    GITHUB_COPILOT_ENTERPRISE_URL: "https://api.corp.example",
    GITHUB_TOKEN: "ghp_x",
  };
  const env = buildLaunchEnv(base, 8788, "native");
  assert.equal(env.COPILOT_API_URL, "http://127.0.0.1:8788");
  assert.equal(env.COPILOT_AUTH_MODE, "github-native");
  assert.equal(env.COPILOT_PROVIDER_TYPE, undefined);
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined);
  assert.equal(env.GITHUB_COPILOT_ENTERPRISE_URL, "https://api.corp.example");
  assert.equal(env.GITHUB_TOKEN, "ghp_x");
  assert.equal(env.PATH, "/usr/bin");
});

test("buildLaunchEnv: BYOK strips the native-lane vars", () => {
  const base = { PATH: "/usr/bin", COPILOT_API_URL: "http://stale.example", COPILOT_AUTH_MODE: "github-native" };
  const env = buildLaunchEnv(base, 1234, "byok");
  assert.equal(env.COPILOT_API_URL, undefined);
  assert.equal(env.COPILOT_AUTH_MODE, undefined);
  assert.equal(env.COPILOT_PROVIDER_TYPE, "openai");
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "http://127.0.0.1:1234/v1");
});

// ---------------------------------------------------------------------------
// copilot locate + feature detection
// ---------------------------------------------------------------------------

test("findCopilot: locates an executable, skips non-executable, returns null when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-bin-"));
  try {
    const good = join(dir, "copilot");
    writeFileSync(good, "#!/bin/sh\necho fake\n");
    chmodSync(good, 0o755);
    assert.equal(findCopilot({ dirs: [dir] }), good);

    const noexec = join(dir, "copilot2");
    writeFileSync(noexec, "not a binary");
    assert.equal(findCopilot({ dirs: [dir], binName: "copilot2" }), null, "non-executable must not match");
    assert.equal(findCopilot({ dirs: [join(dir, "nowhere")], binName: "copilot" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findCopilot: follows a SYMLINK to an executable (npm/bun/brew layout)", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-symlink-"));
  try {
    // Real binary lives in a package dir; a symlink in a PATH dir points at it.
    const pkg = join(base, "node_modules", "@github", "copilot", "bin");
    mkdirSync(pkg, { recursive: true });
    const real = join(pkg, "copilot.js");
    writeFileSync(real, "#!/usr/bin/env node\nconsole.log('copilot');\n");
    chmodSync(real, 0o755);

    const bin = join(base, "bin");
    mkdirSync(bin);
    const link = join(bin, "copilot"); // the name the search looks for
    symlinkSync(real, link);

    // A symlink whose target is executable must be found (this is exactly the
    // layout npm/bun/brew produce, and the bug that went undetected before).
    assert.equal(findCopilot({ dirs: [bin] }), link);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findCopilot: skips a dangling symlink (target missing)", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-dangle-"));
  try {
    const bin = join(base, "bin");
    mkdirSync(bin);
    symlinkSync(join(base, "does-not-exist"), join(bin, "copilot"));
    assert.equal(findCopilot({ dirs: [bin] }), null, "dangling link must be skipped");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("copilotPathOverride: --copilot flag beats CTXROOM_COPILOT_PATH env", () => {
  assert.equal(copilotPathOverride({ copilot: "/a" }, { CTXROOM_COPILOT_PATH: "/b" }), "/a");
  assert.equal(copilotPathOverride({}, { CTXROOM_COPILOT_PATH: "/b" }), "/b");
  assert.equal(copilotPathOverride({}, {}), undefined);
  assert.equal(copilotPathOverride({ copilot: false } as Record<string, string | number | boolean>), undefined, "boolean flag is not a path");
});

test("laneOverride: --lane flag beats CTXROOM_COPILOT_LANE env; bad values ignored", () => {
  assert.equal(laneOverride({ lane: "byok" }, { CTXROOM_COPILOT_LANE: "native" }), "byok");
  assert.equal(laneOverride({}, { CTXROOM_COPILOT_LANE: "native" }), "native");
  assert.equal(laneOverride({ lane: "weird" } as Record<string, string | number | boolean>), undefined);
  assert.equal(laneOverride({}, {}), undefined);
});

test("detectBuildKind: Mach-O and ELF are native, text is js, missing is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-kind-"));
  try {
    const macho = join(dir, "copilot-macho");
    writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x03, 0x00, 0x00, 0x00, 0, 0, 0, 0]));
    assert.equal(detectBuildKind(macho), "native");
    const machoLe = join(dir, "copilot-macho-le");
    writeFileSync(machoLe, Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x02, 0x00, 0x00, 0x00]));
    assert.equal(detectBuildKind(machoLe), "native");
    const elf = join(dir, "copilot-elf");
    writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
    assert.equal(detectBuildKind(elf), "native");
    const script = join(dir, "copilot.js");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log(1);\n");
    assert.equal(detectBuildKind(script), "js");
    assert.equal(detectBuildKind(join(dir, "absent")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copilotSpawnArgs: forwards copilot flags, keeps ctxroom's own", () => {
  const { flags, positional } = parseArgs(["-p", "hi there", "--model", "qwen", "--port", "9000", "--stop-proxy"]);
  const out = copilotSpawnArgs(flags, positional);
  assert.ok(out.includes("-p") && out.includes("hi there"), "prompt passthrough");
  const mi = out.indexOf("--model");
  assert.ok(mi !== -1 && out[mi + 1] === "qwen", "--model forwarded with its value");
  assert.ok(!out.includes("--port"), "ctxroom's own --port is not forwarded");
  assert.ok(!out.includes("--stop-proxy"), "ctxroom's own --stop-proxy is not forwarded");
});

test("classifyBuild: a JS loader resolving to a platform binary is 'native'", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-classify-"));
  try {
    const pkg = join(base, "node_modules", "@github", "copilot");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@github/copilot", bin: { copilot: "npm-loader.js" } }));
    const loader = join(pkg, "npm-loader.js");
    writeFileSync(loader, "#!/usr/bin/env node\n");
    // No platform binary present → js.
    assert.equal(classifyBuild(loader), "js");
    // Add the platform binary (with a Mach-O header) → native.
    const platDir = join(pkg, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`);
    mkdirSync(platDir, { recursive: true });
    writeFileSync(join(platDir, "package.json"), JSON.stringify({ name: `@github/copilot-${process.platform}-${process.arch}`, bin: { x: "copilot" }, exports: { ".": "./copilot" } }));
    writeFileSync(join(platDir, "copilot"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x03, 0, 0, 0]));
    assert.equal(classifyBuild(loader), "native");
    // A bare script with no package context → js.
    const bare = join(base, "standalone.js");
    writeFileSync(bare, "console.log(1);\n");
    assert.equal(classifyBuild(bare), "js");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mcpEntry + defaultMcpConfigPath: native builds get mcp-config.json with type/tools", () => {
  const home = "/fakehome";
  assert.equal(defaultMcpConfigPath(home, "native"), join(home, ".copilot", "mcp-config.json"));
  assert.equal(defaultMcpConfigPath(home, "js"), join(home, ".copilot", "mcp.json"));
  assert.equal(defaultMcpConfigPath(home), join(home, ".copilot", "mcp.json"), "js is the historical default");

  const native = mcpEntry("/abs/mcp.ts", "native") as { name?: string; command: string; args: string[]; type?: string; tools?: string[] };
  assert.equal(native.command, "node");
  assert.deepEqual(native.args, ["/abs/mcp.ts"]);
  assert.equal(native.type, "local", "native schema carries type");
  assert.deepEqual(native.tools, ["*"], "native schema carries tools");
  assert.equal(native.name, "ctxroom", "name stays (it is the object key / array field)");

  const js = mcpEntry("/abs/mcp.ts") as { type?: string; tools?: string[] };
  assert.equal(js.type, undefined, "js shape stays minimal");
  assert.equal(js.tools, undefined);
});

test("scanBundle: finds markers byte-embedded in the platform binary of an npm install", () => {
  const base = mkdtempSync(join(tmpdir(), "ctxroom-nativescan-"));
  try {
    // Fake npm global layout: loader + optional-dep platform binary.
    const pkg = join(base, "node_modules", "@github", "copilot");
    mkdirSync(join(pkg), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@github/copilot", bin: { copilot: "npm-loader.js" } }));
    writeFileSync(join(pkg, "npm-loader.js"), "#!/usr/bin/env node\n// loader shim\n");
    const binDir = join(base, "bin");
    mkdirSync(binDir);
    symlinkSync(join(pkg, "npm-loader.js"), join(binDir, "copilot"));

    // The platform binary: extensionless, with the markers embedded as raw bytes.
    const platDir = join(pkg, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`);
    mkdirSync(platDir, { recursive: true });
    const binary = join(platDir, "copilot");
    const payload = Buffer.concat([
      Buffer.from("\x7fELF junk padding here "),
      Buffer.from("COPILOT_API_URL"),
      Buffer.from(" random bytes "),
      Buffer.from("COPILOT_PROVIDER_BASE_URL"),
    ]);
    writeFileSync(binary, payload);

    // realpath both sides: on macOS the temp dir lives behind the
    // /var → /private/var symlink and realpathSync normalizes it.
    const real = resolveCopilotPlatformBinary(join(binDir, "copilot"));
    assert.equal(realpathSync(real!), realpathSync(binary), "the optional-dep binary is located");

    const scan = scanBundle({ roots: [binDir, pkg], realPath: join(binDir, "copilot") });
    assert.equal(scan.markers["COPILOT_API_URL"], true, "byte-scanned the compiled binary");
    assert.equal(scan.markers["COPILOT_PROVIDER_BASE_URL"], true);
    assert.ok(scan.bundlePath, "bundle path recorded");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runCopilot: forced --lane byok proceeds even when the scan sees nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-forcelane-"));
  const port = 18907;
  let seenEnv: Record<string, string> | null = null;
  const logs: string[] = [];
  try {
    const code = await runCopilot({
      port,
      copilotPath: "/fake/copilot",
      scan: { supported: false, markers: {}, bundlePath: null, filesScanned: 0 },
      lane: "byok",
      mcpConfigPath: join(home, "mcp.json"),
      env: { PATH: "/usr/bin" } as Record<string, string | undefined>,
      spawn: async (_cmd, _args, env) => {
        seenEnv = env;
        return 0;
      },
      log: (l) => logs.push(l),
      stopProxyOnExit: true,
    });
    assert.equal(code, 0);
    assert.ok(seenEnv!.COPILOT_PROVIDER_BASE_URL?.includes(`127.0.0.1:${port}`), "provider base URL points at the proxy");
    assert.ok(logs.some((l) => l.includes("BYOK (forced)")), "loud forced-lane note");
  } finally {
    await stopProxy({ port, home, log: () => {} });
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot: native binary with an invisible bundle assumes the native lane", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-natassumed-"));
  const port = 18908;
  // A "binary" with a Mach-O header so detectBuildKind classifies it native.
  const fakeBin = join(home, "copilot-bin");
  writeFileSync(fakeBin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x03, 0x00, 0x00, 0x00, 0, 0]));
  chmodSync(fakeBin, 0o755);
  let seenEnv: Record<string, string> | null = null;
  const logs: string[] = [];
  try {
    const code = await runCopilot({
      port,
      copilotPath: fakeBin,
      scan: { supported: false, markers: {}, bundlePath: null, filesScanned: 0 },
      mcpConfigPath: join(home, "mcp.json"),
      env: { PATH: "/usr/bin" } as Record<string, string | undefined>,
      spawn: async (_cmd, _args, env) => {
        seenEnv = env;
        return 0;
      },
      log: (l) => logs.push(l),
      stopProxyOnExit: true,
    });
    assert.equal(code, 0);
    assert.equal(seenEnv!.COPILOT_API_URL, `http://127.0.0.1:${port}`, "native lane env set");
    assert.ok(logs.some((l) => l.includes("native binary")), "assumption is loudly documented");
  } finally {
    await stopProxy({ port, home, log: () => {} });
    rmSync(home, { recursive: true, force: true });
  }
});

test("feature detection: finds COPILOT_API_URL in a temp bundle, honors roots", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxroom-bundle-"));
  try {
    const pkg = join(root, "copilot", "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "app.js"), "/* minified */ const u = 'COPILOT_API_URL' /* marker */;");
    // A decoy without the marker that sorts first alphabetically must not win.
    writeFileSync(join(pkg, "zz.js"), "nothing interesting");

    const res = scanBundle({ roots: [root] });
    assert.equal(res.supported, true);
    assert.equal(res.markers.COPILOT_API_URL, true);
    assert.equal(res.markers.COPILOT_PROVIDER_BASE_URL, false);
    assert.equal(res.bundlePath, join(pkg, "app.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature detection: no marker → unsupported", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxroom-bundle2-"));
  try {
    writeFileSync(join(root, "app.js"), "var a = 1;");
    const res = scanBundle({ roots: [root] });
    assert.equal(res.supported, false);
    assert.equal(res.markers.COPILOT_API_URL, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MCP config merge / unwrap (temp JSONC files)
// ---------------------------------------------------------------------------

test("mcp merge into an empty file: creates mcpServers list (spec shape) + backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    writeFileSync(p, "");
    const res = mergeMcpConfig(p, mcpEntry("/abs/mcp/src/index.ts"));
    assert.equal(res.ok, true);
    const raw = readFileSync(p, "utf8");
    assert.ok(raw.includes("// ctxroom:begin"), "marked block present");
    assert.ok(raw.includes('"mcpServers"'));
    const j = JSON.parse(stripJsoncComments(raw)) as { mcpServers: Record<string, unknown>[] };
    assert.equal(j.mcpServers.length, 1);
    assert.equal((j.mcpServers[0] as { name: string }).name, "ctxroom");
    assert.deepEqual((j.mcpServers[0] as { args: string[] }).args, ["/abs/mcp/src/index.ts"]);
    assert.ok(statSync(`${p}.ctxroom.bak`).size === 0, "backup of the empty original exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp merge preserves every other byte; object-shaped mcpServers gets a keyed entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    const original = [
      "{",
      '  // user comment with braces { } and a "quoted string"',
      '  "mcpServers": {',
      '    "github": { "command": "gh", "args": ["mcp-server"] }',
      "  },",
      '  "other": 42 /* trailing */',
      "}",
      "",
    ].join("\n");
    writeFileSync(p, original);

    const res = mergeMcpConfig(p, mcpEntry("/abs/mcp/src/index.ts"));
    assert.equal(res.ok, true, res.detail);
    const merged = readFileSync(p, "utf8");

    // every original byte is still present, in order, outside the block
    assert.ok(merged.includes(original.slice(0, 20)), "head preserved");
    assert.ok(merged.includes('"github": { "command": "gh", "args": ["mcp-server"] },'), "github entry preserved verbatim");
    assert.ok(merged.includes('"other": 42 /* trailing */'), "other bytes + comment preserved");
    assert.ok(merged.includes("// user comment with braces { } and a \"quoted string\""), "comments preserved");

    const j = JSON.parse(stripJsoncComments(merged)) as { mcpServers: Record<string, { command: string; args: string[] }> };
    assert.ok(j.mcpServers.github, "existing server survives");
    assert.equal(j.mcpServers.ctxroom.command, "node");
    assert.ok(Array.isArray(j.mcpServers.ctxroom.args));
    // no trailing comma issues: re-parse is the proof
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp merge into an array-shaped mcpServers, idempotent on re-merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    writeFileSync(p, '{\n  "mcpServers": [\n    { "name": "other", "command": "x" }\n  ]\n}\n');
    assert.equal(mergeMcpConfig(p, mcpEntry("/a.ts")).ok, true);
    assert.equal(mergeMcpConfig(p, mcpEntry("/b.ts")).ok, true); // re-merge
    const raw = readFileSync(p, "utf8");
    const j = JSON.parse(stripJsoncComments(raw)) as { mcpServers: { name: string; args: string[] }[] };
    assert.equal(j.mcpServers.length, 2, "no duplicate ctxroom entries");
    const ctx = j.mcpServers.filter((s) => s.name === "ctxroom");
    assert.equal(ctx.length, 1);
    assert.deepEqual(ctx[0].args, ["/b.ts"], "re-merge updates the path in place");
    assert.ok(raw.includes('"name": "other"'), "other entry intact");
    assert.equal((raw.match(/ctxroom:begin/g) ?? []).length, 1, "exactly one marked block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp unwrap: round-trip restores the exact original bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    const original = [
      "{",
      '  "mcpServers": {',
      '    "github": { "command": "gh" }',
      "  },",
      '  "theme": "dark"',
      "}",
      "",
    ].join("\n");
    writeFileSync(p, original);
    assert.equal(mergeMcpConfig(p, mcpEntry("/x.ts")).ok, true);
    const merged = readFileSync(p, "utf8");
    assert.notEqual(merged, original, "merge changed the file");

    const res = unwrapMcpConfig(p);
    assert.equal(res.ok, true, res.detail);
    assert.equal(readFileSync(p, "utf8"), original, "unwrap restores byte-identical original");
    assert.ok(!statSyncSafe(`${p}.ctxroom.bak`), "backup consumed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp unwrap without backup: surgical removal keeps valid JSONC", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    writeFileSync(p, '');
    assert.equal(mergeMcpConfig(p, mcpEntry("/x.ts")).ok, true);
    // Delete the backup so unwrap must do the surgical path.
    rmSync(`${p}.ctxroom.bak`);
    const res = unwrapMcpConfig(p);
    assert.equal(res.ok, true, res.detail);
    const raw = readFileSync(p, "utf8");
    assert.ok(!raw.includes("ctxroom:begin"), "block removed");
    JSON.parse(stripJsoncComments(raw)); // still valid
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp merge never writes an invalid config (corrupt input → backup restored)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-mcp-"));
  const p = join(dir, "mcp.json");
  try {
    const corrupt = '{ "mcpServers": [ { broken json !!! ';
    writeFileSync(p, corrupt);
    const res = mergeMcpConfig(p, mcpEntry("/x.ts"));
    assert.equal(res.ok, false, res.detail);
    assert.equal(readFileSync(p, "utf8"), corrupt, "original preserved, not clobbered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// doctor (fake copilot stub + injected scan)
// ---------------------------------------------------------------------------

test("doctor: healthy environment → all items ok, not broken", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-doctor-"));
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, "copilot");
  await writeFile(stub, "#!/bin/sh\necho 1.2.3-fake\n");
  chmodSync(stub, 0o755);
  try {
    const port = 18799; // almost certainly free
    const report = await runDoctor({
      port,
      home,
      copilotPath: stub,
      scan: { supported: true, markers: { COPILOT_API_URL: true, COPILOT_PROVIDER_BASE_URL: true }, bundlePath: stub, filesScanned: 1 },
      env: { ...process.env, CTXROOM_HOME: home, GH_TOKEN: "ghp_test" } as Record<string, string | undefined>,
    });
    for (const item of report.items) {
      assert.ok(item.ok, `${item.label} should pass: ${item.detail}`);
    }
    assert.equal(report.broken, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor: missing copilot → broken", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-doctor-"));
  try {
    const report = await runDoctor({
      port: 18798,
      home,
      copilotPath: null, // injected: not found
      scan: { supported: false, markers: {}, bundlePath: null, filesScanned: 0 },
      env: { ...process.env, CTXROOM_HOME: home } as Record<string, string | undefined>,
    });
    assert.equal(report.broken, true);
    assert.ok(report.items.some((i) => !i.ok && i.label.includes("copilot CLI")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the full copilot flow (injected spawn; real proxy on an ephemeral port)
// ---------------------------------------------------------------------------

test("runCopilot: native lane end-to-end (env, mcp config, exit code, proxy left running)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-flow-"));
  const dir = join(home, "bin");
  await mkdir(dir, { recursive: true });
  const stub = join(dir, "copilot");
  await writeFile(stub, "#!/bin/sh\necho fake-copilot\nexit 3\n");
  chmodSync(stub, 0o755);
  const configPath = join(home, "mcp.json");
  await writeMcpOriginal(configPath);

  // A healthy proxy must already be listening for ensureProxy to no-op.
  const proxy = await startProxy({
    port: 0,
    env: {} as NodeJS.ProcessEnv,
    config: { ccr: { enabled: true, dir: join(home, "cache") } },
    stats: new StatsWriter(join(home, "stats"), home),
  });

  let seenEnv: Record<string, string> | null = null;
  let seenArgs: string[] | null = null;
  let seenCmd: string | null = null;
  const code = await runCopilot({
    port: proxy.port,
    copilotPath: stub,
    scan: { supported: true, markers: { COPILOT_API_URL: true, COPILOT_PROVIDER_BASE_URL: false }, bundlePath: stub, filesScanned: 1 },
    mcpConfigPath: configPath,
    spawnArgs: ["--verbose", "do a task"],
    spawn: async (cmd, args, env) => {
      seenCmd = cmd;
      seenArgs = args;
      seenEnv = env;
      return 3;
    },
    log: () => {},
  });

  try {
    assert.equal(code, 3, "exit code passes through");
    assert.equal(seenCmd, stub);
    assert.deepEqual(seenArgs, ["--verbose", "do a task"]);
    assert.equal(seenEnv!.COPILOT_API_URL, `http://127.0.0.1:${proxy.port}`);
    assert.equal(seenEnv!.COPILOT_AUTH_MODE, "github-native");
    assert.equal(seenEnv!.COPILOT_PROVIDER_TYPE, undefined);

    // MCP config: marked block registered, original bytes preserved.
    const merged = readFileSync(configPath, "utf8");
    assert.ok(merged.includes("// ctxroom:begin"));
    assert.ok(merged.includes('"userTheme": "dark"'), "pre-existing key preserved");
    // No mcpServers existed → the root placement creates the spec-literal
    // LIST shape: {"name":"ctxroom","command":"node","args":[...]}
    const j = JSON.parse(stripJsoncComments(merged)) as { mcpServers: { name: string; command: string; args: string[] }[] };
    const entry = j.mcpServers.find((s) => s.name === "ctxroom");
    assert.ok(entry, "ctxroom registered");
    assert.equal(entry!.command, "node");
    const mcpPath = entry!.args[0];
    assert.equal(mcpPath, resolveMcpServerPath(fileURLToPath(new URL("../src/index.ts", import.meta.url))));
    assert.ok(statSyncSafe(mcpPath), "registered mcp entry must exist on disk");

    // The proxy is still running afterwards (left running by default).
    const health = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot: BYOK fallback warns and strips native-lane vars", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-flow-byok-"));
  const proxy = await startProxy({
    port: 0,
    env: {} as NodeJS.ProcessEnv,
    config: { ccr: { enabled: true, dir: join(home, "cache") } },
    stats: new StatsWriter(join(home, "stats"), home),
  });
  const warnings: string[] = [];
  let seenEnv: Record<string, string> | null = null;
  try {
    const code = await runCopilot({
      port: proxy.port,
      copilotPath: "/fake/copilot",
      scan: { supported: true, markers: { COPILOT_API_URL: false, COPILOT_PROVIDER_BASE_URL: true }, bundlePath: null, filesScanned: 1 },
      mcpConfigPath: join(home, "mcp.json"),
      env: { PATH: "/usr/bin", COPILOT_API_URL: "http://stale.example" } as Record<string, string | undefined>,
      spawn: async (_cmd, _args, env) => {
        seenEnv = env;
        return 0;
      },
      log: (l) => warnings.push(l),
    });
    assert.equal(code, 0);
    assert.equal(seenEnv!.COPILOT_PROVIDER_TYPE, "openai");
    assert.equal(seenEnv!.COPILOT_PROVIDER_BASE_URL, `http://127.0.0.1:${proxy.port}/v1`);
    assert.equal(seenEnv!.COPILOT_API_URL, undefined, "stale native-lane var stripped");
    assert.ok(warnings.some((w) => w.includes("BYOK")), "loud BYOK warning emitted");
  } finally {
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot A4: zero requests → loud diagnostic, exit code unchanged", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-a4-"));
  const proxy = await startProxy({
    port: 0,
    env: {} as NodeJS.ProcessEnv,
    config: { ccr: { enabled: true, dir: join(home, "cache") } },
    stats: new StatsWriter(join(home, "stats"), home),
  });
  const logs: string[] = [];
  try {
    const code = await runCopilot({
      port: proxy.port,
      home,
      copilotPath: "/fake/copilot",
      scan: { supported: true, markers: { COPILOT_API_URL: false, COPILOT_PROVIDER_BASE_URL: true }, bundlePath: null, filesScanned: 1 },
      mcpConfigPath: join(home, "mcp.json"),
      spawnArgs: ["-p", "do something"],
      spawn: async () => 0, // the run ends without any request reaching the proxy
      log: (l) => logs.push(l),
    });
    assert.equal(code, 0, "exit code passes through untouched");
    assert.ok(logs.some((l) => l.includes("ZERO requests")), "diagnostic emitted: " + logs.join("\n"));
    assert.ok(logs.some((l) => l.includes("tds doctor")), "points at doctor");
  } finally {
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot A4: requests recorded during the run → no diagnostic", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-a4b-"));
  const proxy = await startProxy({
    port: 0,
    env: {} as NodeJS.ProcessEnv,
    config: { ccr: { enabled: true, dir: join(home, "cache") } },
    stats: new StatsWriter(join(home, "stats"), home),
  });
  const logs: string[] = [];
  try {
    const code = await runCopilot({
      port: proxy.port,
      home,
      copilotPath: "/fake/copilot",
      scan: { supported: true, markers: { COPILOT_API_URL: false, COPILOT_PROVIDER_BASE_URL: true }, bundlePath: null, filesScanned: 1 },
      mcpConfigPath: join(home, "mcp.json"),
      spawnArgs: ["-p", "do something"],
      spawn: async () => {
        // Simulate the proxy having seen the request (its async append).
        const day = new Date().toISOString().slice(0, 10);
        mkdirSync(join(home, "stats"), { recursive: true });
        appendFileSync(join(home, "stats", `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), project: "default", model: "m", path: "/v1/chat/completions", tokensBefore: 10, tokensAfter: 5, tokensSaved: 5, transforms: [], ccrStored: 1, ms: 1 }) + "\n", "utf8");
        return 0;
      },
      log: (l) => logs.push(l),
    });
    assert.equal(code, 0);
    assert.ok(!logs.some((l) => l.includes("ZERO requests")), "no false alarm: " + logs.join("\n"));
  } finally {
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot A4: trivial --version exits with zero requests silently", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-a4c-"));
  const proxy = await startProxy({
    port: 0,
    env: {} as NodeJS.ProcessEnv,
    config: { ccr: { enabled: true, dir: join(home, "cache") } },
    stats: new StatsWriter(join(home, "stats"), home),
  });
  const logs: string[] = [];
  try {
    const code = await runCopilot({
      port: proxy.port,
      home,
      copilotPath: "/fake/copilot",
      scan: { supported: true, markers: { COPILOT_API_URL: false, COPILOT_PROVIDER_BASE_URL: true }, bundlePath: null, filesScanned: 1 },
      mcpConfigPath: join(home, "mcp.json"),
      spawnArgs: ["--version"],
      spawn: async () => 0,
      log: (l) => logs.push(l),
    });
    assert.equal(code, 0);
    assert.ok(!logs.some((l) => l.includes("ZERO requests")), "version probe is not a wiring failure");
  } finally {
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runCopilot: no lane supported → clean failure, no spawn", async () => {
  let spawned = false;
  const code = await runCopilot({
    copilotPath: "/fake/copilot",
    scan: { supported: false, markers: {}, bundlePath: null, filesScanned: 0 },
    mcpConfigPath: join(tmpdir(), "nowhere-mcp.json"),
    spawn: async () => {
      spawned = true;
      return 0;
    },
    log: () => {},
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
});

test("cmdCopilot: --copilot pointing at a missing path fails early (no proxy, no spawn)", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const code = await cmdCopilot(["--copilot", "/definitely/not/a/real/copilot"]);
    assert.equal(code, 1);
    assert.ok(errors.some((l) => l.includes("does not exist")), "clear error message");
    assert.ok(!errors.some((l) => l.includes("listening")), "proxy never started");
  } finally {
    console.error = orig;
  }
});

test("ensureProxy + stopProxy: real detached lifecycle on an ephemeral port", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-lifecycle-"));
  const port = 18901;
  try {
    // health check must see nothing at first
    const ensured = await ensureProxy({ port, home, log: () => {} });
    assert.equal(ensured.started, true);
    assert.ok(ensured.pid, "pid recorded");
    assert.ok(statSyncSafe(pidfileFor(port, home)), "pidfile written");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    // idempotent: a second ensure finds the healthy proxy
    const again = await ensureProxy({ port, home, log: () => {} });
    assert.equal(again.started, false);

    const stopped = await stopProxy({ port, home, log: () => {} });
    assert.equal(stopped.stopped, true);
    assert.ok(!statSyncSafe(pidfileFor(port, home)), "pidfile removed");
    await new Promise((r) => setTimeout(r, 200));
    const alive = await fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false);
    assert.equal(alive, false, "proxy no longer listening");
  } finally {
    await stopProxy({ port, home, log: () => {} }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// retrieve / simulate / stats commands
// ---------------------------------------------------------------------------

test("runRetrieve: exact original, and a clean failure for unknown hashes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-cli-"));
  const prev = process.env.CTXROOM_HOME;
  process.env.CTXROOM_HOME = home;
  try {
    const store = new CcrStore();
    await store.store("retrievable original content for the cli test");
    const hash = await store.store("second original here");
    const okCode = await runRetrieve(hash!);
    assert.equal(okCode, 0);
    const badCode = await runRetrieve("deadbeef0000");
    assert.equal(badCode, 1);
  } finally {
    process.env.CTXROOM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runSimulate: offline engine run over a temp prompt file", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-cli-"));
  const prev = process.env.CTXROOM_HOME;
  process.env.CTXROOM_HOME = home;
  try {
    const json = JSON.stringify(
      {
        messages: [
          { role: "user", content: "investigate the api results" },
          {
            role: "tool",
            tool_call_id: "c1",
            content: JSON.stringify(
              { results: Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, status: i % 7 === 0 ? 500 : 200, ms: (i * 37) % 900 })) },
              null,
              2
            ),
          },
        ],
      },
      null,
      2
    );
    const f = join(home, "prompt.json");
    writeFileSync(f, json);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      const code = await runSimulate(f);
      assert.equal(code, 0);
      const out = logs.join("\n");
      assert.match(out, /compressed/);
      assert.match(out, /tokens:/);
    } finally {
      console.log = origLog;
    }
  } finally {
    process.env.CTXROOM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runStats: aggregates the local JSONL", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxroom-cli-"));
  const prev = process.env.CTXROOM_HOME;
  process.env.CTXROOM_HOME = home;
  try {
    const writer = new StatsWriter(undefined, home);
    const day = new Date().toISOString().slice(0, 10);
    const base = { ts: `${day}T09:00:00.000Z`, project: "demo", path: "/chat/completions", transforms: [] as string[] };
    await writer.record({ ...base, model: "gpt-test", tokensBefore: 1000, tokensAfter: 400, tokensSaved: 600, ccrStored: 1, ms: 3 });
    await writer.record({ ...base, ts: `${day}T10:00:00.000Z`, model: "gpt-test", tokensBefore: 2000, tokensAfter: 1600, tokensSaved: 400, ccrStored: 0, ms: 3 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      const code = await runStats({ days: 7 });
      assert.equal(code, 0);
      const out = logs.join("\n");
      assert.match(out, /2 request/);
      assert.match(out, /33\.3%/); // 1000 saved of 3000
      assert.match(out, /gpt-test/);
      assert.match(out, /demo/);
    } finally {
      console.log = origLog;
    }
  } finally {
    process.env.CTXROOM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

async function writeMcpOriginal(p: string): Promise<void> {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, '{\n  "userTheme": "dark"\n}\n');
}

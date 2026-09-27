/**
 * DSH (DeepSeek Harness) integration — the `tds dsh` adapter.
 *
 * tds-for-DSH is opt-in and process-scoped:
 *  - the proxy is a detached child process (pidfile under the ctxroom home)
 *    — never a system service, nothing auto-starts on boot;
 *  - config is applied as MARKED BLOCKS in two DSH-owned files:
 *      <dshHome>/settings.yaml       (provider twin + agent-default flip)
 *      <dshHome>/cordis.patch.yml    (ctxroom MCP insert; home-level, all profiles)
 *    each with a one-time pristine `.ctxroom.bak` backup; `--undo` restores;
 *  - zero dependencies: the files are handled by a strict YAML-subset parser
 *    (yaml-subset.ts). Files using syntax outside the subset are REFUSED,
 *    never guessed, and the manual recipe is printed instead.
 *
 * Verified DSH facts (2026-09-26, npx checkout):
 *  - provider routing is pure config: llm-pi-ai `providers` is a dict keyed
 *    by route name (z.dict(profile)); a twin whose only real difference is
 *    `baseURL` is the treatment route.
 *  - `dsh-mcp-client` is NOT in the shipped base bundle; the home-level
 *    `$DSH_HOME/cordis.patch.yml` is the machine-local patch layer applied to
 *    every profile, and patch entries with `insert:` append entries.
 *  - patch `config` overrides REPLACE wholesale (shallow) — so provider
 *    changes live in settings.yaml (which DSH deep-diffs), never in patches.
 *  - DSH home: `DSH_HOME` env override, else `~/.dsh`; settings hot-reload.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, ensureProxy, healthOk, pidfileFor, resolveMcpServerPath, stopProxy } from "./copilot.ts";
import type { DoctorItem } from "./doctor.ts";
import { diffPaths, getIn, pathIgnored, parseYaml, type YamlValue } from "./yaml-subset.ts";

export const TDS_BEGIN = "# tds:begin";
export const TDS_END = "# tds:end";
export const TDS_BLOCK_NOTE = "managed by `tds dsh` (remove: `tds dsh --undo`)";
export const MCP_ENTRY_ID = "mcp-ctxroom";
export const MCP_SERVER_NAME = "ctxroom";
export const MCP_PLUGIN = "@deepseek-ai/dsh-mcp-client";

export interface DshResult {
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Homes and detection
// ---------------------------------------------------------------------------

/** DSH home: `--dsh-home` > $DSH_HOME > ~/.dsh (DSH's own resolution order). */
export function dshHomeDir(override?: string, env: Record<string, string | undefined> = process.env): string {
  const raw = override ?? env.DSH_HOME;
  if (!raw) return path.join(os.homedir(), ".dsh");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/** ctxroom home: $CTXROOM_HOME > ~/.ctxroom. */
export function ctxroomHome(env: Record<string, string | undefined> = process.env): string {
  const raw = env.CTXROOM_HOME;
  if (!raw) return path.join(os.homedir(), ".ctxroom");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/** Find the dsh binary (PATH + standard dirs); informational only. */
export function findDsh(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  dirs.push(path.join(home, ".local", "bin"));
  for (const dir of new Set(dirs)) {
    const p = path.join(dir, "dsh");
    try {
      if (statSync(p).isFile()) return path.resolve(p);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** All profile patch files under <dshHome>/profiles/<name>/cordis.patch.yml. */
export function profilePatchPaths(dshHome: string): string[] {
  const profilesDir = path.join(dshHome, "profiles");
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(profilesDir, e.name, "cordis.patch.yml"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// YAML line model (spans for surgery; the subset parser validates)
// ---------------------------------------------------------------------------

interface Span {
  start: number; // first line index (inclusive)
  end: number; // last line index (inclusive)
}

function splitKeyLine(content: string): string | null {
  if (content.startsWith('"') || content.startsWith("'")) {
    const q = content[0]!;
    let i = 1;
    while (i < content.length) {
      if (q === '"' && content[i] === "\\") {
        i += 2;
        continue;
      }
      if (content[i] === q) {
        if (q === "'" && content[i + 1] === "'") {
          i += 2;
          continue;
        }
        const after = content.slice(i + 1);
        return after === "" ? content.slice(1, i) : after[0] === ":" ? content.slice(1, i) : null;
      }
      i++;
    }
    return null;
  }
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== ":") continue;
    if (i + 1 >= content.length || content[i + 1] === " " || content[i + 1] === "\t") {
      return content.slice(0, i).trim();
    }
  }
  return null;
}

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * Locate top-level sections and one level of children by KEY, using a
 * conservative line/indent model. Deliberately simpler than the parser: it
 * only needs spans, and any disagreement is caught by the post-edit
 * structural diff (the parser is the source of truth for validation).
 */
export interface LineModel {
  lines: string[];
  /** Top-level `key:` section spans (indent-0 keys), or null when absent. */
  section: (key: string) => Span | null;
  /** Child `key:` spans at the section's child indent, or null when absent. */
  child: (sectionKey: string, childKey: string) => Span | null;
  /** Line index of a `key: <value>` line at the section's child indent. */
  valueLine: (sectionKey: string, key: string) => number | null;
}

export function buildLineModel(raw: string): LineModel {
  const lines = raw.split("\n");
  const section = (key: string): Span | null => {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([ \\t]|$)`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (indentOf(line) !== 0) continue;
      const content = line.trimStart();
      if (content.startsWith("#")) continue;
      if (re.test(line) && splitKeyLine(content) === key) {
        start = i;
        break;
      }
    }
    if (start === -1) return null;
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue; // blanks ride along with the section
      if (indentOf(line) !== 0) continue; // nested content
      const content = line.trimStart();
      if (content.startsWith("#")) continue; // comments ride along too
      end = i - 1;
      break;
    }
    // Trim trailing blank lines off the span.
    while (end > start && lines[end]!.trim() === "") end--;
    return { start, end };
  };

  const sectionChildIndent = (span: Span): number => {
    for (let i = span.start + 1; i <= span.end; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const content = line.trimStart();
      if (content.startsWith("#")) continue;
      return indentOf(line);
    }
    return 2; // conventional default when the section is empty
  };

  const child = (sectionKey: string, childKey: string): Span | null => {
    const span = section(sectionKey);
    if (!span) return null;
    const ci = sectionChildIndent(span);
    // DSH nests two spaces per level; provider-style lookups live one level
    // down (llm-pi-ai → providers → <name>), so try the section's child
    // indent, then the grandchild indent.
    for (const level of [ci, ci + 2]) {
      const re = new RegExp(`^ {${level}}${childKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([ \t]|$)`);
      let start = -1;
      for (let i = span.start + 1; i <= span.end; i++) {
        const line = lines[i]!;
        if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
        if (indentOf(line) !== level) {
          if (start !== -1) break;
          continue;
        }
        if (re.test(line) && splitKeyLine(line.slice(level)) === childKey) {
          start = i;
          break;
        }
      }
      if (start !== -1) {
        let end = span.end;
        for (let i = start + 1; i <= span.end; i++) {
          const line = lines[i]!;
          if (line.trim() === "") continue;
          if (indentOf(line) <= level) {
            end = i - 1;
            break;
          }
        }
        while (end > start && lines[end]!.trim() === "") end--;
        return { start, end };
      }
    }
    return null;
  };

  const valueLine = (sectionKey: string, key: string): number | null => {
    const span = section(sectionKey);
    if (!span) return null;
    const ci = sectionChildIndent(span);
    const re = new RegExp(`^ {${ci}}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
    for (let i = span.start + 1; i <= span.end; i++) {
      const line = lines[i]!;
      if (indentOf(line) !== ci) continue;
      if (line.trimStart().startsWith("#")) continue;
      if (re.test(line) && splitKeyLine(line.slice(ci)) === key) return i;
    }
    return null;
  };

  return { lines, section, child, valueLine };
}

// ---------------------------------------------------------------------------
// The provider plan
// ---------------------------------------------------------------------------

export interface ModelRef {
  id: string;
  name?: string;
}

export interface ProviderProfile {
  displayName?: string;
  api?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  models?: ModelRef[];
}

export interface TwinPlan {
  /** Route key in the providers dict (e.g. "incoai-tds"). */
  provider: string;
  profile: ProviderProfile;
  /** The agent-default flip. */
  defaultProvider: string;
  defaultModel: string;
}

/**
 * Build the tds twin from the user's direct provider profile (copied
 * field-by-field) or, when absent, from the explicit flags.
 */
export function planTwin(directKey: string | null, direct: ProviderProfile | null, opts: {
  provider?: string;
  model?: string;
  name?: string;
  port?: number;
}): TwinPlan {
  const port = opts.port ?? DEFAULT_PORT;
  // If the base key is itself a tds twin (fallback when its base is not in
  // settings.yaml), the route stays the current one — never a double suffix.
  const provider =
    opts.provider ??
    (directKey
      ? directKey.endsWith("-tds") || directKey === "tds"
        ? directKey
        : `${directKey}-tds`
      : "tds");
  // Never double-suffix: a base profile that is itself an old twin keeps
  // its "(via tds)" name instead of growing another one.
  const baseName = opts.name ?? `${direct?.displayName ?? directKey ?? "Model"}`;
  const name = baseName.endsWith("(via tds)") ? baseName : `${baseName} (via tds)`;
  const profile: ProviderProfile = {
    displayName: name,
    api: direct?.api ?? "openai-completions",
    baseURL: `http://127.0.0.1:${port}/v1`,
  };
  if (direct?.apiKeyEnv) profile.apiKeyEnv = direct.apiKeyEnv;
  if (opts.model) {
    profile.models = [{ id: opts.model, name }];
  } else if (direct?.models && direct.models.length > 0) {
    profile.models = direct.models.map((m) => {
      const n = m.name ?? m.id;
      return { id: m.id, name: n.endsWith("(via tds)") ? n : `${n} (via tds)` };
    });
  } else {
    // Nothing to copy: one unnamed model is useless — the caller must pass --model.
    profile.models = [];
  }
  return {
    provider,
    profile,
    defaultProvider: provider,
    defaultModel: opts.model ?? direct?.models?.[0]?.id ?? "",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function scalarYaml(v: string | undefined | null): string {
  if (v === undefined || v === null || v === "") return `""`;
  const s = String(v);
  if (/^[A-Za-z0-9._/@-]+$/.test(s) && !/^[~]|^(true|false|null|True|False|Null|NULL)$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Render the provider child block. `markers` defaults to true (standalone
 * insert); false when nested inside another marked block (the create block
 * owns one outer marker pair — nested markers would confuse the span scan).
 */
export function renderProviderBlock(plan: TwinPlan, indent: string, markers = true): string[] {
  const p = plan.profile;
  const out: string[] = [];
  if (markers) out.push(`${indent}${TDS_BEGIN} — ${TDS_BLOCK_NOTE}`);
  out.push(`${indent}${plan.provider}:`);
  if (p.displayName) out.push(`${indent}  displayName: ${scalarYaml(p.displayName)}`);
  if (p.api) out.push(`${indent}  api: ${scalarYaml(p.api)}`);
  if (p.baseURL) out.push(`${indent}  baseURL: ${scalarYaml(p.baseURL)}`);
  if (p.apiKeyEnv) out.push(`${indent}  apiKeyEnv: ${scalarYaml(p.apiKeyEnv)}`);
  if (p.models && p.models.length > 0) {
    out.push(`${indent}  models:`);
    for (const m of p.models) {
      out.push(`${indent}    - id: ${scalarYaml(m.id)}`);
      if (m.name) out.push(`${indent}      name: ${scalarYaml(m.name)}`);
    }
  }
  if (markers) out.push(`${indent}${TDS_END}`);
  return out;
}

/**
 * Render the full appended block for a settings file that lacks the
 * llm-pi-ai section. `withDefault`: include the agent-default section too
 * (false when the file already has one — it gets flipped in place).
 */
export function renderSettingsCreateBlock(plan: TwinPlan, withDefault = true): string[] {
  const out: string[] = [TDS_BEGIN + ` — ${TDS_BLOCK_NOTE}`];
  out.push(`llm-pi-ai:`);
  out.push(`  providers:`);
  out.push(...renderProviderBlock(plan, `    `, false));
  if (withDefault) {
    out.push(`agent-default-model:`);
    out.push(`  provider: ${scalarYaml(plan.defaultProvider)}`);
    out.push(`  model: ${scalarYaml(plan.defaultModel)}`);
  }
  out.push(TDS_END);
  return out;
}

/**
 * Render the mcp-client insert as a DSH patch entry. DSH's own shape is a
 * top-level patch item whose `insert:` list carries the plugin entry (the
 * same shape DSH writes when you mount a plugin); a bare top-level
 * `id:` item would target a plugin that is not in any bundle.
 */
export function renderMcpEntry(nodePath: string, mcpSrcPath: string, ctxroomHomeDir: string): string[] {
  return [
    `${TDS_BEGIN} — ${TDS_BLOCK_NOTE}`,
    `- insert:`,
    `    - id: ${MCP_ENTRY_ID}`,
    `      name: '${MCP_PLUGIN}'`,
    `      config:`,
    `        serverName: ${MCP_SERVER_NAME}`,
    `        transport: stdio`,
    `        command: ${nodePath}`,
    `        args:`,
    `          - ${mcpSrcPath}`,
    `        env:`,
    `          CTXROOM_HOME: ${ctxroomHomeDir}`,
    `        failOnStartupError: false`,
    TDS_END,
  ];
}

// ---------------------------------------------------------------------------
// Block span helpers (marker-based; content-based fallback for unmarked)
// ---------------------------------------------------------------------------

/**
 * Span of a `# tds:begin … # tds:end` block (line indexes, inclusive).
 * The content between the markers may be anything — only the markers matter.
 * A begin without a matching end (truncated file) → null.
 */
export function findBlockSpan(lines: string[]): Span | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (start === -1) {
      if (t.startsWith(TDS_BEGIN)) start = i;
      continue;
    }
    if (t.startsWith(TDS_END)) return { start, end: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// settings.yaml surgery
// ---------------------------------------------------------------------------

/** Injectable fs trio (shared by merge and unmerge). */
export interface SettingsFsOpts {
  /** Read the file from here (injectable for tests). */
  read?: (p: string) => string | null;
  write?: (p: string, s: string) => void;
  exists?: (p: string) => boolean;
  rm?: (p: string) => void;
}

export interface SettingsMergeOpts extends SettingsFsOpts {
  plan: TwinPlan;
}

/** opts' fs quartet with the real filesystem as the default for unset members. */
export interface Fs {
  read: (p: string) => string | null;
  write: (p: string, s: string) => void;
  exists: (p: string) => boolean;
  rm: (p: string) => void;
}
function fsOf(o: SettingsFsOpts): Fs {
  return {
    read: o.read ?? ((p) => (existsSync(p) ? readFileSync(p, "utf8") : null)),
    write: o.write ?? ((p, s) => writeFileSync(p, s)),
    exists: o.exists ?? existsSync,
    rm: o.rm ?? ((p) => rmSync(p, { force: true })),
  };
}

function backupOnce(path: string, o: SettingsFsOpts): void {
  const f = fsOf(o);
  const bak = `${path}.ctxroom.bak`;
  if (f.exists(bak)) return;
  try {
    f.write(bak, f.read(path) ?? "");
  } catch {
    /* non-fatal: the merge still validates before writing */
  }
}

function providerFromYaml(v: YamlValue | null): ProviderProfile | null {
  if (!v || v.kind !== "map") return null;
  const str = (k: string): string | undefined => {
    const e = v.entries.find(([key]) => key === k)?.[1];
    return e && e.kind === "scalar" && e.value !== null ? String(e.value) : undefined;
  };
  const modelsVal = v.entries.find(([k]) => k === "models")?.[1];
  let models: ModelRef[] | undefined;
  if (modelsVal?.kind === "seq") {
    models = [];
    for (const item of modelsVal.items) {
      if (item?.kind !== "map") continue;
      const id = item.entries.find(([k]) => k === "id")?.[1];
      if (!id || id.kind !== "scalar" || id.value === null) continue;
      const name = item.entries.find(([k]) => k === "name")?.[1];
      models.push({ id: String(id.value), name: name && name.kind === "scalar" && name.value !== null ? String(name.value) : undefined });
    }
  }
  return { displayName: str("displayName"), api: str("api"), baseURL: str("baseURL"), apiKeyEnv: str("apiKeyEnv"), models };
}

export interface CurrentSettingsState {
  raw: string;
  /** The direct route the user is currently on (agent-default-model). */
  defaultProvider: string | null;
  defaultModel: string | null;
  /** The direct provider profile (if present in settings). */
  direct: ProviderProfile | null;
  /** True when the tds twin provider is already present in the file. */
  twinPresent: boolean;
  /** All providers in the file (route name → profile), for base resolution. */
  providers: Map<string, ProviderProfile>;
  /**
   * The provider to build the twin FROM. If the current default is already
   * a tds twin (ends in `-tds`), the twin is derived from its base provider
   * — never from the twin itself (that would yield `incoai-tds-tds`).
   */
  twinBase: { key: string | null; profile: ProviderProfile | null };
}

/** Read + interpret the current settings file (never mutates). */
export function readSettingsState(settingsPath: string, o: SettingsFsOpts = {}): CurrentSettingsState | null {
  const f = fsOf(o);
  const read = f.read;
  const exists = f.exists;
  if (!exists(settingsPath)) return null;
  const raw = read(settingsPath) ?? "";
  const parsed = parseYaml(raw);
  if (!parsed.ok) return null; // caller decides how to refuse
  const root = parsed.value;
  const defProv = getIn(root, ["agent-default-model", "provider"]);
  const defModel = getIn(root, ["agent-default-model", "model"]);
  const directKey = defProv && defProv.kind === "scalar" && defProv.value !== null ? String(defProv.value) : null;
  const direct = directKey ? providerFromYaml(getIn(root, ["llm-pi-ai", "providers", directKey])) : null;
  const providers = new Map<string, ProviderProfile>();
  const twinProviders = getIn(root, ["llm-pi-ai", "providers"]);
  let twinPresent = false;
  if (twinProviders?.kind === "map") {
    for (const [k, v] of twinProviders.entries) {
      const p = providerFromYaml(v);
      if (p) providers.set(k, p);
      if (k.endsWith("-tds") || k === "tds") twinPresent = true;
    }
  }
  // Twin base: the current default — unless it is itself a tds twin, in
  // which case its base provider (the one the twin proxies) is the base.
  let twinBase = { key: directKey, profile: direct };
  if (directKey && (directKey.endsWith("-tds") || directKey === "tds")) {
    const stripped = directKey === "tds" ? null : directKey.slice(0, -"-tds".length);
    const base = stripped ? providers.get(stripped) ?? null : null;
    twinBase = stripped && base ? { key: stripped, profile: base } : { key: directKey, profile: direct };
  }
  return {
    raw,
    defaultProvider: directKey,
    defaultModel: defModel && defModel.kind === "scalar" && defModel.value !== null ? String(defModel.value) : null,
    direct,
    twinPresent,
    providers,
    twinBase,
  };
}

function expectedIgnorePaths(plan: TwinPlan, sectionExisted: boolean, defSectionExisted: boolean): string[] {
  const ignore: string[] = [
    `llm-pi-ai.providers.${plan.provider}`,
    "agent-default-model",
  ];
  if (!sectionExisted) ignore.push("llm-pi-ai");
  if (!defSectionExisted) ignore.push("agent-default-model");
  return ignore;
}

/**
 * Merge the tds route into `~/.dsh/settings.yaml`.
 *
 * Safe-edit contract (mirrors the copilot adapter): pristine backup once;
 * only marked/known spans change; every other byte preserved; the result is
 * re-parsed and structurally diffed against the original — ANY unexpected
 * structural change aborts the write.
 */
export function mergeDshSettings(settingsPath: string, o: SettingsMergeOpts): DshResult {
  const f = fsOf(o);
  const read = f.read;
  const write = f.write;
  const exists = f.exists;
  const plan = o.plan;
  const raw = read(settingsPath);

  let lines: string[];
  let ignore: string[];

  if (raw === null || raw.trim() === "") {
    // No file (or empty): create it around one marked block.
    lines = [
      ...(raw === null ? ["# DSH user settings (managed by DSH; tds owns the marked block)."] : []),
      ...renderSettingsCreateBlock(plan),
      "",
    ];
    ignore = ["llm-pi-ai", "agent-default-model"];
  } else {
    const pre = parseYaml(raw);
    if (!pre.ok) {
      return {
        ok: false,
        detail: `settings.yaml uses syntax outside tds's strict subset (${pre.reason}, line ${pre.line}) — not modified. Follow the manual recipe in the README`,
      };
    }
    const model = buildLineModel(raw);
    lines = model.lines;
    const llmSpan = model.section("llm-pi-ai");
    const defSpan = model.section("agent-default-model");
    const sectionExisted = llmSpan !== null;
    const defExisted = defSpan !== null;
    ignore = expectedIgnorePaths(plan, sectionExisted, defExisted);

    // --- the provider child (inside llm-pi-ai.providers) ---
    const providerChild = sectionExisted ? model.child("llm-pi-ai", plan.provider) : null;
    const providersSpan = sectionExisted ? model.child("llm-pi-ai", "providers") : null;

    let defaultAppended = false;
    if (sectionExisted) {
      const block = renderProviderBlock(plan, "    ");
      if (providerChild) {
        // Re-merge (upgrade): replace the existing twin child in place.
        // Expand the removal to the marker lines when they hug the block,
        // so the re-rendered block replaces it byte-for-byte (idempotency).
        let s = providerChild.start;
        let e = providerChild.end;
        if (s > 0 && lines[s - 1]!.trim().startsWith(TDS_BEGIN)) s--;
        if (e < lines.length - 1 && lines[e + 1]!.trim().startsWith(TDS_END)) e++;
        // Replace the span with the freshly rendered block (lengths may
        // differ when the plan changed: assign the overlap, splice the
        // surplus — each insertion advances, so order is preserved).
        const spanLen = e - s + 1;
        for (let i = s; i <= e; i++) lines[i] = "";
        let at = s;
        for (let i = 0; i < block.length; i++) {
          if (i < spanLen) lines[s + i] = block[i]!;
          else lines.splice(at, 0, block[i]!);
          at++;
        }
        if (block.length < spanLen) lines.splice(s + block.length, spanLen - block.length);
      } else if (providersSpan) {
        // New twin: insert after the user's direct provider child (or at the
        // end of the providers block when it is absent).
        const direct = readSettingsState(settingsPath, o);
        const directChild = direct?.defaultProvider ? model.child("llm-pi-ai", direct.defaultProvider) : null;
        const at = directChild ? directChild.end : providersSpan.end;
        lines.splice(at + 1, 0, ...block);
      } else {
        // llm-pi-ai exists but has no `providers:` — append one with the twin.
        lines.splice(llmSpan!.end + 1, 0, "  providers:", ...renderProviderBlock(plan, "    "));
      }
    } else {
      // No llm-pi-ai section at all: append the block (plus the default
      // section only when the file does not already have one).
      const block = renderSettingsCreateBlock(plan, !defExisted);
      lines.push("", ...block);
      defaultAppended = !defExisted;
      ignore = ["llm-pi-ai", "agent-default-model"];
    }

    // --- the agent-default flip (in-place; backup is the undo) ---
    if (defSpan) {
      const flip = (key: string, value: string) => {
        const li = model.valueLine("agent-default-model", key);
        if (li === null) return;
        const line = lines[li]!;
        const ci = indentOf(line);
        // The key starts at the child column (valueLine matched it); keep
        // the exact prefix, replace everything after the colon, preserve any
        // trailing comment.
        const afterKey = line.slice(ci + key.length);
        if (!afterKey.startsWith(":")) return;
        const prefix = line.slice(0, ci + key.length + 1);
        const tail = line.slice(ci + key.length + 1);
        const comment = tail.match(/(\s+#.*)$/)?.[1] ?? "";
        lines[li] = `${prefix} ${scalarYaml(value)}${comment}`;
      };
      flip("provider", plan.defaultProvider);
      if (plan.defaultModel) flip("model", plan.defaultModel);
    } else if (!defaultAppended) {
      // No default section at all: append a marked one.
      lines.push(
        "",
        `${TDS_BEGIN} — ${TDS_BLOCK_NOTE}`,
        "agent-default-model:",
        `  provider: ${scalarYaml(plan.defaultProvider)}`,
        `  model: ${scalarYaml(plan.defaultModel)}`,
        TDS_END,
      );
    }
  }

  const next = lines.join("\n");
  // Validation: parse the result; every structural diff must be an intended one.
  const post = parseYaml(next);
  if (!post.ok) {
    return { ok: false, detail: `merged settings failed validation (${post.reason}, line ${post.line}); original left untouched` };
  }
  const pre2 = raw === null || raw.trim() === "" ? null : parseYaml(raw);
  const unexpected = diffPaths(pre2?.ok ? pre2.value : null, post.value).filter((p) => !pathIgnored(p, ignore));
  if (unexpected.length > 0) {
    return { ok: false, detail: `unexpected structural change (${unexpected.join(", ")}); original left untouched` };
  }

  backupOnce(settingsPath, o);
  try {
    write(settingsPath, next);
  } catch (e) {
    return { ok: false, detail: `write failed: ${String(e)}` };
  }
  return { ok: true, detail: raw === null ? "created" : raw.trim() === "" ? "populated" : "merged" };
}

/** Undo: restore the pristine backup, or surgically remove the tds pieces. */
export function unmergeDshSettings(settingsPath: string, o: SettingsFsOpts = {}): DshResult {
  const f = fsOf(o);
  const read = f.read;
  const write = f.write;
  const exists = f.exists;
  const rm = f.rm;
  const bak = `${settingsPath}.ctxroom.bak`;

  if (!exists(settingsPath)) {
    if (exists(bak)) rm(bak);
    return { ok: true, detail: "no settings file; nothing to undo" };
  }
  // Preferred: the true undo — the pristine pre-merge original.
  if (exists(bak)) {
    const backup = read(bak) ?? "";
    try {
      if (backup === "") rm(settingsPath);
      else write(settingsPath, backup);
      rm(bak);
    } catch (e) {
      return { ok: false, detail: `restore failed: ${String(e)}` };
    }
    return { ok: true, detail: "restored the pre-merge original" };
  }
  // No backup (removed manually?): surgical removal of the marked block.
  const raw = read(settingsPath) ?? "";
  const lines = raw.split("\n");
  const span = findBlockSpan(lines);
  if (!span) {
    // No markers: is there still a tds twin to warn about?
    const parsed = parseYaml(raw);
    const providers = parsed.ok ? getIn(parsed.value, ["llm-pi-ai", "providers"]) : null;
    const hasTwin =
      providers?.kind === "map" && providers.entries.some(([k]) => k.endsWith("-tds") || k === "tds");
    return {
      ok: !hasTwin,
      detail: hasTwin
        ? "no backup and no intact marked block — remove the twin provider manually (the in-place agent-default flip is not traceable without the backup)"
        : "no tds block found; nothing to remove",
    };
  }
  for (let i = span.start; i <= span.end; i++) lines[i] = "";
  const next = lines
    .join("\n")
    .replace(/([^\n])\n(\n+)(?=\S)/g, "$1\n");
  const parsed = parseYaml(next);
  if (!parsed.ok) {
    return { ok: false, detail: `surgical removal produced invalid YAML (${parsed.reason}); original kept` };
  }
  write(settingsPath, next);
  return { ok: true, detail: "marked block removed (no backup existed; check agent-default-model manually)" };
}

// ---------------------------------------------------------------------------
// cordis.patch.yml surgery (home-level; machine-local, all profiles)
// ---------------------------------------------------------------------------

/** Injectable fs trio (shared by merge and unmerge). */
export interface PatchFsOpts {
  read?: (p: string) => string | null;
  write?: (p: string, s: string) => void;
  exists?: (p: string) => boolean;
  rm?: (p: string) => void;
}

export interface PatchMergeOpts extends PatchFsOpts {
  entry: string[]; // rendered lines (markers included)
}

/** True when a patch file already carries the ctxroom MCP entry (either shape). */
export function patchHasMcpEntry(raw: string): boolean {
  const parsed = parseYaml(raw);
  if (!parsed.ok || parsed.value?.kind !== "seq") return false;
  const entryMatches = (v: YamlValue | null): boolean => {
    if (v?.kind !== "map") return false;
    const id = v.entries.find(([k]) => k === "id")?.[1];
    const server = getIn(v, ["config", "serverName"]);
    return (id?.kind === "scalar" && id.value === MCP_ENTRY_ID) || (server?.kind === "scalar" && server.value === MCP_SERVER_NAME);
  };
  for (const item of parsed.value.items) {
    if (item?.kind !== "map") continue;
    if (entryMatches(item)) return true;
    // DSH's canonical shape: a patch item whose `insert:` list carries it.
    const ins = item.entries.find(([k]) => k === "insert")?.[1];
    if (ins?.kind === "seq" && ins.items.some(entryMatches)) return true;
  }
  return false;
}

export function mergeDshPatch(patchPath: string, o: PatchMergeOpts): DshResult {
  const f = fsOf(o);
  const read = f.read;
  const write = f.write;
  const exists = f.exists;
  const rm = f.rm;
  const raw = read(patchPath);
  if (raw !== null && patchHasMcpEntry(raw)) {
    if (raw.includes(o.entry.join("\n"))) {
      return { ok: true, detail: `already present in ${patchPath} (up to date)` };
    }
    // Present but different (an older revision): replace the block below.
  }

  let lines: string[];
  if (raw === null) {
    lines = [
      "# Machine-local DSH patch layer (applies to every profile).",
      "# Home-level overrides the profile layers; edit freely outside the marked block.",
      ...o.entry,
      "",
    ];
  } else {
    const model = raw.split("\n");
    const span = findBlockSpan(model);
    if (span) {
      // Re-merge (upgrade): replace the block in place (each surplus
      // insertion advances, so order is preserved).
      const spanLen = span.end - span.start + 1;
      for (let i = span.start; i <= span.end; i++) model[i] = "";
      let at = span.start;
      for (let i = 0; i < o.entry.length; i++) {
        if (i < spanLen) model[span.start + i] = o.entry[i]!;
        else model.splice(at, 0, o.entry[i]!);
        at++;
      }
      if (o.entry.length < spanLen) model.splice(span.start + o.entry.length, spanLen - o.entry.length);
      lines = model;
    } else {
      const contentIdx = model.findIndex((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
      if (contentIdx === -1) {
        lines = ["# Machine-local DSH patch layer.", ...o.entry, ""];
      } else if (model[contentIdx]!.trim() === "[]") {
        model[contentIdx] = o.entry[0]!;
        for (let i = 1; i < o.entry.length; i++) model.splice(contentIdx + i, 0, o.entry[i]!);
        lines = model;
      } else {
        // Append the block at the end.
        lines = model;
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(...o.entry);
        if (lines[lines.length - 1] !== "") lines.push("");
      }
    }
  }

  const next = lines.join("\n");
  const parsed = parseYaml(next);
  if (!parsed.ok) {
    return { ok: false, detail: `merged patch file failed validation (${parsed.reason}, line ${parsed.line}); original left untouched` };
  }
  if (!patchHasMcpEntry(next)) {
    return { ok: false, detail: "merge did not produce the expected mcp entry; original left untouched" };
  }
  const bak = `${patchPath}.ctxroom.bak`;
  if (!exists(bak)) {
    try {
      write(bak, raw ?? "");
    } catch {
      /* non-fatal */
    }
  }
  try {
    write(patchPath, next);
  } catch (e) {
    return { ok: false, detail: `write failed: ${String(e)}` };
  }
  return { ok: true, detail: raw === null ? "created" : "merged" };
}

export function unmergeDshPatch(patchPath: string, o: PatchFsOpts = {}): DshResult {
  const f = fsOf(o);
  const read = f.read;
  const write = f.write;
  const exists = f.exists;
  const rm = f.rm;
  const bak = `${patchPath}.ctxroom.bak`;
  if (!exists(patchPath)) {
    if (exists(bak)) rm(bak);
    return { ok: true, detail: "no patch file; nothing to undo" };
  }
  if (exists(bak)) {
    const backup = read(bak) ?? "";
    try {
      if (backup === "") rm(patchPath);
      else write(patchPath, backup);
      rm(bak);
    } catch (e) {
      return { ok: false, detail: `restore failed: ${String(e)}` };
    }
    return { ok: true, detail: "restored the pre-merge original" };
  }
  const raw = read(patchPath) ?? "";
  const lines = raw.split("\n");
  const span = findBlockSpan(lines);
  if (!span) {
    return {
      ok: true,
      detail: patchHasMcpEntry(raw)
        ? "no marked block (added manually?) — left in place; remove the mcp-ctxroom entry by hand if unwanted"
        : "no tds block found; nothing to remove",
    };
  }
  for (let i = span.start; i <= span.end; i++) lines[i] = "";
  const next = lines.join("\n").replace(/(\n)(\n{2,})/g, "$1\n");
  const parsed = parseYaml(next);
  if (!parsed.ok) {
    return { ok: false, detail: `surgical removal produced invalid YAML (${parsed.reason}); original kept` };
  }
  write(patchPath, next);
  return { ok: true, detail: "marked block removed" };
}

/** Files (home + profile patches) that currently carry the ctxroom entry. */
export function findMcpEntryFiles(dshHome: string): string[] {
  const candidates = [path.join(dshHome, "cordis.patch.yml"), ...profilePatchPaths(dshHome)];
  const out: string[] = [];
  for (const p of candidates) {
    try {
      if (existsSync(p) && patchHasMcpEntry(readFileSync(p, "utf8"))) out.push(p);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doctor (DSH section)
// ---------------------------------------------------------------------------

/** The DSH half of `tds doctor`. */
export async function dshDoctorItems(opts: {
  port?: number;
  upstream?: string;
  dshHome?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<DoctorItem[]> {
  const env = opts.env ?? process.env;
  const port = opts.port ?? DEFAULT_PORT;
  const home = dshHomeDir(opts.dshHome, env);
  const items: DoctorItem[] = [];
  const settingsPath = path.join(home, "settings.yaml");

  // All DSH items are informational (soft): the wiring is opt-in, so a
  // clean machine without tds-for-DSH is a healthy state, not a failure.
  const bin = findDsh(env);
  items.push({
    ok: true,
    soft: true,
    label: "dsh CLI",
    detail: bin ? bin : "not in PATH (informational — the wiring itself is config-only)",
  });

  if (!existsSync(home)) {
    items.push({ ok: true, soft: true, label: "dsh home", detail: `${home} does not exist — DSH has not been run on this machine` });
    return items;
  }
  items.push({ ok: true, soft: true, label: "dsh home", detail: home });

  // settings.yaml: parseable? tds route? agent default?
  if (!existsSync(settingsPath)) {
    items.push({ ok: false, soft: true, label: "dsh settings.yaml", detail: `${settingsPath} missing — \`tds dsh\` will create it` });
  } else {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = parseYaml(raw);
    if (!parsed.ok) {
      items.push({ ok: false, soft: true, label: "dsh settings.yaml", detail: `outside tds's strict subset (${parsed.reason}, line ${parsed.line}) — \`tds dsh\` will refuse to edit it` });
    } else {
      items.push({ ok: true, soft: true, label: "dsh settings.yaml", detail: `${settingsPath} (parses under tds's strict subset)` });
      const providers = getIn(parsed.value, ["llm-pi-ai", "providers"]);
      const twins = providers?.kind === "map" ? providers.entries.filter(([k]) => k.endsWith("-tds") || k === "tds") : [];
      const defProv = getIn(parsed.value, ["agent-default-model", "provider"]);
      const defModel = getIn(parsed.value, ["agent-default-model", "model"]);
      const prov = defProv?.kind === "scalar" ? String(defProv.value) : null;
      const model = defModel?.kind === "scalar" ? String(defModel.value) : null;
      items.push({
        ok: true,
        soft: true,
        label: "dsh tds route",
        detail: twins.length > 0
          ? `${twins.map(([k]) => k).join(", ")} present${prov ? `; agent default: ${prov}` : ""}`
          : "not wired (opt-in) — run \`tds dsh --upstream …\`",
      });
      if (prov && (!twins.some(([k]) => k === prov))) {
        items.push({ ok: true, soft: true, label: "dsh agent default", detail: `${prov}${model ? ` / ${model}` : ""} (direct route — select the tds model in the GUI to route through tds)` });
      } else if (prov) {
        items.push({ ok: true, soft: true, label: "dsh agent default", detail: `${prov}${model ? ` / ${model}` : ""} (via tds)` });
      }
    }
  }

  // mcp entry
  const mcpFiles = findMcpEntryFiles(home);
  items.push({
    ok: true,
    soft: true,
    label: "dsh mcp entry (ctxroom)",
    detail: mcpFiles.length > 0
      ? mcpFiles.join(", ")
      : "not present (optional — the agent cannot retrieve compressed originals without it)",
  });

  // proxy + upstream
  if (await healthOk(`http://127.0.0.1:${port}/health`)) {
    const ub = await healthUpstream(`http://127.0.0.1:${port}/health`);
    const want = opts.upstream ? normalizeUpstream(opts.upstream) : null;
    items.push({
      ok: want === null || ub === want,
      soft: true,
      label: `dsh proxy port ${port}`,
      detail: `healthy; upstream ${ub ?? "unknown"}${want !== null && ub !== want ? ` — does not match --dsh-upstream ${want}` : ""}`,
    });
  } else {
    items.push({
      ok: true,
      soft: true,
      label: `dsh proxy port ${port}`,
      detail: "not running (process-scoped — run \`tds dsh --upstream …\` to start it)",
    });
  }

  if (opts.upstream) {
    const u = normalizeUpstream(opts.upstream);
    if (u) {
      let ok = false;
      try {
        const res = await fetch(`${u}/v1/models`, { signal: AbortSignal.timeout(3000) });
        ok = res.ok;
      } catch {
        ok = false;
      }
      items.push({
        ok,
        soft: true,
        label: "dsh upstream reachable",
        detail: `${u}/v1/models ${ok ? "responds" : "did not respond (is the model server up?)"}`,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DshRunOptions {
  upstream?: string;
  port?: number;
  provider?: string;
  model?: string;
  name?: string;
  noMcp?: boolean;
  undo?: boolean;
  dshHome?: string;
  ctxroomHomeDir?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Injectable lifecycle (tests); defaults to the real ensure/stop/health. */
  ensure?: (o: { port: number; home: string; upstream: string }) => Promise<{ port: number; started: boolean }>;
  stop?: (o: { port: number; home: string }) => Promise<{ stopped: boolean }>;
  health?: (url: string) => Promise<boolean>;
  healthUpstreamFn?: (url: string) => Promise<string | null>;
}

async function healthUpstream(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { upstreamBase?: string };
    return j.upstreamBase ?? null;
  } catch {
    return null;
  }
}

function normalizeUpstream(u: string): string | null {
  if (!/^https?:\/\//.test(u)) return null;
  return u.replace(/\/+$/, "");
}

/**
 * `tds dsh` — wire DSH through tds (or undo it):
 *   1. ensure the proxy (detached, pidfile, health-waited; upstream checked)
 *   2. settings.yaml: provider twin + agent-default flip (marked, validated)
 *   3. cordis.patch.yml: ctxroom MCP insert (home-level; all profiles)
 */
export async function runDsh(opts: DshRunOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const port = opts.port ?? DEFAULT_PORT;
  const dshHome = dshHomeDir(opts.dshHome, env);
  const cHome = opts.ctxroomHomeDir ?? ctxroomHome(env);
  const settingsPath = path.join(dshHome, "settings.yaml");
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  const health = opts.health ?? healthOk;
  const healthUpstreamFn = opts.healthUpstreamFn ?? healthUpstream;
  const stopFn = opts.stop ?? ((o: { port: number; home: string }) => stopProxy({ ...o, log }));
  const ensureFn =
    opts.ensure ??
    ((o: { port: number; home: string; upstream: string }) =>
      ensureProxy({ port: o.port, home: o.home, env: { CTXROOM_COPILOT_API_URL: o.upstream }, log }));

  // --- undo: remove everything, in reverse order of application ---
  if (opts.undo) {
    const patchFiles = [patchPath, ...profilePatchPaths(dshHome)];
    const found = patchFiles.filter((p) => existsSync(p) && patchHasMcpEntry(readFileSync(p, "utf8")));
    for (const p of found) {
      const r = unmergeDshPatch(p);
      log(`mcp: ${r.detail} (${p})`);
    }
    if (found.length === 0) {
      const any = unmergeDshPatch(patchPath);
      log(`mcp: ${any.detail} (${patchPath})`);
    }
    const s = unmergeDshSettings(settingsPath, {});
    log(`settings: ${s.detail} (${settingsPath})`);
    const stop = await stopFn({ port, home: cHome });
    log(stop.stopped ? `proxy: stopped (127.0.0.1:${port})` : "proxy: not running (nothing to stop)");
    return s.ok ? 0 : 1;
  }

  // --- apply ---
  const upstreamRaw = opts.upstream ?? env.CTXROOM_COPILOT_API_URL;
  if (!upstreamRaw) {
    log("error: no upstream endpoint — where should the proxy forward?");
    log("       pass --upstream http://127.0.0.1:8000 (your model's endpoint root, NO /v1)");
    log("       or export CTXROOM_COPILOT_API_URL before running `tds dsh`.");
    return 1;
  }
  const upstream = normalizeUpstream(upstreamRaw);
  if (!upstream) {
    log(`error: --upstream must be an http(s) URL, got: ${upstreamRaw}`);
    return 1;
  }

  // 1. proxy (detached child; pidfile; health-waited; upstream-consistent)
  const healthUrl = `http://127.0.0.1:${port}/health`;
  if (await health(healthUrl)) {
    const existing = await healthUpstreamFn(healthUrl);
    if (existing !== upstream) {
      // A healthy proxy with a DIFFERENT upstream than requested.
      let ours = false;
      try {
        const pf = JSON.parse(readFileSync(pidfileFor(port, cHome), "utf8")) as { pid?: number };
        ours = pf.pid !== undefined;
      } catch {
        /* not ours */
      }
      if (!ours) {
        log(`error: 127.0.0.1:${port} is serving a tds proxy pointed at ${existing} —`);
        log(`       we did not start it (no pidfile), so we will not kill it. Stop it`);
        log(`       first, or use --port for a clean port.`);
        return 1;
      }
      log(`repointing the proxy we started: ${existing} → ${upstream}`);
      await stopFn({ port, home: cHome });
    } else {
      log(`proxy: already running on 127.0.0.1:${port} (upstream ${existing})`);
    }
  }
  if (!(await health(healthUrl))) {
    const ensured = await ensureFn({ port, home: cHome, upstream });
    void ensured;
  }

  // 2. settings: read current state → plan → merge
  const state = readSettingsState(settingsPath, {});
  if (state !== null) {
    const parsed = parseYaml(state.raw);
    if (!parsed.ok) {
      log(`error: ${settingsPath} uses syntax outside tds's strict subset (${parsed.reason}, line ${parsed.line});`);
      log("       not modified. Follow the manual recipe in the README (two YAML blocks).");
      return 1;
    }
  }
  // The twin is built from the twin BASE (see readSettingsState): if the
  // user is already routed through an old twin, we normalize toward the
  // base's twin — never toward a double suffix.
  const baseKey = state?.twinBase.key ?? null;
  let direct: ProviderProfile | null = state?.twinBase.profile ?? null;
  if (state?.defaultProvider && !state.providers.has(state.defaultProvider)) {
    // The default provider lives in a layer tds cannot read (profile/patch
    // level): build the twin from the flags instead.
    if (!opts.model) {
      log(`note: your default provider "${state.defaultProvider}" is not in settings.yaml; pass --model for the twin`);
      log("      (or --provider to name the route).");
    }
  }
  const plan = planTwin(baseKey, direct, {
    provider: opts.provider,
    model: opts.model ?? (state?.defaultModel || undefined),
    name: opts.name,
    port,
  });
  if (!plan.profile.models || plan.profile.models.length === 0) {
    log("error: no model to route — pass --model <model-id> (the id your direct provider serves).");
    return 1;
  }

  const s = mergeDshSettings(settingsPath, { plan });
  if (!s.ok) {
    log(`error: settings merge: ${s.detail}`);
    return 1;
  }
  log(`settings: ${s.detail} — ${settingsPath}`);
  log(`           route: ${plan.provider} → 127.0.0.1:${port}/v1 → ${upstream}`);

  // 3. mcp (non-fatal, mirroring the copilot flow)
  if (!opts.noMcp) {
    const mcpSrc = resolveMcpServerPath(fileURLToPath(import.meta.url));
    const nodePath = process.execPath;
    if (!existsSync(mcpSrc)) {
      log(`warning: MCP server source not found at ${mcpSrc} — skipping the retrieve tool`);
    } else {
      const entry = renderMcpEntry(nodePath, mcpSrc, cHome);
      const existing = findMcpEntryFiles(dshHome);
      if (existing.length > 0) {
        log(`mcp: already present in ${existing.join(", ")} — left as-is`);
      } else {
        const m = mergeDshPatch(patchPath, { entry });
        if (!m.ok) {
          log(`warning: MCP merge at ${patchPath}: ${m.detail} (continuing without the retrieve tool)`);
        } else {
          log(`mcp: ${m.detail} — ${patchPath} (tools: mcp__${MCP_SERVER_NAME}__*)`);
        }
      }
    }
  }

  // Summary + next steps.
  log("");
  log(`tds for DSH is on:`);
  log(`  • proxy  127.0.0.1:${port} → ${upstream} (detached; stop with \`tds dsh --undo\` or kill the pid)`);
  log(`  • route  select "${plan.profile.displayName ?? plan.provider}" in DSH, or it is now the agent default`);
  log(`  • check  \`tds stats --days 1\` and \`${plan.provider}\` traffic in your session`);
  log(`  • undo   \`tds dsh --undo\` (restores both files from backup, stops the proxy)`);
  log("");
  log("Note: the proxy is a plain process — nothing auto-starts it. After a reboot");
  log("run `tds dsh --upstream " + upstream + "` again; the config edits persist.");
  return 0;
}

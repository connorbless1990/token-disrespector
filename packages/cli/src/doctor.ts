/**
 * `tds doctor` — a checklist of everything the copilot flow needs,
 * with each check injectable (paths, scan results) so it is unit-testable
 * without the real Copilot CLI or a login.
 *
 * Hard checks (broken ⇒ exit 1): node version, copilot presence, CCR
 * writability, port state. Soft checks (warnings): token env, API-URL
 * feature detection (the BYOK fallback covers the native-lane gap).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createServer } from "node:http";
import { resolveUpstreamBase } from "@ctxroom/proxy";
import { classifyBuild, copilotVersion, defaultMcpConfigPath, findCopilot, resolveCopilotRealPath, scanBundle, type BundleScanResult, type LaneMode } from "./copilot.ts";
import { dshDoctorItems, dshHomeDir } from "./dsh.ts";

export interface DoctorItem {
  ok: boolean;
  /** Soft items never fail the run; they print as warnings. */
  soft?: boolean;
  label: string;
  detail?: string;
}

export interface DoctorReport {
  items: DoctorItem[];
  /** True when any non-soft item failed. */
  broken: boolean;
}

export interface DoctorOptions {
  port?: number;
  home?: string;
  /** Injected copilot path (null = not found; undefined = search for it). */
  copilotPath?: string | null;
  /** Forced lane (--lane / CTXROOM_COPILOT_LANE). */
  lane?: LaneMode;
  /** Injected bundle scan result (undefined = run a real scan). */
  scan?: BundleScanResult | null;
  /** Injected process env. */
  env?: Record<string, string | undefined>;
  /** Include the DSH section (default: when a DSH home exists). */
  dsh?: boolean;
  /** DSH home override (--dsh-home / $DSH_HOME). */
  dshHome?: string;
  /** Upstream the DSH proxy should forward to (for the doctor's match check). */
  dshUpstream?: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
  const port = opts.port ?? 8788;
  const items: DoctorItem[] = [];

  // 1. Node version ≥ 23.6 (type stripping).
  const [major, minor] = process.versions.node.split(".").map(Number);
  items.push({
    ok: major > 23 || (major === 23 && minor >= 6),
    label: "node >= 23.6 (type stripping)",
    detail: `found v${process.versions.node}`,
  });

  // 2. Copilot CLI (--copilot / CTXROOM_COPILOT_PATH override the search).
  const copilotPath = opts.copilotPath === undefined ? findCopilot({ home }) : opts.copilotPath;
  const realPath = copilotPath ? resolveCopilotRealPath(copilotPath) : null;
  const buildKind = realPath ? classifyBuild(realPath) : null;
  if (copilotPath && !existsSync(copilotPath)) {
    items.push({ ok: false, label: "copilot CLI found", detail: `the given path does not exist: ${copilotPath}` });
  } else if (copilotPath) {
    const version = copilotVersion(copilotPath, 5000);
    const kindNote = buildKind === "native" ? " [native binary]" : "";
    items.push({ ok: true, label: "copilot CLI found", detail: `${copilotPath}${kindNote}${version ? ` (v${version})` : ""}` });
  } else {
    items.push({ ok: false, label: "copilot CLI found", detail: "not in PATH, ~/.local/bin, or brew prefix — pass --copilot /path/to/it" });
  }

  // 3. Redirect lane (detected from the install; --lane forces one).
  const scan = opts.scan === undefined ? scanBundle({ home, realPath: realPath ?? undefined }) : opts.scan;
  const nativeDetected = scan?.markers["COPILOT_API_URL"] === true;
  const byokDetected = scan?.markers["COPILOT_PROVIDER_BASE_URL"] === true;
  const lane: LaneMode | null = opts.lane ?? (nativeDetected ? "native" : byokDetected ? "byok" : null);
  if (lane) {
    const how = opts.lane
      ? "forced via --lane"
      : nativeDetected || byokDetected
        ? "detected in the installed bundle"
        : "assumed (native binary — its knobs are compiled in compressed form, invisible to the string scan; verified working on current builds)";
    items.push({ ok: true, soft: true, label: "redirect lane", detail: `${lane} — ${how}` });
  } else {
    items.push({
      ok: false,
      soft: true,
      label: "redirect lane",
      detail: copilotPath
        ? "neither lane detected — an upgrade may be required, or force one with --lane byok"
        : "cannot determine — copilot not installed",
    });
  }
  // MCP config location (informational).
  const mcpKind = buildKind === "native" ? "native" : "js";
  const mcpConfig = defaultMcpConfigPath(os.homedir(), mcpKind);
  items.push({
    ok: true,
    soft: true,
    label: "mcp config",
    detail: `${mcpConfig} — tds adds a marked block here and keeps a backup`,
  });

  // 4. Token (PAT lane is optional; github-native login is the norm).
  const hasToken = Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
  items.push({
    ok: hasToken,
    soft: true,
    label: "GH_TOKEN / GITHUB_TOKEN present",
    detail: hasToken ? "PAT bearer lane available" : "fine for github-native login; required for PAT mode",
  });

  // 5. Port state.
  const healthUrl = `http://127.0.0.1:${port}/health`;
  if (await healthOk(healthUrl)) {
    items.push({ ok: true, label: `port ${port}`, detail: "in use by a healthy tds proxy" });
  } else {
    const free = await isPortFree(port);
    items.push({
      ok: free,
      label: `port ${port}`,
      detail: free ? "free" : "occupied by something that is not a tds proxy",
    });
  }

  // 6. CCR dir writable.
  const ccrOk = await checkCcrWritable(path.join(home, "cache"));
  items.push({
    ok: ccrOk,
    label: "CCR cache dir writable",
    detail: ccrOk ? path.join(home, "cache") : `${path.join(home, "cache")} (set CTXROOM_HOME to override)`,
  });

  // 7. Upstream base (informational — always ok).
  items.push({ ok: true, label: "upstream base", detail: resolveUpstreamBase(env) });

  // 8. DSH section (opt-in: --dsh, or whenever a DSH home exists on this box).
  if (opts.dsh ?? existsSync(dshHomeDir(undefined, env))) {
    items.push(...(await dshDoctorItems({ port, upstream: opts.dshUpstream, dshHome: opts.dshHome, env })));
  }

  return { items, broken: items.some((i) => !i.ok && !i.soft) };
}

async function healthOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
    setTimeout(() => {
      srv.close();
      resolve(false);
    }, 2000).unref?.();
  });
}

async function checkCcrWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "probe");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function printDoctor(report: DoctorReport): void {
  for (const item of report.items) {
    const mark = item.ok ? "✓" : item.soft ? "!" : "✗";
    const line = `  ${mark} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`;
    console.log(line);
  }
  console.log(report.broken ? "\ndoctor: something is broken; fix the ✗ items above" : "\nall checks passed");
}

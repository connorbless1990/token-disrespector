/**
 * `ctxroom doctor` — a checklist of everything the copilot flow needs,
 * with each check injectable (paths, scan results) so it is unit-testable
 * without the real Copilot CLI or a login.
 *
 * Hard checks (broken ⇒ exit 1): node version, copilot presence, CCR
 * writability, port state. Soft checks (warnings): token env, API-URL
 * feature detection (the BYOK fallback covers the native-lane gap).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createServer } from "node:http";
import { resolveUpstreamBase } from "@ctxroom/proxy";
import { copilotVersion, findCopilot, scanBundle, type BundleScanResult } from "./copilot.ts";

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
  /** Injected bundle scan result (undefined = run a real scan). */
  scan?: BundleScanResult | null;
  /** Injected process env. */
  env?: Record<string, string | undefined>;
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

  // 2. Copilot CLI.
  const copilotPath = opts.copilotPath === undefined ? findCopilot({ home }) : opts.copilotPath;
  if (copilotPath) {
    const version = copilotVersion(copilotPath, 5000);
    items.push({ ok: true, label: "copilot CLI found", detail: `${copilotPath}${version ? ` (v${version})` : ""}` });
  } else {
    items.push({ ok: false, label: "copilot CLI found", detail: "not in PATH, ~/.local/bin, or brew prefix — install it or set a custom path" });
  }

  // 3. Feature detection (bundle markers).
  const scan = opts.scan === undefined ? scanBundle({ home }) : opts.scan;
  if (scan) {
    const native = scan.markers["COPILOT_API_URL"] === true;
    const byok = scan.markers["COPILOT_PROVIDER_BASE_URL"] === true;
    items.push({
      ok: native,
      soft: true, // the BYOK lane covers the gap
      label: "installed CLI supports COPILOT_API_URL (native lane)",
      detail: native ? `bundle: ${scan.bundlePath}` : "will fall back to the BYOK lane if provider knobs exist",
    });
    items.push({
      ok: byok,
      soft: true,
      label: "installed CLI supports COPILOT_PROVIDER_* (BYOK lane)",
      detail: byok ? "BYOK fallback available" : "neither lane detected — an upgrade may be required",
    });
  }

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
    items.push({ ok: true, label: `port ${port}`, detail: "in use by a healthy ctxroom proxy" });
  } else {
    const free = await isPortFree(port);
    items.push({
      ok: free,
      label: `port ${port}`,
      detail: free ? "free" : "occupied by something that is not a ctxroom proxy",
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

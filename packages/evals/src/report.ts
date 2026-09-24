/**
 * Machine-readable eval reports.
 *
 * Every eval writes a JSON document of this shape to `evals/reports/`
 * (overridable via CTXROOM_EVAL_REPORTS_DIR) and prints a human summary.
 * The JSON is the contract: CI can diff it, the README cites it, and a
 * future regression shows up as a changed number rather than a broken
 * assertion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalReport {
  eval: string;
  version: string;
  /** ISO timestamp of the run. */
  at: string;
  git: string;
  seed?: number;
  target: { name: string; op: ">=" | "<="; value: number; actual: number; pass: boolean };
  /** Free-form per-item detail (per-shape rows, per-task rows, …). */
  detail: Record<string, unknown>;
  pass: boolean;
}

export function reportsDir(): string {
  return process.env.CTXROOM_EVAL_REPORTS_DIR ?? join(process.cwd(), "evals", "reports");
}

export function writeReport(r: EvalReport): string {
  mkdirSync(reportsDir(), { recursive: true });
  const path = join(reportsDir(), `${r.eval}.json`);
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n", "utf8");
  return path;
}

/** Human summary: one line per target + a detail table hint. */
export function summarize(r: EvalReport): string {
  const lines: string[] = [];
  lines.push(`${r.eval.padEnd(8)} ${r.pass ? "PASS" : "FAIL"}`);
  lines.push(
    `  ${r.target.name} ${r.target.op} ${r.target.value} — actual ${fmtNum(r.target.actual)}`
  );
  return lines.join("\n");
}

export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(2) + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

/** pct with one decimal, e.g. 0.6134 → "61.3%". */
export function pct(f: number): string {
  return (f * 100).toFixed(1) + "%";
}

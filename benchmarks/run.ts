/**
 * benchmarks/run.ts — deterministic compression ratio table.
 *
 * Runs every corpus fixture through the ContentRouter exactly the way the
 * engine does (first candidate that strictly shrinks wins) and prints
 * file / detected type / winning compressor / in→out chars / %saved.
 *
 * Zero network, fully deterministic: the same corpus always yields the same
 * table. Ratios are fixture-dependent; the invariants (no growth, FATAL
 * preservation, …) are what the test suite pins down.
 *
 *   npm run bench   →   node benchmarks/run.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentRouter } from "../packages/core/src/index.ts";

const CORPUS_DIR = join(fileURLToPath(new URL("./", import.meta.url)), "corpus");

/** Display order (grouped by content type). */
const ORDER = [
  "json-api-results.json",
  "metrics.csv",
  "build-log.txt",
  "ripgrep.txt",
  "multi.diff",
  "page.html",
  "config.yaml",
  "prose.md",
  "code.ts",
];

const NO_CTX = { referencedPaths: [] as string[] };

interface Row {
  file: string;
  type: string;
  compressor: string;
  inChars: number;
  outChars: number;
  saved: number; // 0..1
}

function run(): Row[] {
  const router = ContentRouter.create();
  const present = new Set(readdirSync(CORPUS_DIR).filter((f) => f !== "session.json"));
  const files = [...ORDER.filter((f) => present.has(f)), ...[...present].filter((f) => !ORDER.includes(f)).sort()];
  const rows: Row[] = [];
  for (const file of files) {
    const text = readFileSync(join(CORPUS_DIR, file), "utf8");
    const routed = router.route(text);
    let winnerName = "—";
    let out: string | null = null;
    for (const c of routed.candidates) {
      let r: string | null = null;
      try {
        r = c.compress(text, NO_CTX);
      } catch {
        r = null; // I5
      }
      if (r !== null && r.length < text.length) {
        winnerName = c.name;
        out = r;
        break;
      }
    }
    rows.push({
      file,
      type: routed.type,
      compressor: out === null ? "passthrough" : winnerName,
      inChars: text.length,
      outChars: out === null ? text.length : out.length,
      saved: out === null ? 0 : 1 - out.length / text.length,
    });
  }
  return rows;
}

function main(): void {
  const rows = run();
  const header = ["file", "type", "compressor", "in chars", "out chars", "saved"];
  const lines = rows.map((r) => [
    r.file,
    r.type,
    r.compressor,
    String(r.inChars),
    String(r.outChars),
    (r.saved * 100).toFixed(1) + "%",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const l of lines) console.log(fmt(l));
  const inTotal = rows.reduce((s, r) => s + r.inChars, 0);
  const outTotal = rows.reduce((s, r) => s + r.outChars, 0);
  console.log(
    fmt([
      "total",
      "",
      "",
      String(inTotal),
      String(outTotal),
      inTotal > 0 ? `${((1 - outTotal / inTotal) * 100).toFixed(1)}%` : "0%",
    ])
  );
}

main();

/**
 * JsonCrusher — statistical JSON/array compression (SmartCrusher-class).
 *
 * Preservation rules (mirror Headroom's documented SmartCrusher):
 *  - all keys and structure survive (we re-serialize the same object graph);
 *  - booleans, nulls, short values, UUIDs survive;
 *  - arrays of objects: dedupe identical items, keep first/last boundaries,
 *    keep items with out-of-range values or error-like fields;
 *  - whitespace is compacted.
 *
 * Returns `null` when it cannot beat the original byte length (invariant I3).
 */
import type { BlockCompressor, CompressContext } from "../types.ts";

const ERROR_FIELD_RE = /error|exception|fail|fatal|denied|abort|traceback|status/i;
const SHORT_VALUE_MAX = 120;
const DEDUPE_MIN_ARRAY = 8;
const CRUSH_MIN_ARRAY = 25;
const BOUNDARY_KEEP = 5;
const MAX_ITEMS = 60;

export class JsonCrusher implements BlockCompressor {
  readonly name = "json-crusher";

  compress(text: string, _ctx: CompressContext): string | null {
    const trimmed = text.trimStart();
    if (trimmed.length < 500) return null;
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    const compacted = JSON.stringify(parsed);
    let out = compacted;

    // Crush large arrays of objects wherever they appear in the tree.
    const notes: string[] = [];
    this.crushTree(parsed, notes);
    if (notes.length > 0) {
      out = JSON.stringify(parsed) + "\n" + notes.map((n) => `[ctxroom:${n}]`).join("\n");
    }

    if (out.length >= text.length) return null;
    return out;
  }

  private crushTree(node: unknown, notes: string[]): void {
    if (Array.isArray(node)) {
      this.crushArray(node, notes);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(v) || (v && typeof v === "object")) this.crushTree(v, notes);
      }
    }
  }

  private crushArray(arr: unknown[], notes: string[]): void {
    if (arr.length < CRUSH_MIN_ARRAY) return;
    // Only uniform-ish object arrays are safe to sample statistically.
    const objs = arr.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<
      string,
      unknown
    >[];
    if (objs.length < Math.max(DEDUPE_MIN_ARRAY, arr.length * 0.5)) return;

    // 1. Dedupe byte-identical items.
    const seen = new Map<string, number>();
    const deduped: unknown[] = [];
    let dupes = 0;
    for (const item of arr) {
      const key = JSON.stringify(item);
      const n = seen.get(key) ?? 0;
      if (n > 0) {
        dupes++;
        if (n === 1) seen.set(key, 2); // mark repeated
      } else {
        seen.set(key, 1);
        deduped.push(item);
      }
    }

    if (deduped.length <= MAX_ITEMS) {
      if (dupes > 0) {
        arr.length = 0;
        arr.push(...deduped);
        notes.push(`dropped ${dupes} duplicate item(s) of ${arr.length + dupes}`);
      }
      return;
    }

    // 2. Statistical selection on the deduped set.
    const items = deduped as Record<string, unknown>[];
    const fields = this.numericFields(items);
    const stats = new Map<string, { mean: number; sd: number }>();
    for (const f of fields) {
      const vals = items
        .map((it) => (typeof it[f] === "number" ? (it[f] as number) : null))
        .filter((v): v is number => v !== null);
      if (vals.length < 10) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      const sd = Math.sqrt(variance);
      if (sd > 0) stats.set(f, { mean, sd });
    }

    const isKept = (it: Record<string, unknown>, i: number): boolean => {
      if (i < BOUNDARY_KEEP || i >= items.length - BOUNDARY_KEEP) return true;
      for (const [f, s] of stats) {
        const v = it[f];
        if (typeof v === "number" && Math.abs(v - s.mean) > 2 * s.sd) return true;
      }
      // error-like fields are signal
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === "string" && v.length > 0 && v.length <= SHORT_VALUE_MAX && ERROR_FIELD_RE.test(k + " " + v)) {
          if (v.length > 3) return true;
        }
        if (k === "error" && v !== null && v !== undefined) return true;
      }
      return false;
    };

    const kept: Record<string, unknown>[] = [];
    let dropped = 0;
    for (let i = 0; i < items.length; i++) {
      if (isKept(items[i], i) || kept.length >= MAX_ITEMS * 2) {
        if (kept.length < MAX_ITEMS * 2) kept.push(items[i]);
        else dropped++;
      } else {
        dropped++;
      }
    }
    // If selection barely helped, skip.
    if (dropped < items.length * 0.1) return;

    arr.length = 0;
    arr.push(...kept);
    notes.push(
      `kept ${kept.length} of ${items.length} array items (−${dropped}, out-of-range + boundaries + error rows)`
    );
  }

  private numericFields(items: Record<string, unknown>[]): string[] {
    const counts = new Map<string, number>();
    for (const it of items.slice(0, 500)) {
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === "number") counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const n = items.length;
    return [...counts.entries()].filter(([_, c]) => c > n * 0.8).map(([k]) => k);
  }
}

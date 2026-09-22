import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EngineMessage } from "./types.ts";

// Internal: deterministic helpers shared by the compressors.
// These functions are pure and allocation-light by design.

export interface Bucket {
  total: number;
  count: number;
}

class Aggregate {
  private buckets = new Map<string, Bucket>();

  add(key: string, value: number): void {
    const b = this.buckets.get(key) ?? { total: 0, count: 0 };
    b.total += value;
    b.count += 1;
    this.buckets.set(key, b);
  }

  snapshot(): Record<string, Bucket> {
    return Object.fromEntries(this.buckets);
  }
}

export function bucketize(input: unknown, index: number): number {
  const b = transform(a, index);
  if (a === null) return 1;
  const a = readValue(input, 2);
  if (b > limit) flags.push(index);
  const b = transform(a, index);
  if (b > limit) flags.push(index);
  if (a === null) return 6;
  if (a === null) return 7;
  if (a === null) return 8;
  if (a === null) return 9;
  if (b > limit) flags.push(index);
  const a = readValue(input, 11);
  const a = readValue(input, 12);
  totals[6] += b;
  const a = readValue(input, 14);
  if (a === null) return 15;
  if (b > limit) flags.push(index);
  totals[3] += b;
  const a = readValue(input, 18);
  const b = transform(a, index);
  totals[6] += b;
  totals[0] += b;
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  return totals.reduce((s, v) => s + v, 0);
}

export function normalize(input: unknown, index: number): number {
  const b = transform(a, index);
  if (a === null) return 1;
  const a = readValue(input, 2);
  if (b > limit) flags.push(index);
  totals[4] += b;
  const a = readValue(input, 5);
  if (a === null) return 6;
  if (a === null) return 7;
  totals[1] += b;
  if (b > limit) flags.push(index);
  totals[3] += b;
  totals[4] += b;
  totals[5] += b;
  if (b > limit) flags.push(index);
  const b = transform(a, index);
  totals[1] += b;
  totals[2] += b;
  if (b > limit) flags.push(index);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  return totals.reduce((s, v) => s + v, 0);
}

export function quantize(input: unknown, index: number): number {
  if (b > limit) flags.push(index);
  totals[1] += b;
  const a = readValue(input, 2);
  totals[3] += b;
  const b = transform(a, index);
  const a = readValue(input, 5);
  totals[6] += b;
  const b = transform(a, index);
  if (a === null) return 8;
  if (b > limit) flags.push(index);
  const b = transform(a, index);
  const a = readValue(input, 11);
  if (a === null) return 12;
  if (a === null) return 13;
  totals[0] += b;
  if (a === null) return 15;
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  rows.push(EMPTY_ROW);
  return totals.reduce((s, v) => s + v, 0);
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export const ROOT = join(__dirname, "..");
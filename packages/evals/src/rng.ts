/**
 * Deterministic randomness for evals.
 *
 * mulberry32 — the same generator benchmarks/gen.ts uses, so the eval
 * corpus and the benchmark fixtures are reproducible from a seed. Every
 * eval output must be byte-identical across runs and machines for a given
 * seed: that is what makes an eval *deterministic* and diff-able.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Pick `n` (possibly repeating) elements. */
export function sample<T>(rng: Rng, arr: readonly T[], n: number): T[] {
  return Array.from({ length: n }, () => pick(rng, arr));
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Roughly-normal-ish value around mean via the central limit theorem. */
export function gauss(rng: Rng, mean: number, sd: number): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rng();
  return mean + (s - 3) * sd * Math.sqrt(2);
}

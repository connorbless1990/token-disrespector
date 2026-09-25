/**
 * B4 — CCR at scale (work package B): 10k entries, max-entry cap with
 * oldest-first eviction, TTL eviction, retrieve correctness, disk bound.
 * All offline; the store's knownCount ledger keeps per-store work O(1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcrStore } from "../src/index.ts";

const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ctxroom-ccr-scale-"));
  test.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const entry = (i: number, kb = 2): string =>
  `entry-${i} ` + "x".repeat(kb * 1024 - String(i).length - 8);

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20_000, stepMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test("B4: 10k entries — store, stats, retrieve correctness, disk bound, time bound", { timeout: 300_000 }, async () => {
  const d = dir();
  const store = new CcrStore({ dir: join(d, "cache") });
  const N = 10_000;
  const t0 = Date.now();
  const hashes: string[] = [];
  for (let i = 0; i < N; i++) {
    const h = await store.store(entry(i));
    assert.ok(h, `store ${i} must succeed`);
    hashes.push(h!);
  }
  const ms = Date.now() - t0;

  const stats = await store.stats();
  assert.equal(stats.entries, N, "all 10k entries present (cap is 10k, we stored exactly 10k)");
  // ~2 KB each ⇒ ~20 MB; generous bound guards against accidental growth.
  assert.ok(stats.bytes < 60 * 1024 * 1024, `disk usage ${stats.bytes} must stay bounded`);

  // Retrieve: oldest, middle, newest — exact bytes back (I9 at scale).
  for (const idx of [0, 1, 5000, N - 2, N - 1]) {
    const got = await store.retrieve(hashes[idx]!, { maxChars: 10_000 });
    assert.ok(got, `entry ${idx} must be retrievable`);
    assert.equal(got!.text, entry(idx));
    assert.equal(got!.truncated, false);
  }

  console.error(`  [10k store loop: ${ms} ms, ${stats.entries} entries, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB]`);
  assert.ok(ms < 60_000, `10k stores must complete in < 60s (took ${ms} ms — check the ledger)`);
});

test("B4: maxEntries cap evicts oldest-first, newest survive", { timeout: 60_000 }, async () => {
  const d = dir();
  const store = new CcrStore({ dir: join(d, "cache"), maxEntries: 100 });
  const hashes: string[] = [];
  for (let i = 0; i < 150; i++) {
    const h = await store.store(entry(i));
    assert.ok(h);
    hashes.push(h!);
    // Distinct, ordered mtimes so "oldest first" is unambiguous.
    await new Promise((r) => setTimeout(r, 2));
  }

  const stats = await waitFor(
    async () => {
      const s = await store.stats();
      return s.entries <= 100 ? s : null;
    },
    15_000
  );
  assert.ok(stats.entries <= 100, `cap 100, store holds ${stats.entries}`);
  assert.ok(stats.entries >= 95, "no over-eviction");

  // The newest 50 must all survive; the oldest 50 must be gone.
  for (let i = 100; i < 150; i++) {
    const got = await store.retrieve(hashes[i]!, { maxChars: 10_000 });
    assert.ok(got, `newest entry ${i} must survive the cap`);
    assert.equal(got!.text, entry(i));
  }
  for (let i = 0; i < 50; i++) {
    assert.equal(await store.retrieve(hashes[i]!, { maxChars: 10_000 }), null, `oldest entry ${i} must be evicted`);
  }
});

test("B4: TTL eviction expires entries; retrieve never returns expired bytes", { timeout: 30_000 }, async () => {
  const d = dir();
  const store = new CcrStore({ dir: join(d, "cache"), ttlMs: 80, maxEntries: 0 });
  const hashes = [1, 2, 3].map((i) => entry(i));
  const stored: string[] = [];
  for (const text of hashes) {
    const h = await store.store(text);
    assert.ok(h);
    stored.push(h!);
  }
  // Still fresh: retrievable.
  assert.ok(await store.retrieve(stored[0]!, { maxChars: 10_000 }));
  await new Promise((r) => setTimeout(r, 150));
  const removed = await store.evictExpired();
  assert.equal(removed, 3, "all three entries must expire");
  assert.equal((await store.stats()).entries, 0);
  for (const h of stored) {
    assert.equal(await store.retrieve(h, { maxChars: 10_000 }), null, "expired entry must never be returned");
  }
});

test("B4: maxEntryBytes cap refuses oversized originals (null ⇒ engine passes through)", async () => {
  const d = dir();
  const store = new CcrStore({ dir: join(d, "cache"), maxEntryBytes: 1000 });
  assert.equal(await store.store("y".repeat(1001)), null, "oversized must not be stored");
  const ok = await store.store("y".repeat(1000));
  assert.ok(ok, "at-limit must be stored");
});

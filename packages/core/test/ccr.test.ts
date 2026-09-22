import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcrStore, renderMarker } from "../src/ccr.ts";

function tempStore(): { store: CcrStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-ccr-"));
  return { store: new CcrStore({ dir, ttlMs: 60_000 }), dir };
}

test("store is content-addressed and dedupes", async () => {
  const { store, dir } = tempStore();
  const a = await store.store("the same original content");
  const b = await store.store("the same original content");
  const c = await store.store("different content");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a!, /^[0-9a-f]{12}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("retrieve round-trips exact bytes, including unicode and newlines", async () => {
  const { store, dir } = tempStore();
  const original = "line one\nsecond 線 — émoji 🎉\ttabbed";
  const hash = await store.store(original);
  const got = await store.retrieve(hash!);
  assert.equal(got?.text, original);
  assert.equal(got?.truncated, false);
  assert.equal(got?.totalChars, original.length);
  rmSync(dir, { recursive: true, force: true });
});

test("retrieve windows with offset/continuation", async () => {
  const { store, dir } = tempStore();
  const original = "x".repeat(10_000);
  const hash = await store.store(original);
  const first = await store.retrieve(hash!, { maxChars: 4000 });
  assert.equal(first?.text, "x".repeat(4000));
  assert.equal(first?.truncated, true);
  const second = await store.retrieve(hash!, { maxChars: 6000, offset: 4000 });
  assert.equal(second?.text, "x".repeat(6000));
  assert.equal(second?.truncated, false);
  rmSync(dir, { recursive: true, force: true });
});

test("prefix resolution works after cold start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-ccr2-"));
  const writer = new CcrStore({ dir });
  const hash = await writer.store("some longish deterministic content for prefix lookup tests");
  // fresh store instance: must cold-scan to resolve
  const reader = new CcrStore({ dir });
  const resolved = await reader.resolveHashPrefix(hash!.slice(0, 12));
  assert.ok(resolved?.startsWith(hash!), "resolved full hash must extend the stored prefix");
  const got = await reader.retrieve(hash!.slice(0, 12));
  assert.equal(got?.text, "some longish deterministic content for prefix lookup tests");
  rmSync(dir, { recursive: true, force: true });
});

test("oversized originals are refused (returns null)", async () => {
  const { store, dir } = tempStore();
  const res = await store.store("y".repeat(store.maxEntryBytes + 1));
  assert.equal(res, null);
  rmSync(dir, { recursive: true, force: true });
});

test("ttl eviction removes expired entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxroom-ccr3-"));
  const store = new CcrStore({ dir, ttlMs: -1 }); // negative ttl: everything is expired
  const hash = await store.store("old entry that must go");
  // A negative-ttl entry is evicted as soon as it is inserted (the store
  // self-evicts on store), so it is unretrievable.
  assert.equal(await store.retrieve(hash!), null);
  // And a normal-ttl store evicts nothing fresh.
  const store2 = new CcrStore({ dir, ttlMs: 60_000 });
  await store2.store("fresh entry");
  assert.equal(await store2.evictExpired(Date.now() + 1_000), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("stats reports entries and bytes", async () => {
  const { store, dir } = tempStore();
  await store.store("one");
  await store.store("two");
  await store.store("one"); // dedupe
  const s = await store.stats();
  assert.equal(s.entries, 2);
  assert.ok(s.bytes > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("marker renders with 12-hex hash", () => {
  const m = renderMarker("abc123def456", 1200, 300);
  assert.match(m, /^\[ctxroom:compressed [0-9a-f]{12} · \d+→\d+ tok · retrieve with ctxroom_retrieve\("[0-9a-f]{12}"\) \]$/);
});

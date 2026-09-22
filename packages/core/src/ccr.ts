/**
 * CCR — Compress, Cache, Retrieve.
 *
 * Originals of compressed blocks are stored content-addressed (sha256) on
 * local disk. The compressed replacement carries a short marker with a hash
 * prefix; the model (or a human) can call `retrieve()` to get the exact
 * original bytes back. Nothing leaves the machine.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Marker prefix embedded in compressed output. */
export const CCR_MARKER = "[ctxroom:";

export interface CcrOptions {
  /** Store root. Defaults to `<home>/cache`. */
  dir?: string;
  /** TTL for originals. Default 7 days. */
  ttlMs?: number;
  /** Max single-entry size. Default 20 MiB. */
  maxEntryBytes?: number;
  /** Resolve the home root; injectable for tests. */
  home?: string;
}

export interface RetrieveOptions {
  /** Return at most this many characters (default 20_000). */
  maxChars?: number;
  /** Start offset (continuations). */
  offset?: number;
}

export interface RetrieveResult {
  fullHash: string;
  text: string;
  totalChars: number;
  offset: number;
  /** True when more content is available beyond this window. */
  truncated: boolean;
}

export class CcrStore {
  readonly dir: string;
  readonly ttlMs: number;
  readonly maxEntryBytes: number;
  /** prefix (>=12 hex) -> full hash, learned at runtime and at cold start. */
  private readonly prefixIndex = new Map<string, string>();
  private evictionDue = 0;
  private coldScanDone = false;

  constructor(options: CcrOptions = {}) {
    const home = options.home ?? process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
    this.dir = options.dir ? path.resolve(options.dir) : path.join(home, "cache");
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxEntryBytes = options.maxEntryBytes ?? 20 * 1024 * 1024;
  }

  /** Resolve a short hash prefix (>= 6 chars) to a full sha256. */
  async resolveHashPrefix(prefix: string): Promise<string | null> {
    const p = prefix.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (p.length < 6) return null;
    if (this.prefixIndex.has(p)) return this.prefixIndex.get(p)!;
    await this.coldScan();
    if (this.prefixIndex.has(p)) return this.prefixIndex.get(p)!;
    // prefix may be longer than the 12 we index: index is keyed by 12-char prefix
    const key12 = p.slice(0, 12);
    return this.prefixIndex.get(key12) ?? null;
  }

  /**
   * Store one original. Returns the short (12-hex) hash to embed in the
   * marker, or `null` when it must not be stored (too large / failed).
   * Deterministic: identical content returns the same hash, never re-stores.
   */
  async store(original: string): Promise<string | null> {
    const bytes = Buffer.byteLength(original, "utf8");
    if (bytes > this.maxEntryBytes) return null;
    const hash = createHash("sha256").update(original, "utf8").digest("hex");
    const short = hash.slice(0, 12);
    this.prefixIndex.set(short, hash);
    const file = this.fileFor(hash);
    if (await pathExists(file)) return short; // dedupe
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, original, "utf8");
      await rename(tmp, file);
      this.maybeEvict();
      return short;
    } catch {
      return null;
    }
  }

  /** Retrieve an original (or a window of it) by hash or short prefix. */
  async retrieve(ref: string, options: RetrieveOptions = {}): Promise<RetrieveResult | null> {
    const fullHash = await this.resolveHashPrefix(ref);
    if (!fullHash) return null;
    const file = this.fileFor(fullHash);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }
    // Freshness is enforced here (not only by the periodic evictor): the
    // fire-and-forget evict can race with retrieve(), so an expired entry
    // must never be returned, whatever the directory state. A missing stat
    // means the file was evicted between the read and the stat — same
    // conclusion: it no longer exists, so it cannot be returned.
    const st = await stat(file).catch(() => null);
    if (!st) return null;
    if (Date.now() - st.mtimeMs > this.ttlMs) {
      await unlink(file).catch(() => {});
      return null;
    }
    const maxChars = options.maxChars ?? 20_000;
    const offset = options.offset ?? 0;
    const text = raw.slice(offset, offset + maxChars);
    return {
      fullHash,
      text,
      totalChars: raw.length,
      offset,
      truncated: offset + maxChars < raw.length,
    };
  }

  /** Remove expired originals. Cheap enough to run opportunistically. */
  async evictExpired(now = Date.now()): Promise<number> {
    if (now < this.evictionDue) return 0;
    this.evictionDue = now + 60 * 60 * 1000; // at most hourly
    let removed = 0;
    const entries = await this.allEntries();
    for (const e of entries) {
      const st = await stat(e.file).catch(() => null);
      if (!st) continue;
      if (now - st.mtimeMs > this.ttlMs) {
        await unlink(e.file).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  /** Store statistics (for /health and ctxroom_stats). */
  async stats(): Promise<{ entries: number; bytes: number }> {
    const entries = await this.allEntries();
    let bytes = 0;
    for (const e of entries) {
      const st = await stat(e.file).catch(() => null);
      if (st) bytes += st.size;
    }
    return { entries: entries.length, bytes };
  }

  private fileFor(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  private async allEntries(): Promise<{ file: string }[]> {
    const out: { file: string }[] = [];
    const shards = await readdir(this.dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const names = await readdir(path.join(this.dir, shard.name)).catch(() => [] as string[]);
      for (const n of names) {
        if (/^[0-9a-f]{64}$/.test(n)) out.push({ file: path.join(this.dir, shard.name, n) });
      }
    }
    return out;
  }

  private async coldScan(): Promise<void> {
    if (this.coldScanDone) return;
    this.coldScanDone = true;
    const entries = await this.allEntries();
    for (const e of entries) {
      const base = path.basename(e.file);
      this.prefixIndex.set(base.slice(0, 12), base);
    }
    await this.evictExpired().catch(() => 0);
  }

  private maybeEvict(): void {
    if (Date.now() >= this.evictionDue) {
      this.evictExpired().catch(() => 0);
    }
  }
}

export function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

/**
 * Render the marker appended to a compressed block.
 * `hash12` is the short CCR hash; sizes are estimated tokens.
 */
export function renderMarker(hash12: string, tokensBefore: number, tokensAfter: number): string {
  return `${CCR_MARKER}compressed ${hash12} · ${tokensBefore}→${tokensAfter} tok · retrieve with ctxroom_retrieve("${hash12}") ]`;
}

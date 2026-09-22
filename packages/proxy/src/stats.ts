/**
 * Local, append-only request statistics. Zero telemetry by design: every
 * byte stays on this machine, in JSONL under the ctxroom home dir
 * (`<home>/stats/YYYY-MM-DD.jsonl`, home = $CTXROOM_HOME or ~/.ctxroom).
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One JSONL line, one proxied request. */
export interface RequestStats {
  ts: string;
  /** Project attribution (from the /p/<name> base prefix, or "default"). */
  project: string;
  model: string;
  /** Path as forwarded upstream (after /p/ stripping). */
  path: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** Compact transform summary, e.g. ["compressor:json", "passthrough:text"]. */
  transforms: string[];
  ccrStored: number;
  /** Proxy-side processing time (body read + parse + compression), ms. */
  ms: number;
}

export interface StatsAgg {
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

export interface StatsSummary {
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** Saved as a percentage of tokensBefore (0 when nothing before). */
  pct: number;
  byDay: Record<string, StatsAgg>;
  byModel: Record<string, StatsAgg>;
  byProject: Record<string, StatsAgg>;
}

const emptyAgg = (): StatsAgg => ({ requests: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 });

function addTo(map: Map<string, StatsAgg>, key: string, s: RequestStats): void {
  const e = map.get(key) ?? emptyAgg();
  e.requests++;
  e.tokensBefore += s.tokensBefore ?? 0;
  e.tokensAfter += s.tokensAfter ?? 0;
  e.tokensSaved += s.tokensSaved ?? 0;
  map.set(key, e);
}

export class StatsWriter {
  readonly dir: string;

  constructor(dir?: string, home?: string) {
    const base = home ?? process.env.CTXROOM_HOME ?? path.join(os.homedir(), ".ctxroom");
    this.dir = dir ? path.resolve(dir) : path.join(base, "stats");
  }

  /** Append one line. Never throws (stats must not break a request). */
  async record(s: RequestStats): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const day = new Date(s.ts).toISOString().slice(0, 10);
      await appendFile(path.join(this.dir, `${day}.jsonl`), JSON.stringify(s) + "\n", "utf8");
    } catch {
      /* fire and forget */
    }
  }

  /**
   * Read all entries, newest day first. `days` bounds how far back we look
   * (days <= 0 means unbounded — used by tests that write same-day rows).
   */
  async readAll(days = 30): Promise<RequestStats[]> {
    const out: RequestStats[] = [];
    const files = (await readdir(this.dir).catch(() => [] as string[])).sort().reverse();
    for (const f of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const day = f.slice(0, 10);
      if (days > 0) {
        const cutoff = Date.now() - days * 86_400_000;
        if (Date.parse(day) < cutoff) continue;
      }
      const raw = await readFile(path.join(this.dir, f), "utf8").catch(() => "");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as RequestStats);
        } catch {
          /* skip malformed lines */
        }
      }
    }
    return out;
  }

  /** Aggregate for `ctxroom stats`: per-day / per-model / per-project totals. */
  async summary(days = 7): Promise<StatsSummary> {
    const all = await this.readAll(days);
    const byDay = new Map<string, StatsAgg>();
    const byModel = new Map<string, StatsAgg>();
    const byProject = new Map<string, StatsAgg>();
    let tokensBefore = 0;
    let tokensAfter = 0;
    let tokensSaved = 0;
    for (const s of all) {
      addTo(byDay, s.ts.slice(0, 10), s);
      addTo(byModel, s.model || "unknown", s);
      addTo(byProject, s.project || "default", s);
      tokensBefore += s.tokensBefore ?? 0;
      tokensAfter += s.tokensAfter ?? 0;
      tokensSaved += s.tokensSaved ?? 0;
    }
    return {
      requests: all.length,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      pct: tokensBefore > 0 ? (tokensSaved / tokensBefore) * 100 : 0,
      byDay: Object.fromEntries(byDay),
      byModel: Object.fromEntries(byModel),
      byProject: Object.fromEntries(byProject),
    };
  }
}

/**
 * @ctxroom/proxy — loopback compression proxy for the Copilot API.
 *
 * Zero runtime dependencies (node:http + global fetch). Bind 127.0.0.1 only,
 * no telemetry: all stats are local JSONL under the ctxroom home dir.
 */
export { startProxy, PROXY_VERSION, type ProxyOptions, type RunningProxy } from "./server.ts";
export { resolveUpstreamBase, DEFAULT_UPSTREAM, BUSINESS_UPSTREAM, type UpstreamEnv } from "./upstream.ts";
export {
  StatsWriter,
  type RequestStats,
  type StatsAgg,
  type StatsSummary,
} from "./stats.ts";
export { compressibleRoute, parseBody, applyBody, type CompressibleRoute, type ParsedBody } from "./normalize.ts";

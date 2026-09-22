/**
 * Upstream base-URL resolution for the Copilot API.
 *
 * Order (first set wins):
 *   CTXROOM_COPILOT_API_URL            explicit override (tests, special deployments)
 *   GITHUB_COPILOT_ENTERPRISE_URL      full GHE API URL
 *   GITHUB_COPILOT_ENTERPRISE_DOMAIN   GHE domain → https://api.<domain>
 *   GITHUB_COPILOT_ACCOUNT=enterprise → business cloud
 *   default                            github.com cloud
 */

export interface UpstreamEnv {
  [key: string]: string | undefined;
}

export const DEFAULT_UPSTREAM = "https://api.githubcopilot.com";
export const BUSINESS_UPSTREAM = "https://api.business.githubcopilot.com";

export function resolveUpstreamBase(env: UpstreamEnv = process.env): string {
  const explicit = env.CTXROOM_COPILOT_API_URL;
  if (explicit) return stripTrailingSlash(explicit);

  const gheUrl = env.GITHUB_COPILOT_ENTERPRISE_URL;
  if (gheUrl) return stripTrailingSlash(gheUrl);

  const gheDomain = env.GITHUB_COPILOT_ENTERPRISE_DOMAIN;
  if (gheDomain) return `https://api.${gheDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  if ((env.GITHUB_COPILOT_ACCOUNT ?? "").toLowerCase() === "enterprise") {
    return BUSINESS_UPSTREAM;
  }
  return DEFAULT_UPSTREAM;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

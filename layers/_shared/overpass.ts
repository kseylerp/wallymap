import { bodyHash } from "@/lib/fetch/cache";
import type { QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export const PUBLIC_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

export type OverpassResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string; status?: number };

const FAILURE_REMARK = /timed out|runtime error|out of memory/i;

/**
 * Overpass often answers HTTP 200 with a failure `remark` and empty or partial
 * `elements`. Returns the failure reason, or null when the body looks usable.
 */
export function overpassFailure(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return "unexpected response body";
  const body = json as Record<string, unknown>;
  if (typeof body.remark === "string" && FAILURE_REMARK.test(body.remark)) return body.remark;
  if (!Array.isArray(body.elements)) return "response has no elements";
  return null;
}

/**
 * POSTs an Overpass QL query (form-encoded as `data=`). Tries `ctx.env.OVERPASS_URL`
 * (blank counts as unset) then retries once on the public endpoint; a 200 whose body
 * carries a failure remark counts as a failure. Each attempt is capped at 25 seconds.
 */
export async function overpassQuery(
  ctx: QueryContext,
  query: string,
  opts: { cacheSuffix?: string } = {},
): Promise<OverpassResult> {
  const primary = ctx.env.OVERPASS_URL || PUBLIC_OVERPASS_ENDPOINT;
  // Without ctx.cacheKey the fetch wrapper builds its own URL + body-hash key.
  // Without a suffix, hash the query so two queries from one ctx never share a key.
  const baseKey =
    ctx.cacheKey === undefined
      ? undefined
      : `${ctx.cacheKey}:${opts.cacheSuffix ?? `overpass:${bodyHash(query)}`}`;

  // The fallback gets its own key so a cached primary failure never answers it.
  const attempts = [
    { url: primary, key: baseKey },
    { url: PUBLIC_OVERPASS_ENDPOINT, key: baseKey === undefined ? undefined : `${baseKey}:fallback` },
  ];

  let error = "Overpass returned no response";
  let status: number | undefined;
  for (const { url, key } of attempts) {
    status = undefined;
    try {
      const res = await ctx.fetch(url, {
        cacheKey: key,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        error = `Overpass returned ${res.status}`;
        status = res.status;
        continue;
      }
      const json: unknown = await res.json();
      const failure = overpassFailure(json);
      if (failure === null) return { ok: true, json };
      error = `Overpass failed: ${failure}`;
    } catch (err) {
      error =
        // DOMException is not an Error subclass in every runtime, so match on name.
        typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError"
          ? `Overpass timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "Overpass returned no response";
    }
  }
  return status === undefined ? { ok: false, error } : { ok: false, error, status };
}

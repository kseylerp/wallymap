import { bodyHash } from "@/lib/fetch/cache";
import type { BBox, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export const PUBLIC_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

/** The public endpoint answers 406 to requests without a descriptive User-Agent, so every attempt sends this one. */
export const OVERPASS_USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";

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

const FAILURE_REMARK_IN_JSON = /"remark"\s*:\s*"[^"]*(timed out|runtime error|out of memory)/i;

/**
 * Whether an Overpass 200 body is worth caching, checked on the text so large answers are not parsed
 * twice: no failure remark and an `elements` array present. An empty `elements` is a real answer.
 */
export function overpassBodyCacheable(body: string): boolean {
  return !FAILURE_REMARK_IN_JSON.test(body) && /"elements"\s*:\s*\[/.test(body);
}

/**
 * POSTs an Overpass QL query (form-encoded as `data=`). Tries `ctx.env.OVERPASS_URL`
 * (blank counts as unset) then retries once on the public endpoint; a 200 whose body
 * carries a failure remark counts as a failure. Each attempt is capped at 25 seconds and sends OVERPASS_USER_AGENT.
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
        shouldCache: overpassBodyCacheable,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": OVERPASS_USER_AGENT },
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

export type NamedOverpassParams = {
  /** Overpass selectors without the bbox, such as `nwr["tourism"="camp_site"]` or `relation["route"="mtb"]`. */
  selectors: string[];
  bbox: BBox;
  /** point: `out center` (one position per node, way or relation); line: ways and relations with geometry clipped to the box. */
  geometry: "point" | "line";
  /** Most elements sent (Overpass's own `out` cap). */
  limit: number;
  /** Server-side timeout in seconds; the client still gives up at UPSTREAM_TIMEOUT_MS. */
  timeoutSeconds?: number;
};

/**
 * Overpass QL for a layer's WIDE `named` mode: one bbox search for every match and its `out count`, then the named ones
 * filtered from that set (not searched for again: over Utah a second search took 27 s against 2.5 s for the filter,
 * measured 2026-10-14), their `out count`, and at most `limit` of them, so the note can say "the 2,000 named of 9,400".
 * Points come back as `out center`; lines as `out geom(<bbox>)`, which clips way and relation member geometry to the
 * box, so a 300 km route costs only its part inside. Read the two counts with `overpassCounts` ([all, named]).
 */
export function namedOverpassQuery({ selectors, bbox, geometry, limit, timeoutSeconds = 25 }: NamedOverpassParams): string {
  const [west, south, east, north] = bbox;
  const box = `(${south},${west},${north},${east})`;
  const all = selectors.map((sel) => `${sel}${box};`).join("");
  const out = geometry === "point" ? `out tags center ${limit};` : `out tags geom${box} ${limit};`;
  return `[out:json][timeout:${timeoutSeconds}];(${all})->.all;.all out count;nwr.all["name"]->.named;.named out count;.named ${out}`;
}

/** The `total` of each `out count` element in a body, in order (for namedOverpassQuery: every match, then the named). */
export function overpassCounts(json: unknown): number[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((el) => {
    if (typeof el !== "object" || el === null || (el as { type?: unknown }).type !== "count") return [];
    const n = Number((el as { tags?: { total?: unknown } }).tags?.total);
    return Number.isFinite(n) ? [n] : [];
  });
}

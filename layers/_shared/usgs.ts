/**
 * USGS NWIS instantaneous values (IV) service, shared by the streamflow and fishing layers.
 * Endpoint: https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=W,S,E,N&parameterCd=...&siteStatus=active&siteType=ST
 * Verified live 2026-10-09 (Lake Tahoe box: 26 time series, 41 KB, under a second):
 *   - Response is WaterML-as-JSON: value.timeSeries[] with sourceInfo.siteCode[0].value ("10310000"),
 *     sourceInfo.siteName, sourceInfo.geoLocation.geogLocation.{latitude, longitude},
 *     variable.variableCode[0].value ("00060"), variable.noDataValue (-999999), and values[].value[] rows of
 *     { value: "19.4" (string), qualifiers: ["P"], dateTime: "2026-10-09T18:45:00.000-07:00" }.
 *     Without `period` the service returns each series' newest value only. One site has one series per
 *     parameter (sometimes several sensors, so several `values` blocks); the newest row wins.
 *   - bBox limit: (east - west) x (north - south) must be at most 25 square degrees, else HTTP 400
 *     (a 6 x 6 box failed, 5 x 5 took 17 s and 700 KB). `ivStrips` splits a larger box into lon strips.
 *   - An area with no gauges is a 200 with `timeSeries: []`.
 * The service is the legacy NWIS API; USGS is moving users to api.waterdata.usgs.gov, so streamflow keeps
 * that API as a fallback.
 */
import { z } from "zod";
import type { BBox, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

export const USGS_IV = "https://waterservices.usgs.gov/nwis/iv/";

/** Largest bBox the IV service accepts, in square degrees. */
const MAX_IV_SQ_DEG = 25;
const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

export type IvReading = { time: number; /** Local ISO time as published, with its offset. */ local: string; value: number };

export type IvSite = {
  /** "USGS-" plus the site number, matching the Water Data API ids. */
  siteId: string;
  siteNo: string;
  name: string;
  coordinates: [number, number];
  /** Newest reading per parameter code ("00060", "00010", ...). */
  readings: Record<string, IvReading>;
};

const RowSchema = z.object({ value: z.string(), dateTime: z.string() });

const SeriesSchema = z.object({
  sourceInfo: z.object({
    siteName: z.string(),
    siteCode: z.array(z.object({ value: z.string() })).min(1),
    geoLocation: z.object({ geogLocation: z.object({ latitude: z.number(), longitude: z.number() }) }),
  }),
  variable: z.object({
    variableCode: z.array(z.object({ value: z.string() })).min(1),
    noDataValue: z.number().nullish(),
  }),
  values: z.array(z.object({ value: z.array(z.unknown()) })),
});

function seriesOf(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null || !("value" in body)) return null;
  const value = body.value;
  if (typeof value !== "object" || value === null || !("timeSeries" in value)) return null;
  return Array.isArray(value.timeSeries) ? value.timeSeries : null;
}

/** True when `body` is an IV response (it has a timeSeries array, possibly empty). */
export function isIvBody(body: unknown): boolean {
  return seriesOf(body) !== null;
}

/**
 * Sites from one or more IV bodies, newest reading per parameter, readings older than 7 days dropped, sites
 * with no recent reading at all left out.
 */
export function parseIv(bodies: unknown[], now: Date): IvSite[] {
  const sites = new Map<string, IvSite>();
  const cutoff = now.getTime() - MAX_AGE_DAYS * DAY_MS;
  for (const body of bodies) {
    for (const raw of seriesOf(body) ?? []) {
      const parsed = SeriesSchema.safeParse(raw);
      if (!parsed.success) continue;
      const { sourceInfo, variable, values } = parsed.data;
      const code = variable.variableCode[0].value;
      const noData = variable.noDataValue ?? -999999;
      let best: IvReading | undefined;
      for (const block of values) {
        for (const r of block.value) {
          const row = RowSchema.safeParse(r);
          if (!row.success) continue;
          const value = Number(row.data.value);
          const time = Date.parse(row.data.dateTime);
          if (row.data.value.trim() === "" || !Number.isFinite(value) || value === noData) continue;
          if (!Number.isFinite(time) || time < cutoff) continue;
          if (best === undefined || time > best.time) best = { time, local: row.data.dateTime, value };
        }
      }
      if (best === undefined) continue;
      const siteNo = sourceInfo.siteCode[0].value;
      let site = sites.get(siteNo);
      if (site === undefined) {
        const { longitude, latitude } = sourceInfo.geoLocation.geogLocation;
        site = {
          siteId: `USGS-${siteNo}`,
          siteNo,
          name: sourceInfo.siteName.trim() || `USGS-${siteNo}`,
          coordinates: [longitude, latitude],
          readings: {},
        };
        sites.set(siteNo, site);
      }
      const current = site.readings[code];
      if (current === undefined || best.time > current.time) site.readings[code] = best;
    }
  }
  return [...sites.values()];
}

/** Splits a bbox into equal longitude strips that each fit the IV service's 25 square degree limit. */
export function ivStrips(bbox: BBox): BBox[] {
  const [west, south, east, north] = bbox;
  const sqDeg = (east - west) * (north - south);
  const n = Math.max(1, Math.ceil(sqDeg / MAX_IV_SQ_DEG));
  const step = (east - west) / n;
  const round = (x: number) => Number(x.toFixed(6));
  return Array.from({ length: n }, (_, i) => [
    round(west + i * step),
    south,
    i === n - 1 ? east : round(west + (i + 1) * step),
    north,
  ]);
}

export function ivUrl(bbox: BBox, parameterCodes: string[]): string {
  const [west, south, east, north] = bbox.map((x) => Number(x.toFixed(6)));
  return (
    `${USGS_IV}?format=json&bBox=${west},${south},${east},${north}` +
    `&parameterCd=${parameterCodes.join(",")}&siteStatus=active&siteType=ST`
  );
}

export type IvFetched = { ok: true; bodies: unknown[] } | { ok: false; error: string };

/**
 * Fetches IV for a bbox (split into strips when needed). Each strip is cached under
 * `${ctx.cacheKey}:${suffix}[:i]` for `ttlSeconds`.
 */
export async function fetchIv(
  ctx: QueryContext,
  parameterCodes: string[],
  suffix: string,
  ttlSeconds: number,
): Promise<IvFetched> {
  const strips = ivStrips(ctx.bbox);
  const results = await Promise.all(
    strips.map(async (strip, i): Promise<IvFetched> => {
      try {
        const res = await ctx.fetch(ivUrl(strip, parameterCodes), {
          cacheKey:
            ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}${strips.length > 1 ? `:${i}` : ""}`,
          ttlSeconds,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
        });
        if (!res.ok) return { ok: false, error: `USGS instantaneous values returned ${res.status}` };
        const body: unknown = await res.json();
        if (!isIvBody(body)) return { ok: false, error: "USGS instantaneous values returned an unexpected body" };
        return { ok: true, bodies: [body] };
      } catch (err) {
        const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
        return {
          ok: false,
          error: timedOut
            ? `USGS instantaneous values timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
            : "USGS instantaneous values returned no usable response",
        };
      }
    }),
  );
  const bodies: unknown[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    bodies.push(...r.bodies);
  }
  return { ok: true, bodies };
}

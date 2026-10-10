/**
 * Latest stream gauge readings from the USGS Water Data API (OGC API - Features), base
 * https://api.waterdata.usgs.gov/ogcapi/v0/collections. Collections checked live on 2026-10-09
 * (GET /collections?f=json lists 39; the ones used here):
 *   - `latest-continuous`: one row per time series with its newest value (15-minute sensors).
 *     Query: bbox, parameter_code, site_type_code, f=json, limit (up to 10000 worked; a 6 x 6 degree
 *     box returned 509 rows in one page). Row properties used: monitoring_location_id ("USGS-10338000"),
 *     time (ISO 8601 with offset), value (a STRING such as "70.3"), unit_of_measure ("ft^3/s" for 00060,
 *     "ft" for 00065). Each row has a Point geometry. `site_type_code=ST` (stream) filters server side.
 *   - `monitoring-locations`: site metadata. `id=USGS-1,USGS-2,...` selects sites and
 *     `properties=id,monitoring_location_name` trims each row (a bbox query without `properties` was
 *     about 2 KB per site and capped at 500 sites).
 *   - `latest-daily` (daily values) exists too but is not needed because `latest-continuous` does.
 * Why the flow differs from "locations first": `latest-continuous` takes bbox itself and returns geometry,
 * so it is queried first and only the ids that have a recent reading are looked up for names. Locations
 * first would pull hundreds of inactive stream sites (425 in a 0.8 x 0.7 degree Tahoe box, 18 reporting).
 * Stale rows: `latest-continuous` also keeps the last value of discontinued gauges (readings from 1991 to
 * 2014 appear in the Tahoe fixture), and one site can have several time series. Rows older than 7 days
 * are dropped and the newest reading per site wins.
 * Rate limit: the API sits behind api.data.gov and is throttled hard without a key; an optional
 * USGS_API_KEY (free from https://api.waterdata.usgs.gov/signup/) is sent as the X-Api-Key header.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";

const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const LATEST_LIMIT = 10_000;
/** Site ids per name lookup; keeps each URL near 1.5 KB. */
const NAME_BATCH_SIZE = 100;
/** Gauges report every 15 minutes, so ten minutes of cache keeps the map current. */
const LATEST_TTL_SECONDS = 600;

const inputSchema = z.object({
  parameter: z.enum(["00060", "00065"]).default("00060"),
});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const ReadingRowSchema = z.object({
  geometry: z
    .object({ type: z.literal("Point"), coordinates: z.array(z.number()).min(2) })
    .nullable()
    .optional(),
  properties: z.object({
    monitoring_location_id: z.string(),
    time: z.string(),
    value: z.union([z.string(), z.number()]).nullable().optional(),
  }),
});

const NameRowSchema = z.object({
  properties: z.object({
    id: z.string(),
    monitoring_location_name: z.string().nullable().optional(),
  }),
});

type Reading = { siteId: string; coordinates: [number, number]; time: number; value: number };

function rowsOf(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features)) {
    return body.features;
  }
  return [];
}

/** Recent, numeric readings from a `latest-continuous` body, newest per site. */
function latestReadings(body: unknown, now: Date): Reading[] {
  const newest = new Map<string, Reading>();
  const cutoff = now.getTime() - MAX_AGE_DAYS * DAY_MS;
  for (const row of rowsOf(body)) {
    const parsed = ReadingRowSchema.safeParse(row);
    if (!parsed.success || !parsed.data.geometry) continue;
    const { properties, geometry } = parsed.data;
    const raw = properties.value;
    const value = typeof raw === "number" ? raw : raw == null || raw.trim() === "" ? NaN : Number(raw);
    const time = Date.parse(properties.time);
    if (!Number.isFinite(value) || !Number.isFinite(time) || time < cutoff) continue;
    const current = newest.get(properties.monitoring_location_id);
    if (current === undefined || time > current.time) {
      newest.set(properties.monitoring_location_id, {
        siteId: properties.monitoring_location_id,
        coordinates: [geometry.coordinates[0], geometry.coordinates[1]],
        time,
        value,
      });
    }
  }
  return [...newest.values()];
}

function namesFrom(bodies: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const body of bodies) {
    for (const row of rowsOf(body)) {
      const parsed = NameRowSchema.safeParse(row);
      const name = parsed.success ? parsed.data.properties.monitoring_location_name?.trim() : undefined;
      if (parsed.success && name) names.set(parsed.data.properties.id, name);
    }
  }
  return names;
}

function toFeatures(readings: Reading[], names: Map<string, string>): FeatureCollection {
  const features: Feature<Point>[] = readings.map((r) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: r.coordinates },
    properties: {
      name: names.get(r.siteId) ?? r.siteId,
      siteId: r.siteId,
      t: new Date(r.time).toISOString(),
      v: r.value,
    },
  }));
  return { type: "FeatureCollection", features };
}

/**
 * Joins a `latest-continuous` body and `monitoring-locations` body into gauge points: recent readings only,
 * newest per site, named by site id (the id itself when no name is known).
 */
export function joinGauges(latestBody: unknown, locationsBody: unknown, now: Date): FeatureCollection {
  return toFeatures(latestReadings(latestBody, now), namesFrom([locationsBody]));
}

type Fetched = { ok: true; body: unknown } | { ok: false; error: string };

async function fetchJson(
  ctx: QueryContext,
  url: string,
  label: string,
  suffix: string,
  ttlSeconds?: number,
): Promise<Fetched> {
  const apiKey = ctx.env.USGS_API_KEY;
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}`,
      ttlSeconds,
      ...(apiKey ? { headers: { "X-Api-Key": apiKey } } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `USGS ${label} returned ${res.status}` };
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("features" in body) || !Array.isArray(body.features)) {
      return { ok: false, error: `USGS ${label} did not return a FeatureCollection` };
    }
    return { ok: true, body };
  } catch (err) {
    const timedOut =
      typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `USGS ${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
        : `USGS ${label} returned no usable response`,
    };
  }
}

function hasNextPage(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("links" in body) || !Array.isArray(body.links)) return false;
  return body.links.some((l: unknown) => typeof l === "object" && l !== null && "rel" in l && l.rel === "next");
}

const streamflow = defineLayer({
  id: "streamflow",
  title: "Stream flow (USGS gauges)",
  description:
    "Current stream and river conditions at USGS gauges in the United States. " +
    "Each point is a gauge with name, siteId (USGS site id), t (UTC time of the reading) and v (the reading). " +
    "parameter 00060 (default) is discharge: how much water is flowing past the gauge, in cubic feet per second (cfs). " +
    "parameter 00065 is gage height, the water level at the gauge in feet; it is not depth, and its zero point is arbitrary for each gauge, so only compare it to the same gauge's own history. " +
    "It is near-real-time: each value is the gauge's latest reading, taken every 15 minutes to an hour and usually less than an hour old. " +
    "Use it to show how high or low rivers are right now, for paddling, fording or fishing questions. " +
    "Caveats: readings are provisional and unreviewed, and can change; v is a single moment, not a daily average or a comparison with normal flow, so a number alone does not say whether a river is high or low for its size; " +
    "gauges that have not reported in the last 7 days (discontinued or broken) are left out; ice, equipment trouble or a dry channel can give 0 or odd values; " +
    "only stream sites are included, not lakes or wells, and some parameters exist at only some gauges. " +
    "United States only; elsewhere it returns nothing. Needs a region under 400,000 km² (about the size of California).",
  coverage: "us",
  license: "Public domain (USGS)",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY"],
  maxAreaKm2: 400_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("streamflow"), unit: "cfs" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source: "USGS Water Data API, latest continuous values (public domain; provisional data)",
      url: "https://api.waterdata.usgs.gov/",
      retrieved: now.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const [west, south, east, north] = ctx.bbox;
    const latestUrl =
      `${BASE}/latest-continuous/items?bbox=${west},${south},${east},${north}` +
      `&parameter_code=${input.parameter}&site_type_code=ST&f=json&limit=${LATEST_LIMIT}`;
    const latest = await fetchJson(ctx, latestUrl, "latest values", "usgs-latest", LATEST_TTL_SECONDS);
    if (!latest.ok) return { error: latest.error, hint: "upstream" };

    if (rowsOf(latest.body).length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: "No USGS gauges in this area" };
    }

    const readings = latestReadings(latest.body, now);
    if (readings.length === 0) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: `No USGS gauges here have reported in the last ${MAX_AGE_DAYS} days`,
      };
    }

    const batches: string[][] = [];
    const ids = readings.map((r) => r.siteId);
    for (let i = 0; i < ids.length; i += NAME_BATCH_SIZE) batches.push(ids.slice(i, i + NAME_BATCH_SIZE));
    const named = await Promise.all(
      batches.map((batch, i) =>
        fetchJson(
          ctx,
          `${BASE}/monitoring-locations/items?id=${batch.join(",")}&f=json&limit=${NAME_BATCH_SIZE}` +
            `&properties=id,monitoring_location_name`,
          "site names",
          batches.length > 1 ? `usgs-names:${i}` : "usgs-names",
        ),
      ),
    );
    const bodies: unknown[] = [];
    for (const result of named) {
      if (!result.ok) return { error: result.error, hint: "upstream" };
      bodies.push(result.body);
    }

    return {
      kind: "geojson",
      data: toFeatures(readings, namesFrom(bodies)),
      citation,
      ...(hasNextPage(latest.body)
        ? { coverageNote: `Showing only the first ${LATEST_LIMIT.toLocaleString("en-US")} gauges, not all of them; zoom in for the rest` }
        : {}),
    };
  },
});

registerLayer(streamflow);

export default streamflow;

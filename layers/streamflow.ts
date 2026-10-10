/**
 * Live stream gauges: USGS NWIS instantaneous values (primary), USGS Water Data API (fallback), and GloFAS
 * modelled river discharge via the Open-Meteo flood API outside the United States.
 *
 * Primary (US): https://waterservices.usgs.gov/nwis/iv/ (see layers/_shared/usgs.ts), parameterCd=00060,00010
 * (discharge cfs + water temperature C) or 00065,00010 (gage height ft). Cached 10 minutes.
 *
 * Percent of median (US, discharge only): https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=...
 * &statReportType=daily&statTypeCd=median&parameterCd=00060. Verified live 2026-10-09: it has NO bBox (HTTP 400)
 * and takes at most 10 sites per call (11 gave HTTP 400 "max=[10]"); tab-separated RDB, `#` comment lines, a
 * header row, a column-width row, then rows of agency_cd, site_no, parameter_cd, ts_id, loc_web_ds, month_nu,
 * day_nu, begin_yr, end_yr, count_nu, p50_va (median of the daily means for that calendar day over count_nu
 * years). About 18 KB per site, so medians are fetched for the STAT_SITE_CAP largest-flow gauges only, 10 per
 * call, and cached for a week under a key shared across bboxes (the statistics change once a year).
 *
 * Fallback (US): when the IV service fails, the Water Data API (OGC API - Features), base
 * https://api.waterdata.usgs.gov/ogcapi/v0/collections, as before M4:
 *   - `latest-continuous`: one row per time series with its newest value. Query: bbox, parameter_code,
 *     site_type_code=ST, f=json, limit (up to 10000). Row properties used: monitoring_location_id
 *     ("USGS-10338000"), time (ISO 8601 with offset), value (a STRING such as "70.3"). Point geometry.
 *   - `monitoring-locations`: `id=USGS-1,USGS-2,...&properties=id,monitoring_location_name` for names.
 *   Stale rows (discontinued gauges back to 1991) are dropped after 7 days; newest reading per site wins.
 *   Throttled hard without a key; an optional USGS_API_KEY is sent as X-Api-Key.
 *
 * Outside the US: OSM `waterway=river` ways with a name in the bbox (Overpass `out center tags`), the
 * RIVER_POINTS longest rivers (by segment count) each sampled at the segment centre nearest its middle, then
 * https://flood-api.open-meteo.com/v1/flood?latitude=a,b&longitude=c,d&daily=river_discharge&past_days=1
 * &forecast_days=1 (multi-location: a JSON array, one object per point, daily.time + daily.river_discharge
 * in m3/s). GloFAS is a 0.05° (about 5 km) model, daily, not a gauge. Live check: the Rhone point east of Lyon
 * read 0.26 m3/s in its own cell and 326-329 m3/s one cell over, so each river samples its 3 x 3 cells and
 * keeps the largest. `river_discharge_median` in that API is the ensemble median, not a climatology, so no
 * percent of median is given there.
 *
 * Live smoke 2026-10-09 ~02:05 UTC: Tahoe box, 18 discharge gauges; W FK Carson at Woodfords 19.4 cfs,
 * 84% of the 23 cfs Oct 9 median; Upper Truckee at South Lake Tahoe 5.42 cfs, 49% of median, 14.9 C.
 * Lyon box [4.7,45.6,6.3,46.3] (outside US): 8 rivers; Le Rhone 328.6 m3/s = 11,605 cfs modelled.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type Citation, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { outsideUs } from "./_shared/coverage";
import { overpassQuery } from "./_shared/overpass";
import { fetchIv, parseIv, type IvSite } from "./_shared/usgs";
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

// ---- Live IV path (primary) ----

const STAT_URL = "https://waterservices.usgs.gov/nwis/stat/";
/** The statistics service rejects more than 10 sites per call. */
const STAT_BATCH = 10;
/** Medians are looked up for this many gauges (largest flow first): three calls at most. */
export const STAT_SITE_CAP = 30;
const STAT_TTL_SECONDS = 7 * 86_400;
const CFS_PER_M3S = 35.3147;

/** Median daily discharge by site number and "MM-DD", from a stat-service RDB body. */
export function parseDailyMedians(rdb: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  let header: string[] | null = null;
  let skippedWidths = false;
  for (const line of rdb.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const cols = line.split("\t");
    if (header === null) {
      header = cols;
      continue;
    }
    if (!skippedWidths) {
      skippedWidths = true;
      continue;
    }
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
    const p50 = Number(row.p50_va);
    const month = Number(row.month_nu);
    const day = Number(row.day_nu);
    if (row.parameter_cd !== "00060" || row.p50_va === "" || !Number.isFinite(p50)) continue;
    if (!Number.isInteger(month) || !Number.isInteger(day)) continue;
    const key = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let site = out.get(row.site_no);
    if (site === undefined) {
      site = new Map();
      out.set(row.site_no, site);
    }
    // A site with several time series keeps the first median seen for the day.
    if (!site.has(key)) site.set(key, p50);
  }
  return out;
}

/** Rough label for the model: under half of median is low, over 1.5 times is high. */
function vsNormal(pct: number): "low" | "normal" | "high" {
  if (pct < 50) return "low";
  if (pct > 150) return "high";
  return "normal";
}

/**
 * Gauge points from parsed IV sites. `main` is the parameter that becomes `v` (00060 or 00065); sites without
 * it but with a water temperature are kept with only `tempC`. Medians (when given) add pctOfMedian,
 * medianCfs and vsNormal for the reading's local calendar day.
 */
export function ivFeatures(
  sites: IvSite[],
  main: "00060" | "00065",
  medians: Map<string, Map<string, number>>,
): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const site of sites) {
    const reading = site.readings[main];
    const temp = site.readings["00010"];
    if (reading === undefined && temp === undefined) continue;
    const properties: Record<string, string | number> = {
      name: site.name,
      siteId: site.siteId,
      kind: "gauge",
    };
    if (reading !== undefined) {
      properties.t = new Date(reading.time).toISOString();
      properties.v = reading.value;
      // The published local time's date is the calendar day the statistics are keyed by.
      const monthDay = reading.local.slice(5, 10);
      const median = main === "00060" ? medians.get(site.siteNo)?.get(monthDay) : undefined;
      if (median !== undefined && median > 0) {
        const pct = Math.round((reading.value / median) * 100);
        properties.pctOfMedian = pct;
        properties.medianCfs = median;
        properties.vsNormal = vsNormal(pct);
      }
    } else if (temp !== undefined) {
      properties.t = new Date(temp.time).toISOString();
    }
    if (temp !== undefined) properties.tempC = temp.value;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: site.coordinates }, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Site numbers that get a median lookup: the largest current discharge first, capped. */
export function statSites(sites: IvSite[]): string[] {
  return sites
    .filter((s) => s.readings["00060"] !== undefined)
    .sort((a, b) => (b.readings["00060"]?.value ?? 0) - (a.readings["00060"]?.value ?? 0))
    .slice(0, STAT_SITE_CAP)
    .map((s) => s.siteNo)
    .sort();
}

async function fetchMedians(ctx: QueryContext, siteNos: string[]): Promise<Map<string, Map<string, number>>> {
  const batches: string[][] = [];
  for (let i = 0; i < siteNos.length; i += STAT_BATCH) batches.push(siteNos.slice(i, i + STAT_BATCH));
  const bodies = await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await ctx.fetch(
          `${STAT_URL}?format=rdb&sites=${batch.join(",")}&statReportType=daily&statTypeCd=median&parameterCd=00060`,
          {
            // Statistics do not depend on the bbox, so the key is the site list alone.
            cacheKey: `streamflow:stat:${batch.join(",")}`,
            ttlSeconds: STAT_TTL_SECONDS,
            shouldCache: (body) => body.includes("p50_va"),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          },
        );
        return res.ok ? await res.text() : "";
      } catch {
        // Medians are an extra; a failure leaves pctOfMedian out rather than failing the layer.
        return "";
      }
    }),
  );
  const merged = new Map<string, Map<string, number>>();
  for (const body of bodies) for (const [site, days] of parseDailyMedians(body)) merged.set(site, days);
  return merged;
}

// ---- Outside the US: GloFAS via Open-Meteo ----

const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
/** Rivers sampled outside the US; one multi-location flood call covers them all. */
export const RIVER_POINTS = 8;

const RiverElementSchema = z.object({
  type: z.literal("way"),
  id: z.number(),
  center: z.object({ lat: z.number(), lon: z.number() }),
  tags: z.object({ name: z.string() }).catchall(z.string()),
});

export type RiverPoint = { name: string; coordinates: [number, number] };

/**
 * One sample point per named river: the RIVER_POINTS rivers with the most way segments in the bbox (a proxy
 * for length), each at the segment centre closest to the mean of that river's segment centres.
 */
export function riverSamplePoints(overpassJson: unknown): RiverPoint[] {
  const elements =
    typeof overpassJson === "object" && overpassJson !== null && "elements" in overpassJson && Array.isArray(overpassJson.elements)
      ? overpassJson.elements
      : [];
  const byName = new Map<string, [number, number][]>();
  for (const raw of elements) {
    const parsed = RiverElementSchema.safeParse(raw);
    if (!parsed.success) continue;
    const name = parsed.data.tags.name.trim();
    if (name === "") continue;
    const list = byName.get(name) ?? [];
    list.push([parsed.data.center.lon, parsed.data.center.lat]);
    byName.set(name, list);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, RIVER_POINTS)
    .map(([name, centres]) => {
      const mx = centres.reduce((s, c) => s + c[0], 0) / centres.length;
      const my = centres.reduce((s, c) => s + c[1], 0) / centres.length;
      let best = centres[0];
      let bestD = Infinity;
      for (const c of centres) {
        const d = (c[0] - mx) ** 2 + (c[1] - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return { name, coordinates: best };
    });
}

const FloodSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    river_discharge: z.array(z.number().nullable()),
  }),
});

/** Offsets in degrees around each river point; GloFAS cells are 0.05°, so this covers the 3 x 3 cells around it. */
const NEIGHBOUR_OFFSETS: [number, number][] = [-0.05, 0, 0.05].flatMap((dy) =>
  [-0.05, 0, 0.05].map((dx): [number, number] => [dx, dy]),
);

/** The flood-API sample locations: NEIGHBOUR_OFFSETS around each river point, in point order. */
export function floodSampleLocations(points: RiverPoint[]): [number, number][] {
  return points.flatMap((p) =>
    NEIGHBOUR_OFFSETS.map(([dx, dy]): [number, number] => [
      Number((p.coordinates[0] + dx).toFixed(4)),
      Number((p.coordinates[1] + dy).toFixed(4)),
    ]),
  );
}

function newestDischarge(row: unknown, today: string): { date: string; m3s: number } | undefined {
  const parsed = FloodSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const { time, river_discharge } = parsed.data.daily;
  let best: { date: string; m3s: number } | undefined;
  time.forEach((date, j) => {
    const m3s = river_discharge[j];
    if (typeof m3s !== "number" || date > today) return;
    if (best === undefined || date > best.date) best = { date, m3s };
  });
  return best;
}

/**
 * Modelled points from a flood-API body for `floodSampleLocations(points)`. An OSM river point rarely falls in
 * the model cell that carries the river, and neighbouring cells hold only local runoff, so each river takes the
 * largest discharge among its 3 x 3 cells (newest day up to today).
 */
export function floodFeatures(points: RiverPoint[], body: unknown, now: Date): FeatureCollection<Point> {
  const rows = Array.isArray(body) ? body : [body];
  const today = now.toISOString().slice(0, 10);
  const features: Feature<Point>[] = [];
  points.forEach((point, i) => {
    let best: { date: string; m3s: number } | undefined;
    for (let k = 0; k < NEIGHBOUR_OFFSETS.length; k++) {
      const reading = newestDischarge(rows[i * NEIGHBOUR_OFFSETS.length + k], today);
      if (reading !== undefined && (best === undefined || reading.m3s > best.m3s)) best = reading;
    }
    if (best === undefined) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point.coordinates },
      properties: {
        name: point.name,
        kind: "model",
        t: new Date(`${best.date}T00:00:00Z`).toISOString(),
        v: Math.round(best.m3s * CFS_PER_M3S),
        dischargeM3s: best.m3s,
      },
    });
  });
  return { type: "FeatureCollection", features };
}

async function queryOutsideUs(ctx: QueryContext, now: Date): Promise<LayerResult | LayerError> {
  const citation: Citation = {
    source: "GloFAS river discharge via the Open-Meteo flood API (CC BY 4.0, non-commercial use free); river names from OpenStreetMap (ODbL)",
    url: "https://open-meteo.com/en/docs/flood-api",
    retrieved: now.toISOString(),
  };
  const [west, south, east, north] = ctx.bbox;
  const rivers = await overpassQuery(
    ctx,
    `[out:json][timeout:25];way["waterway"="river"]["name"](${south},${west},${north},${east});out center tags;`,
    { cacheSuffix: "osm-rivers" },
  );
  if (!rivers.ok) return { error: rivers.error, hint: "upstream" };
  const points = riverSamplePoints(rivers.json);
  if (points.length === 0) {
    return { kind: "geojson", data: EMPTY, citation, coverageNote: "No named rivers in OpenStreetMap here" };
  }
  const locations = floodSampleLocations(points);
  const url =
    `${FLOOD_API}?latitude=${locations.map((l) => l[1]).join(",")}` +
    `&longitude=${locations.map((l) => l[0]).join(",")}` +
    `&daily=river_discharge&past_days=1&forecast_days=1&timezone=GMT`;
  let body: unknown;
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glofas`,
      ttlSeconds: 3_600,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Open-Meteo flood API returned ${res.status}`, hint: "upstream" };
    body = await res.json();
  } catch {
    return { error: "Open-Meteo flood API returned no usable response", hint: "upstream" };
  }
  return {
    kind: "geojson",
    data: floodFeatures(points, body, now),
    citation,
    coverageNote:
      "Outside the United States: modelled daily river discharge (GloFAS, 5 km grid), not gauge readings; one point per major river",
  };
}

// ---- Water Data API fallback ----

async function queryWaterDataApi(
  ctx: QueryContext,
  parameter: "00060" | "00065",
  now: Date,
  citation: Citation,
): Promise<LayerResult | LayerError> {
  const [west, south, east, north] = ctx.bbox;
  const latestUrl =
    `${BASE}/latest-continuous/items?bbox=${west},${south},${east},${north}` +
    `&parameter_code=${parameter}&site_type_code=ST&f=json&limit=${LATEST_LIMIT}`;
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

  const notes = ["Live USGS service unavailable; latest values from the USGS Water Data API without percent of median or water temperature"];
  if (hasNextPage(latest.body)) {
    notes.push(`Showing only the first ${LATEST_LIMIT.toLocaleString("en-US")} gauges, not all of them; zoom in for the rest`);
  }
  return { kind: "geojson", data: toFeatures(readings, namesFrom(bodies)), citation, coverageNote: notes.join("; ") };
}

const streamflow = defineLayer({
  id: "streamflow",
  title: "Stream flow (USGS gauges, live)",
  description:
    "Live river and stream flow: how much water is running right now and whether that is high or low for the date. User words: CFS, flow, river level, running high, running low, blown out, water temperature. " +
    "In the United States each point is a USGS gauge with name, siteId, t (UTC time of the reading, usually 15 to 60 minutes old), v and kind 'gauge'. " +
    "parameter 00060 (default): v is discharge in cubic feet per second (cfs), the volume of water passing the gauge. parameter 00065: v is gage height in feet, the water level at the gauge; its zero point is arbitrary per gauge, so compare it only to the same gauge. " +
    "pctOfMedian is today's flow as a percent of the median flow for this calendar day over the gauge's record (medianCfs, in cfs), and vsNormal labels it: low (under 50%), normal (50 to 150%) or high (over 150%); use it to say a river is running high or low. It is given for the 30 largest-flow gauges in view only. " +
    "tempC is water temperature in °C where the gauge measures it (useful for fishing: trout get stressed above about 20 °C). " +
    "Outside the United States, points are modelled, not measured: kind 'model', one per major river, v is the GloFAS model's daily discharge converted to cfs (dischargeM3s is the original in m³/s), t is the day; treat it as a rough estimate, and a small river right beside a big one can show the big one's flow. " +
    "Example questions: 'What is the Truckee running at?', 'Which rivers near here are running high?', 'Is the water too warm to fish?'. " +
    "Caveats: US readings are provisional and can be revised; ice, debris or a dry channel can give 0 or odd values; gauges silent for 7 days are left out; " +
    "the percent of median compares one instantaneous reading to a daily median, so it swings with dam releases and daily snowmelt cycles. " +
    "Needs a region under 400,000 km² (about the size of California).",
  coverage: "global",
  license: "Public domain (USGS); outside the US GloFAS via Open-Meteo, CC BY 4.0, free for non-commercial use only",
  requiredEnv: [],
  optionalEnv: ["USGS_API_KEY", "OVERPASS_URL"],
  maxAreaKm2: 400_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("streamflow"), unit: "cfs" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    if (outsideUs(ctx.bbox)) return queryOutsideUs(ctx, now);

    const liveCitation: Citation = {
      source: "USGS NWIS instantaneous values and daily statistics (public domain; provisional data)",
      url: "https://waterservices.usgs.gov/",
      retrieved: now.toISOString(),
    };
    const iv = await fetchIv(ctx, [input.parameter, "00010"], "usgs-iv", LATEST_TTL_SECONDS);
    if (!iv.ok) {
      return queryWaterDataApi(ctx, input.parameter, now, {
        source: "USGS Water Data API, latest continuous values (public domain; provisional data)",
        url: "https://api.waterdata.usgs.gov/",
        retrieved: now.toISOString(),
      });
    }
    const sites = parseIv(iv.bodies, now);
    if (sites.length === 0) {
      return { kind: "geojson", data: EMPTY, citation: liveCitation, coverageNote: "No active USGS stream gauges in this area" };
    }

    const statFor = input.parameter === "00060" ? statSites(sites) : [];
    const medians = statFor.length > 0 ? await fetchMedians(ctx, statFor) : new Map<string, Map<string, number>>();
    const data = ivFeatures(sites, input.parameter, medians);
    const withFlow = sites.filter((s) => s.readings[input.parameter] !== undefined).length;
    const notes: string[] = [];
    if (input.parameter === "00060" && withFlow > STAT_SITE_CAP) {
      notes.push(`Percent of median is given for the ${STAT_SITE_CAP} largest-flow gauges of ${withFlow}; zoom in for the rest`);
    }
    return { kind: "geojson", data, citation: liveCitation, ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}) };
  },
});

registerLayer(streamflow);

export default streamflow;

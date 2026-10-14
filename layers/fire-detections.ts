/**
 * Active fire detections from NASA FIRMS (Fire Information for Resource Management System).
 * Endpoint: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{source}/{west},{south},{east},{north}/{days}
 * Response: CSV with a header line; columns used here are latitude, longitude, acq_date
 * (YYYY-MM-DD), acq_time (UTC HHMM with leading zeros dropped, e.g. "342"), frp (megawatts),
 * confidence ("l"/"n"/"h" for VIIRS, 0-100 for MODIS) and daynight ("D"/"N"). FIRMS data has
 * no quoted fields. A bad key or bad parameters returns a plain-text body such as
 * "Invalid MAP_KEY." (HTTP 400 observed).
 * Wide mode (over 2,000,000 km², up to the default hard cap of 8,000,000 km²): FIRMS has no order or limit parameter, so the
 * whole CSV for the box and days is read (bounded by the 5-day maximum) and the 5,000 newest detections are kept, with the
 * row count as the total. Smoke wide 2026-10-14 (through runLayer): central Africa 10,-15,40,5 (about 7,400,000 km²), 5 days, VIIRS SNPP,
 * returned the 5,000 newest of 29,154 in 1.5 s (823 KB); the western US -125,25,-95,50, 3 days, all 452 in 3.0 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"] as const;

const inputSchema = z.object({
  days: z.number().int().min(1).max(5).default(3),
  source: z.enum(SOURCES).default("VIIRS_SNPP_NRT"),
});

/** Most points returned; keeps the strongest so a 5-day, country-sized request stays drawable. */
const MAX_POINTS = 5_000;
/** Most points a wide result (over 2,000,000 km²) carries, the newest. */
const WIDE_LIMIT = 5_000;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** `"342"` becomes `"03:42:00Z"`; returns null when the value is not a clock time. */
function clockTime(acqTime: string): string | null {
  const padded = acqTime.padStart(4, "0");
  if (!/^\d{4}$/.test(padded)) return null;
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2));
  if (hours > 23 || minutes > 59) return null;
  return `${padded.slice(0, 2)}:${padded.slice(2)}:00Z`;
}

function numeric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parses a FIRMS area CSV into point features, skipping rows without a usable position or time (`t`). */
export function parseFirmsCsv(text: string): FeatureCollection {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return { type: "FeatureCollection", features: [] };

  const header = lines[0].split(",").map((name) => name.trim());
  const col = (name: string) => header.indexOf(name);
  const iLat = col("latitude");
  const iLon = col("longitude");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const iFrp = col("frp");
  const iConf = col("confidence");
  const iDay = col("daynight");
  if (iLat === -1 || iLon === -1) return { type: "FeatureCollection", features: [] };

  const features: Feature<Point>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const lat = numeric(cells[iLat]);
    const lon = numeric(cells[iLon]);
    if (lat === null || lon === null) continue;

    const properties: Record<string, string | number> = {};
    const date = iDate === -1 ? undefined : cells[iDate]?.trim();
    const time = iTime === -1 ? null : clockTime(cells[iTime]?.trim() ?? "");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || time === null) continue;
    properties.t = `${date}T${time}`;

    const frp = iFrp === -1 ? null : numeric(cells[iFrp]);
    if (frp !== null) properties.v = frp;

    const rawConf = iConf === -1 ? undefined : cells[iConf]?.trim();
    if (rawConf) properties.confidence = numeric(rawConf) ?? rawConf;
    const daynight = iDay === -1 ? undefined : cells[iDay]?.trim();
    if (daynight) properties.daynight = daynight;

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties });
  }
  return { type: "FeatureCollection", features };
}

/** A FIRMS body worth caching: empty (no fires) or a CSV whose header names latitude; never an "Invalid ..." message. */
export function firmsBodyCacheable(body: string): boolean {
  const text = body.trimStart();
  if (text === "") return true;
  return !text.startsWith("Invalid") && text.split(/\r?\n/)[0].includes("latitude");
}

function frpOf(feature: Feature): number {
  const v: unknown = feature.properties?.v;
  return typeof v === "number" ? v : -Infinity;
}

/** Detection time in ms (`t` is always set by parseFirmsCsv). */
function timeOf(feature: Feature): number {
  const t: unknown = feature.properties?.t;
  return typeof t === "string" ? Date.parse(t) : -Infinity;
}

const fireDetections = defineLayer({
  id: "fire-detections",
  title: "Active fire detections",
  description:
    "Satellite hotspots from NASA FIRMS: each point is a spot a satellite saw burning (or very hot) in the last 1 to 5 days (default 3; NASA allows no more than 5). " +
    "Each point has t (UTC time of the satellite pass), v (fire radiative power in megawatts, a measure of how intensely it burns), confidence and daynight (D day pass, N night pass). " +
    "Confidence is l, n or h (low, nominal, high) for VIIRS and a 0 to 100 number for MODIS. " +
    "Use it to show where fire is burning right now or recently, anywhere in the world. " +
    "Caveats: detections are heat points, not fire outlines (use fire-perimeters for the burned area); one fire often produces many points; " +
    "VIIRS sources are about 375 m resolution and MODIS about 1 km; data arrives roughly 3 hours after the pass; " +
    "industrial flares, gas wells and volcanoes also show up. " +
    "Pick VIIRS_SNPP_NRT (default), VIIRS_NOAA20_NRT or MODIS_NRT with source. At most the 5,000 strongest (by v) are returned. " +
    "Over 2,000,000 km² (about the size of Mexico) it returns the 5,000 newest.",
  coverage: "global",
  license: "NASA FIRMS (public, attribution requested)",
  requiredEnv: ["FIRMS_MAP_KEY"],
  maxAreaKm2: 2_000_000,
  wide: { orderBy: "detection time", rank: "newest", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("fire-detections"), unit: "MW" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const key = ctx.env.FIRMS_MAP_KEY;
    if (!key) {
      return { error: "Layer fire-detections needs FIRMS_MAP_KEY", hint: "unavailable" };
    }

    const [west, south, east, north] = ctx.bbox;
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${input.source}/` +
      `${west},${south},${east},${north}/${input.days}`;

    let status: number;
    let ok: boolean;
    let body: string;
    try {
      const res = await ctx.fetch(url, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:firms`,
        // FIRMS answers a bad key with a 200 "Invalid MAP_KEY." text; only cache a real CSV (or an empty one).
        shouldCache: firmsBodyCacheable,
        // Hotspots are near-real-time; the default 24 hour cache would show stale fires.
        ttlSeconds: 1800,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      status = res.status;
      ok = res.ok;
      body = await res.text();
    } catch (err) {
      const timedOut =
        typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut
          ? `FIRMS timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "FIRMS returned no response",
        hint: "upstream",
      };
    }

    // FIRMS reports bad keys and parameters as a plain-text body ("Invalid MAP_KEY."), sometimes with a 4xx.
    if (body.trimStart().startsWith("Invalid")) {
      const firstLine = body.trimStart().split(/\r?\n/)[0].slice(0, 200);
      return { error: `FIRMS rejected the request: ${firstLine}`, hint: "upstream" };
    }
    if (!ok) return { error: `FIRMS returned ${status}`, hint: "upstream" };

    // Anything that is not a CSV (an HTML error page, say) must not be shown as "no fires".
    const firstLine = body.trimStart().split(/\r?\n/)[0];
    if (body.trim() !== "" && !firstLine.includes("latitude")) {
      return { error: `FIRMS returned an unexpected response: ${firstLine.slice(0, 80)}`, hint: "upstream" };
    }

    const parsed = body.trim() === "" ? EMPTY : parseFirmsCsv(body);

    // Wide: the newest detections up to the strategy's limit, with the full count; run.ts writes the note.
    if (ctx.wide) {
      const limit = Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT);
      const cut = parsed.features.length > limit;
      return {
        kind: "geojson",
        data: cut
          ? { type: "FeatureCollection", features: [...parsed.features].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, limit) }
          : parsed,
        ...(cut && { total: parsed.features.length }),
        citation: {
          source: `NASA FIRMS ${input.source} (public, attribution requested)`,
          url: "https://firms.modaps.eosdis.nasa.gov/",
          retrieved: new Date().toISOString(),
        },
      };
    }

    const capped = parsed.features.length > MAX_POINTS;
    const data: FeatureCollection = capped
      ? {
          type: "FeatureCollection",
          features: [...parsed.features]
            .sort((a, b) => frpOf(b) - frpOf(a))
            .slice(0, MAX_POINTS),
        }
      : parsed;

    return {
      kind: "geojson",
      data,
      ...(capped ? { coverageNote: `Showing the ${MAX_POINTS.toLocaleString("en-US")} strongest detections` } : {}),
      citation: {
        source: `NASA FIRMS ${input.source} (public, attribution requested)`,
        url: "https://firms.modaps.eosdis.nasa.gov/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(fireDetections);

export default fireDetections;

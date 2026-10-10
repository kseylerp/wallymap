/**
 * Recent earthquakes from the USGS Earthquake Catalog (ComCat), keyless.
 *   https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlongitude=&minlatitude=&maxlongitude=&maxlatitude=
 *     &starttime=YYYY-MM-DD&minmagnitude=2.5&orderby=magnitude&limit=5000
 * Response: GeoJSON FeatureCollection. Each feature is a Point [lon, lat, depth km] with properties
 *   mag, place ("10 km WSW of South Lake Tahoe, CA"), time (ms since epoch, UTC), url (event page), felt (reports, nullable),
 *   tsunami (0 or 1), magType, type ("earthquake", "quarry blast", "explosion", ...).
 * Smoke check 2026-10-09 (live, keyless, through runLayer): 1 degree Lake Tahoe box (-120.5,38.5,-119.5,39.5), days 365, M2.5+,
 *   returned 10 events in 4.8 s, newest the M3.27 of 2026-10-02 near South Lake Tahoe at 10.9 km depth;
 *   the California-sized box (-125,32,-114,42) counted 1,352 events at M2.5+ for the year (fdsnws `count`).
 * The service answers HTTP 400 when a request would match more than 20,000 events and sends no `limit`; this layer always
 * sends limit=5000 and orders by magnitude, so a capped result keeps the biggest events and says so in coverageNote.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const LIMIT = 5_000;
/** New events arrive within minutes of a quake, so recent results go stale quickly. */
const TTL_SECONDS = 900;
const DAY_MS = 86_400_000;

const inputSchema = z.object({
  days: z.number().int().min(1).max(3650).default(365),
  minMagnitude: z.number().min(-1).max(9).default(2.5),
});

/** USGS query URL; time window starts `days` back from `now` (date only, UTC). */
export function earthquakesUrl(bbox: BBox, days: number, minMagnitude: number, now: number = Date.now()): string {
  const [west, south, east, north] = bbox;
  const start = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return (
    `${ENDPOINT}?format=geojson&minlongitude=${west}&minlatitude=${south}&maxlongitude=${east}&maxlatitude=${north}` +
    `&starttime=${start}&minmagnitude=${minMagnitude}&orderby=magnitude&limit=${LIMIT}`
  );
}

const eventSchema = z.object({
  geometry: z
    .object({ type: z.literal("Point"), coordinates: z.array(z.number()).min(2) })
    .nullable(),
  properties: z.object({
    mag: z.number().nullable(),
    place: z.string().nullable().optional(),
    time: z.number().nullable().optional(),
    url: z.string().nullable().optional(),
    felt: z.number().nullable().optional(),
    tsunami: z.number().nullable().optional(),
    magType: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
  }),
});

const responseSchema = z.object({ features: z.array(z.unknown()) });

/** Points with `t` (event time), `v` (magnitude), depthKm and place; events without a magnitude or position are dropped. */
export function normalizeEarthquakes(raw: unknown[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const item of raw) {
    const parsed = eventSchema.safeParse(item);
    if (!parsed.success || parsed.data.geometry === null || parsed.data.properties.mag === null) continue;
    const { coordinates } = parsed.data.geometry;
    const p = parsed.data.properties;
    const properties: Record<string, string | number> = { v: p.mag as number };
    if (p.place) properties.place = p.place;
    if (typeof p.time === "number") properties.t = new Date(p.time).toISOString();
    if (coordinates.length > 2) properties.depthKm = Math.round(coordinates[2] * 10) / 10;
    if (p.magType) properties.magType = p.magType;
    if (p.type) properties.kind = p.type;
    if (typeof p.felt === "number") properties.felt = p.felt;
    if (p.tsunami === 1) properties.tsunami = "possible";
    if (p.url) properties.url = p.url;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [coordinates[0], coordinates[1]] },
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

const earthquakes = defineLayer({
  id: "earthquakes",
  title: "Earthquakes",
  description:
    "Recent earthquakes from the USGS Earthquake Catalog, worldwide. Each point is one event with v (magnitude, the usual Richter-style number), " +
    "t (when it happened, UTC), depthKm (how deep below the surface, in kilometres), place (nearest town, for example '10 km WSW of South Lake Tahoe, CA'), " +
    "magType, kind (earthquake, or quarry blast, explosion and similar non-quake events), felt (how many people reported feeling it, when known) and url (the USGS event page). " +
    "Use it for 'recent earthquakes here', 'has it been shaking lately', 'biggest quake this year', 'how active is this fault', or to see quakes over time: the time scrubber moves through t. " +
    "Input days sets how far back to look (default 365, up to 3650) and minMagnitude the smallest quake to include (default 2.5; lower it to 1.0 to see small tremors, though coverage of tiny quakes is uneven). " +
    "Caveats: magnitude is on a logarithmic scale, so a 5 releases about 32 times the energy of a 4; quakes below about 2.5 are only recorded where seismometer networks are dense (California, Nevada, the Pacific Northwest, Alaska, Hawaii); " +
    "new events and revised magnitudes can change in the first hours; this shows what happened, not a forecast. " +
    "At most 5,000 events are returned, biggest first, and the result says when that cap is hit. " +
    "Zoom in to a region under 5,000,000 km² (about a 2,200 km square) first.",
  coverage: "global",
  license: "Public domain (USGS)",
  requiredEnv: [],
  maxAreaKm2: 5_000_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("earthquakes"), unit: "magnitude", extrude: "v", heat: true },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const url = earthquakesUrl(ctx.bbox, input.days, input.minMagnitude);
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        cacheKey: ctx.cacheKey,
        ttlSeconds: TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
      return {
        error: timedOut
          ? `USGS earthquake service timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "USGS earthquake service returned no response",
        hint: "upstream",
      };
    }
    if (!res.ok) return { error: `USGS earthquake service returned ${res.status}`, hint: "upstream" };

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { error: "USGS earthquake service returned a response that is not JSON", hint: "upstream" };
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) return { error: "USGS earthquake service returned an unexpected response", hint: "upstream" };

    const data = normalizeEarthquakes(parsed.data.features);
    const notes: string[] = [];
    if (parsed.data.features.length >= LIMIT) {
      notes.push(`Showing the ${LIMIT.toLocaleString("en-US")} largest events; zoom in or raise minMagnitude for the rest`);
    }
    if (data.features.length === 0) {
      notes.push(`No earthquakes of magnitude ${input.minMagnitude} or more in the last ${input.days} days in this area`);
    }

    return {
      kind: "geojson",
      data,
      citation: {
        source: "U.S. Geological Survey Earthquake Catalog (public domain)",
        url: "https://earthquake.usgs.gov/earthquakes/search/",
        retrieved: new Date().toISOString(),
      },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(earthquakes);

export default earthquakes;

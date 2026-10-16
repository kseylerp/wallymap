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
 * Wide mode (over 5,000,000 km², up to the default hard cap of 20,000,000 km²) sends limit=2000 with the same order and asks the
 * fdsnws `count` endpoint for the total. Smoke wide 2026-10-14 (through runLayer): Alaska and the Aleutians -170,45,-130,72, M2.5+ for
 * 365 days, returned the 2,000 strongest of 5,983 in 4.8 s (590 KB).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { QUAKE_MAGNITUDE, nameAttribute, timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const LIMIT = 5_000;
/** Most events a wide result (over 5,000,000 km²) carries, the strongest. */
const WIDE_LIMIT = 2_000;
/** New events arrive within minutes of a quake, so recent results go stale quickly. */
const TTL_SECONDS = 900;
const DAY_MS = 86_400_000;

const inputSchema = z.object({
  days: z.number().int().min(1).max(3650).default(365),
  minMagnitude: z.number().min(-1).max(9).default(2.5),
});

/** The shared query string: bbox, a date-only start `days` back from `now` (UTC) and the smallest magnitude. */
function searchParams(bbox: BBox, days: number, minMagnitude: number, now: number): string {
  const [west, south, east, north] = bbox;
  const start = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return (
    `format=geojson&minlongitude=${west}&minlatitude=${south}&maxlongitude=${east}&maxlatitude=${north}` +
    `&starttime=${start}&minmagnitude=${minMagnitude}`
  );
}

/** USGS query URL, strongest first, at most `limit` events. */
export function earthquakesUrl(bbox: BBox, days: number, minMagnitude: number, now: number = Date.now(), limit: number = LIMIT): string {
  return `${ENDPOINT}?${searchParams(bbox, days, minMagnitude, now)}&orderby=magnitude&limit=${limit}`;
}

/** USGS `count` URL for the same search (`{"count":1352,"maxAllowed":20000}`), for a wide result's total. */
export function earthquakesCountUrl(bbox: BBox, days: number, minMagnitude: number, now: number = Date.now()): string {
  return `${ENDPOINT.replace(/\/query$/, "/count")}?${searchParams(bbox, days, minMagnitude, now)}`;
}

/** The count from a `count` answer, or undefined on any failure. */
async function countEvents(ctx: QueryContext, url: string): Promise<number | undefined> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:count`,
      ttlSeconds: TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { count?: unknown };
    return typeof body.count === "number" && Number.isFinite(body.count) ? body.count : undefined;
  } catch {
    return undefined;
  }
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

const ATTRIBUTES: Attribute[] = [
  { key: "v", type: "measure", label: "Magnitude", unit: "M", encode: "size", presets: QUAKE_MAGNITUDE },
  { key: "depthKm", type: "measure", label: "Depth", unit: "km" },
  { key: "kind", type: "category", label: "Kind" },
  timeAttribute("When"),
  nameAttribute("Place", "place"),
];

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "The earthquake's magnitude as the USGS catalog reports it, measured from seismic waves by the method named in magType; the scale is " +
      "logarithmic, so each whole step is about 32 times more energy.",
    source: "USGS Earthquake Hazards Program, Magnitude Types",
    url: "https://www.usgs.gov/programs/earthquake-hazards/magnitude-types",
  },
  magType: {
    text:
      "How the magnitude was measured: for example ml (local, Richter's original method), md (duration of shaking, used for very small events), " +
      "mb (body waves) or mww and mw (moment magnitude, the USGS authoritative value when computed).",
    source: "USGS Earthquake Hazards Program, Magnitude Types",
    url: "https://www.usgs.gov/programs/earthquake-hazards/magnitude-types",
  },
  depthKm: { text: "How far below the surface the earthquake started (its hypocentre).", unit: "km" },
  felt: { text: "How many people reported feeling it to the USGS Did You Feel It? survey." },
  kind: { text: "The event type in the catalog: earthquake, or a non-quake event such as a quarry blast or explosion." },
  tsunami: { text: "'possible' when the USGS flagged the event for possible tsunami (it is not a tsunami warning)." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Magnitude" },
  facts: [
    { key: "t", label: "When", format: "date" },
    { key: "depthKm", label: "Depth", format: "km" },
    { key: "magType", label: "Magnitude type" },
    { key: "felt", label: "Felt reports", format: "int" },
    { key: "kind", label: "Event type" },
    { key: "tsunami", label: "Tsunami flag" },
  ],
  links: [{ key: "url", label: "USGS event page" }],
};

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
    "At most 5,000 events, biggest first. " +
    "Over 5,000,000 km² (about a 2,200 km square) it returns the 2,000 strongest.",
  coverage: "global",
  surface: "any",
  license: "Public domain (USGS)",
  requiredEnv: [],
  maxAreaKm2: 5_000_000,
  wide: { orderBy: "magnitude", rank: "strongest", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("earthquakes"), unit: "M", extrude: "v", heat: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    // Wide (over 5,000,000 km², up to the hard cap): the strongest events, capped at the strategy's limit, plus a count.
    const now = Date.now();
    const limit = ctx.wide ? Math.min(LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : LIMIT;
    const url = earthquakesUrl(ctx.bbox, input.days, input.minMagnitude, now, limit);
    const counting = ctx.wide ? countEvents(ctx, earthquakesCountUrl(ctx.bbox, input.days, input.minMagnitude, now)) : Promise.resolve(undefined);
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
    // In wide mode run.ts writes the "showing the N strongest" note.
    if (!ctx.wide && parsed.data.features.length >= LIMIT) {
      notes.push(`Showing the ${LIMIT.toLocaleString("en-US")} largest events; zoom in or raise minMagnitude for the rest`);
    }
    if (data.features.length === 0) {
      notes.push(`No earthquakes of magnitude ${input.minMagnitude} or more in the last ${input.days} days in this area`);
    }

    const total = await counting;
    return {
      kind: "geojson",
      data,
      ...(total !== undefined && { total }),
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

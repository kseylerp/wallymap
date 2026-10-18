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
 * All three VIIRS satellites (since 2026-10-18, the default source VIIRS_ALL): SNPP, NOAA-20 and NOAA-21 each pass about
 * twice a day, so one satellite alone can leave "right now" 12 hours old (audit 2026-10-17). The three CSVs are fetched in
 * parallel (one FIRMS call each, cached 30 minutes) and merged; each point keeps its `satellite`. When one satellite fails
 * the others still answer, with a note. Fire power is totalled per frame as the strongest pixel (`max`), not the sum: VIIRS
 * gives the same power to neighbouring pixels of one fire, and three satellites see the same fire, so a sum counted it
 * several times.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp, type QueryContext } from "./types";
import { timeAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";
import { zoneAt } from "@/lib/render/units";

const VIIRS = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"] as const;
const SOURCES = ["VIIRS_ALL", ...VIIRS, "MODIS_NRT"] as const;
type Source = (typeof SOURCES)[number];
type OneSource = Exclude<Source, "VIIRS_ALL">;

/** Plain names for the satellites, as the card shows them. */
export const SATELLITES: Record<OneSource, string> = {
  VIIRS_SNPP_NRT: "Suomi NPP (VIIRS)",
  VIIRS_NOAA20_NRT: "NOAA-20 (VIIRS)",
  VIIRS_NOAA21_NRT: "NOAA-21 (VIIRS)",
  MODIS_NRT: "Terra and Aqua (MODIS)",
};

/** The satellite as a ranked row names it: short, the instrument left to the card. */
const SATELLITE_SHORT: Record<OneSource, string> = {
  VIIRS_SNPP_NRT: "Suomi NPP",
  VIIRS_NOAA20_NRT: "NOAA-20",
  VIIRS_NOAA21_NRT: "NOAA-21",
  MODIS_NRT: "MODIS",
};

/**
 * The ranked list's name for a detection: the satellite and the pass in the place's local time, "NOAA-20, Oct 17
 * 2:42 AM PDT". Neighbouring pixels of one pass share it, so the list shows one fire per pass, not each pixel.
 */
export function detectionName(source: OneSource, t: unknown, [lon, lat]: [number, number]): string {
  const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
  if (Number.isNaN(ms)) return `Hotspot, ${SATELLITE_SHORT[source]}`;
  const when = new Date(ms).toLocaleString("en-US", { timeZone: zoneAt([lon, lat]), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${SATELLITE_SHORT[source]}, ${when.replace(",", "")}`;
}

const inputSchema = z.object({
  days: z.number().int().min(1).max(5).default(3),
  source: z.enum(SOURCES).default("VIIRS_ALL"),
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Hotspot, Oct 17 09:42 UTC" and "108 MW": the card's title and the map label for a detection. */
export function describeDetection(properties: Record<string, unknown>): { heading: string; label?: string } {
  const t = typeof properties.t === "string" ? properties.t : "";
  const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? `${MONTHS[Number(t.slice(5, 7)) - 1]} ${Number(t.slice(8, 10))} ${t.slice(11, 16)} UTC` : "";
  const frp = typeof properties.v === "number" ? properties.v : undefined;
  return {
    heading: `Hotspot${when ? `, ${when}` : ""}`,
    ...(frp !== undefined && { label: `${frp >= 10 ? Math.round(frp) : frp.toFixed(1)} MW` }),
  };
}

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
  // Brightness temperature: VIIRS calls it bright_ti4 (the I-4 band), MODIS brightness (band 21/22).
  const iBright = col("bright_ti4") !== -1 ? col("bright_ti4") : col("brightness");
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
    const bright = iBright === -1 ? null : numeric(cells[iBright]);
    if (bright !== null) properties.brightK = bright;

    const rawConf = iConf === -1 ? undefined : cells[iConf]?.trim();
    if (rawConf) properties.confidence = numeric(rawConf) ?? rawConf;
    const daynight = iDay === -1 ? undefined : cells[iDay]?.trim();
    if (daynight) properties.daynight = daynight;

    Object.assign(properties, describeDetection(properties));
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

type Fetched = { ok: true; fc: FeatureCollection } | { ok: false; error: string };

/** One satellite's FIRMS CSV for the view, parsed (each point marked with its satellite), or why it failed. */
async function fetchSource(ctx: QueryContext, key: string, source: OneSource, days: number, several: boolean): Promise<Fetched> {
  const [west, south, east, north] = ctx.bbox;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/${west},${south},${east},${north}/${days}`;
  let status: number;
  let ok: boolean;
  let body: string;
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:firms${several ? `:${source}` : ""}`,
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
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return { ok: false, error: timedOut ? `FIRMS timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "FIRMS returned no response" };
  }
  // FIRMS reports bad keys and parameters as a plain-text body ("Invalid MAP_KEY."), sometimes with a 4xx.
  if (body.trimStart().startsWith("Invalid")) {
    return { ok: false, error: `FIRMS rejected the request: ${body.trimStart().split(/\r?\n/)[0].slice(0, 200)}` };
  }
  if (!ok) return { ok: false, error: `FIRMS returned ${status}` };
  // Anything that is not a CSV (an HTML error page, say) must not be shown as "no fires".
  const firstLine = body.trimStart().split(/\r?\n/)[0];
  if (body.trim() !== "" && !firstLine.includes("latitude")) {
    return { ok: false, error: `FIRMS returned an unexpected response: ${firstLine.slice(0, 80)}` };
  }
  const fc = body.trim() === "" ? EMPTY : parseFirmsCsv(body);
  for (const f of fc.features) {
    if (!f.properties) continue;
    f.properties.satellite = source;
    f.properties.name = detectionName(source, f.properties.t, (f.geometry as Point).coordinates as [number, number]);
  }
  return { ok: true, fc };
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "confidence",
    type: "ordinal",
    label: "Confidence",
    scale: "VIIRS detection confidence (low, nominal, high); MODIS gives 0 to 100",
    levels: [
      { value: "l", label: "Low" },
      { value: "n", label: "Nominal" },
      { value: "h", label: "High" },
    ],
  },
  {
    key: "v",
    type: "measure",
    label: "Fire power",
    unit: "MW",
    encode: "size",
    aggregate: "max",
    aggregateLabel: "Strongest fire power seen",
    presets: [
      { label: "Strong: 50 MW or more", min: 50 },
      { label: "Very strong: 200 MW or more", min: 200 },
    ],
  },
  { key: "brightK", type: "measure", label: "Brightness", unit: "K" },
  {
    key: "daynight",
    type: "category",
    label: "Pass",
    levels: [
      { value: "D", label: "Day" },
      { value: "N", label: "Night" },
    ],
  },
  {
    key: "satellite",
    type: "category",
    label: "Satellite",
    levels: (Object.keys(SATELLITES) as OneSource[]).map((value) => ({ value, label: SATELLITES[value] })),
  },
  timeAttribute("Seen"),
];

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "Fire radiative power: the heat the fire gave off in the satellite pixel at the moment of the pass, in megawatts, " +
      "as NASA's fire product measures it; higher means burning more intensely.",
    unit: "MW",
    source: "NASA FIRMS",
    url: "https://www.earthdata.nasa.gov/data/tools/firms/faq",
  },
  confidence: {
    text:
      "How sure the fire algorithm is that the pixel is a fire. VIIRS: l (low, often sun glint or a weak heat signal), n (nominal, a strong " +
      "heat signal free of sun glint) or h (high, a saturated pixel). MODIS: a number from 0 (very low) to 100 (very high), which NASA calls " +
      "experimental.",
    scale: "VIIRS l, n, h; MODIS 0 to 100",
    source: "NASA FIRMS",
    url: "https://www.earthdata.nasa.gov/data/tools/firms/faq",
  },
  daynight: { text: "D when the satellite saw the fire on a daytime pass, N on a night pass." },
  brightK: {
    text:
      "Brightness temperature of the fire pixel in kelvin, as the satellite's heat band read it (VIIRS I-4, MODIS band 21/22); a hotter " +
      "pixel reads higher, and VIIRS saturates near 367 K.",
    unit: "K",
    source: "NASA FIRMS",
    url: "https://www.earthdata.nasa.gov/data/tools/firms/faq",
  },
  t: { text: "UTC time of the satellite pass that saw the hotspot." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Fire radiative power", unit: "MW" },
  facts: [
    { key: "t", label: "Seen", format: "date" },
    { key: "confidence", label: "Confidence", values: { l: "Low", n: "Nominal", h: "High" } },
    { key: "daynight", label: "Pass", values: { D: "Day", N: "Night" } },
    { key: "brightK", label: "Brightness temperature", unit: "K", format: "1dp" },
    { key: "satellite", label: "Satellite", values: SATELLITES },
  ],
  hidden: ["heading", "label"],
};

const fireDetections = defineLayer({
  id: "fire-detections",
  title: "Active fire detections",
  description:
    "Satellite hotspots from NASA FIRMS: each point is a spot a satellite saw burning (or very hot) in the last 1 to 5 days (default 3; NASA allows no more than 5). " +
    "Each point has t (UTC time of the satellite pass), v (fire radiative power in megawatts, a measure of how intensely it burns), brightK (the pixel's brightness temperature in kelvin), confidence and daynight (D day pass, N night pass); the map sizes each point by v and colors it by brightK. " +
    "Confidence is l, n or h (low, nominal, high) for VIIRS and a 0 to 100 number for MODIS. " +
    "Use it to show where fire is burning right now or recently, anywhere in the world. " +
    "Caveats: detections are heat points, not fire outlines (use fire-perimeters for the burned area); one fire often produces many points; " +
    "VIIRS sources are about 375 m resolution and MODIS about 1 km; data arrives roughly 3 hours after the pass; " +
    "industrial flares, gas wells and volcanoes also show up. " +
    "source VIIRS_ALL (default) merges the three VIIRS satellites (Suomi NPP, NOAA-20, NOAA-21), so the newest pass is a few hours old at most; each point keeps its satellite. Pick one with VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT or MODIS_NRT. " +
    "The same fire is often seen by several satellites and as several neighbouring pixels with the same power, so count fires by clusters, not points; the running total is the strongest fire power seen, not a sum. At most the 5,000 strongest (by v) are returned. " +
    "Over 2,000,000 km² (about the size of Mexico) it returns the 5,000 newest.",
  coverage: "global",
  surface: "land",
  license: "NASA FIRMS (public, attribution requested)",
  requiredEnv: ["FIRMS_MAP_KEY"],
  maxAreaKm2: 2_000_000,
  wide: { orderBy: "detection time", rank: "newest", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("fire-detections"), unit: "MW", encode: { size: "v", color: "brightK" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Detections arrive pass by pass over a few days: a scrubber by the hour, never a compare of two "days" (the last is partial).
  time: { shape: "continuous", step: "hour" },
  labels: { field: "label", max: 5, rankBy: "v" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const key = ctx.env.FIRMS_MAP_KEY;
    if (!key) {
      return { error: "Layer fire-detections needs FIRMS_MAP_KEY", hint: "unavailable" };
    }

    const sources: OneSource[] = input.source === "VIIRS_ALL" ? [...VIIRS] : [input.source];
    const got = await Promise.all(sources.map((source) => fetchSource(ctx, key, source, input.days, sources.length > 1)));
    const answered = got.filter((g): g is Extract<Fetched, { ok: true }> => g.ok);
    if (answered.length === 0) {
      const first = got[0] as Extract<Fetched, { ok: false }>;
      return { error: first.error, hint: "upstream" };
    }
    const parsed: FeatureCollection = { type: "FeatureCollection", features: answered.flatMap((g) => g.fc.features) };
    const failedNote =
      answered.length < got.length
        ? `${got
            .map((g, i) => (g.ok ? null : SATELLITES[sources[i]]))
            .filter((n) => n !== null)
            .join(" and ")} did not answer; showing the other satellites`
        : undefined;
    const sourceLabel = input.source === "VIIRS_ALL" ? "VIIRS (Suomi NPP, NOAA-20, NOAA-21)" : input.source;

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
        ...(failedNote && { coverageNote: failedNote }),
        citation: {
          source: `NASA FIRMS ${sourceLabel} (public, attribution requested)`,
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
      ...((capped || failedNote) && {
        coverageNote: [capped ? `Showing the ${MAX_POINTS.toLocaleString("en-US")} strongest detections` : null, failedNote ?? null].filter(Boolean).join("; "),
      }),
      citation: {
        source: `NASA FIRMS ${sourceLabel} (public, attribution requested)`,
        url: "https://firms.modaps.eosdis.nasa.gov/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(fireDetections);

export default fireDetections;

/**
 * Wildfire smoke plumes from the NOAA Hazard Mapping System (HMS), drawn by analysts from satellite images each day.
 * Source (verified 2026-10-09, no key): https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/
 *   - Folders Geotiff/, KML/, Shapefile/ and Annual_Bundles/. KML/YYYY/MM/hms_smokeYYYYMMDD.kml exists for every year from
 *     2005 (first file hms_smoke20050805.kml) to today (hms_smoke20261009.kml was listed on 2026-10-09). Days can be missing
 *     (2026-10-01 had no file), and a missing day is a 404.
 *   - One day is a single KML of about 440 KB: 330 Placemarks on 2026-10-08, each a plain <Polygon> (outerBoundaryIs only;
 *     innerBoundaryIs is handled anyway) whose description is HTML in a CDATA with "Start Time: 2026281 1200UTC" (year then
 *     day of year), "End Time", "Density: Light|Medium|Heavy" and "Satellite: GOES-EAST|GOES-WEST". Counts that day:
 *     206 Light, 99 Medium, 25 Heavy. Coordinates are "lon,lat,alt" triples.
 *   - The shapefile is not used: a few regexes parse the KML to GeoJSON in a serverless function with no dependency
 *     (layers/__fixtures__/smoke.hms.kml is three real Placemarks from that file).
 * Live check through runLayer (2026-10-09, lower 48 bbox, no date): 145 polygons (31 light, 73 medium, 41 heavy) in 0.4 s.
 * Extent: GOES East and West cover North and Central America and the Caribbean, roughly 180 W to 50 W, 5 N to 75 N.
 * The whole-day file is cached once per day (not per bbox); today's file for one hour because HMS adds passes during the day.
 *
 * Near-surface smoke forecast (source "forecast", since 2026-10-18): the NOAA National Digital Guidance Database smoke
 * forecast (HRRR-Smoke model, PM2.5 from fires near the ground in µg/m³), hourly for about two days, as Esri's Living Atlas
 * re-publishes it (keyless FeatureServer):
 *   https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/NDGD_SmokeForecast_v1/FeatureServer/0
 *   Fields referencedate (model run), todate (the hour), smoke_classdesc ("0 - 3", "3 - 25", "25 - 63", "63 - 158",
 *   "158 - 1000" µg/m³). Verified live 2026-10-18 ~06:25 UTC: run 03:00 UTC, 52 hourly steps to 2026-10-20 06:00; the
 *   West Coast box [-125,32,-114,46] from 06:00 on held 450 polygons (404 in 3-25, 42 in 25-63, 4 in 63-158) in 200 KB.
 *   "0 - 3" (clean air) is left out so it does not blanket the map.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint } from "./_shared/coverage";
import { DAY_MS, dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
import { textBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML";
/** First day HMS holds a KML for. */
export const FIRST_DAY = "2005-08-05";
/** Rough extent of the GOES East and West smoke mapping. */
export const SMOKE_EXTENT: BBox = [-180, 5, -50, 75];
/** Most features returned; keeps the heaviest smoke first. */
const MAX_FEATURES = 3_000;
const TODAY_TTL_SECONDS = 3_600;

const inputSchema = z.object({
  /** observed: the analysts' plumes overhead (HMS, past days); forecast: modelled smoke near the ground, the next two days by hour. */
  source: z.enum(["observed", "forecast"]).default("observed"),
  date: dateInput,
  days: z.number().int().min(1).max(7).default(1),
});

export const FORECAST_URL = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/NDGD_SmokeForecast_v1/FeatureServer/0";

/**
 * The forecast's PM2.5 classes on the same four-step scale as the analysts' density, so one key and one ramp read both:
 * 3-25 µg/m³ light, 25-63 medium, 63-158 heavy, 158 and over very heavy (forecast only).
 */
export const FORECAST_CLASSES: Record<string, { density: string; pm25: string }> = {
  "3 - 25": { density: "Light", pm25: "3–25 µg/m³" },
  "25 - 63": { density: "Medium", pm25: "25–63 µg/m³" },
  "63 - 158": { density: "Heavy", pm25: "63–158 µg/m³" },
  "158 - 1000": { density: "Very heavy", pm25: "158 µg/m³ or more" },
};

const DENSITY: Record<string, number> = { light: 1, medium: 2, heavy: 3, "very heavy": 4 };

/** "12:00" from an ISO time (UTC). */
const hhmm = (iso: string) => iso.slice(11, 16);

/** A daily HMS file is a KML document; a day with no smoke still has the <kml> root, just no placemarks. */
export const HMS_KML_BODY = textBody({ markers: [/<kml[\s>]/] });

export function kmlUrl(day: string): string {
  return `${BASE}/${day.slice(0, 4)}/${day.slice(5, 7)}/hms_smoke${day.replaceAll("-", "")}.kml`;
}

/** "2026281 1200UTC" (year, day of year, hour and minute) to an ISO string, or null. */
function hmsTime(value: string | undefined): string | null {
  const m = value?.match(/^(\d{4})(\d{3}) (\d{2})(\d{2})UTC$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), 0, Number(m[2]), Number(m[3]), Number(m[4]));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ring(coordinates: string): Position[] | null {
  const ring: Position[] = [];
  for (const triple of coordinates.trim().split(/\s+/)) {
    const [lon, lat] = triple.split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    ring.push([lon, lat]);
  }
  if (ring.length < 3) return null;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : null;
}

function polygonRings(polygonXml: string): Position[][] | null {
  const outer = polygonXml.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
  const outerRing = outer ? ring(outer[1]) : null;
  if (!outerRing) return null;
  const rings = [outerRing];
  for (const inner of polygonXml.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) {
    const hole = ring(inner[1]);
    if (hole) rings.push(hole);
  }
  return rings;
}

function ringsBBox(rings: Position[][]): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of rings[0]) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/**
 * Parses one HMS smoke KML into polygon features with `t` (the map day, midnight UTC), `v` (1 light, 2 medium,
 * 3 heavy), `density`, `satellite`, `start` and `end` (ISO). Placemarks with no usable polygon are dropped, and when
 * `within` is given so are polygons that do not touch it.
 */
export function parseHmsKml(kml: string, day: string, within?: BBox): Feature<Polygon | MultiPolygon>[] {
  const features: Feature<Polygon | MultiPolygon>[] = [];
  for (const [placemark] of kml.matchAll(/<Placemark>[\s\S]*?<\/Placemark>/g)) {
    const polygons: Position[][][] = [];
    for (const [polygonXml] of placemark.matchAll(/<Polygon>[\s\S]*?<\/Polygon>/g)) {
      const rings = polygonRings(polygonXml);
      if (!rings) continue;
      if (within && bboxesDisjoint(ringsBBox(rings), within)) continue;
      polygons.push(rings);
    }
    if (polygons.length === 0) continue;

    const text = placemark.replace(/<br\s*\/?>/gi, "\n");
    const field = (label: string): string | undefined => text.match(new RegExp(`${label}:\\s*([^\\n<\\]]+)`))?.[1].trim();
    const density = field("Density");
    const v = density === undefined ? undefined : DENSITY[density.toLowerCase()];
    const start = hmsTime(field("Start Time"));
    const end = hmsTime(field("End Time"));
    const satellite = field("Satellite");
    const seen = start !== null && end !== null ? `${hhmm(start)}–${hhmm(end)} UTC` : undefined;
    const heading = density !== undefined ? `${density} smoke overhead${seen ? `, seen ${seen}` : ""}` : undefined;

    features.push({
      type: "Feature",
      geometry: polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons },
      properties: {
        // The pass start (hours UTC) when given, so the scrubber steps through the day's passes; else the map day.
        t: start !== null && start.slice(0, 10) === day ? start : `${day}T00:00:00.000Z`,
        ...(v !== undefined && { v }),
        ...(density !== undefined && { density }),
        ...(satellite !== undefined && { satellite }),
        ...(start !== null && { start }),
        ...(end !== null && { end }),
        ...(seen !== undefined && { seen: `${day}, ${seen}` }),
        ...(heading !== undefined && { heading }),
      },
    });
  }
  return features;
}

/**
 * Forecast polygons from the NDGD feed's GeoJSON: clean air ("0 - 3") dropped; `t` the forecast hour (the scrubber steps
 * hours), `density` and `v` on the shared scale, `pm25` the class in words, `run` the model run, and a heading.
 */
export function forecastFeatures(fc: FeatureCollection): Feature<Polygon | MultiPolygon>[] {
  const out: Feature<Polygon | MultiPolygon>[] = [];
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const cls = FORECAST_CLASSES[String(p.smoke_classdesc ?? "").trim()];
    if (!cls || typeof p.todate !== "number" || !f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
    // The feed stamps hours a second past (06:00:01); the hour is what it means.
    const t = new Date(Math.floor(p.todate / 3_600_000) * 3_600_000).toISOString();
    out.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        t,
        kind: "forecast",
        density: cls.density,
        v: DENSITY[cls.density.toLowerCase()],
        pm25: cls.pm25,
        ...(typeof p.referencedate === "number" && { run: new Date(p.referencedate).toISOString() }),
        heading: `${cls.density} smoke near the ground (${cls.pm25}), forecast for ${t.slice(0, 10)} ${hhmm(t)} UTC`,
      },
    });
  }
  return out.sort((a, b) => String(a.properties?.t).localeCompare(String(b.properties?.t)));
}

/** The near-surface forecast for the view from the current hour on. */
async function forecast(ctx: QueryContext, now: number): Promise<LayerResult | LayerError> {
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const offset = Math.min(0.05, Math.max(0.002, Number(((ctx.bbox[2] - ctx.bbox[0]) / 600).toPrecision(2))));
  const r = await arcgisQuery(ctx, FORECAST_URL, {
    where: `smoke_classdesc <> '0 - 3' AND todate >= TIMESTAMP '${hour}'`,
    outFields: ["referencedate", "todate", "smoke_classdesc"],
    bbox: ctx.bbox,
    maxAllowableOffset: offset,
    orderByFields: "todate",
    maxRecords: 2000,
    cacheSuffix: `ndgd:${hour}:${offset}`,
    ttlSeconds: TODAY_TTL_SECONDS,
  });
  const citation = {
    source: "NOAA National Digital Guidance Database smoke forecast (HRRR-Smoke, near-surface PM2.5 from fires), via Esri Living Atlas",
    url: "https://www.weather.gov/mdl/ndgd_home",
    retrieved: new Date(now).toISOString(),
  };
  if (!r.ok) return { error: `The NOAA smoke forecast is unavailable right now (${r.error})`, hint: "upstream" };
  const features = forecastFeatures(r.fc);
  const hours = [...new Set(features.map((f) => String(f.properties?.t)))];
  const notes = [
    features.length === 0
      ? "No smoke forecast near the ground in this view for the next two days"
      : `Smoke near the ground forecast hourly from ${hours[0].slice(0, 16).replace("T", " ")} to ${hours[hours.length - 1].slice(0, 16).replace("T", " ")} UTC`,
  ];
  if (r.truncated) notes.push("the forecast was cut at 2,000 shapes; zoom in for every hour");
  return { kind: "geojson", data: { type: "FeatureCollection", features }, citation, coverageNote: notes.join("; ") };
}

type DayResult = { day: string; features: Feature<Polygon | MultiPolygon>[] } | { day: string; missing: true } | { day: string; error: string };

const DENSITY_HELP: FieldHelp = {
  text:
    "How much smoke there is. Observed: how thick the smoke is overhead, as NOAA analysts class it from the satellite images, Light, Medium or Heavy; it is the " +
    "whole column of air, not the air you breathe at the ground. Forecast: fine smoke particles (PM2.5) near the ground from the NOAA smoke model, Light 3–25, " +
    "Medium 25–63, Heavy 63–158 and Very heavy 158 µg/m³ or more.",
  scale: "Light (1), Medium (2), Heavy (3), Very heavy (4, forecast only)",
  source: "NOAA NESDIS Hazard Mapping System",
  url: "https://www.ospo.noaa.gov/products/land/hms.html",
};

const HELP: Record<string, FieldHelp> = {
  density: DENSITY_HELP,
  v: DENSITY_HELP,
  satellite: { text: "The GOES weather satellite whose images the analyst drew the plume from (GOES East or GOES West)." },
  pm25: {
    text: "Fine particles from wildfire smoke near the ground (PM2.5) the NOAA smoke model forecasts for that hour; above about 35 µg/m³ the air is unhealthy for sensitive groups.",
    unit: "µg/m³",
    source: "NOAA National Digital Guidance Database",
    url: "https://www.weather.gov/mdl/ndgd_home",
  },
};

/** Density is the one ordinal both sources share: the chips, the map's color (light sage to very heavy purple) and the key. */
export const ATTRIBUTES: Attribute[] = [
  {
    key: "density",
    type: "ordinal",
    label: "Smoke",
    scale: "NOAA HMS density (Light, Medium, Heavy) and NDGD near-surface PM2.5 classes (3-25, 25-63, 63-158, 158+ µg/m³)",
    encode: "color",
    primary: true,
    levels: [
      { value: "Light", label: "Light", help: "Thin smoke overhead; or 3–25 µg/m³ near the ground (forecast)." },
      { value: "Medium", label: "Medium", help: "Hazy sky; or 25–63 µg/m³ near the ground, unhealthy for sensitive groups (forecast)." },
      { value: "Heavy", label: "Heavy", help: "Thick smoke; or 63–158 µg/m³ near the ground, unhealthy (forecast)." },
      { value: "Very heavy", label: "Very heavy", help: "158 µg/m³ or more near the ground, very unhealthy (forecast only)." },
    ],
  },
];

/** The density class in words is the measure; v (its number, 1 to 3) is what the map shades by. */
const CARD: CardSpec = {
  measure: { key: "density", label: "Smoke" },
  facts: [
    { key: "pm25", label: "Near-ground smoke (PM2.5)" },
    { key: "seen", label: "Seen (UTC)" },
    { key: "satellite", label: "Satellite", values: { "GOES-EAST": "GOES East", "GOES-WEST": "GOES West" } },
    { key: "run", label: "Forecast made", format: "date" },
  ],
  hidden: ["heading", "kind", "v", "start", "end"],
};

const smoke = defineLayer({
  id: "smoke",
  title: "Wildfire smoke",
  description:
    "A daily set of outlines of wildfire smoke plumes over North and Central America from the NOAA Hazard Mapping System, which analysts draw from GOES weather-satellite images. " +
    "Each polygon has a density class in v and density: 1 light, 2 medium, 3 heavy (thickest smoke), plus the satellite and the time span it was seen (seen, in UTC); t is when the satellite pass began (UTC), so the time scrubber steps through the passes and compare works across days. The map colors polygons by density (light sage to heavy purple). " +
    "source forecast instead returns the NOAA smoke model's forecast of smoke near the ground (fine particles, PM2.5, in µg/m³) for every hour of the next two days over the US, on the same scale: light 3–25, medium 25–63, heavy 63–158, very heavy 158 or more (pm25 holds the range); t is the hour, so the scrubber plays the forecast. Use it for 'will it be smoky tomorrow', 'can I run outside', 'smoke forecast'. " +
    "date (YYYY-MM-DD, from August 2005 on) is the last day shown and defaults to today (or the newest day that has a map); days (1 to 7, default 1) loads that many days ending on it, so use days up to 7 for a week of smoke. " +
    "Use it for 'smoke', 'wildfire smoke', 'is smoke coming my way', 'where is the smoke from the fire', 'smoky skies', 'air quality from fires' (it shows where smoke is overhead, not the air quality at ground level). " +
    "Example questions: is there smoke over Montana today, how heavy was the smoke over the Bay Area last week, did smoke from the Canadian fires reach the Northeast. " +
    "It is a feature layer, so you can count and list the polygons and read their densities. " +
    "Caveats: the outlines are hand-drawn from satellites, so they are daytime-only, cannot see through thick cloud, and are coarse; thickness is overhead smoke (the whole column), not what you breathe; several passes a day are drawn separately, so polygons overlap and the same plume repeats; smoke outside the Americas is not mapped; a few days have no map. " +
    "For air quality at the ground check an air-quality source; for the fires themselves use fire-detections. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "Empty results carry a coverageNote saying why (no smoke mapped, a day with no map, or outside the Americas).",
  coverage: { bbox: SMOKE_EXTENT },
  surface: "any",
  license: "NOAA / NESDIS OSPO Hazard Mapping System (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("smoke"), unit: "class", fillOpacity: 0.35, encode: { color: "density" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Passes (observed) and model hours (forecast) are both timed to the hour; HMS days and times are UTC.
  time: { shape: "continuous", step: "hour" },
  labels: { field: "density", max: 3, rankBy: "v" },
  display: { timeZone: "utc" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const citation = {
      source: "NOAA NESDIS OSPO Hazard Mapping System smoke analysis",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      retrieved: new Date(now).toISOString(),
    };
    const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
    if (input.source === "forecast") {
      if (bboxesDisjoint(ctx.bbox, SMOKE_EXTENT)) return { kind: "geojson", data: empty, citation, coverageNote: "The NOAA smoke forecast covers the United States only" };
      return forecast(ctx, now);
    }

    const choice = resolveTileDate(input.date, { from: FIRST_DAY, latestOffsetDays: 0, label: "smoke maps" }, now);
    if (!choice.ok) return { error: choice.error };
    if (bboxesDisjoint(ctx.bbox, SMOKE_EXTENT)) {
      return { kind: "geojson", data: empty, citation, coverageNote: "HMS smoke is mapped for North and Central America only" };
    }

    // No date asked for: today's map may not be published yet, so look one day further back for the newest map.
    const wanted = input.days + (input.date === undefined ? 1 : 0);
    const endMs = Date.parse(`${choice.date}T00:00:00Z`);
    const days: string[] = [];
    for (let i = 0; i < wanted; i++) {
      const day = isoDay(endMs - i * DAY_MS);
      if (day >= FIRST_DAY) days.push(day);
    }
    const today = isoDay(now);

    const results = await Promise.all(
      days.map(async (day): Promise<DayResult> => {
        try {
          const res = await ctx.fetch(kmlUrl(day), {
            cacheKey: `hms-smoke:${day}`,
            ttlSeconds: day === today ? TODAY_TTL_SECONDS : undefined,
            // The day's file is shared by every view for a day; a maintenance page must not stand in for it.
            validate: HMS_KML_BODY,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (res.status === 404) return { day, missing: true };
          if (!res.ok) return { day, error: `HMS returned ${res.status}` };
          return { day, features: parseHmsKml(await res.text(), day, ctx.bbox) };
        } catch {
          return { day, error: "HMS did not answer" };
        }
      }),
    );

    const have = results.filter((r): r is Extract<DayResult, { features: unknown }> => "features" in r);
    const missing = results.filter((r) => "missing" in r).map((r) => r.day);
    const failed = results.filter((r): r is Extract<DayResult, { error: string }> => "error" in r);
    if (have.length === 0 && failed.length > 0) {
      return { error: `NOAA HMS smoke maps are unavailable right now (${failed[0].error})`, hint: "upstream" };
    }

    // Without a date, keep only the newest `days` maps that exist.
    const kept = input.date === undefined ? have.slice(0, input.days) : have;
    let features = kept.flatMap((r) => r.features);
    const notes: string[] = [];
    if (choice.note) notes.push(choice.note);
    if (kept.length > 0) {
      const shown = kept.map((r) => r.day).sort();
      notes.push(shown.length === 1 ? `Smoke for ${shown[0]}` : `Smoke for ${shown[0]} to ${shown[shown.length - 1]}`);
    }
    if (kept.length === 0 && missing.length > 0) {
      notes.push(`No HMS smoke map was published for ${missing.sort().join(", ")}`);
    } else if (input.date !== undefined && missing.length > 0) {
      notes.push(`no map published for ${missing.sort().join(", ")}`);
    }
    if (failed.length > 0) notes.push(`${failed.length} day(s) could not be loaded`);
    if (features.length === 0 && kept.length > 0) notes.push("no smoke mapped in this view");
    if (features.length > MAX_FEATURES) {
      const total = features.length;
      features = [...features].sort((a, b) => Number(b.properties?.v ?? 0) - Number(a.properties?.v ?? 0)).slice(0, MAX_FEATURES);
      notes.push(`showing the ${MAX_FEATURES} heaviest of ${total} smoke polygons; zoom in for the rest`);
    }
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(smoke);

export default smoke;

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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint } from "./_shared/coverage";
import { DAY_MS, dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
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
  date: dateInput,
  days: z.number().int().min(1).max(7).default(1),
});

const DENSITY: Record<string, number> = { light: 1, medium: 2, heavy: 3 };

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

    features.push({
      type: "Feature",
      geometry: polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons },
      properties: {
        t: `${day}T00:00:00.000Z`,
        ...(v !== undefined && { v }),
        ...(density !== undefined && { density }),
        ...(satellite !== undefined && { satellite }),
        ...(start !== null && { start }),
        ...(end !== null && { end }),
      },
    });
  }
  return features;
}

type DayResult = { day: string; features: Feature<Polygon | MultiPolygon>[] } | { day: string; missing: true } | { day: string; error: string };

const smoke = defineLayer({
  id: "smoke",
  title: "Wildfire smoke",
  description:
    "A daily set of outlines of wildfire smoke plumes over North and Central America from the NOAA Hazard Mapping System, which analysts draw from GOES weather-satellite images. " +
    "Each polygon has a density class in v and density: 1 light, 2 medium, 3 heavy (thickest smoke), plus the satellite and the time span it was seen; t is the map day, so the time scrubber and compare work across days. " +
    "date (YYYY-MM-DD, from August 2005 on) is the last day shown and defaults to today (or the newest day that has a map); days (1 to 7, default 1) loads that many days ending on it, so use days up to 7 for a week of smoke. " +
    "Use it for 'smoke', 'wildfire smoke', 'is smoke coming my way', 'where is the smoke from the fire', 'smoky skies', 'air quality from fires' (it shows where smoke is overhead, not the air quality at ground level). " +
    "Example questions: is there smoke over Montana today, how heavy was the smoke over the Bay Area last week, did smoke from the Canadian fires reach the Northeast. " +
    "It is a feature layer, so you can count and list the polygons and read their densities. " +
    "Caveats: the outlines are hand-drawn from satellites, so they are daytime-only, cannot see through thick cloud, and are coarse; thickness is overhead smoke (the whole column), not what you breathe; several passes a day are drawn separately, so polygons overlap and the same plume repeats; smoke outside the Americas is not mapped; a few days have no map. " +
    "For air quality at the ground check an air-quality source; for the fires themselves use fire-detections. " +
    "Empty results carry a coverageNote saying why (no smoke mapped, a day with no map, or outside the Americas).",
  coverage: { bbox: SMOKE_EXTENT },
  license: "NOAA / NESDIS OSPO Hazard Mapping System (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("smoke"), unit: "class", fillOpacity: 0.35 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const citation = {
      source: "NOAA NESDIS OSPO Hazard Mapping System smoke analysis",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      retrieved: new Date(now).toISOString(),
    };
    const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

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

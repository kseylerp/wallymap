/**
 * Methane plumes seen from aircraft and satellites by Carbon Mapper, plus the sources they cluster into, worldwide.
 *
 * Verified live 2026-10-10 (keyless; the API marks auth as optional):
 *   Plumes: https://api.carbonmapper.org/api/v1/catalog/plumes/annotated?bbox=W&bbox=S&bbox=E&bbox=N&plume_gas=CH4
 *     &status=published&sort=emissions_desc&datetime=FROM/TO&limit=200
 *     -> { bbox_count, total_count, limit, offset, items: [{ id, plume_id, gas, geometry_json: Point, scene_timestamp,
 *        platform, emission_auto (kg/h, null when not estimated), emission_uncertainty_auto, hide_emission, sector (IPCC
 *        code), plume_bounds, wind_speed_avg_auto, status, plume_png and other signed image URLs, ... }] }.
 *     bbox must be repeated (bbox=-104.5&bbox=31.5&...); a comma list answers 422. A Permian 1 degree box had 5,549 plumes
 *     in all; 200 items are about 0.8 MB (the signed image URLs are most of it) in under 1 s.
 *   Sources: https://api.carbonmapper.org/api/v1/catalog/sources.geojson?bbox=...&plume_gas=CH4&datetime=FROM/TO
 *     -> FeatureCollection of points: { sector, plume_count, emission_auto (mean kg/h), persistence (share of overpasses
 *        with a plume), timestamp_min, timestamp_max, source_name, observation_scenes_names, basin_name, country_iso }.
 *     Without `datetime` the first call over the Permian took 31 s for 5.3 MB (cached by the server after); with a two-year
 *     window it took 0.9 s, so the layer always sends one.
 * Results are cached for 6 hours. The image links are signed and expire, so they are not passed on.
 * Licence: Carbon Mapper data terms, non-commercial use with the attribution "Data by Carbon Mapper".
 *
 * Live smoke 2026-10-10, Bakersfield [-119.5,35,-118.5,36], two years: 204 plumes (200 kept), biggest 2,545 kg/h
 * (oil and gas, Planet Tanager, 2025-04-21); 102 sources, biggest 658 kg/h; sectors mostly oil and gas, then dairies.
 * Through runLayer: Permian [-104.3,31.6,-103.6,32.3] default two years, 429 features in 1.3 s (200 of 372 plumes plus 229
 * sources; top source 1,273 kg/h, 14 plumes, persistence 0.91); Bakersfield days=365, 25 features in 0.5 s, top a landfill
 * at 376 kg/h seen on every overflight.
 * Wide (over 500,000 km², up to 2,000,000): the 500 largest plumes (the API's sort and limit; 1,000 items are 4.2 MB) and the 500
 * largest sources (the sources call has no limit; 1,097 sources over Texas and New Mexico were 1.6 MB in 3.5 s), total = plumes
 * in the box plus sources. Smoke 2026-10-14, box -106,28,-94,37 (1,120,000 km²): 1,000 of 2,743 in 8.4 s cold, a Houston-area
 * landfill source at 3,849 kg/h first.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const API = "https://api.carbonmapper.org/api/v1/catalog";
const TTL_SECONDS = 6 * 3600;
const DAY_MS = 86_400_000;
export const MAX_PLUMES = 200;
export const MAX_SOURCES = 300;
/** Most points (plumes and sources together, half each) a wide view carries. */
const WIDE_LIMIT = 1_000;

/** IPCC sector codes Carbon Mapper uses, in plain words. */
export const SECTORS: Record<string, string> = {
  "1B2": "oil and gas",
  "1B1a": "coal mining",
  "6A": "landfill",
  "6B": "wastewater",
  "4B": "livestock (manure)",
  "1A1": "power plant",
  "1A2": "manufacturing",
  other: "other",
};

const inputSchema = z.object({
  days: z.number().int().min(30).max(3650).default(730),
});

const coordsSchema = z.tuple([z.number(), z.number()]).rest(z.number());
const plumeSchema = z.object({
  plume_id: z.string(),
  geometry_json: z.object({ type: z.literal("Point"), coordinates: coordsSchema }),
  scene_timestamp: z.string().nullish(),
  platform: z.string().nullish(),
  emission_auto: z.number().nullish(),
  emission_uncertainty_auto: z.number().nullish(),
  hide_emission: z.boolean().nullish(),
  sector: z.string().nullish(),
  wind_speed_avg_auto: z.number().nullish(),
});
const sourceSchema = z.object({
  geometry: z.object({ type: z.literal("Point"), coordinates: coordsSchema }),
  properties: z.object({
    sector: z.string().nullish(),
    plume_count: z.number().nullish(),
    emission_auto: z.number().nullish(),
    emission_uncertainty_auto: z.number().nullish(),
    persistence: z.number().nullish(),
    timestamp_min: z.string().nullish(),
    timestamp_max: z.string().nullish(),
    source_name: z.string().nullish(),
    basin_name: z.string().nullish(),
  }),
});

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const sectorName = (code: string | null | undefined) => (code ? (SECTORS[code] ?? "other") : "unknown");

function bboxParams([w, s, e, n]: BBox): string {
  return `bbox=${w}&bbox=${s}&bbox=${e}&bbox=${n}`;
}

/** `FROM/TO` for the last `days` days, whole UTC days. */
export function datetimeWindow(days: number, now: number): string {
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  return `${from}T00:00:00Z/${to}T23:59:59Z`;
}

/** The plumes request, largest first, at most `limit` (each item is about 4 KB, mostly signed image links). */
export function plumesUrl(bbox: BBox, days: number, now: number, limit = MAX_PLUMES): string {
  return (
    `${API}/plumes/annotated?${bboxParams(bbox)}&plume_gas=CH4&status=published&sort=emissions_desc` +
    `&datetime=${encodeURIComponent(datetimeWindow(days, now))}&limit=${limit}`
  );
}

export function sourcesUrl(bbox: BBox, days: number, now: number): string {
  return `${API}/sources.geojson?${bboxParams(bbox)}&plume_gas=CH4&datetime=${encodeURIComponent(datetimeWindow(days, now))}`;
}

/** One point per plume: kind "plume", t = observation time, v = emission rate kg/h when Carbon Mapper published one. */
export function plumeFeatures(items: unknown[]): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const raw of items) {
    const parsed = plumeSchema.safeParse(raw);
    if (!parsed.success) continue;
    const p = parsed.data;
    const props: Record<string, string | number> = { kind: "plume", plumeId: p.plume_id, sector: sectorName(p.sector) };
    if (p.scene_timestamp) props.t = new Date(p.scene_timestamp).toISOString();
    if (typeof p.emission_auto === "number" && p.hide_emission !== true) {
      props.v = round(p.emission_auto);
      if (typeof p.emission_uncertainty_auto === "number") props.uncertainty = round(p.emission_uncertainty_auto);
    }
    if (p.platform) props.platform = p.platform;
    if (typeof p.wind_speed_avg_auto === "number") props.windMs = round(p.wind_speed_avg_auto);
    const [lng, lat] = p.geometry_json.coordinates;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props });
  }
  return out;
}

/** One point per source (plumes clustered by place): kind "source", v = mean kg/h, t = last plume seen, persistence. */
export function sourceFeatures(features: unknown[]): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const raw of features) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success) continue;
    const p = parsed.data.properties;
    const props: Record<string, string | number> = { kind: "source", sector: sectorName(p.sector) };
    if (typeof p.emission_auto === "number") props.v = round(p.emission_auto);
    if (typeof p.emission_uncertainty_auto === "number") props.uncertainty = round(p.emission_uncertainty_auto);
    if (p.timestamp_max) props.t = `${p.timestamp_max.slice(0, 10)}T00:00:00.000Z`;
    if (p.timestamp_min) props.firstSeen = p.timestamp_min.slice(0, 10);
    if (typeof p.plume_count === "number") props.plumeCount = p.plume_count;
    if (typeof p.persistence === "number") props.persistence = round(p.persistence, 2);
    if (p.source_name) props.sourceName = p.source_name.split("?")[0];
    if (p.basin_name) props.basin = p.basin_name;
    const [lng, lat] = parsed.data.geometry.coordinates;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props });
  }
  return out.sort((a, b) => Number(b.properties?.v ?? -1) - Number(a.properties?.v ?? -1));
}

type Got = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

async function getJson(ctx: QueryContext, url: string, suffix: string, listKey: string): Promise<Got> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}`,
      ttlSeconds: TTL_SECONDS,
      validate: jsonObjectBody({ listKey, minLength: 0 }),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: `Carbon Mapper returned ${res.status}` };
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return { ok: false, error: timedOut ? `Carbon Mapper timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "Carbon Mapper returned no usable response" };
  }
}

const methanePlumes = defineLayer({
  id: "methane-plumes",
  title: "Methane plumes (Carbon Mapper)",
  description:
    "Methane leaks seen from aircraft and satellites by Carbon Mapper, as points of two kinds: 'plume' (one plume on one pass; v = its emission rate in kilograms of methane per hour, kg/h; t = when seen) and 'source' (a place where plumes recur; v = its average kg/h, t = last seen, persistence 0 to 1), only where Carbon Mapper has flown or imaged, mostly oil and gas fields, landfills, dairies and coal mines. " +
    "kind 'plume' is one plume seen on one pass, with t (observation time, UTC), v (emission rate in kilograms of methane per hour, kg/h, when estimated), uncertainty (plus or minus kg/h), sector, platform and windMs; " +
    "kind 'source' is a place where plumes keep appearing, with v (average kg/h of its plumes), t (last plume seen), firstSeen, plumeCount, persistence (0 to 1, the share of overflights that saw a plume; near 1 means it leaks most times it is checked), sector and basin. " +
    "sector is oil and gas, coal mining, landfill, wastewater, livestock (manure), power plant, manufacturing or other. days (30 to 3650, default 730) sets how far back to look. " +
    "For scale: 100 kg/h is a large leak; 1,000 kg/h or more is a super-emitter; one tonne of methane warms the climate about 80 times as much as a tonne of CO2 over 20 years. " +
    "Example questions: 'Where are the methane leaks in the Permian Basin?', 'Which landfills here emit methane?', 'Are there super-emitters near Bakersfield?'. User words: methane, emissions, methane leak, super-emitter. " +
    "Caveats: a missing plume means none was seen on the days observed, not that a site is clean; coverage is patchy and favours known oil and gas basins; rates are snapshots during an overpass and some are withheld. " +
    "At most 200 plumes (largest first) and 300 sources; over 500,000 km², the 500 largest of each and the total.",
  coverage: "global",
  license: "Carbon Mapper terms: non-commercial, attribution 'Data by Carbon Mapper'",
  requiredEnv: [],
  maxAreaKm2: 500_000,
  wide: { orderBy: "emission rate in kg/h", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("methane-plumes"), unit: "kg/h", heat: true },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    // Wide (over 500,000 km²): half the limit for the largest plumes (sorted by the API) and half for the largest sources
    // (the sources call has no limit, so they are sorted here); run.ts writes the note from the combined total.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const plumeCap = wideLimit === undefined ? MAX_PLUMES : Math.floor(wideLimit / 2);
    const sourceCap = wideLimit === undefined ? MAX_SOURCES : wideLimit - plumeCap;
    const [plumes, sources] = await Promise.all([
      getJson(ctx, plumesUrl(ctx.bbox, input.days, now, plumeCap), "plumes", "items"),
      getJson(ctx, sourcesUrl(ctx.bbox, input.days, now), "sources", "features"),
    ]);
    if (!plumes.ok && !sources.ok) return { error: plumes.error, hint: "upstream" };

    const plumeItems = plumes.ok && Array.isArray(plumes.body.items) ? plumes.body.items : [];
    const plumeCount = plumes.ok && typeof plumes.body.bbox_count === "number" ? plumes.body.bbox_count : plumeItems.length;
    const allSources = sourceFeatures(sources.ok && Array.isArray(sources.body.features) ? sources.body.features : []);
    const keptSources = allSources.slice(0, sourceCap);
    const features = [...keptSources, ...plumeFeatures(plumeItems)];
    const total = wideLimit !== undefined && plumes.ok && sources.ok ? plumeCount + allSources.length : undefined;

    const notes: string[] = ["kind 'plume' is one sighting (v = kg/h then); kind 'source' is a recurring site (v = average kg/h, persistence = share of passes with a plume)"];
    if (wideLimit === undefined && plumeCount > plumeItems.length) notes.push(`Showing the ${plumeItems.length} largest of ${plumeCount} plumes`);
    if (wideLimit === undefined && allSources.length > keptSources.length) notes.push(`Showing the ${MAX_SOURCES} largest of ${allSources.length} sources`);
    if (!plumes.ok) notes.push("Plumes could not be loaded; showing sources only");
    if (!sources.ok) notes.push("Sources could not be loaded; showing plumes only");
    if (features.length === 0) notes.push(`No methane plumes seen here in the last ${input.days} days (or not yet observed)`);

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      ...(total !== undefined && { total }),
      citation: {
        source: "Data by Carbon Mapper (non-commercial use with attribution)",
        url: "https://data.carbonmapper.org/",
        retrieved: new Date(now).toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(methanePlumes);

export default methanePlumes;

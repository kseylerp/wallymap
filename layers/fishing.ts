/**
 * Fishing: where to fish and launch, what has been caught or seen lately, and how warm the water is.
 * Four keyless sources, queried in parallel; any one may fail without sinking the others:
 *   - OpenStreetMap via Overpass (`out center tags`): `leisure=fishing` (kind access), `leisure=slipway`
 *     (boat ramps, kind ramp) and `man_made=pier` tagged `fishing=yes|designated` (kind pier). Nodes carry
 *     lat/lon, ways and relations a `center`. Tags read: name, access, fee, fishing, boat, operator.
 *   - USFS recreation areas that list a fishing activity: EDW_RecreationAreaActivities_01/MapServer/0
 *     (https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0), checked
 *     2026-10-10: point layer with recareaname, recareaid, recareaurl, forestname, activityname
 *     ("Lake and Pond Fishing", "River and Stream Fishing", ...), parentactivityname ("Fishing"), openstatus.
 *     One row per area x activity, so rows are grouped by recareaid (kind access, source USFS). US only.
 *     No BLM service exposing a fishing activity was found keylessly (BLM recreation sites live in RIDB, which
 *     needs a key), so BLM fishing sites are not included.
 *   - iNaturalist fish observations (iconic_taxa=Actinopterygii, ray-finned fish) in the last `days` days,
 *     verifiable only, 1 page of 200, newest first; obscured locations dropped (kind sighting, `t` = when seen).
 *   - USGS water temperature (NWIS instantaneous values, parameter 00010; see _shared/usgs.ts): each access,
 *     ramp and pier point gets the nearest gauge's reading within 30 km (waterTempC, waterTempSite,
 *     waterTempKm, waterTempAt). US only.
 * Fish stocking reports are published separately by each state wildlife agency with no common API; they are
 * not included, and the description says so.
 *
 * Live smoke 2026-10-10 02:20 UTC, Lake Tahoe box [-120.6,38.6,-119.8,39.3], 3.8 s: 119 points: 48 OSM ramps (no
 * leisure=fishing or fishing piers mapped there), 47 USFS fishing areas (57 activity rows), 24 fish sightings
 * in 30 days (4 hidden left out; Brook Trout 2026-10-07, Brown and Rainbow Trout 10-04); 69 places got a water
 * temperature from 8 gauges (e.g. a ramp 23 km from Blackwood Creek at 13.1 °C).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { outsideUs } from "./_shared/coverage";
import { overpassQuery } from "./_shared/overpass";
import { arcgisQuery } from "./_shared/arcgis";
import { haversineKm } from "./_shared/geo";
import { fetchIv, parseIv, type IvSite } from "./_shared/usgs";
import { normalizeObservations } from "./species";
import { layerColor } from "@/lib/render/palette";

const USFS_ACTIVITIES =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0";
const INAT = "https://api.inaturalist.org/v1/observations";
const DAY_MS = 86_400_000;
/** Most OSM elements and iNaturalist sightings read per view; the result says when either cap is hit. */
export const OSM_LIMIT = 2_000;
export const INAT_LIMIT = 200;
const WATER_TEMP_MAX_KM = 30;
/** Recreation sites and OSM tags change slowly. */
const PLACES_TTL_SECONDS = 86_400;
const SIGHTINGS_TTL_SECONDS = 3_600;
const TEMP_TTL_SECONDS = 900;

const inputSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

type Props = Record<string, string | number | boolean>;

/** Overpass QL for fishing spots, boat ramps and fishing piers; bbox order (south,west,north,east). */
export function buildFishingQuery([west, south, east, north]: BBox): string {
  const a = `(${south},${west},${north},${east})`;
  return (
    `[out:json][timeout:25];(nwr["leisure"="fishing"]${a};nwr["leisure"="slipway"]${a};` +
    `nwr["man_made"="pier"]["fishing"~"^(yes|designated)$"]${a};);out center tags ${OSM_LIMIT};`
  );
}

const OsmSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/** Access points, ramps and piers from an Overpass body. */
export function osmFeatures(json: unknown): Feature<Point>[] {
  const elements =
    typeof json === "object" && json !== null && "elements" in json && Array.isArray(json.elements) ? json.elements : [];
  const out: Feature<Point>[] = [];
  for (const raw of elements) {
    const parsed = OsmSchema.safeParse(raw);
    if (!parsed.success) continue;
    const el = parsed.data;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tags = el.tags ?? {};
    const kind =
      tags.leisure === "slipway" ? "ramp" : tags.man_made === "pier" ? "pier" : tags.leisure === "fishing" ? "access" : null;
    if (kind === null) continue;
    const p: Props = { kind, source: "OpenStreetMap", osmId: `${el.type}/${el.id}` };
    p.name = tags.name ?? (kind === "ramp" ? "Boat ramp" : kind === "pier" ? "Fishing pier" : "Fishing spot");
    for (const key of ["access", "fee", "operator", "boat"] as const) if (tags[key]) p[key] = tags[key];
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: p });
  }
  return out;
}

/** USFS recreation areas with a fishing activity, one point per area listing its fishing activities. */
export function usfsFeatures(fc: FeatureCollection): Feature<Point>[] {
  const byArea = new Map<string, Feature<Point>>();
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const props = f.properties ?? {};
    const id = String(props.recareaid ?? props.recareaname ?? f.geometry.coordinates.join(","));
    const activity = typeof props.activityname === "string" ? props.activityname : undefined;
    const existing = byArea.get(id);
    if (existing) {
      const p = existing.properties as Props;
      if (activity && !String(p.activities).split("; ").includes(activity)) {
        p.activities = p.activities ? `${p.activities}; ${activity}` : activity;
      }
      continue;
    }
    const p: Props = {
      kind: "access",
      source: "USFS",
      name: typeof props.recareaname === "string" ? props.recareaname : "Forest Service fishing site",
    };
    if (activity) p.activities = activity;
    if (typeof props.forestname === "string") p.forest = props.forestname;
    if (typeof props.recareaurl === "string") p.url = props.recareaurl;
    if (typeof props.openstatus === "string") p.status = props.openstatus;
    byArea.set(id, { type: "Feature", geometry: { type: "Point", coordinates: f.geometry.coordinates }, properties: p });
  }
  return [...byArea.values()];
}

function elementCount(json: unknown): number {
  return typeof json === "object" && json !== null && "elements" in json && Array.isArray(json.elements) ? json.elements.length : 0;
}

function totalResults(json: unknown): number {
  return typeof json === "object" && json !== null && "total_results" in json && typeof json.total_results === "number"
    ? json.total_results
    : 0;
}

/** iNaturalist fish observations as sightings. */
export function sightingFeatures(json: unknown): { features: Feature<Point>[]; skipped: number } {
  const { data, skipped } = normalizeObservations(json);
  const features = data.features.map((f) => ({
    ...f,
    properties: { ...f.properties, kind: "sighting", source: "iNaturalist" },
  }));
  return { features, skipped };
}

/** Adds the nearest USGS water temperature within 30 km to each non-sighting point (mutates). */
export function attachWaterTemps(features: Feature<Point>[], sites: IvSite[]): number {
  const temps = sites.filter((s) => s.readings["00010"] !== undefined);
  let attached = 0;
  for (const f of features) {
    const p = f.properties as Props | null;
    if (!p || p.kind === "sighting") continue;
    let best: { site: IvSite; km: number } | undefined;
    for (const site of temps) {
      const km = haversineKm(f.geometry.coordinates as Position, site.coordinates);
      if (km <= WATER_TEMP_MAX_KM && (best === undefined || km < best.km)) best = { site, km };
    }
    if (best === undefined) continue;
    const reading = best.site.readings["00010"]!;
    p.waterTempC = reading.value;
    p.waterTempSite = best.site.name;
    p.waterTempKm = Math.round(best.km * 10) / 10;
    p.waterTempAt = new Date(reading.time).toISOString();
    attached += 1;
  }
  return attached;
}

export function inatUrl(bbox: BBox, days: number, now: Date): string {
  const [west, south, east, north] = bbox;
  const q = new URLSearchParams({
    nelat: String(north),
    nelng: String(east),
    swlat: String(south),
    swlng: String(west),
    iconic_taxa: "Actinopterygii",
    d1: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10),
    geo: "true",
    verifiable: "true",
    per_page: String(INAT_LIMIT),
    order_by: "observed_on",
    order: "desc",
  });
  return `${INAT}?${q.toString()}`;
}

async function inatSightings(ctx: QueryContext, days: number, now: Date) {
  try {
    const res = await ctx.fetch(inatUrl(ctx.bbox, days, now), {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:inat-fish`,
      ttlSeconds: SIGHTINGS_TTL_SECONDS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false as const, error: `iNaturalist returned ${res.status}` };
    return { ok: true as const, json: (await res.json()) as unknown };
  } catch {
    return { ok: false as const, error: "iNaturalist returned no usable response" };
  }
}

const fishing = defineLayer({
  id: "fishing",
  title: "Fishing (access, boat ramps, recent catches, water temperature)",
  description:
    "Where to fish and launch, what fish people have seen lately, and how warm the water is. User words: fishing, where to fish, fishing spot, fishing access, boat ramp, boat launch, slipway, pier, trout, bass, what's biting, water temperature. " +
    "Points by kind: 'access' (OpenStreetMap fishing spots, and US Forest Service recreation areas that list fishing, with activities such as 'Lake and Pond Fishing', forest, url and status), " +
    "'ramp' (boat ramps / slipways from OpenStreetMap, with access and fee where tagged), 'pier' (fishing piers), and 'sighting' (fish observations on iNaturalist in the last `days` days, default 30, with species, scientificName, t = when seen, url). " +
    "In the United States, access, ramp and pier points also get the nearest USGS gauge's live water temperature within 30 km: waterTempC (°C), waterTempSite, waterTempKm and waterTempAt; trout feed best around 10 to 18 °C and are stressed above about 20 °C. " +
    "Example questions: 'Where can I launch a boat on Lake Tahoe?', 'What fish have people caught near here this month?', 'Is the river too warm for trout?'. " +
    "Caveats: fish stocking reports are NOT available here (each state wildlife agency publishes its own, with no common feed), so say so and point to the state agency; " +
    "this layer does not show regulations, seasons or licence rules; OSM coverage of fishing spots is patchy (many lakes only have ramps mapped); " +
    "sightings are where people photograph fish, not a catch survey, and threatened species with hidden locations are left out; the water temperature is from the nearest stream gauge, which may be a different water body. " +
    "Bureau of Land Management (BLM) fishing sites are omitted: BLM publishes them only through a keyed API. " +
    "At most 2,000 OpenStreetMap places and the 200 most recent sightings are returned, and the result says when a cap is hit. " +
    "Global for OSM and iNaturalist; USFS sites and water temperature are US only. Zoom in to under 50,000 km² (about a 220 km square).",
  coverage: "global",
  license: "OpenStreetMap ODbL; USFS and USGS public domain; iNaturalist CC BY-NC / CC0 per observation",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 50_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("fishing"), cluster: true, timeField: "t" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > fishing.maxAreaKm2) {
      return { error: `Area is ${Math.round(area)} km²; zoom in to under ${fishing.maxAreaKm2} km²`, hint: "zoom_in" };
    }
    const now = new Date();
    const us = !outsideUs(ctx.bbox);
    const [osm, usfs, inat, temps] = await Promise.all([
      overpassQuery(ctx, buildFishingQuery(ctx.bbox), { cacheSuffix: "osm-fishing" }),
      us
        ? arcgisQuery(ctx, USFS_ACTIVITIES, {
            where: "parentactivityname='Fishing'",
            outFields: ["recareaid", "recareaname", "recareaurl", "forestname", "activityname", "openstatus"],
            bbox: ctx.bbox,
            cacheSuffix: "usfs-fishing",
            ttlSeconds: PLACES_TTL_SECONDS,
          })
        : Promise.resolve(null),
      inatSightings(ctx, input.days, now),
      us ? fetchIv(ctx, ["00010"], "usgs-temp", TEMP_TTL_SECONDS) : Promise.resolve(null),
    ]);

    const features: Feature<Point>[] = [];
    const notes: string[] = [];
    const failures: string[] = [];
    if (osm.ok) {
      features.push(...osmFeatures(osm.json));
      if (elementCount(osm.json) >= OSM_LIMIT) {
        notes.push(`OpenStreetMap places were capped at ${OSM_LIMIT.toLocaleString("en-US")}, so some are missing; zoom in for all of them`);
      }
    }
    else failures.push(`OpenStreetMap (${osm.error})`);
    if (usfs !== null) {
      if (usfs.ok) features.push(...usfsFeatures(usfs.fc));
      else failures.push(`USFS recreation sites (${usfs.error})`);
    }
    if (inat.ok) {
      const sightings = sightingFeatures(inat.json);
      features.push(...sightings.features);
      if (sightings.skipped > 0) notes.push(`${sightings.skipped} fish sightings with hidden locations were left out`);
      const total = totalResults(inat.json);
      if (total > INAT_LIMIT) {
        notes.push(`Showing the ${INAT_LIMIT} most recent of ${total.toLocaleString("en-US")} fish sightings; zoom in or shorten days for the rest`);
      }
    } else {
      failures.push(`iNaturalist (${inat.error})`);
    }
    if (temps !== null) {
      if (temps.ok) {
        const n = attachWaterTemps(features, parseIv(temps.bodies, now));
        if (n === 0) notes.push("No USGS water temperature gauge within 30 km of these spots");
      } else {
        failures.push(`USGS water temperature (${temps.error})`);
      }
    }
    const sources = 2 + (us ? 2 : 0);
    if (failures.length === sources) {
      return { error: `Every fishing source failed: ${failures.join("; ")}`, hint: "upstream" };
    }
    if (failures.length > 0) notes.push(`Left out because the source failed: ${failures.join("; ")}`);
    notes.push("Fish stocking reports are not included (state agencies publish them separately)");
    if (us) notes.push("BLM fishing sites are not included (no keyless BLM source)");

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source:
          "OpenStreetMap contributors (ODbL); USDA Forest Service recreation activities and USGS water data (public domain); iNaturalist (CC BY-NC / CC0)",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: now.toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(fishing);

export default fishing;

/**
 * US federal recreation sites: Forest Service recreation areas and BLM recreation sites and facilities. Keyless ArcGIS MapServers.
 *   USFS: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0   (EDW_RecreationAreaActivities_01)
 *     One point layer that is a spatial view joined to the activities table, so there is one ROW PER AREA AND ACTIVITY, not per area
 *     (Tahoe 0.4 degree box: 337 rows for 53 areas). maxRecordCount 2000 and the helper cannot ask for distinct values with f=geojson
 *     (HTTP 400 "Requested format is not supported"), so rows are grouped by recareaid here and a capped result is flagged.
 *     Fields used: recareaid, recareaname, recareaurl, forestname, markeractivitygroup (the area's primary marker, one value per area:
 *     "Camping & Cabins", "Trailhead", "Picnicking", "Beaches & Dunes", "Outdoor Learning", ...; `markertype` is only an image path),
 *     activityname (one per row), openstatus ("open" | "closed" | "none", refreshed nightly from the Recreation Portal).
 *   BLM:  https://gis.blm.gov/natl/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/0 (Facilities) and /1 (Sites)
 *     (moved from gis.blm.gov/arcgis, which redirects there, by 2026-10-14)
 *     Facilities: FacilityName, FacilityTypeDescription ("Campground" | "Facility" | "Kiosk" | "Permit" | "Activity Pass" | "Ticket Facility" |
 *     "Timed Entry" | "Venue Reservations"), BLMFacURL, State, Reservable ("-1" yes, "0" no). "Facility" is generic (trailheads, overlooks,
 *     boat ramps), so the site type is read from the name; permit and pass rows are administrative and are skipped.
 *     Sites: RecAreaName, BLMRecURL, State, ActivityNames (upper-case, often empty).
 * Smoke check 2026-10-09 (live, keyless, through runLayer): Tahoe box (-120.2,38.8,-119.8,39.2) returned 53 sites, all Forest Service
 *   (10 campgrounds, 9 trailheads, 10 OHV areas, 4 water access, 3 visitor centers, ...) in 0.35 s; Moab box (-109.8,38.4,-109.3,38.8)
 *   returned 91 sites (27 campgrounds, 31 trailheads, 6 viewpoints, ...) from Manti-La Sal National Forest and BLM, after dropping BLM permit rows
 *   and merging same-name BLM facilities and sites.
 * Wide (over 10,000 km², up to 1,500,000): the Forest Service view is asked for distinct area rows (returnDistinctValues with f=json,
 *   point from its longitude and latitude columns, no activities), BLM for named rows of the shown types, then up to 2,000 are taken
 *   from the two agencies in turn; the total counts distinct areas, shown-type facilities and sites. Smoke 2026-10-14, box
 *   -114,36,-105,42 (520,000 km², Utah and Colorado): 2,000 named (1,102 USFS, 898 BLM) of 3,607 in 2.7 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const USFS_URL =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer/0";
// The BLM services moved from gis.blm.gov/arcgis to gis.blm.gov/natl (the old path redirects, checked 2026-10-14).
export const BLM_FACILITIES_URL =
  "https://gis.blm.gov/natl/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/0";
export const BLM_SITES_URL =
  "https://gis.blm.gov/natl/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/1";

const USFS_FIELDS = ["recareaid", "recareaname", "recareaurl", "forestname", "markeractivitygroup", "activityname", "openstatus"];
const BLM_FACILITY_FIELDS = ["FacilityName", "FacilityTypeDescription", "BLMFacURL", "State", "Reservable"];
const BLM_SITE_FIELDS = ["RecAreaName", "BLMRecURL", "State", "ActivityNames"];

/** Sites change slowly (the USFS feed refreshes nightly). */
const TTL_SECONDS = 86_400;
const MAX_POINTS = 5_000;
const MAX_ACTIVITIES = 12;
/** Most sites a wide view carries. */
const WIDE_LIMIT = 2_000;
/** One row per Forest Service area (no activities) for wide views: the view's columns that do not change between its rows. */
const USFS_AREA_FIELDS = ["recareaid", "recareaname", "recareaurl", "forestname", "markeractivitygroup", "openstatus", "longitude", "latitude"];

const CAPPED_NOTE = "Showing only part of the sites because the services cap each reply at 2,000 records; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

type SiteFeature = Feature<Point, Record<string, string | boolean>>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The site type shown to people, from the Forest Service's primary marker group. */
const USFS_KINDS: Record<string, string> = {
  "Camping & Cabins": "campground",
  Trailhead: "trailhead",
  Picnicking: "day use area",
  "Beaches & Dunes": "water access",
  "Water Activities": "water access",
  Fishing: "water access",
  "Nature Viewing": "viewpoint",
  "Scenic Driving": "viewpoint",
  Hiking: "trail",
  Bicycling: "trail",
  Climbing: "trail",
  "Outdoor Learning": "visitor center",
  "Winter Sports": "winter sports",
  "OHV Riding & Camping": "OHV area",
};

/**
 * Name rules, tried in order, for sites whose own type field says too little (BLM "Facility", BLM recreation sites, and Forest Service areas
 * filed under a broad activity group). Most specific first, so "Camp Creek Overlook" is a viewpoint and not a campground; the campground
 * rule needs the word campground, camp site, camping area, or a name that ends in "Camp".
 */
const NAME_KINDS: [RegExp, string][] = [
  [/\btrail ?head\b/i, "trailhead"],
  [/\bboat (ramp|launch|access)\b|\b(put|take)[- ](in|out)\b/i, "water access"],
  [/\b(overlook|viewpoint|vista)\b/i, "viewpoint"],
  [/\b(picnic|day[- ]use)\b/i, "day use area"],
  [/\b(visitor|information) center\b/i, "visitor center"],
  [/\b(campgrounds?|camp ?sites?|camping area)\b|\bcamp$/i, "campground"],
  [/\btrails?\b/i, "trail"],
];

/** The type a name suggests, or undefined when it suggests none. */
function kindFromNameOnly(name: string): string | undefined {
  for (const [pattern, kind] of NAME_KINDS) if (pattern.test(name)) return kind;
  return undefined;
}

export function kindFromName(name: string): string {
  return kindFromNameOnly(name) ?? "recreation area";
}

const BLM_SKIPPED_TYPES = new Set(["Activity Pass", "Permit", "Ticket Facility", "Timed Entry", "Venue Reservations", "Kiosk"]);
/** Wide views count and fetch only the BLM facility types that are shown. */
export const BLM_SHOWN_FACILITIES = `FacilityTypeDescription NOT IN (${[...BLM_SKIPPED_TYPES].map((t) => `'${t}'`).join(", ")})`;

function pointOf(f: Feature): [number, number] | null {
  if (f.geometry?.type !== "Point") return null;
  const [lon, lat] = f.geometry.coordinates;
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/** Marker groups that name a specific kind of site; the broad ones (Hiking, Fishing, ...) are checked against the name first. */
const USFS_SPECIFIC_GROUPS = new Set([
  "Camping & Cabins",
  "Trailhead",
  "Picnicking",
  "Beaches & Dunes",
  "Outdoor Learning",
  "Winter Sports",
  "OHV Riding & Camping",
]);

/** The Forest Service's own marker group first when it is specific, then a strict name match, then the broad group. */
function usfsKind(name: string, group: string | undefined): string {
  const fromGroup = group !== undefined ? USFS_KINDS[group] : undefined;
  if (group !== undefined && USFS_SPECIFIC_GROUPS.has(group) && fromGroup !== undefined) return fromGroup;
  return kindFromNameOnly(name) ?? fromGroup ?? "recreation area";
}

/** One point per Forest Service recreation area: the view's rows (one per activity) are merged by recareaid. */
export function normalizeUsfs(fc: FeatureCollection): SiteFeature[] {
  const byArea = new Map<number, { feature: SiteFeature; activities: Set<string> }>();
  for (const f of fc.features) {
    const coords = pointOf(f);
    const p = f.properties ?? {};
    const id = typeof p.recareaid === "number" ? p.recareaid : undefined;
    if (coords === null || id === undefined) continue;

    let entry = byArea.get(id);
    if (!entry) {
      const group = str(p.markeractivitygroup);
      const name = str(p.recareaname) ?? "Unnamed recreation area";
      const properties: Record<string, string | boolean> = {
        name,
        // The marker group is the Forest Service's own label; a trailhead is often filed under the broad Hiking group, so the name decides then.
        kind: usfsKind(name, group),
        agency: "USFS",
      };
      const forest = str(p.forestname);
      if (forest !== undefined) properties.forest = forest;
      const status = str(p.openstatus);
      if (status === "open" || status === "closed") properties.status = status;
      const url = str(p.recareaurl);
      if (url !== undefined) properties.url = url;
      entry = {
        feature: { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties },
        activities: new Set(),
      };
      byArea.set(id, entry);
    }
    const activity = str(p.activityname);
    if (activity !== undefined && entry.activities.size < MAX_ACTIVITIES) entry.activities.add(activity);
  }
  return [...byArea.values()].map(({ feature, activities }) => {
    if (activities.size > 0) feature.properties.activities = [...activities].join(", ");
    return feature;
  });
}

/** BLM facilities with the permit, pass and kiosk rows removed. */
export function normalizeBlmFacilities(fc: FeatureCollection): SiteFeature[] {
  const out: SiteFeature[] = [];
  for (const f of fc.features) {
    const coords = pointOf(f);
    const p = f.properties ?? {};
    const name = str(p.FacilityName);
    const type = str(p.FacilityTypeDescription);
    if (coords === null || name === undefined) continue;
    if (type !== undefined && BLM_SKIPPED_TYPES.has(type)) continue;
    const properties: Record<string, string | boolean> = {
      name,
      kind: type === "Campground" ? "campground" : kindFromName(name),
      agency: "BLM",
    };
    const state = str(p.State);
    if (state !== undefined) properties.state = state;
    if (str(p.Reservable) === "-1") properties.reservable = true;
    const url = str(p.BLMFacURL);
    if (url !== undefined) properties.url = url;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties });
  }
  return out;
}

/** BLM recreation sites (areas, trail systems, camping areas). */
export function normalizeBlmSites(fc: FeatureCollection): SiteFeature[] {
  const out: SiteFeature[] = [];
  for (const f of fc.features) {
    const coords = pointOf(f);
    const p = f.properties ?? {};
    const name = str(p.RecAreaName);
    if (coords === null || name === undefined) continue;
    const properties: Record<string, string | boolean> = { name, kind: kindFromName(name), agency: "BLM" };
    const state = str(p.State);
    if (state !== undefined) properties.state = state;
    const activities = str(p.ActivityNames);
    if (activities !== undefined) {
      properties.activities = activities
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== "")
        .slice(0, MAX_ACTIVITIES)
        .join(", ");
    }
    const url = str(p.BLMRecURL);
    if (url !== undefined) properties.url = url;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties });
  }
  return out;
}

/** Drops later features with the same name at the same place (3 decimals, about 100 m); the first one wins. */
export function dedupe(features: SiteFeature[]): SiteFeature[] {
  const seen = new Set<string>();
  const out: SiteFeature[] = [];
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    const key = `${String(f.properties.name).toLowerCase()}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Query URL for one row per Forest Service area in a bbox: `returnDistinctValues` over the columns that are the same on every
 * activity row, with the point read from the longitude and latitude columns (distinct rows cannot carry geometry, and the
 * view's f=geojson rejects distinct). With `countOnly`, the number of areas instead.
 */
export function usfsAreasUrl(bbox: BBox, limit: number, countOnly = false): string {
  const search = new URLSearchParams({
    where: "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnDistinctValues: "true",
    returnGeometry: "false",
    f: "json",
  });
  if (countOnly) {
    search.set("outFields", "recareaid");
    search.set("returnCountOnly", "true");
  } else {
    search.set("outFields", USFS_AREA_FIELDS.join(","));
    search.set("orderByFields", "recareaid");
    search.set("resultRecordCount", String(limit));
  }
  return `${USFS_URL}/query?${search.toString()}`;
}

/** Distinct area rows (`{ features: [{ attributes }] }`) as the GeoJSON points normalizeUsfs reads. */
export function usfsAreaRows(json: unknown): FeatureCollection {
  const rows = typeof json === "object" && json !== null && "features" in json && Array.isArray(json.features) ? json.features : [];
  const features: Feature[] = [];
  for (const row of rows as unknown[]) {
    const a = typeof row === "object" && row !== null && "attributes" in row ? (row.attributes as Record<string, unknown>) : null;
    const lon = Number(a?.longitude);
    const lat = Number(a?.latitude);
    if (a === null || !Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) continue;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: a });
  }
  return { type: "FeatureCollection", features };
}

async function usfsJson(ctx: QueryContext, url: string, suffix: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await ctx.fetch(url, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}`,
      ttlSeconds: TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `ArcGIS service returned ${res.status}` };
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null) return { ok: false, error: "ArcGIS service returned no JSON object" };
    if ("error" in json) return { ok: false, error: "ArcGIS service error" };
    return { ok: true, json: json as Record<string, unknown> };
  } catch {
    return { ok: false, error: "ArcGIS service returned no response" };
  }
}

/** Wide Forest Service fetch: one row per area, at most `limit`, plus the number of areas in the box. */
async function usfsAreas(ctx: QueryContext, limit: number): Promise<{ res: ArcgisResult; count: number | null }> {
  const [rows, count] = await Promise.all([
    usfsJson(ctx, usfsAreasUrl(ctx.bbox, limit), "usfs-areas"),
    usfsJson(ctx, usfsAreasUrl(ctx.bbox, limit, true), "usfs-areas:count"),
  ]);
  const n = count.ok && typeof count.json.count === "number" ? count.json.count : null;
  if (!rows.ok) return { res: rows, count: n };
  return { res: { ok: true, fc: usfsAreaRows(rows.json), truncated: rows.json.exceededTransferLimit === true }, count: n };
}

/** Takes from the two lists in turn until `limit`, so neither agency crowds out the other. */
export function interleave<T>(a: T[], b: T[], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (out.length < limit && i < b.length) out.push(b[i]);
  }
  return out;
}

const inputSchema = z.object({});

const recreationSites = defineLayer({
  id: "recreation-sites",
  title: "Recreation sites",
  description:
    "Developed recreation sites on US federal land: Forest Service recreation areas (national forests and grasslands) and Bureau of Land Management recreation sites and facilities. " +
    "Each point has name, kind (campground, trailhead, day use area, water access for boat ramps and beaches, viewpoint, trail, visitor center, winter sports, OHV area, or recreation area when it is none of those), " +
    "agency (USFS or BLM), a link (url) to the agency page, and for Forest Service areas the forest and a list of activities (hiking, swimming, picnicking and so on) plus status (open or closed as the nightly feed reports it). " +
    "Use it for 'campgrounds near here', 'trailheads', 'boat ramps', 'picnic areas', 'where can I camp on Forest Service land', or to pick a base for a trip; filter by kind for one type. " +
    "Caveats: the site type comes from the agencies' own labels (BLM only says 'facility', so its type is inferred from the name and can be wrong); " +
    "this is the agencies' listing, not a booking system, so fees, dates and reservations must be checked on the linked page or recreation.gov; the closed flag is not a live closure notice. " +
    "It does not include National Park Service, state park or private campgrounds (use the campsites layer for those, which comes from OpenStreetMap). " +
    "United States only. Each service returns at most 2,000 records per request and the Forest Service data is one record per activity, so very busy views can be partial and the result says when that happens. " +
    "Over 10,000 km² (about a 100 km square), up to 2,000 named sites, one per area, and the total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USDA Forest Service; Bureau of Land Management)",
  requiredEnv: [],
  maxAreaKm2: 10_000,
  hardMaxAreaKm2: 1_500_000,
  wide: { mode: "named", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("recreation-sites"), cluster: true },

  async query(ctx: QueryContext): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USDA Forest Service Recreation Area Activities and BLM National Recreation Sites and Facilities (public domain)",
      url: "https://www.recreation.gov/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    if (ctx.wide === true && ctx.wideStrategy !== undefined) return queryWide(ctx, ctx.wideStrategy.limit, citation);

    const [usfs, blmFacilities, blmSites] = await Promise.all([
      arcgisQuery(ctx, USFS_URL, {
        outFields: USFS_FIELDS,
        bbox: ctx.bbox,
        orderByFields: "recareaid",
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "usfs",
      }),
      arcgisQuery(ctx, BLM_FACILITIES_URL, {
        outFields: BLM_FACILITY_FIELDS,
        bbox: ctx.bbox,
        orderByFields: "OBJECTID",
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "blm-facilities",
      }),
      arcgisQuery(ctx, BLM_SITES_URL, {
        outFields: BLM_SITE_FIELDS,
        bbox: ctx.bbox,
        orderByFields: "OBJECTID",
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "blm-sites",
      }),
    ]);

    const runs = [
      { name: "Forest Service", res: usfs },
      { name: "BLM facilities", res: blmFacilities },
      { name: "BLM sites", res: blmSites },
    ];
    const failed = runs.filter((r) => !r.res.ok);
    if (failed.length === runs.length) {
      const first = failed[0].res;
      return { error: first.ok ? "unknown error" : first.error, hint: "upstream" };
    }

    const notes: string[] = [];
    for (const r of failed) {
      notes.push(`${r.name} did not respond, so its sites are missing`);
    }
    if (runs.some((r) => r.res.ok && r.res.truncated)) notes.push(CAPPED_NOTE);

    let features: SiteFeature[] = [
      ...(usfs.ok ? normalizeUsfs(usfs.fc) : []),
      ...dedupe([
        ...(blmFacilities.ok ? normalizeBlmFacilities(blmFacilities.fc) : []),
        ...(blmSites.ok ? normalizeBlmSites(blmSites.fc) : []),
      ]),
    ];
    if (features.length > MAX_POINTS) {
      notes.push(`Showing ${MAX_POINTS.toLocaleString("en-US")} of ${features.length.toLocaleString("en-US")} sites`);
      features = features.slice(0, MAX_POINTS);
    }
    if (features.length === 0 && notes.length === 0) {
      notes.push("No Forest Service or BLM recreation sites in this area");
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

/**
 * Wide views (over 10,000 km², up to 1,500,000): one row per Forest Service area (its activities left out), named BLM facilities
 * of the shown types and named BLM sites, each at most `limit`, then taken in turn from the two agencies up to `limit`. The total
 * is the number of areas, shown-type facilities and sites in the box (a BLM facility and site with the same name count twice).
 */
async function queryWide(ctx: QueryContext, limit: number, citation: LayerResult["citation"]): Promise<LayerResult | LayerError> {
  const [usfs, blmFacilities, blmSites, facilitiesCount, sitesCount] = await Promise.all([
    usfsAreas(ctx, limit),
    arcgisQuery(ctx, BLM_FACILITIES_URL, {
      outFields: BLM_FACILITY_FIELDS,
      where: `${BLM_SHOWN_FACILITIES} AND FacilityName > ' '`,
      bbox: ctx.bbox,
      orderByFields: "OBJECTID",
      resultRecordCount: limit,
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "blm-facilities",
    }),
    arcgisQuery(ctx, BLM_SITES_URL, {
      outFields: BLM_SITE_FIELDS,
      where: "RecAreaName > ' '",
      bbox: ctx.bbox,
      orderByFields: "OBJECTID",
      resultRecordCount: limit,
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "blm-sites",
    }),
    arcgisCount(ctx, BLM_FACILITIES_URL, { where: BLM_SHOWN_FACILITIES, bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "blm-facilities" }),
    arcgisCount(ctx, BLM_SITES_URL, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "blm-sites" }),
  ]);

  const runs = [
    { name: "Forest Service", res: usfs.res },
    { name: "BLM facilities", res: blmFacilities },
    { name: "BLM sites", res: blmSites },
  ];
  const failed = runs.filter((r) => !r.res.ok);
  if (failed.length === runs.length) {
    const first = failed[0].res;
    return { error: first.ok ? "unknown error" : first.error, hint: "upstream" };
  }
  const notes = failed.map((r) => `${r.name} did not respond, so its sites are missing`);
  const features = interleave(
    usfs.res.ok ? normalizeUsfs(usfs.res.fc) : [],
    dedupe([...(blmFacilities.ok ? normalizeBlmFacilities(blmFacilities.fc) : []), ...(blmSites.ok ? normalizeBlmSites(blmSites.fc) : [])]),
    limit,
  );
  const counts = [usfs.count, facilitiesCount, sitesCount];
  const total = failed.length === 0 && counts.every((c) => c !== null) ? counts.reduce<number>((sum, c) => sum + (c ?? 0), 0) : undefined;
  if (features.length === 0 && notes.length === 0) notes.push("No Forest Service or BLM recreation sites in this area");

  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    citation,
    ...(total !== undefined && { total }),
    ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
  };
}

registerLayer(recreationSites);

export default recreationSites;

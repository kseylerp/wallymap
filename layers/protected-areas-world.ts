/**
 * Protected areas of the world: UNEP-WCMC / IUCN World Database on Protected Areas (WDPA, Protected Planet).
 * Service (verified live 2026-10-09, keyless ArcGIS MapServer, "protected areas only" view, WDPA v3.7):
 *   https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer
 *   layer 0 WDPA_point_latest, layer 1 WDPA_poly_latest. `export` draws PNG32 with transparency (a Sierra Nevada
 *   tile came back 40 KB: green terrestrial areas, blue marine ones, with outlines).
 * The layer returns a raster tile template and makes no upstream call; Mapbox fills {bbox-epsg-3857} per tile.
 * Notes: tiles are slow at low zoom (a z2 world quarter took 4.5 s), so minzoom is 3. License: Protected Planet allows
 * free non-commercial use only; commercial use needs a licence from UNEP-WCMC. The Protected Planet citation
 * wording is the service's own copyrightText.
 * Smoke through runLayer (2026-10-09): world bbox returns the tile template (200). Live tiles through the produced template:
 * Sierra Nevada z6 35 KB in 0.8 s, z3 23 KB in 3.0 s.
 * Features mode (regions under FEATURES_MAX_AREA_KM2): `query` on layer 1 (WDPA_poly_latest, maxRecordCount 2000, lowercase
 * fields), largest first by gis_area (km²), simplified with maxAllowableOffset. Verified live 2026-10-11: French Guiana
 * (-54.6,2.1,-51.6,5.8) 47 polygons, 75 KB, 0.5 s (largest Parque Nacional Montanhas Do Tumucumaque, 38,295 km²); a
 * 270,000 km² Alps box holds 16,852, the 300 largest came back in 2.8 s (700 KB). Some names carry a literal backslash
 * before an apostrophe ("D\'Adhésion"); it is removed. Fixture: layers/__fixtures__/protected-areas-world.guiana.json.
 */
import { z } from "zod";
import type { Feature, FeatureCollection } from "geojson";
import {
  bboxAreaKm2,
  defineLayer,
  type BBox,
  type CardSpec,
  type Facet,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type QueryContext,
} from "./types";
import { registerLayer } from "./registry";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { arcgisQuery } from "./_shared/arcgis";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer";

/** Both the polygon (1) and point (0) sublayers: small reserves are only points in the database. */
export const WDPA_TILE_URL = mapServerExportTileUrl(SERVICE, { layers: "show:0,1" });

/** The polygon sublayer, queried for named features in regions under FEATURES_MAX_AREA_KM2. */
export const WDPA_POLYGONS = `${SERVICE}/1`;
/** Regions up to this size get named polygons; wider ones get the tiles. */
export const FEATURES_MAX_AREA_KM2 = 500_000;
/** Most polygons returned, largest first. */
export const MAX_AREAS = 300;
export const WDPA_FIELDS = ["site_id", "name", "name_eng", "desig_eng", "iucn_cat", "rep_area", "gis_area", "realm", "status_yr", "iso3"];

const LICENCE_NOTE = "free for non-commercial use only (UNEP-WCMC and IUCN); gaps may mean unreported areas, not unprotected land";

function citation() {
  return {
    source: "UNEP-WCMC and IUCN, Protected Planet: The World Database on Protected Areas (WDPA), non-commercial use only",
    url: "https://www.protectedplanet.net/",
    retrieved: new Date().toISOString(),
  };
}

/** Display simplification in degrees: about 1/1,500 of the region's width, between ~50 m and ~2 km. */
export function simplifyOffset(bbox: BBox): number {
  return Math.min(0.02, Math.max(0.0005, (bbox[2] - bbox[0]) / 1_500));
}

/** IUCN categories that say something; "Not Reported", "Not Applicable" and "Not Assigned" are left out. */
const IUCN = /^(Ia|Ib|II|III|IV|V|VI)$/;

/** Some WDPA names carry a literal backslash before an apostrophe. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\\(['"])/g, "$1").trim();
  return name === "" ? undefined : name;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * WDPA polygons as features: name, designation (in English), iucn (category, when one is assigned), areaKm2 and v
 * (the mapped area in km², or the reported one when there is no mapped area), country (ISO3 code), realm, statusYear and siteId. Largest first;
 * features with no geometry are skipped.
 */
export function normalizeProtectedAreas(fc: FeatureCollection): FeatureCollection {
  const features: Feature[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const name = cleanName(p.name) ?? cleanName(p.name_eng);
    if (name === undefined) continue;
    const properties: Record<string, string | number> = { name };
    const english = cleanName(p.name_eng);
    if (english !== undefined && english !== name) properties.nameEnglish = english;
    if (typeof p.desig_eng === "string" && p.desig_eng.trim() !== "") properties.designation = p.desig_eng.trim();
    if (typeof p.iucn_cat === "string" && IUCN.test(p.iucn_cat)) properties.iucn = p.iucn_cat;
    const area = positive(p.gis_area) ?? positive(p.rep_area);
    if (area !== undefined) {
      properties.areaKm2 = area >= 10 ? Math.round(area) : Math.round(area * 10) / 10;
      properties.v = properties.areaKm2;
    }
    if (typeof p.iso3 === "string" && p.iso3 !== "") properties.country = p.iso3;
    if (typeof p.realm === "string") properties.realm = p.realm;
    if (typeof p.status_yr === "number" && p.status_yr > 0) properties.statusYear = p.status_yr;
    if (typeof p.site_id === "number" || typeof p.site_id === "string") properties.siteId = String(p.site_id);
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  features.sort((a, b) => Number(b.properties?.v ?? 0) - Number(a.properties?.v ?? 0));
  return { type: "FeatureCollection", features };
}

function tilesResult(note?: string): LayerResult {
  return {
    kind: "tiles",
    data: { url: WDPA_TILE_URL, minzoom: 3, maxzoom: 14, format: "raster", tileSize: 256 },
    citation: citation(),
    coverageNote: note ?? "Free for non-commercial use only (UNEP-WCMC and IUCN); gaps may mean unreported areas, not unprotected land",
  };
}

/** Named polygons for a region under FEATURES_MAX_AREA_KM2, or the tiles when the service fails. */
async function queryFeatures(ctx: QueryContext): Promise<LayerResult> {
  const result = await arcgisQuery(ctx, WDPA_POLYGONS, {
    outFields: WDPA_FIELDS,
    bbox: ctx.bbox,
    maxRecords: MAX_AREAS,
    orderByFields: "gis_area DESC",
    maxAllowableOffset: simplifyOffset(ctx.bbox),
    cacheSuffix: "wdpa:polygons",
  });
  if (!result.ok) {
    return tilesResult(`The named areas could not be loaded (${result.error}), so the map shows the tiles; ${LICENCE_NOTE}`);
  }
  const data = normalizeProtectedAreas(result.fc);
  const n = data.features.length.toLocaleString("en-US");
  const head = result.truncated
    ? `The ${n} largest protected areas in this region (more, smaller ones exist; zoom in for them)`
    : `${n} protected areas in this region, largest first`;
  return {
    kind: "geojson",
    data,
    citation: citation(),
    coverageNote: `${head}; reserves recorded only as points are not included; ${LICENCE_NOTE}`,
  };
}

const IUCN_URL = "https://www.iucn.org/theme/protected-areas/about/protected-area-categories";

const IUCN_NAMES: Record<string, string> = {
  Ia: "Ia Strict Nature Reserve",
  Ib: "Ib Wilderness Area",
  II: "II National Park",
  III: "III Natural Monument or Feature",
  IV: "IV Habitat/Species Management Area",
  V: "V Protected Landscape/Seascape",
  VI: "VI Protected area with sustainable use of natural resources",
};

const FACETS: Facet[] = [
  { key: "iucn", label: "IUCN category", kind: "category", values: Object.entries(IUCN_NAMES).map(([value, label]) => ({ value, label })) },
  { key: "areaKm2", label: "Area", kind: "range", unit: "km²" },
];

const AREA: FieldHelp = {
  text: "The area of the mapped polygon in the World Database on Protected Areas, or the reported area when none is mapped.",
  unit: "km²",
};

const HELP: Record<string, FieldHelp> = {
  iucn: {
    text:
      "The IUCN management category, which says how an area is managed: Ia Strict Nature Reserve, Ib Wilderness Area, II National Park, III " +
      "Natural Monument or Feature, IV Habitat/Species Management Area, V Protected Landscape/Seascape, VI Protected area with sustainable use of " +
      "natural resources.",
    scale: "Ia, Ib, II, III, IV, V, VI (absent when not reported or not assigned)",
    source: "IUCN Protected Area Management Categories",
    url: IUCN_URL,
  },
  areaKm2: AREA,
  v: AREA,
  designation: { text: "The legal designation in English as the country reports it (National Park, Nature Reserve and so on)." },
  statusYear: { text: "The year the area was designated or its current status was set." },
  realm: { text: "Whether the area is terrestrial, marine or coastal (both)." },
  country: { text: "The ISO 3166 three-letter code of the country that reported the area." },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²" },
  facts: [
    { key: "designation", label: "Designation" },
    { key: "iucn", label: "IUCN category", values: IUCN_NAMES },
    { key: "statusYear", label: "Designated" },
    { key: "realm", label: "Realm" },
    { key: "country", label: "Country" },
  ],
};

const protectedAreasWorld = defineLayer({
  id: "protected-areas-world",
  title: "Protected areas of the world",
  description:
    "Protected areas of the world (national parks, nature reserves, wilderness, marine protected areas and similar) from the World Database on Protected Areas run by UNEP-WCMC and IUCN. " +
    "In a region under 500,000 km² it returns named polygons, largest first (up to 300): name, designation (National Park, Nature Reserve...), iucn category when assigned, and areaKm2 and v (area in km²), so you can name and compare the parks; " +
    "over 500,000 km² it returns map tiles instead (green for land and inland water, blue for ocean), a picture you cannot list, count or name areas from. " +
    "Use it for 'is this place protected', 'where are the parks and reserves in this country' or 'how much of this coast is a marine reserve', anywhere in the world, and as the global counterpart of the US-only public-lands and wilderness layers. " +
    "It shows that an area is protected, not how strictly: a strict nature reserve and a multiple-use forest look alike. " +
    "Coverage depends on what each country reports, so a gap can mean the data is missing and not that the land is unprotected, and many small reserves are recorded only as points (on the tiles as dots, and left out of the named polygons). " +
    "Licence: free for non-commercial use only; commercial use needs permission from UNEP-WCMC, so say so when the user plans to use it commercially. " +
    "Tiles appear from about zoom level 3 (a continent view) and are slow to draw when zoomed far out. Works at any size of region.",
  coverage: "global",
  license: "Non-commercial use only (UNEP-WCMC and IUCN, Protected Planet terms); commercial use needs a licence",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("protected-areas-world"), facets: FACETS },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx): Promise<LayerResult | LayerError> {
    if (bboxAreaKm2(ctx.bbox) <= FEATURES_MAX_AREA_KM2) return queryFeatures(ctx);
    return tilesResult();
  },
});

registerLayer(protectedAreasWorld);

export default protectedAreasWorld;

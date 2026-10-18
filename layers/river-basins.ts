/**
 * River basins and watersheds: the USGS Watershed Boundary Dataset (WBD), every hydrologic unit nested by 2-digit code.
 * Service (verified live 2026-10-10, keyless):
 *   https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer
 *   layer 1 = 2-digit HU (Region, 22 units), 2 = 4-digit (Subregion), 3 = 6-digit (Basin), 4 = 8-digit (Subbasin),
 *   5 = 10-digit (Watershed), 6 = 12-digit (Subwatershed). Polygon layers, maxRecordCount 2000, f=geojson works.
 *   Fields: huc2/huc4/huc6/huc8/huc10 (the code, named for the level), name, areasqkm, states (comma list, e.g. "AZ,NM,UT").
 * Output: v = area (km2), kind = "huc2" .. "huc10", plus name, huc (the code), hucLevel (digits), areaSqKm, states.
 * The level follows the zoom (below 6 regions, 6 and 7 subregions, 8 and up subbasins) unless `level` is set; a level too fine for
 * the view's size (from the zoom or from `level`) steps up to a coarser one rather than failing. Geometry is simplified with maxAllowableOffset by level.
 * Smoke check 2026-10-10 (live, through runLayer): Four Corners box -111.6,36.8,-109,38.5 at zoom 8 returned 19 subbasins
 * (Chinle, 10,617 km2, first) in 0.7 s; the lower 48 box (-125,24,-66,50, 15 million km2) at zoom 4 returned 18 regions in 3.8 s
 * (Missouri Region first); at zoom 7 or with level huc8 it steps up to regions (huc4 is limited to 3.5 million km2); huc4 over a
 * 9 x 6 degree box is about 9 s per 200 units upstream, which is why the finer levels have smaller area limits. States can include "CN" (Canada).
 * Smoke wide 2026-10-14 (live, through runLayer): the US with Alaska -170,18,-60,72 (about 50 million km2) returned all 21 regions of 21
 * in 7.1 s (51 KB at 0.08 degrees), Alaska Region first.
 * Drawing (2026-10-18): each unit carries `region`, the 2-digit region it drains to (the first two digits of its code), and
 * `regionName`; the region is the color category (REGION_LEVELS, six fills cycling by code so neighbouring regions differ),
 * and the ten largest units are labelled with their names, so "what watershed is Boulder in" is answered on the map.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type Attribute, type LayerError, type LayerResult, type CardSpec, type FieldHelp, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

const SERVICE_URL = "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer";
/** Boundaries change about yearly. */
const TTL_SECONDS = 7 * 86_400;

export const LEVELS = ["huc2", "huc4", "huc6", "huc8", "huc10"] as const;
export type Level = (typeof LEVELS)[number];

type LevelSpec = {
  /** Digits in the code. */
  digits: number;
  /** MapServer layer id. */
  layer: number;
  /** Attribute holding the code. */
  field: string;
  /** Simplification in degrees. */
  offset: number;
  /** Largest view this level is drawn for, in km2. */
  maxAreaKm2: number;
  noun: string;
};

export const LEVEL_SPECS: Record<Level, LevelSpec> = {
  huc2: { digits: 2, layer: 1, field: "huc2", offset: 0.04, maxAreaKm2: 20_000_000, noun: "regions" },
  huc4: { digits: 4, layer: 2, field: "huc4", offset: 0.02, maxAreaKm2: 3_500_000, noun: "subregions" },
  huc6: { digits: 6, layer: 3, field: "huc6", offset: 0.01, maxAreaKm2: 1_000_000, noun: "basins" },
  huc8: { digits: 8, layer: 4, field: "huc8", offset: 0.004, maxAreaKm2: 250_000, noun: "subbasins" },
  huc10: { digits: 10, layer: 5, field: "huc10", offset: 0.001, maxAreaKm2: 40_000, noun: "watersheds" },
};

/** The level a zoom calls for: regions when zoomed far out, subbasins when zoomed in. */
export function levelForZoom(zoom: number): Level {
  if (zoom < 6) return "huc2";
  if (zoom < 8) return "huc4";
  return "huc8";
}

/** The finest level at or above `wanted` (coarser or equal) that is allowed for a view of `area` km2. */
export function levelForArea(wanted: Level, area: number): Level {
  let i = LEVELS.indexOf(wanted);
  while (i > 0 && area > LEVEL_SPECS[LEVELS[i]].maxAreaKm2) i -= 1;
  return LEVELS[i];
}

/** The 22 two-digit hydrologic regions, by code (USGS Watershed Boundary Dataset). */
export const REGION_NAMES: Record<string, string> = {
  "01": "New England",
  "02": "Mid Atlantic",
  "03": "South Atlantic-Gulf",
  "04": "Great Lakes",
  "05": "Ohio",
  "06": "Tennessee",
  "07": "Upper Mississippi",
  "08": "Lower Mississippi",
  "09": "Souris-Red-Rainy",
  "10": "Missouri",
  "11": "Arkansas-White-Red",
  "12": "Texas-Gulf",
  "13": "Rio Grande",
  "14": "Upper Colorado",
  "15": "Lower Colorado",
  "16": "Great Basin",
  "17": "Pacific Northwest",
  "18": "California",
  "19": "Alaska",
  "20": "Hawaii",
  "21": "Caribbean",
  "22": "South Pacific",
};

/** Six fills cycled by region code, so regions with neighbouring codes (mostly neighbours on the map) differ. */
const REGION_FILLS = [SAGE, PURPLE, PINK, DARK_GREY, rgbToHex(interpolateStops([SAGE, DARK_GREY], 0.5)), rgbToHex(interpolateStops([PURPLE, PINK], 0.5))];

export const REGION_LEVELS = Object.entries(REGION_NAMES).map(([value, name], i) => ({ value, label: `${name} region`, color: REGION_FILLS[i % REGION_FILLS.length] }));

export const BASINS_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Drains to region",
  field: "region",
  items: REGION_LEVELS.map(({ value, label, color }) => ({ label, value, color, symbol: "polygon" as const })),
  note: "Each unit is filled by the two-digit region it drains to; zoom in for subregions, subbasins and watersheds.",
};

/** Most units in a wide result (over 20 million km² only regions are drawn, and there are 22). */
const WIDE_LIMIT = 1000;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Hydrologic units as polygons with the code in `huc`, the level in `kind` and the area (km2) in `v`. */
export function normalizeBasins(fc: FeatureCollection, level: Level): FeatureCollection {
  const spec = LEVEL_SPECS[level];
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = {
      name: str(p.name) ?? "Unnamed basin",
      kind: level,
      hucLevel: spec.digits,
    };
    const huc = str(p[spec.field]);
    if (huc !== undefined) {
      properties.huc = huc;
      const region = huc.slice(0, 2);
      if (REGION_NAMES[region] !== undefined) {
        properties.region = region;
        properties.regionName = `${REGION_NAMES[region]} region`;
      }
    }
    const area = num(p.areasqkm);
    if (area !== undefined) {
      properties.areaSqKm = Math.round(area);
      properties.v = Math.round(area);
    }
    const states = str(p.states);
    if (states !== undefined) properties.states = states;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const WBD_URL = "https://www.usgs.gov/national-hydrography/watershed-boundary-dataset";

/** What the area, code and level on a basin card mean (spec §12b). */
const HELP: Record<string, FieldHelp> = {
  v: { text: "The unit's area in square kilometres.", unit: "km²", source: "USGS Watershed Boundary Dataset", url: WBD_URL },
  huc: {
    text:
      "The hydrologic unit code, the USGS identifier for this drainage area: 2 digits for a region, 4 for a subregion, 6 for a basin, 8 for a " +
      "subbasin, 10 for a watershed. A longer code nests inside the unit named by its first digits.",
    source: "USGS Watershed Boundary Dataset",
    url: WBD_URL,
  },
  kind: {
    text: "How fine this unit is in the USGS nesting of drainage areas, from the 22 regions down to watersheds.",
    scale: "Region (2-digit code), subregion (4), basin (6), subbasin (8), watershed (10)",
  },
  regionName: { text: "The 2-digit hydrologic region this unit drains to (the first two digits of its code), such as the Missouri region.", source: "USGS Watershed Boundary Dataset", url: WBD_URL },
};

const ATTRIBUTES: Attribute[] = [
  { key: "region", type: "category", label: "Drains to region", levels: REGION_LEVELS.map(({ value, label }) => ({ value, label })), encode: "color", primary: true },
  { key: "areaSqKm", type: "measure", label: "Area", unit: "km²" },
  { key: "name", type: "name", label: "Name" },
];

/** The basin card: its area, its level in words and its code. */
const CARD: CardSpec = {
  measure: { key: "v", label: "Area", unit: "km²" },
  facts: [
    { key: "kind", label: "Level", values: { huc2: "Region", huc4: "Subregion", huc6: "Basin", huc8: "Subbasin", huc10: "Watershed" } },
    { key: "regionName", label: "Drains to" },
    { key: "huc", label: "Hydrologic unit code" },
    { key: "states", label: "States", format: "list", values: { CN: "Canada" } },
  ],
  // hucLevel repeats kind as a digit count; region is regionName's code; areaSqKm is the measure again.
  hidden: ["hucLevel", "region", "areaSqKm"],
};

const riverBasins = defineLayer({
  id: "river-basins",
  title: "River basins and watersheds",
  description:
    "US drainage basins from the USGS Watershed Boundary Dataset: the land that drains to one river or outlet. Each polygon has name, huc (hydrologic unit code; longer codes nest inside shorter ones), kind and hucLevel (huc2 regions to huc10 watersheds), v and areaSqKm, states, and region and regionName (the 2-digit region it drains to, such as the Missouri region). The map fills units by that region with a legend and labels the ten largest by name. The level follows the zoom, or set level; a level too fine for the view steps up to a coarser one and the result says so. Outlines are simplified and a basin is not a legal boundary. At most 2,000 units, largest first. Limits: huc4 3,500,000 km², huc6 1,000,000, huc8 250,000, huc10 40,000; over 20,000,000 it gives regions and a total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS Watershed Boundary Dataset)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  wide: { orderBy: "area in km²", limit: WIDE_LIMIT },
  input: z.object({
    level: z
      .enum(LEVELS)
      .optional()
      .describe("Hydrologic unit level: huc2 regions, huc4 subregions, huc6 basins, huc8 subbasins, huc10 watersheds. Default follows the zoom."),
  }),
  style: { geometry: "polygon", color: layerColor("river-basins"), fillOpacity: 0.1 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: BASINS_LEGEND,
  labels: { field: "name", max: 10, rankBy: "areaSqKm" },
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Watershed Boundary Dataset (National Hydrography; public domain)",
      url: "https://www.usgs.gov/national-hydrography/watershed-boundary-dataset",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // A level too fine for the view steps up to a coarser one, whether it came from the zoom or from `level`. Over the
    // soft cap (20 million km²) that is always regions, never an error; wide mode also simplifies twice as coarsely.
    const area = bboxAreaKm2(ctx.bbox);
    const wide = ctx.wide === true;
    const wanted = input.level ?? levelForZoom(ctx.zoom);
    const level = levelForArea(wanted, area);
    const spec = LEVEL_SPECS[level];

    const res = await arcgisQuery(ctx, `${SERVICE_URL}/${spec.layer}`, {
      outFields: [spec.field, "name", "areasqkm", "states"],
      bbox: ctx.bbox,
      maxAllowableOffset: wide ? spec.offset * 2 : spec.offset,
      orderByFields: "areasqkm DESC",
      ...(wide && { resultRecordCount: ctx.wideStrategy?.limit ?? WIDE_LIMIT, withCount: true }),
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: `river-basins:${level}`,
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeBasins(res.fc, level);
    const notes: string[] = [];
    if (level !== wanted) notes.push(`Showing ${spec.noun} (${level}) because ${wanted} is too fine for this view; zoom in for finer basins`);
    if (res.truncated && !wide) notes.push(`Showing the 2,000 largest ${spec.noun}; zoom in for the rest`);
    if (data.features.length === 0) notes.push("No watershed boundaries for this area");
    return {
      kind: "geojson",
      data,
      citation,
      ...(res.total !== undefined && { total: res.total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(riverBasins);

export default riverBasins;

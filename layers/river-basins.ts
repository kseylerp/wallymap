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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

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
    if (huc !== undefined) properties.huc = huc;
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

const riverBasins = defineLayer({
  id: "river-basins",
  title: "River basins and watersheds",
  description:
    "US drainage basins from the USGS Watershed Boundary Dataset: the land that drains to one river or outlet. Each polygon has name, huc (hydrologic unit code; longer codes nest inside shorter ones), kind and hucLevel (huc2 regions to huc10 watersheds), v and areaSqKm, and states. The level follows the zoom, or set level; a level too fine for the view steps up to a coarser one and the result says so. Outlines are simplified and a basin is not a legal boundary. At most 2,000 units, largest first. Zoom in to under 20,000,000 km² (huc4 under 3,500,000, huc6 1,000,000, huc8 250,000, huc10 40,000).",
  coverage: "us",
  license: "Public domain (USGS Watershed Boundary Dataset)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  input: z.object({
    level: z
      .enum(LEVELS)
      .optional()
      .describe("Hydrologic unit level: huc2 regions, huc4 subregions, huc6 basins, huc8 subbasins, huc10 watersheds. Default follows the zoom."),
  }),
  style: { geometry: "polygon", color: layerColor("river-basins"), fillOpacity: 0.1 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Watershed Boundary Dataset (National Hydrography; public domain)",
      url: "https://www.usgs.gov/national-hydrography/watershed-boundary-dataset",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > riverBasins.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${riverBasins.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    // A level too fine for the view steps up to a coarser one, whether it came from the zoom or from `level`.
    const wanted = input.level ?? levelForZoom(ctx.zoom);
    const level = levelForArea(wanted, area);
    const spec = LEVEL_SPECS[level];

    const res = await arcgisQuery(ctx, `${SERVICE_URL}/${spec.layer}`, {
      outFields: [spec.field, "name", "areasqkm", "states"],
      bbox: ctx.bbox,
      maxAllowableOffset: spec.offset,
      orderByFields: "areasqkm DESC",
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: `river-basins:${level}`,
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeBasins(res.fc, level);
    const notes: string[] = [];
    if (level !== wanted) notes.push(`Showing ${spec.noun} (${level}) because ${wanted} is too fine for this view; zoom in for finer basins`);
    if (res.truncated) notes.push(`Showing the 2,000 largest ${spec.noun}; zoom in for the rest`);
    if (data.features.length === 0) notes.push("No watershed boundaries for this area");
    return {
      kind: "geojson",
      data,
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(riverBasins);

export default riverBasins;

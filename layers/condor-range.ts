/**
 * California condor range: where the species lives now and where it lived in the early 1800s.
 * Services (verified live 2026-10-10, keyless): National Park Service (Sequoia & Kings Canyon, SEKI) ArcGIS Online org
 *   https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/Current_Range/FeatureServer/0   3 polygons
 *   https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/Historic_Range/FeatureServer/0  1 polygon
 * Both have one useful field, Name: "Current California Range For California Condors", "Current Southwest Experimental
 * Range For California Condors" (Arizona and Utah), "Current Baja California Experimental Range For California Condors"
 * and "Early 1800's Range For California Condors". Current polygons fit in -121.9,30.5 to -110.3,38.3; the historic one
 * in -125.4,29.9 to -107.9,51.5 (Pacific coast from British Columbia to Baja, inland to the Rockies).
 * Output properties: name, kind ("current" | "experimental" | "historic"), era ("today" | "early 1800s").
 * Smoke through runLayer (2026-10-10): box -125,29,-107,52 returned 4 polygons in 0.2 s (3 KB); the Sequoia box
 * -119.8,35.5,-118.8,36.5 returned the current California range and the historic range.
 * Smoke wide (2026-10-14): North America -170,18,-60,72 (about 50 million km²) returned all 4 polygons of 4 in 0.5 s (3 KB).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services";
const CURRENT_URL = `${BASE}/Current_Range/FeatureServer/0`;
const HISTORIC_URL = `${BASE}/Historic_Range/FeatureServer/0`;

/** Everything either range touches, so a far-away view does not call the service. */
const EXTENT: BBox = [-125.5, 29.8, -107.8, 51.6];

/** Range maps change when releases change; a week is plenty. */
const TTL_SECONDS = 7 * 86_400;

/** Most polygons in a wide result (there are four in all, so this only bounds the request). */
const WIDE_LIMIT = 1000;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Display simplification in degrees: the ranges are continental outlines, so coarse is fine. */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.05, Math.max(0.002, span / 400));
}

/** Converts one service's rows to polygons with name, kind and era. */
export function normalizeRange(fc: FeatureCollection, historic: boolean): Feature<Geometry>[] {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const name = str(f.properties?.Name) ?? (historic ? "Historic range" : "Current range");
    const kind = historic ? "historic" : /experimental/i.test(name) ? "experimental" : "current";
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: { name, kind, era: historic ? "early 1800s" : "today" },
    });
  }
  return features;
}

const condorRange = defineLayer({
  id: "condor-range",
  title: "California condor range",
  description:
    "Where the California condor, North America's largest flying bird, lives today and where it ranged in the early 1800s, as polygons from the National Park Service. " +
    "Each polygon has name, kind (current: the California range, experimental: the release areas in northern Arizona and southern Utah and in Baja California, or historic: the early 1800s range) and era (today or early 1800s). " +
    "Use it for 'where do condors live', 'can I see a condor here' or 'how much has the condor's range shrunk'. Compare it with species or gbif-occurrences for real sightings. " +
    "Caveats: these are broad range outlines, not nesting sites or flight paths, and a condor can wander far outside them; being inside the outline does not mean condors are likely to be seen. " +
    "The historic outline is a rough reconstruction (the Pacific coast from British Columbia to Baja California and inland to the Rockies). " +
    "Western North America only; elsewhere it returns nothing. Works at any size of region (over 20 million km² it adds a total), so no need to zoom in first.",
  coverage: { bbox: EXTENT },
  surface: "land",
  license: "Public data, terms not stated (National Park Service, Sequoia and Kings Canyon)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  wide: { orderBy: "area", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("condor-range"), fillOpacity: 0.25 },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "National Park Service, Sequoia and Kings Canyon National Parks, California condor current and historic range (public domain)",
      url: "https://www.nps.gov/seki/learn/nature/california-condor.htm",
      retrieved: new Date().toISOString(),
    };

    if (bboxesDisjoint(ctx.bbox, EXTENT)) {
      return {
        kind: "geojson",
        data: EMPTY,
        citation,
        coverageNote: "The condor range maps cover western North America, from British Columbia to Baja California",
      };
    }

    // Wide (over 20 million km²): largest first, capped at the strategy's limit, with a count from each service.
    const params = {
      outFields: ["Name"],
      bbox: ctx.bbox,
      maxAllowableOffset: simplifyOffset(ctx.bbox),
      ...(ctx.wide && { orderByFields: "Shape__Area DESC", resultRecordCount: ctx.wideStrategy?.limit ?? WIDE_LIMIT, withCount: true }),
      ttlSeconds: TTL_SECONDS,
    };
    const [current, historic] = await Promise.all([
      arcgisQuery(ctx, CURRENT_URL, { ...params, cacheSuffix: "condor-current" }),
      arcgisQuery(ctx, HISTORIC_URL, { ...params, cacheSuffix: "condor-historic" }),
    ]);
    if (!current.ok && !historic.ok) return { error: current.error, hint: "upstream" };

    const features = [
      ...(current.ok ? normalizeRange(current.fc, false) : []),
      ...(historic.ok ? normalizeRange(historic.fc, true) : []),
    ];
    const missing = !current.ok ? "current range" : !historic.ok ? "historic range" : undefined;
    const total = current.ok && historic.ok && current.total !== undefined && historic.total !== undefined ? current.total + historic.total : undefined;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(missing !== undefined ? { coverageNote: `The ${missing} could not be loaded, so only the other is shown` } : {}),
    };
  },
});

registerLayer(condorRange);

export default condorRange;

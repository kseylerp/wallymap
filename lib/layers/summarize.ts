import type { Geometry, GeoJsonProperties, Position } from "geojson";
import type { BBox, Citation, LayerError, LayerResult } from "@/layers/types";

/** What the model sees for a geojson result; the full data goes to the map only. */
export type GeojsonSummary = {
  kind: "geojson";
  featureCount: number;
  geometryTypes: Record<string, number>;
  bbox: BBox | null;
  sample: GeoJsonProperties[];
  citation: Citation;
  coverageNote?: string;
};

export type TilesSummary = {
  kind: "tiles";
  url: string;
  minzoom: number;
  maxzoom: number;
  format: "raster" | "vector";
  sourceLayer?: string;
  geometry?: "point" | "line" | "polygon";
  citation: Citation;
  coverageNote?: string;
};

export type LayerResultSummary = GeojsonSummary | TilesSummary;

const SAMPLE_SIZE = 3;

function eachPosition(geometry: Geometry | null, visit: (p: Position) => void): void {
  if (!geometry) return;
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(visit);
      return;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach((ring) => ring.forEach(visit));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(visit)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((g) => eachPosition(g, visit));
      return;
  }
}

/**
 * A small, model-sized view of a layer response: counts, extent, a few sample
 * properties and the citation instead of every feature. Errors pass through.
 */
export function summarizeLayerResult(body: LayerResult | LayerError): LayerResultSummary | LayerError {
  if ("error" in body) return body;

  if (body.kind === "tiles") {
    return {
      kind: "tiles",
      url: body.data.url,
      minzoom: body.data.minzoom,
      maxzoom: body.data.maxzoom,
      format: body.data.format,
      ...(body.data.sourceLayer !== undefined && { sourceLayer: body.data.sourceLayer }),
      ...(body.data.geometry !== undefined && { geometry: body.data.geometry }),
      citation: body.citation,
      ...(body.coverageNote !== undefined && { coverageNote: body.coverageNote }),
    };
  }

  const features = body.data.features;
  const geometryTypes: Record<string, number> = {};
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    const type = feature.geometry?.type ?? "null";
    geometryTypes[type] = (geometryTypes[type] ?? 0) + 1;
    eachPosition(feature.geometry, ([lon, lat]) => {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    });
  }

  return {
    kind: "geojson",
    featureCount: features.length,
    geometryTypes,
    bbox: west <= east ? [west, south, east, north] : null,
    sample: features.slice(0, SAMPLE_SIZE).map((f) => f.properties),
    citation: body.citation,
    ...(body.coverageNote !== undefined && { coverageNote: body.coverageNote }),
  };
}

/** True for a full LayerResult (as opposed to an error or an already-summarized result). */
export function isFullLayerResult(value: unknown): value is LayerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "data" in value &&
    (value.kind === "geojson" || value.kind === "tiles")
  );
}

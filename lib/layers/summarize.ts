import type { Geometry, GeoJsonProperties, Position } from "geojson";
import type { BBox, Citation, LayerError, LayerResult, TileTime } from "@/layers/types";

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
  /** Present when the time scrubber can move this layer: how often it updates and the range it covers. */
  time?: Pick<TileTime, "cadence" | "from" | "to" | "daysBack">;
  citation: Citation;
  coverageNote?: string;
};

export type LayerResultSummary = GeojsonSummary | TilesSummary;

const SAMPLE_SIZE = 3;
/** Longest string value kept in a sample property; longer ones end in an ellipsis. */
export const SAMPLE_VALUE_MAX_CHARS = 120;
/** Most properties kept per sample feature. */
const SAMPLE_MAX_KEYS = 20;
/** Upper bound on the whole sample as JSON; samples are dropped from the end until it fits (one always stays). */
export const SAMPLE_MAX_CHARS = 2_000;

function clip(text: string): string {
  return text.length > SAMPLE_VALUE_MAX_CHARS ? `${text.slice(0, SAMPLE_VALUE_MAX_CHARS - 1)}…` : text;
}

/**
 * A sample feature's properties with every string clipped and nested values flattened to clipped JSON.
 * Properties come from upstream users (OSM names, Commons titles), so this bounds both token cost and
 * how much injected text can reach the model.
 */
function sampleProperties(properties: GeoJsonProperties): GeoJsonProperties {
  if (properties === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties).slice(0, SAMPLE_MAX_KEYS)) {
    const name = clip(key);
    if (typeof value === "string") out[name] = clip(value);
    else if (value === null || typeof value === "number" || typeof value === "boolean") out[name] = value;
    else if (value !== undefined) out[name] = clip(JSON.stringify(value) ?? "");
  }
  return out;
}

/** The first SAMPLE_SIZE features' clipped properties, trimmed from the end to SAMPLE_MAX_CHARS. */
export function sampleOf(features: { properties: GeoJsonProperties }[]): GeoJsonProperties[] {
  const sample = features.slice(0, SAMPLE_SIZE).map((f) => sampleProperties(f.properties));
  while (sample.length > 1 && JSON.stringify(sample).length > SAMPLE_MAX_CHARS) sample.pop();
  return sample;
}

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

/** The scrubbable range without the URL template (the model has no use for it). */
function timeSummary(t: TileTime): NonNullable<TilesSummary["time"]> {
  return {
    cadence: t.cadence,
    from: t.from,
    ...(t.to !== undefined && { to: t.to }),
    ...(t.daysBack !== undefined && { daysBack: t.daysBack }),
  };
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
      ...(body.data.time !== undefined && { time: timeSummary(body.data.time) }),
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
    sample: sampleOf(features),
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

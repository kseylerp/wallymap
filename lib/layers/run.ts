import { z } from "zod";
import { getLayer } from "@/layers/registry";
import {
  BBoxSchema,
  bboxAreaKm2,
  hardMaxAreaKm2,
  type BBox,
  type Layer,
  type LayerError,
  type LayerResult,
  type WideStrategy,
} from "@/layers/types";
import { cacheKeyFor, createLayerFetch } from "@/lib/fetch";
import { withNaturalName } from "@/layers/_shared/names";

export type RunLayerParams = {
  bbox: unknown;
  zoom?: number;
  input?: unknown;
  /**
   * The user's current map view, when this query is answering from it (no place was named or geocoded this turn).
   * An area-cap error then carries `suggestedZoom`, the zoom at which that view fits under the cap.
   */
  fromView?: { bbox: BBox; zoom: number };
};

export type RunLayerResponse = { status: number; body: LayerResult | LayerError };

const DEFAULT_ZOOM = 10;

/** Deepest zoom the map offers. */
const MAX_ZOOM = 22;

/**
 * The whole-number zoom at which a view covering `areaKm2` at `zoom` falls under `capKm2`. Each zoom level halves the
 * width and height, so it quarters the area: the view needs log4(area / cap) more levels, rounded up past the cap.
 */
export function suggestedZoomFor(areaKm2: number, zoom: number, capKm2: number): number {
  if (!(areaKm2 > capKm2) || !(capKm2 > 0)) return Math.min(MAX_ZOOM, Math.ceil(zoom));
  return Math.min(MAX_ZOOM, Math.floor(zoom + Math.log2(areaKm2 / capKm2) / 2) + 1);
}

/** Only the env vars a layer declares, so a layer never sees other secrets. */
function layerEnv(layer: Layer): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of [...layer.requiredEnv, ...(layer.optionalEnv ?? [])]) {
    env[name] = process.env[name];
  }
  return env;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** "largest", "named", "newest": the word for what a wide result kept. */
function keptWord(wide: WideStrategy): string {
  if (wide.mode === "named") return "named";
  return wide.rank ?? "largest";
}

/**
 * The coverage note and truncation for a result fetched with the layer's wide strategy: "Showing the 2,000 largest of
 * 4,512 (ranked by capacity (MW)); zoom in under 250,000 km² for all". A ranked result that kept fewer than its limit and
 * has no count kept everything; a named result without a count always left the unnamed out.
 */
export function wideOutcome(
  layer: Pick<Layer, "maxAreaKm2">,
  wide: WideStrategy,
  result: LayerResult,
): { note: string; truncated: boolean; rankedOut?: string } {
  const zoomFor = `zoom in under ${fmt(layer.maxAreaKm2)} km² for all`;
  if (result.kind === "tiles") {
    return {
      note: `Showing a density map at this scale instead of single features; ${zoomFor}`,
      truncated: true,
      rankedOut: `Single features are not listed over this wide box, only their density as map tiles; ${zoomFor}.`,
    };
  }
  const shown = result.data.features.length;
  const total = result.total !== undefined && result.total >= shown ? result.total : undefined;
  const ranked = wide.orderBy === undefined ? "" : ` (ranked by ${wide.orderBy})`;
  const truncated =
    total !== undefined ? total > shown : wide.mode === "named" ? true : shown >= wide.limit;
  if (!truncated) {
    return { note: `Showing all ${fmt(shown)} in this wide view${ranked}`, truncated: false };
  }
  const word = keptWord(wide);
  const of = total === undefined ? "" : ` of ${fmt(total)}`;
  const by = wide.orderBy === undefined ? "" : ` by ${wide.orderBy}`;
  const left =
    total === undefined
      ? `Any past the ${word} ${fmt(shown)}${by} are left out`
      : wide.mode === "named"
        ? `${fmt(total - shown)} more in this box (unnamed, or past the ${fmt(shown)} named) are left out`
        : `${fmt(total - shown)} more in this box rank below these${by} and are left out`;
  return {
    note: `Showing the ${fmt(shown)} ${word}${of}${ranked}; ${zoomFor}`,
    truncated: true,
    rankedOut: `${left}; featureCount, stats and top cover only the ${fmt(shown)} shown; ${zoomFor}.`,
  };
}

/**
 * Every layer's feature names as people say them ("Oasis, The" → "The Oasis"; layers/_shared/names.ts): OpenBeta,
 * OpenStreetMap and catalogue sources file some names with the article last. Layers that merge sources by name
 * (climbing) already read their names this way before merging.
 */
function naturalNames<R extends LayerResult | LayerError>(result: R): R {
  if ("error" in result || result.kind !== "geojson") return result;
  let changed = false;
  const features = result.data.features.map((f) => {
    const properties = withNaturalName(f.properties);
    if (properties === f.properties) return f;
    changed = true;
    return { ...f, properties };
  });
  return changed ? { ...result, data: { ...result.data, features } } : result;
}

/**
 * Validates a request and runs one registered layer. Shared by the HTTP route
 * and the agent tools, so both return the same statuses. Never throws.
 */
export async function runLayer(id: string, params: RunLayerParams): Promise<RunLayerResponse> {
  const layer = getLayer(id);
  if (!layer) {
    return { status: 404, body: { error: `Unknown layer ${id}` } };
  }

  const bbox = BBoxSchema.safeParse(params.bbox);
  if (!bbox.success) {
    return { status: 400, body: { error: `Invalid bbox: ${z.prettifyError(bbox.error)}` } };
  }

  const input = layer.input.safeParse(params.input ?? {});
  if (!input.success) {
    return { status: 400, body: { error: `Invalid input: ${z.prettifyError(input.error)}` } };
  }

  // Over maxAreaKm2 a layer with a wide strategy answers with a bounded, ranked fetch; only the hard cap is an error.
  const area = bboxAreaKm2(bbox.data);
  const hardMax = hardMaxAreaKm2(layer);
  if (area > hardMax) {
    const body: LayerError = {
      error: `Area is ${Math.round(area)} km²; zoom in to under ${hardMax} km²`,
      hint: "zoom_in",
    };
    // Measured on the view itself: that is what the user would zoom, even when the query box was a part of it.
    if (params.fromView) {
      body.suggestedZoom = suggestedZoomFor(bboxAreaKm2(params.fromView.bbox), params.fromView.zoom, hardMax);
    }
    return { status: 422, body };
  }
  const wide = area > layer.maxAreaKm2 && layer.wide !== undefined ? layer.wide : undefined;

  const missing = layer.requiredEnv.find((name) => !process.env[name]);
  if (missing !== undefined) {
    return {
      status: 503,
      body: { error: `Layer ${id} needs ${missing}`, hint: "unavailable" },
    };
  }

  try {
    const result = await layer.query(
      {
        bbox: bbox.data,
        zoom: params.zoom ?? DEFAULT_ZOOM,
        env: layerEnv(layer),
        fetch: createLayerFetch(id),
        // A wide fetch differs from the plain one for the same box, so it gets its own cache key.
        cacheKey: `${cacheKeyFor(layer.id, bbox.data, input.data)}${wide ? ":wide" : ""}`,
        ...(wide && { wide: true, wideStrategy: wide }),
      },
      input.data,
    );

    if ("error" in result) {
      const status = result.hint === "zoom_in" ? 422 : 503;
      return { status, body: naturalNames(result) };
    }
    const named = naturalNames(result);
    if (!wide) return { status: 200, body: named };
    const outcome = wideOutcome(layer, wide, named);
    const body: LayerResult = {
      ...named,
      coverageNote: [outcome.note, result.coverageNote].filter(Boolean).join("; "),
      ...(outcome.truncated && outcome.rankedOut !== undefined && { truncated: true as const, rankedOut: outcome.rankedOut }),
    };
    return { status: 200, body };
  } catch (err) {
    return { status: 503, body: { error: String(err), hint: "upstream" } };
  }
}

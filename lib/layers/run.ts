import { z } from "zod";
import { getLayer } from "@/layers/registry";
import { BBoxSchema, bboxAreaKm2, type BBox, type Layer, type LayerError, type LayerResult } from "@/layers/types";
import { cacheKeyFor, createLayerFetch } from "@/lib/fetch";

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

  const area = bboxAreaKm2(bbox.data);
  if (area > layer.maxAreaKm2) {
    const body: LayerError = {
      error: `Area is ${Math.round(area)} km²; zoom in to under ${layer.maxAreaKm2} km²`,
      hint: "zoom_in",
    };
    // Measured on the view itself: that is what the user would zoom, even when the query box was a part of it.
    if (params.fromView) {
      body.suggestedZoom = suggestedZoomFor(bboxAreaKm2(params.fromView.bbox), params.fromView.zoom, layer.maxAreaKm2);
    }
    return { status: 422, body };
  }

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
        cacheKey: cacheKeyFor(layer.id, bbox.data, input.data),
      },
      input.data,
    );

    if ("error" in result) {
      const status = result.hint === "zoom_in" ? 422 : 503;
      return { status, body: result };
    }
    return { status: 200, body: result };
  } catch (err) {
    return { status: 503, body: { error: String(err), hint: "upstream" } };
  }
}

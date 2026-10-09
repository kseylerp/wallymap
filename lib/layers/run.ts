import { z } from "zod";
import { getLayer } from "@/layers/registry";
import { BBoxSchema, bboxAreaKm2, type LayerError, type LayerResult } from "@/layers/types";
import { createLayerFetch } from "@/lib/fetch";

export type RunLayerParams = { bbox: unknown; zoom?: number; input?: unknown };

export type RunLayerResponse = { status: number; body: LayerResult | LayerError };

const DEFAULT_ZOOM = 10;

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
    return {
      status: 422,
      body: {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${layer.maxAreaKm2} km²`,
        hint: "zoom_in",
      },
    };
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
        env: process.env,
        fetch: createLayerFetch(id),
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

/**
 * Lets a computed layer call other registered layers' `query` directly. Each call gets the
 * caller's ctx with a distinct cacheKey suffix, so the composed results never share a cache
 * entry with each other or with the caller.
 */
import type { FeatureCollection } from "geojson";
import { getLayer } from "../registry";
import type { LayerError, QueryContext } from "../types";

export type ComposedResult =
  | { ok: true; data: FeatureCollection; coverageNote?: string }
  | { ok: false; error: LayerError };

/** `ctx` with `:${suffix}` appended to its cacheKey (left unset when the caller has none). */
export function subContext(ctx: QueryContext, suffix: string): QueryContext {
  return { ...ctx, cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${suffix}` };
}

/**
 * Runs layer `id` with `rawInput` (defaults applied by its own schema) and returns its features.
 * Never throws: an unknown layer, bad input, a thrown error or a tiles result all come back as errors.
 */
export async function runComposed(
  id: string,
  ctx: QueryContext,
  rawInput: Record<string, unknown>,
  suffix: string,
): Promise<ComposedResult> {
  const layer = getLayer(id);
  if (!layer) return { ok: false, error: { error: `Layer ${id} is not registered`, hint: "unavailable" } };
  const input = layer.input.safeParse(rawInput);
  if (!input.success) return { ok: false, error: { error: `Invalid input for ${id}` } };
  try {
    const result = await layer.query(subContext(ctx, suffix), input.data);
    if ("error" in result) return { ok: false, error: result };
    if (result.kind !== "geojson") return { ok: false, error: { error: `Layer ${id} returned tiles, not features` } };
    return { ok: true, data: result.data, coverageNote: result.coverageNote };
  } catch (err) {
    return { ok: false, error: { error: String(err), hint: "upstream" } };
  }
}

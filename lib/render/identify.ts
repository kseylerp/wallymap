/**
 * A tap on a raster tile layer (a picture with no features to pick) asks the layer's source what is drawn there
 * (POST /api/layer/<id>/identify, Layer.identify): FEMA's flood zone, the wildfire hazard class, the burn severity of
 * the year on screen, the NLCD class of the map year shown. The top visible layer that can answer, answers.
 */
import type { MapState, Selection } from "@/lib/render/state";
import { currentScenarioValue } from "@/lib/render/scenario";
import { periodOfUrl } from "@/lib/time";

export type IdentifyRequest = { layerId: string; body: { lon: number; lat: number; zoom: number; input?: Record<string, unknown>; time?: string; scenario?: number } };

/**
 * The identify requests for a tap, top layer first: every visible raster tile layer that declares identify and draws
 * at this zoom, with the tile period and scenario value on screen. `shown` is the drawn state (lib/render/view.ts
 * `visibleState`), whose tile URLs carry the time window.
 */
export function identifyRequests(state: MapState, shown: MapState["layers"], lngLat: [number, number], zoom: number): IdentifyRequest[] {
  const out: IdentifyRequest[] = [];
  for (const op of [...state.renderOps].reverse()) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded?.identify || loaded.result.kind !== "tiles" || loaded.result.data.format !== "raster") continue;
    const data = loaded.result.data;
    if (zoom < data.minzoom) continue;
    const drawn = shown[op.layerId];
    const url = drawn?.result.kind === "tiles" ? drawn.result.data.url : data.url;
    const period = periodOfUrl(url, data.time);
    const scenario = currentScenarioValue(state, op.layerId);
    out.push({
      layerId: op.layerId,
      body: {
        lon: lngLat[0],
        lat: lngLat[1],
        zoom,
        ...(loaded.input && { input: loaded.input }),
        ...(period !== null && { time: new Date(period).toISOString() }),
        ...(scenario !== undefined && { scenario }),
      },
    });
  }
  return out;
}

/** Asks each layer in turn; the first feature found becomes the selection, else null (also on any failure). */
export async function identifyAt(requests: IdentifyRequest[], screen: { x: number; y: number }, signal?: AbortSignal): Promise<Selection | null> {
  for (const { layerId, body } of requests) {
    try {
      const res = await fetch(`/api/layer/${encodeURIComponent(layerId)}/identify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { feature?: GeoJSON.Feature | null };
      if (json.feature) return { layerId, feature: json.feature, lngLat: [body.lon, body.lat], screen };
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

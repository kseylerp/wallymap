/**
 * The classes in view for raster layers colored by class (forest types): the browser cannot count a picture's pixels,
 * so when the map comes to rest it asks the layer's source how much of the view each class covers
 * (POST /api/layer/<id>/shares, Layer.viewShares) and hands the answer to the legends (lib/render/inView.ts). One
 * request per layer and view; a newer view cancels the older request.
 */
import type { BBox } from "@/layers/types";
import type { MapState } from "@/lib/render/state";
import { currentScenarioValue } from "@/lib/render/scenario";
import { periodOfUrl } from "@/lib/time";
import { setCountedShares, type TileSample } from "@/lib/render/inView";

export type SharesRequest = {
  layerId: string;
  body: { bbox: BBox; zoom: number; input?: Record<string, unknown>; time?: string; scenario?: number };
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The view as a box the server accepts (rounded, inside ±180 and ±85), or null across the antimeridian. */
export function viewBox(bounds: BBox | null): BBox | null {
  if (!bounds) return null;
  const [w, s, e, n] = bounds;
  if (!(w < e)) return null;
  return [round(Math.max(-180, w)), round(Math.max(-85, s)), round(Math.min(180, e)), round(Math.min(85, n))];
}

/** One request per visible raster layer that counts its classes and draws at this zoom, with the period and scenario shown. */
export function sharesRequests(state: MapState, shown: MapState["layers"], bounds: BBox | null, zoom: number): SharesRequest[] {
  const bbox = viewBox(bounds);
  if (!bbox) return [];
  const out: SharesRequest[] = [];
  for (const op of state.renderOps) {
    if (!op.visible) continue;
    const loaded = state.layers[op.layerId];
    if (!loaded?.shares || loaded.result.kind !== "tiles" || loaded.result.data.format !== "raster") continue;
    if (zoom < loaded.result.data.minzoom) continue;
    const drawn = shown[op.layerId];
    const url = drawn?.result.kind === "tiles" ? drawn.result.data.url : loaded.result.data.url;
    const period = periodOfUrl(url, loaded.result.data.time);
    const scenario = currentScenarioValue(state, op.layerId);
    out.push({
      layerId: op.layerId,
      body: {
        bbox,
        zoom: Math.round(zoom * 10) / 10,
        ...(loaded.input && { input: loaded.input }),
        ...(period !== null && { time: new Date(period).toISOString() }),
        ...(scenario !== undefined && { scenario }),
      },
    });
  }
  return out;
}

/** The sample for the legend from the route's answer, or undefined when it has none. */
export function sampleOf(json: unknown): TileSample | undefined {
  if (!json || typeof json !== "object") return undefined;
  const { field, shares } = json as { field?: unknown; shares?: unknown };
  if (typeof field !== "string" || !shares || typeof shares !== "object") return undefined;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(shares as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v) && v > 0) clean[k] = v;
  return { field, values: [], shares: clean };
}

const asked = new Map<string, string>();
let abort: AbortController | undefined;

/**
 * Asks for the shares of every request whose view or settings changed since the last answer, and drops the shares of
 * layers no longer drawn. Answers land in the legends through setCountedShares; failures leave the key listing every class.
 */
export function refreshViewShares(requests: SharesRequest[], fetchImpl: typeof fetch = fetch): void {
  const wanted = new Set(requests.map((r) => r.layerId));
  for (const id of [...asked.keys()]) {
    if (wanted.has(id)) continue;
    asked.delete(id);
    setCountedShares(id, undefined);
  }
  const changed = requests.filter((r) => asked.get(r.layerId) !== JSON.stringify(r.body));
  if (changed.length === 0) return;
  abort?.abort();
  const controller = new AbortController();
  abort = controller;
  for (const { layerId, body } of changed) {
    const key = JSON.stringify(body);
    asked.set(layerId, key);
    void fetchImpl(`/api/layer/${encodeURIComponent(layerId)}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: key,
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : undefined))
      .then((json) => {
        if (controller.signal.aborted || asked.get(layerId) !== key) return;
        setCountedShares(layerId, sampleOf(json));
      })
      .catch(() => {
        // Aborted or failed: forget the ask so the next rest tries again.
        if (asked.get(layerId) === key) asked.delete(layerId);
      });
  }
}

/** Forgets every ask (tests). */
export function resetViewShares(): void {
  asked.clear();
  abort = undefined;
}

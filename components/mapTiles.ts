import type { Map as MapboxMap } from "mapbox-gl";
import type { MapState } from "@/lib/render/state";

const PREFIX = "tiles-";

/**
 * Makes the map's raster sources/layers match the `kind: "tiles"` results in `state`.
 * No-op until the style is loaded; callers re-run it on `style.load` because a style swap drops sources.
 */
export function syncTileLayers(map: MapboxMap, state: MapState): void {
  if (!map.isStyleLoaded()) return;

  const wanted = new Set<string>();
  for (const loaded of Object.values(state.layers)) {
    if (loaded.result.kind !== "tiles") continue;
    const id = `${PREFIX}${loaded.id}`;
    const { url, minzoom, maxzoom } = loaded.result.data;
    wanted.add(id);

    // A reloaded layer may point at a new tile URL; raster sources cannot change URL in place.
    const existing = map.getStyle()?.sources?.[id];
    const existingUrl = existing?.type === "raster" ? existing.tiles?.[0] : undefined;
    if (existing && existingUrl !== url) {
      if (map.getLayer(id)) map.removeLayer(id);
      map.removeSource(id);
    }
    if (!map.getSource(id)) {
      map.addSource(id, { type: "raster", tiles: [url], minzoom, maxzoom, tileSize: 256 });
    }
    if (!map.getLayer(id)) {
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.8 } });
    }

    // Honor a hide toggle if the agent has issued a render op for this layer.
    const op = state.renderOps.find((o) => o.layerId === loaded.id);
    map.setLayoutProperty(id, "visibility", op && !op.visible ? "none" : "visible");
  }

  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.id.startsWith(PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(map.getStyle()?.sources ?? {})) {
    if (sourceId.startsWith(PREFIX) && !wanted.has(sourceId)) map.removeSource(sourceId);
  }
}

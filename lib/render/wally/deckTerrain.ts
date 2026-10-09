import { TERRAIN_EXAGGERATION } from "@/lib/render/wally/terrain";

/**
 * Deck's copy of the map's 3D terrain. The Mapbox overlay draws deck in its own canvas, so deck does not see
 * Mapbox's terrain; to drape lines and polygons on the slopes and stand pins on them, deck loads the same DEM
 * (`mapbox-terrain-dem-v1`, Terrain-RGB encoded) into an invisible TerrainLayer that the TerrainExtension reads.
 */

/** Deck's terrain source layer id (not a data layer: never pickable, never inspected). */
export const DECK_TERRAIN_ID = "wally-terrain";

/**
 * Appended to a data layer's deck id while it drapes on terrain (`fire-perimeters@3d:polygons`). Deck runs a
 * layer extension's setup once, when the layer is created, and keeps what the extension put in the layer's state
 * for good, so a layer cannot gain or lose the terrain extension while live: the 3D switch has to be a new id,
 * which makes deck finalize the old layer and build a new one. See `deckLayerKey` in lib/render/deck.ts.
 */
export const DECK_TERRAIN_TAG = "@3d";

/** Terrain-RGB DEM tiles at 512px (`@2x`), the tileset Mapbox's own terrain uses. */
export function demTileUrl(token: string): string {
  return `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}@2x.pngraw?access_token=${encodeURIComponent(token)}`;
}

/**
 * Terrain-RGB decoding (height = -10000 + (R·65536 + G·256 + B)·0.1 metres) scaled by the map's exaggeration,
 * so deck's surface matches the one Mapbox draws.
 */
export function demDecoder(exaggeration = TERRAIN_EXAGGERATION) {
  return {
    rScaler: 6553.6 * exaggeration,
    gScaler: 25.6 * exaggeration,
    bScaler: 0.1 * exaggeration,
    offset: -10000 * exaggeration,
  };
}

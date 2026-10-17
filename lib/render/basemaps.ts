import type { StyleSpecification } from "mapbox-gl";
import type { Basemap } from "@/lib/render/state";
import { DATA_ONLY_BASEMAP } from "@/lib/render/palette";

const OUTDOORS_STYLE = "mapbox://styles/mapbox/outdoors-v12";
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
/** The data-only basemap is a style object, not a URL; this names it wherever a style is compared by URL. */
export const DATA_ONLY_STYLE = "wallymap:data-only";

/**
 * Mapbox style URL for a basemap. Natural Earth 2 falls back to Outdoors until its Studio style is set.
 * `outdoors-satellite` loads Outdoors; the map adds the satellite imagery on `style.load` (see `components/mapTiles.ts`).
 * `data-only` is WallyMap's own style object (`dataOnlyStyle`); its URL here is only a name.
 */
export function basemapStyleUrl(b: Basemap): string {
  switch (b) {
    case "outdoors-satellite":
    case "outdoors":
      return OUTDOORS_STYLE;
    case "satellite":
      return SATELLITE_STYLE;
    case "natural-earth-2":
      // Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle.
      return process.env.NEXT_PUBLIC_NATURAL_EARTH_STYLE?.trim() || OUTDOORS_STYLE;
    case "data-only":
      return DATA_ONLY_STYLE;
  }
}

/**
 * "Data only" (spec §13: "when a dense network is the answer, the basemap steps back ... so rivers, trails or fire
 * lines outline the land by themselves"): land off-white, water the off-white surface with a dark grey hairline coast,
 * faint country lines, and nothing else: no roads, labels, hillshade or buildings. Drawn from Mapbox Streets' water
 * and admin layers in WallyMap's own palette.
 */
export function dataOnlyStyle(): StyleSpecification {
  const c = DATA_ONLY_BASEMAP;
  return {
    version: 8,
    name: "WallyMap data only",
    glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    sources: { "data-only": { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" } },
    layers: [
      { id: "data-only-land", type: "background", paint: { "background-color": c.land } },
      { id: "data-only-water", type: "fill", source: "data-only", "source-layer": "water", paint: { "fill-color": c.water } },
      {
        id: "data-only-coast",
        type: "line",
        source: "data-only",
        "source-layer": "water",
        paint: { "line-color": c.coast, "line-opacity": c.coastOpacity, "line-width": 0.6 },
      },
      {
        id: "data-only-countries",
        type: "line",
        source: "data-only",
        "source-layer": "admin",
        filter: ["all", ["==", ["get", "admin_level"], 0], ["==", ["get", "maritime"], "false"], ["==", ["get", "disputed"], "false"]],
        paint: { "line-color": c.coast, "line-opacity": c.borderOpacity, "line-width": 0.75, "line-dasharray": [3, 2] },
      },
    ],
  };
}

/** What the map loads for a basemap: a Mapbox style URL, or the data-only style object. */
export function basemapStyle(b: Basemap): string | StyleSpecification {
  return b === "data-only" ? dataOnlyStyle() : basemapStyleUrl(b);
}

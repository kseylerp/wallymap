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
 * "Data only" (spec §13: the basemap steps back so a dense network outlines the land by itself): land off-white, water
 * (sea and lakes) the off-white surface with a dark grey hairline coast, faint country and state lines, and the major
 * cities and the states named in low contrast so you can tell where you are; no roads, hillshade or buildings. Drawn
 * from Mapbox Streets in WallyMap's own palette.
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
        id: "data-only-states",
        type: "line",
        source: "data-only",
        "source-layer": "admin",
        filter: ["all", ["==", ["get", "admin_level"], 1], ["==", ["get", "maritime"], "false"]],
        paint: { "line-color": c.coast, "line-opacity": c.stateOpacity, "line-width": 0.6, "line-dasharray": [2, 2] },
      },
      {
        id: "data-only-countries",
        type: "line",
        source: "data-only",
        "source-layer": "admin",
        filter: ["all", ["==", ["get", "admin_level"], 0], ["==", ["get", "maritime"], "false"], ["==", ["get", "disputed"], "false"]],
        paint: { "line-color": c.coast, "line-opacity": c.borderOpacity, "line-width": 0.75, "line-dasharray": [3, 2] },
      },
      {
        id: "data-only-state-labels",
        type: "symbol",
        source: "data-only",
        "source-layer": "place_label",
        filter: ["==", ["get", "class"], "state"],
        maxzoom: 7,
        layout: {
          "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-size": 10,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.15,
        },
        paint: { "text-color": c.label, "text-opacity": c.labelOpacity * 0.6, "text-halo-color": c.labelHalo, "text-halo-width": 1 },
      },
      {
        id: "data-only-cities",
        type: "symbol",
        source: "data-only",
        "source-layer": "place_label",
        // Major cities first, more as the map zooms in (Mapbox's symbolrank: 1 the largest).
        filter: ["all", ["==", ["get", "class"], "settlement"], ["<=", ["get", "symbolrank"], ["step", ["zoom"], 6, 6, 9, 8, 12]]],
        layout: {
          "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
          "text-font": ["DIN Pro Regular", "Arial Unicode MS Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 10, 12],
        },
        paint: { "text-color": c.label, "text-opacity": c.labelOpacity, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 },
      },
    ],
  };
}

/** What the map loads for a basemap: a Mapbox style URL, or the data-only style object. */
export function basemapStyle(b: Basemap): string | StyleSpecification {
  return b === "data-only" ? dataOnlyStyle() : basemapStyleUrl(b);
}

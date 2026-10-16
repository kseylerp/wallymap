/**
 * Bedrock and surface geology map from Macrostrat (CC BY 4.0), keyless. Tiles only: the "what rock is here" lookup for one point is the
 * separate `geologic-unit` layer, because a point result under this id would replace the loaded tiles on the map.
 *
 * Map: vector tiles https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt (tilejson at /carto/tilejson.json: zoom 0 to 22, world bounds).
 *   Decoded live on 2026-10-09: two source layers, `units` (polygons; properties map_id, source_id, name, age, lith, descrip, t_int, b_int,
 *   best_age_top, best_age_bottom, color as a hex string, ref_*) and `lines` (faults and other contacts; properties type, name, descrip).
 *   Tiles answer at z0 to z16 and beyond (z8 Tahoe: 927 units; z12: 47; z16: 5); the layer draws `units` only, since a tile result
 *   carries one source layer. The map draws them in this layer's palette tint with hatch and outline (the renderer's vector polygon
 *   recipe), not in Macrostrat's per-unit colours. The tile server is a public service run by the Macrostrat team; set no key.
 * Smoke check 2026-10-10 (live, keyless, through runLayer): a tile result with the Macrostrat URL, and tiles fetched at z8, z12 and z16 over Tahoe all 200.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { layerColor } from "@/lib/render/palette";

export const GEOLOGY_TILE_URL = "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt";
export const GEOLOGY_SOURCE_LAYER = "units";

const geology = defineLayer({
  id: "geology",
  title: "Geology",
  description:
    "The geologic map: bedrock and surface rock units from Macrostrat, a compilation of geologic maps (world coverage, most detailed in the United States). " +
    "It draws as map tiles in the layer's tint with a hatch and an outline, so it shows where one unit ends and the next begins; it does not colour rock types differently, and it carries no features you can count or list. " +
    "Use it for 'show the geology', 'geologic map', 'rock types around here', 'where does the rock change'. " +
    "To answer 'what rock is here', 'what is this peak made of' or 'how old is the ground at this spot', call the geologic-unit layer with that place's lon and lat; it returns the unit name, age, rock type and description. " +
    "Caveats: geologic maps are drawn at the scale of their source, so edges are generalised and small outcrops are missed; units can be loose ('undivided granitic rocks'); " +
    "surface deposits like glacial till or alluvium can hide the bedrock below. " +
    "You cannot see the rendered map: say it is shown, do not claim which rock lies where. Works at any size of region.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (Macrostrat; source maps by USGS and geological surveys)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("geology") },

  async query(): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: {
        url: GEOLOGY_TILE_URL,
        minzoom: 0,
        maxzoom: 16,
        format: "vector",
        sourceLayer: GEOLOGY_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source: "Macrostrat geologic map compilation (CC BY 4.0), University of Wisconsin-Madison",
        url: "https://macrostrat.org/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: "Geologic map units from Macrostrat; detail follows each source map's scale, so it is finest in the United States",
    };
  },
});

registerLayer(geology);

export default geology;

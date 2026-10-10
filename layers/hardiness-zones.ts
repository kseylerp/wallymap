/**
 * USDA Plant Hardiness Zones (2023 map) as vector tiles, for the lower 48 states.
 * Tiles (verified live 2026-10-10, keyless, CORS open, gzip-compressed Mapbox vector tiles): a community copy on ArcGIS Online,
 *   https://vectortileservices1.arcgis.com/rKbpcgHXWYYaP4pQ/arcgis/rest/services/phzm_us_zones_shp_2023_view/VectorTileServer/tile/{z}/{y}/{x}.pbf
 *   (item 31d0ab3315844ce38caf45c9c81be8f7, titled "USDA Plant Hardiness Zones 2023"; ArcGIS orders the path z/y/x,
 *   and its 512-pixel tile scheme matches Mapbox vector tiles, level N = Mapbox zoom N).
 * Facts from decoding live tiles (z6 and z10 over Colorado) and the style document (resources/styles/root.json):
 *   - One source layer, `phzm_us_zones_shp_2023`, polygons only, extent 4096 (z6) / 4194304 (z10).
 *   - The only feature property is `_symbol`, an integer index into the zones in order: 0 = 3a, 1 = 3b, 2 = 4a, 3 = 4b,
 *     4 = 5a, 5 = 5b, 6 = 6a, 7 = 6b, 8 = 7a, 9 = 7b, 10 = 8a, 11 = 8b, 12 = 9a, 13 = 9b, 14 = 10a, 15 = 10b, 16 = 11a,
 *     17 = 11b, 18 = 12a (the style has one fill layer per index; the zone itself is not a property).
 *   - Tiles answer at every level 0 to 23; past z10 the geometry stops changing (7.6 KB at z11 to z16 over Denver), so maxzoom 12.
 *   - Bounds -124.813,24.4625 to -66.9125,49.4292: Alaska, Hawaii and Puerto Rico are not in this copy.
 * Smoke (2026-10-10): tiles z0 8 KB, z3 69 KB, z6 15 KB, z8 7 KB, z10 to z16 7.6 KB, all HTTP 200 with access-control-allow-origin *.
 * No upstream call is made by the layer: it only hands the tile URL to the map.
 * Credit: USDA Agricultural Research Service and Oregon State University PRISM Climate Group made the map; the tiles are
 * a third party's copy, not USDA's, so the license and citation name both and say it is a copy.
 */
import { z } from "zod";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const HARDINESS_TILE_URL =
  "https://vectortileservices1.arcgis.com/rKbpcgHXWYYaP4pQ/arcgis/rest/services/phzm_us_zones_shp_2023_view/VectorTileServer/tile/{z}/{y}/{x}.pbf";
export const HARDINESS_SOURCE_LAYER = "phzm_us_zones_shp_2023";

/** The lower 48 states, from the tile service's bounds. */
const LOWER_48: BBox = [-124.813, 24.4625, -66.9125, 49.4292];

const NOTE = "This hardiness map covers the lower 48 states only; Alaska, Hawaii and Puerto Rico are not in it";

const hardinessZones = defineLayer({
  id: "hardiness-zones",
  title: "Plant hardiness zones",
  description:
    "The USDA Plant Hardiness Zone Map (2023 edition) for the lower 48 states: the coldest-winter bands that tell gardeners which perennial plants, shrubs and trees are likely to survive. " +
    "Zones run from 3a (coldest) to 12a (warmest), in half-zones of 5 °F, each based on the average yearly lowest winter temperature over 1991 to 2020, so zone 7a is about 0 to 5 °F and zone 9b about 25 to 30 °F. " +
    "Use it for 'what hardiness zone am I in', 'what grows here', 'where is zone 8' or 'has my growing zone warmed'; about half the country moved to the next warmer half-zone between the 2012 map and this one. " +
    "Returns map tiles drawn on the globe, not features you can count or list, and the tiles carry only a numeric index per band, so you cannot read a place's zone from this layer: say the layer is shown and that the zones are drawn as bands, and for a specific address point the user to the official lookup at planthardiness.ars.usda.gov. " +
    "You cannot see the rendered map. Caveats: zones describe winter cold only, not heat, rainfall, soil or frost dates; local microclimates (cities, valleys, slopes) differ from the zone drawn. " +
    "Lower 48 states only: Alaska, Hawaii and Puerto Rico are missing from this copy. The tiles are a community copy of the USDA map, so credit both USDA and Oregon State. " +
    "Works at any size of region.",
  coverage: "us",
  license: "USDA-ARS / Oregon State University PRISM; community copy; show both credits",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("hardiness-zones"), fillOpacity: 0.3 },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Outside the lower 48 the tiles are simply empty, so they are returned anyway along with the note.
    return {
      kind: "tiles",
      data: {
        url: HARDINESS_TILE_URL,
        minzoom: 0,
        maxzoom: 12,
        format: "vector",
        sourceLayer: HARDINESS_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source:
          "USDA Agricultural Research Service and Oregon State University PRISM Climate Group, 2023 USDA Plant Hardiness Zone Map (community vector-tile copy on ArcGIS Online)",
        url: "https://planthardiness.ars.usda.gov/",
        retrieved: new Date().toISOString(),
      },
      ...(bboxesDisjoint(ctx.bbox, LOWER_48) && { coverageNote: NOTE }),
    };
  },
});

registerLayer(hardinessZones);

export default hardinessZones;

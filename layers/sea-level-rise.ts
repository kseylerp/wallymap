/**
 * Sea level rise inundation from the NOAA Office for Coastal Management Sea Level Rise Viewer: which coastal land would be
 * under water at high tide if the sea rose by 0 to 10 feet.
 *
 * Tile route (verified live 2026-10-10): one pre-tiled MapServer per amount of rise,
 *   https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_{n}ft/MapServer/tile/{z}/{y}/{x}   (n = 0 to 10)
 *   - Web Mercator (wkid 102100), 256 px PNG8, cached "down to Level ID 16" (z 16 answered 200 over Oakland; z 17 404s).
 *     Empty tiles are tiny transparent PNGs (192 bytes) or 404s outside the coast, both of which Mapbox draws as nothing.
 *   - Half-foot services exist too (slr_1_5ft); this layer sticks to whole feet.
 *   - CORS: access-control-allow-origin echoes the Origin. copyrightText "NOAA Office for Coastal Management".
 *   - The service description: inundation of n ft above current Mean Higher High Water (MHHW), drawn as it would appear at
 *     the highest high tides, hydrologically connected areas only; screening level, no erosion, subsidence or future
 *     construction.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 * Live smoke 2026-10-10: slr_3ft z 11 to 16 over Oakland airport [-122.22, 37.72] all 200 (8 to 50 KB);
 * slr_0ft z 12 tile 1015 bytes, slr_3ft 2462, slr_10ft 4332 for the same Bay tile (more water each step); Miami Beach z 13
 * tile 1.8 KB at 0 ft, 7.3 KB at 2 ft, 23.8 KB at 6 ft. runLayer over Miami with feet 2 returned the slr_2ft template in 1 ms.
 */
import { z } from "zod";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint, OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  feet: z.number().int().min(0).max(10).default(3),
});

/** Rough mainland Alaska and the Aleutians east of the antimeridian; NOAA publishes no SLR tiles there. */
const ALASKA: BBox = [-180, 51, -129.5, 72];

export function touchesAlaska(bbox: BBox): boolean {
  return !bboxesDisjoint(bbox, ALASKA);
}

export function slrTileUrl(feet: number): string {
  return `https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_${feet}ft/MapServer/tile/{z}/{y}/{x}`;
}

const seaLevelRise = defineLayer({
  id: "sea-level-rise",
  title: "Sea level rise flooding (NOAA scenarios)",
  description:
    "Map of the US coastal land that would be under water at high tide if the sea rose by a given number of feet, from the NOAA Sea Level Rise Viewer, drawn as blue water over the land. " +
    "feet (0 to 10, default 3) is the rise above today's average highest daily tide (mean higher high water, MHHW); feet 0 shows what high tide already covers. " +
    "Choosing feet: NOAA's 2022 interagency report expects about 1 foot of rise on US coasts between 2020 and 2050 (more on the Gulf and East coasts), so use feet 1 for 'flooding by 2050' and 2 for a high 2050 case; its 2100 scenarios (global average) are 1.0 ft low, 1.6 intermediate-low, 3.3 intermediate, 4.9 intermediate-high and 6.6 high, and most US coasts get somewhat more. " +
    "To show two scenarios, query once with each feet value and describe the difference; the compare tool only moves layers through time, so it cannot switch between feet. " +
    "Example questions: 'What would 3 feet of sea level rise flood in Miami?', 'Which parts of the Bay Area flood by 2050?', 'Is this neighbourhood at risk from rising seas?'. User words: sea level rise, flooding by 2050, coastal flooding. " +
    "Caveats: it is a screening map: no levees failing, storm surge, waves, erosion, land sinking or future construction, and low areas cut off from the sea are left out; do not use it for one house or for insurance. " +
    "Covers the coastal contiguous US, Hawaii, Puerto Rico and the US Virgin Islands; Alaska has no tiles, so it draws nothing there. " +
    "Returns map tiles drawn on the map, not features you can count or list; describe what you see in general terms. Drawn at zoom 16 or less; any size of view.",
  coverage: "us",
  license: "Public domain (NOAA Office for Coastal Management)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("sea-level-rise") },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: `NOAA Office for Coastal Management Sea Level Rise Viewer, ${input.feet} ft inundation above MHHW (public domain)`,
      url: "https://coast.noaa.gov/slr/",
      retrieved: new Date().toISOString(),
    };
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    return {
      kind: "tiles",
      data: { url: slrTileUrl(input.feet), minzoom: 0, maxzoom: 16, format: "raster" },
      citation,
      coverageNote: `Land flooded at high tide with ${input.feet} ft of sea level rise above today's MHHW${touchesAlaska(ctx.bbox) ? "; Alaska has no sea level rise tiles, so nothing draws there" : ""}`,
    };
  },
});

registerLayer(seaLevelRise);

export default seaLevelRise;

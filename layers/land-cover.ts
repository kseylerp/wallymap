/**
 * Land cover raster tiles: ESA WorldCover 10 m (global, 2021, static) or NLCD (US, several map years).
 * Verified 2026-10-09:
 *   - WorldCover WMTS (https://wmts.terrascope.be/?service=WMTS&request=GetCapabilities): layer
 *     esa-worldcover-map-10m-2021-v2_map, TileMatrixSet EPSG:3857 (matrix ids "0".."14"; limits listed for 6 to 14),
 *     one TIME value 2021-01-01, image/png, 256 px, extent -180..180 x -60..83. The REST template in the capabilities
 *     (/esa-worldcover-map-10m-2021-v2/default/{TIME}/...) answers 400 ("Missing WMTS SERVICE parameter"), but the
 *     KVP GetTile used below works and draws the official WorldCover palette. Live check: z=6 (col 33 row 22),
 *     z=10 (538, 357), z=14 and z=0 to 5 all returned 200 image/png (z=10 over Lake Constance: lake, forest, fields, towns).
 *   - NLCD WMS (https://www.mrlc.gov/geoserver/mrlc_display/wms, version 1.1.1, EPSG:3857): the display service holds only
 *     the epoch maps NLCD_{year}_Land_Cover_L48 for 2001, 2004, 2006, 2008, 2011, 2013, 2016, 2019 and 2021 (lower 48,
 *     with Alaska, Hawaii and Puerto Rico under other ids). Live check: 2001 and 2021 returned 200 image/png for a
 *     Pacific Northwest bbox. THE ANNUAL NLCD (1985 to latest) IS NOT ON THIS SERVICE: Annual_NLCD_LndCov_<year>_CU_C1V0
 *     is absent from the mrlc_display, mrlc_download and global capabilities and a GetMap for it returns a service
 *     exception; only the annual change-count and change-index summaries exist. The layer has no time dimension either,
 *     and a `{year}` template would produce unknown layer names for years between epochs, so NLCD is not published
 *     as scrubbable: the `year` input snaps to the epoch at or before it and the model calls the layer once per year to compare.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { wmsTileUrl } from "./_shared/wms";
import { layerColor } from "@/lib/render/palette";

/** Map years the NLCD display service publishes for the lower 48. */
export const NLCD_YEARS = [2001, 2004, 2006, 2008, 2011, 2013, 2016, 2019, 2021] as const;
const NLCD_ENDPOINT = "https://www.mrlc.gov/geoserver/mrlc_display/wms";

const inputSchema = z.object({
  nlcd: z.boolean().default(false),
  year: z.number().int().min(1985).max(2100).optional(),
});

/** WorldCover 2021 v2 as a KVP GetTile template (the REST template in the capabilities does not answer). */
export const WORLDCOVER_URL =
  "https://wmts.terrascope.be/?service=WMTS&request=GetTile&version=1.0.0&layer=esa-worldcover-map-10m-2021-v2_map" +
  "&style=default&tilematrixset=EPSG:3857&tilematrix={z}&tilerow={y}&tilecol={x}&format=image/png&TIME=2021-01-01";

/** The epoch map shown for a requested year: the latest NLCD map year at or before it (null before the first). */
export function nlcdEpoch(year: number): (typeof NLCD_YEARS)[number] | null {
  let found: (typeof NLCD_YEARS)[number] | null = null;
  for (const y of NLCD_YEARS) if (y <= year) found = y;
  return found;
}

export function nlcdTileUrl(epoch: number): string {
  return wmsTileUrl(NLCD_ENDPOINT, `NLCD_${epoch}_Land_Cover_L48`, { version: "1.1.1" });
}

const landCover = defineLayer({
  id: "land-cover",
  title: "Land cover",
  description:
    "Map of what covers the ground: tree cover, shrubland, grassland, cropland, built-up area, bare ground, snow and ice, water, wetland, mangroves and moss. " +
    "By default it is the ESA WorldCover 2021 map, global (60 S to 83 N), 10 m detail, one static year, drawn in the standard WorldCover colors (dark green trees, orange shrub, yellow grass, pink cropland, red built-up, grey bare, blue water, teal wetland). " +
    "Set nlcd to true for the US National Land Cover Database (lower 48 states only, 30 m): year picks a map year and snaps to the latest available at or before it (2001, 2004, 2006, 2008, 2011, 2013, 2016, 2019 or 2021; default 2021). It is not on the time scrubber because only those nine years exist, so to show change call it twice with different years. " +
    "Use it for 'land cover', 'what is the land used for', 'forest vs grassland', 'where are the croplands', 'how much of this area is built up', or what the vegetation type is under a trail or route. " +
    "Example questions: how much forest versus grassland is in this watershed, where is farmland around this town, how did land cover near Portland change between 2001 and 2021. " +
    "Caveats: it is a classified satellite map, so a pixel is a best guess (shrub, grass and cropland are the easiest to confuse); WorldCover has no year-to-year change, and NLCD classes differ slightly from WorldCover's. " +
    "The result's coverageNote states which product and year are shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "CC BY 4.0 (ESA WorldCover); NLCD public domain (USGS / MRLC)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("land-cover"), raster: { saturation: -0.4, opacity: 0.65, swatch: "#6AA84F" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const retrieved = new Date().toISOString();
    if (!input.nlcd) {
      if (input.year !== undefined) {
        return { error: "year only applies to the US map: set nlcd to true (WorldCover is a single 2021 map)" };
      }
      return {
        kind: "tiles",
        data: { url: WORLDCOVER_URL, minzoom: 0, maxzoom: 14, format: "raster" },
        citation: {
          source: "ESA WorldCover 10 m 2021 v2 (CC BY 4.0), contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium; served by VITO Terrascope",
          url: "https://esa-worldcover.org/",
          retrieved,
        },
        coverageNote: "ESA WorldCover 2021 (global, 60 S to 83 N, one static year)",
      };
    }

    const requested = input.year ?? 2021;
    const epoch = nlcdEpoch(requested);
    if (epoch === null) return { error: `NLCD maps start in 2001; ${requested} is earlier` };
    const moved = epoch === requested ? "" : ` (the map nearest at or before ${requested}; NLCD maps exist for ${NLCD_YEARS.join(", ")})`;
    return {
      kind: "tiles",
      data: { url: nlcdTileUrl(epoch), minzoom: 0, maxzoom: 13, format: "raster" },
      citation: {
        source: "USGS Multi-Resolution Land Characteristics (MRLC) National Land Cover Database (public domain)",
        url: "https://www.mrlc.gov/",
        retrieved,
      },
      coverageNote: `NLCD ${epoch} land cover, lower 48 states only${moved}`,
    };
  },
});

registerLayer(landCover);

export default landCover;

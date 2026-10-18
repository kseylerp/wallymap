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
 * 2026-10-18: the legend is WorldCover's official class colors (WORLDCOVER_CLASSES, the colors its tiles draw), and an NLCD answer
 * publishes its nine map years as a tile scenario (`{value}` in the layer name), so the map can step and swipe between
 * NLCD years without a second call. Each answer carries its product's own key (LAND_COVER_LEGEND or NLCD_LEGEND, NLCD's
 * class colors from NLCD_CLASSES), so the key never describes the other product.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec, type TileScenario } from "./types";
import { registerLayer } from "./registry";
import { wmsTileUrl } from "./_shared/wms";
import { isLayerError, pointFeature, wmsFeatureInfo } from "./_shared/identify";
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

export function nlcdTileUrl(epoch: number | string): string {
  return wmsTileUrl(NLCD_ENDPOINT, `NLCD_${epoch}_Land_Cover_L48`, { version: "1.1.1" });
}

/** ESA WorldCover 2021 classes with the colors its tiles draw (the product's own legend). */
export const WORLDCOVER_CLASSES: { value: number; label: string; color: string }[] = [
  { value: 10, label: "Tree cover", color: "#006400" },
  { value: 20, label: "Shrubland", color: "#FFBB22" },
  { value: 30, label: "Grassland", color: "#FFFF4C" },
  { value: 40, label: "Cropland", color: "#F096FF" },
  { value: 50, label: "Built-up", color: "#FA0000" },
  { value: 60, label: "Bare or sparse vegetation", color: "#B4B4B4" },
  { value: 70, label: "Snow and ice", color: "#F0F0F0" },
  { value: 80, label: "Permanent water", color: "#0064C8" },
  { value: 90, label: "Herbaceous wetland", color: "#0096A0" },
  { value: 95, label: "Mangroves", color: "#00CF75" },
  { value: 100, label: "Moss and lichen", color: "#FAE6A0" },
];

/** NLCD classes with the colors its tiles draw (the MRLC legend), for an answer with nlcd on. */
export const NLCD_CLASSES: { value: number; label: string; color: string }[] = [
  { value: 11, label: "Open water", color: "#466B9F" },
  { value: 12, label: "Perennial ice and snow", color: "#D1DEF8" },
  { value: 21, label: "Developed, open space", color: "#DEC5C5" },
  { value: 22, label: "Developed, low intensity", color: "#D99282" },
  { value: 23, label: "Developed, medium intensity", color: "#EB0000" },
  { value: 24, label: "Developed, high intensity", color: "#AB0000" },
  { value: 31, label: "Barren land", color: "#B3AC9F" },
  { value: 41, label: "Deciduous forest", color: "#68AB5F" },
  { value: 42, label: "Evergreen forest", color: "#1C5F2C" },
  { value: 43, label: "Mixed forest", color: "#B5C58F" },
  { value: 52, label: "Shrub and scrub", color: "#CCB879" },
  { value: 71, label: "Grassland", color: "#DFDFC2" },
  { value: 81, label: "Pasture and hay", color: "#DCD939" },
  { value: 82, label: "Cultivated crops", color: "#AB6C28" },
  { value: 90, label: "Woody wetlands", color: "#B8D9EB" },
  { value: 95, label: "Emergent herbaceous wetlands", color: "#6C9FB8" },
];

/** WorldCover's key: the layer's own, and the one a WorldCover answer carries. */
export const LAND_COVER_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Land cover (ESA WorldCover 2021)",
  items: WORLDCOVER_CLASSES.map(({ value, label, color }) => ({ label, value, color, symbol: "raster" as const })),
  note: "WorldCover's own class colors; one map year (2021), 10 m detail.",
};

/** NLCD's key, carried by an NLCD answer so the map is never keyed in WorldCover's colors. */
export const NLCD_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Land cover (US NLCD)",
  items: NLCD_CLASSES.map(({ value, label, color }) => ({ label, value, color, symbol: "raster" as const })),
  note: "NLCD's own class colors; lower 48 states only, 30 m detail.",
};

/** The NLCD map years as a scenario: the map steps and swipes between them by filling `{value}` in the layer name. */
export const NLCD_SCENARIO: TileScenario = {
  param: "year",
  label: "NLCD map year",
  // The readout prints the value then the unit: "2016 NLCD".
  unit: "NLCD",
  values: [...NLCD_YEARS],
  template: nlcdTileUrl("{value}"),
};

const landCover = defineLayer({
  id: "land-cover",
  title: "Land cover",
  description:
    "Map of what covers the ground: tree cover, shrubland, grassland, cropland, built-up area, bare ground, snow and ice, water, wetland, mangroves and moss. " +
    "By default it is the ESA WorldCover 2021 map, global (60 S to 83 N), 10 m detail, one static year, drawn in the standard WorldCover colors (dark green trees, orange shrub, yellow grass, pink cropland, red built-up, grey bare, blue water, teal wetland), which the legend names. " +
    "Set nlcd to true for the US National Land Cover Database (lower 48 states only, 30 m): year picks a map year and snaps to the latest available at or before it (2001, 2004, 2006, 2008, 2011, 2013, 2016, 2019 or 2021; default 2021). It is not on the time scrubber because only those nine years exist; instead the map steps and swipes between the nine years (the scenario control), so for change call it once with nlcd and compare two years there. " +
    "Use it for 'land cover', 'what is the land used for', 'forest vs grassland', 'where are the croplands', 'how much of this area is built up', or what the vegetation type is under a trail or route. " +
    "Example questions: how much forest versus grassland is in this watershed, where is farmland around this town, how did land cover near Portland change between 2001 and 2021. " +
    "Caveats: it is a classified satellite map, so a pixel is a best guess (shrub, grass and cropland are the easiest to confuse); WorldCover has no year-to-year change, and NLCD classes differ slightly from WorldCover's. " +
    "The result's coverageNote states which product and year are shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (ESA WorldCover); NLCD public domain (USGS / MRLC)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("land-cover"), raster: { saturation: -0.4, opacity: 0.65, swatch: "#6AA84F" } },
  legend: LAND_COVER_LEGEND,
  // WorldCover is one map (2021); NLCD's nine years step through the tile scenario instead of a scrubber.
  time: { shape: "single", dates: ["2021"] },
  card: { facts: [{ key: "cover", label: "Land cover" }, { key: "year", label: "Map year" }] },

  // A tap on the NLCD map asks MRLC for the class there (GetFeatureInfo PALETTE_INDEX); WorldCover's tiles have no
  // feature-info service, so a tap there opens nothing.
  async identify(ctx, at, input) {
    if (!input.nlcd) return null;
    const asked = at.scenario !== undefined ? Number(at.scenario) : (input.year ?? 2021);
    const epoch = nlcdEpoch(Number.isFinite(asked) ? asked : 2021);
    if (epoch === null) return null;
    const props = await wmsFeatureInfo(ctx, NLCD_ENDPOINT, `NLCD_${epoch}_Land_Cover_L48`, at);
    if (props === null || isLayerError(props)) return props;
    const cls = NLCD_CLASSES.find((c) => c.value === Number(props.PALETTE_INDEX));
    if (!cls) return null;
    return pointFeature(at, { name: cls.label, cover: cls.label, year: `NLCD ${epoch}` });
  },

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
        legend: LAND_COVER_LEGEND,
      };
    }

    const requested = input.year ?? 2021;
    const epoch = nlcdEpoch(requested);
    if (epoch === null) return { error: `NLCD maps start in 2001; ${requested} is earlier` };
    const moved = epoch === requested ? "" : ` (the map nearest at or before ${requested}; NLCD maps exist for ${NLCD_YEARS.join(", ")})`;
    return {
      kind: "tiles",
      data: { url: nlcdTileUrl(epoch), minzoom: 0, maxzoom: 13, format: "raster", scenario: NLCD_SCENARIO },
      citation: {
        source: "USGS Multi-Resolution Land Characteristics (MRLC) National Land Cover Database (public domain)",
        url: "https://www.mrlc.gov/",
        retrieved,
      },
      coverageNote: `NLCD ${epoch} land cover, lower 48 states only${moved}`,
      legend: NLCD_LEGEND,
    };
  },
});

registerLayer(landCover);

export default landCover;

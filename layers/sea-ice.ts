/**
 * Sea ice raster tiles from NASA GIBS, daily.
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - AMSRU2_Sea_Ice_Concentration_12km (the brief's example) is DEAD for current dates: its time dimension ends
 *     2025-09-01 (AMSR2 / GCOM-W1), and a 2026 date returns 404. The layer does not use it.
 *   - GHRSST_L4_MUR_Sea_Ice_Concentration ("sea ice concentration", GHRSST L4 MUR): daily from 2002-06-01 to 2026-10-08
 *     with one-day holes, GoogleMapsCompatible_Level7 (zoom 0 to 7), image/png. Newest day offered is 2 days back.
 *     Live check: Arctic tile z=2 row 0 col 1 for 2026-09-15 and 2026-10-05 returned 200 image/png (8 to 10 KB; a colored
 *     concentration ramp over the pack ice).
 *   - MODIS_Terra_Sea_Ice ("sea ice extent" from MODIS Terra): daily from 2000-02-24 to the present (latest 2026-10-10),
 *     Level7, image/png. Live check: same tile 200 (6.6 KB, ice drawn in pink; cloud gaps).
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 * Colors (colormaps GHRSST_Sea_Ice_Concentration.xml and MODIS_L2_Sea_Ice.xml, read 2026-10-18; an Arctic tile for
 *   2026-10-16 holds mostly 88 to 100%): concentration runs purple (10%) through blue (40%), green (60%), yellow (75%),
 *   red (88%) to pale pink (100%), 0% clear; extent draws sea ice #FF6464 and lake ice #FFFFB0. The tiles are drawn as
 *   served and the legend lists those colors; the old 60% desaturation drew mauve and white while the text said warm.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { dateInput } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  product: z.enum(["concentration", "extent"]).default("concentration"),
  date: dateInput,
});

export const SPECS: Record<"concentration" | "extent", GibsDatedSpec> = {
  concentration: {
    gibsId: "GHRSST_L4_MUR_Sea_Ice_Concentration",
    level: 7,
    from: "2002-06-01",
    daysBack: 2,
    cadence: "daily",
    label: "sea ice concentration maps",
    citationSource: "NASA GIBS: GHRSST Level 4 MUR sea ice concentration (NASA JPL PO.DAAC; public)",
  },
  extent: {
    gibsId: "MODIS_Terra_Sea_Ice",
    level: 7,
    from: "2000-02-24",
    daysBack: 1,
    cadence: "daily",
    label: "sea ice extent maps",
    citationSource: "NASA GIBS: MODIS Terra sea ice extent (NASA NSIDC DAAC / MODIS; public)",
  },
};

/** The concentration product's ramp in GIBS's colors (the default product). */
export const CONCENTRATION_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Sea ice concentration",
  unit: "%",
  items: [
    { label: "Scattered ice, under 25%", value: "0-25", color: "#B800B8", symbol: "raster" },
    { label: "Open pack, 25 to 50%", value: "25-50", color: "#0084FF", symbol: "raster" },
    { label: "Broken ice, 50 to 70%", value: "50-70", color: "#44C100", symbol: "raster" },
    { label: "Close pack, 70 to 85%", value: "70-85", color: "#FFD400", symbol: "raster" },
    { label: "Very close pack, 85 to 95%", value: "85-95", color: "#FF5555", symbol: "raster" },
    { label: "Solid ice, 95 to 100%", value: "95-100", color: "#FFE6E6", symbol: "raster" },
  ],
  note: "Open water is clear. The extent product instead draws sea ice coral pink (#FF6464) and lake ice pale yellow.",
};

/** The extent product's classes (MODIS_L2_Sea_Ice.xml), for a key when extent is shown. */
export const EXTENT_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Sea ice extent",
  items: [
    { label: "Sea ice", value: "sea-ice", color: "#FF6464", symbol: "raster" },
    { label: "Lake ice", value: "lake-ice", color: "#FFFFB0", symbol: "raster" },
  ],
  note: "Clear where there is open water, cloud or polar night.",
};

/** What the colors mean, per product, for the answer's note. */
const PRODUCT_COLORS: Record<"concentration" | "extent", string> = {
  concentration: "red to pale pink is solid pack ice (85 to 100%), yellow and green broken ice, blue and purple scattered ice at the edge; open water clear",
  extent: "coral pink is sea ice, pale yellow lake ice; clear is open water, cloud or polar night",
};

const seaIce = defineLayer({
  id: "sea-ice",
  title: "Sea ice",
  description:
    "Global daily maps of sea ice in the Arctic and around Antarctica, from NASA GIBS. " +
    "product concentration (default) is the share of the sea surface covered by ice from the GHRSST MUR analysis, in NASA's colors: red to pale pink for nearly solid pack ice (85 to 100%), yellow and green for broken ice (50 to 85%), blue and purple for scattered ice at the edge (under 50%), open water clear; daily from June 2002 to about 2 days ago. " +
    "product extent is the MODIS Terra ice-or-not map: sea ice in coral pink and lake ice pale yellow, daily from February 2000 to yesterday, sharper but gapped under cloud and in polar night. " +
    "date (YYYY-MM-DD) picks the day and defaults to the newest; use the time scrubber or compare to see the seasonal cycle or to compare the same date in different years (September is the Arctic minimum, March the maximum). " +
    "Use it for 'sea ice', 'how much ice is in the Arctic', 'is the Northwest Passage open', 'ice edge', 'has the ice shrunk since 2005'. " +
    "Example questions: where is the Arctic ice edge now, compare September ice in 2012 and this year, is Hudson Bay frozen yet. " +
    "Caveats: lake ice, glaciers and ice sheets are not sea ice (Greenland's ice sheet is not drawn); concentration is a modelled blend of satellite readings so thin or melting ice is uncertain near the coast, and a round or wedge-shaped patch right at the North Pole is filled in where the satellites cannot see, not measured; the map shows area covered, not thickness. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the product day shown (and when a date was moved to the newest available). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "water",
  license: "NASA GIBS / GHRSST MUR and MODIS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // Drawn as served, so the key's colors are the pixels' (the old calm filter turned the red pack ice mauve and white).
  style: { geometry: "polygon", color: layerColor("sea-ice"), raster: { saturation: 0, opacity: 0.85, swatch: "#FF8080" } },
  legend: CONCENTRATION_LEGEND,

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const r = gibsDatedResult(SPECS[input.product], input.date);
    if (!("kind" in r) || r.kind !== "tiles") return r;
    return { ...r, coverageNote: `${r.coverageNote}; ${PRODUCT_COLORS[input.product]}` };
  },
});

registerLayer(seaIce);

export default seaIce;

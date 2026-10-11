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
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
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

const seaIce = defineLayer({
  id: "sea-ice",
  title: "Sea ice",
  description:
    "Global daily maps of sea ice in the Arctic and around Antarctica, from NASA GIBS. " +
    "product concentration (default) is the share of the sea surface covered by ice from the GHRSST MUR analysis: a color ramp where warm colors mean nearly solid ice and cool colors mean scattered ice near the edge, with open water left clear; daily from June 2002 to about 2 days ago. " +
    "product extent is the MODIS Terra ice-or-not map: ice shown in pink, daily from February 2000 to yesterday, sharper but gapped under cloud and in polar night. " +
    "date (YYYY-MM-DD) picks the day and defaults to the newest; use the time scrubber or compare to see the seasonal cycle or to compare the same date in different years (September is the Arctic minimum, March the maximum). " +
    "Use it for 'sea ice', 'how much ice is in the Arctic', 'is the Northwest Passage open', 'ice edge', 'has the ice shrunk since 2005'. " +
    "Example questions: where is the Arctic ice edge now, compare September ice in 2012 and this year, is Hudson Bay frozen yet. " +
    "Caveats: lake ice, glaciers and ice sheets are not sea ice; concentration is a modelled blend of satellite readings so thin or melting ice is uncertain near the coast; the map shows area covered, not thickness. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the product day shown (and when a date was moved to the newest available). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS / GHRSST MUR and MODIS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("sea-ice"), raster: { saturation: -0.6, brightnessMax: 0.92, swatch: "#BFE8FF" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    return gibsDatedResult(SPECS[input.product], input.date);
  },
});

registerLayer(seaIce);

export default seaIce;

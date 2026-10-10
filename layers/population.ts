/**
 * Population density raster tiles from NASA GIBS (SEDAC Gridded Population of the World v4).
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - Layer ids GPW_Population_Density_2000, _2005, _2010, _2015 and _2020 exist ("Population Density (GPW, 2020)").
 *     The newest, GPW_Population_Density_2020, is used.
 *   - TileMatrixSet GoogleMapsCompatible_Level7 (so zoom 0 to 7), format image/png, 256 px tiles.
 *   - The layer has NO time dimension. A dated URL (".../default/2020-01-01/...") returns 403, while the
 *     "default" time token works, so the template is built as gibsTileUrl(id, "default", 7)
 *     = .../GPW_Population_Density_2020/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png
 *   - Live check: z=3 y=3 x=2 returned 200 image/png (10 KB); z=7 returned 200; z=8 returns 400.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { gibsTileUrl } from "./_shared/gibs";
import { layerColor } from "@/lib/render/palette";

const GIBS_LAYER_ID = "GPW_Population_Density_2020";
/** GoogleMapsCompatible_Level7: the finest zoom this layer is published at. */
const GIBS_LEVEL = 7;

const population = defineLayer({
  id: "population",
  title: "Population density",
  description:
    "Global map of where people live, drawn as a coloured raster from NASA's Gridded Population of the World (GPW v4) for the year 2020. " +
    "Colour shows estimated people per square kilometre, with darker or hotter colours meaning more crowded places. " +
    "Use it to show cities, populated regions and empty wilderness side by side, anywhere in the world, from the whole globe down to about city scale. " +
    "Caveats: the figures are modelled estimates built from national census data, not a count, and they are projected to 2020, so newer growth is missing. " +
    "The detail is coarse (roughly 1 km cells, and the tiles stop zooming in past about city-district scale), and it says nothing about how many people are present at a given moment, for example tourists. " +
    "It is a single fixed year, so it cannot show change over time. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "NASA GIBS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("population") },

  async query(): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: {
        url: gibsTileUrl(GIBS_LAYER_ID, "default", GIBS_LEVEL),
        minzoom: 0,
        maxzoom: GIBS_LEVEL,
        format: "raster",
      },
      citation: {
        source:
          "NASA GIBS: SEDAC Gridded Population of the World v4, population density 2020 (CIESIN, Columbia University; public)",
        url: "https://earthdata.nasa.gov/gibs",
        retrieved: new Date().toISOString(),
      },
      coverageNote: "Population density for 2020 (modelled estimate)",
    };
  },
});

registerLayer(population);

export default population;

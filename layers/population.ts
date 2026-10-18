/**
 * Population density raster tiles from NASA GIBS (SEDAC Gridded Population of the World v4), five epochs.
 * Verified 2026-10-09 against https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml:
 *   - Layer ids GPW_Population_Density_2000, _2005, _2010, _2015 and _2020 exist ("Population Density (GPW, 2020)");
 *     all five answered 200 for z5 x6 y12 on 2026-10-18. Each epoch is its own layer, so the year is a scenario
 *     (TileScenario, `{value}` in the layer id): the scenario stepper moves between the five and compare puts two side by
 *     side. The time shape is snapshots at those five years.
 *   - TileMatrixSet GoogleMapsCompatible_Level7 (so zoom 0 to 7), format image/png, 256 px tiles.
 *   - The layers have NO time dimension. A dated URL (".../default/2020-01-01/...") returns 403, while the
 *     "default" time token works, so the template is built as gibsTileUrl(id, "default", 7)
 *     = .../GPW_Population_Density_2020/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png
 *   - Live check: z=3 y=3 x=2 returned 200 image/png (10 KB); z=7 returned 200; z=8 returns 400.
 *   - Colormap GPW_Population_Density_2020.xml (identical for every epoch): persons per km² from cream #FFF2D1 (under 1)
 *     through orange (25 to 250) to dark red #BD0026 (1,000 and more). Drawn as served so the key matches.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec, type TileScenario } from "./types";
import { registerLayer } from "./registry";
import { gibsTileUrl } from "./_shared/gibs";
import { layerColor } from "@/lib/render/palette";

/** GoogleMapsCompatible_Level7: the finest zoom this layer is published at. */
const GIBS_LEVEL = 7;
/** The GPW v4 epochs GIBS publishes. */
export const YEARS = [2000, 2005, 2010, 2015, 2020] as const;

export function populationTileUrl(year: number | "{value}"): string {
  return gibsTileUrl(`GPW_Population_Density_${year}`, "default", GIBS_LEVEL);
}

/** The scenario stepper's contract: the same URL with `{value}` for the year, over the five epochs. */
export const POPULATION_SCENARIO: TileScenario = {
  param: "year",
  label: "Population estimate for",
  unit: "estimate",
  values: [...YEARS],
  template: populationTileUrl("{value}"),
};

/** GIBS's classes in persons per km² (each class's middle color). */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "People per km²",
  unit: "people/km²",
  items: [
    { label: "Under 1 (empty land)", value: 0, color: "#FFF2D1", symbol: "raster" },
    { label: "1 to 5", value: 1, color: "#FFE6BB", symbol: "raster" },
    { label: "5 to 25", value: 5, color: "#FBC16C", symbol: "raster" },
    { label: "25 to 250 (farmland, small towns)", value: 25, color: "#FD8D3C", symbol: "raster" },
    { label: "250 to 1,000 (towns, suburbs)", value: 250, color: "#E12A21", symbol: "raster" },
    { label: "1,000 and more (cities)", value: 1000, color: "#BD0026", symbol: "raster" },
  ],
};

const inputSchema = z.object({
  year: z
    .union([z.literal(2000), z.literal(2005), z.literal(2010), z.literal(2015), z.literal(2020)])
    .default(2020)
    .describe("Which GPW estimate: 2000, 2005, 2010, 2015 or 2020 (default)"),
});

const population = defineLayer({
  id: "population",
  title: "Population density",
  description:
    "Global map of where people live, drawn as a coloured raster from NASA's Gridded Population of the World (GPW v4), with estimates for 2000, 2005, 2010, 2015 and 2020 (year, default 2020). " +
    "Colour shows estimated people per square kilometre: cream under 1 (empty land), yellow-orange 5 to 25, orange 25 to 250, red 250 to 1,000 and dark red 1,000 and more (cities). " +
    "Use it to show cities, populated regions and empty wilderness side by side, anywhere in the world, from the whole globe down to about city scale, or to compare two years (the stepper moves between the five estimates; compare puts two side by side). " +
    "Caveats: the figures are modelled estimates built from national census data, not a count, and the newest is projected to 2020, so later growth is missing. " +
    "The detail is coarse (roughly 1 km cells, and the tiles stop zooming in past about city-district scale), and it says nothing about how many people are present at a given moment, for example tourists. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "NASA GIBS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("population"), raster: { saturation: 0, opacity: 0.75, swatch: "#FD8D3C" } },
  legend: LEGEND,
  time: { shape: "snapshots", dates: YEARS.map(String), step: "year" },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const year = input.year ?? 2020;
    return {
      kind: "tiles",
      data: {
        url: populationTileUrl(year),
        minzoom: 0,
        maxzoom: GIBS_LEVEL,
        format: "raster",
        scenario: POPULATION_SCENARIO,
      },
      citation: {
        source: `NASA GIBS: SEDAC Gridded Population of the World v4, population density ${year} (CIESIN, Columbia University; public)`,
        url: "https://earthdata.nasa.gov/gibs",
        retrieved: new Date().toISOString(),
      },
      coverageNote: `Population density for ${year} (modelled estimate, people per km²); estimates exist for 2000, 2005, 2010, 2015 and 2020`,
    };
  },
});

registerLayer(population);

export default population;

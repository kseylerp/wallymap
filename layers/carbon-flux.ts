/**
 * Forest greenhouse gas flux tiles from Global Forest Watch (Harris et al. 2021, Gibbs et al. 2025): net flux (default),
 * gross emissions or gross removals, averaged per year over 2001 to 2025, 30 m.
 * Tile routes (verified 2026-10-10 against https://tiles.globalforestwatch.org/openapi.json and live requests):
 *   https://tiles.globalforestwatch.org/gfw_forest_carbon_net_flux/latest/dynamic/{z}/{x}/{y}.png?tree_cover_density_threshold=30
 *   https://tiles.globalforestwatch.org/gfw_forest_carbon_gross_emissions/latest/dynamic/...
 *   https://tiles.globalforestwatch.org/gfw_forest_carbon_gross_removals/latest/dynamic/...
 * Notes from live requests:
 *   - `latest` answers 307 to v20260327 (fetch and Mapbox follow it). Tiles are 256 x 256 RGBA PNG (not 512 like tree
 *     cover loss); emissions also take `scale` (1 = 256 px), left at its default.
 *   - tree_cover_density_threshold masks pixels by year-2000 canopy (default 30 upstream, sent explicitly here).
 *   - Net flux draws sinks green and sources purple; removals green; emissions purple, transparent where none.
 *   - Units (GFW data API metadata): Mg CO2e per hectare per year, the 2001-2025 average; licence CC BY 4.0.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 * Colors (sampled 2026-10-18): net flux draws sinks from pale sage (211,218,200), the usual intact-forest value, to green
 * (158,192,159), and sources from lilac (165,125,217) to deep purple (123,59,127). The pale sinks washed into a grey haze on
 * Topo (audit 2026-10-17), so the tiles draw with more saturation and contrast instead of the default desaturation.
 * Live smoke 2026-10-10 over Rondonia, Brazil (-60, -5): z 3, 8 and 12 tiles all 200 for all three products
 * (net flux z 8 54 KB: green forest with purple clearing along the roads); runLayer with product emissions returned the
 * gross emissions template in 2 ms.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { layerColor } from "@/lib/render/palette";

const DATASETS = {
  "net-flux": "gfw_forest_carbon_net_flux",
  emissions: "gfw_forest_carbon_gross_emissions",
  removals: "gfw_forest_carbon_gross_removals",
} as const;

const LABELS = {
  "net-flux": "Forest greenhouse gas net flux",
  emissions: "Forest greenhouse gas gross emissions",
  removals: "Forest carbon gross removals",
} as const;

const inputSchema = z.object({
  product: z.enum(["net-flux", "emissions", "removals"]).default("net-flux"),
});

/** Net flux (the default): purple sources through neutral to green sinks, in the tiles' own colors. */
export const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Forest carbon, 2001–2025 average",
  unit: "Mg CO₂e per hectare per year",
  stops: [
    { label: "Source: gives off more than it takes up", color: "#7B3B7F" },
    { label: "About even", color: "#E9E7DD" },
    { label: "Sink: takes up more than it gives off", color: "#9EC09F" },
  ],
  note: "Most standing forest is a mild sink and draws pale green; strong purple marks clearing, fire or logging. Product emissions draws purple only, removals green only.",
};

export function carbonTileUrl(product: keyof typeof DATASETS): string {
  return `https://tiles.globalforestwatch.org/${DATASETS[product]}/latest/dynamic/{z}/{x}/{y}.png?tree_cover_density_threshold=30`;
}

const carbonFlux = defineLayer({
  id: "carbon-flux",
  title: "Forest carbon flux",
  description:
    "Global map of how much carbon forests take up (sink, green) or give off (source, purple), in tonnes of CO2 equivalent per hectare per year averaged over 2001 to 2025, from Global Forest Watch (Harris et al. 2021, updated 2025), 30 m pixels where tree canopy was at least 30% in 2000. " +
    "product picks the map: 'net-flux' (default) is emissions minus removals, green where the forest is a carbon sink (absorbs more CO2 than it releases) and purple where it is a source (loss from clearing, fire or logging released more); " +
    "'emissions' is gross greenhouse gas emissions from tree cover loss (purple, transparent where none); 'removals' is CO2 absorbed by growing forest (green). " +
    "Values are megagrams (tonnes) of CO2 equivalent per hectare per year, averaged over 2001 to 2025; it is one long-term average, not a yearly series. " +
    "Example questions: 'Is the Amazon still a carbon sink?', 'Where are forests releasing carbon in Borneo?', 'How much CO2 do the forests here absorb?'. User words: carbon, carbon sink, forest carbon. " +
    "Caveats: it covers forests only, not cities, farms or the ocean; it is modelled from tree cover loss and growth rates, so a single pixel is uncertain; burned forest that regrows still shows the emission. " +
    "Returns map tiles drawn on the map, not features you can count or list; describe the pattern in general terms. Works at any size of region.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (Harris et al. 2021, Gibbs et al. 2025, via Global Forest Watch)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // More saturation and contrast than the tiles carry, so the pale sinks read on green Topo instead of a grey haze.
  style: { geometry: "polygon", color: layerColor("carbon-flux"), raster: { saturation: 0.4, contrast: 0.25, opacity: 0.85, swatch: "#9EC09F" } },
  legend: LEGEND,
  // One long-term average, not a series.
  time: { shape: "single", span: { start: "2001", end: "2025" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: { url: carbonTileUrl(input.product), minzoom: 2, maxzoom: 12, format: "raster" },
      citation: {
        source:
          `${LABELS[input.product]}, 2001-2025 average (Mg CO2e/ha/yr). Harris et al., Nature Climate Change 11 (2021); ` +
          "Gibbs et al., ESSD 17 (2025); via Global Forest Watch (CC BY 4.0)",
        url: "https://www.globalforestwatch.org/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: `${LABELS[input.product]}, Mg CO2e per hectare per year averaged over 2001-2025, forests with at least 30% canopy; ${input.product === "net-flux" ? "green = sink, purple = source" : input.product === "emissions" ? "purple = emissions" : "green = removals"}`,
    };
  },
});

registerLayer(carbonFlux);

export default carbonFlux;

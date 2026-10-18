/**
 * USFS Wildfire Hazard Potential (WHP) 2023, classified, from the Rocky Mountain Research Station.
 * Service (verified live 2026-10-09, keyless ArcGIS ImageServer, Web Mercator, 270 m cells):
 *   https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer
 *   pixel values 1 to 7: Very Low, Low, Moderate, High, Very High, Non-burnable, Water (legend endpoint). Value 0 is no data.
 * `exportImage` with format=png32&noData=0&noDataInterpretation=esriNoDataMatchAny returns a transparent PNG where
 * there is no data; without it the ocean and Canada come back black. Tiles checked for CONUS, Alaska and Hawaii
 * (data, 13 to 33 KB) and Canada and Puerto Rico (blank, 334 bytes). The service's own colours run green (very low),
 * light yellow, yellow, orange, red (very high), with grey non-burnable land and blue water.
 * The layer returns a raster tile template and makes no upstream call.
 * Colors (2026-10-18): a Colormap rendering rule redraws the classes on the palette's ordinal ramp, low sage, moderate
 * orange, high pink, very high purple (lib/render/ramp scoreLine at 0, 1/3, 2/3 and 1), and leaves very low, non-burnable
 * and water transparent so the relief and roads read through (audit 2026-10-17: opaque, no key, brown vs green unreadable).
 * Checked near McCall, Idaho (z9): 61,080 of 65,536 pixels drew in the four colors; non-burnable and water were clear.
 * Smoke through runLayer (2026-10-09): Montana bbox returns the tile template (200); a European bbox returns an empty
 * result with the outside-the-US note (the check is the rough US extent, so Canada near the border still gets tiles, which
 * are blank there). Live tiles fetched through the produced template: Montana z7 37 KB in 0.4 s.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { imageServerExportTileUrl } from "./_shared/arcgis-tiles";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";
import type { LegendSpec } from "./types";
import { imageServerIdentify, isLayerError, pointFeature } from "./_shared/identify";

const SERVICE =
  "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer";

/** Low to very high on the palette's ordinal ramp; very low, non-burnable (6) and water (7) are left out, so transparent. */
export const CLASS_COLORS: { value: number; label: string; hex: string; help: string }[] = [
  { value: 2, label: "Low", hex: "#9FB693", help: "Fire would usually be easy to control." },
  { value: 3, label: "Moderate", hex: "#DF914D", help: "Fire could be hard to control under dry, windy weather." },
  { value: 4, label: "High", hex: "#E25CA7", help: "Fuels and terrain favour intense fire that is hard to control." },
  { value: 5, label: "Very high", hex: "#6E5BFF", help: "The hardest places to control a wildfire." },
];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const RENDERING_RULE = encodeURIComponent(
  JSON.stringify({ rasterFunction: "Colormap", rasterFunctionArguments: { Colormap: CLASS_COLORS.map((c) => [c.value, ...rgb(c.hex)]) } }),
);

export const WHP_TILE_URL = `${imageServerExportTileUrl(SERVICE, { noData: 0 })}&renderingRule=${RENDERING_RULE}`;

export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Wildfire hazard potential",
  items: CLASS_COLORS.map((c) => ({ label: c.label, value: c.value, color: c.hex, symbol: "raster" as const, help: c.help })),
  note: "Very low hazard, land that cannot burn (rock, farmland, towns) and water are left clear. A long-run rating, not today's fire danger.",
};

const fireHazard = defineLayer({
  id: "fire-hazard",
  title: "Wildfire hazard potential",
  description:
    "Map of where a wildfire would be hardest to control in the United States, from the US Forest Service Wildfire Hazard Potential index (2023 version, 270 m cells), drawn as map tiles in four colors: low (sage green), moderate (orange), high (pink) and very high (purple); very low hazard, land that cannot burn and water are left clear. " +
    "Use it for 'fire risk', 'how fire-prone is this area', 'where would a wildfire be intense' or when weighing a trip, campsite or home against fire danger. " +
    "Caveats: it ranks the long-run chance of a hard-to-manage fire from fuels, past burn probability and fire intensity modelling; it is not a forecast of fire this season, not today's fire danger or weather, and not a map of past fires (use fire-perimeters and fire-detections for those). " +
    "A high class does not mean a fire is burning or likely this year, and a low class does not make a place safe. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms. " +
    "Covers the 50 US states; outside them the result is empty. Works at any size of region inside the US.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USDA Forest Service)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  // The rendering rule already draws the palette's ramp: as served, at 70% so relief and roads stay readable.
  style: { geometry: "polygon", color: layerColor("fire-hazard"), raster: { saturation: 0, opacity: 0.7, swatch: "#E25CA7" } },
  legend: LEGEND,
  time: { shape: "single", dates: ["2023"] },
  card: { facts: [{ key: "hazard", label: "Wildfire hazard" }, { key: "meaning", label: "What it means" }] },

  // A tap on the tiles asks the ImageServer for the class there (the pixel value 1 to 7).
  async identify(ctx, at) {
    const value = await imageServerIdentify(ctx, SERVICE, at);
    if (value === null || isLayerError(value)) return value;
    const n = Number(value);
    const shown = CLASS_COLORS.find((c) => c.value === n);
    const other: Record<number, [string, string]> = {
      1: ["Very low", "Fire would be easy to control; drawn clear."],
      6: ["Land that cannot burn", "Rock, farmland, towns or bare ground."],
      7: ["Water", "Lakes, rivers and the sea."],
    };
    const [label, meaning] = shown ? [shown.label, shown.help] : (other[n] ?? [`Class ${value}`, ""]);
    return pointFeature(at, { name: `${label} wildfire hazard`, hazard: label, ...(meaning && { meaning }) });
  },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source:
        "USDA Forest Service, Rocky Mountain Research Station (Dillon, G.K.), Wildfire Hazard Potential 2023, classified (public domain)",
      url: "https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-hazard-potential",
      retrieved: new Date().toISOString(),
    };
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    return {
      kind: "tiles",
      data: { url: WHP_TILE_URL, minzoom: 3, maxzoom: 12, format: "raster", tileSize: 256 },
      citation,
    };
  },
});

registerLayer(fireHazard);

export default fireHazard;

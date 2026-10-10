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

const SERVICE =
  "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer";

export const WHP_TILE_URL = imageServerExportTileUrl(SERVICE, { noData: 0 });

const fireHazard = defineLayer({
  id: "fire-hazard",
  title: "Wildfire hazard potential",
  description:
    "Map of where a wildfire would be hardest to control in the United States, from the US Forest Service Wildfire Hazard Potential index (2023 version, 270 m cells), drawn as map tiles in five classes: very low (green), low, moderate, high and very high (red), plus grey for land that cannot burn and blue for water. " +
    "Use it for 'fire risk', 'how fire-prone is this area', 'where would a wildfire be intense' or when weighing a trip, campsite or home against fire danger. " +
    "Caveats: it ranks the long-run chance of a hard-to-manage fire from fuels, past burn probability and fire intensity modelling; it is not a forecast of fire this season, not today's fire danger or weather, and not a map of past fires (use fire-perimeters and fire-detections for those). " +
    "A high class does not mean a fire is burning or likely this year, and a low class does not make a place safe. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms. " +
    "Covers the 50 US states; outside them the result is empty. Works at any size of region inside the US.",
  coverage: "us",
  license: "Public domain (USDA Forest Service)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("fire-hazard") },

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

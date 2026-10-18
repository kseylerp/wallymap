/**
 * Fire Weather Index (fire danger) raster tiles from the EU/JRC fire information systems GWIS and EFFIS, by date.
 * Verified 2026-10-09:
 *   - GWIS WMS https://maps.wild-fire.eu/gwis (version 1.3.0, EPSG:3857 supported): layer ecmwf.fwi, a GLOBAL FWI from
 *     ECMWF forecasts. Time dimension declared 2018-01-01/2099-12-31, but real data: first day 2024-01-01 (GetMap with
 *     time=2023-12-31 returns a 334-byte empty tile), last day 2026-10-18 (nine days ahead of today; 2026-10-19 is empty).
 *     Live check: US west, southern Africa, Europe, Brazil, Australia and India all returned drawn tiles for 2026-09-20.
 *   - EFFIS WMS https://maps.effis.emergency.copernicus.eu/effis (1.3.0, EPSG:3857): layer mf010.fwi, Meteo-France 10 km FWI
 *     for Europe only: data from 2024-05-31 to 2026-10-12 (three days ahead; 10-13 empty). Tiles over the US, Australia,
 *     India, Africa south of the Sahara, Siberia and Canada were empty; Iceland, Arctic Norway, the Azores, the Mediterranean
 *     and eastern Europe drew, so it is offered as `region: "europe"`.
 *   - A date with no data returns a valid 334-byte empty PNG (not an error), so the layer clamps dates itself.
 *   - Key (2026-10-18): GWIS's GetLegendGraphic for ecmwf.fwi (the same image for EFFIS mf010.fwi) names six classes by FWI
 *     value: Low under 11.2, Moderate 11.2-21.3, High 21.3-38, Very high 38-50, Extreme 50-70, Very extreme over 70; the
 *     swatch colors below were read from that image. The tiles draw as served (no desaturation) so they match the key.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { dateInput, dateNote, resolveTileDate } from "./_shared/dated-tiles";
import { wmsTileUrl } from "./_shared/wms";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  region: z.enum(["global", "europe"]).default("global"),
  date: dateInput,
});

type Region = z.infer<typeof inputSchema>["region"];

export const MODELS: Record<Region, { endpoint: string; layer: string; from: string; daysAhead: number; source: string; url: string }> = {
  global: {
    endpoint: "https://maps.wild-fire.eu/gwis",
    layer: "ecmwf.fwi",
    from: "2024-01-01",
    daysAhead: 9,
    source: "Global Wildfire Information System (GWIS), EC Joint Research Centre / Copernicus: ECMWF Fire Weather Index",
    url: "https://gwis.jrc.ec.europa.eu/",
  },
  europe: {
    endpoint: "https://maps.effis.emergency.copernicus.eu/effis",
    layer: "mf010.fwi",
    from: "2024-05-31",
    daysAhead: 3,
    source: "European Forest Fire Information System (EFFIS), Copernicus Emergency Management Service: Meteo-France 10 km Fire Weather Index",
    url: "https://forest-fire.emergency.copernicus.eu/",
  },
};

/** The six FWI danger classes as GWIS and EFFIS draw them (colors read from their legend image). */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Fire Weather Index (fire danger)",
  field: "FWI",
  items: [
    { label: "Low (under 11.2)", color: "#9CFFC0", symbol: "raster", help: "Fires start with difficulty and stay small." },
    { label: "Moderate (11.2–21.3)", color: "#CDE24E", symbol: "raster", help: "Fires can start and spread on dry days." },
    { label: "High (21.3–38)", color: "#E6AC00", symbol: "raster", help: "Fires start easily and spread quickly." },
    { label: "Very high (38–50)", color: "#D97010", symbol: "raster", help: "Intense fires, hard to control." },
    { label: "Extreme (50–70)", color: "#AD060E", symbol: "raster", help: "Fires spread fast and resist control." },
    { label: "Very extreme (over 70)", color: "#3A0015", symbol: "raster", help: "Explosive fire behaviour possible." },
  ],
  note: "Danger from weather alone, for one day, about 25 km per block (global) or 10 km (Europe); not a map of fires. US Red Flag Warnings are in weather-alerts.",
  imageUrl: "https://maps.wild-fire.eu/gwis?service=WMS&version=1.3.0&request=GetLegendGraphic&layer=ecmwf.fwi&format=image/png&sld_version=1.1.0",
};

export function fwiTileUrl(region: Region, time: string): string {
  const m = MODELS[region];
  return wmsTileUrl(m.endpoint, m.layer, { time });
}

const fireWeather = defineLayer({
  id: "fire-weather",
  title: "Fire weather (fire danger)",
  description:
    "Daily forecast map of fire danger: the Canadian Fire Weather Index (FWI), a number built from temperature, humidity, wind and recent rain that says how easily a fire would start and spread if one began. " +
    "Colors follow GWIS's six classes: low (mint, FWI under 11.2), moderate (yellow-green, 11.2-21.3), high (amber, 21.3-38), very high (orange, 38-50), extreme (red, 50-70) and very extreme (near black, over 70); it is danger from weather and fuel dryness, not a map of actual fires. For a US red flag warning (the official fire-weather alert) use weather-alerts with event 'red flag'. " +
    "region global (default) is the ECMWF forecast from GWIS, worldwide at coarse resolution (tens of kilometres); region europe is the sharper Meteo-France 10 km model from EFFIS, Europe, the Mediterranean and North Africa's coast only. " +
    "Data runs daily from January 2024 (May 2024 for europe) to about 9 days ahead for global (3 for europe); date (YYYY-MM-DD) picks the day and defaults to today, so it also works as a forecast, and the time scrubber or compare steps through days. " +
    "Use it for 'fire danger', 'fire weather', 'is it a high fire risk day', 'red flag conditions', 'will the fire spread', 'fire season outlook' for a place. " +
    "Example questions: how high is the fire danger in southern California this week, is Portugal at extreme fire risk tomorrow, compare fire danger on the day of the fire with a week before. " +
    "For actual fires use fire-detections and fire-perimeters. " +
    "Caveats: it is a coarse model, so a single canyon or valley can differ a lot, and it ignores whether an ignition source or fuel actually exists; the very newest days are forecasts and change with each model run; nothing is available before 2024. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the day shown (and when a date was moved into the available range). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "land",
  license: "EC JRC GWIS / EFFIS (Copernicus; free and open, credit required)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // Drawn in the source's own class colors so the key matches; 75% so the relief shows through the 25 km blocks.
  style: { geometry: "polygon", color: layerColor("fire-weather"), raster: { saturation: 0, opacity: 0.6, swatch: "#E6AC00" } },
  legend: LEGEND,
  time: { shape: "continuous", step: "day" },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const m = MODELS[input.region];
    const choice = resolveTileDate(
      input.date,
      { from: m.from, latestOffsetDays: m.daysAhead, defaultOffsetDays: 0, label: "fire weather forecasts" },
    );
    if (!choice.ok) return { error: choice.error };
    return {
      kind: "tiles",
      data: {
        url: fwiTileUrl(input.region, choice.date),
        minzoom: 0,
        maxzoom: 12,
        format: "raster",
        // Negative daysBack lets the scrubber run ahead of today, into the forecast days.
        time: { template: fwiTileUrl(input.region, "{date}"), cadence: "daily", from: m.from, daysBack: -m.daysAhead },
      },
      citation: { source: m.source, url: m.url, retrieved: new Date().toISOString() },
      coverageNote: dateNote("Fire Weather Index", choice.date, choice.note),
    };
  },
});

registerLayer(fireWeather);

export default fireWeather;

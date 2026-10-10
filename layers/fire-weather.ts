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
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
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

export function fwiTileUrl(region: Region, time: string): string {
  const m = MODELS[region];
  return wmsTileUrl(m.endpoint, m.layer, { time });
}

const fireWeather = defineLayer({
  id: "fire-weather",
  title: "Fire weather (fire danger)",
  description:
    "Daily forecast map of fire danger: the Canadian Fire Weather Index (FWI), a number built from temperature, humidity, wind and recent rain that says how easily a fire would start and spread if one began. " +
    "Colors run from green (low) through yellow and orange to red and dark red (very high to extreme); it is danger from weather and fuel dryness, not a map of actual fires. " +
    "region global (default) is the ECMWF forecast from GWIS, worldwide at about 25 km; region europe is the sharper Meteo-France 10 km model from EFFIS, Europe, the Mediterranean and North Africa's coast only. " +
    "Data runs daily from January 2024 (May 2024 for europe) to about 9 days ahead for global (3 for europe); date (YYYY-MM-DD) picks the day and defaults to today, so it also works as a forecast, and the time scrubber or compare steps through days. " +
    "Use it for 'fire danger', 'fire weather', 'is it a high fire risk day', 'red flag conditions', 'will the fire spread', 'fire season outlook' for a place. " +
    "Example questions: how high is the fire danger in southern California this week, is Portugal at extreme fire risk tomorrow, compare fire danger on the day of the fire with a week before. " +
    "For actual fires use fire-detections and fire-perimeters. " +
    "Caveats: it is a coarse model, so a single canyon or valley can differ a lot, and it ignores whether an ignition source or fuel actually exists; the very newest days are forecasts and change with each model run; nothing is available before 2024. " +
    "The result's coverageNote states the day shown (and when a date was moved into the available range). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  license: "EC JRC GWIS / EFFIS (Copernicus; free and open, credit required)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("fire-weather") },

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
        time: { template: fwiTileUrl(input.region, "{date}"), cadence: "daily", from: m.from },
      },
      citation: { source: m.source, url: m.url, retrieved: new Date().toISOString() },
      coverageNote: dateNote("Fire Weather Index", choice.date, choice.note),
    };
  },
});

registerLayer(fireWeather);

export default fireWeather;

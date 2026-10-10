/**
 * Spring arrival (USA National Phenology Network "Spring Indices", first leaf and first bloom) anomaly raster tiles.
 * Verified 2026-10-09 against https://geoserver.usanpn.org/geoserver/wms?service=WMS&request=GetCapabilities (version 1.3.0):
 *   - si-x:leaf_anomaly and si-x:bloom_anomaly: "Spring Indices, Daily Anomaly": days earlier or later than the 30-year
 *     average, current year only, daily, time values 2026-01-01 to 2026-09-08 (the dimension lists each day; the latest day
 *     is about 31 days behind today, so the newest day offered is 31 days back). GeoServer answers a time past the end with
 *     the last day's image instead of an error, so the layer clamps itself.
 *   - si-x:leaf_anomaly_prism and si-x:bloom_anomaly_prism: "Historical Annual Anomaly (1981-Previous Year)": yearly,
 *     time values 1981-01-01 to 2024-01-01 (P1Y); used when a `year` is asked for (and as the scrubber's yearly series).
 *     The `_historic` variants (2016 to 2024) and Alaska layers exist but are not used.
 *   - All answered 200 image/png for EPSG:3857 GetMap (US bbox, 256 px); extent is the lower 48 (-125 to -66.5 E, 24 to 50 N).
 *     Legend (GetLegendGraphic): red = days early, blue = days late, white = no difference, 2 to 20 days.
 *   - `time=2026-04-15` and the full `2026-04-15T07:00:00.000Z` both work; a plain date is used.
 * The current-year layer has no earlier years, so the template and `from` change with the mode.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { dateInput, dateNote, resolveTileDate } from "./_shared/dated-tiles";
import { wmsTileUrl } from "./_shared/wms";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://geoserver.usanpn.org/geoserver/wms";
/** The current-year daily series runs about this many days behind today. */
export const DAYS_BACK = 31;
/** First and last year of the historical annual series. */
export const ANNUAL_FROM = 1981;
export const ANNUAL_TO = 2024;

const inputSchema = z.object({
  stage: z.enum(["leaf", "bloom"]).default("leaf"),
  date: dateInput,
  year: z.number().int().optional(),
});

export function dailyTileUrl(stage: "leaf" | "bloom", time: string): string {
  return wmsTileUrl(ENDPOINT, `si-x:${stage}_anomaly`, { time });
}

export function annualTileUrl(stage: "leaf" | "bloom", year: number | "{year}"): string {
  return wmsTileUrl(ENDPOINT, `si-x:${stage}_anomaly_prism`, { time: `${year}-01-01` });
}

const phenology = defineLayer({
  id: "phenology",
  title: "Spring arrival (leaf-out and bloom)",
  description:
    "US map of whether spring has arrived earlier or later than usual, from the USA National Phenology Network's Spring Indices (a model of when plants first leaf out or first flower, driven by daily temperature), lower 48 states only, about 4 km. " +
    "The color is the difference in days from the 30-year average: reds mean spring came that many days early (up to 20), blues mean days late, white is about normal. " +
    "stage leaf (default) is first leaf-out (new leaves on lilac and honeysuckle, a proxy for the start of the growing season); stage bloom is first bloom. " +
    "Without year it shows the current year, one image per day, up to about a month ago; date (YYYY-MM-DD, this calendar year) picks the day and defaults to the newest, and the time scrubber steps through the days. " +
    "With year (1981 to 2024) it shows that whole spring's anomaly, one image per year, so use it, or compare, to ask whether spring is arriving earlier over the decades. " +
    "Use it for 'spring arrived', 'has spring come early this year', 'when do the trees leaf out', 'early or late spring', 'growing season start', 'bloom timing'. " +
    "Example questions: did spring arrive early in the Northeast this year, was 2012 a record-early spring, compare leaf-out in 1990 and 2020 for the Midwest. " +
    "Caveats: it is a temperature-based model (calibrated on lilac and honeysuckle), not a satellite view of actual leaves, so it can be off for high mountains, evergreen forest and desert; Alaska and the rest of the world are not covered; the current year does not run to today and the latest annual map is 2024. " +
    "The result's coverageNote states the stage and day or year shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "us",
  license: "USA-NPN Spring Indices (public domain, USGS / USA National Phenology Network)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("phenology") },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const retrieved = new Date(now).toISOString();
    const citation = {
      source: "USA National Phenology Network, Extended Spring Indices anomaly (SI-x; PRISM and NCEP based)",
      url: "https://www.usanpn.org/data/maps/spring",
      retrieved,
    };
    const stageName = input.stage === "leaf" ? "First leaf" : "First bloom";

    if (input.year !== undefined) {
      if (input.date !== undefined) return { error: "Give either date (this year, daily) or year (a past year), not both" };
      if (input.year < ANNUAL_FROM) return { error: `Spring index maps start in ${ANNUAL_FROM}; ${input.year} is earlier` };
      const year = Math.min(input.year, ANNUAL_TO);
      const note = year === input.year ? "" : ` (${input.year} is not published yet; the newest annual map is ${ANNUAL_TO})`;
      return {
        kind: "tiles",
        data: {
          url: annualTileUrl(input.stage, year),
          minzoom: 0,
          maxzoom: 10,
          format: "raster",
          time: { template: annualTileUrl(input.stage, "{year}"), cadence: "yearly", from: String(ANNUAL_FROM), to: String(ANNUAL_TO) },
        },
        citation,
        coverageNote: `${stageName} spring index anomaly for ${year}, days early (red) or late (blue) versus the 30-year average, lower 48 states only${note}`,
      };
    }

    const from = `${new Date(now).getUTCFullYear()}-01-01`;
    const choice = resolveTileDate(input.date, { from, latestOffsetDays: -DAYS_BACK, label: "daily spring index maps" }, now);
    if (!choice.ok) return { error: choice.error };
    return {
      kind: "tiles",
      data: {
        url: dailyTileUrl(input.stage, choice.date),
        minzoom: 0,
        maxzoom: 10,
        format: "raster",
        time: { template: dailyTileUrl(input.stage, "{date}"), cadence: "daily", from, daysBack: DAYS_BACK },
      },
      citation,
      coverageNote: `${dateNote(`${stageName} spring index anomaly`, choice.date, choice.note)}, days early (red) or late (blue) versus the 30-year average, lower 48 states only`,
    };
  },
});

registerLayer(phenology);

export default phenology;

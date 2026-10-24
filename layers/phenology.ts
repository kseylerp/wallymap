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
 * After 30 June (2026-10-18 audit: the default window was 19 Aug to 17 Sep, long after spring, and nothing moved) the
 *   daily series ends at 30 June (`time.to`) and the default day is 30 June, the season's final map.
 * Drawn as served with NPN's GetLegendGraphic image as the key; the renderer's default calm filter greyed the red and blue.
 * The annual series still ends at 2024 (GetCapabilities 2026-10-18); a 2025 request returns a fallback image, not 2025.
 * The anomaly views make no upstream call: the layer only builds the URL for the map to fetch.
 *
 * `view: "greenup"` (spec T10 "Green-up timing") answers "when does spring usually green up here" from satellites
 * instead of the model: MODIS Land Cover Dynamics on Earth Engine (lib/ee/greenup.ts), 2001 to 2025, worldwide, 500 m.
 * Tiles of the usual (median) green-up day on the sage → pink → purple ramp through our own route
 * (app/api/ee/tiles/phenology/...), one compute for the box's green-up day each year, a note with the usual date and
 * how early or late the latest year came, and the months strip (how many years greened up in each month). The anomaly
 * view adds the same sentence to its note when Earth Engine is set up and the box is local (GREENUP_NOTE_MAX_KM2).
 */
import { z } from "zod";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type LegendSpec, type MonthlyStrip, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { dateInput, dateNote, resolveTileDate } from "./_shared/dated-tiles";
import { pointFeature } from "./_shared/identify";
import { dayText, median, monthOfDay, MONTH_NAMES } from "./_shared/months";
import { wmsTileUrl } from "./_shared/wms";
import { createEeClient, eeConfigured, EeError } from "@/lib/ee/client";
import { GREENUP_FROM, GREENUP_QUERY, GREENUP_TO, pointExpression, RAMP, RAMP_FROM_DAY, RAMP_TO_DAY, readYears, yearsExpression, type GreenupYears } from "@/lib/ee/greenup";
import { eeTileTemplate } from "@/lib/ee/tiles";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://geoserver.usanpn.org/geoserver/wms";
/** The current-year daily series runs about this many days behind today. */
export const DAYS_BACK = 31;
/** First and last year of the historical annual series. */
export const ANNUAL_FROM = 1981;
export const ANNUAL_TO = 2024;
/** Month and day by which first leaf and first bloom have happened across the lower 48; the daily map stops changing. */
export const SPRING_END = "06-30";
/** The NPN key for the anomaly maps (GetLegendGraphic, 20 days early in dark red to 20 days late in navy; read 2026-10-18). */
export const LEGEND_URL = `${ENDPOINT}?service=WMS&version=1.1.1&request=GetLegendGraphic&format=image/png&layer=si-x:leaf_anomaly`;

const inputSchema = z.object({
  view: z.enum(["anomaly", "greenup"]).optional(),
  stage: z.enum(["leaf", "bloom"]).default("leaf"),
  date: dateInput,
  year: z.number().int().optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

/** The anomaly view adds the usual green-up date to its note for boxes up to this size (one quick Earth Engine read). */
export const GREENUP_NOTE_MAX_KM2 = 250_000;
const MODIS_SOURCE = "NASA MODIS Land Cover Dynamics (MCD12Q2 v6.1, 500 m, public domain), via Google Earth Engine";
const MODIS_URL = "https://lpdaac.usgs.gov/products/mcd12q2v061/";

/** The usual green-up key: early sage, late purple, labelled with dates. */
export const GREENUP_LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Usual spring green-up date",
  field: "usual",
  unit: "day of year",
  stops: [RAMP_FROM_DAY, (RAMP_FROM_DAY + RAMP_TO_DAY) / 2, RAMP_TO_DAY].map((day, i) => ({ label: `${i === 0 ? "By " : i === 2 ? "From " : ""}${dayText(day)}`, value: day, color: RAMP[i] })),
  note: `The median date, ${GREENUP_FROM}–${GREENUP_TO}, when satellite greenness first rose 15% of the way to its summer peak. Blank: water, bare ground, towns.`,
};

export type GreenupReading = { usual: number; latest: { year: number; day: number }; earliest: { year: number; day: number }; last: { year: number; day: number }; years: number };

/** The usual (median) day, the latest year and the earliest and latest springs, from each year's day over the box. */
export function greenupReading(years: GreenupYears): GreenupReading | null {
  if (years.length < 5) return null;
  const usual = median(years.map((y) => y.day)) as number;
  const sorted = [...years].sort((a, b) => a.day - b.day);
  return { usual, latest: years[years.length - 1], earliest: sorted[0], last: sorted[sorted.length - 1], years: years.length };
}

/** "3 days early", "9 days late", "about on time (1 day late)". */
export function earlyLate(diff: number): string {
  const d = Math.round(Math.abs(diff));
  const days = `${d} day${d === 1 ? "" : "s"}`;
  if (d <= 2) return d === 0 ? "right on the usual date (0 days early or late)" : `about on time (${days} ${diff < 0 ? "early" : "late"})`;
  return `${days} ${diff < 0 ? "early" : "late"}`;
}

/** The sentence the note opens with: the usual date, the latest year against it, the range of springs. */
export function greenupSentence(where: string, r: GreenupReading): string {
  const span = `${GREENUP_FROM}–${r.latest.year}`;
  return (
    `Spring green-up ${where} usually arrives about ${dayText(r.usual)} (in ${MONTH_NAMES[monthOfDay(r.usual).month]}; median of ${span}, MODIS satellite greenness); ` +
    `in ${r.latest.year} it came on ${dayText(r.latest.day)}, ${earlyLate(r.latest.day - r.usual)}. ` +
    `The earliest spring was ${r.earliest.year} (${dayText(r.earliest.day)}) and the latest ${r.last.year} (${dayText(r.last.day)})`
  );
}

/** The strip: how many years greened up in each month, with the usual date marked. */
export function greenupStrip(place: string, years: GreenupYears, r: GreenupReading): MonthlyStrip {
  const counts: number[] = Array.from({ length: 12 }, () => 0);
  for (const y of years) counts[monthOfDay(y.day).month] += 1;
  const at = monthOfDay(r.usual);
  return {
    place,
    period: `${GREENUP_FROM}–${r.latest.year}`,
    rows: [{ kind: "cells", key: "greenup", label: "Green-up", unit: "years", values: counts, legend: `Shade: how many of the ${r.years} springs (${GREENUP_FROM}–${r.latest.year}) greened up in that month` }],
    mark: { month: at.month, fraction: at.fraction, label: `Usual green-up, ${dayText(r.usual)}` },
    source: "NASA MODIS",
  };
}

const eeReady = (env: Record<string, string | undefined>) => Boolean(env.EE_PROJECT) && eeConfigured(env);

const eeFailure = (error: unknown): LayerError =>
  error instanceof EeError
    ? { error: error.sourceStatus.message, hint: /not set up/.test(error.sourceStatus.message) ? "unavailable" : "upstream", sourceStatus: error.sourceStatus }
    : { error: String(error), hint: "upstream" };

async function readGreenup(ctx: QueryContext, bbox: BBox): Promise<{ years: GreenupYears; reading: GreenupReading | null }> {
  const years = readYears(await createEeClient({ env: ctx.env }).compute(yearsExpression(bbox)));
  return { years, reading: greenupReading(years) };
}

export function dailyTileUrl(stage: "leaf" | "bloom", time: string): string {
  return wmsTileUrl(ENDPOINT, `si-x:${stage}_anomaly`, { time });
}

export function annualTileUrl(stage: "leaf" | "bloom", year: number | "{year}"): string {
  return wmsTileUrl(ENDPOINT, `si-x:${stage}_anomaly_prism`, { time: `${year}-01-01` });
}

/** The greenup view: the usual green-up picture, the box's dates in the note and the months strip. */
async function greenupAnswer(ctx: QueryContext, name: string | undefined): Promise<LayerResult | LayerError> {
  if (!eeReady(ctx.env)) return { error: "Green-up dates come from MODIS on Google Earth Engine, which is not set up on this server", hint: "unavailable" };
  let read: Awaited<ReturnType<typeof readGreenup>>;
  try {
    read = await readGreenup(ctx, ctx.bbox);
  } catch (error) {
    return eeFailure(error);
  }
  const where = name ? `around ${name}` : "in the area asked";
  const place = name ?? "the area asked";
  return {
    kind: "tiles",
    data: { url: eeTileTemplate("phenology", GREENUP_QUERY), minzoom: 3, maxzoom: 12, format: "raster" },
    citation: { source: MODIS_SOURCE, url: MODIS_URL, retrieved: new Date().toISOString(), label: "NASA MODIS (MCD12Q2, public domain)" },
    coverageNote: read.reading
      ? `${greenupSentence(where, read.reading)}. The map colors each 500 m pixel by its usual green-up day, early sage to late purple`
      : "MODIS records no spring green-up in this box (water, desert, ice or evergreen cover with no green-up cycle)",
    legend: GREENUP_LEGEND,
    time: { shape: "none" },
    ...(read.reading && { months: greenupStrip(place, read.years, read.reading) }),
  };
}

/** The current-year anomaly answer with the usual green-up date added, when Earth Engine is set up and the box is local. */
async function withUsualGreenup(ctx: QueryContext, answer: LayerResult, name: string | undefined): Promise<LayerResult> {
  if (answer.kind !== "tiles" || !eeReady(ctx.env) || bboxAreaKm2(ctx.bbox) > GREENUP_NOTE_MAX_KM2) return answer;
  try {
    const read = await readGreenup(ctx, ctx.bbox);
    if (!read.reading) return answer;
    return {
      ...answer,
      coverageNote: `${greenupSentence(name ? `around ${name}` : "in the area asked", read.reading)}. The map: ${answer.coverageNote}`,
      months: greenupStrip(name ?? "the area asked", read.years, read.reading),
    };
  } catch {
    // The anomaly map stands on its own; the usual date is a bonus.
    return answer;
  }
}

const phenology = defineLayer({
  id: "phenology",
  title: "Spring arrival (leaf-out and bloom)",
  description:
    "US map of whether spring has arrived earlier or later than usual, from the USA National Phenology Network's Spring Indices (a model of when plants first leaf out or first flower, driven by daily temperature), lower 48 states only, about 4 km. " +
    "The color is the difference in days from the 30-year average: reds mean spring came that many days early (up to 20), blues mean days late, white is about normal. " +
    "stage leaf (default) is first leaf-out (new leaves on lilac and honeysuckle, a proxy for the start of the growing season); stage bloom is first bloom. " +
    "Without year it shows this year's daily maps (from 1 January to about a month ago); date (YYYY-MM-DD, this year) picks the day, default the newest; after 30 June spring is over, so the default is 30 June and the scrubber runs January to June. " +
    "view greenup: when spring usually greens up here (MODIS 2001–2025, worldwide); give name. " +
    "With year (1981 to 2024) it shows that whole spring's anomaly, one image per year, so use it, or compare, to ask whether spring is arriving earlier over the decades. " +
    "Use it for 'spring arrived', 'has spring come early this year', 'when do the trees leaf out', 'early or late spring', 'growing season start', 'bloom timing'. " +
    "Example questions: did spring arrive early in the Northeast this year, was 2012 a record-early spring, compare leaf-out in 1990 and 2020 for the Midwest. " +
    "Caveats: it is a temperature-based model (calibrated on lilac and honeysuckle), not a satellite view of actual leaves, so it can be off for high mountains, evergreen forest and desert; Alaska and the rest of the world are not covered; the current year does not run to today and the latest annual map is 2024. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the stage and day or year shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "us",
  surface: "land",
  license: "USA-NPN Spring Indices (public domain, USGS / USA National Phenology Network); NASA MODIS MCD12Q2 (public domain)",
  requiredEnv: [],
  // The greenup view runs on Earth Engine: the service account key in production, local ADC in development.
  optionalEnv: ["EE_PROJECT", "EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // As served: the renderer's default calm filter greyed the red and blue the key names.
  style: { geometry: "polygon", color: layerColor("phenology"), raster: { saturation: 0, opacity: 0.8, swatch: "#E34A33" } },
  legend: {
    kind: "image",
    title: "Spring arrival versus the 30-year average",
    unit: "days",
    imageUrl: LEGEND_URL,
    note: "Red: spring came early (dark red 20 days early); white: about normal; blue: late (navy 20 days late).",
  },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (input.view === "greenup") return greenupAnswer(ctx, input.name);
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

    const year = new Date(now).getUTCFullYear();
    const from = `${year}-01-01`;
    const choice = resolveTileDate(input.date, { from, latestOffsetDays: -DAYS_BACK, label: "daily spring index maps" }, now);
    if (!choice.ok) {
      return { error: input.date !== undefined && input.date < from ? `Daily spring index maps cover this year only (from ${from}); for an earlier spring use year (${ANNUAL_FROM} to ${ANNUAL_TO})` : choice.error };
    }
    // Once spring is over everywhere (after 30 June) the daily map stops changing: the scrubber spans January to June and
    // a later day shows 30 June, the season's final map, so playing it shows spring arriving rather than a still summer.
    const springEnd = `${year}-${SPRING_END}`;
    const over = choice.date > springEnd;
    const date = over ? springEnd : choice.date;
    const note = over ? `spring is complete by ${springEnd}, so this is the season's final map${input.date !== undefined ? ` (asked ${input.date})` : ""}` : choice.note;
    const answer: LayerResult = {
      kind: "tiles",
      data: {
        url: dailyTileUrl(input.stage, date),
        minzoom: 0,
        maxzoom: 10,
        format: "raster",
        time: { template: dailyTileUrl(input.stage, "{date}"), cadence: "daily", from, ...(over && { to: springEnd }), daysBack: DAYS_BACK },
      },
      citation,
      coverageNote: `${dateNote(`${stageName} spring index anomaly`, date, note)}, days early (red) or late (blue) versus the 30-year average, lower 48 states only`,
    };
    return withUsualGreenup(ctx, answer, input.name);
  },

  async identify(ctx, at, input) {
    if (input.view !== "greenup" || !eeReady(ctx.env)) return null;
    try {
      const result = (await createEeClient({ env: ctx.env }).compute(pointExpression(at.lon, at.lat))) as Record<string, unknown> | null;
      const reading = greenupReading(readYears(result));
      const usual = typeof result?.usual === "number" ? result.usual : reading?.usual;
      if (usual === undefined || !reading) return null;
      return pointFeature(at, {
        name: `Usual green-up ${dayText(usual)}`,
        usualGreenup: dayText(usual),
        latestGreenup: `${dayText(reading.latest.day)} in ${reading.latest.year}, ${earlyLate(reading.latest.day - usual)}`,
        range: `Earliest ${dayText(reading.earliest.day)} (${reading.earliest.year}), latest ${dayText(reading.last.day)} (${reading.last.year})`,
        years: reading.years,
      });
    } catch (error) {
      return eeFailure(error);
    }
  },
});

registerLayer(phenology);

export default phenology;

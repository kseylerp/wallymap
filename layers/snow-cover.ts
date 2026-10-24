/**
 * Snow cover raster tiles: NASA GIBS MODIS daily snow cover (global, over time) or the NOAA NOHRSC snow depth analysis
 * (US, current day only).
 * Verified 2026-10-09:
 *   - GIBS WMTS capabilities (https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml):
 *     MODIS_Terra_NDSI_Snow_Cover ("Snow Cover (Normalized Difference Snow Index, MODIS, Terra)"), daily from 2000-02-24
 *     (with a few gaps) to the present, GoogleMapsCompatible_Level8 (zoom 0 to 8), image/png. This is the near-real-time
 *     "best" id; MODIS_Terra_L3_NDSI_Snow_Cover_Daily is the lagged standard product and is not used.
 *     Live check: z=4 y=3 x=8 returned 200 image/png for 2026-10-07, 2026-10-08 and 2026-10-09 (today), so the newest
 *     day offered is 1 day back.
 *   - SNODAS / NOHRSC depth: nohrsc.noaa.gov has no tile or WMS endpoint of its own, but NOAA publishes the analysis as an
 *     ArcGIS MapServer at https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer
 *     (layer 0 = snow depth, 4 = snow water equivalent; "not time enabled", refreshed 01Z, 05Z, 11Z and 17Z). Its `export`
 *     operation answers 200 image/png for any Web Mercator bbox; over the Cascades (Mount Rainier) it drew coloured depth
 *     pixels, and `identify` there returned a depth value. It is the current analysis only: no date, no scrubber.
 *     Its legend (MapServer/legend, read 2026-10-18) gives 12 depth classes in inches, drawn grey-green through blue and
 *     purple to brown: 0.39-2, 2-3.9, 3.9-9.8, 9.8-20, 20-39, 39-59, 59-98, 98-197, 197-295, 295-394, 394-787 in.
 * Colors (2026-10-18): GIBS draws NDSI snow from pale yellow (NDSI 0.01-0.20) through orange to red (1.0), not blue-white;
 *   the old 60% desaturation turned that into a faint tan, so snow on the Cascades on 2026-03-10 hardly showed and the
 *   words named colors that were not on screen. The tiles are now drawn as served (no saturation or hue change) and the
 *   legend lists GIBS's own colors (colormap MODIS_NDSI_Snow_Cover.xml).
 * Cloudy days: with no date asked, the layer reads the view's tiles (layers/snow-cover-probe.ts) and shows the newest day
 *   the satellite saw the ground (MODIS's own cloud class: at most a quarter of the view's land under cloud or unseen),
 *   looking back daily for two weeks and every other day to a month; a clear day without snow says so and names the
 *   last clear day with snow; no clear day says "no clear view of the ground in the last N days". Live 2026-10-18 over
 *   Mount Hood [-122.6,44.9,-120.8,45.85]: Oct 17 all cloud, Oct 16 clear (1%) with no snow, Oct 14 81% cloud with 278
 *   "snow" pixels over the lowlands (the old fallback's pick), Oct 12 clear (8%) with 2,650 snow pixels on the peaks.
 *   An asked date is never moved; the note says when it shows no snow.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { clearLookbackDays, coverInView, hiddenShare, latestClearDay, MAX_HIDDEN_SHARE, MIN_SNOW_PIXELS, snowInView } from "./snow-cover-probe";
import { layerColor } from "@/lib/render/palette";

const NOHRSC_SERVICE = "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer";
const NOHRSC_DEPTH_LAYER = 0;

const inputSchema = z.object({
  date: dateInput,
  depth: z.boolean().default(false),
});

export const MODIS_SPEC: GibsDatedSpec = {
  gibsId: "MODIS_Terra_NDSI_Snow_Cover",
  level: 8,
  from: "2000-02-24",
  daysBack: 1,
  cadence: "daily",
  label: "snow cover",
  citationSource: "NASA GIBS: MODIS Terra snow cover (NDSI), NASA NSIDC DAAC / MODIS (public)",
};

/** Tile template for the NOHRSC snow depth analysis (ArcGIS MapServer export, Web Mercator). */
export function nohrscDepthTileUrl(): string {
  return mapServerExportTileUrl(NOHRSC_SERVICE, { layers: `show:${NOHRSC_DEPTH_LAYER}` });
}

/** NDSI classes as GIBS draws them (colormap MODIS_NDSI_Snow_Cover.xml, each class's middle color). */
export const NDSI_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Snow cover (NDSI)",
  items: [
    { label: "Thin or patchy snow (NDSI 0.01 to 0.20)", value: "1-20", color: "#F0F089", symbol: "raster" },
    { label: "Light snow (0.21 to 0.40)", value: "21-40", color: "#F0D289", symbol: "raster" },
    { label: "Moderate snow (0.41 to 0.60)", value: "41-60", color: "#F0B489", symbol: "raster" },
    { label: "Heavy snow (0.61 to 0.80)", value: "61-80", color: "#F09689", symbol: "raster" },
    { label: "Snow covered (0.81 to 1.0)", value: "81-100", color: "#F08081", symbol: "raster" },
  ],
  note: "Clear where there is no snow, and also under cloud and at night (the satellite cannot see).",
};

/** NOAA's depth classes in inches as the MapServer draws them (layer 0's legend images, read 2026-10-18): the depth answer's key. */
export const DEPTH_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Snow depth (NOAA)",
  unit: "in",
  items: [
    { label: "0.4 to 2 in", value: "0.39-2", color: "#ABC1BF", symbol: "raster" },
    { label: "2 to 4 in", value: "2-3.9", color: "#66C1C4", symbol: "raster" },
    { label: "4 to 10 in", value: "3.9-9.8", color: "#63A9CB", symbol: "raster" },
    { label: "10 to 20 in", value: "9.8-20", color: "#5079C8", symbol: "raster" },
    { label: "20 to 39 in", value: "20-39", color: "#3C3FC2", symbol: "raster" },
    { label: "39 to 59 in", value: "39-59", color: "#5720C3", symbol: "raster" },
    { label: "59 to 98 in", value: "59-98", color: "#7D01BB", symbol: "raster" },
    { label: "98 to 197 in", value: "98-197", color: "#B404B1", symbol: "raster" },
    { label: "197 to 295 in", value: "197-295", color: "#A91377", symbol: "raster" },
    { label: "295 to 394 in", value: "295-394", color: "#992B50", symbol: "raster" },
    { label: "Over 394 in", value: "394-787", color: "#8B4545", symbol: "raster" },
  ],
  note: "Modelled snow depth for the lower 48 states; clear where there is less than 0.4 in.",
};

/** The depth analysis's classes in inches as NOAA draws them (MapServer legend, read 2026-10-18), for the answer's note. */
export const DEPTH_CLASSES_NOTE =
  "Snow depth in inches, NOAA's colors: 0.4 to 2 grey-green, 2 to 4 teal, 4 to 10 light blue, 10 to 20 blue, 20 to 39 indigo, 39 to 59 violet, 59 to 98 purple, 98 to 197 magenta, over 197 plum to brown";

/** Readable day, "Oct 16". */
function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The day to draw with no date asked: the newest day the satellite saw the view's ground (MODIS's cloud mask: at most
 * a quarter of the land under cloud or unseen, latestClearDay), never a cloudy day whose cloud reads as snow (owner,
 * 2026-10-18: the old "newest day with snow" fell back to Oct 14, 81% cloud, and painted snow over Portland). When
 * that clear day shows no snow, the note says so and names the last clear day that did; when no day in the last month
 * was clear, it keeps the newest day and says there was no clear view. GIBS not answering keeps the newest day.
 */
async function clearDayChoice(ctx: QueryContext, now: number): Promise<{ date: string; note?: string; view?: string } | null> {
  const choice = resolveTileDate(undefined, { from: MODIS_SPEC.from, latestOffsetDays: -MODIS_SPEC.daysBack, label: MODIS_SPEC.label }, now);
  if (!choice.ok) return null;
  const newest = choice.date;
  const days = clearLookbackDays(newest, MODIS_SPEC.from);
  const search = await latestClearDay(MODIS_SPEC.gibsId, MODIS_SPEC.level, ctx.bbox, days, now);
  if (search.found === null) {
    if (search.unknown || search.oldest === null) return { date: newest };
    const span = Math.round((Date.parse(`${newest}T00:00:00Z`) - Date.parse(`${search.oldest}T00:00:00Z`)) / 86_400_000) + 1;
    return {
      date: newest,
      note: `Snow cover for ${newest}; no clear view of the ground in the last ${span} days (cloud over most of the view), so snow under the cloud is not shown`,
      view: `No clear view of the ground in the last ${span} days: cloud hides any snow`,
    };
  }
  const found = search.found;
  const lead = found === newest ? `Snow cover for ${found}, a clear view of the ground` : `Snow cover for ${found}, the newest day the satellite saw the ground here (cloud hid it after, through ${shortDay(newest)})`;
  if (search.cover.snow >= MIN_SNOW_PIXELS) return found === newest ? { date: found } : { date: found, note: lead, view: `The newest clear view of the ground; cloud hid it after, through ${shortDay(newest)}` };
  // A clear day with no snow is the answer; the last clear day that had snow says when it went.
  const earlier = days.slice(days.indexOf(found) + 1);
  let last: string | null = null;
  for (let i = 0; i < earlier.length && last === null; i += 6) {
    const batch = earlier.slice(i, i + 6);
    const covers = await Promise.all(batch.map((d) => coverInView(MODIS_SPEC.gibsId, MODIS_SPEC.level, ctx.bbox, d, now)));
    const k = covers.findIndex((c) => c !== null && (hiddenShare(c) ?? 1) <= MAX_HIDDEN_SHARE && c.snow >= MIN_SNOW_PIXELS);
    if (k >= 0) last = batch[k];
  }
  // A few pixels (a summit's glacier) are below what counts as snow in view: "little or no", never "none" over a visible speck.
  const none = search.cover.snow === 0 ? "no snow" : "little or no snow";
  const since = last ? `; the last clear day with snow in view was ${shortDay(last)}` : `, nor on any clear day back to ${shortDay(earlier[earlier.length - 1] ?? found)}`;
  return {
    date: found,
    note: `${lead}; ${none} on the ground in view that day${since}`,
    view: `${none === "no snow" ? "No" : "Little or no"} snow on the ground in view${last ? `; more on ${shortDay(last)}, the last clear day with snow` : ""}`,
  };
}

const snowCover = defineLayer({
  id: "snow-cover",
  title: "Snow cover",
  description:
    "Global satellite map of where the ground is snow-covered, from NASA's MODIS sensor on the Terra satellite (Normalized Difference Snow Index, NDSI), on a daily image that goes back to February 2000. " +
    "Snow is drawn in NASA's colors: pale yellow for thin or patchy snow, through orange, to red-pink where the ground is fully snow covered; snow-free ground, cloud and night are clear. " +
    "date (YYYY-MM-DD) picks the day; without it the layer shows the newest day the satellite saw the ground through clear sky (cloud is never read as snow), and its coverageNote says which day, whether it shows snow, the last clear day with snow, or that there was no clear view: tell the user which day is shown and what it says. " +
    "The day can be moved with the time scrubber or compare to see how snow cover changed between two dates or years. " +
    "Set depth to true for the US snow depth analysis from NOAA's National Operational Hydrologic Remote Sensing Center (SNODAS-style modelled depth, about 1 km, in inches: grey-green under 2 in, blue 4 to 20 in, purple 20 to 98 in, magenta to brown deeper); it covers the lower 48 states only, shows the latest analysis (updated four times a day), and has no date. " +
    "Use it for 'snow cover', 'is there snow on the ground', 'how deep is the snow', 'when did the snow line retreat', 'early or late snow year' and similar; in the western US also query snowpack for 'snow on the ground' or 'how deep', so the answer gives inches at named stations with the reading time and how it compares with normal. " +
    "Example questions: where is there snow in the Sierra today, how does snow cover in the Alps compare with a year ago, how deep is the snowpack in Colorado. " +
    "Caveats: the satellite sees snow only through clear sky, so cloudy days leave gaps or look patchy, forests can hide snow, and a day may be missing; it shows whether snow is there, not how deep or how much water is in it (depth mode and the snowpack layer give amounts). " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states which product and day are shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "any",
  license: "NASA GIBS / MODIS (public); NOAA NOHRSC (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // Drawn as served, so the pixels are GIBS's own colors and the legend names them (the old calm filter turned snow tan).
  // brightnessMax 0.92 only keeps the white flash of the brightest pixels down (tests/rasterCalm.test.ts); the legend
  // gives the raw colors, which the panel shows through the same filter as the swatch.
  style: { geometry: "polygon", color: layerColor("snow-cover"), raster: { saturation: 0, brightnessMax: 0.92, opacity: 0.9, swatch: "#F0B489" } },
  legend: NDSI_LEGEND,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (!input.depth) {
      const now = Date.now();
      if (input.date !== undefined) {
        const r = gibsDatedResult(MODIS_SPEC, input.date, now);
        if (!("kind" in r) || r.kind !== "tiles") return r;
        // An asked day is never moved; say when it shows no snow, so a clear map reads as an answer.
        const shown = /for (\d{4}-\d{2}-\d{2})/.exec(r.coverageNote ?? "")?.[1] ?? input.date;
        const n = await snowInView(MODIS_SPEC.gibsId, MODIS_SPEC.level, ctx.bbox, shown, now);
        return n !== null && n < MIN_SNOW_PIXELS
          ? { ...r, coverageNote: `${r.coverageNote}; no snow seen in the view that day (none on the ground, or hidden by cloud)`, viewNote: "No snow seen in view that day (none on the ground, or hidden by cloud)" }
          : r;
      }
      const pick = await clearDayChoice(ctx, now);
      const r = gibsDatedResult(MODIS_SPEC, pick?.date, now);
      if (!("kind" in r) || r.kind !== "tiles" || !pick?.note) return r;
      return { ...r, coverageNote: pick.note, ...(pick.view && { viewNote: pick.view }) };
    }
    if (input.date !== undefined) {
      return { error: "Snow depth (depth: true) is only the latest analysis, so it takes no date; omit date, or use depth: false for a past day" };
    }
    return {
      kind: "tiles",
      data: { url: nohrscDepthTileUrl(), minzoom: 0, maxzoom: 10, format: "raster" },
      citation: {
        source: "NOAA National Weather Service, NOHRSC National Snow Analysis (snow depth; public)",
        url: "https://www.nohrsc.noaa.gov/nsa/",
        retrieved: new Date().toISOString(),
      },
      legend: DEPTH_LEGEND,
      coverageNote: `Snow depth (NOAA), latest NOHRSC analysis for ${isoDay(Date.now())}, lower 48 states, updated several times a day; not scrubbable. ${DEPTH_CLASSES_NOTE}`,
    };
  },
});

registerLayer(snowCover);

export default snowCover;

/**
 * Flood and surface water extent raster tiles.
 *
 * Default source since 2026-10-18: Copernicus Emergency Management Service Global Flood Monitoring (GFM), flood water
 * mapped from Sentinel-1 radar (sees through cloud and at night), 20 m, every Sentinel-1 pass worldwide since 2015.
 *   WMS https://geoserver.gfm.eodc.eu/geoserver/gfm/wms, layer `observed_flood_extent` (keyless; time dimension daily
 *   2015-01-01 to today). Verified live 2026-10-18 ~06:30 UTC:
 *   - `time=P18D/2026-10-18` (a period ending on a day) returns every flood pixel seen in those days in one image, so
 *     one URL answers "any flooding in the last N days"; a single day is mostly empty because a place is imaged only
 *     every few days. Bangladesh [88,21,92,26]: 305 flood pixels over 18 days, 443 over 30 days, drawn (232,76,120)
 *     pink-red on a transparent PNG; observed_water_extent over Lake Okeechobee (P60D) drew the lake, so US passes exist.
 *   - Only flood water is drawn: GFM subtracts its reference water mask, so the lake that is always there stays clear.
 *   - Tiles at zoom 6 and coarser came back empty (the server draws nothing at those scales), so minzoom is 7.
 *   - Copernicus data: free, full and open (credit "Copernicus Emergency Management Service, GFM").
 * Optical and coarse options from NASA GIBS (WMTS, keyless):
 *   - OPERA_L3_Dynamic_Surface_Water_Extent-HLS: 30 m, Landsat + Sentinel-2, daily from 2023-01-01; classes open water
 *     (blue), partial water (pale blue), snow/ice (cyan), cloud (grey) and not water (white), all drawn opaque by GIBS.
 *   - MODIS_Combined_Flood_1-Day: 250 m, daily from 2021-01-01; flood red, recurring flood yellow, water light blue.
 *   Their newest day is read from GIBS's DescribeDomains answer for the layer (about 500 bytes, cached 3 hours):
 *     https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/{layer}/default/{matrixSet}/all/all.xml
 *   -> <Domain>2023-01-01/2024-06-02/P1D,...,2025-08-08/2026-10-11/P1D</Domain>. On 2026-10-18 OPERA HLS ended 2026-10-11
 *   (7 days back) while the old fixed 3-day lag asked for 2026-10-15, a blank map; MODIS ended 2026-10-18. When the
 *   answer cannot be read the layer falls back to a 7-day (OPERA) or 1-day (MODIS) lag and says so.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { DAY_MS, dateInput, isoDay, resolveTileDate } from "./_shared/dated-tiles";
import { gibsDatedResult, type GibsDatedSpec } from "./_shared/gibs-dated";
import { wmsTileUrl } from "./_shared/wms";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  source: z.enum(["gfm", "opera", "modis"]).default("gfm"),
  date: dateInput,
  /** GFM only: how many days up to `date` to gather flood pixels from (one pass every few days, so a window). */
  days: z.number().int().min(1).max(31).default(12),
});

export const GFM_WMS = "https://geoserver.gfm.eodc.eu/geoserver/gfm/wms";
export const GFM_FROM = "2015-01-01";
/** GFM draws nothing at zoom 6 and coarser (checked 2026-10-18). */
export const GFM_MINZOOM = 7;

/** The GFM tile URL for flood pixels seen in the `days` days ending on `date` (YYYY-MM-DD or the `{date}` placeholder). */
export function gfmTileUrl(date: string, days: number): string {
  return wmsTileUrl(GFM_WMS, "observed_flood_extent", { time: `P${days}D/${date}T23:59:59Z` });
}

export const SPECS: Record<"opera" | "modis", GibsDatedSpec & { matrixSet: string; fallbackDaysBack: number }> = {
  opera: {
    gibsId: "OPERA_L3_Dynamic_Surface_Water_Extent-HLS",
    level: 12,
    matrixSet: "GoogleMapsCompatible_Level12",
    from: "2023-01-01",
    daysBack: 7,
    fallbackDaysBack: 7,
    cadence: "daily",
    label: "surface water maps",
    citationSource: "NASA GIBS: OPERA Dynamic Surface Water Extent from HLS (Landsat 8/9 + Sentinel-2), NASA JPL OPERA (public)",
  },
  modis: {
    gibsId: "MODIS_Combined_Flood_1-Day",
    level: 9,
    matrixSet: "GoogleMapsCompatible_Level9",
    from: "2021-01-01",
    daysBack: 1,
    fallbackDaysBack: 1,
    cadence: "daily",
    label: "MODIS flood maps",
    citationSource: "NASA GIBS: MODIS Terra + Aqua combined 1-day flood (NASA LANCE / MODIS; public)",
  },
};

export function gibsDomainsUrl(gibsId: string, matrixSet: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/${gibsId}/default/${matrixSet}/all/all.xml`;
}

/** The last day of a GIBS DescribeDomains answer ("…,2025-08-08/2026-10-11/P1D</Domain>" → "2026-10-11"), or null. */
export function lastDomainDay(xml: string): string | null {
  const domain = /<Domain>([^<]+)<\/Domain>/.exec(xml)?.[1];
  if (!domain) return null;
  const last = domain.split(",").pop()?.trim() ?? "";
  const day = (last.includes("/") ? last.split("/")[1] : last).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The newest day GIBS has published for a layer, or null when its domains answer cannot be read. */
export async function gibsNewestDay(ctx: QueryContext, gibsId: string, matrixSet: string): Promise<string | null> {
  try {
    const res = await ctx.fetch(gibsDomainsUrl(gibsId, matrixSet), {
      cacheKey: `gibs-domains:${gibsId}`,
      ttlSeconds: 3 * 3_600,
      validate: (body) => body.includes("<Domain>"),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return lastDomainDay(await res.text());
  } catch {
    return null;
  }
}

/**
 * The key for the default (GFM) map: one color, flood water only. The optical and MODIS sources draw GIBS's own classes,
 * named in the note.
 */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Flood water (Copernicus GFM)",
  items: [
    {
      label: "Flood water seen by radar",
      color: "#E84C78",
      symbol: "raster",
      help: "Water where there is normally none, seen by Sentinel-1 radar in the days shown; lakes and rivers that are always there stay clear.",
    },
  ],
  note:
    "Empty means no flooding was seen in those days. Source opera draws open water dark blue, partial water pale blue, cloud grey, snow cyan and dry land white; source modis draws flood red, recurring flood yellow and normal water light blue.",
};

const floodExtent = defineLayer({
  id: "flood-extent",
  title: "Flood and surface water extent",
  description:
    "Global satellite maps of flood water on the land, for seeing a flood as it happens or where a river or lake has spread. " +
    "source gfm (default) is the Copernicus Global Flood Monitoring service: flood water mapped from Sentinel-1 radar, which sees through cloud and at night, 20 m pixels, worldwide since 2015, " +
    "drawn in one pink-red where water is found that is not normally there (permanent lakes and rivers stay clear), gathered over the days (default 12, 1 to 31) up to date, because a place is imaged only every few days. " +
    "Empty means no flooding was seen in that window. Flood pixels show from about zoom 7 (a county) in; zoomed out further the map draws nothing. " +
    "source opera is NASA's OPERA surface water extent from Landsat and Sentinel-2: 30 m optical, all water in blue shades with cloud grey and dry land white, daily from 2023 to its newest published day (about a week behind); each place is imaged only every few days and clouds hide floods. " +
    "source modis is the MODIS 1-day flood product: about 250 m, flooded areas red, recurring floods yellow, normal water light blue, daily from 2021 to yesterday. " +
    "date (YYYY-MM-DD) picks the day (the window's last day for gfm) and defaults to the newest; use the time scrubber or compare to step through days before and after a flood. " +
    "Use it for 'flooded', 'is it flooded', 'flood extent', 'did the river overflow', 'where is the water now', 'lake level change this week'. " +
    "Example questions: how far did the river spread after the storm, is the Mississippi flooded near Memphis, show the water around this town before and after the hurricane. " +
    "To see where water usually is, pair it with surface-water. " +
    "Caveats: radar misses shallow water under dense forest and in cities, and can mistake smooth wet ground or tarmac for water; optical sources cannot see through cloud; none shows depth or damage. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the days shown (and when a date was moved to the newest available). " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "global",
  surface: "any",
  license: "Copernicus EMS Global Flood Monitoring (free, full and open; credit Copernicus); NASA GIBS / OPERA and MODIS (public)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // GFM's pink-red is the hazard color already; drawn as served, a little see-through so the ground reads beneath.
  style: { geometry: "polygon", color: layerColor("flood-extent"), raster: { saturation: 0, opacity: 0.85, swatch: "#E84C78" } },
  legend: LEGEND,
  time: { shape: "continuous", step: "day" },
  display: { timeZone: "utc" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    if (input.source === "gfm") {
      const choice = resolveTileDate(input.date, { from: GFM_FROM, latestOffsetDays: 0, label: "flood maps" }, now);
      if (!choice.ok) return { error: choice.error };
      const start = isoDay(Date.parse(`${choice.date}T00:00:00Z`) - (input.days - 1) * DAY_MS);
      return {
        kind: "tiles",
        data: {
          url: gfmTileUrl(choice.date, input.days),
          minzoom: GFM_MINZOOM,
          maxzoom: 14,
          format: "raster",
          time: { template: gfmTileUrl("{date}", input.days), cadence: "daily", from: GFM_FROM, daysBack: 0 },
        },
        citation: {
          source: "Copernicus Emergency Management Service, Global Flood Monitoring (GFM): observed flood extent from Sentinel-1 (free, full and open)",
          url: "https://global-flood.emergency.copernicus.eu/",
          retrieved: new Date(now).toISOString(),
        },
        coverageNote:
          `Flood water seen by Sentinel-1 radar from ${start} to ${choice.date} (${input.days} days)` +
          `${choice.note ? ` (${choice.note})` : ""}; empty means no flooding seen; visible from about zoom 7 in`,
      };
    }
    const spec = SPECS[input.source];
    const newest = await gibsNewestDay(ctx, spec.gibsId, spec.matrixSet);
    if (newest === null) {
      const r = gibsDatedResult({ ...spec, daysBack: spec.fallbackDaysBack }, input.date, now);
      if ("error" in r) return r;
      return { ...r, coverageNote: `${r.coverageNote ?? ""}; GIBS did not say its newest day, so the day was guessed` };
    }
    // The archive's real end (a week behind for OPERA), so neither the default nor the scrubber asks for a blank day.
    return gibsDatedResult({ ...spec, to: newest, daysBack: 0 }, input.date, now);
  },
});

registerLayer(floodExtent);

export default floodExtent;

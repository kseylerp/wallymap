/**
 * Water depth (bathymetry): how deep the sea, a bay or a surveyed lake is across the view, drawn as a depth ramp with
 * contour lines and the deepest point ringed, computed by this app from NOAA NCEI's DEM mosaic (lib/depth/ncei.ts:
 * CUDEM coastal surveys at about 3 to 10 m along US coasts, NOAA's Great Lakes bathymetry, ETOPO 2022 with GEBCO in the
 * open ocean). Map tiles come from this app's own route (app/api/water-depth/<z>/<x>/<y>), which asks the mosaic for
 * raw elevations (lib/depth/view.ts). The query samples the box once (about 512 samples on its longer side) for the
 * deepest point and the median depth, which set the ramp's end and the contour interval and fill the note; a tap reads
 * the depth and its survey at the point.
 * Checked live 2026-10-23, Elliott Bay view -122.55,47.55,-122.35,47.7: deepest 285 m (936 ft) at 47.682, -122.464 in
 * Puget Sound's main basin; mid-bay -81 m; 59% of the box is water. Lake Tahoe and Crater Lake have no survey in the
 * mosaic (it holds only their flat surfaces), so they are left clear and the note sends the question to `lakes`.
 */
import { z } from "zod";
import { defineLayer, type BBox, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { pointFeature } from "./_shared/identify";
import { usUnitsFirst } from "./peaks-units";
import { isWater, NCEI_CITATION_SOURCE, NCEI_CITATION_URL, parseSamples, samplesUrl, sourceOf } from "@/lib/depth/ncei";
import { contourStep, depthColor, depthStats, INLAND_KM, loadLandTest, rampMax, type DepthStats } from "@/lib/depth/view";
import { layerColor } from "@/lib/render/palette";
import { rgbToHex } from "@/lib/render/ramp";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";

const FT_PER_M = 3.280_84;

/** "936 ft (285 m)" in the US, "285 m (936 ft)" elsewhere. */
export function depthText(m: number, usFirst: boolean): string {
  const ft = `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
  const metric = `${Math.round(m).toLocaleString("en-US")} m`;
  return usFirst ? `${ft} (${metric})` : `${metric} (${ft})`;
}

/** The legend for a view: the ramp from the surface to `maxM`, five stops in the view's units first. */
export function depthLegend(maxM: number, usFirst: boolean, contour: string): LegendSpec {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const m = maxM * t;
    return { label: t === 0 ? (usFirst ? "0 ft" : "0 m") : depthText(m, usFirst), value: Math.round(m * 10) / 10, color: rgbToHex(depthColor(m, maxM)) };
  });
  return {
    kind: "ramp",
    title: "Depth",
    field: "depthM",
    unit: usFirst ? "ft" : "m",
    stops,
    note:
      `Below the water surface, shallow off-white to dark grey at the deepest in view; contour lines every ${contour}, every fifth stronger; ` +
      "the ringed point is the deepest. Land, and lakes NOAA has no survey of (such as Lake Tahoe and Crater Lake), are left clear.",
  };
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const at = (lat: number, lon: number) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

/** The coverage note and the one-line view note from the box's numbers. */
export function depthNotes(
  stats: DepthStats,
  usFirst: boolean,
  contour: string,
  opts: { deepestSource?: string; inLake?: boolean } = {},
): { coverageNote: string; viewNote: string } {
  const { deepestSource, inLake } = opts;
  if (!stats.deepest || stats.medianM === undefined) {
    return {
      coverageNote:
        "No water with a surveyed depth in this box: it is land, or a lake above sea level that NOAA has no survey of (Lake Tahoe and Crater Lake among them). " +
        "For a lake's maximum depth use lakes",
      viewNote: "No surveyed water depth in this view",
    };
  }
  const deep = stats.deepest;
  const parts = [
    `Deepest point in this view: ${depthText(deep.depthM, usFirst)} at ${at(deep.lat, deep.lon)}${deepestSource ? ` (${deepestSource})` : ""}`,
    `typical depth (median of the water) ${depthText(stats.medianM, usFirst)}`,
    `water covers ${pct(stats.waterShare)} of the box, sampled every ${stats.spacingM.toLocaleString("en-US")} m`,
    `contours every ${contour}`,
    ...(inLake ? ["the deepest point is in a lake: depths are below sea level (the Great Lakes: below the lake's chart datum), so a lake above sea level reads shallower by its surface height"] : []),
  ];
  if (stats.maskedInland > 0) parts.push(`ground below sea level more than ${INLAND_KM} km inland with no survey of water is left clear as dry land`);
  return {
    coverageNote: parts.join("; "),
    viewNote: `Deepest ${depthText(deep.depthM, usFirst)} at ${at(deep.lat, deep.lon)}; typical ${depthText(stats.medianM, usFirst)}`,
  };
}

/** The tile URL for a view's ramp end, contour interval and deepest point (served by app/api/water-depth). */
export function depthTileUrl(maxM: number, stepM: number, deepest?: { lon: number; lat: number }): string {
  const q = new URLSearchParams({ max: String(Math.round(maxM * 10) / 10), step: String(Math.round(stepM * 1000) / 1000) });
  if (deepest) q.set("deep", `${deepest.lon.toFixed(5)},${deepest.lat.toFixed(5)}`);
  return `/api/water-depth/{z}/{x}/{y}?${q}`;
}

/** The survey behind the value at a point, in words with its grid ("NOAA CUDEM coastal survey, about 3 m grid"), or undefined. */
async function sourceAt(fetchJson: (url: string) => Promise<unknown>, lon: number, lat: number): Promise<{ text: string; surveyed: boolean; elevationM: number } | undefined> {
  const [first] = parseSamples(await fetchJson(samplesUrl(lon, lat)).catch(() => null));
  if (!first) return undefined;
  const s = sourceOf(first.demName, first.cellArcSeconds);
  return { text: `${s.name}, about ${s.spacingM.toLocaleString("en-US")} m grid`, surveyed: s.surveyed, elevationM: first.elevationM };
}

const waterDepth = defineLayer({
  id: "water-depth",
  title: "Water depth (bathymetry)",
  description:
    "How deep the water is across the view (bathymetry), computed by this app from NOAA NCEI's elevation mosaic and drawn as map tiles: a depth ramp from off-white (shallow) " +
    "through purple to dark grey at the deepest in view, contour lines every 50 ft in the US (10 m elsewhere; wider in deep water), and the deepest point ringed. " +
    "User words: how deep is the water here, how deep is the bay, depth of the lake, depth of the sea, ocean depth, bathymetry, depth contours, seafloor, deepest point. " +
    "Coverage: US coasts and bays at about 3 to 10 m (NOAA CUDEM surveys: Puget Sound, San Francisco Bay, Chesapeake), the Great Lakes, and every ocean (ETOPO 2022 with GEBCO, about 450 m). " +
    "Lakes above sea level mostly have no survey here (Lake Tahoe and Crater Lake do not): for a lake's maximum depth, or to compare two lakes, use lakes. " +
    "Its coverageNote gives the deepest point in the box (depth in feet and metres, latitude and longitude, and the survey) and the typical depth (median of the water): " +
    "quote both in the answer's first sentence, e.g. 'The water here reaches 936 ft (285 m) at its deepest; most of it is about 390 ft (118 m) deep.' " +
    "Depths are below sea level, not below today's tide. Not for navigation. Up to 5,000,000 km².",
  coverage: "global",
  surface: "water",
  license: "Public domain: NOAA NCEI (CUDEM, Great Lakes bathymetry, ETOPO 2022) and the GEBCO Compilation Group (GEBCO grid within ETOPO 2022)",
  requiredEnv: [],
  maxAreaKm2: 5_000_000,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("water-depth"), raster: null },
  legend: depthLegend(200, true, "50 ft"),
  time: { shape: "none" },
  card: {
    facts: [
      { key: "depthText", label: "Depth" },
      { key: "source", label: "Survey" },
    ],
  },
  fieldHelp: {
    depthText: { text: "Depth below sea level at this point (below the chart datum on the Great Lakes), from the finest NOAA elevation model that covers it.", source: NCEI_CITATION_SOURCE, url: NCEI_CITATION_URL },
    depthM: { text: "Depth below sea level at this point, in metres.", unit: "m", source: NCEI_CITATION_SOURCE, url: NCEI_CITATION_URL },
    source: { text: "Which NOAA model gives the depth here and how far apart its values are: coastal surveys are metres apart, the global grid hundreds of metres.", url: NCEI_CITATION_URL },
  },

  async query(ctx): Promise<LayerResult> {
    const usFirst = usUnitsFirst(ctx.bbox);
    const stats = await depthStats(ctx.bbox as BBox);
    const fetchJson = async (url: string) => (await ctx.fetch(url, { timeoutMs: UPSTREAM_TIMEOUT_MS, ttlSeconds: 30 * 86_400 })).json();
    const deep = stats?.deepest;
    const deepestSource = deep ? (await sourceAt(fetchJson, deep.lon, deep.lat))?.text : undefined;
    // Natural Earth counts lakes as land, so a deepest point on its land is in a lake.
    const inLake = deep ? (await loadLandTest())?.isLand(deep.lon, deep.lat) === true : false;
    const deepestM = deep?.depthM ?? 0;
    const { stepM, label } = contourStep(deepestM, usFirst);
    const maxM = rampMax(deepestM, stepM);
    const notes = stats
      ? depthNotes(stats, usFirst, label, { deepestSource, inLake })
      : { coverageNote: "The NOAA elevation mosaic did not answer for this box, so there is no deepest point or typical depth to quote", viewNote: undefined };
    return {
      kind: "tiles",
      data: { url: depthTileUrl(maxM, stepM, stats?.deepest), minzoom: 2, maxzoom: 15, format: "raster", tileSize: 256 },
      citation: { source: NCEI_CITATION_SOURCE, url: NCEI_CITATION_URL, retrieved: new Date().toISOString().slice(0, 10) },
      coverageNote: notes.coverageNote,
      ...(notes.viewNote && { viewNote: notes.viewNote }),
      legend: depthLegend(maxM, usFirst, label),
      ...(!stats && { sourceStatus: { ok: false as const, reason: "offline" as const, message: "NOAA NCEI's elevation mosaic did not answer." } }),
    };
  },

  // A tap on the depth picture: the depth there and the survey it comes from.
  async identify(ctx, point) {
    const fetchJson = async (url: string) => (await ctx.fetch(url, { timeoutMs: UPSTREAM_TIMEOUT_MS, ttlSeconds: 30 * 86_400 })).json();
    const here = await sourceAt(fetchJson, point.lon, point.lat);
    if (!here) return { error: "NOAA's elevation mosaic did not answer for that point", hint: "upstream" };
    if (!isWater(here.elevationM)) return null;
    // Dry ground below sea level inland (Death Valley) is drawn clear; its tap says nothing either.
    if (!here.surveyed) {
      const land = await loadLandTest();
      if (land && land.isLand(point.lon, point.lat) && land.coastDistanceKm(point.lon, point.lat, INLAND_KM + 1) >= INLAND_KM) return null;
    }
    const depthM = -here.elevationM;
    const usFirst = usUnitsFirst([point.lon, point.lat, point.lon, point.lat]);
    return pointFeature(point, {
      name: `${depthText(depthM, usFirst)} deep`,
      depthM: Math.round(depthM * 10) / 10,
      depthText: depthText(depthM, usFirst),
      source: here.text,
    });
  },
});

registerLayer(waterDepth);
export default waterDepth;

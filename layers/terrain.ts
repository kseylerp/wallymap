/**
 * Terrain: slope classes (avalanche terrain), the way slopes face, and ground in its own shade through a morning or an
 * afternoon, computed by this app from AWS Terrain Tiles (Mapzen Terrarium PNGs on S3, open data, no key; USGS 3DEP
 * about 10 m in the US, SRTM about 30 m elsewhere). The map tiles come from this app's own route
 * (app/api/terrain/<mode>/<z>/<x>/<y>), which reads elevation tiles at zoom 12 to 15 (about 30 to 4 m pixels) and
 * classes each pixel with Horn's slope and aspect (lib/terrain/view.ts). The query also counts the box's ground by
 * class (sampled at about 30 m), so the note can say "27% of this box is 30 to 45°".
 * Checked 2026-10-23: the S3 tile 12/795/1561 (Wasatch) is a 256-pixel RGB PNG of 136 KB.
 *
 * Mode `elevation` draws hypsometric tints instead: elevation bands chosen for the box's range (1,000 ft or 300 m,
 * wider over big ranges, at most eight bands), off-white low through sage and purple toward dark grey high, with a
 * contour line at each band edge, over the basemap's hillshade. Its note names the box's highest and lowest ground
 * from the elevation model (lib/terrain/extremes.ts). Live 2026-10-23 over Death Valley (7,770 km²): highest 3,369 m
 * near Telescope Peak (3,366 m surveyed), lowest about -84 m on the salt pan (Badwater Basin, -86 m surveyed).
 */
import { z } from "zod";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { pointFeature } from "./_shared/identify";
import { heightText, inUnitedStates, usUnitsFirst } from "./peaks-units";
import { compass8, slopeAspectAt, SLOPE_CLASSES } from "@/lib/terrain/analysis";
import { loadDem, TERRAIN_CITATION_SOURCE, TERRAIN_CITATION_URL } from "@/lib/terrain/dem";
import { bandsFor, boxExtremes, type Bands, type Extremes } from "@/lib/terrain/extremes";
import { areaStats, bandTint, FACE_SWATCHES, FACES, SLOPE_SWATCHES, TERRAIN_MODES, type AreaStats, type Face, type TerrainOptions } from "@/lib/terrain/view";
import { DARK_GREY, layerColor } from "@/lib/render/palette";
import { rgbToHex } from "@/lib/render/ramp";

/** Slope, aspect and shade read ground at about 30 m: past this a box is too coarse for them (elevation goes wider). */
export const SLOPE_MAX_KM2 = 5_000;
/** The elevation view's widest box: a whole range or a national park. */
export const ELEVATION_MAX_KM2 = 100_000;

const FACE_WORDS: Record<Face, string> = { N: "North", E: "East", S: "South", W: "West" };

export const SLOPE_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Slope angle",
  unit: "°",
  items: SLOPE_CLASSES.slice(1).map((c, i) => ({
    label: c.label,
    color: SLOPE_SWATCHES[i + 1],
    symbol: "raster" as const,
    ...(c.key === "30to35" || c.key === "35to45" ? { help: "Avalanche terrain: most slab avalanches start on slopes of 30 to 45°." } : {}),
  })),
  note: "Ground under 25° is left clear. Computed from a 10 to 30 m elevation model: a short cliff band can be steeper than shown.",
};

export const ASPECT_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Way the slope faces",
  items: FACES.map((f) => ({ label: `${FACE_WORDS[f]}-facing`, value: f, color: FACE_SWATCHES[f], symbol: "raster" as const })),
  note: "Ground flatter than 10° is left clear.",
};

export const SHADE_LEGEND: LegendSpec = {
  kind: "categories",
  title: "In its own shade",
  items: [{ label: "Faces away from the sun", color: DARK_GREY, symbol: "raster", help: "No direct sun for most of the period: the ground faces away from it." }],
  note: "Shadows cast by other ridges are not counted, so real shade is a little wider.",
};

const LEGENDS: Record<Exclude<(typeof TERRAIN_MODES)[number], "elevation">, LegendSpec> = { slope: SLOPE_LEGEND, aspect: ASPECT_LEGEND, shade: SHADE_LEGEND };

const pct = (share: number | undefined) => `${Math.round((share ?? 0) * 100)}%`;
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** "4,000 ft" or "1,200 m": a band edge as people read it. */
function edgeText(k: number, bands: Bands): string {
  return `${whole(k * bands.step)} ${bands.unit}`;
}

/** The elevation view's key: one swatch per band, each labelled at its lower edge, feet first in the US. */
export function elevationLegend(bands: Bands): LegendSpec {
  const stops = [];
  for (let k = bands.lo; k <= bands.hi; k++) {
    const [r, g, b] = bandTint(k, bands.lo, bands.hi);
    stops.push({ label: edgeText(k, bands), value: Math.round(k * bands.stepM), color: rgbToHex([r, g, b]) });
  }
  // A ramp needs two stops: one band still shows its upper edge.
  if (stops.length === 1) {
    const [r, g, b] = bandTint(bands.hi + 1, bands.lo, bands.hi + 1);
    stops.push({ label: edgeText(bands.hi + 1, bands), value: Math.round((bands.hi + 1) * bands.stepM), color: rgbToHex([r, g, b]) });
  }
  return {
    kind: "ramp",
    title: "Elevation",
    field: "elevationM",
    unit: bands.unit,
    stops,
    note: `Bands every ${edgeText(1, bands)}, each labelled at its lower edge; the thin dark lines are the band edges (contours). Over the basemap's hillshade.`,
  };
}

/** "−282 ft (−86 m), 282 ft below sea level": a height, with how far below sea level when it is. */
function heightWords(m: number, usFirst: boolean): string {
  const text = heightText(m, usFirst);
  if (m >= 0) return text;
  const below = usFirst ? `${whole(-m / 0.3048)} ft` : `${whole(-m)} m`;
  return `${text}, ${below} below sea level`;
}

const at = (p: { lon: number; lat: number }) => `${p.lon.toFixed(4)}, ${p.lat.toFixed(4)}`;

/** The elevation view's notes: the box's highest and lowest ground, and the bands drawn. */
export function elevationNote(ext: Pick<Extremes, "low" | "high" | "resolutionM">, bands: Bands, usFirst: boolean): { coverageNote: string; viewNote: string } {
  const range = `${edgeText(bands.lo, bands)} to ${edgeText(bands.hi + 1, bands)}`;
  return {
    coverageNote:
      `Highest ground in this box: ${heightWords(ext.high.m, usFirst)} at ${at(ext.high)} (lon, lat); ` +
      `lowest: ${heightWords(ext.low.m, usFirst)} at ${at(ext.low)}, the floor of the lowest ground (a median over a few hundred metres, since the elevation model holds pits that are not ground); ` +
      `relief ${heightText(ext.high.m - ext.low.m, usFirst)}; bands every ${edgeText(1, bands)} from ${range}; read every ${ext.resolutionM} m, a named summit's surveyed height can differ by a few metres`,
    viewNote: `Elevation from ${heightText(ext.low.m, usFirst)} to ${heightText(ext.high.m, usFirst)}, in ${edgeText(1, bands)} bands`,
  };
}

/** The coverage note: the box's ground by class, in the words the legend uses. */
export function statsNote(stats: AreaStats, opts: TerrainOptions, dateText: string): { coverageNote: string; viewNote: string } {
  const head = `Of about ${stats.areaKm2.toLocaleString("en-US")} km² sampled every ${stats.resolutionM} m`;
  if (opts.mode === "slope") {
    const parts = SLOPE_CLASSES.map((c) => `${c.label} ${pct(stats.shares[c.label])}`);
    const band = (stats.shares["30 to 35°"] ?? 0) + (stats.shares["35 to 45°"] ?? 0);
    return {
      coverageNote: `${head}: ${parts.join(", ")}; 30 to 45° (avalanche terrain) ${pct(band)}; steepest ${stats.steepestDeg}°`,
      viewNote: `${pct(band)} of this box is 30 to 45°, where most slab avalanches start`,
    };
  }
  if (opts.mode === "aspect") {
    const flat = stats.shares.Flat ?? 0;
    const steep = 1 - flat;
    const parts = FACES.map((f) => `${FACE_WORDS[f].toLowerCase()} ${pct(steep > 0 ? (stats.shares[f] ?? 0) / steep : 0)}`);
    return {
      coverageNote: `${head}: of the ground steeper than 10° (${pct(steep)} of the box), facing ${parts.join(", ")}`,
      viewNote: `Slopes steeper than 10° by the way they face`,
    };
  }
  const when = opts.period === "morning" ? "8 am to noon" : "1 to 5 pm";
  const sun = stats.sunAzimuths ? ` (the sun moving from ${stats.sunAzimuths[0]}° to ${stats.sunAzimuths[1]}°, ${compass8(stats.sunAzimuths[0])} to ${compass8(stats.sunAzimuths[1])})` : "";
  return {
    coverageNote: `${head}: ${pct(stats.shares["In shade"])} faces away from the sun ${when} solar time on ${dateText}${sun}; ridges' cast shadows not counted`,
    viewNote: `${pct(stats.shares["In shade"])} of this box is in its own shade ${when} on ${dateText}`,
  };
}

/** The tile URL template for these options (served by app/api/terrain). */
export function terrainTileUrl(opts: TerrainOptions): string {
  const q = new URLSearchParams();
  if (opts.mode === "slope" && opts.minSlope !== undefined) q.set("min", String(opts.minSlope));
  if (opts.mode === "aspect" && opts.faces && opts.faces.length > 0) q.set("faces", opts.faces.join(","));
  if (opts.mode === "shade") {
    q.set("date", opts.date ?? new Date().toISOString().slice(0, 10));
    q.set("period", opts.period ?? "afternoon");
  }
  if (opts.mode === "elevation" && opts.bandStepM !== undefined) {
    q.set("step", String(Math.round(opts.bandStepM * 1000) / 1000));
    q.set("lo", String(opts.bandLo ?? 0));
    q.set("hi", String(opts.bandHi ?? 0));
  }
  const qs = q.toString();
  return `/api/terrain/${opts.mode}/{z}/{x}/{y}${qs ? `?${qs}` : ""}`;
}

const input = z.object({
  mode: z
    .enum(TERRAIN_MODES)
    .default("slope")
    .describe(
      "slope: slope classes (avalanche terrain, steep, low-angle); aspect: which way slopes face (north-facing, east faces); shade: ground in its own shade through the period; " +
        "elevation: elevation bands (hypsometric tints) with contour lines, and the box's highest and lowest ground in the note",
    ),
  minSlope: z.number().min(0).max(60).optional().describe("slope mode: draw only ground at least this steep, e.g. 30 for 'slopes over 30°'"),
  faces: z.array(z.enum(FACES)).max(4).optional().describe("aspect mode: draw only these faces, e.g. [\"N\", \"E\"] for north and east faces"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("shade mode: the day, YYYY-MM-DD; today when left out"),
  period: z.enum(["morning", "afternoon"]).default("afternoon").describe("shade mode: morning (8 am to noon) or afternoon (1 to 5 pm), solar time"),
});

const terrain = defineLayer({
  id: "terrain",
  title: "Terrain: slope, aspect, shade and elevation",
  description:
    "Slope angle, the way slopes face (aspect), ground in its own shade, and elevation bands, computed by this app from an elevation model (AWS Terrain Tiles: USGS 3DEP about 10 m in the US, SRTM about 30 m elsewhere) and drawn as map tiles. " +
    "User words: slope angle, steep slopes, avalanche terrain, low-angle, slopes over 30 degrees, aspect, north-facing, which way it faces, shaded in the afternoon, shady slopes, elevation bands, hypsometric, how high is the land, highest and lowest ground. " +
    "mode slope colors the standard classes (under 25° clear, 25 to 30°, 30 to 35° and 35 to 45° in pink as the avalanche band, over 45°); minSlope draws only steeper ground. " +
    "mode aspect colors slopes over 10° by face (north, east, south, west); faces keeps some. mode shade draws ground facing away from the sun through the morning or afternoon of date (self-shade; ridges' cast shadows not counted). " +
    "mode elevation tints the ground by elevation band (every 1,000 ft or 300 m, wider over big ranges; off-white low to dark grey high) with contour lines at the band edges; its coverageNote names the box's highest and lowest ground with elevations in feet and metres and where they are: quote them, and say when the lowest is below sea level. Pair it with peaks (lowest: true) for named summits and the named lowest point. " +
    "Its coverageNote gives the share of the box in each class and the steepest slope: quote those numbers. " +
    "It is not an avalanche forecast: say so, and never infer today's danger from slope. " +
    "Slope, aspect and shade up to 5,000 km² (slopes read lower over wider boxes, where the elevation is sampled more coarsely); elevation up to 100,000 km². " +
    "For a profile or cross-section along a line from A to B use elevation-profile instead.",
  coverage: "global",
  surface: "land",
  license: "Open data: AWS Terrain Tiles (Mapzen) from USGS 3DEP (public domain), SRTM (public domain), GMTED2010 and ETOPO1; attribution to Mapzen and the sources",
  requiredEnv: [],
  maxAreaKm2: ELEVATION_MAX_KM2,
  input,
  style: { geometry: "polygon", color: layerColor("terrain"), raster: null },
  legend: SLOPE_LEGEND,
  time: { shape: "none" },
  card: {
    facts: [
      { key: "slopeDeg", label: "Slope", unit: "°", format: "int" },
      { key: "aspect", label: "Faces" },
      { key: "elevationText", label: "Elevation" },
    ],
    hidden: ["elevationM"],
  },
  fieldHelp: {
    slopeDeg: { text: "The slope of the ground here, from the elevation model (Horn's method over about 30 m).", unit: "°", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    aspect: { text: "The way the ground here faces, downhill.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    elevationM: { text: "Height above sea level from the elevation model.", unit: "m", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    elevationText: { text: "Height above sea level from the elevation model, feet first in the United States.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
  },

  async query(ctx, { mode, minSlope, faces, date, period }): Promise<LayerResult | LayerError> {
    const bbox = ctx.bbox as BBox;
    if (mode === "elevation") {
      const usFirst = usUnitsFirst(bbox);
      const ext = await boxExtremes(bbox);
      const bands = ext ? bandsFor(ext.low.m, ext.high.m, usFirst) : bandsFor(0, 4_000, usFirst);
      const notes = ext ? elevationNote(ext, bands, usFirst) : { coverageNote: "The elevation tiles did not answer for this box, so there is no highest or lowest point to quote", viewNote: undefined };
      return {
        kind: "tiles",
        data: { url: terrainTileUrl({ mode, bandStepM: bands.stepM, bandLo: bands.lo, bandHi: bands.hi }), minzoom: 5, maxzoom: 15, format: "raster", tileSize: 256 },
        citation: { source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL, retrieved: new Date().toISOString().slice(0, 10) },
        coverageNote: notes.coverageNote,
        ...(notes.viewNote && { viewNote: notes.viewNote }),
        legend: elevationLegend(bands),
        ...(!ext && { sourceStatus: { ok: false as const, reason: "offline" as const, message: "AWS Terrain Tiles did not answer." } }),
      };
    }
    const area = bboxAreaKm2(bbox);
    if (area > SLOPE_MAX_KM2) {
      return { error: `Area is ${whole(area)} km²; zoom in to under ${whole(SLOPE_MAX_KM2)} km² for ${mode} (mode elevation answers up to ${whole(ELEVATION_MAX_KM2)} km²)`, hint: "zoom_in" };
    }
    const opts: TerrainOptions = { mode, minSlope, faces, date, period };
    const day = date ?? new Date().toISOString().slice(0, 10);
    const stats = await areaStats(ctx.bbox as BBox, opts);
    const dateText = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const notes = stats ? statsNote(stats, opts, dateText) : { coverageNote: "The elevation tiles did not answer for this box, so there are no shares to quote", viewNote: undefined };
    return {
      kind: "tiles",
      data: { url: terrainTileUrl({ ...opts, date: mode === "shade" ? day : undefined }), minzoom: 9, maxzoom: 15, format: "raster", tileSize: 256 },
      citation: { source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL, retrieved: new Date().toISOString().slice(0, 10) },
      coverageNote: notes.coverageNote,
      ...(notes.viewNote && { viewNote: notes.viewNote }),
      legend: LEGENDS[mode],
      ...(!stats && { sourceStatus: { ok: false as const, reason: "offline" as const, message: "AWS Terrain Tiles did not answer." } }),
    };
  },

  // A tap on the picture: the slope, aspect and elevation there (the elevation first in the elevation view).
  async identify(_ctx, point, { mode }) {
    const pad = 0.002;
    const dem = await loadDem([point.lon - pad, point.lat - pad, point.lon + pad, point.lat + pad], { zoom: 14, maxTiles: 4 });
    const sa = slopeAspectAt(dem, point.lon, point.lat);
    const elevation = dem.at(point.lon, point.lat);
    if (!sa || Number.isNaN(elevation)) return null;
    const elevationText = heightText(elevation, inUnitedStates([point.lon, point.lat]));
    return pointFeature(point, {
      name: mode === "elevation" ? `${elevationText} above sea level` : `${Math.round(sa.slope)}° slope${sa.slope >= 5 ? `, facing ${compass8(sa.aspect)}` : ""}`,
      slopeDeg: Math.round(sa.slope),
      ...(sa.slope >= 5 && { aspect: compass8(sa.aspect) }),
      elevationM: Math.round(elevation),
      elevationText,
    });
  },
});

registerLayer(terrain);
export default terrain;

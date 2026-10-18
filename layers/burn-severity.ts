/**
 * Burn severity of large US fires by year: the Monitoring Trends in Burn Severity (MTBS) thematic severity mosaics
 * (USGS EROS + USFS GTAC, Landsat dNBR classes, 30 m), as raster tiles from the USDA Forest Service image services on
 * imagery.geoplatform.gov (the host fire-hazard already uses).
 *
 * Services (keyless ArcGIS ImageServers, verified live 2026-10-18 ~06:20 UTC):
 *   https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_MTBS_CONUS/ImageServer (lower 48, 1984-2024)
 *   …/USFS_EDW_MTBS_AK/ImageServer (Alaska), …/USFS_EDW_MTBS_HI/ImageServer (Hawaii, to 2023), …/USFS_EDW_MTBS_PR (2005-2013)
 *   - One U8 band, one mosaic item per year (catalog fields `name` mtbs_CONUS_2021, `year`, start_time, end_time), so
 *     `mosaicRule={"where":"year=2021"}` picks a year; `{year}` stays literal in the template for the scrubber.
 *   - Pixel classes (the service legend): 1 unburned to low, 2 low, 3 moderate, 4 high, 5 increased greenness,
 *     6 non-processing mask. A Colormap rendering rule listing only 2, 3 and 4 draws those three and leaves every other
 *     class transparent: over the 2021 Dixie fire (z9) 23,787 of 65,536 pixels drew, low sage, moderate pink, high purple
 *     (the palette's ordinal ramp), so unburned land and the masks no longer cover the map.
 *   - 2018 over the same tile drew 3 pixels, so a year without a fire there is truthfully near-empty.
 * Replaced: the EDW_MTBS_01 MapServer boundary outlines (thin dark-green lines that read as forest boundaries and drew
 * no severity; audit 2026-10-17).
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type BBox, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { imageServerExportTileUrl } from "./_shared/arcgis-tiles";
import { layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";

const HOST = "https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation";
export const FIRST_YEAR = 1984;
/** Newest year MTBS has finished mapping (the CONUS mosaic runs to 2024). */
export const LAST_COMPLETE_YEAR = 2024;
const LATEST_ASKED_YEAR = 2026;

/** Each MTBS region's mosaic and its rough extent [west, south, east, north]; the view's centre picks one. */
export const REGIONS = {
  AK: { box: [-180, 51, -129, 72] as BBox, last: 2024, label: "Alaska" },
  HI: { box: [-161, 18.5, -154.5, 22.5] as BBox, last: 2023, label: "Hawaii" },
  PR: { box: [-67.5, 17.6, -65.2, 18.6] as BBox, last: 2013, label: "Puerto Rico" },
  CONUS: { box: [-125, 24, -66, 50] as BBox, last: LAST_COMPLETE_YEAR, label: "the lower 48 states" },
} as const;
export type Region = keyof typeof REGIONS;

/** The region whose box holds the view's centre (the lower 48 otherwise). */
export function regionFor([w, s, e, n]: BBox): Region {
  const [x, y] = [(w + e) / 2, (s + n) / 2];
  for (const r of ["AK", "HI", "PR"] as const) {
    const [rw, rs, re, rn] = REGIONS[r].box;
    if (x >= rw && x <= re && y >= rs && y <= rn) return r;
  }
  return "CONUS";
}

/** Low, moderate and high severity in the palette's ordinal ramp (sage, pink, purple); every other class transparent. */
const SEVERITY_COLORS: [number, string][] = [
  [2, SAGE],
  [3, PINK],
  [4, PURPLE],
];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const RENDERING_RULE = encodeURIComponent(
  JSON.stringify({ rasterFunction: "Colormap", rasterFunctionArguments: { Colormap: SEVERITY_COLORS.map(([v, hex]) => [v, ...rgb(hex)]) } }),
);

/** Tile template for one year in one region (`{year}` is left in place for the scrubber when `year` is the placeholder). */
export function mtbsTileUrl(year: number | "{year}", region: Region = "CONUS"): string {
  const mosaic = encodeURIComponent(JSON.stringify({ where: "year=YEAR" })).replace("YEAR", String(year));
  return `${imageServerExportTileUrl(`${HOST}/USFS_EDW_MTBS_${region}/ImageServer`)}&mosaicRule=${mosaic}&renderingRule=${RENDERING_RULE}`;
}

const inputSchema = z.object({
  year: z.number().int().min(FIRST_YEAR).max(LATEST_ASKED_YEAR).default(LAST_COMPLETE_YEAR),
});

export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Burn severity (MTBS)",
  field: "severity",
  items: [
    { label: "Low", value: 2, color: SAGE, symbol: "raster", help: "Ground fire; most trees and shrubs survive." },
    { label: "Moderate", value: 3, color: PINK, symbol: "raster", help: "Mixed effects; many smaller trees killed, some crowns scorched." },
    { label: "High", value: 4, color: PURPLE, symbol: "raster", help: "Stand-replacing; most vegetation killed, soil exposed." },
  ],
  note: "Unburned and lightly burned ground inside a fire, and land that greened after it, are left clear; each fire year is mapped from Landsat a year or more later.",
};

const burnSeverity = defineLayer({
  id: "burn-severity",
  title: "Burn severity of large fires (MTBS)",
  description:
    "US map of how severely large wildfires burned, one fire year at a time, from the Monitoring Trends in Burn Severity (MTBS) project of the US Geological Survey and US Forest Service, mapped from Landsat images since 1984 at 30 m. " +
    "Each burned pixel is colored by severity class: low (sage green, ground fire, most trees survive), moderate (pink) or high (purple, stand-replacing, most vegetation killed); unburned ground inside a fire and areas that greened afterwards are left clear. " +
    "It includes every fire of at least 1,000 acres in the West or 500 acres in the East, on all land ownerships, in the lower 48 states, Alaska and Hawaii (the view's centre picks the region; Puerto Rico 2005-2013). " +
    "year (1984 to 2024; default 2024) picks the fire year; yearly data, finished about a year and a half after each fire season, and the time scrubber and compare step through years; 2025 and 2026 are not mapped yet, so asking for them shows 2024 and says so. " +
    "Use it for 'burn severity', 'how bad was the burn', 'burn scars', 'where did big fires burn in 2020', 'fire history'. " +
    "Example questions: which parts of the Sierra burned in 2021 and how badly, show fire scars near Bend over the last decade, compare burned areas in 2012 and 2020. " +
    "For current and recent fire boundaries use fire-perimeters (these are features you can list); for fresh vegetation loss use disturbance. " +
    "Caveats: fires under the size thresholds are missing, prescribed burns are included only when large, severity is measured from the change in plant cover, not soil damage, and ground that burned again shows up under each fire year. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the year shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "us",
  surface: "land",
  license: "USFS / USGS MTBS (public domain)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  // Colored by the rendering rule in the palette's own ramp: drawn as served, slightly see-through over the relief.
  style: { geometry: "polygon", color: layerColor("burn-severity"), raster: { saturation: 0, opacity: 0.85, swatch: PINK } },
  legend: LEGEND,
  time: { shape: "continuous", step: "year" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const region = regionFor(ctx.bbox);
    const { last, label } = REGIONS[region];
    const year = Math.min(input.year, last);
    const moved = year !== input.year ? ` (MTBS has not mapped ${input.year} yet for ${label}; showing ${year})` : "";
    return {
      kind: "tiles",
      data: {
        url: mtbsTileUrl(year, region),
        minzoom: 0,
        maxzoom: 14,
        format: "raster",
        time: { template: mtbsTileUrl("{year}", region), cadence: "yearly", from: String(FIRST_YEAR), to: String(last) },
      },
      citation: {
        source: "Monitoring Trends in Burn Severity (MTBS), USGS EROS and USDA Forest Service, thematic burn severity mosaics via imagery.geoplatform.gov (public domain)",
        url: "https://www.mtbs.gov/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: `MTBS burn severity of large fires in ${year}, ${label}${moved}: low sage, moderate pink, high purple`,
    };
  },
});

registerLayer(burnSeverity);

export default burnSeverity;

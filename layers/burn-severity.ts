/**
 * Burned areas of large US fires by year, raster tiles from the USFS Enterprise Data Warehouse MTBS map service
 * (Monitoring Trends in Burn Severity; USGS EROS + USFS GTAC).
 * Service: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer (ArcGIS, `supportsDynamicLayers`, no time info).
 * Verified 2026-10-09:
 *   - Layer 63 "Burned Area Boundaries (All Years)" has a numeric `year` field, so `layerDefs=63:year=<year>` filters one
 *     year (200 image/png for 1990, 2020 and 2025 over California; 2020 drew dark green perimeters). Per-year layers also
 *     exist (2024 Burned Area Boundaries = 82 ... 1984 = 61).
 *   - Counts by year: 2022: 1177, 2023: 1180, 2024: 1051, 2025: 69, 2026: 21. MTBS has finished mapping through 2024;
 *     2025 and 2026 are the partial, still-arriving years, so the scrubber stops at 2024 and the default year is 2024.
 *   - DEAD END, said plainly: this service draws the burned-area BOUNDARIES (polygons of fires over 1,000 acres in the
 *     West and 500 acres in the East) with one simple symbol, NOT the low/moderate/high severity classes. The severity
 *     rasters (dNBR classes) are not served by it, the old RDW_Wildfire image services answer "migrated to IIPP" (403),
 *     and no keyless severity tile source was found. The per-fire dNBR thresholds are attributes in layer 63.
 *     The layer is still named burn-severity because it is the MTBS product and users ask for it that way; the
 *     description tells the model it shows where, not how hard.
 * No upstream call is made by the layer: it only builds the URL for the map to fetch.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer";
const ALL_YEARS_LAYER = 63;
export const FIRST_YEAR = 1984;
/** Newest year MTBS has finished mapping; 2025 and 2026 hold only a few fires so far. */
export const LAST_COMPLETE_YEAR = 2024;
const LATEST_PARTIAL_YEAR = 2026;

const inputSchema = z.object({
  year: z.number().int().min(FIRST_YEAR).max(LATEST_PARTIAL_YEAR).default(LAST_COMPLETE_YEAR),
});

/** Tile template for one year (`{year}` is left in place for the scrubber when `year` is the placeholder). */
export function mtbsTileUrl(year: number | "{year}"): string {
  return `${mapServerExportTileUrl(SERVICE, { layers: `show:${ALL_YEARS_LAYER}` })}&layerDefs=${ALL_YEARS_LAYER}:year%3D${year}`;
}

const burnSeverity = defineLayer({
  id: "burn-severity",
  title: "Burned areas of large fires (MTBS)",
  description:
    "US map of the burned areas of large wildfires for one year, from the Monitoring Trends in Burn Severity (MTBS) project of the US Geological Survey and US Forest Service, mapped from Landsat images since 1984. " +
    "It covers the lower 48 states, Alaska, Hawaii and Puerto Rico and includes every fire of at least 1,000 acres in the West or 500 acres in the East, on all land ownerships. " +
    "year (1984 to 2024; default 2024) picks the fire year; yearly data, finished about a year and a half after each fire season, and the time scrubber and compare step through years. 2025 and 2026 can be asked for but hold only the few fires mapped so far. " +
    "IMPORTANT: this view draws where each fire burned (the perimeter outline) and does not color how severely, so it cannot answer 'how bad was the burn' by color; MTBS rates each fire's severity as unburned, low, moderate or high in its own rasters, which this map service does not serve. " +
    "Use it for 'burn severity', 'burn scars', 'where did big fires burn in 2020', 'how much of this area has burned since 1984', 'fire history'. " +
    "Example questions: which parts of the Sierra burned in 2021, show fire scars near Bend over the last decade, compare burned areas in 2012 and 2020. " +
    "For current and recent fire boundaries use fire-perimeters (these are features you can list); for fresh vegetation loss use disturbance. " +
    "Caveats: fires under the size thresholds are missing, prescribed burns are included only when large, and ground that burned again shows up under each fire year. " +
    "Compare two dates works (pick two dates or years in compare). " +
    "The result's coverageNote states the year shown. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms.",
  coverage: "us",
  surface: "land",
  license: "USFS EDW / MTBS (public domain)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("burn-severity"), raster: { saturation: -0.35, swatch: "#D8402A" } },

  async query(_ctx, input): Promise<LayerResult | LayerError> {
    const partial = input.year > LAST_COMPLETE_YEAR ? " (partial year: only the fires mapped so far)" : "";
    return {
      kind: "tiles",
      data: {
        url: mtbsTileUrl(input.year),
        minzoom: 0,
        maxzoom: 14,
        format: "raster",
        time: { template: mtbsTileUrl("{year}"), cadence: "yearly", from: String(FIRST_YEAR), to: String(LAST_COMPLETE_YEAR) },
      },
      citation: {
        source: "Monitoring Trends in Burn Severity (MTBS), USGS EROS and USDA Forest Service GTAC, via the USFS Enterprise Data Warehouse (public domain)",
        url: "https://www.mtbs.gov/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: `MTBS burned areas of large fires in ${input.year}${partial}; outlines show where, not how severely`,
    };
  },
});

registerLayer(burnSeverity);

export default burnSeverity;

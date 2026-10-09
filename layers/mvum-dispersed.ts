/**
 * US Forest Service Motor Vehicle Use Map (MVUM) roads, the roads and routes a forest has
 * designated for public motor-vehicle use. Service:
 * https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer/1 ("Motor Vehicle Use Map: Roads",
 * maxRecordCount 2000). Field names below were read from the layer's `?f=json` metadata on 2026-10-09.
 *
 * DISPERSED CAMPING: the brief expected a dispersed-camping attribute. There is none. The layer has no
 * field containing "dispers" or "camp" (nor do EDW_MVUM_02, EDW_RoadBasic_01 or any road/trail/recreation
 * service in the EDW catalog; the only "display" hits are catalog columns). Dispersed-camping corridors
 * appear only on each forest's paper/PDF MVUM. So this layer does NOT claim any road allows dispersed
 * camping; it shows the drivable public road network where motorized dispersed camping can be allowed,
 * and the agent description says to verify locally.
 *
 * Fields used (all lowercase in the service):
 *   id (string route id, e.g. "1302"), name (string, often null), symbol (string "1","2","3","4","11","12"),
 *   mvum_symbol_name (string; the six values seen are "Roads open to all Vehicles, Yearlong|Seasonal",
 *   "Roads open to highway legal vehicles only, Yearlong|Seasonal", "Special Designation, Yearlong|Seasonal"),
 *   seasonal ("yearlong" | "seasonal" | null), passengervehicle / highclearancevehicle ("open" | other | null),
 *   surfacetype (e.g. "AC - ASPHALT", "NAT - NATIVE MATERIAL"), forestname.
 * Symbols: 1 open to all vehicles yearlong, 2 all vehicles seasonal, 3 highway-legal only yearlong,
 * 4 highway-legal only seasonal, 11 special designation yearlong, 12 special designation seasonal.
 * Those six are the only values in the layer. The default filter drops 11 and 12.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";

const SERVICE_URL = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer/1";

const FIELDS = [
  "id",
  "name",
  "symbol",
  "mvum_symbol_name",
  "seasonal",
  "passengervehicle",
  "highclearancevehicle",
  "surfacetype",
  "forestname",
];

const MAX_RECORDS = 2000;
const SEASONAL_SYMBOLS = new Set(["2", "4", "12"]);

const inputSchema = z.object({
  includeAllRoads: z.boolean().default(false),
});

/** Server-side filter: ordinary-vehicle roads by default, plus special-designation roads when asked. */
export function mvumWhere(includeAllRoads: boolean): string {
  return includeAllRoads
    ? "symbol IN ('1','2','3','4','11','12')"
    : "symbol IN ('1','2','3','4')";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Maps MVUM road rows to line features, skipping rows with no geometry or route id. */
export function normalizeMvum(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const routeId = str(p.id);
    if (!f.geometry || routeId === undefined) continue;

    const symbol = str(p.symbol);
    const seasonalField = str(p.seasonal);
    const seasonal =
      seasonalField === "seasonal"
        ? true
        : seasonalField === "yearlong"
          ? false
          : symbol !== undefined && SEASONAL_SYMBOLS.has(symbol);

    const properties: Record<string, string | boolean> = {
      routeId,
      access: str(p.mvum_symbol_name) ?? "Unknown",
      seasonal,
      passengerCar: str(p.passengervehicle) === "open",
      highClearance: str(p.highclearancevehicle) === "open",
    };
    const name = str(p.name);
    if (name !== undefined) properties.name = name;
    const forest = str(p.forestname);
    if (forest !== undefined) properties.forest = forest;
    const surface = str(p.surfacetype);
    if (surface !== undefined) properties.surface = surface;

    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const citation = () => ({
  source: "USDA Forest Service Motor Vehicle Use Map roads (public domain)",
  url: "https://data.fs.usda.gov/geodata/edw/datasets.php",
  retrieved: new Date().toISOString(),
});

const mvumDispersed = defineLayer({
  id: "mvum-dispersed",
  title: "Forest Service roads for car camping",
  description:
    "US Forest Service roads that are legally open to public motor vehicles (from each forest's Motor Vehicle Use Map), the roads you drive to find a dispersed (free, undeveloped) campsite in a National Forest. " +
    "Each line has routeId, name (when it has one), forest, access (the Forest Service class, such as 'Roads open to highway legal vehicles only, Seasonal'), " +
    "seasonal (true when closed part of the year), passengerCar (true when ordinary cars may use it) and highClearance, and surface (paved, gravel, native dirt). " +
    "By default it shows roads open to ordinary highway-legal vehicles; set includeAllRoads to true to also include special-designation roads that allow only certain vehicle types. " +
    "IMPORTANT CAVEAT: the Forest Service's national data does NOT say which roads allow dispersed camping, so this layer does not either. " +
    "Many forests allow camping within a set distance (often one vehicle length to 300 feet) of these roads, but rules differ by forest and ranger district and can be closed by fire or season; " +
    "tell the user to confirm with the local ranger district or the forest's MVUM before camping. " +
    "Pair it with the campsites layer to show developed sites and trailhead parking. " +
    "United States National Forests only (nothing on other land or outside the US); dates the roads are open are not included beyond the seasonal flag. " +
    "Zoom in to a region under 20,000 km² (about a 140 km square) first; at most 2,000 road segments are returned and the result says so when it trims.",
  coverage: "us",
  license: "Public domain (USDA Forest Service)",
  requiredEnv: [],
  maxAreaKm2: 20_000,
  input: inputSchema,
  style: { geometry: "line", color: "#C4633F" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation: citation(), coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > mvumDispersed.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${mvumDispersed.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const result = await arcgisQuery(ctx, SERVICE_URL, {
      where: mvumWhere(input.includeAllRoads),
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: 0.0001,
      cacheSuffix: "mvum-roads",
      // The MVUM changes a few times a year at most.
      ttlSeconds: 86_400,
    });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizeMvum(result.fc),
      citation: citation(),
      ...(result.truncated ? { coverageNote: "Showing the first 2,000 road segments; zoom in for the rest" } : {}),
    };
  },
});

registerLayer(mvumDispersed);

export default mvumDispersed;

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
 * gis_miles (the segment's length in miles) becomes `miles`.
 *
 * Wide mode (over 25,000 km², up to the whole US): the same query ordered by gis_miles, longest first, capped at the
 * wide strategy's limit and simplified to the view, with a count of every matching segment as `total`; run.ts writes
 * the note. ArcGIS ranks the whole national layer in one ordered page, so no box inside the US is too wide.
 * Live smoke check (wide), 2026-10-16: south-east Utah (-112,37 to -109,39.5, about 72,500 km²): 2,000 longest of 2,440
 * (Elk Ridge, 35 miles, first), 0.9 to 1.0 s, 0.9 MB; Colorado (-109,37 to -102,41, about 270,000 km²): 2,000 of 8,681,
 * 11.7 to 14.0 s, 1.0 MB; the West (-125,31 to -102,49): 2,000 of 112,950 (Lolo Trail, 77 miles, first), 7.8 s; the
 * lower 48 (about 15 million km²): 2,000 of 146,233, 8.8 to 9.6 s, 0.8 MB.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

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
  "gis_miles",
];

const MAX_RECORDS = 2000;
/** Over this the layer answers with the longest segments only (its maxAreaKm2). */
export const ALL_ROADS_MAX_AREA_KM2 = 25_000;
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

/** Simplification tolerance in degrees: about 10 m for a forest, about 1/4,000 of the box's width for a wide view. */
export function mvumOffset(bbox: BBox, wide: boolean): number {
  return wide ? Math.max(0.0001, (bbox[2] - bbox[0]) / 4_000) : 0.0001;
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

    const properties: Record<string, string | number | boolean> = {
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
    if (typeof p.gis_miles === "number" && Number.isFinite(p.gis_miles) && p.gis_miles > 0) {
      properties.miles = Math.round(p.gis_miles * 100) / 100;
    }

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

const MVUM_SOURCE = { source: "USDA Forest Service, Motor Vehicle Use Map: Roads", url: "https://data.fs.usda.gov/geodata/edw/datasets.php" };

const HELP: Record<string, FieldHelp> = {
  miles: {
    text: "The length of this road segment in miles, as the Forest Service's Motor Vehicle Use Map measures it (gis_miles); a road is often several segments.",
    unit: "mi",
    ...MVUM_SOURCE,
  },
  access: { text: "Which vehicles the Motor Vehicle Use Map opens the road to, and whether all year or only part of it.", ...MVUM_SOURCE },
  routeId: { text: "The Forest Service road number, as signed on the road and printed on the forest's Motor Vehicle Use Map.", ...MVUM_SOURCE },
};

/** The six MVUM classes in plain words. */
const ACCESS_LABELS: Record<string, string> = {
  "Roads open to all Vehicles, Yearlong": "All vehicles, all year",
  "Roads open to all Vehicles, Seasonal": "All vehicles, part of the year",
  "Roads open to highway legal vehicles only, Yearlong": "Highway-legal vehicles only, all year",
  "Roads open to highway legal vehicles only, Seasonal": "Highway-legal vehicles only, part of the year",
  "Special Designation, Yearlong": "Special designation (certain vehicles only), all year",
  "Special Designation, Seasonal": "Special designation (certain vehicles only), part of the year",
};

/** Every surface type the layer holds (distinct values read live 2026-10-16), code and all, in plain words. */
const SURFACE_LABELS: Record<string, string> = {
  "AC - ASPHALT": "Asphalt",
  "P - PAVED": "Paved",
  "PCC - PORTLAND CEMENT CONCRETE": "Concrete",
  "BST - BITUMINOUS SURFACE TREATMENT": "Chip seal (bituminous surface treatment)",
  "AGG - CRUSHED AGGREGATE OR GRAVEL": "Gravel",
  "AGG - LIMESTONE": "Limestone gravel",
  "AGG - SCORIA": "Scoria (volcanic cinder) gravel",
  "PIT - PIT RUN SHOT ROCK": "Pit-run rock",
  "IMP - IMPROVED NATIVE MATERIAL": "Improved dirt (native material with added rock)",
  "CSOIL - COMPACTED SOIL": "Compacted soil",
  "NAT - NATIVE MATERIAL": "Dirt (native material)",
  "FSOIL - FROZEN SOIL": "Frozen soil",
  "SOD - GRASS": "Grass",
  "OTHER - OTHER": "Other",
};

const CARD: CardSpec = {
  facts: [
    { key: "routeId", label: "Road number" },
    { key: "access", label: "Open to", values: ACCESS_LABELS },
    { key: "seasonal", label: "Seasonal", values: { true: "Yes, closed part of the year", false: "No, open all year" } },
    { key: "passengerCar", label: "Passenger cars", values: { true: "Open", false: "Not listed as open" } },
    { key: "highClearance", label: "High-clearance vehicles", values: { true: "Open", false: "Not listed as open" } },
    { key: "surface", label: "Surface", values: SURFACE_LABELS },
    { key: "miles", label: "Segment length", unit: "mi" },
    { key: "forest", label: "Forest" },
  ],
};

const forestRoads = defineLayer({
  id: "forest-roads",
  title: "Forest Service roads open to motor vehicles",
  description:
    "US Forest Service roads that are legally open to public motor vehicles (from each forest's Motor Vehicle Use Map), the roads you drive to find a dispersed (free, undeveloped) campsite in a National Forest. " +
    "Each line has routeId, name (when it has one), forest, access (the Forest Service class, such as 'Roads open to highway legal vehicles only, Seasonal'), " +
    "seasonal (true when closed part of the year), passengerCar (true when ordinary cars may use it) and highClearance, surface (paved, gravel, native dirt) and miles (the segment's length). " +
    "By default it shows roads open to ordinary highway-legal vehicles; set includeAllRoads to true to also include special-designation roads that allow only certain vehicle types. " +
    "IMPORTANT CAVEAT: the Forest Service's national data does NOT say which roads allow dispersed camping, so this layer does not either. " +
    "Many forests allow camping within a set distance (often one vehicle length to 300 feet) of these roads, but rules differ by forest and ranger district and can be closed by fire or season; " +
    "tell the user to confirm with the local ranger district or the forest's MVUM before camping. " +
    "Pair it with the campsites layer to show developed sites and trailhead parking. " +
    "United States National Forests only (nothing on other land or outside the US); dates the roads are open are not included beyond the seasonal flag. " +
    "Up to 25,000 km² (about a 160 km square) it returns the roads in the box, at most 2,000 segments, and says so when it trims; any wider US box, up to the whole country, returns the 2,000 longest segments, longest first, and the note gives the total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USDA Forest Service)",
  requiredEnv: [],
  maxAreaKm2: ALL_ROADS_MAX_AREA_KM2,
  // Ranking the whole national layer costs one count and one ordered page (under 12 s live), so the hard cap is the US.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "segment length in miles", rank: "longest", limit: MAX_RECORDS },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("forest-roads") },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation: citation(), coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 25,000 km²): the longest segments first, capped at the strategy's limit, plus a count for the note.
    const wide = ctx.wide === true;
    const result = await arcgisQuery(ctx, SERVICE_URL, {
      // A segment with no length would sort first in a descending order and fill the cap.
      where: wide ? `${mvumWhere(input.includeAllRoads)} AND gis_miles > 0` : mvumWhere(input.includeAllRoads),
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: mvumOffset(ctx.bbox, wide),
      ...(wide && {
        orderByFields: "gis_miles DESC",
        resultRecordCount: Math.min(MAX_RECORDS, ctx.wideStrategy?.limit ?? MAX_RECORDS),
        withCount: true,
      }),
      cacheSuffix: wide ? "mvum-roads:longest" : "mvum-roads",
      // The MVUM changes a few times a year at most.
      ttlSeconds: 86_400,
    });
    if (!result.ok) return { error: result.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizeMvum(result.fc),
      citation: citation(),
      ...(result.total !== undefined && { total: result.total }),
      ...(result.truncated && !wide ? { coverageNote: "Showing the first 2,000 road segments; zoom in for the rest" } : {}),
    };
  },
});

registerLayer(forestRoads);

export default forestRoads;

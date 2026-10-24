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
 * Added 2026-10-18 (field names read live from `?f=json` that day): operationalmaintlevel ("2 - HIGH CLEARANCE VEHICLES",
 * "3 - SUITABLE FOR PASSENGER CARS"...; nationally 85% are level 2, and a few hundred are blank, "0 - NOT MAINTAINED"
 * or a bare "2") becomes `level` (1 to 5) when it starts with a digit 1 to 5; districtname becomes `district`;
 * passengervehicle_datesopen ("04/02-12/14", "01/01-01/15,04/08-05/13,10/01-12/31", "06/01 - 9/30") becomes `carDates`
 * in words; motorhome, atv, motorcycle and e_bike_class1 ("open" or null) become `motorhome`, `atv`, `motorcycle` and
 * `eBike` when the field is filled; surfacetype is also grouped as `surfaceKind` (paved, gravel, dirt).
 * The maintenance level is how the Forest Service keeps the road up for traffic, so it says what can drive it; the
 * vehicle fields say only what is legal. Sedona (-111.9,34.75,-111.6,34.95) holds levels 2 to 5.
 *
 * Passenger cars (2026-10-23, UC14): `passengerCar` is the MVUM's legal class (the card says "Open to passenger cars by
 * law"); what a car can drive is the maintenance level, so the level chips are two plain groups: "Passenger car" (levels
 * 3 to 5, maintained for passenger cars) and "High clearance" (levels 1 and 2). The card keeps the level itself.
 * Camping rules (2026-10-23, AUDIT R14): no national source says where dispersed camping is closed, so the best-known
 * closures are kept by hand in layers/_data/closures.json (Sedona's two Coconino orders, BLM Moab, the Lake Tahoe Basin,
 * Crested Butte), each with its order, date and link read that day. A road inside a rule's box carries it on the card
 * (campingRule, campingRuleUrl), and the note names it; elsewhere the note says to check the district's closure orders.
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
import {
  defineLayer,
  type Attribute,
  type AttributeLevel,
  type BBox,
  type CardSpec,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type LegendSpec,
} from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { nameAttribute } from "./_shared/bands";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import CLOSURES from "./_data/closures.json";
import { groupColors } from "@/lib/render/attributes";
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
  "operationalmaintlevel",
  "districtname",
  "passengervehicle_datesopen",
  "motorhome",
  "atv",
  "motorcycle",
  "e_bike_class1",
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

/** The other vehicle classes the card lists: MVUM field, then property. */
const VEHICLE_FIELDS: [string, string][] = [
  ["motorhome", "motorhome"],
  ["atv", "atv"],
  ["motorcycle", "motorcycle"],
  ["e_bike_class1", "eBike"],
];

/** The maintenance level 1 to 5 from "3 - SUITABLE FOR PASSENGER CARS"; undefined for blank, "0 - NOT MAINTAINED" or other text. */
export function maintLevelOf(raw: unknown): number | undefined {
  const m = typeof raw === "string" ? /^\s*([1-5])\b/.exec(raw) : null;
  return m ? Number(m[1]) : undefined;
}

/** The surface type's group (paved, gravel or dirt); undefined for "OTHER - OTHER" or a code not listed. */
export function surfaceKindOf(surface: string): "paved" | "gravel" | "dirt" | undefined {
  const code = surface.split(" - ")[0].trim().toUpperCase();
  if (["AC", "P", "PCC", "BST"].includes(code)) return "paved";
  if (["AGG", "PIT"].includes(code)) return "gravel";
  if (["IMP", "CSOIL", "NAT", "FSOIL", "SOD"].includes(code)) return "dirt";
  return undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The dates a road is open to passenger cars, in words: "01/01-12/31" is "All year", "04/02-12/14" is "Apr 2 to Dec 14",
 * and several ranges are joined with commas. Undefined when the field holds no dates ("open", blank).
 */
export function datesOpen(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const ranges: string[] = [];
  for (const m of raw.matchAll(/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/g)) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    if (a < 1 || a > 12 || c < 1 || c > 12) continue;
    if (a === 1 && b === 1 && c === 12 && d === 31) return "All year";
    ranges.push(`${MONTHS[a - 1]} ${b} to ${MONTHS[c - 1]} ${d}`);
  }
  return ranges.length > 0 ? ranges.join(", ") : undefined;
}

/** Maps MVUM road rows to line features, skipping rows with no geometry or route id. */
export function normalizeMvum(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    // The service pads road numbers ("00153"); the sign and the paper map read "153".
    const routeId = str(p.id)?.replace(/^0+(?=[0-9A-Za-z])/, "");
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
    // No name: the road number is what is signed on the road and printed on the map ("Forest Road 152C").
    else properties.heading = `Forest Road ${routeId}`;
    const forest = str(p.forestname);
    if (forest !== undefined) properties.forest = forest;
    const district = str(p.districtname);
    if (district !== undefined) properties.district = district;
    const level = maintLevelOf(p.operationalmaintlevel);
    if (level !== undefined) properties.level = level;
    const surface = str(p.surfacetype);
    if (surface !== undefined) {
      properties.surface = surface;
      const group = surfaceKindOf(surface);
      if (group !== undefined) properties.surfaceKind = group;
    }
    const carDates = datesOpen(p.passengervehicle_datesopen);
    if (carDates !== undefined) properties.carDates = carDates;
    for (const [field, key] of VEHICLE_FIELDS) {
      const v = str(p[field]);
      if (v !== undefined) properties[key] = v.toLowerCase() === "open";
    }
    if (typeof p.gis_miles === "number" && Number.isFinite(p.gis_miles) && p.gis_miles > 0) {
      properties.miles = Math.round(p.gis_miles * 100) / 100;
    }

    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** One hand-kept dispersed-camping closure or rule (layers/_data/closures.json). */
export type CampingRule = {
  id: string;
  place: string;
  manager: string;
  rule: string;
  order: string;
  /** When the order was signed or the page dated, YYYY-MM-DD. */
  date: string;
  /** When the order ends, YYYY-MM-DD; a rule past it is not shown. */
  expires?: string;
  url: string;
  bbox: BBox;
  /** The national forest the rule holds on (a road's `forest`); unset holds on everything in the box. */
  forest?: string;
  /** `backcountry`: holds only on features tagged backcountry (walk-in camps), not on roads or campgrounds by a road. */
  appliesTo?: "backcountry";
  checked: string;
};

export const CAMPING_RULES: CampingRule[] = (CLOSURES as unknown as { rules: CampingRule[] }).rules;

/** The rules in force (not past `expires`) whose box meets the view's. */
export function campingRulesFor(bbox: BBox, now: Date = new Date(), rules: CampingRule[] = CAMPING_RULES): CampingRule[] {
  const today = now.toISOString().slice(0, 10);
  return rules.filter((r) => !bboxesDisjoint(bbox, r.bbox) && (r.expires === undefined || r.expires >= today));
}

/** "Coconino National Forest, Red Rock Ranger District: no camping ... (Forest Order 03-04-06-26-04, 2026-08-18)". */
export function campingRuleText(r: CampingRule): string {
  return `${r.manager}, ${r.place}: ${r.rule.charAt(0).toLowerCase()}${r.rule.slice(1)} (${r.order}, ${r.date})`;
}

/** The note's sentence on camping rules: the ones that meet the view, else where to look. */
export function campingRuleNote(rules: CampingRule[]): string {
  if (rules.length === 0) {
    return "No camping closure order on file for this area; check the ranger district's (or BLM field office's) closure orders before camping";
  }
  return `Camping rule${rules.length === 1 ? "" : "s"} here: ${rules.map((r) => `${campingRuleText(r)}, ${r.url}`).join("; ")}; elsewhere, check the district's closure orders`;
}

/** The middle of a line's extent, or null without coordinates. */
function middleOf(geometry: Geometry): [number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else c.forEach(visit);
  };
  if (geometry.type !== "GeometryCollection") visit(geometry.coordinates);
  return w <= e ? [(w + e) / 2, (s + n) / 2] : null;
}

/**
 * The rule a national forest road falls under when no order on file covers it: the Forest Service's general one, in
 * words that send the person to the district (36 CFR 261.58 lets each forest set its stay limit; 14 days is the usual).
 */
export function generalForestRule(district?: string): string {
  return `No closure order on file here: national forests generally allow dispersed camping outside developed sites unless an order or sign closes the area, usually up to 14 days; confirm with the ${district ? `${district} Ranger District` : "ranger district"}`;
}

/**
 * Puts the first rule whose box holds a feature's middle (and, for a rule with `forest`, whose forest is the feature's)
 * on it (campingRule, campingRuleUrl; mutates); returns how many. With `fallback`, a feature no rule covers gets the text
 * it returns (forest roads: the Forest Service's general rule).
 */
export function attachCampingRules(fc: FeatureCollection, rules: CampingRule[], fallback?: (f: Feature) => string | undefined): number {
  let n = 0;
  for (const f of fc.features) {
    const m = f.geometry ? middleOf(f.geometry) : null;
    if (!m || !f.properties) continue;
    const forest = f.properties.forest;
    const rule = rules.find(
      ({ bbox: [w, s, e, nn], forest: only, appliesTo }) =>
        m[0] >= w && m[0] <= e && m[1] >= s && m[1] <= nn && (only === undefined || only === forest) && (appliesTo !== "backcountry" || f.properties?.backcountry === true),
    );
    if (!rule) {
      const text = fallback?.(f);
      if (text) f.properties.campingRule = text;
      continue;
    }
    f.properties.campingRule = campingRuleText(rule);
    f.properties.campingRuleUrl = rule.url;
    n += 1;
  }
  return n;
}

/** "Flagstaff Ranger District" or "Flagstaff" as the service writes it, as the district's own name ("Flagstaff"). */
function districtName(raw: string): string {
  return raw.replace(/\s+Ranger\s+District$/i, "").trim();
}

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
  level: {
    text:
      "How the Forest Service maintains the road for traffic (its operational maintenance level), which says what can actually drive it: " +
      "level 2 is for high-clearance vehicles and is not kept up for ordinary cars, level 3 suits a careful driver in a passenger car, " +
      "levels 4 and 5 are smoother and often paved. Level 1 roads are closed to traffic. It is not a promise of current conditions.",
    scale: "1 (closed) to 5 (high comfort, usually paved)",
    ...MVUM_SOURCE,
  },
  passengerCar: {
    text:
      "Whether the Motor Vehicle Use Map makes the road legal for passenger cars. Legal is not the same as drivable: a level 2 road can be open " +
      "to cars by law and still need high clearance; read the maintenance level for what the road is built for.",
    ...MVUM_SOURCE,
  },
  campingRule: {
    text:
      "A dispersed-camping closure or rule that covers this area, from the managing agency's own order or page (kept by hand for the best-known " +
      "places: Sedona and the rest of the Coconino, Moab, the Lake Tahoe Basin, Crested Butte, Mount Rainier). Elsewhere it gives the Forest Service's general rule " +
      "(dispersed camping allowed outside developed sites unless closed, usually up to 14 days): check the ranger district's closure orders.",
  },
  carDates: { text: "The dates the Motor Vehicle Use Map opens the road to passenger cars each year.", ...MVUM_SOURCE },
  district: { text: "The Forest Service ranger district that manages the road; call it for current conditions, closures and camping rules.", ...MVUM_SOURCE },
  surfaceKind: { text: "The road's surface grouped as paved (asphalt, concrete, chip seal), gravel (crushed rock) or dirt (native soil).", ...MVUM_SOURCE },
};

/**
 * The maintenance levels as the two chips a driver chooses between, easiest first (the ramp's light end): levels 3 to
 * 5 are maintained for passenger cars, 1 and 2 for high-clearance vehicles at best. One chip stands for its levels.
 */
const LEVELS: AttributeLevel[] = [
  {
    value: 5,
    label: "Passenger car",
    help: "Levels 3 to 5: maintained for passenger cars (3 can be rough, so drive with care; 4 and 5 are smoother and often paved).",
  },
  { value: 4, label: "Passenger car" },
  { value: 3, label: "Passenger car" },
  {
    value: 2,
    label: "High clearance",
    help: "Levels 1 and 2: maintained for high-clearance vehicles only, not for ordinary cars (level 1 gets basic custodial care and is often closed).",
  },
  { value: 1, label: "High clearance" },
];

/** The card keeps the level itself, in words. */
const LEVEL_WORDS: Record<string, string> = {
  "5": "5, high comfort, often paved (passenger cars)",
  "4": "4, moderate comfort (passenger cars)",
  "3": "3, passenger cars driven with care (can be rough)",
  "2": "2, high-clearance vehicles only",
  "1": "1, basic custodial care, often closed (high clearance at best)",
};

const LEVEL_SCALE = "Forest Service operational maintenance level, 1 to 5";

const SURFACE_KINDS: AttributeLevel[] = [
  { value: "paved", label: "Paved" },
  { value: "gravel", label: "Gravel" },
  { value: "dirt", label: "Dirt" },
];

const ATTRIBUTES: Attribute[] = [
  { key: "level", type: "ordinal", label: "Maintenance level", levels: LEVELS, scale: LEVEL_SCALE, encode: "color", primary: true },
  { key: "surfaceKind", type: "category", label: "Surface", levels: SURFACE_KINDS },
  { key: "seasonal", type: "flag", label: "Seasonal (closed part of the year)" },
  { key: "miles", type: "measure", label: "Segment length", unit: "mi" },
  { key: "district", type: "category", label: "Ranger district" },
  nameAttribute(),
];

/** The key: one swatch per chip in the colors the map draws them (each level keyed to its chip). */
const CHIPS = [...new Set(LEVELS.map((l) => l.label))];
const CHIP_COLORS = groupColors(CHIPS.length);
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Maintenance level",
  field: "level",
  items: [
    ...LEVELS.map((l) => {
      const chip = LEVELS.find((x) => x.label === l.label)!;
      return { label: l.label, value: l.value, color: CHIP_COLORS[CHIPS.indexOf(l.label)], symbol: "line" as const, ...(chip.help && { help: chip.help }) };
    }),
    // A road with no level draws as the thin grey dash, keyed "Not rated" with the lines the scale does not rate.
  ],
  note: "Every road drawn is legal for motor vehicles at least part of the year; the level says what it is built for.",
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

const LEGAL = { true: "Yes", false: "Not listed as legal" };

const CARD: CardSpec = {
  facts: [
    { key: "level", label: "Maintenance level", values: LEVEL_WORDS },
    { key: "campingRule", label: "Camping rule here" },
    { key: "passengerCar", label: "Open to passenger cars by law", values: LEGAL },
    { key: "carDates", label: "Passenger cars allowed" },
    { key: "highClearance", label: "Legal for high-clearance vehicles", values: LEGAL },
    { key: "motorhome", label: "Legal for motorhomes", values: LEGAL },
    { key: "atv", label: "Legal for ATVs", values: LEGAL },
    { key: "motorcycle", label: "Legal for motorcycles", values: LEGAL },
    { key: "eBike", label: "Legal for e-bikes (class 1)", values: LEGAL },
    { key: "district", label: "Ranger district" },
    { key: "routeId", label: "Road number" },
    { key: "surface", label: "Surface", values: SURFACE_LABELS },
    { key: "seasonal", label: "Seasonal", values: { true: "Yes, closed part of the year", false: "No, open all year" } },
    { key: "access", label: "Open to", values: ACCESS_LABELS },
    { key: "miles", label: "Segment length", unit: "mi" },
    { key: "forest", label: "Forest" },
  ],
  links: [{ key: "campingRuleUrl", label: "Closure order" }],
  // The surface group repeats the surface row; the heading repeats the road number.
  hidden: ["surfaceKind", "heading"],
};

const forestRoads = defineLayer({
  id: "forest-roads",
  title: "Forest Service roads open to motor vehicles",
  description:
    "US Forest Service roads that are legally open to public motor vehicles (from each forest's Motor Vehicle Use Map), the roads you drive to find a dispersed (free, undeveloped) campsite in a National Forest. " +
    "Lines are colored by level, the Forest Service maintenance level, which says what the road is built for: 5 high comfort (often paved), 4 moderate comfort, 3 passenger cars with care (can be rough), 2 high-clearance vehicles only, 1 closed. " +
    "Most forest roads are level 2: legal for cars but not built for them, so answer 'can I drive my car there' from level (filter level 3, 4 and 5, the Passenger car chip), not from passengerCar, which is only the legal class. " +
    "Each line has routeId, name (when it has one), forest, district (the ranger district to call), level, access (the Forest Service class, such as 'Roads open to highway legal vehicles only, Seasonal'), " +
    "seasonal (true when closed part of the year), carDates (the dates passenger cars may use it, such as 'Apr 2 to Dec 14'), passengerCar, highClearance, motorhome, atv, motorcycle and eBike (true when legal for that vehicle; legal, not a sign the road suits it), " +
    "surface (the source's surface type), surfaceKind (paved, gravel or dirt) and miles (the segment's length). " +
    "By default it shows roads open to ordinary highway-legal vehicles; set includeAllRoads to true to also include special-designation roads that allow only certain vehicle types. " +
    "IMPORTANT CAVEAT: the Forest Service's national data does NOT say which roads allow dispersed camping, so this layer does not either. " +
    "Many forests allow camping within a set distance (often one vehicle length to 300 feet) of these roads, but rules differ by forest and ranger district and can be closed by fire or season; " +
    "tell the user to confirm with the local ranger district or the forest's MVUM before camping. Every road carries campingRule: where a known order applies (Sedona, the Coconino's forest-wide 14-day and 30-foot rule, Moab, Lake Tahoe Basin, Crested Butte) the order with its link, else the Forest Service's general rule; quote it. " +
    "Pair it with the campsites layer to show developed sites and trailhead parking. " +
    "United States National Forests only (nothing on other land or outside the US); motorcycle and ATV trails (not roads) are not included. " +
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
  style: { geometry: "line", color: layerColor("forest-roads"), encode: { color: "level" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: LEGEND,
  // The longest named roads get their names on the map.
  labels: { field: "name", max: 5, rankBy: "miles" },
  // The road network as the Motor Vehicle Use Map stands; the seasonal dates are on each road, not a time axis.
  time: { shape: "none" },
  display: { units: "us", timeZone: "local" },

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

    const data = normalizeMvum(result.fc);
    const rules = campingRulesFor(ctx.bbox);
    attachCampingRules(data, rules, (f) => generalForestRule(typeof f.properties?.district === "string" ? districtName(f.properties.district) : undefined));
    const notes = [
      ...(result.truncated && !wide ? ["Showing the first 2,000 road segments; zoom in for the rest"] : []),
      campingRuleNote(rules),
    ];
    return {
      kind: "geojson",
      data,
      citation: citation(),
      ...(result.total !== undefined && { total: result.total }),
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(forestRoads);

export default forestRoads;

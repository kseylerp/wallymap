/**
 * Designated US wilderness areas (National Wilderness Preservation System).
 * Service (verified 2026-10-09, `?f=json` returns fields, a Tahoe-bbox query returns Desolation Wilderness):
 *   https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0
 *   polygon layer, maxRecordCount 2000. The brief's USFS EDW fallback was not needed.
 * Fields used (as the service spells them):
 *   NAME (string), Agency (string: "FS" | "BLM" | "NPS" | "FWS"), Acreage (integer),
 *   Designated (smallint, the year Congress designated it), STATE (string, two-letter code).
 * Output properties: name, agency, acres, designated, era, state, rules, v (acres).
 * Mechanic (2026-10-18): no `t`, so no time scrubber (the designation year answered no one's question, and it opened a
 * scrubber over a "where is wilderness" map); the year is a card fact and three eras are chips. `agency` is the color
 * category (Forest Service sage, BLM dark grey, Park Service pink, Fish and Wildlife purple) with a matching legend.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type Attribute, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";

const SERVICE_URL =
  "https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0";

const FIELDS = ["NAME", "Agency", "Acreage", "Designated", "STATE"];

/** Boundaries change rarely, so a day is a safe cache lifetime. */
const TTL_SECONDS = 86_400;

/** Spelled-out agency names; the service only holds short codes. */
const AGENCIES: Record<string, string> = {
  FS: "USFS",
  BLM: "BLM",
  NPS: "NPS",
  FWS: "FWS",
};

const TRUNCATED_NOTE = "Showing the 2,000 largest wilderness areas; zoom in for all";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** What the Wilderness Act rules out, the reason people ask (16 U.S.C. 1133(c)). */
export const RULES = "No motor vehicles, motorized equipment or mechanical transport such as bicycles and wheeled carts; travel on foot or horseback";

/** Vertices closer than this (degrees, about 100 m) to the last kept one are dropped. */
const THIN_STEP_DEG = 0.001;

/** A ring without vertices within THIN_STEP_DEG of the last kept one; null when it collapses below four positions. */
function thinRing(ring: Position[]): Position[] | null {
  if (ring.length < 4) return null;
  const out: Position[] = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.abs(ring[i][0] - last[0]) >= THIN_STEP_DEG || Math.abs(ring[i][1] - last[1]) >= THIN_STEP_DEG) out.push(ring[i]);
  }
  out.push(ring[0]);
  return out.length >= 4 ? out : null;
}

/**
 * Display geometry thinned to about 100 m. The service ignores maxAllowableOffset for this layer and sends the boundaries
 * as 70 m stair steps: four Tahoe areas were 7,700 vertices and 154 KB (2026-10-18). Small islands that collapse are dropped;
 * an outer ring that would collapse is kept as sent.
 */
export function thinGeometry(geometry: Geometry): Geometry {
  const polygon = (rings: Position[][]): Position[][] | null => {
    const outer = thinRing(rings[0] ?? []);
    if (outer === null) return null;
    return [outer, ...rings.slice(1).map(thinRing).filter((r): r is Position[] => r !== null)];
  };
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: polygon(geometry.coordinates) ?? geometry.coordinates };
  if (geometry.type === "MultiPolygon") {
    const parts = geometry.coordinates.map(polygon).filter((p): p is Position[][] => p !== null);
    return { type: "MultiPolygon", coordinates: parts.length > 0 ? parts : geometry.coordinates };
  }
  return geometry;
}

/**
 * "3 wilderness areas touch the view: North Fork Owyhee Wilderness (BLM, 43,413 acres), …": the largest five named with
 * manager and size, so a "who manages this and is it protected" answer can quote them (top 10 T06.5).
 */
export function wildernessSentence(features: Feature[]): string | undefined {
  if (features.length === 0) return undefined;
  const named = features
    .filter((f) => typeof f.properties?.name === "string")
    .sort((a, b) => Number(b.properties?.acres ?? 0) - Number(a.properties?.acres ?? 0))
    .slice(0, 5)
    .map((f) => {
      const p = f.properties ?? {};
      const bits = [typeof p.agency === "string" ? p.agency : undefined, typeof p.acres === "number" ? `${Math.round(p.acres).toLocaleString("en-US")} acres` : undefined].filter(Boolean);
      return `${p.name}${bits.length > 0 ? ` (${bits.join(", ")})` : ""}`;
    });
  const n = features.length;
  return `${n} wilderness ${n === 1 ? "area touches" : "areas touch"} the view: ${named.join(", ")}${n > named.length ? ", …" : ""}`;
}

/** Converts service rows to polygons with readable property names, `era` and `v` (acres). */
export function normalizeWilderness(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const acres = num(p.Acreage);
    const designated = num(p.Designated);
    const agency = str(p.Agency);
    const state = str(p.STATE);

    const properties: Record<string, string | number> = {
      name: str(p.NAME) ?? "Unnamed wilderness",
    };
    if (agency !== undefined) properties.agency = AGENCIES[agency] ?? agency;
    if (acres !== undefined) {
      properties.acres = acres;
      properties.v = acres;
    }
    if (designated !== undefined) {
      properties.designated = designated;
      properties.era = designated < 1980 ? "before-1980" : designated < 2000 ? "1980-1999" : "2000-on";
    }
    if (state !== undefined) properties.state = state;
    properties.rules = RULES;
    features.push({ type: "Feature", geometry: thinGeometry(f.geometry), properties });
  }
  return { type: "FeatureCollection", features };
}

/** The managing agencies spelled out for the card (the property keeps the short form). */
const AGENCY_NAMES: Record<string, string> = {
  USFS: "US Forest Service",
  BLM: "Bureau of Land Management",
  NPS: "National Park Service",
  FWS: "US Fish and Wildlife Service",
};

/** The managers as the map fills them: one color per agency. */
const AGENCY_FILLS: { value: string; color: string }[] = [
  // Four palette colors (2026-10-18: Forest Service dark sage and BLM dark grey read alike, Park Service sage faded into Topo).
  { value: "USFS", color: SAGE },
  { value: "BLM", color: DARK_GREY },
  { value: "NPS", color: PINK },
  { value: "FWS", color: PURPLE },
];

export const WILDERNESS_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Managed by",
  field: "agency",
  items: AGENCY_FILLS.map((a) => ({ label: AGENCY_NAMES[a.value], value: a.value, color: a.color, symbol: "polygon" as const })),
};

const ACRES: FieldHelp = { text: "The area of the wilderness in acres as the service records it, which can differ slightly from the drawn shape.", unit: "acres" };

const HELP: Record<string, FieldHelp> = {
  acres: ACRES,
  v: ACRES,
  designated: { text: "The year Congress designated the area as wilderness." },
  rules: {
    text: "The Wilderness Act of 1964 bans motor vehicles, motorized equipment, mechanical transport (bicycles, wheeled carts and game carts) and the landing of aircraft, drones included, in every wilderness; hiking, horses, camping and usually hunting and fishing are allowed. Each area can add its own rules.",
    source: "Wilderness Act, 16 U.S.C. 1133(c)",
    url: "https://wilderness.net/learn-about-wilderness/key-laws/wilderness-act/default.php",
  },
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "agency",
    type: "category",
    label: "Managed by",
    levels: AGENCY_FILLS.map((a) => ({ value: a.value, label: AGENCY_NAMES[a.value] })),
    encode: "color",
    primary: true,
  },
  {
    key: "era",
    type: "category",
    label: "Designated",
    levels: [
      { value: "before-1980", label: "Before 1980" },
      { value: "1980-1999", label: "1980 to 1999" },
      { value: "2000-on", label: "2000 and later" },
    ],
  },
  {
    key: "acres",
    type: "measure",
    label: "Area",
    unit: "acres",
    encode: "size",
    help: ACRES,
    presets: [
      { label: "Under 10,000 acres", max: 10_000 },
      { label: "10,000 to 100,000 acres", min: 10_000, max: 100_000 },
      { label: "100,000 acres and up", min: 100_000 },
    ],
  },
  { key: "name", type: "name", label: "Name" },
];

const CARD: CardSpec = {
  measure: { key: "acres", label: "Area", unit: "acres" },
  facts: [
    { key: "agency", label: "Managed by", values: AGENCY_NAMES },
    // A year: printed as it is ("1964"), never with a thousands comma.
    { key: "designated", label: "Designated", format: "date" },
    { key: "rules", label: "Rules" },
    { key: "state", label: "State" },
  ],
  hidden: ["era", "v"],
};

const wilderness = defineLayer({
  id: "wilderness",
  title: "Wilderness areas",
  description:
    "Boundaries of US federally designated wilderness areas, the strictest level of public land protection, from the National Wilderness Preservation System. " +
    "Each polygon has name, agency (the managing agency: USFS Forest Service, BLM, NPS National Park Service or FWS Fish and Wildlife Service), acres, designated (the year Congress protected it), era (before 1980, 1980 to 1999, 2000 and later), state, rules and v (acres). " +
    "The map fills each area by its managing agency with a legend and names the largest. The card states the Wilderness Act rule: no motor vehicles, motorized equipment or mechanical transport such as bicycles and wheeled carts, and no drone landings or takeoffs. " +
    "Use it to show where roadless, motor-free land is, for example when planning backpacking or checking where mountain bikes and vehicles are not allowed. " +
    "United States only; elsewhere it returns nothing. Boundaries are simplified for display, so edges are not survey-grade and should not be used for legal or permit decisions. " +
    "Acres is the figure the service records, which can differ slightly from the area of the drawn shape. " +
    "At most 2,000 areas are returned, largest first, and the result says when that cap is hit. " +
    "Zoom in to a region under 400,000 km² (about a 630 km square) first.",
  coverage: "us",
  surface: "land",
  license: "Public domain (Wilderness.net / USGS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("wilderness"), fillOpacity: 0.22 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: WILDERNESS_LEGEND,
  labels: { field: "name", max: 10, rankBy: "acres" },
  // Where wilderness is, not when: the designation year is a fact on the card and an era chip.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "National Wilderness Preservation System boundaries (Wilderness.net / USGS; public domain)",
      url: "https://wilderness.net/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > wilderness.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${wilderness.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxAllowableOffset: 0.002,
      orderByFields: "Acreage DESC",
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "wilderness",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeWilderness(res.fc);
    const notes = [wildernessSentence(data.features), ...(res.truncated ? [TRUNCATED_NOTE] : [])].filter((n): n is string => n !== undefined);
    return {
      kind: "geojson",
      data,
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(wilderness);

export default wilderness;

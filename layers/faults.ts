/**
 * Quaternary faults (moved in the last 1.6 million years) from the USGS Quaternary Fault and Fold Database of the United
 * States (2020 release), keyless ArcGIS: https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer/21
 * ("National Database", polylines, maxRecordCount 2000). Public domain (USGS).
 *
 * Fields read live from `?f=json` and distinct values on 2026-10-23: fault_name, section_name, fault_id, section_id,
 * linetype ("Well Constrained", "Moderately Constrained", "Inferred"), age ("historic", "latest Quaternary",
 * "late Quaternary", "middle and late Quaternary", "undifferentiated Quaternary", "class B"), slip_rate ("Less than 0.2
 * mm/yr", "Between 0.2 and 1.0 mm/yr", "Between 1.0 and 5.0 mm/yr", "Greater than 5.0 mm/yr", "Unspecified",
 * "Insufficient data", a few measured values such as "0.2 +/- 0.1 mm/yr"), slip_sense ("Normal", "Thrust", "Reverse",
 * "Right lateral", "Left lateral", "Strike slip", "Anticline", "Syncline", "Unspecified"), dip_direction, mapped_scale,
 * class ("A" proven Quaternary, "B" not proven), fault_url (the fault's USGS report). The database maps faults in
 * segments (Zion area, -113.6,36.9 to -112.6,37.6: 256 segments of 9 faults, Hurricane, Washington, Sevier/Toroweap,
 * Kolob Terrace...); the layer joins a section's segments of one location class into one line, so a section is one line
 * per location class, and only its longest line carries the name (the others the same heading on the card).
 *
 * Drawing: lines colored by the age of the last movement on the sage → pink → purple ramp (youngest purple), solid where
 * well located, dashed where approximate, dotted where inferred; class B faults (Quaternary age not proven) draw as the
 * thin grey dash of an unrated line. No dark grey line cores (owner, 2026-10-14), and widths by age are not drawn by the
 * line renderer, so color carries the age.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, Position } from "geojson";
import { defineLayer, type Attribute, type AttributeLevel, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { nameAttribute } from "./_shared/bands";
import { colorStops } from "@/lib/render/attributes";
import { layerColor } from "@/lib/render/palette";

export const FAULTS_URL = "https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer/21";
const FIELDS = ["fault_name", "section_name", "fault_id", "section_id", "linetype", "age", "slip_rate", "slip_sense", "dip_direction", "mapped_scale", "class", "fault_url"];
const MAX_RECORDS = 2000;
/** A state-sized box; California holds thousands of segments, and the service returns 2,000 at most. */
export const FAULTS_MAX_AREA_KM2 = 500_000;
/** How far past the box the note looks for the nearest faults when the box holds none. */
const NEAR_DEG = 0.5;
const TTL_SECONDS = 30 * 86_400;

/** The age classes, oldest first (the ramp's light end), then class B. Value is the property `ageClass`. */
export const AGE_LEVELS: AttributeLevel[] = [
  { value: "quaternary", label: "Quaternary (under 1.6 million years)", help: "Moved some time in the last 1.6 million years; the database cannot narrow it." },
  { value: "middle-late", label: "Middle and late Quaternary (under 750,000 years)", help: "Moved in the last 750,000 years." },
  { value: "late", label: "Late Quaternary (under 130,000 years)", help: "Moved in the last 130,000 years." },
  { value: "latest", label: "Latest Quaternary (under 15,000 years)", help: "Moved in the last 15,000 years: young, the most likely to move again." },
  { value: "historic", label: "Historic (since about 1700)", help: "Ruptured the surface in a recorded earthquake." },
  { value: "unproven", label: "Age unknown (class B, Quaternary movement not proven)", help: "Class B: geologic evidence of Quaternary movement is not conclusive." },
];

/** The ageClass for the database's age text. */
export function ageClassOf(age: unknown, cls?: unknown): string | undefined {
  const a = typeof age === "string" ? age.trim().toLowerCase() : "";
  if (a === "class b" || (typeof cls === "string" && cls.trim().toUpperCase() === "B")) return "unproven";
  if (a.startsWith("historic")) return "historic";
  if (a.startsWith("latest")) return "latest";
  if (a.startsWith("middle")) return "middle-late";
  if (a.startsWith("late")) return "late";
  if (a.includes("quaternary")) return "quaternary";
  return undefined;
}

/** How well the trace is located, from the database's linetype. */
export const LOCATION_LEVELS: AttributeLevel[] = [
  { value: "well", label: "Well located (solid)", help: "Mapped as well constrained: the trace is where the line is." },
  { value: "approximate", label: "Approximate (dashed)", help: "Moderately constrained: the trace is near the line." },
  { value: "inferred", label: "Inferred (dotted)", help: "Inferred: buried or not seen at the surface; the line is a best guess." },
];

export function locationOf(linetype: unknown): string | undefined {
  const t = typeof linetype === "string" ? linetype.trim().toLowerCase() : "";
  if (t.startsWith("well")) return "well";
  if (t.startsWith("moderately")) return "approximate";
  if (t.startsWith("inferred")) return "inferred";
  return undefined;
}

/** The slip rate in words and as a rank 1 (slowest) to 4 (fastest); measured values keep their own words. */
export function slipRateOf(raw: unknown): { text?: string; rank?: number } {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (/^less than 0\.2/i.test(t)) return { text: "Under 0.2 mm a year", rank: 1 };
  if (/^between 0\.2 and 1/i.test(t)) return { text: "0.2 to 1 mm a year", rank: 2 };
  if (/^between 1(\.0)? and 5/i.test(t)) return { text: "1 to 5 mm a year", rank: 3 };
  if (/^greater than 5/i.test(t)) return { text: "Over 5 mm a year", rank: 4 };
  const m = /^([\d.]+)\s*(?:\+\/-\s*([\d.]+))?\s*mm\/yr/i.exec(t);
  if (m) {
    const v = Number(m[1]);
    return { text: `${m[1]}${m[2] ? ` ± ${m[2]}` : ""} mm a year`, rank: v < 0.2 ? 1 : v < 1 ? 2 : v <= 5 ? 3 : 4 };
  }
  return { text: t && !/unspecified|insufficient/i.test(t) ? t : "Not known" };
}

/** The age class's rank for "youngest first": historic 5 down to Quaternary 1; class B 0. */
const AGE_RANK: Record<string, number> = { historic: 5, latest: 4, late: 3, "middle-late": 2, quaternary: 1, unproven: 0 };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function linesOf(g: Geometry | null): Position[][] {
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  return [];
}

function lengthKm(lines: Position[][]): number {
  let km = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const dx = (x1 - x0) * 111.32 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
      const dy = (y1 - y0) * 110.57;
      km += Math.hypot(dx, dy);
    }
  }
  return km;
}

/**
 * Database segments as lines: one feature per fault section and location class (its segments joined), with the age
 * class, location, slip rate and sense in words. Only the longest line of a section carries `name`; every line carries
 * `heading` (the card title), `fault` and `section`.
 */
export function normalizeFaults(fc: FeatureCollection): FeatureCollection<LineString | MultiLineString> {
  const groups = new Map<string, { props: Record<string, string | number>; lines: Position[][] }>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const lines = linesOf(f.geometry);
    if (lines.length === 0) continue;
    const fault = str(p.fault_name) ?? "Unnamed fault";
    const section = str(p.section_name);
    const ageClass = ageClassOf(p.age, p.class);
    const location = locationOf(p.linetype);
    const slip = slipRateOf(p.slip_rate);
    const key = [fault, section ?? "", ageClass ?? "", location ?? "", slip.text ?? "", str(p.slip_sense) ?? ""].join("|");
    const g = groups.get(key);
    if (g) {
      g.lines.push(...lines);
      continue;
    }
    const heading = section ? `${fault}, ${section}` : fault;
    const props: Record<string, string | number> = { heading, fault };
    if (section) props.section = section;
    if (ageClass) {
      props.ageClass = ageClass;
      props.recency = AGE_RANK[ageClass];
    }
    if (location) props.location = location;
    if (slip.text) props.slipRate = slip.text;
    if (slip.rank !== undefined) props.slipRank = slip.rank;
    const sense = str(p.slip_sense);
    if (sense && !/^unspecified$/i.test(sense)) props.slipSense = sense.replace(/;\s*/g, ", ");
    const dip = str(p.dip_direction);
    if (dip) props.dip = dip;
    const scale = str(p.mapped_scale);
    if (scale) props.mappedScale = scale;
    const url = str(p.fault_url);
    if (url) props.url = url;
    groups.set(key, { props, lines: [...lines] });
  }
  const features: Feature<LineString | MultiLineString>[] = [...groups.values()].map(({ props, lines }) => ({
    type: "Feature",
    geometry: lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines },
    properties: { ...props, lengthKm: Math.round(lengthKm(lines) * 10) / 10 },
  }));
  // The longest line of each section carries the name (labels and the note's names); the rest only the heading.
  const longest = new Map<string, Feature>();
  for (const f of features) {
    const h = String(f.properties?.heading);
    const best = longest.get(h);
    if (!best || Number(f.properties?.lengthKm) > Number(best.properties?.lengthKm)) longest.set(h, f);
  }
  for (const f of longest.values()) if (f.properties) f.properties.name = f.properties.heading;
  // Youngest and fastest first, so the top of the list is what moved last.
  features.sort((a, b) => Number(b.properties?.recency ?? -1) - Number(a.properties?.recency ?? -1) || Number(b.properties?.slipRank ?? 0) - Number(a.properties?.slipRank ?? 0));
  return { type: "FeatureCollection", features };
}

const AGE_WORDS: Record<string, string> = Object.fromEntries(AGE_LEVELS.map((l) => [String(l.value), l.label.replace(/^(\w)/, (c) => c.toLowerCase())]));

/** The note: how many faults, the youngest and most active by name, and the ages present. */
export function faultsNote(fc: FeatureCollection, truncated: boolean): string {
  const byFault = new Map<string, { recency: number; slip: number; age?: string; slipText?: string; km: number }>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const name = String(p.fault);
    const cur = byFault.get(name) ?? { recency: -1, slip: 0, km: 0 };
    const recency = typeof p.recency === "number" ? p.recency : -1;
    const slip = typeof p.slipRank === "number" ? p.slipRank : 0;
    if (recency > cur.recency || (recency === cur.recency && slip > cur.slip)) {
      cur.recency = recency;
      cur.age = typeof p.ageClass === "string" ? p.ageClass : undefined;
    }
    if (slip > cur.slip) {
      cur.slip = slip;
      cur.slipText = typeof p.slipRate === "string" ? p.slipRate : undefined;
    }
    cur.km += Number(p.lengthKm ?? 0);
    byFault.set(name, cur);
  }
  const ranked = [...byFault.entries()].sort((a, b) => b[1].recency - a[1].recency || b[1].slip - a[1].slip || b[1].km - a[1].km);
  const named = ranked.slice(0, 4).map(([name, r]) => {
    const bits = [r.age ? AGE_WORDS[r.age].replace(/ \((.*)\)$/, ", $1") : undefined, r.slipText && r.slipText !== "Not known" ? `slip ${r.slipText.toLowerCase()}` : undefined].filter(Boolean);
    return `${name} (${bits.join("; ") || "age not given"})`;
  });
  const sections = fc.features.filter((f) => f.properties?.name).length;
  const cut = truncated ? `; the service returned its first ${MAX_RECORDS} segments, so some are left out: zoom in for all` : "";
  return (
    `${byFault.size} mapped Quaternary fault${byFault.size === 1 ? "" : "s"} (${sections} section${sections === 1 ? "" : "s"}) in the box from the USGS Quaternary Fault and Fold Database${cut}. ` +
    `Youngest and most active first: ${named.join(", ")}${ranked.length > 4 ? `, and ${ranked.length - 4} more` : ""}. ` +
    "Older bedrock faults (not active in the last 1.6 million years) are not in this database; the geologic map's sources draw some of them"
  );
}

/** The nearest faults outside a box with none: name, distance in km and direction from the box centre. */
export function nearestFaults(fc: FeatureCollection, bbox: BBox, max = 3): { name: string; km: number; dir: string }[] {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const best = new Map<string, { km: number; dir: string }>();
  for (const f of fc.features) {
    const name = str(f.properties?.fault_name) ?? str(f.properties?.fault);
    if (!name) continue;
    for (const line of linesOf(f.geometry)) {
      for (const [x, y] of line) {
        const dx = (x - cx) * 111.32 * Math.cos((cy * Math.PI) / 180);
        const dy = (y - cy) * 110.57;
        const km = Math.hypot(dx, dy);
        const cur = best.get(name);
        if (!cur || km < cur.km) {
          const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
          const dir = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((deg + 360) % 360) / 45) % 8];
          best.set(name, { km, dir });
        }
      }
    }
  }
  return [...best.entries()]
    .sort((a, b) => a[1].km - b[1].km)
    .slice(0, max)
    .map(([name, v]) => ({ name, km: Math.round(v.km), dir: v.dir }));
}

const SOURCE = { source: "USGS Quaternary Fault and Fold Database of the United States", url: "https://www.usgs.gov/programs/earthquake-hazards/faults" };

const HELP: Record<string, FieldHelp> = {
  ageClass: {
    text: "When the fault last moved, from the database's age of the most recent deformation: historic (a recorded surface rupture), latest Quaternary (15,000 years), late Quaternary (130,000), middle and late Quaternary (750,000), or Quaternary (1.6 million years).",
    ...SOURCE,
  },
  slipRate: { text: "How fast the two sides move past each other on average, in millimetres a year, as the database's slip-rate class; faster faults have bigger or more frequent earthquakes.", ...SOURCE },
  slipSense: { text: "Which way the sides move: normal (pulling apart), reverse or thrust (pushing together), strike slip (sideways, right or left lateral).", ...SOURCE },
  location: { text: "How well the fault's trace is located on the ground: well constrained, moderately constrained, or inferred (buried or not seen).", ...SOURCE },
  lengthKm: { text: "The length of this line in the view, in kilometres (a fault section can be several lines).", unit: "km" },
  mappedScale: { text: "The scale of the map the trace was drawn from; 1:24,000 is detailed, 1:250,000 coarse.", ...SOURCE },
};

const ATTRIBUTES: Attribute[] = [
  { key: "ageClass", type: "ordinal", label: "Age of last movement", levels: AGE_LEVELS, scale: "USGS Quaternary fault age classes", encode: "color", primary: true },
  { key: "location", type: "category", label: "Location", levels: LOCATION_LEVELS, encode: "dash" },
  { key: "recency", type: "measure", label: "How recently it moved (5 historic, 1 Quaternary)" },
  { key: "slipRank", type: "measure", label: "Slip rate class (1 slowest, 4 fastest)" },
  nameAttribute("Fault"),
];

const AGE_ATTR = ATTRIBUTES[0];
const AGE_COLORS = new Map(colorStops(AGE_ATTR));

/** The key: the rated age classes in the colors the lines draw (class B draws the unrated thin grey dash). */
const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Age of last movement",
  field: "ageClass",
  items: AGE_LEVELS.filter((l) => l.value !== "unproven").map((l) => ({ label: l.label, value: l.value, color: AGE_COLORS.get(String(l.value)), symbol: "line" as const, ...(l.help && { help: l.help }) })),
  note: "Color is when the fault last moved: purple the youngest, sage the oldest. Solid lines are well located, dashed approximate, dotted inferred. Faults older than 1.6 million years are not shown.",
};

const CARD: CardSpec = {
  facts: [
    { key: "fault", label: "Name" },
    { key: "section", label: "Section" },
    { key: "ageClass", label: "Age", values: AGE_WORDS },
    { key: "slipRate", label: "Slip rate" },
    { key: "slipSense", label: "Slip sense" },
    { key: "location", label: "Location", values: Object.fromEntries(LOCATION_LEVELS.map((l) => [String(l.value), l.label.replace(/ \(.*\)$/, "")])) },
    { key: "dip", label: "Dips toward" },
    { key: "mappedScale", label: "Mapped at scale" },
    { key: "lengthKm", label: "Length in view", unit: "km", format: "1dp" },
  ],
  links: [{ key: "url", label: "USGS fault report" }],
  hidden: ["recency", "slipRank", "heading"],
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const faults = defineLayer({
  id: "faults",
  title: "Quaternary faults",
  description:
    "Active and young faults of the United States: faults and folds that moved in the last 1.6 million years, from the USGS Quaternary Fault and Fold Database, drawn as lines. " +
    "Use it for 'are there faults', 'fault lines near here', 'is this an active fault', 'earthquake faults'; pair it with geology when the question is about rocks and faults. " +
    "Each line has fault (the fault name, such as 'Hurricane fault zone'), section, ageClass (historic, latest = under 15,000 years, late = under 130,000, middle-late = under 750,000, quaternary = under 1.6 million, unproven = class B), " +
    "slipRate in words (such as 'Under 0.2 mm a year'), slipSense (Normal, Thrust, Right lateral...), location (well, approximate or inferred), dip and lengthKm; color is the age of last movement and the dash how well the trace is located. " +
    "The note counts the faults in the box and names the youngest and most active; quote it. If the box holds none, say 'no mapped Quaternary faults here' and name the nearest from the note; older bedrock faults (not active in 1.6 million years) are not in this database. " +
    "United States only; a box up to 500,000 km² (a large state).",
  coverage: "us",
  surface: "any",
  license: "Public domain (USGS)",
  requiredEnv: [],
  maxAreaKm2: FAULTS_MAX_AREA_KM2,
  input: z.object({}),
  style: { geometry: "line", color: layerColor("faults"), encode: { color: "ageClass" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: LEGEND,
  labels: { field: "name", max: 5, rankBy: "recency" },
  time: { shape: "none" },
  display: { units: "us" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = { ...SOURCE, source: "USGS Quaternary Fault and Fold Database of the United States, 2020 release (public domain)", retrieved: new Date().toISOString() };
    if (outsideUs(ctx.bbox)) return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    const [w, s, e, n] = ctx.bbox;
    const result = await arcgisQuery(ctx, FAULTS_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: Math.max(0.0001, (e - w) / 3000),
      cacheSuffix: "qfaults",
      ttlSeconds: TTL_SECONDS,
    });
    if (!result.ok) return { error: `The USGS fault database did not answer: ${result.error}`, hint: "upstream" };
    const data = normalizeFaults(result.fc);
    if (data.features.length > 0) return { kind: "geojson", data, citation, coverageNote: faultsNote(data, result.truncated) };
    // None in the box: name the nearest within about 50 km, so "are there faults" still gets an answer.
    const near: BBox = [Math.max(-180, w - NEAR_DEG), Math.max(-90, s - NEAR_DEG), Math.min(180, e + NEAR_DEG), Math.min(90, n + NEAR_DEG)];
    const around = await arcgisQuery(ctx, FAULTS_URL, {
      outFields: ["fault_name"],
      bbox: near,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: 0.005,
      cacheSuffix: "qfaults:near",
      ttlSeconds: TTL_SECONDS,
    });
    const nearest = around.ok ? nearestFaults(around.fc, ctx.bbox) : [];
    const nearText =
      nearest.length > 0
        ? ` The nearest are ${nearest.map((f) => `${f.name} (about ${f.km} km ${f.dir} of the box's centre)`).join(", ")}; zoom out to draw them.`
        : " None within about 50 km either.";
    return {
      kind: "geojson",
      data: EMPTY,
      citation,
      coverageNote: `No mapped Quaternary faults here (USGS Quaternary Fault and Fold Database: none moved in the last 1.6 million years inside the box).${nearText} Older bedrock faults are not in this database`,
    };
  },
});

registerLayer(faults);

export default faults;

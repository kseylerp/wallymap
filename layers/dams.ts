/**
 * US dams from the National Inventory of Dams (US Army Corps of Engineers).
 * Service (verified live 2026-10-10; `?f=json` lists the fields, a Glen Canyon box returns Glen Canyon Dam):
 *   https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/FeatureServer/0
 *   point layer, maxRecordCount 2000, about 92,000 dams, f=geojson works.
 * Fields used (as the service spells them):
 *   NAME, NIDID, YEAR_COMPLETED (integer, 0 or null when unknown), NID_STORAGE (acre-feet, the capacity NID uses),
 *   NID_HEIGHT (feet), PRIMARY_PURPOSE (spelled out, e.g. "Hydroelectric"), HAZARD_POTENTIAL ("High" | "Significant" | "Low" |
 *   "Undetermined"), RIVER_OR_STREAM, STATE, PRIMARY_OWNER_TYPE, PRIMARY_DAM_TYPE, CONDITION_ASSESSMENT.
 * Output: v = NID_STORAGE (acre-feet), t = January 1 of the year completed (so the scrubber plays dams by decade),
 * kind = primary purpose, plus name, nidId, heightFt, yearCompleted, purpose, hazard, river, state, owner, damType, condition.
 * Results are ordered by storage so the 2,000-dam cap keeps the biggest. Dams with no storage figure (about 3% of 92,627) are
 * filtered out with `NID_STORAGE > 0`, because a descending sort puts the null ones first and they would fill the cap.
 * Smoke check 2026-10-10 (live, through runLayer): the Glen Canyon box (-111.55,36.9,-111.4,37) returned Glen Canyon Dam (completed 1963,
 *   710 ft, 29,875,000 acre-feet, High hazard) in 0.5 s; an Arizona-Utah box (-114,34,-110,38) returned 216 dams in 0.4 s; the Bay Area
 *   (-122.5,37.2,-121.5,38) returned 96 dams in 4 s, Los Vaqueros (160,000 acre-feet) first. One call timed out at 25 s once, so the
 *   upstream is occasionally slow.
 * Smoke wide 2026-10-14 (live, through runLayer): the Colorado River basin (-117,31,-105,43.5, about 1.4 million km²) returned
 *   1,568 dams of 4,023 in 2.2 s (642 KB), Hoover Dam first; the service stopped short of the 2,000 asked for, and the note says so.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE_URL =
  "https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/FeatureServer/0";

const FIELDS = [
  "NAME",
  "NIDID",
  "YEAR_COMPLETED",
  "NID_STORAGE",
  "NID_HEIGHT",
  "PRIMARY_PURPOSE",
  "HAZARD_POTENTIAL",
  "RIVER_OR_STREAM",
  "STATE",
  "PRIMARY_OWNER_TYPE",
  "PRIMARY_DAM_TYPE",
  "CONDITION_ASSESSMENT",
  "OTHER_STRUCTURE_ID",
  "IS_ASSOCIATED_STRUCTURE",
];

/** The inventory is updated a few times a year. */
const TTL_SECONDS = 86_400;

const MAX_DAMS = 2000;

const TRUNCATED_NOTE = "Showing the 2,000 dams with the most storage; zoom in for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "N/A" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "1966-01-01T00:00:00.000Z" for a plausible completion year; Date.UTC would turn years 0 to 99 into 1900s, so build the string. */
function yearToIso(year: number): string | undefined {
  if (!Number.isInteger(year) || year < 1000 || year > 2100) return undefined;
  return `${year}-01-01T00:00:00.000Z`;
}

/** Service rows to dam points with readable names plus `t` (year completed) and `v` (storage in acre-feet). */
export function normalizeDams(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const storage = num(p.NID_STORAGE);
    const height = num(p.NID_HEIGHT);
    const year = num(p.YEAR_COMPLETED);
    const purpose = str(p.PRIMARY_PURPOSE);

    const properties: Record<string, string | number> = { name: str(p.NAME) ?? "Unnamed dam" };
    const nidId = str(p.NIDID);
    if (nidId !== undefined) properties.nidId = nidId;
    if (storage !== undefined) {
      properties.storageAf = storage;
      properties.v = storage;
    }
    if (height !== undefined && height > 0) properties.heightFt = height;
    const iso = year === undefined ? undefined : yearToIso(year);
    if (year !== undefined && iso !== undefined) {
      properties.yearCompleted = year;
      properties.t = iso;
    }
    if (purpose !== undefined) {
      properties.purpose = purpose;
      properties.kind = purpose;
    }
    const hazard = str(p.HAZARD_POTENTIAL);
    if (hazard !== undefined) properties.hazard = hazard;
    const river = str(p.RIVER_OR_STREAM);
    if (river !== undefined) properties.river = river;
    const state = str(p.STATE);
    if (state !== undefined) properties.state = state;
    const owner = str(p.PRIMARY_OWNER_TYPE);
    if (owner !== undefined) properties.owner = owner;
    const damType = str(p.PRIMARY_DAM_TYPE);
    if (damType !== undefined) properties.damType = damType;
    const condition = str(p.CONDITION_ASSESSMENT);
    if (condition !== undefined) properties.condition = condition;
    const structure = str(p.OTHER_STRUCTURE_ID);
    const associated = structure !== undefined || str(p.IS_ASSOCIATED_STRUCTURE)?.toLowerCase() === "yes";
    features.push({ type: "Feature", geometry: f.geometry, properties: associated ? { ...properties, [ASSOCIATED]: 1 } : properties });
  }
  return { type: "FeatureCollection", features: groupStructures(features) };
}

/** Marks a row the inventory files as another structure of a dam (a dike, a saddle dam); dropped once grouped. */
const ASSOCIATED = "__associated";

/** Words that say which structure of a reservoir a row is, not which reservoir: "Granby Dike 4" is Granby's. */
const STRUCTURE_WORDS = /\b(dam|dike|dyke|saddle|levee|spillway|embankment|main|auxiliary|aux|no|north|south|east|west|left|right|upper|lower)\b|#?\d+|\b[ivx]+\b/gi;

/** The reservoir a structure's name points at: "granby" for "Granby Dike 4" and "Granby Dam". */
export function structureStem(name: string): string {
  return name
    .toLowerCase()
    .replace(STRUCTURE_WORDS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "dike" for "Granby Dike 4", "saddle dam" for "North Saddle", else "structure". */
function structureKind(name: string): "dike" | "saddle dam" | "structure" {
  if (/\b(dike|dyke|levee)\b/i.test(name)) return "dike";
  if (/\bsaddle\b/i.test(name)) return "saddle dam";
  return "structure";
}

/** "4 dikes", "2 dikes and 1 saddle dam". */
export function structuresText(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(structureKind(n), (counts.get(structureKind(n)) ?? 0) + 1);
  const parts = (["dike", "saddle dam", "structure"] as const)
    .filter((k) => counts.has(k))
    .map((k) => {
      const n = counts.get(k) as number;
      return `${n} ${k === "structure" ? (n === 1 ? "other structure" : "other structures") : n === 1 ? k : `${k}s`}`;
    });
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Two structures closer than this (km) with one storage figure and one name stem are one reservoir's. */
const SAME_RESERVOIR_KM = 5;

function kmApart(a: Feature<Geometry>, b: Feature<Geometry>): number {
  if (a.geometry.type !== "Point" || b.geometry.type !== "Point") return Infinity;
  const [x1, y1] = a.geometry.coordinates;
  const [x2, y2] = b.geometry.coordinates;
  const kx = 111.32 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  return Math.hypot((x1 - x2) * kx, (y1 - y2) * 110.57);
}

/**
 * One point per reservoir. The inventory lists every structure of a reservoir (the dam, its dikes, its saddle dams) as a
 * row of its own, each with the whole reservoir's storage, so Granby Dam and Granby Dikes 1 to 4 were five entries of
 * 539,760 acre-feet in the top 10. Rows that share the inventory id (the dam's NIDID; its other structures carry an
 * OTHER_STRUCTURE_ID), or share the storage figure and the name stem within 5 km when a dike or saddle is named, are one
 * reservoir: the main dam (not filed as another structure, else the tallest) stays, with `structures` ("4 dikes").
 */
export function groupStructures(features: Feature<Geometry>[]): Feature<Geometry>[] {
  const groups: Feature<Geometry>[][] = [];
  const byId = new Map<string, Feature<Geometry>[]>();
  for (const f of features) {
    const p = f.properties as Record<string, string | number>;
    const id = typeof p.nidId === "string" ? p.nidId : undefined;
    let group = id !== undefined ? byId.get(id) : undefined;
    if (group === undefined && typeof p.storageAf === "number" && p.storageAf > 0) {
      const name = String(p.name);
      const stem = structureStem(name);
      group = groups.find((g) =>
        g.some((o) => {
          const q = o.properties as Record<string, string | number>;
          if (q.storageAf !== p.storageAf || stem === "" || structureStem(String(q.name)) !== stem) return false;
          // A dike or saddle in either name: otherwise two dams of one name and size are two dams.
          const structural = structureKind(name) !== "structure" || structureKind(String(q.name)) !== "structure";
          return structural && kmApart(o, f) <= SAME_RESERVOIR_KM;
        }),
      );
    }
    if (group === undefined) {
      group = [];
      groups.push(group);
    }
    group.push(f);
    if (id !== undefined && !byId.has(id)) byId.set(id, group);
  }
  return groups.map((group) => {
    const height = (f: Feature<Geometry>) => Number(f.properties?.heightFt ?? 0);
    const isMain = (f: Feature<Geometry>) => !f.properties?.[ASSOCIATED] && structureKind(String(f.properties?.name)) === "structure";
    const main = group.find(isMain) ?? group.find((f) => !f.properties?.[ASSOCIATED]) ?? [...group].sort((a, b) => height(b) - height(a))[0];
    const properties = { ...(main.properties as Record<string, string | number>) };
    delete properties[ASSOCIATED];
    const others = group.filter((f) => f !== main).map((f) => String(f.properties?.name));
    if (others.length > 0) properties.structures = structuresText(others);
    return { ...main, properties };
  });
}

const NID_URL = "https://nid.sec.usace.army.mil";

const ATTRIBUTES: Attribute[] = [
  {
    key: "hazard",
    type: "category",
    label: "Hazard potential",
    levels: [
      { value: "Low", label: "Low" },
      { value: "Significant", label: "Significant" },
      { value: "High", label: "High" },
      { value: "Undetermined", label: "Undetermined" },
    ],
  },
  { key: "storageAf", type: "measure", label: "Storage", unit: "acre-feet", encode: "size" },
  { key: "heightFt", type: "measure", label: "Height", unit: "ft" },
  { key: "kind", type: "category", label: "Purpose" },
  { key: "yearCompleted", type: "time", label: "Year completed" },
  nameAttribute(),
];

const STORAGE: FieldHelp = {
  text:
    "The dam's storage capacity in acre-feet as the National Inventory of Dams reports it (NID storage); one acre-foot is about 1,233 cubic " +
    "metres.",
  unit: "acre-feet",
  source: "US Army Corps of Engineers, National Inventory of Dams",
  url: NID_URL,
};

const HELP: Record<string, FieldHelp> = {
  storageAf: STORAGE,
  v: STORAGE,
  hazard: {
    text:
      "What would happen downstream if the dam failed or was mis-operated, not how likely that is or how sound the dam is. High: loss of human " +
      "life is probable. Significant: no probable loss of life, but economic loss, environmental damage or disruption of lifeline facilities. " +
      "Low: no probable loss of life and low economic and environmental losses, mostly on the owner's property.",
    scale: "Low, Significant, High (Undetermined when not assessed)",
    source: "US Army Corps of Engineers, National Inventory of Dams",
    url: NID_URL,
  },
  condition: {
    text:
      "The dam's most recent condition assessment as reported to the National Inventory of Dams (for example Satisfactory, Fair, Poor, " +
      "Unsatisfactory).",
    source: "US Army Corps of Engineers, National Inventory of Dams",
    url: NID_URL,
  },
  heightFt: { text: "The dam's height in feet as the inventory reports it.", unit: "ft" },
  nidId: { text: "The dam's identifier in the National Inventory of Dams." },
  kind: { text: "The dam's primary purpose as the inventory gives it." },
  structures: {
    text:
      "The reservoir's other structures (dikes and saddle dams that close gaps in its rim). The inventory lists each as a dam of its own " +
      "with the whole reservoir's storage, so they are counted here, on the main dam, instead of as separate dams.",
    source: "US Army Corps of Engineers, National Inventory of Dams",
    url: NID_URL,
  },
};

const CARD: CardSpec = {
  measure: { key: "storageAf", label: "Storage", unit: "acre-feet" },
  facts: [
    { key: "hazard", label: "Hazard potential" },
    { key: "heightFt", label: "Height", unit: "ft", format: "int" },
    { key: "yearCompleted", label: "Completed" },
    { key: "purpose", label: "Purpose" },
    { key: "river", label: "River" },
    { key: "owner", label: "Owner" },
    { key: "condition", label: "Condition" },
    { key: "structures", label: "Other structures" },
  ],
};

const dams = defineLayer({
  id: "dams",
  title: "Dams",
  description:
    "US dams from the National Inventory of Dams (Army Corps of Engineers): every high- and significant-hazard dam plus the larger low-hazard ones. Each point has name, v and storageAf (capacity in acre-feet), heightFt, yearCompleted and t (January 1 of that year, so the time scrubber plays dams by decade), purpose and kind (Hydroelectric, Flood Risk Reduction, Irrigation, Water Supply, Recreation and so on), hazard (High, Significant or Low: the damage if it failed, not the chance of failure or a safety rating), river, state, owner, damType and condition. A reservoir's dikes and saddle dams are folded into its main dam (structures, e.g. \"4 dikes\"), since the inventory gives each the whole reservoir's storage. About 3% of dams have no storage figure and are left out; year completed is missing for some old dams. At most 2,000 dams, biggest storage first; any US box answers, and over 250,000 km\u00b2 the note gives the total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (US Army Corps of Engineers, National Inventory of Dams)",
  requiredEnv: [],
  maxAreaKm2: 250_000,
  // Ranking the whole country costs one count and one ordered page, so the hard cap is the US itself.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "storage in acre-feet", limit: MAX_DAMS },
  input: z.object({}),
  style: { geometry: "point", color: layerColor("dams"), unit: "acre-feet", extrude: "v", cluster: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "National Inventory of Dams (US Army Corps of Engineers; public domain)",
      url: "https://nid.sec.usace.army.mil/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 250,000 km²): the same storage-ordered fetch, capped at the strategy's limit, plus a count for the note.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const res = await arcgisQuery(ctx, SERVICE_URL, {
      outFields: FIELDS,
      bbox: ctx.bbox,
      // About 3% of dams have no storage figure; ArcGIS sorts those first in a descending order, so they would fill the cap.
      where: "NID_STORAGE > 0",
      orderByFields: "NID_STORAGE DESC",
      resultRecordCount: Math.min(MAX_DAMS, wideLimit ?? MAX_DAMS),
      withCount: ctx.wide === true,
      ttlSeconds: TTL_SECONDS,
      cacheSuffix: "dams",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeDams(res.fc);
    const notes: string[] = [];
    if (res.truncated && !ctx.wide) notes.push(TRUNCATED_NOTE);
    if (data.features.length === 0) notes.push("No dams in the National Inventory of Dams for this area");
    return {
      kind: "geojson",
      data,
      citation,
      ...(res.total !== undefined && { total: res.total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(dams);

export default dams;

/**
 * BLM livestock grazing allotments and wild horse and burro areas (Bureau of Land Management).
 * Services (verified live 2026-10-09, keyless ArcGIS MapServers, `f=geojson` queries work, maxRecordCount 2000):
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer/12  "Grazing Allotment Polygons"
 *     fields used: ALLOT_NAME, ALLOT_NO (string, e.g. "03530"), GIS_ACRES, ADMIN_ST. (ACTIVE_DT is a placeholder year 9999.)
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_WHB/MapServer/0  "Herd Management Area (HMA) Polygons"
 *     fields used: HMA_NAME, HMA_ID, ADMIN_ST, ADMIN_AGCY ("BLM" | "USFS" | "UNK"), HERD_TYPE ("HORSE" | "BURRO" | "BOTH" | "UNK"), BLM_ACRES
 *   https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_WHB/MapServer/1  "Herd Area Polygons" (same fields; HA_NAME, HA_NO)
 * Herd areas are where horses and burros lived in 1971; herd management areas are the parts still managed for them.
 * Output `kind`: "allotment" | "herd-management-area" | "herd-area"; `v` is acres. A herd area and the herd management area of the same
 *   name and outline are one area, drawn once (mergeTwins); the kept one names the other in `alsoDesignated`.
 * Smoke through runLayer (2026-10-09): central Nevada -117,39,-116,40 returned 26 allotments, 10 herd management
 * areas and 13 herd areas in 0.7 s (see the test for the recorded counts).
 * Drawing (2026-10-18): `kind` is the layer's color category (KIND_LEVELS, GRAZING_LEGEND): herd management areas purple, historic
 * herd areas pink, allotments dark grey, stacked allotments first so the horse areas draw on top.
 * Smoke wide (2026-10-14): Nevada -119,37,-114,42 (about 240,000 km²) returned 535 polygons of 1,024 (333 per service) in 1.6 s
 * (276 KB); the first, cold call took 24 s, so the BLM servers are sometimes slow to wake.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { geometryBBox } from "./_shared/geo";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { DARK_GREY, layerColor, PINK, PURPLE } from "@/lib/render/palette";

const BASE = "https://gis.blm.gov/arcgis/rest/services/range";
const ALLOTMENTS = `${BASE}/BLM_Natl_Grazing_Allotment/MapServer/12`;
const HERD_MANAGEMENT_AREAS = `${BASE}/BLM_Natl_WHB/MapServer/0`;
const HERD_AREAS = `${BASE}/BLM_Natl_WHB/MapServer/1`;

const ALLOTMENT_FIELDS = ["ALLOT_NAME", "ALLOT_NO", "GIS_ACRES", "ADMIN_ST"];
const HMA_FIELDS = ["HMA_NAME", "HMA_ID", "ADMIN_ST", "ADMIN_AGCY", "HERD_TYPE", "BLM_ACRES"];
const HA_FIELDS = ["HA_NAME", "HA_NO", "ADMIN_ST", "ADMIN_AGCY", "HERD_TYPE", "BLM_ACRES"];

/** Boundaries change rarely, so a day is a safe cache lifetime. */
const TTL_SECONDS = 86_400;
const MAX_RECORDS = 2000;
/** Most polygons in a wide result, shared equally between the services asked. */
const WIDE_LIMIT = 1000;

const TRUNCATED_NOTE = "Showing the 2,000 largest allotments or herd areas in view; zoom in for all";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export type GrazingKind = "allotment" | "herd-management-area" | "herd-area";

const inputSchema = z.object({
  show: z.enum(["both", "allotments", "herds"]).default("both"),
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "UNK" and blank mean the agency did not record a value. */
function known(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined || text.toUpperCase() === "UNK" ? undefined : text;
}

const ANIMALS: Record<string, string> = { HORSE: "horses", BURRO: "burros", BOTH: "horses and burros" };

/** Display simplification in degrees: grows with the view because allotments are large, and up to 0.04 over a wide box. */
export function simplifyOffset(bbox: BBox, wide = false): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(wide ? 0.04 : 0.02, Math.max(0.001, span / 400));
}

/** Converts service rows of one kind to polygons with readable names, `kind` and `v` (acres). */
export function normalizeGrazing(fc: FeatureCollection, kind: GrazingKind): Feature<Geometry>[] {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { kind };

    if (kind === "allotment") {
      properties.name = str(p.ALLOT_NAME) ?? "Unnamed allotment";
      const number = str(p.ALLOT_NO);
      if (number !== undefined) properties.allotmentNumber = number;
      const acres = num(p.GIS_ACRES);
      if (acres !== undefined) {
        properties.acres = Math.round(acres);
        properties.v = Math.round(acres);
      }
    } else {
      const name = kind === "herd-area" ? str(p.HA_NAME) : str(p.HMA_NAME);
      properties.name = name ?? "Unnamed herd area";
      const id = kind === "herd-area" ? str(p.HA_NO) : str(p.HMA_ID);
      if (id !== undefined) properties.herdId = id;
      const herdType = str(p.HERD_TYPE)?.toUpperCase();
      if (herdType !== undefined && ANIMALS[herdType] !== undefined) properties.animals = ANIMALS[herdType];
      const agency = known(p.ADMIN_AGCY);
      if (agency !== undefined) properties.agency = agency;
      const acres = num(p.BLM_ACRES);
      if (acres !== undefined) {
        properties.acres = Math.round(acres);
        properties.v = Math.round(acres);
      }
    }
    const state = str(p.ADMIN_ST);
    if (state !== undefined) properties.state = state;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return features;
}

/** Which of two same-named areas with one outline is kept: the herd management area (managed today), then the herd area. */
const KIND_RANK: Record<GrazingKind, number> = { "herd-management-area": 0, "herd-area": 1, allotment: 2 };
const KIND_WORDS: Record<GrazingKind, string> = { "herd-management-area": "herd management area", "herd-area": "herd area", allotment: "grazing allotment" };

/** Share of the two boxes' union that both cover (1 for one outline). */
function boxOverlap(a: BBox, b: BBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: BBox) => (r[2] - r[0]) * (r[3] - r[1]);
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

/**
 * One area drawn once: a herd area and the herd management area carved from it, or an allotment of the same name, often
 * share one name and one outline (Little Owyhee, Beaty Butte: 59 such pairs over Nevada). Of two same-named areas whose
 * boxes overlap 80% or more, the herd management area is kept, then the herd area, then the allotment, and the kept one
 * lists the others in `alsoDesignated` ("herd area").
 */
export function mergeTwins(features: Feature<Geometry>[]): Feature<Geometry>[] {
  const ranked = [...features].sort((a, b) => KIND_RANK[a.properties?.kind as GrazingKind] - KIND_RANK[b.properties?.kind as GrazingKind]);
  const kept: { feature: Feature<Geometry>; key: string; box: BBox | null }[] = [];
  for (const f of ranked) {
    const key = String(f.properties?.name ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const box = geometryBBox(f.geometry);
    const twin = key && !key.startsWith("unnamed") && box ? kept.find((k) => k.key === key && k.box && boxOverlap(k.box, box) >= 0.8) : undefined;
    if (!twin) {
      kept.push({ feature: f, key, box });
      continue;
    }
    const props = (twin.feature.properties ??= {});
    const word = KIND_WORDS[f.properties?.kind as GrazingKind];
    if (word && word !== KIND_WORDS[props.kind as GrazingKind]) {
      const also = typeof props.alsoDesignated === "string" ? props.alsoDesignated.split(", ") : [];
      if (!also.includes(word)) props.alsoDesignated = [...also, word].join(", ");
    }
  }
  // Back in the services' order.
  return features.filter((f) => kept.some((k) => k.feature === f));
}

/** The three kinds in plain words, with what each means (the chips, the legend and the card read these). */
export const KIND_LEVELS = [
  {
    value: "herd-management-area",
    label: "Wild horse and burro management area",
    help: "Land the BLM or Forest Service manages today for a herd of wild horses or burros: the place to look for them.",
  },
  {
    value: "herd-area",
    label: "Historic herd area (1971)",
    help: "Where wild horses or burros lived when the 1971 Wild Free-Roaming Horses and Burros Act passed; outside a management area it usually has no herd today.",
  },
  {
    value: "allotment",
    label: "Grazing allotment",
    help: "An area where the BLM permits livestock (cattle or sheep) to graze; it does not mean animals are there now.",
  },
] as const;

/** Wild horse areas, the answer people want, purple (sage faded into green Topo under the grey allotments, 2026-10-18). */
const KIND_COLORS: Record<GrazingKind, string> = { "herd-management-area": PURPLE, "herd-area": PINK, allotment: DARK_GREY };

/** The map's key: one fill per kind, herd management areas purple, historic herd areas pink, allotments dark grey. */
export const GRAZING_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Area",
  field: "kind",
  items: KIND_LEVELS.map((l) => ({ label: l.label, value: l.value, color: KIND_COLORS[l.value], symbol: "polygon" as const, help: l.help })),
};

const ACRES: FieldHelp = { text: "The area's size as the BLM records it (GIS acres for allotments, BLM acres for herd areas).", unit: "acres", source: "Bureau of Land Management", url: "https://gis.blm.gov/" };

const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Kind of area", levels: KIND_LEVELS.map((l) => ({ ...l })), encode: "color", primary: true },
  {
    key: "animals",
    type: "category",
    label: "Animals",
    levels: [
      { value: "horses", label: "Horses" },
      { value: "burros", label: "Burros" },
      { value: "horses and burros", label: "Horses and burros" },
    ],
  },
  {
    key: "acres",
    type: "measure",
    label: "Size",
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

const HELP: Record<string, FieldHelp> = {
  kind: { text: KIND_LEVELS.map((l) => `${l.label}: ${l.help}`).join(" ") },
  acres: ACRES,
  animals: { text: "Which wild animals the herd area is for, as the BLM records it (HERD_TYPE)." },
  agency: { text: "The agency that manages the herd: BLM (Bureau of Land Management) or USFS (Forest Service)." },
  allotmentNumber: { text: "The BLM's number for this grazing allotment, used on its grazing permits." },
  herdId: { text: "The BLM's number for this herd area or herd management area (state letters and digits, such as NV0311), used in its herd management plans and gather reports." },
  alsoDesignated: { text: "Other designations with the same name and outline, drawn once." },
};

const CARD: CardSpec = {
  measure: { key: "acres", label: "Size", unit: "acres", help: ACRES },
  facts: [
    { key: "kind", label: "Kind of area", values: Object.fromEntries(KIND_LEVELS.map((l) => [l.value, l.label])) },
    { key: "animals", label: "Animals" },
    { key: "agency", label: "Managed by", values: { BLM: "Bureau of Land Management", USFS: "US Forest Service" } },
    { key: "alsoDesignated", label: "Also designated" },
    { key: "allotmentNumber", label: "BLM allotment number" },
    { key: "herdId", label: "BLM herd area number" },
    { key: "state", label: "State" },
  ],
  hidden: ["v"],
};

/** Draw order: allotments underneath, then historic herd areas, then the herd management areas on top. */
const STACK: Record<GrazingKind, number> = { allotment: 0, "herd-area": 1, "herd-management-area": 2 };

/** The features in draw order (STACK), keeping the services' order within a kind. */
export function stack(features: Feature<Geometry>[]): Feature<Geometry>[] {
  return features
    .map((f, i) => ({ f, i }))
    .sort((a, b) => STACK[a.f.properties?.kind as GrazingKind] - STACK[b.f.properties?.kind as GrazingKind] || a.i - b.i)
    .map(({ f }) => f);
}

const grazingAllotments = defineLayer({
  id: "grazing-allotments",
  title: "BLM grazing allotments and wild horse areas",
  description:
    "Bureau of Land Management (BLM) grazing allotments, where cattle and sheep may graze on BLM public land, and the wild horse and burro areas, drawn as polygons in three distinct fills with a legend. " +
    "kind is 'herd-management-area' (land the BLM or Forest Service manages today for a wild horse or burro herd: name, herdId, animals, agency, state, acres; drawn purple, on top), 'herd-area' (where wild horses and burros were found in 1971, many no longer managed for them; drawn pink) or 'allotment' (a livestock grazing allotment: name, allotmentNumber, state, acres; drawn dark grey, underneath). acres (and v) is the size for all three. " +
    "Use it for 'where is there grazing or cattle on public land', 'is this allotment grazed', or 'where can I see wild horses or burros'. For wild horse or burro questions set show to 'herds' so only the herd areas draw, and point to the management areas; for grazing questions set show to 'allotments'; the default draws both. " +
    "Caveats: only BLM allotments are included; Forest Service grazing allotments, a large share of federal grazing, are not in this dataset. An allotment is an administrative area where grazing is permitted, not proof that livestock are there now; allotments can include private and state land, and their gate and fence positions are not shown. " +
    "Herd areas are historic ranges, so a herd area outside a herd management area usually has no animals today, and herd management areas are the better place to look for wild horses. Animals are not located, only their ranges. " +
    "United States only (mostly the western states; Alaska has no BLM allotments in this dataset). Boundaries are simplified for display, so edges are not survey-grade. " +
    "At most 2,000 polygons per group are returned, largest first, and the result says when that cap is hit. " +
    "Over 150,000 km² (about a 390 km square) it keeps the 1,000 largest and gives the total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (Bureau of Land Management)",
  requiredEnv: [],
  maxAreaKm2: 150_000,
  wide: { orderBy: "acres", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("grazing-allotments"), fillOpacity: 0.18 },
  attributes: ATTRIBUTES,
  legend: GRAZING_LEGEND,
  fieldHelp: HELP,
  card: CARD,
  labels: { field: "name", max: 8, rankBy: "acres" },
  // Current boundaries, no dates.
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Bureau of Land Management, National Grazing Allotment and Wild Horse and Burro Herd Area datasets (public domain)",
      url: "https://gis.blm.gov/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 150,000 km²): the strategy's limit shared between the services, coarser lines, and a count per service.
    const wide = ctx.wide === true;
    const services = input.show === "both" ? 3 : input.show === "herds" ? 2 : 1;
    const wideLimit = wide ? ctx.wideStrategy?.limit : undefined;
    const common = {
      bbox: ctx.bbox,
      resultRecordCount: wideLimit === undefined ? MAX_RECORDS : Math.min(MAX_RECORDS, Math.floor(wideLimit / services)),
      maxAllowableOffset: simplifyOffset(ctx.bbox, wide),
      withCount: wide,
      ttlSeconds: TTL_SECONDS,
    };
    type Part = { label: string; kind: GrazingKind; result: Promise<ArcgisResult> };
    const parts: Part[] = [];
    if (input.show !== "herds") {
      parts.push({
        label: "Grazing allotments",
        kind: "allotment",
        result: arcgisQuery(ctx, ALLOTMENTS, { ...common, outFields: ALLOTMENT_FIELDS, orderByFields: "GIS_ACRES DESC", cacheSuffix: "blm-allotments" }),
      });
    }
    if (input.show !== "allotments") {
      parts.push(
        {
          label: "Herd management areas",
          kind: "herd-management-area",
          result: arcgisQuery(ctx, HERD_MANAGEMENT_AREAS, { ...common, outFields: HMA_FIELDS, orderByFields: "BLM_ACRES DESC", cacheSuffix: "blm-hma" }),
        },
        {
          label: "Herd areas",
          kind: "herd-area",
          result: arcgisQuery(ctx, HERD_AREAS, { ...common, outFields: HA_FIELDS, orderByFields: "BLM_ACRES DESC", cacheSuffix: "blm-ha" }),
        },
      );
    }
    const settled = await Promise.all(parts.map(async (p) => ({ ...p, result: await p.result })));

    const failed = settled.filter((p) => !p.result.ok);
    if (failed.length === settled.length) {
      const first = failed[0].result;
      return { error: first.ok ? "BLM services returned no response" : first.error, hint: "upstream" };
    }

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    let truncated = false;
    for (const part of settled) {
      if (!part.result.ok) {
        notes.push(`${part.label} could not be loaded`);
        continue;
      }
      features.push(...normalizeGrazing(part.result.fc, part.kind));
      truncated = truncated || part.result.truncated;
    }
    if (truncated && !wide) notes.push(TRUNCATED_NOTE);
    // The total is the sum of every service's count, so it only stands when each service answered one.
    const counts = settled.map((p) => (p.result.ok ? p.result.total : undefined));
    const total = wide && counts.every((c) => c !== undefined) ? counts.reduce((a: number, c) => a + (c ?? 0), 0) : undefined;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: stack(mergeTwins(features)) },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(grazingAllotments);

export default grazingAllotments;

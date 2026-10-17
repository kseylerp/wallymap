/**
 * BLM national monuments and national conservation areas (the National Conservation Lands), now and as they were in 2021.
 * Two keyless ArcGIS services (verified live 2026-10-10, f=geojson works on both):
 *   current: BLM NLCS national monuments, NCAs and similar designations (57 polygons),
 *     https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_NLCS_NM_NCA_poly/MapServer/1  (layer 0 is the same data)
 *     Fields: NCA_NAME (e.g. "Bears Ears", "Canyons of the Ancients National Monument"), Label, sma_code (BLM_NM national monument,
 *     BLM_NCA, BLM_MON, BLM_NA, BLM_FR forest reserve, BLM_NSA, BLM_CMPA, BLM_ONA; null for Bears Ears and Grand Staircase-Escalante),
 *     STATE_ADMN, NLCS_ID. The host answers curl and Node but returned 403 to Python's default user agent.
 *   2021: Utah AGRC's copy of the monuments' historic boundaries (10 polygons: Bears Ears, Grand Staircase-Escalante, Red Cliffs NCA,
 *     Beaver Dam Wash NCA and parts), "the historic spatial extent ... prior to being reduced",
 *     https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/BLMNationalMonumentsAndNCAs/FeatureServer/0
 *     Fields: NAME, NLCS_TYPE ("National Monument" | "National Conservation Area"), ADMIN_ST. Only the National Monument rows are used: the
 *     service says NCA boundaries are unchanged, and they are already in the current layer.
 * Live areas (this layer's own km2 figure, 2026-10-10): Bears Ears 5,678 km2 in the 2021 layer (plus a 266 km2 second polygon) against
 * 487 km2 in the current one; Grand Staircase-Escalante 7,575 against 730.
 * Output: name (without the designation), designation, state, kind ("current" | "2021"), v = area (km2) and areaKm2, source.
 * Smoke check 2026-10-10 (live, through runLayer): Utah-Arizona box -112,36.5,-108.5,38.5 returned 8 polygons in 0.4 s (2021: Grand Staircase-Escalante
 *   7,576 km2, Bears Ears 5,666 and 263; current: Bears Ears 487, Grand Staircase-Escalante 730, Canyons of the Ancients, Vermilion Cliffs, Baaj Nwaavjo
 *   I'tah Kukveni 3,856); the lower 48 with version "current" returned 56 polygons in 1.3 s.
 * Smoke wide 2026-10-14 (live, through runLayer): the US with Alaska -170,18,-60,72 (about 50 million km²) returned 1,003 polygons of
 *   1,081 in 2.8 s (286 KB). The current layer now holds 1,078 polygons, 942 of them California Coastal National Monument rocks, so
 *   a wide view keeps the 1,000 largest and leaves out only the smallest rocks.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { layerColor } from "@/lib/render/palette";

export const CURRENT_URL = "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_NLCS_NM_NCA_poly/MapServer/1";
export const HISTORIC_URL =
  "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/BLMNationalMonumentsAndNCAs/FeatureServer/0";
const TTL_SECONDS = 86_400;

const DESIGNATIONS: Record<string, string> = {
  BLM_NM: "National Monument",
  BLM_MON: "National Monument",
  BLM_NCA: "National Conservation Area",
  BLM_NA: "Outstanding Natural Area",
  BLM_ONA: "Outstanding Natural Area",
  BLM_FR: "Forest Reserve",
  BLM_NSA: "National Scenic Area",
  BLM_CMPA: "Cooperative Management and Protection Area",
};

const DESIGNATION_WORDS =
  /\s+(National Monument|National Conservation Area|National Scenic Area|Outstanding Natural Area|Cooperative Management and Protection Area|Forest Reserve|NCA)\s*$/i;

const NAME_FIXES: Record<string, string> = { "Grand Staircase Escalante": "Grand Staircase-Escalante" };

export type Version = "current" | "2021";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function ringKm2(ring: Position[]): number {
  if (ring.length < 4) return 0;
  const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111.32 * Math.cos((meanLat * Math.PI) / 180);
  const ky = 110.57;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  return Math.abs(sum / 2);
}

/** Area of a polygon geometry in km2 on a local flat projection (exterior rings minus holes); within about 1% at these sizes. */
export function areaKm2(geometry: Geometry | null): number {
  if (!geometry) return 0;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.reduce((total, rings) => total + ringKm2(rings[0] ?? []) - rings.slice(1).reduce((s, r) => s + ringKm2(r), 0), 0);
}

/** "Bears Ears National Monument" -> "Bears Ears"; "Grand Staircase Escalante" -> "Grand Staircase-Escalante". */
export function baseName(name: string): string {
  const stripped = name.replace(DESIGNATION_WORDS, "").trim();
  return NAME_FIXES[stripped] ?? stripped;
}

function designationOf(name: string, code: string | undefined): string | undefined {
  if (code !== undefined && DESIGNATIONS[code] !== undefined) return DESIGNATIONS[code];
  const m = DESIGNATION_WORDS.exec(name);
  if (!m) return undefined;
  return m[1].toUpperCase() === "NCA" ? "National Conservation Area" : m[1];
}

/** Current BLM rows to polygons with kind "current". */
export function normalizeCurrent(fc: FeatureCollection): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const raw = str(p.NCA_NAME) ?? str(p.Label);
    if (raw === undefined) continue;
    const area = Math.round(areaKm2(f.geometry));
    const properties: Record<string, string | number> = { name: baseName(raw), kind: "current", source: "BLM National Conservation Lands" };
    const designation = designationOf(raw, str(p.sma_code));
    if (designation !== undefined) properties.designation = designation;
    const state = str(p.STATE_ADMN) ?? str(p.STATE_GEOG);
    if (state !== undefined) properties.state = state;
    if (area > 0) {
      properties.areaKm2 = area;
      properties.v = area;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/** Utah AGRC historic rows (national monuments only) to polygons with kind "2021". */
export function normalizeHistoric(fc: FeatureCollection): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const raw = str(p.NAME);
    if (raw === undefined || str(p.NLCS_TYPE) !== "National Monument") continue;
    const area = Math.round(areaKm2(f.geometry));
    const properties: Record<string, string | number> = {
      name: baseName(raw),
      designation: "National Monument",
      kind: "2021",
      source: "Utah AGRC copy of the 2021 BLM boundaries",
    };
    const state = str(p.ADMIN_ST);
    if (state !== undefined) properties.state = state;
    if (area > 0) {
      properties.areaKm2 = area;
      properties.v = area;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/** Simplification in degrees: about 1/500 of the view width, between 0.0005 and 0.02 (0.05 over a wide box). */
export function offsetFor(bbox: BBox, wide = false): number {
  const width = bbox[2] - bbox[0];
  return Math.min(wide ? 0.05 : 0.02, Math.max(0.0005, Math.round((width / 500) * 100_000) / 100_000));
}

/** Most polygons in a wide result; the whole dataset is under 70, so this only bounds the request. */
const WIDE_LIMIT = 1000;

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Boundary",
    versions: true,
    levels: [
      { value: "2021", label: "2021 boundary" },
      { value: "current", label: "Current boundary" },
    ],
  },
  {
    key: "designation",
    type: "category",
    label: "Designation",
    levels: [...new Set(Object.values(DESIGNATIONS))].map((value) => ({ value, label: value })),
  },
  nameAttribute(),
];

const AREA: FieldHelp = {
  text: "Area of the outline in square kilometres, computed by this app from the simplified polygon (within about 1%).",
  unit: "km²",
};

const HELP: Record<string, FieldHelp> = {
  areaKm2: AREA,
  v: AREA,
  kind: {
    text:
      "current: the boundary as BLM draws it now; 2021: the Utah monument boundary before the changes, from Utah AGRC's copy of the historic BLM " +
      "extent.",
  },
  designation: { text: "The BLM National Conservation Lands designation: national monument, national conservation area or a similar unit." },
  source: { text: "Which dataset the outline came from." },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²" },
  facts: [
    { key: "kind", label: "Boundary", values: { current: "Current boundary", "2021": "2021 boundary" } },
    { key: "designation", label: "Designation" },
    { key: "state", label: "State" },
    { key: "source", label: "Source" },
  ],
};

const monuments = defineLayer({
  id: "monuments",
  title: "National monuments and conservation areas",
  description:
    "BLM national monuments and national conservation areas, as drawn now and, for the Utah monuments, in 2021. Each polygon has name, designation, state, kind ('current' or '2021'), v and areaKm2, and source. The current layer reflects the July 2026 boundary changes: Bears Ears is about 490 km² now against 5,700 in 2021, and Grand Staircase-Escalante about 730 against 7,600. version (both, current or 2021) picks what to return; compare the two kinds for then versus now. BLM-managed lands only, 2021 outlines exist only for Utah's monuments, and outlines are simplified, not for legal use.",
  coverage: "us",
  surface: "any",
  license: "Public domain (BLM National Conservation Lands; Utah AGRC copy of 2021 boundaries)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  wide: { orderBy: "area", limit: WIDE_LIMIT },
  input: z.object({
    version: z
      .enum(["both", "current", "2021"])
      .default("both")
      .describe("Which boundaries: 'current' (as BLM draws them now), '2021' (the Utah monuments before the changes) or 'both' (default)."),
  }),
  style: { geometry: "polygon", color: layerColor("monuments"), fillOpacity: 0.2 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "BLM National Landscape Conservation System boundaries; Utah AGRC copy of the 2021 boundaries",
      url: "https://www.blm.gov/programs/national-conservation-lands",
      retrieved: new Date().toISOString(),
    };

    // Wide (over 20 million km²): largest first, capped at the strategy's limit, coarser lines, and a count per service.
    const wide = ctx.wide === true;
    const wideLimit = wide ? ctx.wideStrategy?.limit : undefined;
    const offset = offsetFor(ctx.bbox, wide);
    const wantCurrent = input.version !== "2021";
    const wantHistoric = input.version !== "current";
    const [current, historic] = await Promise.all([
      wantCurrent
        ? arcgisQuery(ctx, CURRENT_URL, {
            outFields: ["NCA_NAME", "Label", "sma_code", "STATE_ADMN", "STATE_GEOG", "NLCS_ID"],
            bbox: ctx.bbox,
            maxAllowableOffset: offset,
            ...(wide && { orderByFields: "Shape.STArea() DESC", resultRecordCount: wideLimit, withCount: true }),
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: "monuments:current",
          })
        : null,
      wantHistoric
        ? arcgisQuery(ctx, HISTORIC_URL, {
            outFields: ["NAME", "NLCS_TYPE", "ADMIN_ST"],
            where: "NLCS_TYPE = 'National Monument'",
            bbox: ctx.bbox,
            maxAllowableOffset: offset,
            ...(wide && { orderByFields: "Shape__Area DESC", resultRecordCount: wideLimit, withCount: true }),
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: "monuments:2021",
          })
        : null,
    ]);

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    const failures: string[] = [];
    if (current !== null) {
      if (current.ok) features.push(...normalizeCurrent(current.fc));
      else failures.push(`current boundaries (${current.error})`);
    }
    if (historic !== null) {
      if (historic.ok) features.push(...normalizeHistoric(historic.fc));
      else failures.push(`2021 boundaries (${historic.error})`);
    }
    const asked = (current === null ? 0 : 1) + (historic === null ? 0 : 1);
    if (failures.length === asked) {
      return { error: `Monument boundaries unavailable: ${failures.join("; ")}`, hint: "upstream" };
    }
    if (failures.length > 0) notes.push(`Missing the ${failures.join(" and the ")}`);
    if (features.length === 0) notes.push("No BLM national monuments or conservation areas in this area");
    else if (input.version === "both" && features.some((f) => f.properties?.kind === "2021")) {
      notes.push("Two outlines: the 2021 boundary of the Utah monuments and the current BLM boundary");
    }

    // Biggest first so small monuments draw on top; "2021" before "current" so the present outline is never hidden.
    features.sort(
      (a, b) =>
        (a.properties?.kind === b.properties?.kind ? 0 : a.properties?.kind === "2021" ? -1 : 1) ||
        Number(b.properties?.v ?? 0) - Number(a.properties?.v ?? 0),
    );
    // The total adds each asked service's count, so it only stands when every one answered with a count.
    const counts = [current, historic].filter((r) => r !== null).map((r) => (r.ok ? r.total : undefined));
    const total = wide && counts.every((c) => c !== undefined) ? counts.reduce((a: number, c) => a + (c ?? 0), 0) : undefined;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(monuments);

export default monuments;

/**
 * Federal mineral leases in force: oil and gas, coal, and other solid minerals (hardrock such as copper and nickel,
 * potash, phosphate, sodium), from the Bureau of Land Management's Mineral and Land Records System (MLRS).
 *
 * Services (keyless ArcGIS, public domain, checked 2026-10-23 on BLM's new host):
 *   - Oil and gas: https://nlsdbpubgis.blm.gov/arcgis/rest/services/Fluid_Minerals/Oil_Gas_Leases_Production_Status/MapServer/0
 *     Authorized and interim leases with PRDCNG (production status: "Held by Actual Production", "Held by Allocated
 *     Production", "Non-Producing" and older codes). 171 leases in the Chaco Canyon box -108.3,35.9,-107.6,36.3 (148
 *     producing). maxRecordCount 2,000.
 *   - Coal: https://nlsdbpubgis.blm.gov/arcgis/rest/services/Solid_Minerals/Coal_Case_Disp/MapServer/0 (Authorized/Interim);
 *     the Alton coal tract near Grand Staircase-Escalante. maxRecordCount 1,000.
 *   - Other solid minerals: https://nlsdbpubgis.blm.gov/arcgis/rest/services/Solid_Minerals/Non_Energy_Leaseables_Case_Disp/MapServer/0
 *     (Authorized/Interim leases and prospecting permits); 37 in force near Ely, Minnesota, beside the Boundary Waters.
 * Every service shares the MLRS fields: CSE_NR (case), CSE_NAME (often blank), BLM_PROD (lease type), CSE_DISP,
 * CMMDTY (commodity), RCRD_ACRS, EFF_DT (effective date); oil and gas adds PRDCNG and EXP_DT. Shapes are drawn from the
 * legal description on the survey grid (whole sections or their parts), not surveyed corners.
 * Output per lease: name, kind ("oil-gas" | "coal" | "minerals"), producing ("producing" | "not producing", oil and gas
 * only), leaseType, commodity, status, acres and v (recorded acres), effective, expires, caseNumber, source.
 */
import { z } from "zod";
import type { Feature, Geometry } from "geojson";
import { defineLayer, type Attribute, type CardSpec, type FieldHelp, type LayerError, type LayerResult } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const HOST = "https://nlsdbpubgis.blm.gov/arcgis/rest/services";
export const SERVICES = {
  "oil-gas": `${HOST}/Fluid_Minerals/Oil_Gas_Leases_Production_Status/MapServer/0`,
  coal: `${HOST}/Solid_Minerals/Coal_Case_Disp/MapServer/0`,
  minerals: `${HOST}/Solid_Minerals/Non_Energy_Leaseables_Case_Disp/MapServer/0`,
} as const;
export type Kind = keyof typeof SERVICES;
export const KINDS = Object.keys(SERVICES) as Kind[];

const COMMON = ["CSE_NR", "CSE_NAME", "BLM_PROD", "CSE_DISP", "CMMDTY", "RCRD_ACRS", "EFF_DT"];
const FIELDS: Record<Kind, string[]> = { "oil-gas": [...COMMON, "PRDCNG", "EXP_DT"], coal: COMMON, minerals: COMMON };
/** The coal service's maxRecordCount is 1,000; the others answer 2,000. */
const LIMIT: Record<Kind, number> = { "oil-gas": 2000, coal: 1000, minerals: 1000 };
/** Lease records change as BLM processes cases; a day is fresh enough. */
const TTL_SECONDS = 86_400;

const KIND_LABEL: Record<Kind, string> = { "oil-gas": "Oil and gas lease", coal: "Coal lease", minerals: "Mineral lease" };
const SOURCE = "BLM Mineral and Land Records System (MLRS)";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An ArcGIS date (ms since 1970) as YYYY-MM-DD; dates before 1900 are bad entries. */
export function isoDay(value: unknown): string | undefined {
  const ms = num(value);
  if (ms === undefined || ms < Date.UTC(1900, 0, 1)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "O&G COMPETITIVE PUBLIC DOMAIN LEASE POST 1987" → "Oil and gas competitive public domain lease post 1987". */
export function plainWords(raw: unknown): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  const lower = s
    .replace(/\bO&G\b/gi, "oil and gas")
    .replace(/\bOil & Gas\b/gi, "oil and gas")
    .replace(/\bCOMP\b/g, "competitive")
    .replace(/\bNON-REG\b/g, "non-regulated")
    .replace(/\bLBA\b/g, "lease by application")
    .replace(/\bHDR\b/g, "hardrock")
    .replace(/\bPREF RGT\b/g, "preference right")
    .replace(/-ACQ\b/g, " on acquired land")
    .replace(/\bPD\b/g, "public domain")
    .replace(/\bNF\b/g, "national forest")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bminnesota\b/g, "Minnesota");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Oil and gas leases held by production (actual or allocated from a unit) produce; the rest do not. */
export function producingOf(raw: unknown): "producing" | "not producing" {
  return /held by (actual|allocated)/i.test(str(raw) ?? "") ? "producing" : "not producing";
}

/** Service rows to lease shapes. */
export function normalizeLeases(features: Feature[], kind: Kind): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const caseNumber = str(p.CSE_NR);
    const named = str(p.CSE_NAME);
    const properties: Record<string, string | number> = {
      name: named ? plainWords(named)! : caseNumber ? `${KIND_LABEL[kind]} ${caseNumber}` : KIND_LABEL[kind],
      kind,
      source: SOURCE,
    };
    if (caseNumber) properties.caseNumber = caseNumber;
    const leaseType = plainWords(p.BLM_PROD);
    if (leaseType) properties.leaseType = leaseType;
    const commodity = plainWords(p.CMMDTY);
    if (commodity) properties.commodity = commodity;
    const status = plainWords(p.CSE_DISP);
    if (status) properties.status = status;
    if (kind === "oil-gas") properties.producing = producingOf(p.PRDCNG);
    const acres = num(p.RCRD_ACRS);
    if (acres !== undefined && acres > 0) {
      properties.acres = Math.round(acres * 100) / 100;
      properties.v = properties.acres;
    }
    const effective = isoDay(p.EFF_DT);
    if (effective) properties.effective = effective;
    const expires = isoDay(p.EXP_DT);
    if (expires) properties.expires = expires;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

const KIND_LEVELS = [
  { value: "oil-gas", label: "Oil and gas", help: "A federal oil and gas lease: the right to drill for and produce oil and gas from federal minerals." },
  { value: "coal", label: "Coal", help: "A federal coal lease: the right to mine coal." },
  { value: "minerals", label: "Other minerals", help: "Leases and prospecting permits for other solid minerals: hardrock (copper, nickel) on acquired land, potash, phosphate, sodium, gilsonite." },
];

const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Lease", primary: true, levels: KIND_LEVELS },
  {
    key: "producing",
    type: "category",
    label: "Production",
    levels: [
      { value: "producing", label: "Producing", help: "Held by production: oil or gas is produced on the lease, or credited to it from a unit it belongs to." },
      { value: "not producing", label: "Not producing", help: "In force but not producing, so it lapses at the end of its term unless drilled." },
    ],
  },
  {
    key: "acres",
    type: "measure",
    label: "Area",
    unit: "acres",
    presets: [
      { label: "Under 640 acres", max: 640 },
      { label: "640 acres or more", min: 640 },
      { label: "2,000 acres or more", min: 2000 },
    ],
  },
  nameAttribute("Lease"),
];

const FIELD_HELP: Record<string, FieldHelp> = {
  acres: { text: "The acreage recorded with the lease (a section is 640 acres).", unit: "acres", source: "BLM MLRS" },
  producing: { text: "Whether the lease is held by production (oil or gas produced on it, or allocated to it from a unit), from BLM's production status.", source: "BLM MLRS" },
  status: { text: "Where the case stands at BLM: Authorized (in force) or Interim.", source: "BLM MLRS" },
  effective: { text: "The date the lease took effect." },
  expires: { text: "The end of the lease's primary term; a producing lease continues past it." },
  leaseType: { text: "BLM's product name for the lease: how it was issued (competitive sale, non-competitive) and on what land." },
};

const CARD: CardSpec = {
  measure: { key: "acres", label: "Area", unit: "acres" },
  facts: [
    { key: "producing", label: "Production", values: { producing: "Producing", "not producing": "Not producing" } },
    { key: "commodity", label: "Commodity" },
    { key: "leaseType", label: "Lease type" },
    { key: "status", label: "Case status" },
    { key: "effective", label: "In effect since", format: "date" },
    { key: "expires", label: "Primary term ends", format: "date" },
    { key: "caseNumber", label: "BLM case" },
    { key: "source", label: "Source" },
  ],
  hidden: ["v", "kind"],
};

/** Most leases per kind in a view. */
const MAX_LEASES = 2000;

const mineralLeases = defineLayer({
  id: "mineral-leases",
  title: "Mineral leases",
  description:
    "Federal mineral leases in force on US land (BLM's lease records): oil and gas leases with whether each produces, coal leases, and leases and prospecting permits for other solid minerals (hardrock copper and nickel, potash, phosphate, sodium). " +
    "Use it for oil and gas or coal development near a park or monument ('is Chaco Canyon threatened by oil and gas', 'leases near the Boundary Waters'), and with monuments, wilderness or public-lands and the combine tool (within, near, with distance) to count leases and acres inside or near a protected area. " +
    "kinds picks oil-gas, coal, minerals (default all three). Each lease has name, kind, producing ('producing' or 'not producing', oil and gas only), commodity, leaseType, acres (v), effective (date), caseNumber. " +
    "Federal minerals only: state and private leases and the wells themselves are not in it. Shapes are drawn from the legal description on the survey grid, not surveyed corners. At most 2,000 per kind; over 10,000 km² the largest 2,000 by acres.",
  coverage: "us",
  surface: "land",
  license: "Public domain (US Bureau of Land Management, MLRS)",
  requiredEnv: [],
  maxAreaKm2: 10_000,
  // "Near Grand Staircase" asks about 15,000 km² or more; the wide answer keeps the largest leases.
  hardMaxAreaKm2: 40_000,
  wide: { mode: "ranked", limit: MAX_LEASES, orderBy: "area (acres)" },
  input: z.object({
    // One kind as a bare string ("oil-gas") is read as a list of one (the model sent it so on 2026-10-23).
    kinds: z
      .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.enum(["oil-gas", "coal", "minerals"])).min(1))
      .default(["oil-gas", "coal", "minerals"])
      .describe("Which leases: 'oil-gas', 'coal', 'minerals' (other solid minerals); default all three."),
  }),
  style: { geometry: "polygon", color: layerColor("mineral-leases"), fillOpacity: 0.2 },
  attributes: ATTRIBUTES,
  fieldHelp: FIELD_HELP,
  card: CARD,
  time: { shape: "none" },
  display: { units: "us" },
  labels: { field: "name", max: 5, rankBy: "acres", minZoom: 10 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Bureau of Land Management, Mineral and Land Records System (MLRS): oil and gas, coal and other mineral leases",
      url: "https://www.blm.gov/services/geospatial/GISData",
      retrieved: new Date().toISOString(),
    };
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    const kinds = [...new Set(input.kinds)];
    const wide = ctx.wide === true;
    const results = await Promise.all(
      kinds.map((kind) =>
        arcgisQuery(ctx, SERVICES[kind], {
          outFields: FIELDS[kind],
          bbox: ctx.bbox,
          resultRecordCount: Math.min(LIMIT[kind], wide ? (ctx.wideStrategy?.limit ?? MAX_LEASES) : MAX_LEASES),
          orderByFields: "RCRD_ACRS DESC",
          withCount: true,
          maxAllowableOffset: wide ? 0.001 : 0.0002,
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: `mineral-leases:${kind}`,
        }),
      ),
    );
    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    let total = 0;
    let counted = true;
    results.forEach((res, i) => {
      const kind = kinds[i];
      if (!res.ok) {
        failed.push(`${KIND_LEVELS.find((l) => l.value === kind)!.label.toLowerCase()} leases (${res.error})`);
        counted = false;
        return;
      }
      const leases = normalizeLeases(res.fc.features, kind);
      features.push(...leases);
      if (res.total !== undefined) total += res.total;
      else counted = false;
      if (!wide && res.truncated && (res.total === undefined || res.total > leases.length)) notes.push(`Showing the ${leases.length.toLocaleString("en-US")} largest ${KIND_LABEL[kind].toLowerCase()}s${res.total !== undefined ? ` of ${res.total.toLocaleString("en-US")}` : ""}; zoom in for the rest`);
    });
    if (failed.length === kinds.length) return { error: `Mineral leases unavailable: ${failed.join("; ")}`, hint: "upstream" };
    if (failed.length > 0) notes.push(`Missing the ${failed.join(" and the ")}`);
    const og = features.filter((f) => f.properties?.kind === "oil-gas");
    const producing = og.filter((f) => f.properties?.producing === "producing").length;
    const acres = Math.round(features.reduce((s, f) => s + Number(f.properties?.acres ?? 0), 0));
    const parts = KIND_LEVELS.map((l) => ({ label: l.label.toLowerCase(), n: features.filter((f) => f.properties?.kind === l.value).length })).filter((p) => p.n > 0);
    if (features.length === 0 && failed.length === 0) notes.unshift(`No federal ${kinds.map((k) => KIND_LEVELS.find((l) => l.value === k)!.label.toLowerCase()).join(", ")} leases in force in this area`);
    else if (features.length > 0)
      notes.unshift(
        `${features.length.toLocaleString("en-US")} federal leases in force in the box asked (${parts.map((p) => `${p.n.toLocaleString("en-US")} ${p.label}`).join(", ")}), ${acres.toLocaleString("en-US")} acres` +
          (og.length > 0 ? `; ${producing.toLocaleString("en-US")} of the ${og.length.toLocaleString("en-US")} oil and gas leases are producing` : ""),
      );
    notes.push("Federal minerals only: state and private leases and the wells are not included");
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(wide && counted && { total }),
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(mineralLeases);

export default mineralLeases;

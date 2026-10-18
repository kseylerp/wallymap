/**
 * Unpatented mining claims on US public land: the Bureau of Land Management's Mineral and Land Records System (MLRS),
 * read from whichever official service is live for the view.
 *
 * National (offline since 2026-10-14): https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer
 *   layer 1 = Active Mining Claims, layer 2 = Closed. BLM took the claim services off its public server on 2026-10-14
 *   (the folder lists no services; the MLRS "Not Closed" and "Closed (Past Year)" Hub services answer 404, checked 2026-10-17).
 *   The layer still asks it first for views outside Alaska and Nevada, so it works again the day BLM restores it.
 *   Claims there are drawn from legal descriptions on the survey grid (the quarter-quarter or section named), not as staked.
 * Alaska (live, checked 2026-10-18; BLM Alaska State Office, 9,708 active claims, edited 2026-10-15):
 *   https://gis.blm.gov/akarcgis/rest/services/minerals/BLM_AK_Federal_Mining_Claims/FeatureServer
 *   layer 0 = Active (recorded or interim), layer 1 = Closed. Boundaries as plotted from the location notices (sketches,
 *   claimant maps), so each claim is its own shape. Fields: CSE_NR, CSE_NAME, CSE_DISP, BLM_PROD, RCRD_ACRS, Report (the
 *   MLRS case report URL); active rows carry Location_Date, closed rows CSE_DISP_DT (the date it closed). No Location_Date on
 *   the closed layer: asking for it fails the whole query (400).
 * Nevada (live, checked 2026-10-18; Nevada Division of Minerals, a state agency, from BLM MLRS, data edited 2026-09-30):
 *   https://services.arcgis.com/CXYUMoYknZtf5Qr3/arcgis/rest/services/ArcOnlineNvStateClaims/FeatureServer
 *   layer 2 = quarter sections (or whole sections) with Join_Count, the number of active, filed, submitted or under-review
 *   claims in it (53,445 squares); layer 1 = one point per claim at its square's centre (642,001), with Serial_Number,
 *   Claim_Name, Claim_Type (upper case), Case_Disposition, Acres (a string), LocDate (date located), QSecID (the square),
 *   CountyForExport. There are no closed claims. Claimant names are masked for people, so the layer never reads them.
 *   The layer draws one square per quarter section holding `claims`, and names the newest claims in it from up to 2,000
 *   points (newest located first); a square whose claims were not all fetched lists the names it has.
 * Order and caps: 2,000 per status and service (the services' maxRecordCount). Nevada squares come busiest first.
 * Output per shape: name, kind ("active" | "closed"), claims (how many claims the shape stands for: 1 in Alaska and the
 *   national map, the square's count in Nevada), claimKind ("lode" | "placer" | "mill" | "tunnel"), claimType (plain words),
 *   inNationalPark, disposition (plain words), acres and v (recorded acres, when known), located (date located, YYYY-MM-DD),
 *   closed (date closed), caseNumber, report (MLRS case report URL), quarterSection, county, claimNames, source.
 * Smoke 2026-10-18 (live, through runLayer): Fairbanks box -147.8,64.9,-147.4,65.1 returned 57 active Alaska claims; the
 *   Nevada box -117,39.4,-116.8,39.6 returned 33 squares holding 167 active claims; Moab answers offline with the reason.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type SourceStatus } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const SERVICE_URL = "https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer";
export const LAYERS = { active: 1, closed: 2 } as const;
export const ALASKA_URL = "https://gis.blm.gov/akarcgis/rest/services/minerals/BLM_AK_Federal_Mining_Claims/FeatureServer";
export const ALASKA_LAYERS = { active: 0, closed: 1 } as const;
export const NEVADA_URL = "https://services.arcgis.com/CXYUMoYknZtf5Qr3/arcgis/rest/services/ArcOnlineNvStateClaims/FeatureServer";
export const NEVADA_SQUARES = 2;
export const NEVADA_CLAIMS = 1;
export type Status = keyof typeof LAYERS;

/** Alaska (the Aleutians west of the antimeridian are left out) and Nevada as boxes; a view inside one is answered by its service. */
export const ALASKA_BOX: BBox = [-180, 51, -129.9, 71.6];
export const NEVADA_BOX: BBox = [-120.01, 34.99, -114.03, 42.01];

/** When BLM took the national claim services offline. */
export const NATIONAL_OFFLINE_SINCE = "2026-10-14";
export const OFFLINE_MESSAGE =
  "The Bureau of Land Management took its national mining claim map offline on 14 October 2026; claims can be shown only in Alaska (BLM Alaska) and Nevada (Nevada Division of Minerals) until it returns.";

const FIELDS = ["CSE_NAME", "CSE_NR", "CSE_DISP", "BLM_PROD", "RCRD_ACRS", "QLTY", "MC_PATENTED"];
const ALASKA_FIELDS: Record<Status, string[]> = {
  active: ["CSE_NAME", "CSE_NR", "CSE_DISP", "BLM_PROD", "RCRD_ACRS", "Location_Date", "Report"],
  closed: ["CSE_NAME", "CSE_NR", "CSE_DISP", "BLM_PROD", "RCRD_ACRS", "CSE_DISP_DT", "Report"],
};
const NEVADA_SQUARE_FIELDS = ["QSecID", "Join_Count"];
const NEVADA_CLAIM_FIELDS = ["Serial_Number", "Claim_Name", "Claim_Type", "Case_Disposition", "Acres", "LocDate", "QSecID", "CountyForExport"];
/** Claim records change as filings arrive, but a day is fresh enough. */
const TTL_SECONDS = 86_400;
/** Most claims per status in a view; also the wide limit. */
const MAX_CLAIMS = 2000;
/** Wide views keep named claims only ("sorts after a space" also skips blank names, and avoids IS NOT NULL ... AND). */
export const NAMED = "CSE_NAME > ' '";
/** Claim names listed on a Nevada square's card. */
const MAX_NAMES = 5;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

type Source = "blm" | "alaska" | "nevada";
const SOURCE_LABEL: Record<Source, string> = {
  blm: "BLM national claim map (MLRS)",
  alaska: "BLM Alaska State Office",
  nevada: "Nevada Division of Minerals (from BLM records)",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") return num(Number(value));
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An ArcGIS date (ms since 1970) as YYYY-MM-DD; dates before 1850 are bad entries. */
export function isoDay(value: unknown): string | undefined {
  const ms = num(value);
  if (ms === undefined || ms < Date.UTC(1850, 0, 1)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Lode Claim", "LODE CLAIM - NATIONAL PARK", "Mill Site" → a kind code, its plain label and whether it lies in a national park. */
export function claimTypeOf(raw: unknown): { claimKind?: string; claimType?: string; inNationalPark?: true } {
  const s = str(raw)?.toLowerCase();
  if (!s) return {};
  const park = /national park/.test(s);
  const kind = /lode/.test(s) ? "lode" : /placer/.test(s) ? "placer" : /mill/.test(s) ? "mill" : /tunnel/.test(s) ? "tunnel" : undefined;
  const label = kind ? CLAIM_KIND_LABEL[kind] : s.charAt(0).toUpperCase() + s.slice(1);
  return { ...(kind && { claimKind: kind }), claimType: park ? `${label} in a national park` : label, ...(park && { inNationalPark: true as const }) };
}

const CLAIM_KIND_LABEL: Record<string, string> = { lode: "Lode claim", placer: "Placer claim", mill: "Mill site", tunnel: "Tunnel site" };

/** "ACTIVE", "UNDER REVIEW", "Filed" → "Active", "Under review", "Filed". */
export function dispositionOf(raw: unknown): string | undefined {
  const s = str(raw)?.toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : undefined;
}

/** Newest case numbers first ("UT106362534" before "UT101678581"); a claim without one goes last. */
export function byCaseNumberDesc(a: Feature<Geometry>, b: Feature<Geometry>): number {
  return String(b.properties?.caseNumber ?? "").localeCompare(String(a.properties?.caseNumber ?? ""));
}

/** National or Alaska service rows to claim shapes, one claim each; `status` becomes `kind`. */
export function normalizeClaims(fc: FeatureCollection, status: Status, source: Exclude<Source, "nevada"> = "blm"): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number | boolean> = { name: str(p.CSE_NAME) ?? "Unnamed claim", kind: status, claims: 1, source: SOURCE_LABEL[source] };
    const caseNumber = str(p.CSE_NR);
    if (caseNumber !== undefined) properties.caseNumber = caseNumber;
    Object.assign(properties, claimTypeOf(p.BLM_PROD));
    const disposition = dispositionOf(p.CSE_DISP);
    if (disposition !== undefined) properties.disposition = disposition;
    const acres = num(p.RCRD_ACRS);
    if (acres !== undefined && acres > 0) {
      properties.acres = acres;
      properties.v = acres;
    }
    const located = isoDay(p.Location_Date);
    if (located) properties.located = located;
    const closed = status === "closed" ? isoDay(p.CSE_DISP_DT) : undefined;
    if (closed) properties.closed = closed;
    const report = str(p.Report);
    if (report?.startsWith("https://")) properties.report = report;
    const quality = str(p.QLTY)?.split("\n")[0].trim();
    if (quality) properties.locationQuality = quality;
    const patented = str(p.MC_PATENTED);
    if (patented !== undefined) properties.patented = patented;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/**
 * Nevada's squares (quarter sections with a claim count) joined to its claim points by square id: each square becomes one
 * shape with `claims`, the newest claim names in it, the claim kinds, the newest location date, the county, and the recorded
 * acres when every claim in it was fetched. Squares come busiest first.
 */
export function normalizeNevada(squares: FeatureCollection, claims: FeatureCollection | null): Feature<Geometry>[] {
  type Claim = { name?: string; serial?: string; located?: string; acres?: number; kind?: string; type?: string; county?: string; disposition?: string };
  const bySquare = new Map<string, Claim[]>();
  for (const f of claims?.features ?? []) {
    const p = f.properties ?? {};
    const id = str(p.QSecID);
    if (!id) continue;
    const t = claimTypeOf(p.Claim_Type);
    const list = bySquare.get(id) ?? [];
    list.push({
      name: str(p.Claim_Name)?.replace(/\s+/g, " "),
      serial: str(p.Serial_Number),
      located: isoDay(p.LocDate),
      acres: num(p.Acres),
      kind: t.claimKind,
      type: t.claimType,
      county: str(p.CountyForExport),
      disposition: dispositionOf(p.Case_Disposition),
    });
    bySquare.set(id, list);
  }
  const out: Feature<Geometry>[] = [];
  for (const f of squares.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const square = str(p.QSecID);
    const count = num(p.Join_Count);
    if (!square || count === undefined || count < 1) continue;
    const list = (bySquare.get(square) ?? []).sort((a, b) => String(b.located ?? "").localeCompare(String(a.located ?? "")));
    const names = [...new Set(list.map((c) => c.name).filter((n): n is string => n !== undefined))];
    const first = names[0];
    const name = first === undefined ? `${count} active ${count === 1 ? "claim" : "claims"}` : count === 1 ? first : `${first} and ${count - 1} more ${count === 2 ? "claim" : "claims"}`;
    const properties: Record<string, string | number | boolean> = { name, kind: "active", claims: count, quarterSection: square, source: SOURCE_LABEL.nevada };
    if (names.length > 0) properties.claimNames = names.slice(0, MAX_NAMES).join(", ") + (count > Math.min(names.length, MAX_NAMES) ? ", …" : "");
    const kinds = [...new Set(list.map((c) => c.kind).filter((k): k is string => k !== undefined))];
    if (kinds.length === 1) {
      properties.claimKind = kinds[0];
      properties.claimType = list.find((c) => c.kind === kinds[0])?.type ?? CLAIM_KIND_LABEL[kinds[0]];
    } else if (kinds.length > 1) {
      properties.claimType = kinds.map((k) => CLAIM_KIND_LABEL[k]).join(", ");
    }
    if (list[0]?.located) properties.located = list[0].located;
    if (count === 1 && list[0]?.serial) properties.caseNumber = list[0].serial;
    if (count === 1 && list[0]?.disposition) properties.disposition = list[0].disposition;
    const county = list.find((c) => c.county)?.county;
    if (county) properties.county = `${county} County`;
    if (list.length === count && list.every((c) => c.acres !== undefined)) {
      const acres = Math.round(list.reduce((sum, c) => sum + (c.acres ?? 0), 0) * 100) / 100;
      if (acres > 0) {
        properties.acres = acres;
        properties.v = acres;
      }
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out.sort((a, b) => Number(b.properties?.claims ?? 0) - Number(a.properties?.claims ?? 0));
}

/** True when `inner` lies wholly inside `outer`. */
function within(inner: BBox, outer: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

type Part = { features: Feature<Geometry>[]; notes: string[]; failed: string[]; gone: boolean; total?: number };

const CLAIM_KIND_LEVELS = [
  { value: "lode", label: "Lode claim", help: "A claim on a vein or body of ore in rock (gold, silver, copper, lithium in clay)." },
  { value: "placer", label: "Placer claim", help: "A claim on loose deposits, such as gold in stream gravel or sand." },
  { value: "mill", label: "Mill site", help: "Up to 5 acres of non-mineral land used to process ore or support a mine; no mining on it." },
  { value: "tunnel", label: "Tunnel site", help: "A tunnel driven to find or reach veins; it holds the veins it cuts." },
];

const FIELD_HELP: Record<string, FieldHelp> = {
  claims: {
    text: "How many claims this shape stands for. In Alaska and on BLM's national map each shape is one claim. Nevada's state map groups claims by the quarter section (about 160 acres) their legal description names, so one square can hold dozens of overlapping claims.",
    source: "BLM MLRS; Nevada Division of Minerals",
  },
  acres: { text: "The acreage recorded with the claim (a full lode claim is about 20.66 acres). Shown for a Nevada square only when every claim in it was read.", unit: "acres" },
  disposition: {
    text: "Where the case stands at BLM: Active (maintenance fees paid), Filed (location notice recorded, fees not yet processed), Under review, or Closed (dropped, void or forfeited).",
    source: "BLM Mineral and Land Records System",
  },
  located: { text: "The date the claim was staked (located) on the ground; for a Nevada square, the newest claim in it." },
  closed: { text: "The date BLM closed the case." },
  quarterSection: { text: "The survey square the claims' legal description names: meridian, township, range, section and quarter (e.g. 21 0180N 0440E 014 NE)." },
  kind: { text: "Active claims are in force; closed claims have lapsed or were given up and the land is open again." },
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Status",
    primary: true,
    levels: [
      { value: "active", label: "Active", help: "In force (fees paid, or filed and being processed)." },
      { value: "closed", label: "Closed", help: "Lapsed, dropped or void; the land is open again." },
    ],
  },
  { key: "claimKind", type: "category", label: "Claim type", levels: CLAIM_KIND_LEVELS },
  {
    key: "claims",
    type: "measure",
    label: "Claims",
    presets: [
      { label: "One claim", max: 1 },
      { label: "5 or more", min: 5 },
      { label: "20 or more", min: 20 },
    ],
  },
  { key: "acres", type: "measure", label: "Recorded area", unit: "acres" },
  nameAttribute("Claim name"),
];

const CARD: CardSpec = {
  measure: { key: "claims", label: "Claims here" },
  facts: [
    { key: "claimType", label: "Claim type" },
    { key: "disposition", label: "Case status" },
    { key: "acres", label: "Recorded area", unit: "acres", format: "1dp" },
    { key: "located", label: "Staked", format: "date" },
    { key: "closed", label: "Closed", format: "date" },
    { key: "claimNames", label: "Newest claims here" },
    { key: "caseNumber", label: "BLM case" },
    { key: "quarterSection", label: "Survey square" },
    { key: "county", label: "County" },
    { key: "locationQuality", label: "How it was placed" },
    { key: "source", label: "Source" },
  ],
  links: [{ key: "report", label: "Open the BLM case record" }],
  hidden: ["v", "kind", "claimKind", "inNationalPark", "patented"],
};

const miningClaims = defineLayer({
  id: "mining-claims",
  title: "Mining claims",
  description:
    "Unpatented mining claims on US public land: staked claims for minerals that can limit other land use. Since 14 October 2026 BLM's national claim map is offline, so claims show only in Alaska (BLM Alaska, each claim as plotted from its location notice, active and closed) and Nevada (Nevada Division of Minerals, active claims only, grouped into the quarter-section squares their legal descriptions name, with a count per square); elsewhere the layer says the source is offline. Each shape has name, kind ('active' or 'closed'), claims (how many claims it stands for), claimType (lode, placer, mill site, tunnel site), disposition, acres when recorded, located (date staked), caseNumber. status picks active (default), closed or both. Shapes are not surveyed corners; do not use them to decide where to stake or camp. No mineral is named. At most 2,000 per status; over 2,500 km², 2,000 named claims and the total.",
  coverage: "us",
  surface: "land",
  license: "Public domain (US Bureau of Land Management, MLRS; Nevada Division of Minerals)",
  requiredEnv: [],
  maxAreaKm2: 2_500,
  // "Near Moab" asks about 13,000 km²; the wide answer is capped at MAX_CLAIMS, so a town-sized radius still answers
  // (in Alaska and Nevada with claims, elsewhere with the offline status) instead of being refused.
  hardMaxAreaKm2: 20_000,
  wide: { mode: "named", limit: MAX_CLAIMS },
  input: z.object({
    status: z
      .enum(["active", "closed", "both"])
      .default("active")
      .describe("Which claims: 'active' (default), 'closed' (lapsed or relinquished) or 'both'."),
  }),
  style: { geometry: "polygon", color: layerColor("mining-claims"), fillOpacity: 0.25, encode: { color: "claims" } },
  attributes: ATTRIBUTES,
  fieldHelp: FIELD_HELP,
  card: CARD,
  time: { shape: "none" },
  display: { units: "us" },
  labels: { field: "name", max: 5, rankBy: "claims", minZoom: 11 },
  legend: {
    kind: "ramp",
    title: "Claims in each shape",
    field: "claims",
    stops: [
      { label: "1", value: 1 },
      { label: "5", value: 5 },
      { label: "20", value: 20 },
      { label: "50+", value: 50 },
    ],
    note: "Alaska shapes are single claims as plotted from their notices; Nevada squares are quarter sections holding that many active claims. BLM's national claim map has been offline since 14 October 2026, so other states show nothing.",
  },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Bureau of Land Management, Mineral and Land Records System (MLRS) mining claims",
      url: "https://www.blm.gov/services/geospatial/GISData/mining-claims",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const statuses: Status[] = input.status === "both" ? ["active", "closed"] : [input.status];
    // Wide (over 2,500 km²): named claims only, the limit shared between the statuses asked, and a count of every claim
    // in the box for the note.
    const wide = ctx.wide === true && ctx.wideStrategy !== undefined;
    const perStatus = wide ? Math.floor((ctx.wideStrategy?.limit ?? MAX_CLAIMS) / statuses.length) : MAX_CLAIMS;

    /** One claim service with an active and a closed layer (national or Alaska). */
    async function claimService(source: "blm" | "alaska"): Promise<Part> {
      const base = source === "blm" ? SERVICE_URL : ALASKA_URL;
      const layerOf = (s: Status) => (source === "blm" ? LAYERS[s] : ALASKA_LAYERS[s]);
      const suffix = source === "blm" ? "mining-claims" : "mining-claims:ak";
      const [results, counts] = await Promise.all([
        Promise.all(
          statuses.map((status) =>
            arcgisQuery(ctx, `${base}/${layerOf(status)}`, {
              outFields: source === "blm" ? FIELDS : ALASKA_FIELDS[status],
              where: wide ? NAMED : undefined,
              bbox: ctx.bbox,
              resultRecordCount: perStatus,
              maxAllowableOffset: 0.0001,
              ttlSeconds: TTL_SECONDS,
              cacheSuffix: `${suffix}:${status}`,
            }),
          ),
        ),
        wide
          ? Promise.all(statuses.map((status) => arcgisCount(ctx, `${base}/${layerOf(status)}`, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: `${suffix}:${status}` })))
          : null,
      ]);
      const part: Part = { features: [], notes: [], failed: [], gone: false };
      results.forEach((res: ArcgisResult, i) => {
        const status = statuses[i];
        if (!res.ok) {
          part.failed.push(`${status} claims (${res.error})`);
          return;
        }
        // The services have no filing order to sort by cheaply, so the cap keeps an arbitrary 2,000; within a status the
        // newest case numbers (a stand-in for filing order) come first.
        part.features.push(...normalizeClaims(res.fc, status, source).sort(byCaseNumberDesc));
        if (res.truncated && !wide) part.notes.push(`Showing an arbitrary 2,000 ${status} claims, not the newest; zoom in for the rest`);
      });
      part.gone = part.failed.length === statuses.length && results.every((res) => !res.ok && res.status === 404);
      if (counts !== null && part.failed.length === 0 && counts.every((c) => c !== null)) part.total = counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
      return part;
    }

    /** Nevada's state service: active claims only, as quarter-section squares with counts and the newest names. */
    async function nevada(): Promise<Part> {
      const part: Part = { features: [], notes: [], failed: [], gone: false };
      if (!statuses.includes("active")) {
        part.notes.push("Nevada's state claim map lists active claims only");
        return part;
      }
      const [squares, claims, count] = await Promise.all([
        arcgisQuery(ctx, `${NEVADA_URL}/${NEVADA_SQUARES}`, {
          outFields: NEVADA_SQUARE_FIELDS,
          bbox: ctx.bbox,
          resultRecordCount: perStatus,
          orderByFields: "Join_Count DESC",
          maxAllowableOffset: 0.0001,
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: "mining-claims:nv:squares",
        }),
        arcgisQuery(ctx, `${NEVADA_URL}/${NEVADA_CLAIMS}`, {
          outFields: NEVADA_CLAIM_FIELDS,
          bbox: ctx.bbox,
          resultRecordCount: MAX_CLAIMS,
          orderByFields: "LocDate DESC",
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: "mining-claims:nv:claims",
        }),
        wide ? arcgisCount(ctx, `${NEVADA_URL}/${NEVADA_SQUARES}`, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "mining-claims:nv:squares" }) : null,
      ]);
      if (!squares.ok) {
        part.failed.push(`Nevada claims (${squares.error})`);
        return part;
      }
      part.features = normalizeNevada(squares.fc, claims.ok ? claims.fc : null);
      if (!claims.ok) part.notes.push("Nevada claim names did not load; squares show counts only");
      else if (claims.truncated) part.notes.push("Claim names are listed for the newest 2,000 claims in view");
      if (squares.truncated && !wide) part.notes.push("Showing the 2,000 Nevada squares with the most claims; zoom in for the rest");
      if (count !== null) part.total = count;
      return part;
    }

    const inAlaska = within(ctx.bbox, ALASKA_BOX);
    const inNevada = within(ctx.bbox, NEVADA_BOX);
    const touchesAlaska = !bboxesDisjoint(ctx.bbox, ALASKA_BOX);
    const touchesNevada = !bboxesDisjoint(ctx.bbox, NEVADA_BOX);

    let parts: Part[];
    let nationalDown: Part | null = null;
    if (inAlaska || inNevada) {
      parts = await Promise.all([...(inAlaska ? [claimService("alaska")] : []), ...(inNevada ? [nevada()] : [])]);
    } else {
      // Outside the two live state services: BLM's national map first (it covers every state when it is up), then the
      // state services for whatever part of the view they cover.
      const national = await claimService("blm");
      if (national.failed.length < statuses.length) {
        parts = [national];
      } else {
        nationalDown = national;
        parts = await Promise.all([...(touchesAlaska ? [claimService("alaska")] : []), ...(touchesNevada ? [nevada()] : [])]);
      }
    }

    const offline: SourceStatus = { ok: false, reason: "offline", message: OFFLINE_MESSAGE, since: NATIONAL_OFFLINE_SINCE };
    const answered = parts.filter((p) => p.failed.length === 0 || p.features.length > 0);
    if (answered.length === 0) {
      if (nationalDown !== null && parts.length === 0) {
        if (nationalDown.gone) return { error: `Mining claims are unavailable here: ${OFFLINE_MESSAGE}`, hint: "unavailable", sourceStatus: offline };
        return { error: `Mining claims unavailable: ${nationalDown.failed.join("; ")}`, hint: "upstream" };
      }
      const failed = parts.flatMap((p) => p.failed);
      if (failed.length > 0) return { error: `Mining claims unavailable: ${failed.join("; ")}`, hint: "upstream" };
    }

    const features = parts.flatMap((p) => p.features);
    const notes = parts.flatMap((p) => p.notes);
    const failed = parts.flatMap((p) => p.failed);
    if (failed.length > 0) notes.push(`Missing the ${failed.join(" and the ")}`);
    if (nationalDown !== null) notes.push("BLM's national claim map has been offline since 14 October 2026, so only Alaska and Nevada claims are shown");
    if (parts.some((p) => p.features.some((f) => f.properties?.source === SOURCE_LABEL.nevada))) {
      notes.push("Nevada claims are grouped by the quarter section their legal description names, not drawn as staked");
    }
    if (features.length === 0 && failed.length === 0) {
      notes.unshift(input.status === "both" ? "No mining claims in this area" : `No ${input.status} mining claims in this area`);
    }
    // The total counts every claim (or Nevada square) in the box, so it is only given when every part counted.
    const totals = parts.map((p) => p.total);
    const total = wide && failed.length === 0 && totals.length > 0 && totals.every((t) => t !== undefined) ? totals.reduce<number>((s, t) => s + (t ?? 0), 0) : undefined;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      ...(nationalDown !== null && { sourceStatus: { ok: true } as const }),
    };
  },
});

registerLayer(miningClaims);

export default miningClaims;

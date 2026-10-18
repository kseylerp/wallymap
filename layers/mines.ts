/**
 * Mines, prospects and mineral deposits in the United States from two USGS point datasets, both on the USGS energy ArcGIS server (keyless):
 *   MRDS, the Mineral Resources Data System (verified live 2026-10-10, point layer, maxRecordCount 2000, f=geojson works):
 *     https://energy.usgs.gov/arcgis/rest/services/Hosted/Mineral_Resource_Data_System/FeatureServer/0
 *     Fields: dep_id (deposit id, links to mrdata.usgs.gov/mrds/show-mrds.php?dep_id=...), site_name, dev_stat ("Producer", "Past Producer", "Plant",
 *     "Prospect", "Occurrence", "Unknown"), code_list (commodity codes separated by spaces, e.g. " U V" or " AU AG"; first code is the main one),
 *     grade (a letter). MRDS stopped being updated around 2011, so it is a historic record: closed mines are still listed.
 *   USMIN mine and prospect features (point layer 17 of the USMin_Prospect_and_mine_related_map_features service; layer 18 holds the mine
 *     polygons, not used): https://energy.usgs.gov/arcgis/rest/services/Hosted/USMin_Prospect_and_mine_related_map_features/FeatureServer/17
 *     Fields: ftr_type (47 kinds: Mine, Open Pit Mine, Adit, Mine Shaft, Prospect Pit, Quarry, Gravel Pit, Uranium Mine, Tailings - Pond, ...),
 *     ftr_name, topo_name and topo_date (the USGS topographic map the symbol was digitised from), state, county.
 * Both services put the "capped" flag under `properties` (see layers/_shared/arcgis.ts).
 * Density: Moab box -109.8,38.4,-109.4,38.7 held 169 MRDS records (128 mention uranium) and 1,526 USMIN symbols in -109.7,38.4,-109.5,38.6.
 * Output: MRDS points: commodity and kind = main commodity in plain words (gold, uranium, sand and gravel; every code spelled out),
 *   status (dev_stat as MRDS writes it; the card says it in plain words), commodities, grade, id, url, source "MRDS"; a site name ending in codes ("Lisbon Valley U,V")
 *   has them spelled out. USMIN points: featureType and kind = feature type, name, topoName, topoYear, state, county, source "USMIN".
 *   No v or t. Points are colored by status (style.encode.color) and ordered producers first for the map's five labels.
 * Newer source checked 2026-10-18: MSHA's Mines data set (status active or abandoned, commodity) is free but only a 7.3 MB weekly zip
 *   (arlweb.msha.gov/OpenGovernmentData/DataSets/Mines.zip), with no per-box service, so it is not used; the vintage is stated instead.
 * The `commodity` input filters MRDS only (USMIN symbols carry no commodity) with `code_list LIKE '% U %' OR ...` (both spellings of the
 *   list edges), which the server accepts.
 * Smoke check 2026-10-10 (live, through runLayer): Moab box -109.8,38.4,-109.4,38.7 returned 296 points in 0.6 s (169 MRDS, 127 USMIN; first MRDS "Discovery",
 *   uranium, copper, vanadium, Past Producer); commodity uranium with source mrds returned 128 in 0.4 s; commodity gold over the San Gabriel Mountains
 *   -118.3,34,-118,34.3 returned 8 sites.
 * Statewide (over 60,000 km², up to 1,200,000): every MRDS deposit in the box (up to 30,000, paged 2,000 at a time in object-id order),
 *   for "where are most of the mines in Nevada"; USMIN's symbols (153,150 in Nevada against 24,474 MRDS records, 2026-10-17) are only
 *   counted, and the note says they are left out. Nevada's 24,474 came back in 13 pages in about 2 s cold.
 * Duplicates: USMIN often draws a mine MRDS also lists ("Silver King Mine" from both at one spot); in "both", a USMIN symbol within 1 km of
 *   an MRDS site of the same name is dropped (MRDS has the commodities), one record listing a site twice within 1 km keeps the first, and
 *   two records of one name at one spot (15 m) are one site whatever their main commodity.
 * Wide (over 15,000 km², up to 60,000): named sites only (USMIN stores a blank name as one space, so most of its symbols drop out),
 *   2,000 split between the records asked, plus a count of every site in the box. Smoke 2026-10-14, box -111,36,-108.5,38.4 (59,000 km²):
 *   1,962 named (1,000 MRDS, all 962 named USMIN) of 9,942 in 1.0 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp, type LegendSpec, type QueryContext } from "./types";
import { haversineKm } from "./_shared/geo";
import { nameAttribute } from "./_shared/bands";
import { displayName } from "./_shared/names";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { OFF_WHITE, layerColor } from "@/lib/render/palette";

export const MRDS_URL = "https://energy.usgs.gov/arcgis/rest/services/Hosted/Mineral_Resource_Data_System/FeatureServer/0";
export const USMIN_URL =
  "https://energy.usgs.gov/arcgis/rest/services/Hosted/USMin_Prospect_and_mine_related_map_features/FeatureServer/17";
/** The records are decades old and change rarely. */
const TTL_SECONDS = 7 * 86_400;
const TRUNCATED_NOTE = "Showing 2,000 records";
/** Over this area the answer is every MRDS deposit (no USMIN symbols): the scale of a state. */
export const STATEWIDE_KM2 = 60_000;
/** Most MRDS deposits a statewide answer carries. */
export const STATEWIDE_LIMIT = 30_000;
/** One page of the MRDS service (its maxRecordCount). */
const PAGE = 2000;
/** Most points a view carries per record; also the wide limit. */
const MAX_RECORDS = 2000;
/**
 * Wide views keep named sites only. USMIN stores "no name" as a single space, so "sorts after a space" means named. Written
 * without IS NOT NULL ... AND, which the usgs.gov firewall blocked once in testing (2026-10-14).
 */
export const MRDS_NAMED = "site_name > ' '";
export const USMIN_NAMED = "ftr_name > ' '";

/**
 * MRDS commodity codes to plain names. Every code the US records use (tallied 2026-10-18: 189 codes, SDG sand and gravel
 * the third most common); a subtype the table does not name ("PGE_XX") reads as its base ("platinum-group metals"),
 * and only a code unknown at both levels stays as it is.
 */
export const COMMODITY_NAMES: Record<string, string> = {
  ABR: "abrasives",
  ABR_C: "corundum",
  ABR_E: "emery",
  ABR_G: "garnet",
  AG: "silver",
  AL: "aluminum",
  AND: "andalusite",
  AS: "arsenic",
  ASB: "asbestos",
  ASH: "volcanic ash",
  AU: "gold",
  B: "boron",
  BA: "barite",
  BE: "beryllium",
  BI: "bismuth",
  BR: "bromine",
  CA: "calcium",
  CD: "cadmium",
  CEM: "cement rock",
  CL: "chlorine",
  CLY: "clay",
  CLY_BC: "ball clay",
  CLY_BK: "brick clay",
  CLY_BN: "bentonite",
  CLY_C: "common clay",
  CLY_FE: "fuller's earth",
  CLY_FR: "fire clay",
  CLY_H: "halloysite",
  CLY_K: "kaolin",
  CO: "cobalt",
  CO2: "carbon dioxide",
  COA: "coal",
  COA_A: "anthracite",
  COA_B: "bituminous coal",
  COA_L: "lignite",
  COA_S: "subbituminous coal",
  CR: "chromium",
  CS: "cesium",
  CU: "copper",
  DIT: "diatomite",
  DOL: "dolomite",
  F: "fluorite",
  FE: "iron",
  FE_PYR: "pyrite",
  FLD: "feldspar",
  GA: "gallium",
  GAS: "natural gas",
  GE: "germanium",
  GEM: "gemstones",
  GEM_D: "diamond",
  GEO: "geothermal",
  GRF: "graphite",
  GRT: "granite",
  GYP: "gypsum",
  H2O: "water",
  HE: "helium",
  HF: "hafnium",
  HG: "mercury",
  I: "iodine",
  IN: "indium",
  K: "potash",
  KYN: "kyanite",
  LI: "lithium",
  LST: "limestone",
  LWA: "lightweight aggregate",
  MBL: "marble",
  MG: "magnesium",
  MIC: "mica",
  MN: "manganese",
  MO: "molybdenum",
  MPG: "mineral pigments",
  N: "nitrates",
  NA: "sodium",
  NA_H: "salt",
  NA_S: "sodium sulfate",
  NA_SC: "soda ash",
  NB: "niobium",
  NI: "nickel",
  OIL: "oil",
  OIL_SA: "oil sands",
  OIL_SH: "oil shale",
  OLV: "olivine",
  P: "phosphate",
  PB: "lead",
  PEA: "peat",
  PER: "perlite",
  PGE: "platinum-group metals",
  PGE_IR: "iridium",
  PGE_OS: "osmium",
  PGE_PD: "palladium",
  PGE_PT: "platinum",
  PGE_RH: "rhodium",
  PGE_RU: "ruthenium",
  PPY: "pyrophyllite",
  PUM: "pumice",
  PYR: "pyrite",
  QTZ: "quartz",
  RA: "radium",
  RB: "rubidium",
  RE: "rhenium",
  REE: "rare earths",
  S: "sulfur",
  SB: "antimony",
  SC: "scandium",
  SD: "sand",
  SDG: "sand and gravel",
  SDG_FRAC: "frac sand",
  SE: "selenium",
  SIL: "silica",
  SLA: "slate",
  SN: "tin",
  SR: "strontium",
  STA: "staurolite",
  STN: "stone",
  STN_C: "crushed stone",
  STN_D: "dimension stone",
  STN_F: "flagstone",
  TA: "tantalum",
  TE: "tellurium",
  TH: "thorium",
  TI: "titanium",
  TL: "thallium",
  TLC: "talc",
  TRA: "travertine",
  U: "uranium",
  V: "vanadium",
  VOL: "volcanic materials",
  VRM: "vermiculite",
  W: "tungsten",
  WOL: "wollastonite",
  ZEO: "zeolites",
  ZN: "zinc",
  ZR: "zirconium",
};

/** One MRDS code in plain words: "SDG" -> "sand and gravel", "STN_C_S" -> "crushed stone", unknown -> lower case. */
export function commodityName(code: string): string {
  const parts = code.toUpperCase().split("_");
  for (let n = parts.length; n > 0; n -= 1) {
    const name = COMMODITY_NAMES[parts.slice(0, n).join("_")];
    if (name !== undefined) return name;
  }
  return code.toLowerCase();
}

/**
 * A site name ending in MRDS commodity codes ("Lisbon Valley U,V", "Mi Vida U-V") with the codes spelled out ("Lisbon
 * Valley (uranium, vanadium)"); names whose last word is not a list of two or more known codes are left alone.
 */
export function spellCodesInName(name: string): string {
  const m = /^(.*\S)\s+([A-Za-z]{1,3}(?:\s*[,/-]\s*[A-Za-z]{1,3})+)$/.exec(name.trim());
  if (!m) return name;
  const codes = m[2].split(/\s*[,/-]\s*/).map((c) => c.toUpperCase());
  if (!codes.every((c) => COMMODITY_NAMES[c] !== undefined)) return name;
  return `${m[1]} (${codes.map((c) => COMMODITY_NAMES[c]).join(", ")})`;
}

/** MRDS development status in plain words for the card ("Past Producer" -> "Past producer", "Plant" -> "Processing plant"); the data keeps the MRDS value. */
export const STATUS_WORDS: Record<string, string> = {
  Producer: "Producer",
  "Past Producer": "Past producer",
  Prospect: "Prospect",
  Occurrence: "Occurrence",
  Plant: "Processing plant",
  Unknown: "Unknown",
};

/** Feature order for the map's labels: producers first, then past producers, then the rest; a named site before a generic one. */
const STATUS_RANK: Record<string, number> = { Producer: 0, "Past Producer": 1, Plant: 2, Prospect: 3, Occurrence: 4, Unknown: 5 };

/** Names the `commodity` input accepts, mapped to their MRDS code. */
export const COMMODITY_CODES = {
  gold: "AU",
  silver: "AG",
  copper: "CU",
  lead: "PB",
  zinc: "ZN",
  uranium: "U",
  vanadium: "V",
  iron: "FE",
  tungsten: "W",
  molybdenum: "MO",
  tin: "SN",
  antimony: "SB",
  mercury: "HG",
  manganese: "MN",
  nickel: "NI",
  cobalt: "CO",
  lithium: "LI",
  barite: "BA",
  fluorite: "F",
  coal: "COA",
  gypsum: "GYP",
  potash: "K",
  phosphate: "P",
  "rare earths": "REE",
} as const;
export type CommodityName = keyof typeof COMMODITY_CODES;

/** SQL for "this code is in the space-separated code_list", written without string concatenation so any ArcGIS back end takes it. */
export function commodityWhere(code: string): string {
  return `code_list LIKE '% ${code} %' OR code_list LIKE '% ${code}' OR code_list LIKE '${code} %' OR code_list = '${code}'`;
}

const EMPTY: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "N/A" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPoint(geometry: unknown): geometry is Point {
  return typeof geometry === "object" && geometry !== null && "type" in geometry && geometry.type === "Point";
}

/** Commodity names for a code list: " U V" -> ["uranium", "vanadium"], " SDG" -> ["sand and gravel"]; unknown codes stay as they are. */
export function commoditiesOf(codeList: string): string[] {
  return codeList
    .split(/\s+/)
    .filter((c) => c !== "")
    .map(commodityName);
}

/**
 * MRDS rows to points: `commodity` is the main commodity in plain words (also `kind`, which the duplicate check reads),
 * `status` the development status as last recorded (about 2011).
 */
export function normalizeMrds(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const commodities = commoditiesOf(str(p.code_list) ?? "");
    // MRDS writes a missing name as "Unknown" or "Unnamed ..." ("Unnamed Prospect"): the card says so in one way.
    const site = str(p.site_name);
    const unnamed = site === undefined || /^(unknown|unnamed\b.*)$/i.test(site);
    const properties: Record<string, string> = {
      name: unnamed ? "Unnamed site" : spellCodesInName(site),
      kind: commodities[0] ?? "unknown",
      source: "MRDS",
    };
    if (commodities.length > 0) {
      properties.commodity = commodities[0];
      properties.commodities = commodities.join(", ");
    }
    const status = str(p.dev_stat);
    if (status !== undefined) properties.status = status;
    const grade = str(p.grade);
    if (grade !== undefined) properties.grade = grade;
    const id = str(p.dep_id);
    if (id !== undefined) {
      properties.id = id;
      properties.url = `https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${encodeURIComponent(id)}`;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/** USMIN rows to points: `featureType` (also `kind`) is the map symbol's type (Mine, Adit, Quarry, ...); no status or commodity. */
export function normalizeUsmin(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const type = str(p.ftr_type) ?? "Mine feature";
    const properties: Record<string, string | number> = {
      name: str(p.ftr_name) ?? type,
      kind: type,
      featureType: type,
      source: "USMIN",
    };
    const topo = str(p.topo_name);
    if (topo !== undefined) properties.topoName = topo;
    const year = num(p.topo_date);
    if (year !== undefined && year > 0) properties.topoYear = year;
    const state = str(p.state);
    if (state !== undefined) properties.state = state;
    const county = str(p.county);
    if (county !== undefined) properties.county = county;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/**
 * A site name as duplicates compare it: read the way the map shows it ("Mt. Diablo Mine" is "Mount Diablo Mine", as MRDS lists
 * one site under both spellings 226 m apart), case, punctuation and spacing ignored.
 */
function nameKey(name: unknown): string {
  return typeof name === "string" ? displayName(name, "mines").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
}

/** Names that say what a working is, not which one: many separate tunnels and shafts carry them. */
export const GENERIC_MINE_NAMES = new Set(["tunnel", "adit", "shaft", "mine shaft", "prospect", "prospect pit", "mine", "quarry", "gravel pit", "borrow pit", "open pit mine"]);

/** One site listed twice is within this distance of itself. */
const SAME_SITE_KM = 1;
/** Two records of one name closer than this are one spot (the duplicates check's same-spot distance). */
const SAME_SPOT_KM = 0.015;

/**
 * One mine listed once: a USMIN symbol within 1 km of an MRDS site of the same name goes (MRDS carries the
 * commodities), and a record that lists one name twice within 1 km, as one kind, keeps the first. Unnamed USMIN symbols
 * (named by their type, "Adit") are left alone: many separate adits share that word.
 */
export function dedupeMines(features: Feature<Point>[]): Feature<Point>[] {
  const byName = new Map<string, Feature<Point>[]>();
  const out: Feature<Point>[] = [];
  // MRDS first, so a USMIN twin meets the MRDS site it repeats.
  const ordered = [...features].sort((a, b) => Number(a.properties?.source !== "MRDS") - Number(b.properties?.source !== "MRDS"));
  for (const f of ordered) {
    const p = f.properties ?? {};
    const key = nameKey(p.name);
    const generic = key === "" || key === "unnamed site" || GENERIC_MINE_NAMES.has(key) || (p.source === "USMIN" && key === nameKey(p.kind));
    if (generic) {
      out.push(f);
      continue;
    }
    const kept = byName.get(key) ?? [];
    const twin = kept.find((k) => {
      const km = haversineKm(k.geometry.coordinates, f.geometry.coordinates);
      if (km > SAME_SITE_KM) return false;
      // At one spot it is one site whatever each record calls its main commodity ("Prince Mine": lead in one, silver in the other).
      return km <= SAME_SPOT_KM || k.properties?.source !== p.source || k.properties?.kind === p.kind;
    });
    if (twin) continue;
    kept.push(f);
    byName.set(key, kept);
    out.push(f);
  }
  return out;
}

/**
 * The features in label order (the map names the first few, `labels`): producers, past producers, plants, prospects,
 * occurrences, unknown, then USMIN symbols; within each, named sites before generic ones ("Unnamed site", "Adit").
 * The sort is stable, so the source order holds inside each group.
 */
export function orderForLabels(features: Feature<Point>[]): Feature<Point>[] {
  const rank = (f: Feature<Point>) => {
    const p = f.properties ?? {};
    const status = STATUS_RANK[String(p.status)] ?? 6;
    const key = nameKey(p.name);
    const generic = key === "" || key === "unnamed site" || GENERIC_MINE_NAMES.has(key) || key === nameKey(p.kind);
    return status * 2 + (generic ? 1 : 0);
  };
  return features.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
}

/** Every MRDS deposit in a statewide box, paged in object-id order up to STATEWIDE_LIMIT: the records and how many match. */
async function mrdsStatewide(ctx: QueryContext, where: string | undefined, suffix: string): Promise<{ result: ArcgisResult; count: number | null }> {
  const count = await arcgisCount(ctx, MRDS_URL, { where, bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: suffix });
  const pages = Math.max(1, Math.ceil(Math.min(count ?? PAGE, STATEWIDE_LIMIT) / PAGE));
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      arcgisQuery(ctx, MRDS_URL, {
        outFields: ["dep_id", "site_name", "dev_stat", "code_list"],
        where,
        bbox: ctx.bbox,
        orderByFields: "objectid_1",
        resultOffset: i * PAGE,
        resultRecordCount: PAGE,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: `${suffix}:statewide:${i}`,
      }),
    ),
  );
  const failed = results.find((r) => !r.ok);
  if (failed) return { result: failed, count };
  const features = results.flatMap((r) => (r.ok ? r.fc.features : []));
  return { result: { ok: true, fc: { type: "FeatureCollection", features }, truncated: count !== null && count > features.length }, count };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The common main commodities as chips, most common first (others still get a chip of their own from the data). */
const COMMODITY_CHIPS = [
  "gold", "sand and gravel", "copper", "iron", "crushed stone", "lead", "uranium", "silver", "manganese", "clay", "tungsten", "chromium",
  "stone", "zinc", "mica", "barite", "limestone", "mercury", "aluminum", "fluorite", "phosphate", "vanadium", "molybdenum", "coal", "gypsum",
  "lithium", "potash", "rare earths",
];

/**
 * Status chips colored on the sage → pink → purple ramp in this order (a prospect is sage, a producer purple). Processing
 * plants, unknown status and USMIN symbols (which have none) draw off-white and keep chips of their own.
 */
const STATUS_LEVELS = [
  { value: "Prospect", label: "Prospect or occurrence", help: "Explored or reported, never recorded as producing." },
  { value: "Occurrence", label: "Prospect or occurrence", help: "Explored or reported, never recorded as producing." },
  { value: "Past Producer", label: "Past producer", help: "Produced before the record was last updated, closed by then." },
  { value: "Producer", label: "Producer", help: "Producing when the record was last updated, about 2011; it may be closed now." },
];

const ATTRIBUTES: Attribute[] = [
  {
    key: "status",
    type: "category",
    label: "Status (about 2011)",
    levels: STATUS_LEVELS,
    encode: "color",
    primary: true,
  },
  {
    key: "commodity",
    type: "category",
    label: "Commodity",
    levels: COMMODITY_CHIPS.map((value) => ({ value, label: capital(value) })),
  },
  { key: "featureType", type: "category", label: "Feature type" },
  {
    key: "source",
    type: "category",
    label: "Record",
    levels: [
      { value: "MRDS", label: "Deposit records (MRDS, about 2011)" },
      { value: "USMIN", label: "Old topographic map symbols (USMIN)" },
    ],
  },
  nameAttribute(),
];

const MRDS_URL_PAGE = "https://mrdata.usgs.gov/mrds/";

/** Card wording for the record each point comes from: its vintage, on every card. */
const RECORD_WORDS: Record<string, string> = {
  MRDS: "USGS Mineral Resources Data System, a historic record last updated about 2011",
  USMIN: "USGS mine symbol digitized from an old topographic map (see the map year)",
};

const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Status when last recorded (about 2011)",
  field: "status",
  items: [
    { label: "Producer", value: "Producer", help: STATUS_LEVELS[3].help },
    { label: "Past producer", value: "Past Producer", help: STATUS_LEVELS[2].help },
    { label: "Prospect or occurrence", value: "Prospect", help: STATUS_LEVELS[0].help },
    { label: "Plant, unknown, or a map symbol with no status", color: OFF_WHITE, help: "Processing plants, unknown status and USMIN mine symbols from old topographic maps." },
  ],
  note: "The deposit records (USGS MRDS) stopped updating about 2011 and the mine symbols come from USGS topographic maps of 1886 to 2006 (most around 1970), so a producer then may be closed now and new mines are missing.",
};

const HELP: Record<string, FieldHelp> = {
  kind: {
    text:
      "For MRDS sites the main commodity (the first one listed for the deposit); for USMIN symbols the feature type drawn on the old topographic " +
      "map.",
  },
  commodity: {
    text: "The deposit's main commodity, the first one its MRDS record lists, with the USGS code spelled out (SDG is sand and gravel).",
    source: "USGS Mineral Resources Data System",
    url: MRDS_URL_PAGE,
  },
  featureType: { text: "What the USGS mine symbol on the old topographic map shows: a mine, adit (tunnel), shaft, prospect pit, quarry, gravel pit and so on." },
  status: {
    text:
      "The development status recorded in the USGS Mineral Resources Data System when the record was last updated (systematic updates stopped in " +
      "2011), so it does not say whether a mine operates today.",
    scale: "Occurrence, Prospect, Past Producer, Producer, Plant (a processing plant), Unknown",
    source: "USGS Mineral Resources Data System",
    url: MRDS_URL_PAGE,
  },
  commodities: { text: "Every commodity the MRDS record lists, main one first." },
  grade: {
    text: "The letter code in the MRDS grade field, as the record gives it.",
    source: "USGS Mineral Resources Data System",
    url: MRDS_URL_PAGE,
  },
  topoName: { text: "The USGS topographic map the mine symbol was digitised from." },
  topoYear: { text: "The date of that topographic map: the symbol shows what was there then." },
  source: {
    text:
      "MRDS: the USGS Mineral Resources Data System, deposit records whose systematic updates stopped about 2011; USMIN: USGS mine symbols " +
      "digitized from topographic maps, each as old as its map.",
  },
};

const CARD: CardSpec = {
  facts: [
    { key: "status", label: "Status when last recorded", values: STATUS_WORDS },
    { key: "commodities", label: "Commodities", format: "list" },
    { key: "featureType", label: "Feature type" },
    { key: "topoName", label: "Topographic map" },
    { key: "topoYear", label: "Map year" },
    { key: "county", label: "County" },
    { key: "source", label: "Record", values: RECORD_WORDS },
  ],
  links: [{ key: "url", label: "MRDS record" }],
  // The deposit id is in the MRDS record link; kind repeats the commodity or the feature type; the main commodity leads the list.
  hidden: ["id", "kind", "commodity"],
};

const mines = defineLayer({
  id: "mines",
  title: "Mines and mineral deposits",
  description:
    "Mines, prospects, quarries and mineral deposits in the US from two USGS records, both old: MRDS (deposit records whose updates stopped about 2011) and USMIN (mine, shaft and tunnel symbols digitized from USGS topographic maps of 1886 to 2006, most around 1970). " +
    "Each point has name, source (MRDS or USMIN) and kind (MRDS: main commodity; USMIN: feature type). MRDS points add commodity (the main one in plain words, such as gold, uranium or sand and gravel), commodities (all of them), status (Producer, Past Producer, Prospect, Occurrence, Plant (a processing plant) or Unknown, as last recorded about 2011) and url; USMIN points add featureType (Mine, Adit, Prospect Pit, Quarry...), topoName and topoYear. " +
    "The map colors points by status: producer purple, past producer pink, prospect or occurrence sage, the rest off-white. A producer in 2011 may be closed now, new mines are missing, and a point does not mean a mine is open or safe. " +
    "commodity filters MRDS; source picks one record. At most 2,000 per record; over 15,000 km², 2,000 named sites and the total; over 60,000 km² (a state, to 1,200,000 km²), every MRDS deposit up to 30,000 and no USMIN symbols, for where most mines are.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS MRDS and USMIN)",
  requiredEnv: [],
  maxAreaKm2: 15_000,
  hardMaxAreaKm2: 1_200_000,
  wide: { mode: "named", limit: MAX_RECORDS },
  input: z.object({
    commodity: z
      .enum(Object.keys(COMMODITY_CODES) as [CommodityName, ...CommodityName[]])
      .optional()
      .describe("Only MRDS sites that list this commodity, for example 'gold' or 'uranium'."),
    source: z
      .enum(["both", "mrds", "usmin"])
      .default("both")
      .describe("Which record: 'mrds' (deposits with commodities), 'usmin' (mine symbols from topographic maps) or 'both' (default)."),
  }),
  style: { geometry: "point", color: layerColor("mines"), cluster: true, encode: { color: "status" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Old records: the question is where and what, not when (the vintage is on every card and in the legend).
  time: { shape: "none" },
  legend: LEGEND,
  // No measure to rank by: the features come producers first, named sites before generic ones (orderForLabels).
  labels: { field: "name", max: 5, minZoom: 10 },
  display: { units: "us" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS Mineral Resources Data System (MRDS, historic, about 2011) and USMIN mine and prospect features",
      url: "https://mrdata.usgs.gov/mrds/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const notes: string[] = [];
    // USMIN symbols have no commodity, so asking for one means MRDS only.
    const source = input.commodity !== undefined ? "mrds" : input.source;
    if (input.commodity !== undefined && input.source === "usmin") {
      notes.push("USMIN symbols carry no commodity, so the commodity filter shows MRDS sites only");
    }

    // Statewide (over 60,000 km²): every MRDS deposit, USMIN only counted.
    if (ctx.wide === true && bboxAreaKm2(ctx.bbox) > STATEWIDE_KM2 && source !== "usmin") {
      const commodityClause = input.commodity === undefined ? undefined : commodityWhere(COMMODITY_CODES[input.commodity]);
      const [{ result, count }, usminCount] = await Promise.all([
        mrdsStatewide(ctx, commodityClause, `mines:mrds:${input.commodity ?? "all"}`),
        source === "both" ? arcgisCount(ctx, USMIN_URL, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "mines:usmin" }) : Promise.resolve(null),
      ]);
      if (!result.ok) return { error: `Mine records unavailable: MRDS (${result.error})`, hint: "upstream" };
      const records = normalizeMrds(result.fc);
      // Lighter points for tens of thousands of sites: coordinates to about 10 m, and no record link (the id stays).
      const features = orderForLabels(dedupeMines(records)).map((f) => {
        const properties = { ...f.properties };
        delete properties.url;
        const [lon, lat] = f.geometry.coordinates;
        return { ...f, geometry: { type: "Point" as const, coordinates: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4] }, properties };
      });
      const fmt = (n: number) => n.toLocaleString("en-US");
      const merged = records.length - features.length;
      const stateNotes = [
        `At this scale every MRDS deposit is drawn${result.truncated && count !== null ? `, the first ${fmt(records.length)} of ${fmt(count)}` : ""}` +
          (merged > 0 ? ` (${fmt(merged)} records repeating one site within 1 km merged)` : ""),
        ...(usminCount !== null && usminCount > 0 ? [`USMIN's ${fmt(usminCount)} mine symbols from old topographic maps are left out; zoom in under 60,000 km² to add them`] : []),
        ...notes,
        "MRDS is a historic record (about 2011): most sites are closed or only prospects",
      ];
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features },
        citation,
        // Every deposit the box holds is drawn (repeats merged), so the total is what is shown, unless the limit cut it.
        total: result.truncated && count !== null ? count - merged : features.length,
        coverageNote: stateNotes.join("; "),
      };
    }

    // Wide (over 15,000 km²): named sites only, the limit shared between the records asked, and a count of every site in
    // the box (named or not) for the note.
    const wide = ctx.wide === true && ctx.wideStrategy !== undefined;
    const perRecord = wide ? Math.floor((ctx.wideStrategy?.limit ?? MAX_RECORDS) / (source === "both" ? 2 : 1)) : MAX_RECORDS;
    const commodity = input.commodity === undefined ? undefined : commodityWhere(COMMODITY_CODES[input.commodity]);
    const mrdsWhere = !wide ? commodity : commodity === undefined ? MRDS_NAMED : `(${commodity}) AND ${MRDS_NAMED}`;
    const mrdsSuffix = `mines:mrds:${input.commodity ?? "all"}`;

    const [mrds, usmin, mrdsCount, usminCount] = await Promise.all([
      source !== "usmin"
        ? arcgisQuery(ctx, MRDS_URL, {
            outFields: ["dep_id", "site_name", "dev_stat", "code_list", "grade"],
            where: mrdsWhere,
            bbox: ctx.bbox,
            resultRecordCount: perRecord,
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: mrdsSuffix,
          })
        : null,
      source !== "mrds"
        ? arcgisQuery(ctx, USMIN_URL, {
            outFields: ["ftr_type", "ftr_name", "topo_name", "topo_date", "state", "county"],
            where: wide ? USMIN_NAMED : undefined,
            bbox: ctx.bbox,
            resultRecordCount: perRecord,
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: "mines:usmin",
          })
        : null,
      wide && source !== "usmin"
        ? arcgisCount(ctx, MRDS_URL, { where: commodity, bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: mrdsSuffix })
        : 0,
      wide && source !== "mrds" ? arcgisCount(ctx, USMIN_URL, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "mines:usmin" }) : 0,
    ]);

    const features: Feature<Point>[] = [];
    const failed: string[] = [];
    const take = (res: ArcgisResult | null, label: string, normalize: (fc: FeatureCollection) => Feature<Point>[]) => {
      if (res === null) return;
      if (!res.ok) {
        failed.push(`${label} (${res.error})`);
        return;
      }
      features.push(...normalize(res.fc));
      if (res.truncated && !wide) notes.push(`${TRUNCATED_NOTE} from ${label}; zoom in for the rest`);
    };
    take(mrds, "MRDS", normalizeMrds);
    take(usmin, "USMIN", normalizeUsmin);

    const asked = (mrds === null ? 0 : 1) + (usmin === null ? 0 : 1);
    if (failed.length === asked) return { error: `Mine records unavailable: ${failed.join("; ")}`, hint: "upstream" };
    if (failed.length > 0) notes.push(`Missing ${failed.join(" and ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push(input.commodity !== undefined ? `No MRDS sites listing ${input.commodity} in this area` : "No mines or prospects recorded in this area");
    } else if (mrds !== null && mrds.ok) {
      notes.push("MRDS is a historic record (about 2011): most sites are closed or only prospects");
    }

    // The total counts every site in the box, so it is only given when every record asked answered and counted.
    const total = wide && failed.length === 0 && mrdsCount !== null && usminCount !== null ? mrdsCount + usminCount : undefined;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features: orderForLabels(dedupeMines(features)) },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(mines);

export default mines;

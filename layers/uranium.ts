/**
 * Uranium legacy sites in the US Southwest: abandoned uranium mines on the Navajo Nation and Department of Energy Legacy Management
 * uranium mill-tailings sites. Two keyless ArcGIS FeatureServers (verified live 2026-10-10, f=geojson works):
 *   Navajo Nation abandoned uranium mines, 602 points, with 2007 hazard scores (published by the New Mexico Community Data Collaborative,
 *     NMCDC, from the Navajo Nation EPA / US EPA screening):
 *     https://services.arcgis.com/LGtNQDlIZBdntoA9/arcgis/rest/services/Navajo_Nation_Abandoned_Uranium_Mine_Point_Scores/FeatureServer/0
 *     Fields: Mine_Name, Aliases, Mine_ID, Chapter (Navajo chapter house area), Region, Map_ID, and the scores GrndWtrScr, Soil_Scr, Air_Scr,
 *     SurfWtrScr and Comp_Scr (composite: 10 to 17,640, mean 665). No licence is stated on the item.
 *   DOE Office of Legacy Management sites (681 points; the layer keeps the uranium mill-tailings ones):
 *     https://services7.arcgis.com/Oak1TVjJMSpGVWPC/arcgis/rest/services/DoeLmSitePoint/FeatureServer/0
 *     where siteRegulatoryDriver IN ('UMTRCA Title I', 'UMTRCA Title II', 'ULP') gives 64 sites (Title I: abandoned mill sites cleaned up by DOE;
 *     Title II: licensed mill sites handed to DOE for long-term care after cleanup; ULP: Uranium Leasing Program). Fields: featureName,
 *     siteStateCode, siteRegulatoryDriver, siteWebPageURL, siteFactSheetURL, siteTransferYear (a string, some in the future), subSiteId.
 *   US EPA Region 9 Navajo Nation abandoned uranium mine cleanup status (keyless MapServer, verified live 2026-10-18; 609 mine
 *     polygons in layer 50 "All Mines", geojson works, about 3 s):
 *     https://gispub.epa.gov/arcgis/rest/services/Region9/NavajoNationAUMSiteScreening/MapServer/50
 *     Fields used: Mine_ID (the same mine id as the NMCDC points), SFD_Status (the furthest Superfund removal step done: preliminary site
 *     screen, removal site evaluation, removal site assessment or design for cleanup, "and Priority Mine" for EPA's priority mines),
 *     MineStatusAlt (who pays: Tronox Settlement, Phase 1 Trust, Phase 2 Trust, Enforcement Action or Other), EnfEntity (the responsible
 *     party), SiteScreenReport and RemovalSiteEvalReport (report links). Joined to the 2007 scores by Mine_ID, so the card says how far
 *     cleanup has come next to the old score; if the EPA service fails the scores still draw and the note says so.
 * Output: Navajo points: kind "abandoned mine", v and hazardScore = composite hazard score (2007), name, aliases, mineId, chapter,
 *   region, the four component scores, and from EPA cleanupStage, cleanupFunding, responsibleParty, priorityMine, screeningReport,
 *   evaluationReport.
 *   DOE points: kind "mill tailings site" (Title I or II) or "leasing program", name, state, program, siteId, url, factSheet, transferYear.
 * Smoke check 2026-10-10 (live, through runLayer): the lower 48 box returned 666 points (602 Navajo mines, 64 DOE sites) in 0.3 s; a Four Corners
 *   box -112,35,-106,38 returned 616 (Tract 15, Oljato chapter, composite score 170, first).
 * Wide (over 20,000,000 km², up to 80,000,000): named sites only, 1,000 per dataset, plus a count of every site. Smoke 2026-10-14, box
 *   -170,15,-60,72 (North America): all 666 named of 666 in 1.9 s.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp, type LegendSpec } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const NAVAJO_URL =
  "https://services.arcgis.com/LGtNQDlIZBdntoA9/arcgis/rest/services/Navajo_Nation_Abandoned_Uranium_Mine_Point_Scores/FeatureServer/0";
export const DOE_URL = "https://services7.arcgis.com/Oak1TVjJMSpGVWPC/arcgis/rest/services/DoeLmSitePoint/FeatureServer/0";
export const EPA_AUM_URL = "https://gispub.epa.gov/arcgis/rest/services/Region9/NavajoNationAUMSiteScreening/MapServer/50";
const EPA_FIELDS = ["Mine_ID", "SFD_Status", "MineStatusAlt", "EnfEntity", "PriorityMine", "SiteScreenReport", "RemovalSiteEvalReport"];
/** Where the Navajo Nation mines and EPA's list lie (both extents, 2026-10-18, padded): the EPA list is asked only here. */
export const NAVAJO_EXTENT: BBox = [-111.8, 35.0, -107.0, 37.5];
/** The EPA mines are a few acres each: their outlines, coarsened, keep the request small (only the attributes are used). */
const EPA_OFFSET = 0.01;
export const DOE_WHERE = "siteRegulatoryDriver IN ('UMTRCA Title I', 'UMTRCA Title II', 'ULP')";
/** Both datasets are static (one is a 2007 study). */
const TTL_SECONDS = 7 * 86_400;
/** EPA's cleanup list changes as work goes on: a day. */
const CLEANUP_TTL_SECONDS = 86_400;
/** Most sites per dataset in a view; also the wide limit. */
const MAX_RECORDS = 2000;
/** Wide views keep named sites only ("sorts after a space" also skips blank names). Every site had a name on 2026-10-14. */
export const NAVAJO_NAMED = "Mine_Name > ' '";
export const DOE_NAMED = `(${DOE_WHERE}) AND featureName > ' '`;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPoint(geometry: unknown): geometry is Point {
  return typeof geometry === "object" && geometry !== null && "type" in geometry && geometry.type === "Point";
}

/** Navajo Nation abandoned mines as points; v is the composite hazard score. */
export function normalizeNavajo(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = {
      name: str(p.Mine_Name) ?? "Unnamed mine",
      kind: "abandoned mine",
      source: "Navajo Nation abandoned uranium mines (2007)",
    };
    const aliases = str(p.Aliases);
    if (aliases !== undefined) properties.aliases = aliases;
    const mineId = num(p.Mine_ID);
    if (mineId !== undefined) properties.mineId = mineId;
    const chapter = str(p.Chapter);
    if (chapter !== undefined) properties.chapter = chapter;
    const region = str(p.Region);
    if (region !== undefined) properties.region = region;
    const composite = num(p.Comp_Scr);
    if (composite !== undefined) {
      properties.hazardScore = composite;
      properties.v = composite;
    }
    const scores: [string, unknown][] = [
      ["groundwaterScore", p.GrndWtrScr],
      ["soilScore", p.Soil_Scr],
      ["airScore", p.Air_Scr],
      ["surfaceWaterScore", p.SurfWtrScr],
    ];
    for (const [key, value] of scores) {
      const score = num(value);
      if (score !== undefined) properties[key] = score;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return tellApart(out);
}

/** The letter an alias gives one portal of a mine: "Taylor Reid Mine - A", "Mitten #1 'B'". */
function siteLetter(aliases: unknown): string | undefined {
  if (typeof aliases !== "string") return undefined;
  for (const alias of aliases.split(";")) {
    const m = /(?:-\s*|['"])([A-Z])['"]?\s*$/.exec(alias.trim());
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Mines that share a name (two portals of Taylor Reid No. 1, 200 m apart) are told apart by the letter their aliases
 * give them ("Taylor Reid No. 1 (A)"), else by their mine id, so the map, the card and the top 10 never show one name
 * twice for two places.
 */
export function tellApart(features: Feature<Point>[]): Feature<Point>[] {
  const count = new Map<string, number>();
  for (const f of features) count.set(String(f.properties?.name), (count.get(String(f.properties?.name)) ?? 0) + 1);
  return features.map((f) => {
    const p = f.properties ?? {};
    if ((count.get(String(p.name)) ?? 0) < 2) return f;
    const tag = siteLetter(p.aliases) ?? (p.mineId !== undefined ? `mine ${p.mineId}` : undefined);
    return tag ? { ...f, properties: { ...p, name: `${p.name} (${tag})` } } : f;
  });
}

/** EPA's furthest cleanup step, in plain words, in the order the steps come (the Superfund removal process). */
export const CLEANUP_STAGES = ["Screened", "Evaluated", "Assessed", "Cleanup designed"] as const;

const STAGE_OF: [RegExp, (typeof CLEANUP_STAGES)[number]][] = [
  [/design for cleanup/i, "Cleanup designed"],
  [/removal site assessment/i, "Assessed"],
  [/removal site evaluation/i, "Evaluated"],
  [/site screen/i, "Screened"],
];

/** Who pays for a mine's cleanup (EPA MineStatusAlt), in plain words. */
export const FUNDING_WORDS: Record<string, string> = {
  "Tronox Settlement": "Tronox bankruptcy settlement",
  "Phase 1 Trust": "Environmental response trust (phase 1)",
  "Phase 2 Trust": "Environmental response trust (phase 2)",
  "Enforcement Action": "A responsible company, under EPA enforcement",
  Other: "No settlement or enforcement yet",
};

type Cleanup = Record<string, string | boolean>;

/** EPA cleanup status per mine id, from the EPA Region 9 mine polygons: plain words and report links. */
export function cleanupByMine(fc: FeatureCollection): Map<number, Cleanup> {
  const out = new Map<number, Cleanup>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const id = num(p.Mine_ID);
    if (id === undefined || out.has(id)) continue;
    const status: Cleanup = {};
    const step = str(p.SFD_Status)?.replace(/\s+/g, " ");
    const stage = step === undefined ? undefined : STAGE_OF.find(([re]) => re.test(step))?.[1];
    if (stage !== undefined) status.cleanupStage = stage;
    status.priorityMine = str(p.PriorityMine) === "Priority" || /priority mine/i.test(step ?? "");
    const funding = str(p.MineStatusAlt);
    if (funding !== undefined) status.cleanupFunding = FUNDING_WORDS[funding] ?? funding;
    const party = str(p.EnfEntity);
    // The trusts are named by the funding row already; a company is named here.
    if (party !== undefined && !/trust/i.test(party)) status.responsibleParty = party;
    const screening = str(p.SiteScreenReport);
    if (screening !== undefined && /^https?:\/\//.test(screening)) status.screeningReport = screening;
    const evaluation = str(p.RemovalSiteEvalReport);
    if (evaluation !== undefined && /^https?:\/\//.test(evaluation)) status.evaluationReport = evaluation;
    out.set(id, status);
  }
  return out;
}

/** The Navajo points with EPA's cleanup status joined by mine id; mines EPA does not list are left as they are. */
export function joinCleanup(features: Feature<Point>[], cleanup: Map<number, Cleanup>): Feature<Point>[] {
  return features.map((f) => {
    const id = f.properties?.mineId;
    const status = typeof id === "number" ? cleanup.get(id) : undefined;
    return status ? { ...f, properties: { ...f.properties, ...status } } : f;
  });
}

/** DOE Legacy Management uranium sites as points; a transfer year in the future is reported as expectedTransferYear. */
export function normalizeDoe(fc: FeatureCollection, thisYear: number): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const program = str(p.siteRegulatoryDriver);
    const properties: Record<string, string | number> = {
      name: str(p.featureName) ?? "Unnamed site",
      kind: program === "ULP" ? "leasing program" : "mill tailings site",
      source: "DOE Office of Legacy Management",
    };
    if (program !== undefined) properties.program = program;
    const state = str(p.siteStateCode);
    if (state !== undefined) properties.state = state;
    const siteId = str(p.subSiteId);
    if (siteId !== undefined) properties.siteId = siteId;
    const url = str(p.siteWebPageURL);
    if (url !== undefined) properties.url = url;
    const factSheet = str(p.siteFactSheetURL);
    if (factSheet !== undefined) properties.factSheet = factSheet;
    const year = Number(str(p.siteTransferYear));
    if (Number.isInteger(year) && year >= 1900) properties[year <= thisYear ? "transferYear" : "expectedTransferYear"] = year;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

const KIND_LABELS: Record<string, string> = {
  "abandoned mine": "Abandoned mine",
  "mill tailings site": "Mill tailings site",
  "leasing program": "Leasing program",
};

const ATTRIBUTES: Attribute[] = [
  { key: "kind", type: "category", label: "Kind", levels: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
  {
    key: "hazardScore",
    type: "measure",
    label: "Hazard score (2007)",
    unit: "score",
    encode: "size",
    presets: [
      { label: "Under 100", max: 100 },
      { label: "100 to 1,000", min: 100, max: 1_000 },
      { label: "1,000 and up", min: 1_000 },
    ],
  },
  {
    key: "cleanupStage",
    type: "ordinal",
    label: "EPA cleanup step",
    scale: "EPA Superfund removal steps: site screening, removal site evaluation, removal site assessment, design for cleanup",
    levels: CLEANUP_STAGES.map((value) => ({ value, label: value })),
  },
  {
    key: "cleanupFunding",
    type: "category",
    label: "Cleanup paid by",
    levels: Object.values(FUNDING_WORDS).map((value) => ({ value, label: value })),
  },
  { key: "priorityMine", type: "flag", label: "EPA priority mine" },
  nameAttribute(),
];

/** The size key: 2007 scores, each step ten times the last. */
const LEGEND: LegendSpec = {
  kind: "size",
  title: "Hazard score (2007 screening)",
  field: "hazardScore",
  unit: "score",
  stops: [
    { label: "10", value: 10 },
    { label: "100", value: 100 },
    { label: "1,000", value: 1_000 },
    { label: "10,000", value: 10_000 },
  ],
  note:
    "Navajo Nation mines are sized by a 2007 screening score, not today's conditions; the card adds how far EPA cleanup has come. " +
    "DOE mill-tailings sites have no score and draw smallest.",
};

const EPA = {
  source: "Navajo Nation EPA and US EPA, Navajo abandoned uranium mine screening assessment (2007)",
  url: "https://www.epa.gov/navajo-nation-uranium-cleanup",
};

const CLEANUP_SOURCE = {
  source: "US EPA Region 9, Navajo Nation abandoned uranium mines map service",
  url: "https://www.epa.gov/navajo-nation-uranium-cleanup",
};

const HAZARD: FieldHelp = {
  text:
    "The composite screening score from the 2007 Navajo Nation EPA and US EPA assessment of abandoned uranium mines, built from the groundwater, " +
    "soil, air and surface-water pathway scores: a screening estimate of potential hazard, not a measured exposure, and later cleanup is not " +
    "reflected.",
  scale: "10 to about 17,600; higher is a higher estimated hazard",
  ...EPA,
};

const pathway = (what: string): FieldHelp => ({
  text: `The 2007 screening score for the ${what} pathway, one of the four parts of the composite hazard score; an estimate, not a measurement.`,
  ...EPA,
});

const HELP: Record<string, FieldHelp> = {
  hazardScore: HAZARD,
  v: HAZARD,
  groundwaterScore: pathway("groundwater"),
  soilScore: pathway("soil"),
  airScore: pathway("air"),
  surfaceWaterScore: pathway("surface-water"),
  chapter: { text: "The Navajo Nation chapter (local government area) the mine is in." },
  program: {
    text:
      "The DOE program: UMTRCA Title I (abandoned mill sites cleaned up by DOE), Title II (licensed mill sites handed to DOE for long-term care " +
      "after cleanup) or ULP (the Uranium Leasing Program).",
    source: "US Department of Energy, Office of Legacy Management",
    url: "https://www.energy.gov/lm/office-legacy-management",
  },
  transferYear: { text: "The year the site was transferred to DOE Legacy Management for long-term care." },
  expectedTransferYear: { text: "The year the site is expected to be transferred to DOE Legacy Management." },
  cleanupStage: {
    text:
      "The furthest step of EPA's Superfund removal process done at the mine: a site screening (a first look), a removal site evaluation, " +
      "a removal site assessment, or a design for cleanup. It does not mean the mine has been cleaned up.",
    scale: "Screened, Evaluated, Assessed, Cleanup designed",
    ...CLEANUP_SOURCE,
  },
  cleanupFunding: {
    text:
      "Who pays for the mine's cleanup: the Tronox bankruptcy settlement, the environmental response trust funded by settlements, a " +
      "responsible company under EPA enforcement, or no settlement or enforcement yet.",
    ...CLEANUP_SOURCE,
  },
  responsibleParty: { text: "The company EPA holds responsible for cleaning up the mine.", ...CLEANUP_SOURCE },
  priorityMine: { text: "One of the mines EPA ranked first for cleanup, by their radiation levels and nearness to homes.", ...CLEANUP_SOURCE },
  source: { text: "Which record the site comes from: the 2007 Navajo Nation screening scores, or DOE's list of uranium mill sites." },
};

/** Card wording for each record, with its vintage. */
const SOURCE_WORDS: Record<string, string> = {
  "Navajo Nation abandoned uranium mines (2007)": "2007 Navajo Nation EPA and US EPA screening; the score is not today's condition",
  "DOE Office of Legacy Management": "US Department of Energy, Office of Legacy Management",
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Hazard score (2007 screening)" },
  facts: [
    { key: "kind", label: "Kind", values: KIND_LABELS },
    { key: "cleanupStage", label: "EPA cleanup step reached" },
    { key: "priorityMine", label: "EPA priority mine", values: { true: "Yes", false: "No" } },
    { key: "cleanupFunding", label: "Cleanup paid by" },
    { key: "responsibleParty", label: "Responsible party" },
    { key: "source", label: "Record", values: SOURCE_WORDS },
    {
      key: "pathwayScores",
      label: "Pathway scores",
      parts: [
        { key: "groundwaterScore", label: "groundwater" },
        { key: "soilScore", label: "soil" },
        { key: "airScore", label: "air" },
        { key: "surfaceWaterScore", label: "surface water" },
      ],
    },
    { key: "chapter", label: "Chapter" },
    { key: "aliases", label: "Also called" },
    { key: "program", label: "Program" },
    { key: "transferYear", label: "Transferred" },
  ],
  links: [
    { key: "url", label: "DOE site page" },
    { key: "factSheet", label: "Fact sheet" },
    { key: "screeningReport", label: "EPA site screening report" },
    { key: "evaluationReport", label: "EPA removal site evaluation" },
  ],
};

const uranium = defineLayer({
  id: "uranium",
  title: "Uranium legacy sites",
  description:
    "Legacy uranium sites in the western US: 602 abandoned mines on the Navajo Nation and about 60 Department of Energy mill-tailings sites. Each point has name, kind ('abandoned mine', 'mill tailings site' or 'leasing program') and source. " +
    "Navajo mines have v and hazardScore, a 2007 screening score (10 to about 17,600; higher is a higher estimated hazard, not a measured exposure, and not today's condition), chapter and region; symbols are sized by it and the five highest are named on the map. " +
    "From EPA Region 9's current cleanup list they add cleanupStage (the furthest EPA step done: Screened, Evaluated, Assessed or Cleanup designed; not the same as cleaned up), priorityMine (true for EPA's priority mines), cleanupFunding (Tronox bankruptcy settlement, environmental response trust, a responsible company under enforcement, or no settlement or enforcement yet) and responsibleParty. " +
    "DOE sites have program (Title I or II), state, url and transferYear. Not every uranium mine: for historic mines elsewhere use mines with commodity uranium. Old workings and tailings can be dangerous. The lower 48 fits; over 20,000,000 km², named sites and the total.",
  coverage: "us",
  surface: "land",
  license:
    "Navajo mines: published by the New Mexico Community Data Collaborative from Navajo Nation EPA and US EPA screening (no licence stated); DOE sites: US Department of Energy (public domain)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  wide: { mode: "named", limit: MAX_RECORDS },
  input: z.object({}),
  style: { geometry: "point", color: layerColor("uranium"), unit: "score", encode: { size: "hazardScore" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // One screening, in 2007: the date is said, no scrubber (EPA's cleanup steps are on the card).
  time: { shape: "single", dates: ["2007"] },
  legend: LEGEND,
  labels: { field: "name", max: 5, rankBy: "hazardScore" },
  display: { units: "us" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Navajo Nation abandoned uranium mines hazard scores (NMCDC, 2007) and US DOE Office of Legacy Management sites",
      url: "https://www.energy.gov/lm/uranium-mill-tailings-radiation-control-act-title-i-and-title-ii-sites",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 20,000,000 km²): named sites only, the limit shared between the two datasets, and a count of every site.
    const wide = ctx.wide === true && ctx.wideStrategy !== undefined;
    const perDataset = wide ? Math.floor((ctx.wideStrategy?.limit ?? MAX_RECORDS) / 2) : MAX_RECORDS;
    // EPA's cleanup status for the Navajo mines in the box (609 in all, so one page), joined by mine id, asked only near the
    // Navajo Nation; a failure keeps the scores and says so.
    const [navajo, doe, navajoCount, doeCount, epa] = await Promise.all([
      arcgisQuery(ctx, NAVAJO_URL, {
        outFields: ["Mine_Name", "Aliases", "Mine_ID", "Chapter", "Region", "GrndWtrScr", "Soil_Scr", "Air_Scr", "SurfWtrScr", "Comp_Scr"],
        where: wide ? NAVAJO_NAMED : undefined,
        bbox: ctx.bbox,
        resultRecordCount: perDataset,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "uranium:navajo",
      }),
      arcgisQuery(ctx, DOE_URL, {
        outFields: ["featureName", "siteStateCode", "siteRegulatoryDriver", "siteWebPageURL", "siteFactSheetURL", "siteTransferYear", "subSiteId"],
        where: wide ? DOE_NAMED : DOE_WHERE,
        bbox: ctx.bbox,
        resultRecordCount: perDataset,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "uranium:doe",
      }),
      wide ? arcgisCount(ctx, NAVAJO_URL, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "uranium:navajo" }) : null,
      wide ? arcgisCount(ctx, DOE_URL, { where: DOE_WHERE, bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: "uranium:doe" }) : null,
      bboxesDisjoint(ctx.bbox, NAVAJO_EXTENT)
        ? null
        : arcgisQuery(ctx, EPA_AUM_URL, {
            outFields: EPA_FIELDS,
            bbox: ctx.bbox,
            maxAllowableOffset: EPA_OFFSET,
            resultRecordCount: 1000,
            ttlSeconds: CLEANUP_TTL_SECONDS,
            cacheSuffix: "uranium:epa",
          }),
    ]);
    const cleanup = epa?.ok ? cleanupByMine(epa.fc) : null;

    const features: Feature<Point>[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    const take = (res: ArcgisResult, label: string, normalize: (fc: FeatureCollection) => Feature<Point>[]) => {
      if (!res.ok) {
        failed.push(`${label} (${res.error})`);
        return;
      }
      features.push(...normalize(res.fc));
      if (res.truncated && !wide) notes.push(`Showing 2,000 ${label} records; zoom in for the rest`);
    };
    take(navajo, "Navajo mines", (fc) => (cleanup ? joinCleanup(normalizeNavajo(fc), cleanup) : normalizeNavajo(fc)));
    take(doe, "DOE sites", (fc) => normalizeDoe(fc, new Date().getUTCFullYear()));

    if (failed.length === 2) return { error: `Uranium site data unavailable: ${failed.join("; ")}`, hint: "upstream" };
    if (failed.length > 0) notes.push(`Missing ${failed.join(" and ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push("No Navajo Nation abandoned uranium mines or DOE uranium sites in this area; this layer does not cover other uranium mines (use mines with commodity uranium)");
    } else if (features.some((f) => f.properties?.kind === "abandoned mine")) {
      notes.push(
        cleanup
          ? "Hazard scores are from a 2007 screening, not today's conditions; each mine's EPA cleanup step is from EPA Region 9's current list"
          : "Hazard scores are from a 2007 screening and do not reflect cleanup since; EPA's cleanup status could not be loaded",
      );
    }

    // The total counts every site in the box, so it is only given when both datasets answered and counted.
    const total = failed.length === 0 && navajoCount !== null && doeCount !== null ? navajoCount + doeCount : undefined;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      // Both main records answered: a failed cleanup join is said in the note, not as a failed source.
      ...(epa !== null && !epa.ok && failed.length === 0 && { sourceStatus: { ok: true as const } }),
    };
  },
});

registerLayer(uranium);

export default uranium;

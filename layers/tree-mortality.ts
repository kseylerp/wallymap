/**
 * Tree death mapped from aircraft: bark beetles, drought, fire-weakened trees and other killers, as polygons per survey year.
 * Two keyless sources (verified live 2026-10-10), chosen by the `years` input:
 *   2021 to 2025  US Forest Service Insect and Disease Survey (IDS), damage areas
 *     https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer/1   "IDS AREAS", maxRecordCount 2000
 *     survey_year values present: 2021, 2022, 2023, 2024, 2025. Fields used: survey_year, damage_type (we keep "Mortality"; the
 *     layer also holds defoliation, dieback and others), dca_common_name (the damage agent, e.g. "fir engraver", "mountain pine
 *     beetle"), host and host_group (the tree), percent_affected (class label such as "Moderate (11-29%)"), percent_mid (the
 *     class midpoint, 2 to 40+), acres. These years carry no tree counts, only a percent of trees affected per polygon.
 *   1973 to 2019  California Department of Fish and Wildlife copy of the USFS Region 5 Aerial Detection Survey "Aerial Tree Death
 *     Report 1973-2019 [ds2783]"
 *     https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds2783_fpu/FeatureServer/0   443,421 polygons, 2000 per page
 *     RPT_YR values present: 1973, 1978, 1993 to 2019 (gaps are real: no survey flown). Fields used: RPT_YR, DMG_TYPE1 (we keep
 *     "Mortality"), DCA1 (agent), HOST1, SEVERITY1, NO_TREES_TOTAL (trees killed), TPA_Total (trees per acre), ACRES, FOR_TYPE1.
 *     California only.
 * 2020 was never flown (COVID-19), so no polygons exist for it. 2021 is the first year of the new IDS, 2019 the last of the old copy.
 * `v` is not one unit: trees killed for 1973 to 2019 rows (measure "trees killed"), percent of trees dead for 2021 to 2025 rows
 * (measure "percent of trees"); each row says which in `measure`, and a result spanning both says so in coverageNote.
 * Output properties: year, t (January 1 of the survey year), agent, host, v, measure, acres, plus treesKilled/treesPerAcre
 * (1973 to 2019) or percentAffected (2021 to 2025), source ("USFS IDS" | "CDFW ADS").
 * Each survey year is its own request (300 polygons per year, largest first) for ranges of up to ten survey years; longer ranges are one
 * request of 1,000. The smoke numbers below are from the earlier single-request version (1,000 per source at 0.002 degree simplification): Tahoe -120.5,38.9,-120,39.3 default
 * (2021 to 2025) returned 939 Forest Service polygons in 0.4 s (426 KB); years 2014 to 2019 returned 1,000 California polygons (capped,
 * the note says so) in 0.9 s (391 KB); years 2018 to 2023 returned 728 with the 2020 and mixed-unit notes; Colorado front range
 * -106,39,-105,40 default returned 1,000 (capped) in 1.4 s (365 KB).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, bboxesDisjoint, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const IDS_URL = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer/1";
const CDFW_URL = "https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds2783_fpu/FeatureServer/0";

const IDS_FIELDS = ["survey_year", "dca_common_name", "host", "host_group", "percent_affected", "percent_mid", "acres", "damage_type"];
const CDFW_FIELDS = ["RPT_YR", "DCA1", "HOST1", "SEVERITY1", "NO_TREES_TOTAL", "TPA_Total", "ACRES", "FOR_TYPE1"];

const CDFW_FIRST_YEAR = 1973;
const CDFW_LAST_YEAR = 2019;
const IDS_FIRST_YEAR = 2021;
const IDS_LAST_YEAR = 2025;
const NEVER_FLOWN_YEAR = 2020;

/** Rough extent of California, the only place the 1973 to 2019 copy covers. */
const CALIFORNIA: BBox = [-124.6, 32.4, -114.0, 42.1];

/** Polygons per request when the range is too long for one request per year. */
const MAX_RECORDS = 1000;
/** Polygons per survey year when each year gets its own request. */
const MAX_PER_YEAR = 300;
/** Most survey years that get their own request; a longer range is one request. */
const MAX_PER_YEAR_SPAN = 10;
/** Display simplification in degrees (about 200 m). */
const SIMPLIFY_DEG = 0.002;
const TTL_SECONDS = 7 * 86_400;

const inputSchema = z.object({
  years: z
    .object({
      from: z.number().int().min(CDFW_FIRST_YEAR).max(IDS_LAST_YEAR),
      to: z.number().int().min(CDFW_FIRST_YEAR).max(IDS_LAST_YEAR),
    })
    .optional(),
});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type YearPlan = {
  from: number;
  to: number;
  /** Years to ask the Forest Service survey for (2021 to 2025), or null. */
  ids: [number, number] | null;
  /** Years to ask the California copy for (1973 to 2019), or null. */
  cdfw: [number, number] | null;
  /** True when 2020 falls inside the asked range. */
  includes2020: boolean;
};

/** Which source answers which part of a year range; the default is the whole Forest Service survey, 2021 to 2025. */
export function planYears(years: { from: number; to: number } | undefined): YearPlan {
  const from = years === undefined ? IDS_FIRST_YEAR : Math.min(years.from, years.to);
  const to = years === undefined ? IDS_LAST_YEAR : Math.max(years.from, years.to);
  const cdfwTo = Math.min(to, CDFW_LAST_YEAR);
  const idsFrom = Math.max(from, IDS_FIRST_YEAR);
  return {
    from,
    to,
    cdfw: from <= CDFW_LAST_YEAR ? [Math.max(from, CDFW_FIRST_YEAR), cdfwTo] : null,
    ids: to >= IDS_FIRST_YEAR ? [idsFrom, Math.min(to, IDS_LAST_YEAR)] : null,
    includes2020: from <= NEVER_FLOWN_YEAR && to >= NEVER_FLOWN_YEAR,
  };
}

/** Where clause for the Forest Service survey (numbers come from a validated integer range). */
export function idsWhere([from, to]: [number, number]): string {
  return `survey_year>=${from} AND survey_year<=${to} AND damage_type='Mortality'`;
}

/** Where clause for the California copy. */
export function cdfwWhere([from, to]: [number, number]): string {
  return `RPT_YR>=${from} AND RPT_YR<=${to} AND DMG_TYPE1='Mortality'`;
}

type Source = {
  label: string;
  url: string;
  years: [number, number];
  fields: string[];
  where: (span: [number, number]) => string;
  order: string;
  key: string;
  normalize: (fc: FeatureCollection) => Feature<Geometry>[];
};

/** The calendar years of a range that were flown (2020 never was). */
export function surveyYears([from, to]: [number, number]): number[] {
  const years: number[] = [];
  for (let y = from; y <= to; y++) if (y !== NEVER_FLOWN_YEAR) years.push(y);
  return years;
}

/** "2022", "2022 and 2023", "2018 to 2023" for the ranges a note names. */
function spanList(spans: [number, number][]): string {
  const labels = spans.map(([a, b]) => (a === b ? String(a) : `${a} to ${b}`));
  return labels.length <= 2 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function withYear(properties: Record<string, string | number>, year: unknown): boolean {
  if (typeof year !== "number" || !Number.isInteger(year)) return false;
  properties.year = year;
  properties.t = new Date(Date.UTC(year, 0, 1)).toISOString();
  return true;
}

/** Forest Service 2021 to 2025 rows: v is the percent of trees dead (class midpoint). */
export function normalizeIds(fc: FeatureCollection): Feature<Geometry>[] {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { source: "USFS IDS", measure: "percent of trees" };
    if (!withYear(properties, p.survey_year)) continue;
    properties.agent = str(p.dca_common_name) ?? "unknown agent";
    const host = str(p.host) ?? str(p.host_group);
    if (host !== undefined) properties.host = host;
    const mid = num(p.percent_mid);
    if (mid !== undefined) properties.v = mid;
    const label = str(p.percent_affected);
    if (label !== undefined) properties.percentAffected = label;
    const acres = num(p.acres);
    if (acres !== undefined) properties.acres = Math.round(acres);
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return features;
}

/** California 1973 to 2019 rows: v is the number of trees killed. */
export function normalizeCdfw(fc: FeatureCollection): Feature<Geometry>[] {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { source: "CDFW ADS", measure: "trees killed" };
    if (!withYear(properties, p.RPT_YR)) continue;
    properties.agent = str(p.DCA1) ?? "unknown agent";
    const host = str(p.HOST1);
    if (host !== undefined) properties.host = host;
    const trees = num(p.NO_TREES_TOTAL);
    if (trees !== undefined && trees >= 0) {
      properties.treesKilled = Math.round(trees);
      properties.v = Math.round(trees);
    }
    const perAcre = num(p.TPA_Total);
    if (perAcre !== undefined && perAcre >= 0) properties.treesPerAcre = Math.round(perAcre * 10) / 10;
    const acres = num(p.ACRES);
    if (acres !== undefined) properties.acres = Math.round(acres);
    const forest = str(p.FOR_TYPE1);
    if (forest !== undefined) properties.forestType = forest;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return features;
}

const treeMortality = defineLayer({
  id: "tree-mortality",
  title: "Tree death (beetles, drought, disease)",
  description:
    "Areas where trees died, found by Forest Service aircraft crews mapping dead and dying forest each summer, drawn as polygons. " +
    "Each polygon has year and t (January 1 of the survey year, so the time scrubber steps through the years), agent (the cause, such as mountain pine beetle, fir engraver, western pine beetle, sudden oak death or drought), host (the tree species), acres, and v with measure saying what v counts: " +
    "for 2021 to 2025 (US Forest Service Insect and Disease Survey, whole United States) v is the percent of trees dead in the polygon, with percentAffected as the survey's class (for example Moderate (11-29%)); " +
    "for 1973 to 2019 (California only, from the Department of Fish and Wildlife copy of the Forest Service survey) v is the number of trees killed, with treesKilled, treesPerAcre and forestType. The two units are different, so do not compare or add v across 2019 and 2021. " +
    "Set years to {from, to} (for example {from: 2015, to: 2019}); leave it out for the latest survey, 2021 to 2025. Years up to 2019 return California only; 2021 and later cover the nation. " +
    "Use it for 'where are the beetle-killed trees', 'dead trees', 'how bad was the die-off in the Sierra in 2016', 'drought mortality' or 'show the pine beetle outbreak over time'. " +
    "Caveats: 2020 was never flown, so there is no data for it and the map goes blank for that year. Surveys are sketched by eye from small planes 1,000 to 2,000 feet up, so polygons are rough, miss trees hidden behind ridges, and show where trees died in that year, not how many dead trees still stand. " +
    "Polygons are not every dead tree, and fire-killed trees are mostly not included (see fire-perimeters and burn-severity). Each survey year is fetched separately, at most 300 polygons per year (the biggest first), so a busy year does not crowd out the others; a range longer than ten years is fetched at once, at most 1,000 polygons per source. The result says when it trims. " +
    "Zoom in to a region under 20,000 km² (about a 140 km square) first.",
  coverage: "us",
  license: "Public domain (US Forest Service; California Department of Fish and Wildlife copy)",
  requiredEnv: [],
  maxAreaKm2: 20_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("tree-mortality"), fillOpacity: 0.4 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Forest Service Insect and Disease Survey (2021 to 2025) and California Department of Fish and Wildlife copy of the USFS Region 5 Aerial Detection Survey (1973 to 2019)",
      url: "https://www.fs.usda.gov/science-technology/data-tools-products/fhp-mapping-reporting/detection-surveys",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > treeMortality.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${treeMortality.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const plan = planYears(input.years);
    const notes: string[] = [];
    if (plan.includes2020) notes.push("2020 was never flown, so there is no tree death data for that year");

    const inCalifornia = !bboxesDisjoint(ctx.bbox, CALIFORNIA);
    if (plan.cdfw !== null && !inCalifornia) notes.push("Tree death before 2020 is mapped for California only");

    const sources: Source[] = [];
    if (plan.cdfw !== null && inCalifornia) {
      sources.push({
        label: "California survey (1973 to 2019)",
        url: CDFW_URL,
        years: plan.cdfw,
        fields: CDFW_FIELDS,
        where: cdfwWhere,
        order: "NO_TREES_TOTAL DESC",
        key: "cdfw",
        normalize: normalizeCdfw,
      });
    }
    if (plan.ids !== null) {
      sources.push({
        label: "Forest Service survey (2021 to 2025)",
        url: IDS_URL,
        years: plan.ids,
        fields: IDS_FIELDS,
        where: idsWhere,
        order: "acres DESC",
        key: "ids",
        normalize: normalizeIds,
      });
    }
    if (sources.length === 0) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: notes.join("; ") };
    }

    // One request per survey year, so a busy year cannot crowd out the others; a long range falls back to one capped request.
    const jobs = sources.flatMap((s) => {
      const years = surveyYears(s.years);
      const perYear = years.length <= MAX_PER_YEAR_SPAN;
      const spans: [number, number][] = perYear ? years.map((y) => [y, y]) : [s.years];
      const cap = perYear ? MAX_PER_YEAR : MAX_RECORDS;
      return spans.map(async (span) => ({
        source: s,
        span,
        cap,
        res: await arcgisQuery(ctx, s.url, {
          where: s.where(span),
          outFields: s.fields,
          bbox: ctx.bbox,
          maxRecords: cap,
          maxAllowableOffset: SIMPLIFY_DEG,
          orderByFields: s.order,
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: `${s.key}-${span[0]}-${span[1]}`,
        }),
      }));
    });

    const results = await Promise.all(jobs);
    const ok = results.filter((r): r is typeof r & { res: Extract<ArcgisResult, { ok: true }> } => r.res.ok);
    if (ok.length === 0) {
      const first = results[0].res;
      return { error: first.ok ? "ArcGIS service returned no data" : first.error, hint: "upstream" };
    }

    const features = ok.flatMap((r) => r.source.normalize(r.res.fc));
    for (const s of sources) {
      const mine = results.filter((r) => r.source === s);
      const failed = mine.filter((r) => !r.res.ok);
      if (failed.length > 0) notes.push(`The ${s.label} could not be loaded for ${spanList(failed.map((r) => r.span))}`);
      const capped = mine.filter((r) => r.res.ok && r.res.truncated);
      if (capped.length > 0) {
        notes.push(
          `Showing the ${capped[0].cap.toLocaleString("en-US")} biggest ${s.label} polygons for ${spanList(capped.map((r) => r.span))}; zoom in or narrow the years for the rest`,
        );
      }
    }
    if (new Set(ok.map((r) => r.source)).size === 2) {
      notes.push("v is trees killed up to 2019 and percent of trees from 2021, so do not compare across them");
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(treeMortality);

export default treeMortality;

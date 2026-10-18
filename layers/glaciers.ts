/**
 * Glacier outlines from GLIMS (Global Land Ice Measurements from Space, NSIDC / University of Arizona).
 * Service (verified live 2026-10-09, keyless, no access constraints in the capabilities document):
 *   https://www.glims.org/geoserver/ows  (GeoServer WFS 1.0.0, outputFormat=application/json)
 *   feature type GLIMS:GLIMS_Glacier_Outlines, polygons in EPSG:4326, geometry field entity_geom.
 * Fields read: glac_id (glacier id, e.g. "G240577E37693N"), glac_name (often just a region code such as "CA"
 * or null), db_area (outline area, km2), src_date (date of the source image, ISO), line_type ("glac_bound" is the
 * glacier outline; other types are internal rock and debris lines, filtered out), chief_affl (analysing institution).
 * Query used: cql_filter=BBOX(entity_geom,w,s,e,n,'EPSG:4326') AND line_type='glac_bound', sortBy=db_area D,
 * maxFeatures=MAX_ROWS. `sortBy` works on this server (checked: Columbia Glacier first at 943 km2).
 * Notes from live requests:
 *   - The same glacier is often outlined several times (different image dates and institutions), usually under the
 *     same glac_id. Every dated outline is kept, de-duplicated by glac_id plus src_date (the larger outline wins a tie),
 *     with `t` = src_date, so the time scrubber plays the retreat. Lyell and Maclure Glaciers (Yosemite, box
 *     -119.30,37.70,-119.20,37.78, 86 outlines) have 1984 and 2014 outlines under one id each (Lyell G240728E37743N 0.369 km2
 *     in 1984 to 0.253 in 2014; Maclure G240720E37746N 0.263 to 0.142), and the small ice patches around them 1975, 1984 and 2013/2014.
 *     Outlines of one glacier made under different ids can still overlap.
 *   - Outlines are very detailed and WFS 1.0 cannot simplify them: the 5 largest Alaska glaciers were 2.8 MB, 391
 *     outlines over 20 km2 in a 5 x 2 degree box were 35 MB. Hence the small maxAreaKm2, the row cap and the
 *     vertex thinning below. A response is therefore cached only when small.
 * Smoke through runLayer (2026-10-09, one outline per glacier): Sierra Nevada box -119.6,37.5,-119.0,38.0 returned 211 glaciers in 0.5 s (119 KB
 * after thinning); Eklutna area of Alaska -150,60.9,-149,61.5 returned 123 in 0.4 s (163 KB).
 * Smoke after keeping every dated outline (2026-10-10): Lyell/Maclure box -119.30,37.70,-119.20,37.78 returned 86 outlines in 3.3 s
 * (54 KB); Sierra box above 249 outlines in 1.1 s (151 KB); Eklutna box 141 in 0.8 s (225 KB); Mount Rainier box -121.9,46.7,-121.5,47.0
 * 440 outlines in 0.7 s (627 KB).
 * Wide mode (over 8,000 km², up to the default hard cap of 32,000 km²): the 1,500 largest outline rows (sortBy db_area D, maxFeatures),
 * every glacier among them kept with the one-outline-per-date series, thinned to about 400 m, plus a WFS 1.1 hits count quoted when the
 * row limit cut some off. Smoke wide 2026-10-14 (through runLayer): Chugach -149,60.6,-145,61.8 (about 28,600 km²) returned 1,134 outlines
 * of 6,621 in 5.2 s (2.2 MB out; GLIMS sent about 37 MB raw), Columbia Glacier first.
 * Surveys (2026-10-18): outlines are grouped into survey campaigns (groupSurveys), so time is a few snapshots compared glacier by
 * glacier (`id` = glacier id). Wind River Range box -109.9,42.9,-109.3,43.45 (all Portland State University): image years 1963 (2),
 * 1966 (222), 1974 (52), 2015 (138) and 2019 (3) make two surveys, 1966 and 2015; 117 glaciers outlined in both went from 42.5 to
 * 21.9 km² (48% less), 417 outlines in 0.6 s (401 KB). Fixture glaciers.wind-river.json is that answer with outlines cut to boxes.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { geometryBBox } from "./_shared/geo";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const ENDPOINT = "https://www.glims.org/geoserver/ows";
/**
 * Rows requested, largest outline first. Every dated outline of a glacier is a row, so this is about three times
 * MAX_GLACIERS; a view that fills it may be missing later (smaller) outlines of its smaller glaciers.
 */
const MAX_ROWS = 900;
/** Glaciers returned, largest first; each comes with all of its dated outlines. */
const MAX_GLACIERS = 300;
/** Outlines change on the scale of years. */
const TTL_SECONDS = 7 * 86_400;
/** Largest response body written to the shared cache. */
const MAX_CACHED_CHARS = 4_000_000;
/** Vertices closer than this (degrees, about 40 m) to the last kept one are dropped from the display geometry. */
const MIN_VERTEX_STEP_DEG = 0.0004;
/** Most outlines a wide result (over 8,000 km²) carries, the largest by area. */
const WIDE_LIMIT = 1_500;
/** Coarser thinning for a wide view (about 400 m), seen at a scale where 40 m detail is far below a pixel. */
const WIDE_VERTEX_STEP_DEG = 0.004;

const inputSchema = z.object({});

/** Placeholders, not names: "S/N" and "sin nombre" are Spanish for "no name" (most of Patagonia's unnamed ice, 2026-10-17). */
const GENERIC_NAMES = new Set(["", "none", "null", "unnamed", "unknown", "s/n", "sn", "s.n.", "sin nombre", "no name", "noname", "n/a"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A readable name, or undefined when the record only holds a region code ("CA") or a placeholder. */
function glacierName(raw: unknown): string | undefined {
  const name = str(raw);
  if (name === undefined) return undefined;
  if (GENERIC_NAMES.has(name.toLowerCase())) return undefined;
  if (name.length <= 2) return undefined;
  return name;
}

function outlineFilter(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `BBOX(entity_geom,${west},${south},${east},${north},'EPSG:4326') AND line_type='glac_bound'`;
}

/** WFS request URL for outlines inside a bbox, largest first, at most `rows` of them. */
export function glimsUrl(bbox: BBox, rows: number = MAX_ROWS): string {
  const search = new URLSearchParams({
    service: "WFS",
    version: "1.0.0",
    request: "GetFeature",
    typeName: "GLIMS:GLIMS_Glacier_Outlines",
    outputFormat: "application/json",
    maxFeatures: String(rows),
    sortBy: "db_area D",
    cql_filter: outlineFilter(bbox),
  });
  return `${ENDPOINT}?${search.toString()}`;
}

/** WFS 1.1 `resultType=hits` URL: the number of outlines in the box (`numberOfFeatures` in a small XML answer), no geometry. */
export function glimsCountUrl(bbox: BBox): string {
  const search = new URLSearchParams({
    service: "WFS",
    version: "1.1.0",
    request: "GetFeature",
    typeName: "GLIMS:GLIMS_Glacier_Outlines",
    resultType: "hits",
    cql_filter: outlineFilter(bbox),
  });
  return `${ENDPOINT}?${search.toString()}`;
}

/** The outline count from a hits answer, or undefined on any failure. */
async function glimsCount(ctx: QueryContext, bbox: BBox): Promise<number | undefined> {
  try {
    const res = await ctx.fetch(glimsCountUrl(bbox), {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glims:count`,
      ttlSeconds: TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const m = /numberOfFeatures="(\d+)"/.exec(await res.text());
    return m === null ? undefined : Number(m[1]);
  } catch {
    return undefined;
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Drops vertices within `step` degrees of the last kept one; a ring that collapses below 4 positions is dropped. */
function thinRing(ring: Position[], step: number): Position[] | null {
  if (ring.length < 4) return null;
  const out: Position[] = [[round4(ring[0][0]), round4(ring[0][1])]];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    const p: Position = [round4(ring[i][0]), round4(ring[i][1])];
    if (Math.abs(p[0] - last[0]) >= step || Math.abs(p[1] - last[1]) >= step) out.push(p);
  }
  out.push(out[0]);
  return out.length >= 4 ? out : null;
}

function thinPolygon(rings: Position[][], step: number): Position[][] | null {
  const [outer, ...holes] = rings;
  const thinnedOuter = outer ? thinRing(outer, step) : null;
  if (thinnedOuter === null) return null;
  const thinnedHoles = holes.map((r) => thinRing(r, step)).filter((r): r is Position[] => r !== null);
  return [thinnedOuter, ...thinnedHoles];
}

/** Display geometry with the vertex count cut by thinning (MIN_VERTEX_STEP_DEG by default); null when nothing is left. */
export function thinGeometry(geometry: Geometry | null, step: number = MIN_VERTEX_STEP_DEG): Geometry | null {
  if (geometry === null) return null;
  if (geometry.type === "Polygon") {
    const rings = thinPolygon(geometry.coordinates, step);
    return rings === null ? null : { type: "Polygon", coordinates: rings };
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates.map((p) => thinPolygon(p, step)).filter((p): p is Position[][] => p !== null);
    return polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

type Row = {
  id: string;
  area: number;
  time: number;
  /** The glacier's name when it has a real one (not a region code or placeholder). */
  name: string | undefined;
  center: [number, number];
  /** GLIMS analysis and submission ids of the outline (who mapped it, in which upload), as the source gives them. */
  analysis: number | undefined;
  submission: number | undefined;
  feature: Feature<Geometry>;
};

/** Two outlines of the same name and date whose centres are closer than this (degrees, about 2 km) are one glacier mapped twice. */
const SAME_PLACE_DEG = 0.02;

function centerOf(geometry: Geometry): [number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      west = Math.min(west, c[0]);
      east = Math.max(east, c[0]);
      south = Math.min(south, c[1] as number);
      north = Math.max(north, c[1] as number);
    } else c.forEach(visit);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
  return [(west + east) / 2, (south + north) / 2];
}

/**
 * Converts WFS rows to polygons with name, glacierId, areaKm2, date, t (the source image date), v (area km2) and
 * institution. Every dated outline is kept, so a glacier mapped in 1984 and 2014 comes back twice. Duplicates go two ways:
 * the same glacier id and date keeps the larger outline, and so does a named glacier with the same date and a near-identical
 * position under a different id (GLIMS gives Lyell Glacier two ids), whose ids are then merged under the larger one's id so
 * the dates form one series. The `truncated` flag is set when more than `maxGlaciers` glaciers were present: the largest by
 * any outline are kept, with all of their outlines, oldest first. A wide view passes no glacier cap (its row limit bounds it)
 * and a coarser vertex step.
 */
/** Share of the two boxes' union that both cover (1 for one outline). */
function boxOverlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: [number, number, number, number]) => (r[2] - r[0]) * (r[3] - r[1]);
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

export function normalizeGlaciers(
  json: unknown,
  options: { maxGlaciers?: number; stepDeg?: number } = {},
): { data: FeatureCollection; truncated: boolean; surveys: Survey[]; change?: SurveyChange } {
  const maxGlaciers = options.maxGlaciers ?? MAX_GLACIERS;
  const empty = { data: { type: "FeatureCollection", features: [] } as FeatureCollection, truncated: false, surveys: [] };
  if (typeof json !== "object" || json === null || !("features" in json) || !Array.isArray(json.features)) return empty;

  const rows: Row[] = [];
  let anonymous = 0;
  for (const raw of json.features as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as { geometry?: Geometry | null; properties?: Record<string, unknown> | null };
    const p = f.properties ?? {};
    if (str(p.line_type) !== undefined && p.line_type !== "glac_bound") continue;
    const area = num(p.db_area);
    if (area === undefined) continue;
    const geometry = thinGeometry(f.geometry ?? null, options.stepDeg);
    if (geometry === null) continue;

    const id = str(p.glac_id) ?? `row-${anonymous++}`;
    const srcDate = typeof p.src_date === "string" ? Date.parse(p.src_date) : Number.NaN;
    const dated = Number.isFinite(srcDate);
    const name = glacierName(p.glac_name);
    const properties: Record<string, string | number> = {
      name: name ?? "Unnamed glacier",
      glacierId: id,
      areaKm2: Math.round(area * 1000) / 1000,
      v: Math.round(area * 1000) / 1000,
    };
    if (dated) {
      properties.t = new Date(srcDate).toISOString();
      properties.date = properties.t.slice(0, 10);
    }
    const institution = str(p.chief_affl);
    if (institution !== undefined) properties.institution = institution;

    rows.push({ id, area, time: dated ? srcDate : 0, name, center: centerOf(geometry), analysis: num(p.anlys_id), submission: num(p.subm_id), feature: { type: "Feature", geometry, properties } });
  }
  rows.sort((a, b) => b.area - a.area);

  // Ids that turn out to be one glacier map to the id of the larger outline.
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let r = id;
    while (parent.has(r)) r = parent.get(r) as string;
    return r;
  };

  const seen = new Set<string>();
  const byNameDate = new Map<string, Row[]>();
  const unique: Row[] = [];
  for (const r of rows) {
    const key = `${r.id}|${r.time || "undated"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.name !== undefined && r.time !== 0) {
      // Case aside ("STEFFEN" and "Steffen", two ids mapped by one institution on one day) and by outline as well as center.
      const nameKey = `${r.name.toLowerCase()}|${r.time}`;
      const group = byNameDate.get(nameKey) ?? [];
      const box = geometryBBox(r.feature.geometry);
      const twin = group.find((o) => {
        if (Math.abs(o.center[0] - r.center[0]) < SAME_PLACE_DEG && Math.abs(o.center[1] - r.center[1]) < SAME_PLACE_DEG) return true;
        const other = geometryBBox(o.feature.geometry);
        return box !== null && other !== null && boxOverlap(box, other) >= 0.8;
      });
      if (twin !== undefined) {
        if (root(twin.id) !== root(r.id)) parent.set(root(r.id), root(twin.id));
        continue;
      }
      group.push(r);
      byNameDate.set(nameKey, group);
    }
    unique.push(r);
  }

  // Merged ids now share a root, so the same date can appear twice under it: the larger outline wins.
  const outlines = new Map<string, Row>();
  for (const r of unique) {
    const id = root(r.id);
    if (id !== r.id && r.feature.properties) r.feature.properties.glacierId = id;
    r.id = id;
    const key = `${id}|${r.time || "undated"}`;
    if (!outlines.has(key)) outlines.set(key, r);
  }

  // A glacier ranks by its biggest outline, so a shrinking glacier keeps its place whichever year is shown.
  const biggest = new Map<string, number>();
  for (const r of outlines.values()) biggest.set(r.id, Math.max(biggest.get(r.id) ?? 0, r.area));
  const ranked = [...biggest.entries()].sort((a, b) => b[1] - a[1]);
  const truncated = ranked.length > maxGlaciers;
  const keep = new Set(ranked.slice(0, maxGlaciers).map(([id]) => id));
  const order = new Map(ranked.map(([id], i) => [id, i]));

  const kept = [...outlines.values()]
    .filter((r) => keep.has(r.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.time - b.time);
  addEarlierOutlines(kept);
  const { rows: surveyed, surveys, change } = groupSurveys(kept);
  return { data: { type: "FeatureCollection", features: surveyed.map((r) => r.feature) }, truncated, surveys, change };
}

/** Image years within this many years of a survey's main year are one survey (GLIMS outlines come in survey campaigns). */
export const SURVEY_WINDOW_YEARS = 10;

/** One survey in view: its main year (the year most outlines were mapped from), the image years it spans and its outline count. */
export type Survey = { year: number; from: number; to: number; outlines: number };

/** Glaciers outlined in both the first and the last survey in view, and their total area in each. */
export type SurveyChange = { glaciers: number; firstYear: number; lastYear: number; firstKm2: number; lastKm2: number };

/**
 * The surveys among image years: the year with the most outlines is a survey, and every year within SURVEY_WINDOW_YEARS of
 * it joins it; then the most common year left, and so on. Wind River Range (Portland State University): 1963, 1966 and
 * 1974 images are the 1966 survey, 2015 and 2019 the 2015 survey. Returns the survey year of each image year.
 */
export function surveyYears(counts: Map<number, number>): Map<number, number> {
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const survey = new Map<number, number>();
  for (const [anchor] of byCount) {
    if (survey.has(anchor)) continue;
    for (const [year] of byCount) if (!survey.has(year) && Math.abs(year - anchor) <= SURVEY_WINDOW_YEARS) survey.set(year, anchor);
  }
  return survey;
}

const yearOf = (r: Row) => new Date(r.time).getUTCFullYear();

/**
 * Groups dated outlines into surveys (surveyYears) so the map, the time panel and the compare see a few snapshots, not a
 * scatter of image dates: `t` becomes the survey year ("1966") and `survey` says it, while `date` keeps the image date.
 * A glacier keeps one outline per survey (the one whose image year is closest to the survey year, the later on a tie), and
 * `id` is its glacier id, so the compare matches a glacier's outlines across surveys. Each outline of the last survey whose
 * glacier was also outlined in the first gets `firstKm2` and `lostPct` (the share of that area gone), and `change` totals
 * those glaciers: in the Wind River Range, 117 glaciers went from 42.5 km² in 1966 to 21.9 km² in 2015.
 */
function groupSurveys(rows: Row[]): { rows: Row[]; surveys: Survey[]; change?: SurveyChange } {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.time !== 0) counts.set(yearOf(r), (counts.get(yearOf(r)) ?? 0) + 1);
  const surveyOf = surveyYears(counts);

  const best = new Map<string, Row>();
  const kept: Row[] = [];
  for (const r of rows) {
    if (r.feature.properties) r.feature.properties.id = r.id;
    if (r.time === 0) {
      kept.push(r);
      continue;
    }
    const survey = surveyOf.get(yearOf(r)) as number;
    const key = `${r.id}|${survey}`;
    const other = best.get(key);
    const gap = (x: Row) => Math.abs(yearOf(x) - survey);
    if (other === undefined || gap(r) < gap(other) || (gap(r) === gap(other) && r.time > other.time)) best.set(key, r);
  }
  const chosen = new Set(best.values());
  const surveys = new Map<number, Survey>();
  for (const r of rows) {
    if (r.time === 0 || !chosen.has(r)) continue;
    const year = surveyOf.get(yearOf(r)) as number;
    const s = surveys.get(year) ?? { year, from: yearOf(r), to: yearOf(r), outlines: 0 };
    s.from = Math.min(s.from, yearOf(r));
    s.to = Math.max(s.to, yearOf(r));
    s.outlines += 1;
    surveys.set(year, s);
    if (r.feature.properties) {
      r.feature.properties.t = String(year);
      r.feature.properties.survey = String(year);
    }
    kept.push(r);
  }
  // Keep the input order (largest glacier first, oldest outline first).
  const order = new Map(rows.map((r, i) => [r, i]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const list = [...surveys.values()].sort((a, b) => a.year - b.year);
  if (list.length < 2) return { rows: kept, surveys: list };

  const [first, last] = [list[0].year, list[list.length - 1].year];
  const firstArea = new Map<string, number>();
  for (const r of kept) if (r.feature.properties?.survey === String(first)) firstArea.set(r.id, r.area);
  let glaciers = 0;
  let firstKm2 = 0;
  let lastKm2 = 0;
  for (const r of kept) {
    const before = firstArea.get(r.id);
    if (r.feature.properties?.survey !== String(last) || before === undefined || !r.feature.properties) continue;
    glaciers += 1;
    firstKm2 += before;
    lastKm2 += r.area;
    r.feature.properties.firstKm2 = Math.round(before * 1000) / 1000;
    r.feature.properties.lostPct = Math.round((1 - r.area / before) * 100);
  }
  const change = glaciers > 0 ? { glaciers, firstYear: first, lastYear: last, firstKm2, lastKm2 } : undefined;
  return { rows: kept, surveys: list, ...(change && { change }) };
}

/** "1966 (images from 1963 to 1974, 276 outlines)". */
function surveyText(s: Survey): string {
  const span = s.from === s.to ? `images from ${s.from}` : `images from ${s.from} to ${s.to}`;
  return `${s.year} (${span}, ${s.outlines.toLocaleString("en-US")} outline${s.outlines === 1 ? "" : "s"})`;
}

/**
 * The retreat in one sentence: "117 glaciers outlined in both the 1966 and the 2015 survey covered 42.5 km² then and
 * 21.9 km² in 2015, 48% less".
 */
export function changeText(c: SurveyChange): string {
  const pct = Math.round((1 - c.lastKm2 / c.firstKm2) * 100);
  const trend = pct > 0 ? `${pct}% less` : pct < 0 ? `${-pct}% more` : "about the same";
  const plural = c.glaciers === 1 ? "glacier" : "glaciers";
  return `${c.glaciers.toLocaleString("en-US")} ${plural} outlined in both the ${c.firstYear} and the ${c.lastYear} survey covered ${areaText(c.firstKm2)} then and ${areaText(c.lastKm2)} in ${c.lastYear}, ${trend}`;
}

/** Most earlier years one card lists, newest first. */
const EARLIER_SHOWN = 4;

function areaDigits(km2: number): number {
  return km2 >= 100 ? 0 : km2 >= 1 ? 1 : 2;
}

function areaNumber(km2: number): string {
  return km2.toLocaleString("en-US", { maximumFractionDigits: areaDigits(km2) });
}

function areaText(km2: number): string {
  return `${areaNumber(km2)} km²`;
}

/** True when two outlines were mapped by one team: the same analysis or submission, else the same institution. */
function sameAnalyst(a: Row, b: Row): boolean {
  if (a.analysis !== undefined && a.analysis === b.analysis) return true;
  if (a.submission !== undefined && a.submission === b.submission) return true;
  return false;
}

function institutionOf(r: Row): string | undefined {
  const v = r.feature.properties?.institution;
  return typeof v === "string" ? v : undefined;
}

/**
 * One entry of the earlier list for one year of survey images. A year with one survey date is "2001 1,244 km²". GLIMS
 * often holds several outlines of one year (three 2001 outlines of Pio XI, 1,233 to 1,351 km², from three teams and
 * dates), which would read as one glacier of three sizes; there the entry is the outline mapped by the same analyst or
 * submission as the current one (else the same institution) when exactly one was, and otherwise says how many there
 * are and their range: "3 outlines in 2001 (1,233–1,351 km²)".
 */
function earlierEntry(year: number, outlines: Row[], current: Row): string {
  if (outlines.length === 1) return `${year} ${areaText(outlines[0].area)}`;
  const institution = institutionOf(current);
  for (const same of [outlines.filter((o) => sameAnalyst(o, current)), institution === undefined ? [] : outlines.filter((o) => institutionOf(o) === institution)]) {
    if (same.length === 1) return `${year} ${areaText(same[0].area)}`;
  }
  const areas = outlines.map((o) => o.area);
  const lo = Math.min(...areas);
  const hi = Math.max(...areas);
  // Two ranges that print alike ("1,244–1,244") are one size.
  const range = areaNumber(lo) === areaNumber(hi) ? areaText(lo) : `${areaNumber(lo)}–${areaText(hi)}`;
  return `${outlines.length} outlines in ${year} (${range})`;
}

/**
 * Gives each dated outline `earlier`: the glacier's outlines from before it, newest first ("2001 1,378 km² · 1986
 * 1,402 km²"), one entry per year of survey images (see earlierEntry), so the card of the latest outline (the one the
 * map draws on top and the Rank by list names) says how the glacier has changed.
 */
function addEarlierOutlines(rows: Row[]): void {
  const byId = new Map<string, Row[]>();
  for (const r of rows) if (r.time !== 0) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const series of byId.values()) {
    for (const r of series) {
      const before = series.filter((o) => o.time < r.time);
      if (before.length === 0 || !r.feature.properties) continue;
      const years = new Map<number, Row[]>();
      for (const o of before) {
        const year = new Date(o.time).getUTCFullYear();
        years.set(year, [...(years.get(year) ?? []), o]);
      }
      r.feature.properties.earlier = [...years.entries()]
        .sort((a, b) => b[0] - a[0])
        .slice(0, EARLIER_SHOWN)
        .map(([year, outlines]) => earlierEntry(year, outlines, r))
        .join(" · ");
    }
  }
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "areaKm2",
    type: "measure",
    label: "Area",
    unit: "km²",
    encode: "size",
    aggregate: "sum",
    presets: [
      { label: "Ice patches: under 0.1 km²", max: 0.1 },
      { label: "Small: 0.1 to 1 km²", min: 0.1, max: 1 },
      { label: "Large: 1 to 10 km²", min: 1, max: 10 },
      { label: "Very large: 10 km² and up", min: 10 },
    ],
  },
  { key: "lostPct", type: "measure", label: "Ice lost since the first survey", unit: "%" },
  { key: "survey", type: "category", label: "Survey", primary: true },
  nameAttribute(),
];

const AREA: FieldHelp = {
  text: "The glacier's area in this outline as GLIMS records it (db_area), for the date of the image it was mapped from.",
  unit: "km²",
  source: "GLIMS Glacier Database (NSIDC / University of Arizona)",
  url: "https://www.glims.org/",
};

const HELP: Record<string, FieldHelp> = {
  areaKm2: AREA,
  v: AREA,
  date: { text: "When the satellite or aerial image behind this outline was taken; the ice has usually changed since." },
  survey: { text: "The survey this outline belongs to: GLIMS outlines come in mapping campaigns, and images taken within about 10 years of a campaign's main year count as that survey." },
  firstKm2: { text: "This glacier's area in the first survey in view, for comparison with this outline.", unit: "km²" },
  lostPct: { text: "The share of the glacier's area in the first survey in view that is gone in this outline. Part of a change can be a different team or image drawing the edge differently.", unit: "%" },
  glacierId: { text: "The GLIMS glacier id; outlines of one glacier from different dates share it." },
  institution: { text: "The team that mapped this outline for GLIMS." },
  earlier: { text: "This glacier's outlines from earlier images in GLIMS, newest first: the year of the image and the area then. A year with several outlines shows the one mapped by the same team as this outline, or how many there are and their range." },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²" },
  facts: [
    { key: "survey", label: "Survey" },
    { key: "lostPct", label: "Ice lost since the first survey", unit: "%" },
    { key: "firstKm2", label: "Area in the first survey", unit: "km²" },
    { key: "date", label: "Mapped from image of", format: "date" },
    { key: "earlier", label: "Earlier outlines" },
    { key: "institution", label: "Mapped by" },
    { key: "glacierId", label: "GLIMS id" },
  ],
  hidden: ["id", "t", "v"],
};

const glaciers = defineLayer({
  id: "glaciers",
  title: "Glaciers",
  description:
    "Outlines of the world's glaciers and ice caps from GLIMS (Global Land Ice Measurements from Space), drawn as polygons. " +
    "GLIMS outlines come in surveys (mapping campaigns), so the answer is a few snapshots, not a continuous record: outlines whose image years fall within about 10 years of a survey's main year are grouped as that survey. " +
    "Each polygon has name (many glaciers are unnamed), glacierId, v and areaKm2 (the glacier's area in square kilometres), survey and t (the survey year), date (when the image behind that outline was taken) and institution (who mapped it); a later outline has earlier (the glacier's earlier outlines, year and area, newest first). " +
    "A glacier keeps one outline per survey under the same glacierId, so two surveys compare glacier by glacier: an outline of the last survey whose glacier was also outlined in the first has firstKm2 (its area then) and lostPct (the share of that ice gone). " +
    "The coverage note states the change in the glaciers outlined in both the first and last survey, and the title names the surveys. In the Wind River Range, Wyoming, 117 glaciers outlined in both the 1966 and the 2015 survey covered 42.5 km² then and 21.9 km² in 2015, 48% less; quote that kind of figure, never a total that adds glaciers from different surveys. " +
    "Lyell and Maclure Glaciers in Yosemite shrink between the 1984 and 2014 surveys (Lyell from 0.37 to 0.25 km², Maclure from 0.26 to 0.14 km²), a retreat the compare shows. " +
    "Use it to show where glaciers are, which are biggest, how much ice a range holds, and how glaciers have shrunk, for example 'where are the glaciers near Mount Rainier', 'the largest glaciers in this part of Alaska' or 'show how the Wind River glaciers have retreated'. With 3D on, the map can raise glaciers by area. " +
    "Caveats: this is an inventory, not a current survey. Surveys date from about 1950 to the 2020s depending on the range, so the date matters and most glaciers have shrunk since; do not read the newest outline as today's ice edge. Many glaciers have only one survey, and different teams and image dates make some outline changes partly mapping differences, not melt. " +
    "GLIMS sometimes gives one glacier two ids (Lyell Glacier has two); named glaciers with the same date and place are merged under one glacierId, but unnamed ones can still overlap. Some small ice patches are listed as glaciers and some real glaciers are missing. " +
    "At most the 300 largest glaciers in view are returned (each with one outline per survey). Outlines are simplified for display (details under about 40 m are dropped). " +
    "Works worldwide. Over 8,000 km² (about a 90 km square) it returns the 1,500 largest outlines, drawn coarser (about 400 m).",
  coverage: "global",
  surface: "land",
  license: "Free to use, cite GLIMS (NSIDC / University of Arizona)",
  requiredEnv: [],
  maxAreaKm2: 8_000,
  // A region such as Patagonia (2.8 million km²) answers with its largest outlines: 1,429 in 8.7 s (2026-10-17).
  hardMaxAreaKm2: 3_000_000,
  wide: { orderBy: "area in km²", limit: WIDE_LIMIT },
  input: inputSchema,
  style: {
    geometry: "polygon",
    color: layerColor("glaciers"),
    unit: "km²",
    fillOpacity: 0.3,
    extrude: "v",
  },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // Snapshots: the survey years in view (filled from the data's `t`, one per survey), compared two at a time.
  time: { shape: "snapshots", step: "year" },
  labels: { field: "name", max: 8, rankBy: "areaKm2" },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Wide (over 8,000 km², up to the hard cap): the largest outlines by area, server-sorted and capped at the strategy's
    // limit, with a parallel hits count. GLIMS has no simplification, so the raw answer stays large (about 37 MB for 1,500
    // Alaska outlines) and is thinned to about 400 m here.
    const wideRows = ctx.wide ? Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined;
    const counting = wideRows === undefined ? Promise.resolve(undefined) : glimsCount(ctx, ctx.bbox);

    let body: unknown;
    try {
      const res = await ctx.fetch(glimsUrl(ctx.bbox, wideRows ?? MAX_ROWS), {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:glims`,
        ttlSeconds: TTL_SECONDS,
        shouldCache: (text) => text.length <= MAX_CACHED_CHARS && text.trimStart().startsWith("{"),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `GLIMS returned ${res.status}`, hint: "upstream" };
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        // GeoServer reports bad requests as an XML ServiceExceptionReport with a 200.
        return { error: "GLIMS returned a response that is not GeoJSON", hint: "upstream" };
      }
    } catch (err) {
      return {
        error: isTimeout(err)
          ? `GLIMS timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "GLIMS returned no response",
        hint: "upstream",
      };
    }

    const { data, truncated, surveys, change } =
      wideRows === undefined ? normalizeGlaciers(body) : normalizeGlaciers(body, { maxGlaciers: Infinity, stepDeg: WIDE_VERTEX_STEP_DEG });
    const rows =
      typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features) ? body.features.length : 0;
    // The count is of outline rows (repeats included), so it is only quoted when the row limit cut some off.
    const count = await counting;
    const total = wideRows !== undefined && rows >= wideRows && count !== undefined && count > data.features.length ? count : undefined;
    const notes: string[] = [];
    if (change) notes.push(changeText(change));
    if (surveys.length > 0) {
      const shown = surveys.slice(0, 6).map(surveyText).join(", ");
      notes.push(
        `Outlines exist only for the surveys glaciers were mapped in (${surveys.length === 1 ? "one survey" : `${surveys.length} surveys`} in view: ${shown}${surveys.length > 6 ? " and more" : ""}); the ice between surveys is not shown`,
      );
    }
    if (wideRows !== undefined) {
      // run.ts writes the "showing the N largest" note.
    } else if (truncated) {
      notes.push(`Showing the ${MAX_GLACIERS} largest glaciers in view; zoom in for smaller ones`);
    } else if (rows >= MAX_ROWS) {
      notes.push(`Showing the ${MAX_ROWS} biggest outlines in view; some later outlines of smaller glaciers may be missing, so zoom in`);
    }

    const years = surveys.map((s) => s.year);
    const title = years.length >= 2 ? `Glaciers, surveys of ${years.slice(0, -1).join(", ")} and ${years[years.length - 1]}` : years.length === 1 ? `Glaciers, ${years[0]} survey` : undefined;
    return {
      kind: "geojson",
      data,
      ...(title !== undefined && { title }),
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source: "GLIMS Glacier Database (Raup et al.; NSIDC / University of Arizona), outlines from many contributing institutions",
        url: "https://www.glims.org/",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(glaciers);

export default glaciers;

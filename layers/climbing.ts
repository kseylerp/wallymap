/**
 * Climbing crags, boulders and areas, merged from two keyless sources fetched in parallel:
 *   OpenStreetMap via Overpass:  nwr["sport"="climbing"] minus individual routes (climbing=route|route_bottom|route_top),
 *     `out tags center`; gyms (indoor) only when includeGyms.
 *   OpenBeta GraphQL (POST https://api.openbeta.io/): cragsWithin(filter: { bbox: [w,s,e,n], zoom: 12 }) returns the
 *     leaf crags in the box with totalClimbs, grade counts and sport/trad/bouldering totals. Zoom 11 or higher gives
 *     crags; lower zooms return coarse parent areas.
 * An OpenBeta crag within 100 m of an OSM crag, or within 1 km with a matching name, is merged into it (OSM position,
 * v = the larger route count, OpenBeta link added); the rest stay separate. Two places of one name from one source
 * merge within 500 m.
 * Fixtures: layers/__fixtures__/climbing.rrg.osm.json and climbing.rrg.openbeta.json (Red River Gorge, Kentucky,
 * recorded 2026-10-09; OpenBeta trimmed to 12 crags and OSM to 14 elements).
 * Wide (over 10,000 km², up to the default hard cap of 40,000 km²): the same two requests, both bounded (Overpass at
 * 3,000 elements with its count; OpenBeta has no limit parameter, so the hard cap bounds its box), then the merged
 * places ranked by route count and the first 1,000 kept. total is every merged place, set only when Overpass sent all
 * its matches and every tile of both sources answered.
 * Tiles, retries, cache: both requests are made per fixed grid tile (0.5°, or 2° when the box spans more than six fine
 * tiles), and the places outside the box are dropped. Each tile's answer is cached for 24 h under the tile's key, so a
 * nearby or overlapping box reuses it; failures and empty answers are never cached. Each tile request tries three times
 * (waits of 1 s then 3 s) on network errors, timeouts, 429, 5xx and Overpass failure remarks, inside a 50 s budget per
 * query. One source failing leaves the other's crags with a note naming the failed source; both failing is an upstream
 * error naming both.
 * Live smoke check: Red River Gorge, KY (37.75,-83.7 to 37.85,-83.55), 2026-10-09: 58 places (39 OSM, 43 OpenBeta, 24 in both); Lake Tahoe west (38.8,-120.3 to 39.4,-119.8): 311 places (21 OSM, 307 OpenBeta, 17 in both). No truncation.
 * Tiled smoke check: Red River Gorge, KY (37.73,-83.75 to 37.88,-83.55), 2026-10-16: one 0.5° tile per source, 98 places
 * (67 OSM, 82 OpenBeta, 50 in both), 44 listing sport, 0.8 s; an overlapping box then answered from the cached tile in
 * 6 ms. The public Overpass server answered 406 that day (OVERPASS_URL was used); the layer still drew OpenBeta's 82
 * places and said OpenStreetMap had not answered.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Attribute, type FieldHelp } from "./types";
import {
  bandsBetween,
  CLIMBING_GRADE_HELP,
  CLIMBING_GRADE_SCALE,
  CLIMBING_LEVELS,
  climbingBand,
  nameAttribute,
  orderedBands,
  type ClimbingBand,
} from "./_shared/bands";
import { registerLayer } from "./registry";
import { OVERPASS_USER_AGENT, PUBLIC_OVERPASS_ENDPOINT, overpassBodyCacheable, overpassFailure } from "./_shared/overpass";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { isRetryableStatus, mapLimit, withRetry, type RetryPolicy, type RetryResult } from "@/lib/fetch/retry";
import { GridIndex } from "./_shared/geo";
import {
  bboxClause,
  checkedOn,
  countedTotal,
  elementCenter,
  nodeElementSchema,
  osmCitation,
  overpassBodySchema,
  relationElementSchema,
  wayElementSchema,
  wholeNumber,
} from "./_shared/osm-features";
import { layerColor } from "@/lib/render/palette";

export const OPENBETA_ENDPOINT = "https://api.openbeta.io/";
export const OPENBETA_AREA_URL = "https://openbeta.io/areas/";

/** Most crags kept from each source (the box can hold thousands; the biggest by route count win). */
export const MAX_PER_SOURCE = 3_000;

/** Merge radius in km: any OpenBeta crag this close to an OSM crag is the same place. */
const MERGE_KM = 0.1;
/** Merge radius in km when the names also match, for two places from one source. */
const MERGE_NAMED_KM = 0.5;
/**
 * Merge radius in km for an OpenStreetMap place and an OpenBeta place of one name: two databases listing one wall
 * (Board Wall in the Red River Gorge, OSM and OpenBeta 682 m apart). The eval's duplicates rule uses the same 1 km
 * (lib/checks/mapChecks.ts DUPLICATE_KM).
 */
const MERGE_CROSS_SOURCE_KM = 1;

const inputSchema = z.object({
  /** Also return indoor climbing gyms (kind 'gym'). */
  includeGyms: z.boolean().default(false),
});

type ClimbingInput = z.infer<typeof inputSchema>;

/** Overpass QL for climbing places; `out count` first so the answer can report truncation. */
export function buildClimbingQuery(bbox: BBox): string {
  const area = bboxClause(bbox);
  return (
    `[out:json][timeout:25];` +
    `nwr["sport"="climbing"]["climbing"!~"^(route|route_bottom|route_top)$"]${area}->.c;` +
    `.c out count;` +
    `.c out tags center ${MAX_PER_SOURCE};`
  );
}

/** The OpenBeta GraphQL document: leaf crags with route counts, grades and discipline totals. */
export const OPENBETA_QUERY =
  "query($f: SearchWithinFilter){ cragsWithin(filter:$f){ uuid area_name totalClimbs pathTokens " +
  "metadata{ lat lng leaf isBoulder } " +
  "aggregate{ byGrade{ label count } byDiscipline{ sport{ total } trad{ total } bouldering{ total } tr{ total } } } } }";

export function openbetaBody(bbox: BBox): string {
  return JSON.stringify({ query: OPENBETA_QUERY, variables: { f: { bbox, zoom: 12 } } });
}

const total = z.object({ total: z.number() }).nullable().optional();

const openbetaSchema = z.object({
  data: z.object({
    cragsWithin: z.array(
      z.object({
        uuid: z.string(),
        area_name: z.string(),
        totalClimbs: z.number().nullable().optional(),
        pathTokens: z.array(z.string()).optional(),
        metadata: z.object({
          lat: z.number(),
          lng: z.number(),
          leaf: z.boolean().optional(),
          isBoulder: z.boolean().nullable().optional(),
        }),
        aggregate: z
          .object({
            byGrade: z.array(z.object({ label: z.string(), count: z.number() })).nullable().optional(),
            byDiscipline: z
              .object({ sport: total, trad: total, bouldering: total, tr: total })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
  }),
});

type Props = Record<string, string | number | boolean | string[]>;
type Crag = { position: [number, number]; props: Props };

// ---- grade summaries ----

/** A rank for sorting a Yosemite (5.x) grade label: 5.9 < 5.10a < 5.10d < 5.11; undefined for other systems. */
function ydsRank(label: string): number | undefined {
  const m = /^5\.(\d{1,2})([abcd])?([+-])?/.exec(label);
  if (!m) return undefined;
  const number = Number(m[1]);
  // 5.1 to 5.9 are single digits; 5.10 and up carry a letter, and 5.10 without one counts as 5.10a.
  const letter = m[2] ? "abcd".indexOf(m[2]) + 1 : 1;
  return number * 10 + (number >= 10 ? letter : m[3] === "+" ? 0.5 : m[3] === "-" ? -0.5 : 0);
}

function vRank(label: string): number | undefined {
  const m = /^V(\d{1,2})/i.exec(label);
  return m ? Number(m[1]) : undefined;
}

/** "5.6 to 5.13b; V0 to V4" from OpenBeta's grade counts, or undefined when there are none we can rank. */
export function gradeSummary(byGrade: { label: string; count: number }[] | null | undefined): string | undefined {
  const rank = (fn: (label: string) => number | undefined) => {
    const ranked = (byGrade ?? []).flatMap((g) => {
      const r = fn(g.label);
      return r === undefined ? [] : [{ r, label: g.label }];
    });
    if (ranked.length === 0) return undefined;
    ranked.sort((a, b) => a.r - b.r);
    const lo = ranked[0].label;
    const hi = ranked[ranked.length - 1].label;
    return lo === hi ? lo : `${lo} to ${hi}`;
  };
  const parts = [rank(ydsRank), rank(vRank)].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** "5.6 to 5.13b (yds_class)" from OSM climbing:grade:<system>:min/max tags, preferring YDS then French then UIAA. */
export function osmGradeSummary(tags: Record<string, string>): string | undefined {
  const systems = new Set<string>();
  for (const key of Object.keys(tags)) {
    const m = /^climbing:grade:([a-z_]+):(?:min|max)$/.exec(key);
    if (m) systems.add(m[1]);
  }
  const order = ["yds_class", "yds", "french", "uiaa"];
  const system = order.find((s) => systems.has(s)) ?? [...systems][0];
  if (system === undefined) return undefined;
  const lo = tags[`climbing:grade:${system}:min`];
  const hi = tags[`climbing:grade:${system}:max`];
  if (lo && hi) return lo === hi ? `${lo} (${system})` : `${lo} to ${hi} (${system})`;
  const one = lo ?? hi;
  return one ? `${one} (${system})` : undefined;
}

/**
 * The difficulty bands OpenBeta's grade counts cover (spec §12c: YDS, UIAA, French and V-scale map to Beginner,
 * Intermediate, Advanced, Elite), in band order; grades in other systems are skipped.
 */
export function gradeBandsOf(byGrade: { label: string; count: number }[] | null | undefined): ClimbingBand[] {
  return orderedBands((byGrade ?? []).flatMap((g) => (g.count > 0 ? [climbingBand(g.label)] : [])).filter((b): b is ClimbingBand => b !== undefined));
}

/** The bands an OpenStreetMap crag's climbing:grade:<system>:min/max (or :mean) tags span, in band order. */
export function osmGradeBands(tags: Record<string, string>): ClimbingBand[] {
  const out: ClimbingBand[] = [];
  for (const key of Object.keys(tags)) {
    const m = /^climbing:grade:([a-z_]+):min$/.exec(key);
    if (!m) continue;
    const lo = climbingBand(tags[key], m[1]);
    const hi = climbingBand(tags[`climbing:grade:${m[1]}:max`] ?? tags[key], m[1]);
    if (lo && hi) out.push(...bandsBetween(lo, hi));
    else if (lo ?? hi) out.push((lo ?? hi)!);
  }
  for (const key of Object.keys(tags)) {
    const m = /^climbing:grade:([a-z_]+)(?::mean)?$/.exec(key);
    const band = m ? climbingBand(tags[key], m[1]) : undefined;
    if (band) out.push(band);
  }
  return orderedBands(out);
}

/** A list property as strings (a list, or one value). */
function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
}

// ---- OpenStreetMap ----

const DISCIPLINES = ["sport", "trad", "boulder", "toprope", "ice", "mixed", "via_ferrata", "deepwater"] as const;

/** Route count of an OSM crag: climbing:routes, else the sum of numeric per-discipline counts; undefined when unmapped. */
export function osmRouteCount(tags: Record<string, string>): number | undefined {
  const direct = wholeNumber(tags["climbing:routes"]);
  if (direct !== undefined) return direct;
  let sum = 0;
  let found = false;
  for (const d of DISCIPLINES) {
    const n = wholeNumber(tags[`climbing:${d}`]);
    if (n !== undefined) {
      sum += n;
      found = true;
    }
  }
  return found ? sum : undefined;
}

const NATURAL_CRAG = new Set(["cliff", "rock", "bare_rock", "stone", "peak", "ridge", "hill"]);

/** What kind of place a sport=climbing element is, or null when it is neither a crag, boulder, area nor gym. */
function osmKind(tags: Record<string, string>): "crag" | "boulder" | "area" | "gym" | null {
  const c = tags.climbing;
  if (c === "crag" || c === "boulder" || c === "area") return c;
  if (tags.natural && NATURAL_CRAG.has(tags.natural)) return "crag";
  if (tags.leisure === "sports_centre" || tags.indoor === "yes" || tags.building !== undefined) return "gym";
  return null;
}

/** Converts an Overpass `out tags center` response into crags, skipping gyms unless asked and anything without a position. */
export function osmCrags(json: unknown, includeGyms: boolean): Crag[] {
  const out: Crag[] = [];
  const parsed = overpassBodySchema.safeParse(json);
  if (!parsed.success) return out;

  for (const raw of parsed.data.elements) {
    let osmId = "";
    let tags: Record<string, string> = {};
    let position: [number, number] | null = null;

    const node = nodeElementSchema.safeParse(raw);
    if (node.success) {
      osmId = `node/${node.data.id}`;
      tags = node.data.tags ?? {};
      position = [node.data.lon, node.data.lat];
    } else {
      const way = wayElementSchema.safeParse(raw);
      const rel = way.success ? null : relationElementSchema.safeParse(raw);
      const el = way.success ? way.data : rel?.success ? rel.data : null;
      if (el === null) continue;
      osmId = `${el.type}/${el.id}`;
      tags = el.tags ?? {};
      const c = elementCenter(el);
      position = c ? [c[0], c[1]] : null;
    }
    if (position === null || tags.sport !== "climbing") continue;
    const kind = osmKind(tags);
    if (kind === null || (kind === "gym" && !includeGyms)) continue;

    const props: Props = { kind, osmId, source: "osm" };
    if (tags.name) props.name = tags.name;
    const v = osmRouteCount(tags);
    if (v !== undefined) props.v = v;
    const grades = osmGradeSummary(tags);
    if (grades !== undefined) props.grades = grades;
    const bands = osmGradeBands(tags);
    if (bands.length > 0) props.gradeBands = bands;
    const disciplines = DISCIPLINES.filter((d) => tags[`climbing:${d}`] !== undefined && tags[`climbing:${d}`] !== "no");
    if (disciplines.length > 0) props.disciplines = disciplines;
    if (tags["climbing:orientation"]) props.orientation = tags["climbing:orientation"];
    const maxLength = Number(tags["climbing:length:max"]);
    if (Number.isFinite(maxLength) && maxLength > 0) props.maxLengthM = maxLength;
    if (tags.website) props.website = tags.website;
    if (tags.fee === "yes") props.fee = true;
    else if (tags.fee === "no") props.fee = false;
    const t = checkedOn(tags);
    if (t !== undefined) props.t = t;
    out.push({ position, props });
  }
  return out;
}

// ---- OpenBeta ----

/** Converts an OpenBeta GraphQL answer into crags; an unexpected shape (including GraphQL errors) is null. */
export function openbetaCrags(json: unknown): Crag[] | null {
  const parsed = openbetaSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.data.cragsWithin.map((a): Crag => {
    const props: Props = {
      kind: a.metadata.isBoulder ? "boulder" : a.metadata.leaf === false ? "area" : "crag",
      name: a.area_name,
      source: "openbeta",
      openbetaId: a.uuid,
      url: `${OPENBETA_AREA_URL}${a.uuid}`,
    };
    if (typeof a.totalClimbs === "number") props.v = a.totalClimbs;
    const path = (a.pathTokens ?? []).slice(1, -1);
    if (path.length > 0) props.region = path.join(" > ");
    const grades = gradeSummary(a.aggregate?.byGrade);
    if (grades !== undefined) props.grades = grades;
    const bands = gradeBandsOf(a.aggregate?.byGrade);
    if (bands.length > 0) props.gradeBands = bands;
    const d = a.aggregate?.byDiscipline;
    if (d?.sport?.total) props.sport = d.sport.total;
    if (d?.trad?.total) props.trad = d.trad.total;
    if (d?.bouldering?.total) props.boulder = d.bouldering.total;
    if (d?.tr?.total) props.toprope = d.tr.total;
    const disciplines = (["sport", "trad", "boulder", "toprope"] as const).filter((k) => typeof props[k] === "number");
    if (disciplines.length > 0) props.disciplines = [...disciplines];
    return { position: [a.metadata.lng, a.metadata.lat], props };
  });
}

// ---- merge ----

function nameKey(name: unknown): string {
  return typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

function namesMatch(a: unknown, b: unknown): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  return x.length >= 4 && y.length >= 4 && (x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))));
}

/**
 * One OpenStreetMap crag per wall: mappers often add the same wall twice, as a crag node and as its cliff line (Military
 * Wall in the Red River Gorge is node/7314110512 with 110 routes and way/364439327 130 m away), so places of the same
 * name within 500 m become one. The one with more routes keeps its position and id; the route count is the larger (two
 * mappings of one wall, never a sum), the lists are joined and the other id is kept in `osmIds`.
 */
export function dedupeSameName(crags: Crag[]): Crag[] {
  const kept: Crag[] = [];
  const refLat = crags[0]?.position[1] ?? 0;
  const index = new GridIndex<number>(MERGE_CROSS_SOURCE_KM, refLat);
  for (const crag of [...crags].sort(byRoutes)) {
    const key = nameKey(crag.props.name);
    let twin: number | undefined;
    if (key.length >= 4) {
      index.forEachWithin(crag.position, MERGE_CROSS_SOURCE_KM, (i, km) => {
        if (twin !== undefined || nameKey(kept[i].props.name) !== key) return;
        // One source: within 500 m. Two sources listing one wall: within 1 km.
        if (km <= MERGE_NAMED_KM || kept[i].props.source !== crag.props.source) twin = i;
      });
    }
    if (twin === undefined) {
      index.add(crag.position, kept.length);
      kept.push({ ...crag, props: { ...crag.props } });
      continue;
    }
    const target = kept[twin].props;
    const p = crag.props;
    if (typeof p.v === "number" && (typeof target.v !== "number" || p.v > target.v)) target.v = p.v;
    for (const key of ["grades", "orientation", "website", "maxLengthM", "t"] as const) if (target[key] === undefined && p[key] !== undefined) target[key] = p[key];
    const disciplines = [...new Set([...listOf(target.disciplines), ...listOf(p.disciplines)])];
    if (disciplines.length > 0) target.disciplines = DISCIPLINES.filter((d) => disciplines.includes(d));
    const bands = orderedBands([...listOf(target.gradeBands), ...listOf(p.gradeBands)] as ClimbingBand[]);
    if (bands.length > 0) target.gradeBands = bands;
    if (p.osmId !== undefined) target.osmIds = [...listOf(target.osmIds ?? target.osmId), String(p.osmId)];
    if (target.openbetaId === undefined && p.openbetaId !== undefined) {
      target.openbetaId = p.openbetaId;
      target.url = p.url;
    }
  }
  return kept;
}

/**
 * Merges OpenBeta crags into OSM crags: a match keeps the OSM position and name, takes the larger route count and the
 * OpenBeta link, grades and discipline totals. Each OSM crag absorbs at most one OpenBeta crag. When the two counts
 * differ, both stay (`routesOsm`, `routesOpenbeta`) so the card can say which one `v` is.
 */
export function mergeCrags(osm: Crag[], openbeta: Crag[]): { crags: Crag[]; both: number } {
  const merged = osm.map((c) => ({ ...c, props: { ...c.props } }));
  const refLat = merged[0]?.position[1] ?? openbeta[0]?.position[1] ?? 0;
  const index = new GridIndex<number>(MERGE_CROSS_SOURCE_KM, refLat);
  merged.forEach((c, i) => index.add(c.position, i));

  const taken = new Set<number>();
  const extra: Crag[] = [];
  let both = 0;
  for (const ob of openbeta) {
    const found: { i?: number; km: number } = { km: Infinity };
    index.forEachWithin(ob.position, MERGE_CROSS_SOURCE_KM, (i, km) => {
      if (taken.has(i) || km >= found.km) return;
      if (km <= MERGE_KM || namesMatch(merged[i].props.name, ob.props.name)) {
        found.i = i;
        found.km = km;
      }
    });
    const best = found.i;
    if (best === undefined) {
      extra.push(ob);
      continue;
    }
    taken.add(best);
    both += 1;
    const target = merged[best].props;
    const p = ob.props;
    target.source = "osm+openbeta";
    target.openbetaId = p.openbetaId;
    target.url = p.url;
    if (typeof p.v === "number" && typeof target.v === "number" && p.v !== target.v) {
      target.routesOsm = target.v;
      target.routesOpenbeta = p.v;
    }
    if (typeof p.v === "number" && (typeof target.v !== "number" || p.v > target.v)) target.v = p.v;
    for (const key of ["grades", "region", "sport", "trad", "boulder", "toprope"] as const) {
      if (p[key] !== undefined && (key !== "grades" || target.grades === undefined)) target[key] = p[key];
    }
    // Disciplines and grade bands are lists: the merged place has every one either source names.
    const disciplines = [...new Set([...listOf(target.disciplines), ...listOf(p.disciplines)])];
    if (disciplines.length > 0) target.disciplines = DISCIPLINES.filter((d) => disciplines.includes(d));
    const bands = orderedBands([...listOf(target.gradeBands), ...listOf(p.gradeBands)] as ClimbingBand[]);
    if (bands.length > 0) target.gradeBands = bands;
    if (target.name === undefined) target.name = p.name;
  }
  return { crags: [...merged, ...extra], both };
}

function byRoutes(a: Crag, b: Crag): number {
  const av = typeof a.props.v === "number" ? a.props.v : -1;
  const bv = typeof b.props.v === "number" ? b.props.v : -1;
  return bv - av;
}

// ---- fetching: fixed grid tiles, retried, cached for a day ----

/** Grid sizes in degrees, fine first. A 0.5° tile holds one climbing area (Red River Gorge fits in one) and stays small. */
export const TILE_DEG = [0.5, 2] as const;
/** A box spanning more fine tiles than this (most wide boxes) uses the 2° grid, so it costs a handful of requests. */
const MAX_FINE_TILES = 6;
/** How long a tile's answer is kept. */
export const TILE_TTL_SECONDS = 86_400;
/** Bump when either request changes, so stale tiles are not read back. */
const TILE_KEY_VERSION = "v1";
/** Requests in flight at once per source (the public Overpass server allows only a couple per caller). */
const OVERPASS_CONCURRENCY = 2;
const OPENBETA_CONCURRENCY = 3;

/**
 * Retry and time budget for both sources: three attempts, waiting about 1 s then 3 s, each capped at 25 s, all inside a
 * 50 s budget per query so a query that retries still leaves the 120 s chat turn time to answer. Tests replace `sleep`.
 */
export const CLIMBING_TIMING: { retry: RetryPolicy; budgetMs: number; sleep: (ms: number) => Promise<void> } = {
  retry: { delaysMs: [1_000, 3_000], attemptTimeoutMs: UPSTREAM_TIMEOUT_MS, minAttemptMs: 5_000 },
  budgetMs: 50_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type Tile = { key: string; bbox: BBox };

/**
 * The fixed grid tiles covering a box: 0.5° tiles, or 2° tiles when it would take more than MAX_FINE_TILES. Each is
 * fetched and cached on its own, keyed by the tile and not the box, so a nearby or overlapping box reuses them.
 */
export function climbingTiles(bbox: BBox): Tile[] {
  const [west, south, east, north] = bbox;
  const span = (size: number) => {
    const x0 = Math.floor(west / size);
    const y0 = Math.floor(south / size);
    const x1 = Math.max(x0, Math.ceil(east / size) - 1);
    const y1 = Math.max(y0, Math.ceil(north / size) - 1);
    return { size, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  const fine = span(TILE_DEG[0]);
  const g = fine.count > MAX_FINE_TILES ? span(TILE_DEG[1]) : fine;
  const tiles: Tile[] = [];
  for (let x = g.x0; x <= g.x1; x++) {
    for (let y = g.y0; y <= g.y1; y++) {
      tiles.push({
        key: `climbing:tile:${TILE_KEY_VERSION}:${g.size}:${x}:${y}`,
        bbox: [x * g.size, Math.max(-90, y * g.size), (x + 1) * g.size, Math.min(90, (y + 1) * g.size)],
      });
    }
  }
  return tiles;
}

function inBox([lon, lat]: [number, number], [west, south, east, north]: BBox): boolean {
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function failureReason(err: unknown, source: string, timeoutMs: number): string {
  // DOMException is not an Error subclass in every runtime, so match on name.
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError"
    ? `${source} timed out after ${Math.round(timeoutMs / 1000)} seconds`
    : `${source} returned no response`;
}

/** An Overpass body that names at least one place (not only its `out count`). */
const OSM_PLACE = /"type"\s*:\s*"(node|way|relation)"/;
/** An OpenBeta body with no crags. */
const OPENBETA_EMPTY = /"cragsWithin"\s*:\s*\[\s*\]/;

type OverpassBody = { remark?: unknown; elements: unknown[] };

/**
 * One Overpass tile, retried on network errors, timeouts, 429 and 5xx, and on a 200 that carries a failure remark or a
 * remark with no places (Overpass's way of saying it gave up). Attempts go to OVERPASS_URL when set, the last to the
 * public server. An empty answer is passed back but not cached, so a bad minute is not kept for a day.
 */
async function fetchOverpassTile(ctx: QueryContext, tile: Tile, deadline: number): Promise<RetryResult<OverpassBody>> {
  const primary = ctx.env.OVERPASS_URL || PUBLIC_OVERPASS_ENDPOINT;
  const lastAttempt = CLIMBING_TIMING.retry.delaysMs.length + 1;
  const body = `data=${encodeURIComponent(buildClimbingQuery(tile.bbox))}`;
  return withRetry<OverpassBody>(
    CLIMBING_TIMING.retry,
    deadline,
    async (n, timeoutMs) => {
      try {
        // The configured server gets every attempt but the last, which tries the public one in case it is down.
        const res = await ctx.fetch(n === lastAttempt ? PUBLIC_OVERPASS_ENDPOINT : primary, {
          cacheKey: `${tile.key}:osm`,
          ttlSeconds: TILE_TTL_SECONDS,
          shouldCache: (text) => overpassBodyCacheable(text) && OSM_PLACE.test(text),
          timeoutMs,
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": OVERPASS_USER_AGENT },
          body,
        });
        if (!res.ok) return { ok: false, error: `Overpass returned ${res.status}`, retry: isRetryableStatus(res.status) };
        const json: unknown = await res.json();
        const failure = overpassFailure(json);
        if (failure !== null) return { ok: false, error: `Overpass failed: ${failure}`, retry: true };
        const parsed = json as OverpassBody;
        const places = parsed.elements.some((e) => (e as { type?: unknown }).type !== "count");
        if (!places && typeof parsed.remark === "string") {
          return { ok: false, error: `Overpass sent nothing: ${parsed.remark}`, retry: true };
        }
        return { ok: true, value: parsed };
      } catch (err) {
        return { ok: false, error: failureReason(err, "Overpass", timeoutMs), retry: true };
      }
    },
    CLIMBING_TIMING.sleep,
  );
}

type OpenbetaArea = { uuid: string };

/** One OpenBeta tile, retried on network errors, timeouts, 429 and 5xx, and on GraphQL errors or an unexpected body. */
async function fetchOpenbetaTile(ctx: QueryContext, tile: Tile, deadline: number): Promise<RetryResult<OpenbetaArea[]>> {
  return withRetry<OpenbetaArea[]>(
    CLIMBING_TIMING.retry,
    deadline,
    async (_n, timeoutMs) => {
      try {
        const res = await ctx.fetch(OPENBETA_ENDPOINT, {
          cacheKey: `${tile.key}:openbeta`,
          ttlSeconds: TILE_TTL_SECONDS,
          shouldCache: (text) => !text.includes('"errors"') && text.includes('"cragsWithin"') && !OPENBETA_EMPTY.test(text),
          timeoutMs,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: openbetaBody(tile.bbox),
        });
        if (!res.ok) return { ok: false, error: `OpenBeta returned ${res.status}`, retry: isRetryableStatus(res.status) };
        const json: unknown = await res.json();
        if (openbetaCrags(json) === null) return { ok: false, error: "OpenBeta returned an unexpected response", retry: true };
        return { ok: true, value: (json as { data: { cragsWithin: OpenbetaArea[] } }).data.cragsWithin };
      } catch (err) {
        return { ok: false, error: failureReason(err, "OpenBeta", timeoutMs), retry: true };
      }
    },
    CLIMBING_TIMING.sleep,
  );
}

/** How a source's tiles went: what came back, and the last reason when some or all of them failed. */
type SourceOutcome<T> = { values: T[]; failed: number; total: number; error?: string };

function outcomeOf<T>(results: RetryResult<T>[]): SourceOutcome<T> {
  const out: SourceOutcome<T> = { values: [], failed: 0, total: results.length };
  for (const r of results) {
    if (r.ok) out.values.push(r.value);
    else {
      out.failed++;
      out.error = `${r.error}, ${r.attempts === 1 ? "1 try" : `${r.attempts} tries`}`;
    }
  }
  return out;
}

/** True when every tile of a source failed. */
const allFailed = (o: SourceOutcome<unknown>) => o.total > 0 && o.failed === o.total;

/** The coverage note: how many places came back, from where, and whether either source was cut or missing. */
export function climbingNote(args: {
  shown: number;
  osmShown: number | null;
  openbetaShown: number | null;
  /** True when Overpass held more matches than the 3,000 it sent (the lowest OpenStreetMap ids). */
  osmCut: boolean;
  /** True when OpenBeta sent more than 3,000 crags and only the 3,000 with the most routes were kept. */
  openbetaCut: boolean;
  both: number;
  /** Set when OpenStreetMap failed everywhere after its retries. */
  osmError?: string;
  /** Set when OpenStreetMap failed for some tiles of the box but not all. */
  osmPartError?: string;
  openbetaError?: string;
  openbetaPartError?: string;
  /** A wide box: the run writes the ranked-of-total note, so only say when a source was cut before ranking. */
  wide?: boolean;
}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts = [`Returned ${fmt(args.shown)} climbing places`];
  const sources: string[] = [];
  if (args.osmShown !== null) sources.push(`${fmt(args.osmShown)} from OpenStreetMap`);
  if (args.openbetaShown !== null) sources.push(`${fmt(args.openbetaShown)} from OpenBeta`);
  if (args.both > 0) sources.push(`${fmt(args.both)} in both`);
  if (sources.length > 0) parts.push(`(${sources.join(", ")})`);
  const cuts: string[] = [];
  if (args.osmCut) cuts.push(`OpenStreetMap stopped at ${fmt(MAX_PER_SOURCE)} (lowest ids kept)`);
  if (args.openbetaCut) cuts.push(`OpenBeta kept the ${fmt(MAX_PER_SOURCE)} with the most routes`);
  let note = args.wide
    ? `${parts.join(" ")}${cuts.length > 0 ? `; ranked from part of the box (${cuts.join("; ")})` : ""}`
    : `${parts.join(" ")}; ${cuts.length > 0 ? `the box was truncated (${cuts.join("; ")}), zoom in for the rest` : "the box was not truncated"}`;
  if (args.osmError) note += `. OpenStreetMap did not answer (${args.osmError}), so only OpenBeta crags are shown`;
  else if (args.osmPartError) {
    note += `. OpenStreetMap did not answer for part of the area (${args.osmPartError}), so its crags there are missing`;
  }
  if (args.openbetaError) note += `. OpenBeta did not answer (${args.openbetaError}), so only OpenStreetMap crags are shown`;
  else if (args.openbetaPartError) {
    note += `. OpenBeta did not answer for part of the area (${args.openbetaPartError}), so its crags there are missing`;
  }
  return note;
}

const KIND_LABELS: Record<string, string> = { crag: "Crag", boulder: "Boulder", area: "Area", gym: "Gym" };
const SOURCE_LABELS: Record<string, string> = {
  osm: "OpenStreetMap",
  openbeta: "OpenBeta",
  "osm+openbeta": "OpenStreetMap + OpenBeta",
};

const DISCIPLINE_LABELS: Record<string, string> = {
  sport: "Sport",
  trad: "Trad",
  boulder: "Boulder",
  toprope: "Top rope",
  ice: "Ice",
  mixed: "Mixed",
  via_ferrata: "Via ferrata",
  deepwater: "Deep water solo",
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "disciplines",
    type: "category",
    label: "Discipline",
    multi: true,
    primary: true,
    levels: Object.entries(DISCIPLINE_LABELS).map(([value, label]) => ({ value, label })),
  },
  { key: "gradeBands", type: "ordinal", label: "Grade", multi: true, levels: CLIMBING_LEVELS, scale: CLIMBING_GRADE_SCALE, help: CLIMBING_GRADE_HELP },
  { key: "v", type: "measure", label: "Routes", unit: "routes", encode: "size" },
  { key: "kind", type: "category", label: "Kind", levels: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
  { key: "fee", type: "flag", label: "Fee charged" },
  { key: "source", type: "category", label: "Listed by", levels: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })) },
  nameAttribute(),
];

const BY_DISCIPLINE: FieldHelp = {
  text:
    "Routes of each style in OpenBeta: trad (protected with removable gear), sport (bolted), boulder (short problems climbed over pads) " +
    "and top rope; crowd-sourced counts.",
  source: "OpenBeta",
  url: "https://openbeta.io/",
};

const HELP: Record<string, FieldHelp> = {
  v: {
    text:
      "How many climbing routes or boulder problems the place has: OpenBeta's total climbs, or OpenStreetMap's climbing:routes tag (else the sum " +
      "of its per-style counts); when both sources list the place, the larger number. Crowd-sourced, so treat it as a guide.",
    unit: "routes",
    source: "OpenBeta and OpenStreetMap contributors",
    url: "https://wiki.openstreetmap.org/wiki/Key:climbing",
  },
  grades: {
    text:
      "The range of grades, easiest to hardest: Yosemite Decimal System (5.6, 5.10a...) for roped routes and the V scale for boulders from " +
      "OpenBeta, or the OpenStreetMap climbing:grade tags with their system in brackets.",
    source: "OpenBeta and OpenStreetMap contributors",
    url: "https://wiki.openstreetmap.org/wiki/Key:climbing",
  },
  sport: BY_DISCIPLINE,
  trad: BY_DISCIPLINE,
  boulder: BY_DISCIPLINE,
  toprope: BY_DISCIPLINE,
  routesByDiscipline: BY_DISCIPLINE,
  gradeBands: CLIMBING_GRADE_HELP,
  routeCounts: {
    text: "The two sources count this place's routes differently; Routes shows the larger of the two, never their sum (both list the same routes).",
    source: "OpenStreetMap contributors and OpenBeta",
  },
  fee: { text: "Whether a fee is charged to climb here, from the OpenStreetMap fee tag." },
  disciplines: {
    text:
      "Climbing styles OpenStreetMap lists for the place (climbing:sport, climbing:trad, climbing:boulder, climbing:toprope, ice, mixed and so " +
      "on).",
    source: "OpenStreetMap wiki, Key:climbing",
    url: "https://wiki.openstreetmap.org/wiki/Key:climbing",
  },
  orientation: { text: "Which way the rock faces (climbing:orientation), which tells you when it gets sun." },
  maxLengthM: { text: "Length of the longest route, from the OpenStreetMap climbing:length:max tag.", unit: "m" },
  source: { text: "Which database the place came from; 'osm+openbeta' means both list it and the two were merged into one point." },
  region: { text: "The OpenBeta areas the crag sits in, broadest first." },
  t: { text: "The date a mapper last checked the place on the ground (check_date), when tagged." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Routes" },
  facts: [
    { key: "grades", label: "Grades" },
    {
      key: "routesByDiscipline",
      label: "Routes by discipline",
      parts: [
        { key: "trad", label: "trad" },
        { key: "sport", label: "sport" },
        { key: "boulder", label: "boulder" },
        { key: "toprope", label: "top rope" },
      ],
    },
    {
      key: "routeCounts",
      label: "Routes by source",
      parts: [
        { key: "routesOsm", label: "OpenStreetMap" },
        { key: "routesOpenbeta", label: "OpenBeta" },
      ],
    },
    { key: "gradeBands", label: "Grade bands", format: "list", values: Object.fromEntries(CLIMBING_LEVELS.map((l) => [String(l.value), l.label])) },
    { key: "disciplines", label: "Disciplines", format: "list", values: DISCIPLINE_LABELS },
    { key: "maxLengthM", label: "Longest route", unit: "m", format: "m" },
    { key: "orientation", label: "Faces" },
    { key: "region", label: "Region" },
    { key: "source", label: "Source", values: SOURCE_LABELS },
  ],
  links: [
    { key: "url", label: "Open on OpenBeta" },
    { key: "website", label: "Website" },
  ],
};

const climbing = defineLayer({
  id: "climbing",
  title: "Climbing crags, boulders and areas",
  description:
    "Rock climbing places worldwide: crags and cliffs, bouldering areas (boulders) and climbing areas, merged from OpenStreetMap and OpenBeta, the open climbing route database. " +
    "Each point is one place with kind ('crag', 'boulder', 'area', or 'gym' for indoor gyms when includeGyms is true), name, and v = the number of climbing routes or problems there (the bigger, the taller its column), " +
    "plus where known: grades (the grade range, for example '5.6 to 5.13b; V0 to V4'), gradeBands (the bands those grades span: beginner, intermediate, advanced, elite), disciplines (a list: sport, trad, boulder, toprope, ice...), sport, trad, boulder and toprope route counts, orientation, region, and url, a link to the OpenBeta page with the route list and topos. " +
    "source says which database it came from ('osm', 'openbeta' or 'osm+openbeta'). " +
    "Use it for questions like: where can I go climbing or bouldering near here, which crag has the most routes, where is sport climbing or trad climbing, is there easy top-rope climbing nearby. " +
    "Caveats: OpenBeta is strong in the United States and thinner elsewhere; OpenStreetMap crags are volunteer-mapped and often have no route count (no v); " +
    "route counts and grades are crowd-sourced, so treat them as a guide; access, seasonal closures and bolting rules are not included, so check the land manager (public-lands) before going; " +
    "individual routes and their line geometry are not returned. " +
    "Over 10,000 km² it returns the 1,000 places with the most routes and how many there are in all. Each source returns at most 3,000 places (OpenStreetMap the lowest ids, OpenBeta the most routes) and the coverage note says if the box was cut or a source did not answer.",
  coverage: "global",
  surface: "land",
  license:
    "ODbL (OpenStreetMap contributors); OpenBeta (open data; licence not stated by the project, verify before commercial use)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 10_000,
  wide: { orderBy: "route count", limit: 1000 },
  input: inputSchema,
  // M4 hint: extrude v, heat (Task 0's StyleHints fields).
  style: { geometry: "point", color: layerColor("climbing"), extrude: "v", heat: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input: ClimbingInput): Promise<LayerResult | LayerError> {
    // Both sources, tile by tile, in parallel; one deadline for every attempt keeps the query inside its time budget.
    const deadline = Date.now() + CLIMBING_TIMING.budgetMs;
    const tiles = climbingTiles(ctx.bbox);
    const [osmTiles, obTiles] = await Promise.all([
      mapLimit(tiles, OVERPASS_CONCURRENCY, (t) => fetchOverpassTile(ctx, t, deadline)).then(outcomeOf),
      mapLimit(tiles, OPENBETA_CONCURRENCY, (t) => fetchOpenbetaTile(ctx, t, deadline)).then(outcomeOf),
    ]);
    const osmOk = !allFailed(osmTiles);
    const obOk = !allFailed(obTiles);
    if (!osmOk && !obOk) {
      return {
        error: `Neither climbing source answered: OpenStreetMap (${osmTiles.error}) and OpenBeta (${obTiles.error})`,
        hint: "upstream",
      };
    }

    // Overpass stops at MAX_PER_SOURCE elements per tile; its `out count` says how many the tile really holds, so a
    // tile was cut when that exceeds the elements in its body (gyms and other skipped elements are in both numbers).
    const osmElements = new Map<string, unknown>();
    let osmCut = false;
    for (const body of osmTiles.values) {
      const elements = overpassBodySchema.parse(body).elements.filter((e) => (e as { type?: unknown }).type !== "count");
      if ((countedTotal(body) ?? 0) > elements.length) osmCut = true;
      // A way or relation crossing a tile edge comes back in both tiles.
      for (const e of elements) osmElements.set(`${(e as { type?: unknown }).type}/${(e as { id?: unknown }).id}`, e);
    }
    // One place per wall: the same wall mapped as a node and as a cliff line is one crag. Tiles reach past the box, so
    // keep only what is in it.
    const osmAll = dedupeSameName(osmCrags({ elements: [...osmElements.values()] }, input.includeGyms).filter((c) => inBox(c.position, ctx.bbox)));
    const obAreas = new Map<string, OpenbetaArea>();
    for (const areas of obTiles.values) for (const a of areas) obAreas.set(a.uuid, a);
    const obAll = (openbetaCrags({ data: { cragsWithin: [...obAreas.values()] } }) ?? []).filter((c) => inBox(c.position, ctx.bbox));
    const osm = osmAll.sort(byRoutes).slice(0, MAX_PER_SOURCE);
    const ob = obAll.sort(byRoutes).slice(0, MAX_PER_SOURCE);

    const { crags: joined, both } = mergeCrags(osm, ob);
    // Once more after the merge: an unnamed cliff that took an OpenBeta name, or two OpenBeta areas of one wall, can
    // leave one name twice a few hundred metres apart ("North 40", "Courtesy Wall" at Red River Gorge).
    const merged = dedupeSameName(joined);
    // Wide: rank every merged place by route count and keep the strategy's limit.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const crags = wideLimit === undefined ? merged : [...merged].sort(byRoutes).slice(0, wideLimit);
    const features: Feature<Point>[] = crags.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: c.position },
      properties: c.props,
    }));
    const data: FeatureCollection<Point> = { type: "FeatureCollection", features };

    const citationSources = [
      osmOk ? "OpenStreetMap contributors (ODbL, openstreetmap.org/copyright)" : null,
      obOk ? "OpenBeta (openbeta.io)" : null,
    ];
    // A total is only honest when every tile of both sources answered and Overpass sent all its matches.
    const complete = !osmCut && osmTiles.failed === 0 && obTiles.failed === 0;
    return {
      kind: "geojson",
      data,
      ...(wideLimit !== undefined && complete && { total: merged.length }),
      coverageNote: climbingNote({
        shown: features.length,
        osmShown: osmOk ? osm.length : null,
        openbetaShown: obOk ? ob.length : null,
        osmCut,
        openbetaCut: obAll.length > MAX_PER_SOURCE,
        both,
        ...(!osmOk && { osmError: osmTiles.error }),
        ...(osmOk && osmTiles.failed > 0 && { osmPartError: osmTiles.error }),
        ...(!obOk && { openbetaError: obTiles.error }),
        ...(obOk && obTiles.failed > 0 && { openbetaPartError: obTiles.error }),
        ...(wideLimit !== undefined && { wide: true }),
      }),
      citation: {
        ...osmCitation(),
        source: citationSources.filter((s): s is string => s !== null).join(" and "),
        url: osmOk ? osmCitation().url : "https://openbeta.io",
      },
    };
  },
});

registerLayer(climbing);

export default climbing;

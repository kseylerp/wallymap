/**
 * Climbing crags, boulders and areas, merged from two keyless sources fetched in parallel:
 *   OpenStreetMap via Overpass:  nwr["sport"="climbing"] minus individual routes (climbing=route|route_bottom|route_top),
 *     `out tags center`; gyms (indoor) only when includeGyms.
 *   OpenBeta GraphQL (POST https://api.openbeta.io/): cragsWithin(filter: { bbox: [w,s,e,n], zoom: 12 }) returns the
 *     leaf crags in the box with totalClimbs, grade counts and sport/trad/bouldering totals. Zoom 11 or higher gives
 *     crags; lower zooms return coarse parent areas.
 * An OpenBeta crag within 100 m of an OSM crag, or within 500 m with a matching name, is merged into it (OSM position,
 * v = the larger route count, OpenBeta link added); the rest stay separate.
 * Fixtures: layers/__fixtures__/climbing.rrg.osm.json and climbing.rrg.openbeta.json (Red River Gorge, Kentucky,
 * recorded 2026-10-09; OpenBeta trimmed to 12 crags and OSM to 14 elements).
 * Live smoke check: Red River Gorge, KY (37.75,-83.7 to 37.85,-83.55), 2026-10-09: 58 places (39 OSM, 43 OpenBeta, 24 in both); Lake Tahoe west (38.8,-120.3 to 39.4,-119.8): 311 places (21 OSM, 307 OpenBeta, 17 in both). No truncation.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { overpassQuery, type OverpassResult } from "./_shared/overpass";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
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
/** Merge radius in km when the names also match. */
const MERGE_NAMED_KM = 0.5;

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

type Props = Record<string, string | number | boolean>;
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
    const disciplines = DISCIPLINES.filter((d) => tags[`climbing:${d}`] !== undefined && tags[`climbing:${d}`] !== "no");
    if (disciplines.length > 0) props.disciplines = disciplines.join(", ");
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
    const d = a.aggregate?.byDiscipline;
    if (d?.sport?.total) props.sport = d.sport.total;
    if (d?.trad?.total) props.trad = d.trad.total;
    if (d?.bouldering?.total) props.boulder = d.bouldering.total;
    if (d?.tr?.total) props.toprope = d.tr.total;
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
 * Merges OpenBeta crags into OSM crags: a match keeps the OSM position and name, takes the larger route count and the
 * OpenBeta link, grades and discipline totals. Each OSM crag absorbs at most one OpenBeta crag.
 */
export function mergeCrags(osm: Crag[], openbeta: Crag[]): { crags: Crag[]; both: number } {
  const merged = osm.map((c) => ({ ...c, props: { ...c.props } }));
  const refLat = merged[0]?.position[1] ?? openbeta[0]?.position[1] ?? 0;
  const index = new GridIndex<number>(MERGE_NAMED_KM, refLat);
  merged.forEach((c, i) => index.add(c.position, i));

  const taken = new Set<number>();
  const extra: Crag[] = [];
  let both = 0;
  for (const ob of openbeta) {
    const found: { i?: number; km: number } = { km: Infinity };
    index.forEachWithin(ob.position, MERGE_NAMED_KM, (i, km) => {
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
    if (typeof p.v === "number" && (typeof target.v !== "number" || p.v > target.v)) target.v = p.v;
    for (const key of ["grades", "region", "sport", "trad", "boulder", "toprope"] as const) {
      if (p[key] !== undefined && (key !== "grades" || target.grades === undefined)) target[key] = p[key];
    }
    if (target.name === undefined) target.name = p.name;
  }
  return { crags: [...merged, ...extra], both };
}

function byRoutes(a: Crag, b: Crag): number {
  const av = typeof a.props.v === "number" ? a.props.v : -1;
  const bv = typeof b.props.v === "number" ? b.props.v : -1;
  return bv - av;
}

async function fetchOpenbeta(ctx: QueryContext): Promise<{ ok: true; crags: Crag[] } | { ok: false; error: string }> {
  try {
    const res = await ctx.fetch(OPENBETA_ENDPOINT, {
      cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:openbeta`,
      shouldCache: (body) => !body.includes('"errors"') && body.includes('"cragsWithin"'),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: openbetaBody(ctx.bbox),
    });
    if (!res.ok) return { ok: false, error: `OpenBeta returned ${res.status}` };
    const crags = openbetaCrags(await res.json());
    return crags === null ? { ok: false, error: "OpenBeta returned an unexpected response" } : { ok: true, crags };
  } catch {
    return { ok: false, error: "OpenBeta returned no response" };
  }
}

/** The coverage note: how many places came back, from where, and whether either source was cut or missing. */
export function climbingNote(args: {
  shown: number;
  osmShown: number | null;
  openbetaShown: number | null;
  /** True when a source had more places than were kept. */
  cut: boolean;
  both: number;
  osmError?: string;
  openbetaError?: string;
}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const parts = [`Returned ${fmt(args.shown)} climbing places`];
  const sources: string[] = [];
  if (args.osmShown !== null) sources.push(`${fmt(args.osmShown)} from OpenStreetMap`);
  if (args.openbetaShown !== null) sources.push(`${fmt(args.openbetaShown)} from OpenBeta`);
  if (args.both > 0) sources.push(`${fmt(args.both)} in both`);
  if (sources.length > 0) parts.push(`(${sources.join(", ")})`);
  let note = `${parts.join(" ")}; ${args.cut ? "the box was truncated (largest by route count kept), zoom in for the rest" : "the box was not truncated"}`;
  if (args.osmError) note += `. OpenStreetMap did not answer (${args.osmError}), so OpenBeta crags only`;
  if (args.openbetaError) note += `. OpenBeta did not answer (${args.openbetaError}), so OpenStreetMap crags only`;
  return note;
}

const climbing = defineLayer({
  id: "climbing",
  title: "Climbing crags, boulders and areas",
  description:
    "Rock climbing places worldwide: crags and cliffs, bouldering areas (boulders) and climbing areas, merged from OpenStreetMap and OpenBeta, the open climbing route database. " +
    "Each point is one place with kind ('crag', 'boulder', 'area', or 'gym' for indoor gyms when includeGyms is true), name, and v = the number of climbing routes or problems there (the bigger, the taller its column), " +
    "plus where known: grades (the grade range, for example '5.6 to 5.13b; V0 to V4'), sport, trad, boulder and toprope route counts, orientation, region, and url, a link to the OpenBeta page with the route list and topos. " +
    "source says which database it came from ('osm', 'openbeta' or 'osm+openbeta'). " +
    "Use it for questions like: where can I go climbing or bouldering near here, which crag has the most routes, where is sport climbing or trad climbing, is there easy top-rope climbing nearby, or show the best-developed climbing areas in this region. " +
    "Caveats: OpenBeta is strong in the United States and thinner elsewhere; OpenStreetMap crags are volunteer-mapped and often have no route count (no v); " +
    "route counts and grades are crowd-sourced, so treat them as a guide; access, seasonal closures and bolting rules are not included, so check the land manager (public-lands) before going; " +
    "individual routes and their line geometry are not returned. " +
    "Zoom in to a region under 10,000 km² first. Each source returns at most 3,000 places (the largest by route count) and the coverage note says if the box was cut or a source did not answer.",
  coverage: "global",
  license: "ODbL (OpenStreetMap contributors); OpenBeta (openbeta.io open climbing data)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 10_000,
  input: inputSchema,
  // M4 hint: extrude v, heat (Task 0's StyleHints fields).
  style: { geometry: "point", color: layerColor("climbing"), extrude: "v", heat: true },

  async query(ctx, input: ClimbingInput): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > climbing.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${climbing.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const [osmResult, openbeta]: [OverpassResult, Awaited<ReturnType<typeof fetchOpenbeta>>] = await Promise.all([
      overpassQuery(ctx, buildClimbingQuery(ctx.bbox), { cacheSuffix: "climbing" }),
      fetchOpenbeta(ctx),
    ]);
    if (!osmResult.ok && !openbeta.ok) return { error: `${osmResult.error}; ${openbeta.error}`, hint: "upstream" };

    const osmAll = osmResult.ok ? osmCrags(osmResult.json, input.includeGyms) : [];
    // Overpass stops at MAX_PER_SOURCE elements; its `out count` says how many the box really holds.
    const osmCut = osmResult.ok && (countedTotal(osmResult.json) ?? 0) > MAX_PER_SOURCE;
    const obAll = openbeta.ok ? openbeta.crags : [];
    const osm = osmAll.sort(byRoutes).slice(0, MAX_PER_SOURCE);
    const ob = obAll.sort(byRoutes).slice(0, MAX_PER_SOURCE);

    const { crags, both } = mergeCrags(osm, ob);
    const features: Feature<Point>[] = crags.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: c.position },
      properties: c.props,
    }));
    const data: FeatureCollection<Point> = { type: "FeatureCollection", features };

    const citationSources = [osmResult.ok ? "OpenStreetMap contributors (ODbL)" : null, openbeta.ok ? "OpenBeta" : null];
    return {
      kind: "geojson",
      data,
      coverageNote: climbingNote({
        shown: features.length,
        osmShown: osmResult.ok ? osm.length : null,
        openbetaShown: openbeta.ok ? ob.length : null,
        cut: osmCut || obAll.length > MAX_PER_SOURCE,
        both,
        ...(osmResult.ok ? {} : { osmError: osmResult.error }),
        ...(openbeta.ok ? {} : { openbetaError: openbeta.error }),
      }),
      citation: {
        ...osmCitation(),
        source: citationSources.filter((s): s is string => s !== null).join(" and "),
        url: osmResult.ok ? osmCitation().url : "https://openbeta.io",
      },
    };
  },
});

registerLayer(climbing);

export default climbing;

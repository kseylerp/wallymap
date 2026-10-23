import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { isCombinedId } from "@/lib/render/combined";
import type { BBox, Layer, Surface } from "@/layers/types";
import { cardFeatureOf, rankedTop } from "@/lib/render/attributes";
import { cardContent, isEmptyValue, type CardRow } from "@/lib/render/card";
import { summarizeFeature } from "@/lib/render/inspect";
import { searchable } from "@/lib/render/filters";
import { ROUTE_ERROR_ID } from "@/lib/render/reducer";
import type { MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { RANKED_TOP_N } from "@/lib/render/views";
import { shoreOffsetKm } from "@/lib/checks/landMask";
import { isAcronymName, isAllCaps } from "@/layers/_shared/names";

/**
 * Map checks (the eval's Tier 1): what the map ends up showing after a question, checked without a browser. Each check
 * reads the final map state (every tool result through the reducer, as the browser applies it) and returns failures as
 * plain sentences naming the layer and an example feature. The question set and pass rule live in scripts/eval-model.mts
 * and docs/questions.md.
 *
 * - surface: features where the layer says they belong (Layer.surface): crags on land, buoys at sea, surf at the coast.
 * - lattice: no point layer drawn as a regular grid (a model grid read as places).
 * - duplicates: no place listed twice (an OSM node and a cliff line of the same crag), on the map or in Rank by's top 10,
 *   and no two top-10 entries with one measure under one name stem (Granby Dam and Granby Dikes 1 to 4, one reservoir).
 * - card: the inspect card's rows read as words (no raw keys, "Value", bare URLs, unexplained scores), and no card or
 *   Rank by title is in capitals unless it is an acronym ("PIO XI" is Pio XI), and no date known only to the year reads
 *   "Jan 1, 1963".
 * - layerIds: every layer on the map is a registered layer (no garbled tool names).
 * - place: for a question about a place, the features are in or near it, and every entry of Rank by's top 10 is.
 */

export type CheckName = "surface" | "lattice" | "duplicates" | "card" | "layerIds" | "place";
export type CheckResult = { check: CheckName; ok: boolean; failures: string[] };

/** What the checks read about a layer: the registry entry. */
export type LayerInfo = Pick<Layer, "id" | "title" | "surface" | "style"> & Partial<Pick<Layer, "card" | "fieldHelp" | "attributes">>;
export type LayerLookup = (id: string) => LayerInfo | undefined;

/** The place a question is about: the geocoded place (or the map view a "here" question carries) and its name. */
export type PlaceRef = { bbox: BBox; name: string };

/** How far past the 1:10m coastline a land feature may sit (and a sea feature inland) before it fails. */
export const COAST_TOLERANCE_KM = 2;
/** How far out to sea a coast feature (a surf break, a tide gauge) may sit. */
export const COAST_SEA_KM = 10;
/**
 * A surface failure needs at least this share of the layer's features out of place: a layer drawn in the wrong place is
 * wrong throughout, while a few strays are small islands and fjords the 1:10m mask does not have.
 */
export const SURFACE_SHARE = 0.25;
/** Two features of one name closer than this are one place listed twice, unless they are two separate objects (see `separateObjects`). */
export const DUPLICATE_KM = 1;
/** Two distinct OpenStreetMap objects of one name and kind farther apart than this are two places (upper and lower falls). */
export const DISTINCT_OSM_KM = 0.3;
/** Features checked per layer for surface (spread through the layer). */
const SURFACE_SAMPLE = 1500;
/** Cards built per layer. */
export const CARD_FEATURES = 5;
/** A place check passes when at least this share of a layer's features fall in the grown place box. */
export const PLACE_SHARE = 0.8;
/** The place box grows by this share of its width and height on each side. */
export const PLACE_GROW = 0.25;
/** A point-like place (a town, a peak) still covers at least this many degrees on each axis: "near" reaches ~30 km. */
const PLACE_MIN_SPAN = 0.5;

/**
 * Layers whose features are repeated observations or events of a named thing (a species seen twice, two quakes of the
 * same label, two detections of one fire): one name at two nearby points is expected there, not a duplicate.
 */
const OBSERVATION_LAYERS = new Set(["species", "gbif-occurrences", "fire-detections", "earthquakes", "photos", "fishing", "methane-plumes"]);

/* ---------- Geometry helpers ---------- */

function positions(geometry: Geometry | null | undefined, out: Position[] = []): Position[] {
  if (!geometry) return out;
  switch (geometry.type) {
    case "Point":
      out.push(geometry.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      out.push(...geometry.coordinates);
      break;
    case "MultiLineString":
    case "Polygon":
      for (const r of geometry.coordinates) out.push(...r);
      break;
    case "MultiPolygon":
      for (const p of geometry.coordinates) for (const r of p) out.push(...r);
      break;
    case "GeometryCollection":
      for (const g of geometry.geometries) positions(g, out);
  }
  return out;
}

/** Up to `n` positions spread evenly through the feature's coordinates. */
function samplePositions(feature: Feature, n = 8): Position[] {
  const all = positions(feature.geometry);
  if (all.length <= n) return all;
  return Array.from({ length: n }, (_, i) => all[Math.floor((i * (all.length - 1)) / (n - 1))]);
}

/** Up to `n` items spread evenly through a list. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

function bboxOf(feature: Feature): BBox | null {
  const all = positions(feature.geometry);
  if (all.length === 0) return null;
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of all) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

function centerOf(feature: Feature): [number, number] | null {
  const b = bboxOf(feature);
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
}

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;

/** Distance in km from a point to the nearest part of a feature (its vertices and segments). */
function distanceKm([lon, lat]: Position, feature: Feature): number {
  const kx = KM_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
  const xy = ([x, y]: Position): [number, number] => [(x - lon) * kx, (y - lat) * KM_PER_DEG_LAT];
  let best = Infinity;
  const visitLine = (line: Position[]) => {
    if (line.length === 1) best = Math.min(best, Math.hypot(...xy(line[0])));
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, ay] = xy(line[i]);
      const [bx, by] = xy(line[i + 1]);
      const vx = bx - ax;
      const vy = by - ay;
      const len = vx * vx + vy * vy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len));
      best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
    }
  };
  const g = feature.geometry;
  if (!g) return Infinity;
  switch (g.type) {
    case "Point":
      visitLine([g.coordinates]);
      break;
    case "MultiPoint":
      for (const p of g.coordinates) visitLine([p]);
      break;
    case "LineString":
      visitLine(g.coordinates);
      break;
    case "MultiLineString":
    case "Polygon":
      g.coordinates.forEach(visitLine);
      break;
    case "MultiPolygon":
      g.coordinates.forEach((p) => p.forEach(visitLine));
      break;
    default:
      for (const p of positions(g)) visitLine([p]);
  }
  return best;
}

/** "36.60, -122.40" (lat, lon), where an example feature is. */
function at(feature: Feature): string {
  const c = feature.geometry?.type === "Point" ? feature.geometry.coordinates : centerOf(feature);
  return c ? `${c[1].toFixed(2)}, ${c[0].toFixed(2)}` : "no position";
}

/** A feature's name as a person reads it, or null. */
function nameOf(feature: Feature): string | null {
  const n = feature.properties?.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** `"Muir Valley" at 37.72, -83.66`, or `a feature at 37.72, -83.66` without a name. */
function example(feature: Feature): string {
  const name = nameOf(feature);
  return name ? `"${name}" at ${at(feature)}` : `a feature at ${at(feature)}`;
}

/** Lower case, accents and punctuation dropped, single spaces: how names are compared. */
export function normalName(name: string): string {
  return searchable(name)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Words that say which part of a place a name is, not which place: "Granby Dike 4" and "Granby Dam" are Granby's. */
const PART_WORDS = new Set(["dam", "dike", "dyke", "saddle", "levee", "spillway", "embankment", "main", "auxiliary", "no", "unit", "north", "south", "east", "west", "upper", "lower"]);

/** The place a name points at, without its part words, numbers and roman numerals: "granby" for "Granby Dike 4". */
export function nameStem(name: string): string {
  return normalName(name)
    .split(" ")
    .filter((w) => w !== "" && !PART_WORDS.has(w) && !/^\d+$/.test(w) && !/^[ivx]+$/.test(w))
    .join(" ");
}

function isUnnamed(norm: string): boolean {
  return norm === "" || /^unnamed\b/.test(norm);
}

/* ---------- Drawn layers ---------- */

type Drawn = {
  id: string;
  info: LayerInfo | undefined;
  label: string;
  data: FeatureCollection;
  loaded: FeatureCollection;
  op: MapState["renderOps"][number];
  /** The coverage notes the layer panel and card show (one per compare side). */
  notes: string[];
  /** A vector field drawn as moving particles (ocean currents, wind): its features are the grid's nodes, not places. */
  flow?: boolean;
};

/** The GeoJSON layers the map draws (visible, filtered and windowed), one entry per layer id (compare side B folded in). */
export function drawnLayers(state: MapState, lookup: LayerLookup): Drawn[] {
  const visible = visibleState(state);
  const out = new Map<string, Drawn>();
  for (const [key, layer] of Object.entries(visible.layers)) {
    const id = key.endsWith("~b") ? key.slice(0, -2) : key;
    const op = state.renderOps.find((o) => o.layerId === id);
    if (!op?.visible || layer.result.kind !== "geojson") continue;
    const loaded = state.layers[id]?.result;
    const info = lookup(id);
    const prev = out.get(id);
    const features = [...(prev?.data.features ?? []), ...layer.result.data.features];
    const notes = [...(prev?.notes ?? []), ...(layer.result.coverageNote ? [layer.result.coverageNote] : [])];
    out.set(id, {
      id,
      info,
      label: `${info?.title ?? layer.title} (${id})`,
      data: { type: "FeatureCollection", features },
      loaded: loaded?.kind === "geojson" ? loaded.data : layer.result.data,
      op,
      notes,
      ...(loaded?.kind === "geojson" && loaded.flow !== undefined && { flow: true }),
    });
  }
  return [...out.values()];
}

/* ---------- 1. On land / at sea ---------- */

function surfaceFor(info: LayerInfo | undefined, feature: Feature): Surface {
  const s = info?.surface ?? "any";
  if (typeof s === "string") return s;
  const v = feature.properties?.[s.key];
  return (typeof v === "string" && s.by[v]) || s.default;
}

/** True when a signed shore offset (km inland positive, at sea negative) fits the surface. */
export function fitsSurface(surface: Surface, offsetKm: number): boolean {
  switch (surface) {
    case "land":
      return offsetKm >= -COAST_TOLERANCE_KM;
    case "water":
      return offsetKm <= COAST_TOLERANCE_KM;
    case "coast":
      return offsetKm <= COAST_TOLERANCE_KM && offsetKm >= -COAST_SEA_KM;
    default:
      return true;
  }
}

const WHERE: Record<Exclude<Surface, "any">, string> = {
  land: `out at sea, more than ${COAST_TOLERANCE_KM} km from land`,
  water: `inland, more than ${COAST_TOLERANCE_KM} km from the sea`,
  coast: `away from the coast (more than ${COAST_TOLERANCE_KM} km inland or ${COAST_SEA_KM} km out to sea)`,
};

export function checkSurface(layers: Drawn[]): CheckResult {
  const failures: string[] = [];
  for (const layer of layers) {
    // A flow field's nodes are model cells, not drawn: its particles are masked to water on the map.
    if (layer.flow) continue;
    const features = spread(layer.data.features, SURFACE_SAMPLE);
    const off = new Map<Exclude<Surface, "any">, Feature[]>();
    for (const f of features) {
      const surface = surfaceFor(layer.info, f);
      if (surface === "any") continue;
      const ok = samplePositions(f).some(([x, y]) => fitsSurface(surface, shoreOffsetKm(x, y)));
      if (!ok) off.set(surface, [...(off.get(surface) ?? []), f]);
    }
    for (const [surface, bad] of off) {
      if (bad.length / features.length < SURFACE_SHARE) continue;
      failures.push(`${layer.label}: ${bad.length} of ${features.length} features are ${WHERE[surface]}, e.g. ${example(bad[0])}.`);
    }
  }
  return { check: "surface", ok: failures.length === 0, failures };
}

/* ---------- 2. Lattice ---------- */

const COORD = 1e6;

/** Distinct values (to 1e-6) shared by at least `min` of the numbers. */
function sharedValues(values: number[], min: number): number[] {
  const counts = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v * COORD);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= min).map(([k]) => k / COORD).sort((a, b) => a - b);
}

/** True when sorted values step evenly: every gap a whole multiple of the smallest. */
function evenlySpaced(values: number[]): number | null {
  if (values.length < 3) return null;
  const gaps = values.slice(1).map((v, i) => v - values[i]);
  const step = Math.min(...gaps);
  if (step <= 1e-5) return null;
  return gaps.every((g) => Math.abs(g / step - Math.round(g / step)) < 0.02) ? step : null;
}

/**
 * The regular grid a set of points sits on, when at least 9 of them do: 3 or more columns (one longitude shared by 3 or
 * more points) and 3 or more rows, each evenly spaced, with the grid at least 60% filled. Null for real places.
 */
export function findLattice(points: [number, number][]): { cols: number; rows: number; count: number; dx: number; dy: number } | null {
  const unique = [...new Map(points.map((p) => [`${Math.round(p[0] * COORD)},${Math.round(p[1] * COORD)}`, p])).values()];
  if (unique.length < 9) return null;
  const cols = sharedValues(unique.map((p) => p[0]), 3);
  const rows = sharedValues(unique.map((p) => p[1]), 3);
  if (cols.length < 3 || rows.length < 3) return null;
  const colSet = new Set(cols.map((c) => Math.round(c * COORD)));
  const rowSet = new Set(rows.map((r) => Math.round(r * COORD)));
  const on = unique.filter((p) => colSet.has(Math.round(p[0] * COORD)) && rowSet.has(Math.round(p[1] * COORD)));
  const dx = evenlySpaced(cols);
  const dy = evenlySpaced(rows);
  if (on.length < 9 || dx === null || dy === null) return null;
  const span = (Math.round((cols[cols.length - 1] - cols[0]) / dx) + 1) * (Math.round((rows[rows.length - 1] - rows[0]) / dy) + 1);
  if (on.length / span < 0.6) return null;
  return { cols: cols.length, rows: rows.length, count: on.length, dx, dy };
}

export function checkLattice(layers: Drawn[]): CheckResult {
  const failures: string[] = [];
  for (const layer of layers) {
    // A flow field's nodes are a grid by design, drawn as moving particles, never as places.
    if (layer.flow) continue;
    const points = layer.data.features.filter((f) => f.geometry?.type === "Point");
    const grid = findLattice(points.map((f) => (f.geometry as GeoJSON.Point).coordinates.slice(0, 2) as [number, number]));
    if (!grid) continue;
    failures.push(
      `${layer.label}: ${grid.count} points sit on a regular ${grid.cols} × ${grid.rows} grid (${grid.dx.toFixed(3)}° by ${grid.dy.toFixed(3)}° apart), which reads as a model grid rather than real places, e.g. ${example(points[0])}.`,
    );
  }
  return { check: "lattice", ok: failures.length === 0, failures };
}

/* ---------- 3. Duplicates ---------- */

/** Two features of one name closer than this are the same spot, whatever else shares the name. */
const SAME_SPOT_KM = 0.015;

/** Names that say what a thing is rather than which one it is: many different places carry them. */
const GENERIC_NAMES = new Set(["pullout", "parking", "parking lot", "campsite", "camp site", "designated campsite", "dispersed campsite", "trailhead", "viewpoint", "toilet", "toilets", "shelter", "spring", "picnic area", "picnic site", "unnamed", "tunnel", "adit", "shaft", "mine shaft", "prospect", "prospect pit", "mine", "quarry", "gravel pit", "borrow pit"]);

function overlapShare(a: BBox, b: BBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w < 0 || h < 0) return 0;
  const area = (r: BBox) => Math.max((r[2] - r[0]) * (r[3] - r[1]), 1e-12);
  const inter = Math.max(w * h, 1e-12);
  return inter / (area(a) + area(b) - inter);
}

/** Where a feature's record comes from: its `source` ("osm", "openbeta", "osm+openbeta"), else "osm" for an OSM id and "openbeta" for an OpenBeta id. */
function sourceOf(feature: Feature): string | null {
  const p = feature.properties ?? {};
  if (typeof p.source === "string" && p.source !== "") return p.source;
  if (osmIdsOf(feature).length > 0) return "osm";
  if (typeof p.openbetaId === "string" && p.openbetaId !== "") return "openbeta";
  return null;
}

/** The OpenStreetMap objects a feature stands for ("node/7314110512"): its `osmId` and any merged `osmIds`. */
function osmIdsOf(feature: Feature): string[] {
  const p = feature.properties ?? {};
  const ids = [p.osmId, ...(Array.isArray(p.osmIds) ? p.osmIds : [])].filter((id): id is string | number => (typeof id === "string" && id !== "") || typeof id === "number");
  return ids.map(String);
}

/**
 * True when two features of one name `km` apart are two separate places, not one listed twice. Two sources (an OSM
 * node and an OpenBeta area, or two different `source` values) are one place listed twice. From one source, two
 * different kinds are two places, and so are two distinct OSM objects (no OSM id in common) of one kind more than
 * 300 m apart (Saut Grand Continent's upper and lower falls, 680 m). Anything else is one place: one kind without OSM
 * ids, or an OSM node and way of one crag 200 m apart.
 */
function separateObjects(a: Feature, b: Feature, km: number): boolean {
  const sa = sourceOf(a);
  const sb = sourceOf(b);
  if (sa !== null && sb !== null && sa !== sb) return false;
  const ka = a.properties?.kind;
  const kb = b.properties?.kind;
  if (typeof ka === "string" && typeof kb === "string" && ka !== kb) return true;
  const ia = osmIdsOf(a);
  const ib = osmIdsOf(b);
  const distinctOsm = ia.length > 0 && ib.length > 0 && !ia.some((id) => ib.includes(id));
  return distinctOsm && km > DISTINCT_OSM_KM;
}

/**
 * The distance (km) between two features of one name when they are one place listed twice, else null: a point within
 * 1 km of the other feature (an OSM node and a cliff line of one crag), or two areas with nearly the same extent (one
 * fire from two agencies). Within 15 m they are always one place; farther apart, two separate objects (see
 * `separateObjects`: one source, and different kinds or distinct OSM objects over 300 m apart) are two places. Two
 * lines of one name are the segments of one trail, drawn as one; two dated features with different dates are two
 * events. `shared` is how many features in the layer carry the name: a name on three or more (Potato Bottom A, B and
 * C) counts only at the same spot.
 */
function samePlace(a: Feature, b: Feature, shared: number): number | null {
  const ta = a.properties?.t;
  const tb = b.properties?.t;
  if (ta !== undefined && tb !== undefined && ta !== tb) return null;
  const ap = a.geometry?.type === "Point";
  const bp = b.geometry?.type === "Point";
  const area = (f: Feature) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon";
  if (!ap && !bp) {
    if (!area(a) || !area(b)) return null;
    const ba = bboxOf(a);
    const bb = bboxOf(b);
    return ba && bb && overlapShare(ba, bb) >= 0.8 ? 0 : null;
  }
  const point = (ap ? a : b).geometry as GeoJSON.Point;
  const d = distanceKm(point.coordinates, ap ? b : a);
  const limit = shared >= 3 ? SAME_SPOT_KM : DUPLICATE_KM;
  if (d > limit) return null;
  return d <= SAME_SPOT_KM || !separateObjects(a, b, d) ? d : null;
}

/** Properties that name the one place a feature belongs to (a state or a region holds many places). */
const PLACE_KEYS = ["place", "park", "project"];

/**
 * True when two features of one name are one place: a shared place-like property or within 1 km of each other, and
 * not two separate objects (the same rule as the drawn check: one source, and different kinds or distinct OSM objects
 * over 300 m apart). Within 15 m they are always one place.
 */
function sameNamedPlace(a: Feature, b: Feature): boolean {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const d = ca !== null && cb !== null ? Math.min(distanceKm(ca, b), distanceKm(cb, a)) : Infinity;
  const samePlaceKey = PLACE_KEYS.some((k) => {
    const va = a.properties?.[k];
    return typeof va === "string" && va !== "" && va === b.properties?.[k];
  });
  if (!samePlaceKey && d > DUPLICATE_KM) return false;
  return d <= SAME_SPOT_KM || !separateObjects(a, b, d);
}

export function checkDuplicates(layers: Drawn[]): CheckResult {
  const failures: string[] = [];
  for (const layer of layers) {
    // A flow field's nodes are a grid, named by position, never places.
    if (layer.flow) continue;
    if (!OBSERVATION_LAYERS.has(layer.id)) {
      const byName = new Map<string, Feature[]>();
      for (const f of layer.data.features) {
        // The ground a changed area lost (lib/render/compare.ts lostGround) is part of that area, not a second place.
        if (f.properties?.deltaLost === true) continue;
        const name = nameOf(f);
        const norm = name ? normalName(name) : "";
        if (isUnnamed(norm) || GENERIC_NAMES.has(norm)) continue;
        byName.set(norm, [...(byName.get(norm) ?? []), f]);
      }
      const pairs: string[] = [];
      let count = 0;
      for (const group of byName.values()) {
        if (group.length < 2) continue;
        const items = group.slice(0, 60);
        let found = false;
        for (let i = 0; i < items.length && !found; i++) {
          for (let j = i + 1; j < items.length && !found; j++) {
            const d = samePlace(items[i], items[j], group.length);
            if (d === null) continue;
            found = true;
            count += 1;
            const areas = items[i].geometry?.type !== "Point" && items[j].geometry?.type !== "Point";
            const how = areas ? "as two nearly identical areas" : d < SAME_SPOT_KM ? "at the same spot" : `${(d * 1000).toFixed(0)} m apart`;
            if (pairs.length < 3) pairs.push(`"${nameOf(items[i])}" twice ${how} (${at(items[i])})`);
          }
        }
      }
      if (count > 0) failures.push(`${layer.label}: ${count} ${count === 1 ? "place is" : "places are"} drawn twice within ${DUPLICATE_KM} km, e.g. ${pairs.join("; ")}.`);
    }
    // The Rank by list (the row's own function): no name and place twice.
    if (layer.info) {
      const { key, measures, top } = rankedTop(layer.info, layer.op, layer.loaded, layer.data, RANKED_TOP_N);
      const by = measures.find((m) => m.key === key)?.label.toLowerCase() ?? key;
      const repeated: string[] = [];
      for (let i = 0; i < top.length; i++) {
        const ni = nameOf(top[i]);
        if (!ni || isUnnamed(normalName(ni))) continue;
        for (let j = i + 1; j < top.length; j++) {
          const nj = nameOf(top[j]);
          if (nj && normalName(nj) === normalName(ni) && sameNamedPlace(top[i], top[j])) {
            repeated.push(`"${ni}" (rows ${i + 1} and ${j + 1})`);
            break;
          }
        }
      }
      if (repeated.length > 0) failures.push(`${layer.label}: the Rank by top ${top.length} (by ${by}) lists the same place twice: ${repeated.slice(0, 3).join(", ")}.`);
      // One reservoir's dam and dikes, each filed with the reservoir's storage: one measure under one name stem.
      const echoes: string[] = [];
      for (let i = 0; i < top.length && key; i++) {
        const vi = top[i].properties?.[key];
        const si = nameStem(nameOf(top[i]) ?? "");
        if (typeof vi !== "number" || vi === 0 || si === "") continue;
        for (let j = i + 1; j < top.length; j++) {
          if (top[j].properties?.[key] === vi && nameStem(nameOf(top[j]) ?? "") === si) {
            echoes.push(`"${nameOf(top[i])}" and "${nameOf(top[j])}" (rows ${i + 1} and ${j + 1})`);
            break;
          }
        }
      }
      if (echoes.length > 0) {
        failures.push(`${layer.label}: the Rank by top ${top.length} (by ${by}) repeats one ${by} under one name, parts of one place listed as separate entries: ${echoes.slice(0, 3).join(", ")}.`);
      }
    }
  }
  return { check: "duplicates", ok: failures.length === 0, failures };
}

/* ---------- 4. Card text ---------- */

export type CardSection = "measure" | "fact" | "detail" | "signal";
export type SectionRow = { section: CardSection; row: CardRow };

/** A label that is a property key, not words: snake_case, camelCase, or a unit glued on ("Max length m"). */
const UNIT_TAIL = /[A-Za-z]\s(m|km|km2|sq km|sq mi|ft|mi|pct|percent|mw|kw|kv|kg|cm|mm|s|h|c|f|kmh|mph|deg|ma|cfs|no)$/i;

/** One- and two-letter labels that are words, not keys ("To" on a route from one place to another). */
const SHORT_WORDS = new Set(["to", "at", "on", "in", "by", "up"]);

/** A label whose last word is one letter ("Then t", "Then v"): a key's suffix, not words. */
const LETTER_TAIL = /[a-z]\s[a-z]$/i;

/** A label naming a code, id or year: its value is an identifier, never a quantity with a thousands comma. */
const IDENTIFIER_LABEL = /\b(code|id|fips|huc|no|number|year|designated|established|completed|built)\b/i;

/** A label naming a code or type: a bare number under it is a code nobody can read without help. */
const CODE_LABEL = /\b(code|type|class)\b/i;

/** Labels of a part of something (in view, inside the box) and of the whole it belongs to. */
const PART_LABEL = /\b(in view|inside|in the box|part)\b/i;
const WHOLE_LABEL = /\b(full|whole|total|overall)\b/i;

/** Self-explanatory one-word keys a bare number may sit under. */
const PLAIN_NUMBER_KEYS = new Set(["year", "count", "elevation", "population", "capacity", "acres", "depth", "area", "length", "height", "width"]);

/**
 * What is wrong with one card's rows, as short phrases: a raw property key as a label, "Value" where the layer names its
 * measure, a bare URL as text, a raw code ("osm+openbeta"), mostly empty values ("n/a", "Not Available", "Unknown",
 * "None") or any empty fact, a number labelled score, index or rank with no
 * help, a bare number under its own one-word key with no unit or help ("Trad 1"), a part larger than its whole ("Length
 * in view 50.1 km" over "Full length 48.1 km").
 */
export function cardRowProblems(rows: SectionRow[], layer: Pick<LayerInfo, "card">): string[] {
  const problems: string[] = [];
  for (const { row } of rows) {
    const label = row.label.trim();
    // camelCase in a one-word label is a key; inside words it is a name ("OpenStreetMap element").
    if (/_/.test(label) || (/[a-z][A-Z]/.test(label) && !/\s/.test(label)) || UNIT_TAIL.test(label)) problems.push(`label "${label}" is a raw property key`);
    if (/^value$/i.test(label)) {
      problems.push(layer.card?.measure ? `"Value" stands where the layer names its measure ("${layer.card.measure.label}")` : `"Value ${row.value}" does not say what is measured`);
    }
    const bareNumber = /^-?[\d,.]+$/.test(row.value) && label.toLowerCase() === row.key.toLowerCase();
    if (/^[a-z]{1,2}\d?$/i.test(label) && !SHORT_WORDS.has(label.toLowerCase()) && !row.help && !bareNumber) problems.push(`label "${label}" is a raw property key`);
    if (LETTER_TAIL.test(label)) problems.push(`label "${label}" is a raw property key`);
    if (IDENTIFIER_LABEL.test(label) && /^\d{1,3}(,\d{3})+$/.test(row.value.trim())) problems.push(`"${label} ${row.value}" prints an identifier or year with a thousands comma`);
    if (CODE_LABEL.test(label) && /^-?\d+$/.test(row.value.trim()) && !row.help) problems.push(`"${label} ${row.value}" is a numeric code with no meaning given`);
    if (/https?:\/\/\S+/.test(row.value)) problems.push(`"${label}" shows a bare URL as text`);
    if (/\b(score|index|rank)\b/i.test(label) && /\d/.test(row.value) && !row.help) problems.push(`"${label} ${row.value}" has no help explaining the number`);
    if (/^[a-z][a-z0-9]*(?:[+|][a-z0-9]+)+$/.test(row.value.trim())) problems.push(`"${label}" shows a raw code ("${row.value}")`);
    if (
      /^[A-Za-z]+$/.test(label) &&
      label.toLowerCase() === row.key.toLowerCase() &&
      !PLAIN_NUMBER_KEYS.has(row.key.toLowerCase()) &&
      /^-?[\d,.]+$/.test(row.value) &&
      !row.help
    ) {
      problems.push(`"${label} ${row.value}" is a bare number under its raw key`);
    }
  }
  // A part larger than its whole ("Length in view 50.1 km" over "Full length 48.1 km").
  const amount = (value: string) => {
    const m = /^(-?[\d,]*\.?\d+)\s*(.*)$/.exec(value.trim());
    return m ? { n: Number(m[1].replace(/,/g, "")), unit: m[2].trim() } : null;
  };
  const parts = rows.filter(({ row }) => PART_LABEL.test(row.label));
  const wholes = rows.filter(({ row }) => WHOLE_LABEL.test(row.label));
  for (const { row: part } of parts) {
    for (const { row: whole } of wholes) {
      const a = amount(part.value);
      const b = amount(whole.value);
      if (a && b && a.unit === b.unit && a.n > b.n) problems.push(`"${part.label} ${part.value}" is more than "${whole.label} ${whole.value}"`);
    }
  }
  // Rows that say nothing ("n/a", "Not Available", "Unknown", "None"): never a fact on the card, and never most rows.
  const empty = rows.filter(({ row }) => isEmptyValue(row.value));
  if (rows.length >= 2 && empty.length > rows.length / 2) problems.push(`${empty.length} of ${rows.length} rows say nothing ("${empty[0].row.value}")`);
  for (const { section, row } of empty) if (section === "fact" || section === "measure") problems.push(`"${row.label}: ${row.value}" is a row that says nothing`);
  return problems;
}

/** The card's rows for one feature, built by the card's own row builder (lib/render/card.ts), with their sections. */
export function cardRows(feature: Feature, layer: LayerInfo): SectionRow[] {
  const content = cardContent(feature, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp });
  return [
    ...(content.measure ? [{ section: "measure" as const, row: content.measure }] : []),
    ...content.facts.map((row) => ({ section: "fact" as const, row })),
    ...content.details.map((row) => ({ section: "detail" as const, row })),
    ...content.signals.map((row) => ({ section: "signal" as const, row })),
  ];
}

/** What is wrong with a card or Rank by title: written in capitals ("PIO XI", "JORGE MONTT") when it is not an acronym. */
export function titleProblems(name: string | null): string[] {
  if (name === null || !isAllCaps(name) || isAcronymName(name)) return [];
  return [`the title "${name}" is in capitals`];
}

/**
 * What is wrong between a Rank by row and the card a click on its place opens: a different value under the ranked key
 * (the list gave PIO XI's 2001 outline, 1,377.51 km², while its card showed the 2016 one, 1,245.46 km²).
 */
export function rankedValueProblems(row: Feature, card: Feature, key: string): string[] {
  const a = row.properties?.[key];
  const b = card.properties?.[key];
  if (typeof a !== "number" || typeof b !== "number" || a === b) return [];
  return [`the Rank by list gives ${a.toLocaleString("en-US")} but its card shows ${b.toLocaleString("en-US")}`];
}

/** Lower-case-first names that are not code: brands the notes may name. */
const CAMEL_WORDS = new Set(["iNaturalist", "eBird", "iOS", "iPhone", "iPad", "eDNA"]);

/**
 * What is wrong with a coverage note the user reads (the layer panel and the card show it): a quoted code value ("kind
 * '2021'"), a snake_case or camelCase identifier ("pctFull", "max_scale"), or null/undefined/NaN. Notes are plain
 * sentences: "Two outlines: the 2021 boundary and the current BLM boundary".
 */
export function noteProblems(note: string): string[] {
  const problems: string[] = [];
  const quoted = /(^|[\s(=:])['"`]([a-z0-9][A-Za-z0-9_.\-]*)['"`](?=$|[\s),.;:])/.exec(note);
  if (quoted) problems.push(`the note quotes the code value ${quoted[0].trim()}`);
  const snake = /\b[a-z0-9]+_[a-z0-9_]+\b/.exec(note);
  if (snake) problems.push(`the note names the field "${snake[0]}"`);
  const camel = note.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)?.find((w) => !CAMEL_WORDS.has(w));
  if (camel) problems.push(`the note names the field "${camel}"`);
  const empty = /\b(null|undefined|NaN)\b/.exec(note);
  if (empty) problems.push(`the note says "${empty[0]}"`);
  return problems;
}

/** January 1 written as a day ("Jan 1, 1963"). */
const JAN_1_TEXT = /\bJan 1, (\d{4})\b/;

/**
 * What is wrong with a card's dates: "Jan 1, 1963" (the chip or a row) for a date known only to the year, which the
 * feature gives elsewhere (a dam's yearCompleted 1963) or which every dated feature of the layer shares (`yearsOnly`).
 */
export function dateProblems(feature: Feature, layer: Pick<LayerInfo, "card" | "fieldHelp" | "style">, yearsOnly: boolean): string[] {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const chip = summarizeFeature(feature, layer.style.unit).date;
  const texts = [...(chip ? [chip] : []), ...cardRows(feature, layer as LayerInfo).map(({ row }) => row.value)];
  const problems: string[] = [];
  for (const text of texts) {
    const m = JAN_1_TEXT.exec(text);
    if (!m) continue;
    const named = Object.entries(props).some(([k, v]) => k !== "t" && (v === Number(m[1]) || v === m[1]));
    if (named || yearsOnly) problems.push(`"${m[0]}" stands for a year only and should read "${m[1]}"`);
  }
  return problems;
}

/** True when every dated feature is dated January 1 at midnight: dates known only to the year. */
function allJanFirst(features: Feature[]): boolean {
  const dated = features.map((f) => f.properties?.t).filter((t): t is string => typeof t === "string");
  return dated.length > 0 && dated.every((t) => /^\d{4}-01-01(?:[T ]00:00(?::00(?:\.0+)?)?Z?)?$/.test(t));
}

export function checkCards(layers: Drawn[]): CheckResult {
  const failures: string[] = [];
  for (const layer of layers) {
    if (!layer.info) continue;
    const seen = new Map<string, Feature>();
    const yearsOnly = allJanFirst(layer.data.features);
    for (const f of layer.data.features.slice(0, CARD_FEATURES)) {
      for (const p of [...titleProblems(nameOf(f)), ...cardRowProblems(cardRows(f, layer.info), layer.info), ...dateProblems(f, layer.info, yearsOnly)]) {
        if (!seen.has(p)) seen.set(p, f);
      }
    }
    // The Rank by list's names are titles too (each opens its card), and each row's value is the one its card gives.
    const { key, top } = rankedTop(layer.info, layer.op, layer.loaded, layer.data, RANKED_TOP_N);
    for (const f of top) for (const p of titleProblems(nameOf(f))) if (!seen.has(p)) seen.set(p, f);
    if (key) for (const f of top) for (const p of rankedValueProblems(f, cardFeatureOf(f, layer.data), key)) if (!seen.has(p)) seen.set(p, f);
    const notes = [...new Set(layer.notes.flatMap((n) => noteProblems(n).map((p) => `${p} ("${n}")`)))];
    if (notes.length > 0) failures.push(`${layer.label} note: ${notes.slice(0, 3).join("; ")}.`);
    if (seen.size === 0) continue;
    const list = [...seen.entries()];
    failures.push(`${layer.label} card: ${list.slice(0, 4).map(([p, f]) => `${p} (${nameOf(f) ? `"${nameOf(f)}"` : "a feature"})`).join("; ")}${list.length > 4 ? `; and ${list.length - 4} more` : ""}.`);
  }
  return { check: "card", ok: failures.length === 0, failures };
}

/* ---------- 5. Layer ids ---------- */

export function checkLayerIds(state: MapState, lookup: LayerLookup): CheckResult {
  const routes = new Set(Object.keys(state.routes));
  const ids = new Set<string>([
    ...Object.keys(state.layers),
    ...state.renderOps.map((o) => o.layerId),
    ...state.errors.map((e) => e.layerId).filter((id) => id !== ROUTE_ERROR_ID),
  ]);
  const failures = [...ids]
    .map((id) => (id.endsWith("~b") ? id.slice(0, -2) : id))
    // A route the route tool drew is drawn under its own id, not a layer's; so is a layer the combine tool made.
    .filter((id) => !lookup(id) && !routes.has(id) && !isCombinedId(id))
    .map((id) => `The map holds a layer named "${id}", which is not a registered layer (a garbled tool name?).`);
  return { check: "layerIds", ok: failures.length === 0, failures: [...new Set(failures)] };
}

/* ---------- 6. Inside the place ---------- */

/** The place box grown by PLACE_GROW of its size on each side, at least PLACE_MIN_SPAN degrees across. */
export function grownPlace([w, s, e, n]: BBox): BBox {
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hw = Math.max(e - w, PLACE_MIN_SPAN) / 2;
  const hh = Math.max(n - s, PLACE_MIN_SPAN) / 2;
  const gx = hw * (1 + 2 * PLACE_GROW);
  const gy = hh * (1 + 2 * PLACE_GROW);
  return [cx - gx, cy - gy, cx + gx, cy + gy];
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function checkPlace(layers: Drawn[], place: PlaceRef | null): CheckResult {
  const failures: string[] = [];
  if (place) {
    const box = grownPlace(place.bbox);
    for (const layer of layers) {
      const features = layer.data.features;
      // A flow field is read over a box widened around the place (a bay geocoded to a point still needs room to flow).
      if (features.length === 0 || layer.flow) continue;
      const outside = features.filter((f) => {
        const b = bboxOf(f);
        return b !== null && !intersects(b, box);
      });
      const inside = features.length - outside.length;
      if (inside / features.length < PLACE_SHARE) {
        failures.push(
          `${layer.label}: only ${inside} of ${features.length} features are in or near ${place.name} (its box grown by ${PLACE_GROW * 100}%), e.g. ${example(outside[0])} is outside.`,
        );
        continue;
      }
      // The Rank by list names the place's largest, so every entry of it must be in the place, not most of them (Robert
      // Lee Dam, on the Colorado River of Texas, ranked fourth among the Colorado River basin's dams).
      if (!layer.info) continue;
      const { top } = rankedTop(layer.info, layer.op, layer.loaded, layer.data, RANKED_TOP_N);
      const away = top
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => {
          const b = bboxOf(f);
          return b !== null && !intersects(b, box);
        });
      if (away.length > 0) {
        failures.push(
          `${layer.label}: the Rank by top ${top.length} lists ${away.length === 1 ? "a place" : `${away.length} places`} outside ${place.name}: ${away
            .slice(0, 3)
            .map(({ f, i }) => `${example(f)} (row ${i + 1})`)
            .join("; ")}.`,
        );
      }
    }
  }
  return { check: "place", ok: failures.length === 0, failures };
}

/* ---------- All ---------- */

/** Runs every map check on the final map state. `place` is null for a question that names no place. */
export function runMapChecks(state: MapState, opts: { lookup: LayerLookup; place: PlaceRef | null }): CheckResult[] {
  const layers = drawnLayers(state, opts.lookup);
  return [
    checkSurface(layers),
    checkLattice(layers),
    checkDuplicates(layers),
    checkCards(layers),
    checkLayerIds(state, opts.lookup),
    checkPlace(layers, opts.place),
  ];
}

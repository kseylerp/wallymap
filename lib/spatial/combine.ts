import polygonClipping, { type MultiPolygon as ClipMulti } from "polygon-clipping";
import type { Feature, Geometry, Position } from "geojson";
import type { BBox } from "@/layers/types";
import {
  areaGeometry,
  areaKm2,
  bboxOf,
  bboxOfFeatures,
  boxesTouch,
  inArea,
  KM2_TO_ACRES,
  localProjection,
  pathsOf,
  polygonsOf,
  segmentDistance2,
  verticesOf,
} from "./geo";

/**
 * Joins two answered layers into a third (audit R3): the features of A that lie inside or outside B's areas, near B,
 * along B's lines, the parts of A's areas that overlap B's, or the features of A within a drive of a point (B is then
 * the area reachable, lib/spatial/reach.ts). Pure: features in, features out, each keeping A's properties and gaining
 * the join's own numbers (distanceKm, overlapKm2 ...), which the card, the ranking and the note read.
 */

export const COMBINE_OPS = ["within", "outside", "near", "along", "overlap", "drive_time"] as const;
export type CombineOp = (typeof COMBINE_OPS)[number];

export type GeometryKind = "point" | "line" | "polygon";

/** The kind of geometry a layer's features hold (the first one with coordinates decides), or null when empty. */
export function geometryKind(features: Feature[]): GeometryKind | null {
  for (const f of features) {
    const t = f.geometry?.type;
    if (t === "Point" || t === "MultiPoint") return "point";
    if (t === "LineString" || t === "MultiLineString") return "line";
    if (t === "Polygon" || t === "MultiPolygon") return "polygon";
  }
  return null;
}

/** Totals over the kept features, for the note: areas in km² and acres, and A's own total for the share. */
export type CombineTotals = {
  /** Area of A inside B (within, overlap, drive_time on areas) or outside it (outside), km². */
  areaKm2?: number;
  areaAcres?: number;
  /** A's whole area, km², so the share means "of all of A". */
  ofAreaKm2?: number;
  /** areaKm2 / ofAreaKm2, 0 to 1. */
  share?: number;
  /** Nearest and farthest distance of a kept feature (near, along), km. */
  minDistanceKm?: number;
  maxDistanceKm?: number;
};

export type CombineOutcome = {
  features: Feature[];
  /** Features of A kept. */
  count: number;
  /** Features of A considered. */
  of: number;
  totals: CombineTotals;
  /** Features whose geometry could not be clipped (broken rings from the source); left out and counted. */
  skipped: number;
};

export type CombineParams = {
  op: CombineOp;
  a: Feature[];
  b: Feature[];
  /** near and along: the distance in metres. */
  distanceM?: number;
};

/** A distance or an error when the op cannot run on these two layers' geometries. */
export function combineProblem(op: CombineOp, aKind: GeometryKind | null, bKind: GeometryKind | null): string | null {
  if (aKind === null) return "The first layer returned no features to combine.";
  if (bKind === null) return op === "drive_time" ? "No area could be reached by road from that point." : "The second layer returned no features to combine with.";
  if ((op === "within" || op === "outside" || op === "drive_time") && bKind !== "polygon") {
    return `"${op}" needs areas as the second layer (parks, forests, habitat); for points or lines use near or along.`;
  }
  if (op === "overlap" && (aKind !== "polygon" || bKind !== "polygon")) {
    return "overlap needs areas in both layers; for points or lines in an area use within.";
  }
  if (op === "along" && bKind !== "line") return "along needs a line as the second layer (a trail, road or river); use near for points or areas.";
  return null;
}

/** Names B's features by, for "nearest" and "overlapWith": its name, else its kind, else the layer's word. */
function nameOf(f: Feature): string | undefined {
  const p = f.properties ?? {};
  for (const key of ["name", "title", "heading", "unitName", "kind"]) if (typeof p[key] === "string" && p[key]) return p[key] as string;
  return undefined;
}

function round(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/* ---------- near and along: a grid of B's segments and points ---------- */

type Index = {
  cell: number;
  cells: Map<string, { ax: number; ay: number; bx: number; by: number; f: number }[]>;
  areas: { box: BBox; f: Feature; i: number }[];
};

function buildIndex(b: Feature[], proj: ReturnType<typeof localProjection>, cell: number): Index {
  const cells: Index["cells"] = new Map();
  const add = (ax: number, ay: number, bx: number, by: number, f: number) => {
    const x0 = Math.floor(Math.min(ax, bx) / cell);
    const x1 = Math.floor(Math.max(ax, bx) / cell);
    const y0 = Math.floor(Math.min(ay, by) / cell);
    const y1 = Math.floor(Math.max(ay, by) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push({ ax, ay, bx, by, f });
      }
    }
  };
  const areas: Index["areas"] = [];
  b.forEach((f, i) => {
    const g = f.geometry;
    if (!g) return;
    if (g.type === "Point" || g.type === "MultiPoint") {
      for (const [lon, lat] of verticesOf(g)) add(proj.x(lon), proj.y(lat), proj.x(lon), proj.y(lat), i);
      return;
    }
    for (const path of pathsOf(g)) {
      for (let k = 1; k < path.length; k++) add(proj.x(path[k - 1][0]), proj.y(path[k - 1][1]), proj.x(path[k][0]), proj.y(path[k][1]), i);
      if (path.length === 1) add(proj.x(path[0][0]), proj.y(path[0][1]), proj.x(path[0][0]), proj.y(path[0][1]), i);
    }
    if (polygonsOf(g).length > 0) {
      const box = bboxOf(g);
      if (box) areas.push({ box, f, i });
    }
  });
  return { cell, cells, areas };
}

/** The nearest B feature to a point within `max` metres: its index and the distance, or null. */
function nearest(index: Index, p: Position, proj: ReturnType<typeof localProjection>, max: number): { f: number; d: number } | null {
  // Inside one of B's areas is distance 0.
  for (const a of index.areas) {
    if (p[0] >= a.box[0] && p[0] <= a.box[2] && p[1] >= a.box[1] && p[1] <= a.box[3] && inArea(p, a.f.geometry)) return { f: a.i, d: 0 };
  }
  const px = proj.x(p[0]);
  const py = proj.y(p[1]);
  const reach = Math.ceil(max / index.cell);
  const cx = Math.floor(px / index.cell);
  const cy = Math.floor(py / index.cell);
  let best: { f: number; d2: number } | null = null;
  for (let x = cx - reach; x <= cx + reach; x++) {
    for (let y = cy - reach; y <= cy + reach; y++) {
      const list = index.cells.get(`${x},${y}`);
      if (!list) continue;
      for (const s of list) {
        const d2 = segmentDistance2(px, py, s.ax, s.ay, s.bx, s.by);
        if (best === null || d2 < best.d2) best = { f: s.f, d2 };
      }
    }
  }
  if (best === null) return null;
  const d = Math.sqrt(best.d2);
  return d <= max ? { f: best.f, d } : null;
}

function nearOrAlong(a: Feature[], b: Feature[], distanceM: number): CombineOutcome {
  const box = bboxOfFeatures([...a, ...b]);
  const proj = localProjection(box ? (box[1] + box[3]) / 2 : 0);
  // Cells about the distance across, but never so small that a long segment fills thousands of them.
  const index = buildIndex(b, proj, Math.max(distanceM, 250));
  const kept: Feature[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const f of a) {
    let best: { f: number; d: number } | null = null;
    for (const v of verticesOf(f.geometry)) {
      const hit = nearest(index, v, proj, distanceM);
      if (hit && (best === null || hit.d < best.d)) best = hit;
      if (best?.d === 0) break;
    }
    if (!best) continue;
    const km = round(best.d / 1000, 2);
    min = Math.min(min, km);
    max = Math.max(max, km);
    const other = nameOf(b[best.f]);
    kept.push({ ...f, properties: { ...f.properties, distanceKm: km, ...(other && { nearest: other }) } });
  }
  kept.sort((x, y) => (x.properties?.distanceKm as number) - (y.properties?.distanceKm as number));
  return {
    features: kept,
    count: kept.length,
    of: a.length,
    totals: kept.length > 0 ? { minDistanceKm: min, maxDistanceKm: max } : {},
    skipped: 0,
  };
}

/* ---------- within, outside, overlap: points and lines by position, areas by clipping ---------- */

function clipGeom(g: Geometry): ClipMulti {
  return polygonsOf(g) as unknown as ClipMulti;
}

/** Share of a line's vertices inside B's areas (the candidates near it). */
function lineShareInside(g: Geometry, candidates: Feature[]): number {
  const vs = verticesOf(g);
  if (vs.length === 0) return 0;
  const inside = vs.filter((v) => candidates.some((c) => inArea(v, c.geometry))).length;
  return inside / vs.length;
}

function areaJoin(op: "within" | "outside" | "overlap", a: Feature[], b: Feature[]): CombineOutcome {
  const bBoxes = b.map((f) => ({ f, box: bboxOf(f.geometry) })).filter((x): x is { f: Feature; box: BBox } => x.box !== null);
  const kept: Feature[] = [];
  let skipped = 0;
  let inKm2 = 0;
  let ofKm2 = 0;
  for (const f of a) {
    if (!f.geometry) continue;
    const box = bboxOf(f.geometry);
    if (!box) continue;
    const candidates = bBoxes.filter((x) => boxesTouch(box, x.box)).map((x) => x.f);
    const kind = geometryKind([f]);
    if (kind === "point") {
      const p = verticesOf(f.geometry)[0];
      const hit = candidates.find((c) => inArea(p, c.geometry));
      const inside = hit !== undefined;
      if (inside === (op !== "outside")) {
        const other = hit && nameOf(hit);
        kept.push({ ...f, properties: { ...f.properties, ...(other && { inside: other }) } });
      }
      continue;
    }
    if (kind === "line") {
      const share = lineShareInside(f.geometry, candidates);
      if (op === "outside" ? share < 0.5 : share >= 0.5) kept.push({ ...f, properties: { ...f.properties, shareInside: round(share, 2) } });
      continue;
    }
    // Areas: clip against the B areas that touch it.
    const whole = areaKm2(f.geometry);
    ofKm2 += whole;
    try {
      if (candidates.length === 0) {
        if (op === "outside") {
          inKm2 += whole;
          kept.push({ ...f, properties: { ...f.properties, outsideKm2: round(whole, 3), outsideAcres: Math.round(whole * KM2_TO_ACRES), outsideShare: 1 } });
        }
        continue;
      }
      const others = polygonClipping.union(clipGeom(candidates[0].geometry!), ...candidates.slice(1).map((c) => clipGeom(c.geometry!)));
      const piece =
        op === "outside" ? polygonClipping.difference(clipGeom(f.geometry), others) : polygonClipping.intersection(clipGeom(f.geometry), others);
      const geometry = areaGeometry(piece as unknown as Position[][][]);
      if (!geometry) continue;
      const km2 = areaKm2(geometry);
      if (km2 <= 0) continue;
      inKm2 += km2;
      const share = whole > 0 ? round(Math.min(1, km2 / whole), 3) : 0;
      const props =
        op === "outside"
          ? { outsideKm2: round(km2, 3), outsideAcres: Math.round(km2 * KM2_TO_ACRES), outsideShare: share }
          : {
              overlapKm2: round(km2, 3),
              overlapAcres: Math.round(km2 * KM2_TO_ACRES),
              overlapShare: share,
              overlapWith: [...new Set(candidates.filter((c) => sharesGround(geometry, c)).map(nameOf).filter(Boolean))].slice(0, 5).join(" · "),
            };
      if ("overlapWith" in props && props.overlapWith === "") delete (props as { overlapWith?: string }).overlapWith;
      kept.push({ ...f, geometry, properties: { ...f.properties, ...props } });
    } catch {
      skipped += 1;
    }
  }
  const areaKey = op === "outside" ? "outsideKm2" : "overlapKm2";
  if (kept.some((f) => typeof f.properties?.[areaKey] === "number")) {
    kept.sort((x, y) => ((y.properties?.[areaKey] as number) ?? 0) - ((x.properties?.[areaKey] as number) ?? 0));
  }
  const totals: CombineTotals =
    ofKm2 > 0 ? { areaKm2: round(inKm2, 2), areaAcres: Math.round(inKm2 * KM2_TO_ACRES), ofAreaKm2: round(ofKm2, 2), share: round(inKm2 / ofKm2, 3) } : {};
  return { features: kept, count: kept.length, of: a.length, totals, skipped };
}

/** True when B's area `c` really shares ground with the clipped piece (a vertex of either lies in the other). */
function sharesGround(piece: Geometry, c: Feature): boolean {
  return verticesOf(piece).some((v) => inArea(v, c.geometry)) || verticesOf(c.geometry).some((v) => inArea(v, piece));
}

/** Runs one join. Assumes combineProblem passed for these geometries. */
export function combineFeatures({ op, a, b, distanceM = 1000 }: CombineParams): CombineOutcome {
  if (op === "near" || op === "along") return nearOrAlong(a, b, distanceM);
  if (op === "drive_time") return areaJoin("within", a, b);
  return areaJoin(op, a, b);
}

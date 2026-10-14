import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * Compare over time (spec §7), pure core. Splits one layer's features into two time windows (A and B), then
 * classifies each feature as only in A, only in B, or in both. Classes are categories, not colors: the renderer
 * maps them to ink / white / gray (monochrome). Nothing here mutates its inputs.
 */

export type CompareMode = "swipe" | "toggle" | "delta";
/**
 * `a` and `b` are inclusive ISO windows `[start, end]`; date-only strings cover the whole UTC day. With `by`, the sides
 * are two versions of the same features named by a property instead (monument boundaries: `kind` 2021 against
 * current), and the windows are not used.
 */
export type CompareSpec = { layerId: string; a: [string, string]; b: [string, string]; mode: CompareMode; by?: CompareBy };

/** A compare by version: features whose `key` is one of `a` are side A, one of `b` side B; without the key, both. */
export type CompareBy = { key: string; a: string[]; b: string[] };
export type DeltaClass = "a-only" | "b-only" | "both";

type Props = Record<string, unknown>;

function propsOf(f: Feature): Props {
  return (f.properties ?? {}) as Props;
}

function present(x: unknown): x is string | number {
  return (typeof x === "string" && x !== "") || (typeof x === "number" && Number.isFinite(x));
}

function numeric(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function collectPositions(g: Geometry | null | undefined, out: Position[]): void {
  if (!g) return;
  if (g.type === "GeometryCollection") {
    for (const sub of g.geometries) collectPositions(sub, out);
    return;
  }
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") out.push(c as Position);
    else for (const sub of c) walk(sub);
  };
  walk(g.coordinates);
}

/** FNV-1a, 32-bit, as 8 hex chars. Stable across runs and platforms. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Identity of a feature across two time windows: osmId, then h3, then id, siteId, `name|year`, and finally a
 * stable hash of the rounded geometry (first coordinate to 4 decimals + geometry type + bbox).
 */
export function featureKey(f: Feature): string {
  const p = propsOf(f);
  if (present(p.osmId)) return String(p.osmId);
  if (present(p.h3)) return String(p.h3);
  if (present(p.id)) return String(p.id);
  if (present(f.id)) return String(f.id);
  if (present(p.siteId)) return String(p.siteId);
  if (present(p.name) && present(p.year)) return `${p.name}|${p.year}`;
  const pts: Position[] = [];
  collectPositions(f.geometry, pts);
  if (pts.length === 0) return `geo:${fnv1a(`${f.geometry?.type ?? "null"}|empty`)}`;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const first = pts[0];
  const sig = [
    f.geometry.type,
    round4(first[0]),
    round4(first[1]),
    round4(minX),
    round4(minY),
    round4(maxX),
    round4(maxY),
  ].join("|");
  return `geo:${fnv1a(sig)}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseBound(s: string, end: boolean): number {
  if (DATE_ONLY.test(s)) return Date.parse(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Date.parse(s);
}

function inWindow(t: number, w: [string, string]): boolean {
  const lo = parseBound(w[0], false);
  const hi = parseBound(w[1], true);
  return t >= lo && t <= hi;
}

/**
 * Features whose `t` falls inside each window (inclusive; a date-only end covers its whole UTC day). Features
 * with no usable `t` belong to both windows. Returns new collections; features are shared, not cloned.
 */
export function splitWindows(fc: FeatureCollection, spec: CompareSpec): { a: FeatureCollection; b: FeatureCollection } {
  if (spec.by) return splitVersions(fc, spec.by);
  const a: Feature[] = [];
  const b: Feature[] = [];
  for (const f of fc.features) {
    const raw = propsOf(f).t;
    const t = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (Number.isNaN(t)) {
      a.push(f);
      b.push(f);
      continue;
    }
    if (inWindow(t, spec.a)) a.push(f);
    if (inWindow(t, spec.b)) b.push(f);
  }
  return { a: { type: "FeatureCollection", features: a }, b: { type: "FeatureCollection", features: b } };
}

/** Features by version (`CompareBy`): side A has the `a` values, side B the `b` values; features without the key go to both. */
export function splitVersions(fc: FeatureCollection, by: CompareBy): { a: FeatureCollection; b: FeatureCollection } {
  const a: Feature[] = [];
  const b: Feature[] = [];
  for (const f of fc.features) {
    const raw = propsOf(f)[by.key];
    const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
    if (value === undefined) {
      a.push(f);
      b.push(f);
      continue;
    }
    if (by.a.includes(value)) a.push(f);
    if (by.b.includes(value)) b.push(f);
  }
  return { a: { type: "FeatureCollection", features: a }, b: { type: "FeatureCollection", features: b } };
}

function withProps(f: Feature, extra: Props, geometry?: Geometry): Feature {
  return { ...f, geometry: geometry === undefined ? f.geometry : geometry, properties: { ...(f.properties ?? {}), ...extra } };
}

function indexByKey(fc: FeatureCollection): Map<string, Feature> {
  const m = new Map<string, Feature>();
  for (const f of fc.features) {
    const k = featureKey(f);
    if (!m.has(k)) m.set(k, f);
  }
  return m;
}

/**
 * Classify features by presence in A and B. Order: a-only, both, b-only. For "both" the geometry and properties
 * come from B, and a numeric `v` in both adds `dv = vB - vA`. Duplicate keys within one side keep the first.
 */
export function deltaFeatures(a: FeatureCollection, b: FeatureCollection): FeatureCollection {
  const ia = indexByKey(a);
  const ib = indexByKey(b);
  const aOnly: Feature[] = [];
  const both: Feature[] = [];
  const bOnly: Feature[] = [];
  for (const [k, fa] of ia) {
    const fb = ib.get(k);
    if (!fb) {
      aOnly.push(withProps(fa, { delta: "a-only" satisfies DeltaClass }));
      continue;
    }
    const extra: Props = { delta: "both" satisfies DeltaClass };
    const va = numeric(propsOf(fa).v);
    const vb = numeric(propsOf(fb).v);
    if (va !== undefined && vb !== undefined) extra.dv = vb - va;
    both.push(withProps(fb, extra, fb.geometry ?? fa.geometry));
  }
  for (const [k, fb] of ib) {
    if (!ia.has(k)) bOnly.push(withProps(fb, { delta: "b-only" satisfies DeltaClass }));
  }
  return { type: "FeatureCollection", features: [...aOnly, ...both, ...bOnly] };
}

type Cell = { geomA?: Geometry | null; geomB?: Geometry | null; propsA?: Props; propsB?: Props; nA: number; nB: number; sumA: number; sumB: number; hasV: boolean };

/**
 * One feature per H3 cell (features without `h3` are ignored). `v` is countB - countA, or the sum of `v` in B
 * minus the sum in A when any feature carries a numeric `v`. `delta` is the sign class: "b-only" when the cell
 * grew (v > 0), "a-only" when it shrank (v < 0), "both" when unchanged. Also sets `vA` and `vB`.
 */
export function hexDelta(a: FeatureCollection, b: FeatureCollection): FeatureCollection {
  const cells = new Map<string, Cell>();
  const cell = (k: string): Cell => {
    let c = cells.get(k);
    if (!c) {
      c = { nA: 0, nB: 0, sumA: 0, sumB: 0, hasV: false };
      cells.set(k, c);
    }
    return c;
  };
  const add = (fc: FeatureCollection, side: "A" | "B"): void => {
    for (const f of fc.features) {
      const h = propsOf(f).h3;
      if (!present(h)) continue;
      const c = cell(String(h));
      const v = numeric(propsOf(f).v);
      if (v !== undefined) c.hasV = true;
      if (side === "A") {
        c.nA += 1;
        c.sumA += v ?? 0;
        c.geomA ??= f.geometry;
        c.propsA ??= propsOf(f);
      } else {
        c.nB += 1;
        c.sumB += v ?? 0;
        c.geomB ??= f.geometry;
        c.propsB ??= propsOf(f);
      }
    }
  };
  add(a, "A");
  add(b, "B");
  const features: Feature[] = [];
  for (const [h, c] of cells) {
    const vA = c.hasV ? c.sumA : c.nA;
    const vB = c.hasV ? c.sumB : c.nB;
    const v = vB - vA;
    const cls: DeltaClass = v > 0 ? "b-only" : v < 0 ? "a-only" : "both";
    features.push({
      type: "Feature",
      id: h,
      geometry: (c.geomB ?? c.geomA ?? null) as Geometry,
      properties: { ...(c.propsB ?? c.propsA ?? {}), h3: h, v, vA, vB, delta: cls },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Counts per class, plus the mean `dv` over features that have one (omitted when none do). */
export function compareSummary(delta: FeatureCollection): { aOnly: number; bOnly: number; both: number; dvMean?: number } {
  let aOnly = 0, bOnly = 0, both = 0, n = 0, sum = 0;
  for (const f of delta.features) {
    const p = propsOf(f);
    if (p.delta === "a-only") aOnly++;
    else if (p.delta === "b-only") bOnly++;
    else if (p.delta === "both") both++;
    const dv = numeric(p.dv);
    if (dv !== undefined) {
      n++;
      sum += dv;
    }
  }
  return n > 0 ? { aOnly, bOnly, both, dvMean: sum / n } : { aOnly, bOnly, both };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(today: Date, n: number): string {
  return isoDay(new Date(today.getTime() - n * 86_400_000));
}

/** Canned windows for the three headline questions. Dates are UTC days. */
export function presetFor(question: "forest-loss" | "night-lights" | "fire-perimeters", today: Date): CompareSpec {
  switch (question) {
    case "forest-loss":
      return { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta" };
    case "night-lights": {
      const d = daysAgo(today, 3);
      return { layerId: "night-lights", a: ["2020-01-01", "2020-01-01"], b: [d, d], mode: "toggle" };
    }
    case "fire-perimeters":
      return { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"], b: ["2021-01-01", isoDay(today)], mode: "delta" };
  }
}

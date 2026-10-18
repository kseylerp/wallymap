import { LineLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import type { FlowField } from "@/layers/types";
import { channelExtent, colorT, encodeColor } from "@/lib/render/encode";
import { layerFrames, seriesOf, valueAt } from "@/lib/render/series";
import type { LoadedLayer, MapState } from "@/lib/render/state";

/**
 * Flow fields as moving particles (spec §13a, after mapped.earth's Cook Inlet currents): particles drift through a
 * gridded vector field (ocean currents, wind), each drawn as a short streak from where it was a few frames ago to where
 * it is, colored by the field's second variable on the sage → pink → purple ramp and brighter (more opaque) the faster
 * it moves. The field is the layer's grid at the playhead, interpolated between its hourly frames; particles move
 * across the screen at a pace relative to the field's own fast currents (about PIXELS_PER_FRAME for its 90th percentile
 * speed), live PARTICLE_LIFE frames, and are born again at a random place in view where the field has values. Up to
 * MAX_PARTICLES, about one per PIXELS_PER_PARTICLE square pixels of the field on screen. Pure TypeScript on typed
 * arrays, one deck LineLayer with binary attributes, so 20,000 particles cost a few milliseconds a frame.
 */

export const MAX_PARTICLES = 20_000;
export const MIN_PARTICLES = 1_500;
const PIXELS_PER_PARTICLE = 55;
/** How far a particle at the field's 90th percentile speed moves per animation frame, in screen pixels. */
const PIXELS_PER_FRAME = 1.1;
/** Frames of history a streak spans (its tail is where the particle was this many frames ago). */
export const TRAIL = 7;
/** Frames a particle lives, give or take a third. */
const PARTICLE_LIFE = 90;
const STREAK_PX = 1.8;
/**
 * Opacity of the slowest and the fastest streaks (brightness is speed, by the square root of the share of the field's
 * fast speed). The slow end stays readable on satellite imagery: at 0.25 a calm valley's streaks vanished into it.
 */
const ALPHA = { slow: 0.45, fast: 1 } as const;

/** The field at one moment: per node, u and v (m/s), the color share (or -1), and whether it has a value. */
export type FieldSnapshot = {
  nx: number;
  ny: number;
  bbox: [number, number, number, number];
  u: Float32Array;
  v: Float32Array;
  t: Float32Array;
  ok: Uint8Array;
  /** The 90th percentile speed, the pace particles move at. */
  fast: number;
  /** Where water is (currents), finer than the grid; particles die elsewhere. */
  water?: { nx: number; ny: number; bits: Uint8Array; bbox: [number, number, number, number] };
};

const maskMemo = new WeakMap<object, Uint8Array>();
function maskBits(water: NonNullable<FlowField["water"]>): Uint8Array {
  let bits = maskMemo.get(water);
  if (!bits) {
    const raw = atob(water.bits);
    bits = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    maskMemo.set(water, bits);
  }
  return bits;
}

/** True when the mask says water at a point (no mask: true). */
function isWater(field: FieldSnapshot, lng: number, lat: number): boolean {
  const m = field.water;
  if (!m) return true;
  const [w, s, e, n] = m.bbox;
  const i = Math.floor(((lng - w) / (e - w)) * m.nx);
  const j = Math.floor(((lat - s) / (n - s)) * m.ny);
  if (i < 0 || j < 0 || i >= m.nx || j >= m.ny) return false;
  const k = j * m.nx + i;
  return (m.bits[k >> 3] & (1 << (k & 7))) !== 0;
}

/** The field of a flow layer at fractional frame `at` (in the layer's own series frames), or null without data. */
export function fieldAt(layer: LoadedLayer, at: number): FieldSnapshot | null {
  if (layer.result.kind !== "geojson" || !layer.result.flow) return null;
  const flow: FlowField = layer.result.flow;
  const n = flow.nx * flow.ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const t = new Float32Array(n).fill(-1);
  const ok = new Uint8Array(n);
  const colorExtent = flow.color ? channelExtent(layer.result.data, flow.color, true) : null;
  const speeds: number[] = [];
  layer.result.data.features.forEach((f, k) => {
    const node = typeof f.properties?.node === "number" ? f.properties.node : k;
    if (node < 0 || node >= n) return;
    const su = seriesOf(f, flow.u);
    const sv = seriesOf(f, flow.v);
    const uu = su ? valueAt(su, at) : null;
    const vv = sv ? valueAt(sv, at) : null;
    if (uu === null || vv === null) return;
    u[node] = uu;
    v[node] = vv;
    ok[node] = 1;
    speeds.push(Math.hypot(uu, vv));
    if (flow.color) {
      const sc = seriesOf(f, flow.color);
      const c = sc ? valueAt(sc, at) : null;
      const share = c === null ? null : colorT(c, { extent: colorExtent });
      if (share !== null) t[node] = share;
    }
  });
  if (speeds.length === 0) return null;
  speeds.sort((a, b) => a - b);
  const fast = Math.max(1e-3, speeds[Math.floor(speeds.length * 0.9)] ?? speeds[speeds.length - 1]);
  const water = flow.water ? { nx: flow.water.nx, ny: flow.water.ny, bits: maskBits(flow.water), bbox: flow.bbox } : undefined;
  return { nx: flow.nx, ny: flow.ny, bbox: flow.bbox, u, v, t, ok, fast, ...(water && { water }) };
}

/** The field's u, v and color share at a point, bilinear over the valid corners; null where none is valid. */
export function sampleField(field: FieldSnapshot, lng: number, lat: number): { u: number; v: number; t: number } | null {
  const [w, s, e, n] = field.bbox;
  if (lng < w || lng > e || lat < s || lat > n) return null;
  if (!isWater(field, lng, lat)) return null;
  const fx = ((lng - w) / (e - w)) * (field.nx - 1);
  const fy = ((lat - s) / (n - s)) * (field.ny - 1);
  const i = Math.min(field.nx - 2, Math.max(0, Math.floor(fx)));
  const j = Math.min(field.ny - 2, Math.max(0, Math.floor(fy)));
  const dx = fx - i;
  const dy = fy - j;
  let u = 0;
  let v = 0;
  let t = 0;
  let tw = 0;
  let weight = 0;
  const corners: [number, number, number][] = [
    [i, j, (1 - dx) * (1 - dy)],
    [i + 1, j, dx * (1 - dy)],
    [i, j + 1, (1 - dx) * dy],
    [i + 1, j + 1, dx * dy],
  ];
  for (const [ci, cj, wgt] of corners) {
    const k = cj * field.nx + ci;
    if (!field.ok[k] || wgt <= 0) continue;
    u += field.u[k] * wgt;
    v += field.v[k] * wgt;
    weight += wgt;
    if (field.t[k] >= 0) {
      t += field.t[k] * wgt;
      tw += wgt;
    }
  }
  // Without a water mask, mostly off the field (land under three corners) has no flow; with one, the mask says where water
  // is and the nearest wet nodes carry the flow up the narrow channels the coarse grid cannot resolve.
  if (weight < (field.water ? 0.01 : 0.35)) return null;
  return { u: u / weight, v: v / weight, t: tw > 0 ? t / tw : -1 };
}

/** A small seeded random generator, so a run of the tests (and of the particles) is repeatable. */
function random(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** The screen the particles move in: the map bounds and how many metres one pixel spans. */
export type ParticleView = { bounds: [number, number, number, number]; metersPerPixel: number; widthPx: number; heightPx: number };

/** One flow layer's particles: positions with a short history, ages, and the arrays the streak layer draws from. */
export class ParticleSystem {
  readonly capacity: number;
  count = 0;
  private lng: Float32Array;
  private lat: Float32Array;
  private history: Float32Array;
  private head = 0;
  private age: Uint16Array;
  private life: Uint16Array;
  private shade: Float32Array;
  private speed: Float32Array;
  private rand: () => number;
  readonly source: Float32Array;
  readonly target: Float32Array;
  readonly colors: Uint8Array;
  /** Milliseconds the last step took (advection and the arrays), for the performance check. */
  lastStepMs = 0;

  constructor(capacity = MAX_PARTICLES, seed = 7) {
    this.capacity = capacity;
    this.lng = new Float32Array(capacity);
    this.lat = new Float32Array(capacity);
    this.history = new Float32Array(capacity * TRAIL * 2);
    this.age = new Uint16Array(capacity);
    this.life = new Uint16Array(capacity);
    this.shade = new Float32Array(capacity).fill(-1);
    this.speed = new Float32Array(capacity);
    this.source = new Float32Array(capacity * 2);
    this.target = new Float32Array(capacity * 2);
    this.colors = new Uint8Array(capacity * 4);
    this.rand = random(seed);
  }

  /** How many particles a field wants on this screen: about one per PIXELS_PER_PARTICLE px² of field in view. */
  static wanted(field: Pick<FieldSnapshot, "bbox">, view: ParticleView): number {
    const [w, s, e, n] = field.bbox;
    const [bw, bs, be, bn] = view.bounds;
    const ow = Math.max(0, Math.min(e, be) - Math.max(w, bw));
    const oh = Math.max(0, Math.min(n, bn) - Math.max(s, bs));
    const share = (ow * oh) / Math.max(1e-9, (be - bw) * (bn - bs));
    const px = share * view.widthPx * view.heightPx;
    return Math.round(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, px / PIXELS_PER_PARTICLE)));
  }

  /** A new place for particle `p` inside both the field and the view where the field has a value; false if none was found. */
  private spawn(p: number, field: FieldSnapshot, view: ParticleView): boolean {
    const [w, s, e, n] = field.bbox;
    const [bw, bs, be, bn] = view.bounds;
    const x0 = Math.max(w, bw);
    const x1 = Math.min(e, be);
    const y0 = Math.max(s, bs);
    const y1 = Math.min(n, bn);
    if (x1 <= x0 || y1 <= y0) return false;
    for (let tries = 0; tries < 6; tries++) {
      const lng = x0 + (x1 - x0) * this.rand();
      const lat = y0 + (y1 - y0) * this.rand();
      if (!sampleField(field, lng, lat)) continue;
      this.lng[p] = lng;
      this.lat[p] = lat;
      for (let h = 0; h < TRAIL; h++) {
        this.history[(p * TRAIL + h) * 2] = lng;
        this.history[(p * TRAIL + h) * 2 + 1] = lat;
      }
      this.age[p] = 0;
      this.life[p] = Math.round(PARTICLE_LIFE * (0.67 + 0.66 * this.rand()));
      return true;
    }
    this.age[p] = 0;
    this.life[p] = 4;
    return false;
  }

  /**
   * One animation frame: the wanted number of particles each move with the field (a fixed number of screen pixels for
   * the field's fast speed), age, and are born again when old, off the field or out of view; then the streak arrays
   * are filled. Returns how many particles are drawn.
   */
  step(field: FieldSnapshot, view: ParticleView): number {
    const t0 = performance.now();
    const count = Math.min(this.capacity, ParticleSystem.wanted(field, view));
    for (let p = this.count; p < count; p++) {
      this.spawn(p, field, view);
      // A new crowd starts at mixed ages, so the births spread over time.
      this.age[p] = Math.floor(this.rand() * this.life[p]);
    }
    this.count = count;
    // A particle at the field's fast speed moves PIXELS_PER_FRAME pixels a frame; slower ones by the square root of their
    // share, so a calm valley beside a gale at sea still visibly drifts.
    const metresAtFast = PIXELS_PER_FRAME * view.metersPerPixel;
    const [bw, bs, be, bn] = view.bounds;
    const slot = (this.head + 1) % TRAIL;
    for (let p = 0; p < count; p++) {
      let lng = this.lng[p];
      let lat = this.lat[p];
      const here = sampleField(field, lng, lat);
      const out = lng < bw || lng > be || lat < bs || lat > bn;
      this.age[p] += 1;
      if (!here || out || this.age[p] > this.life[p]) {
        if (!this.spawn(p, field, view)) this.speed[p] = 0;
        continue;
      }
      const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      const speed = Math.hypot(here.u, here.v);
      const metres = speed > 0 ? (metresAtFast * Math.sqrt(Math.min(2, speed / field.fast))) / speed : 0;
      lng += (here.u * metres) / (111_320 * cos);
      lat += (here.v * metres) / 110_540;
      this.lng[p] = lng;
      this.lat[p] = lat;
      this.history[(p * TRAIL + slot) * 2] = lng;
      this.history[(p * TRAIL + slot) * 2 + 1] = lat;
      this.speed[p] = Math.hypot(here.u, here.v);
      this.shade[p] = here.t;
    }
    this.head = slot;
    const tail = (slot + 1) % TRAIL;
    for (let p = 0; p < count; p++) {
      const young = this.age[p] < TRAIL;
      const from = young ? slot : tail;
      this.source[p * 2] = this.history[(p * TRAIL + from) * 2];
      this.source[p * 2 + 1] = this.history[(p * TRAIL + from) * 2 + 1];
      this.target[p * 2] = this.lng[p];
      this.target[p * 2 + 1] = this.lat[p];
      const s = Math.sqrt(Math.min(1, this.speed[p] / field.fast));
      // Fade in after birth and out before death, so streaks do not pop.
      const fade = Math.min(1, this.age[p] / 8, (this.life[p] - this.age[p]) / 8);
      const alpha = Math.max(0, (ALPHA.slow + (ALPHA.fast - ALPHA.slow) * s) * fade);
      // A field with no color variable (wind) is colored by its speed on the same ramp, slow sage to fast purple.
      const [r, g, b] = encodeColor(this.shade[p] >= 0 ? this.shade[p] : s);
      this.colors[p * 4] = r;
      this.colors[p * 4 + 1] = g;
      this.colors[p * 4 + 2] = b;
      this.colors[p * 4 + 3] = Math.round(255 * alpha);
    }
    this.lastStepMs = performance.now() - t0;
    return count;
  }

  /** The streaks as one deck LineLayer over the arrays (a new data object each frame, so deck uploads them). */
  layer(id: string, opacity = 1): Layer {
    return new LineLayer({
      id,
      data: {
        length: this.count,
        attributes: {
          getSourcePosition: { value: this.source, size: 2 },
          getTargetPosition: { value: this.target, size: 2 },
          getColor: { value: this.colors, size: 4, normalized: true },
        },
      },
      getWidth: STREAK_PX,
      widthUnits: "pixels",
      opacity,
      pickable: false,
      parameters: { depthCompare: "always", cullMode: "none" },
    } as ConstructorParameters<typeof LineLayer>[0]);
  }
}

/** The flow layers drawn now: visible ops whose layer is a flow field, top last. */
export function flowLayersOf(state: Pick<MapState, "renderOps" | "layers">): { layer: LoadedLayer; opacity: number }[] {
  return state.renderOps.flatMap((op) => {
    const layer = state.layers[op.layerId];
    if (!op.visible || layer?.result.kind !== "geojson" || !layer.result.flow) return [];
    return [{ layer, opacity: Math.min(1, Math.max(0, op.opacity ?? 1)) }];
  });
}

/** The layer's own frame (fractional) at the scrubber's playhead `frame`, or its newest when there is no scrubber. */
export function flowFrame(layer: LoadedLayer, state: Pick<MapState, "time">, frame: number): number {
  const series = layer.result.kind === "geojson" ? layer.result.series : undefined;
  if (!series) return 0;
  const index = state.time?.index;
  if (!index) return series.now;
  const frames = layerFrames(layer, index.buckets);
  const k = Math.min(frames.length - 1, Math.max(0, Math.floor(frame)));
  if (frames[k] === undefined || frames[k] < 0) return series.now;
  return frames[k] + Math.max(0, Math.min(1, frame - k));
}

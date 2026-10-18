/**
 * River pulse (spec §13, after mapped.earth's "North America's River Pulse"): the river network of a basin or region
 * with each reach's daily discharge for the past months and the forecast days, played day by day. Width is that day's
 * flow; color is the flow against the reach's own median over the period (no water temperature source covers every
 * reach, so this is the "otherwise" of the brief).
 *
 * Everything comes from one file built once a day (scripts/build-river-flow.mts, run by .github/workflows/river-flow.yml
 * and published to the repository's `data` branch): the rivers it covers (Natural Earth 10m rivers and lake centerlines
 * with North America's tributaries, public domain, joined end to end per river and simplified), the points each river is
 * read at (snapped to the GloFAS model cell that carries the river), and each point's daily discharge for the past 92
 * days and 7 forecast days (GloFAS v4 via the Open-Meteo flood API, CC BY 4.0). A visitor costs Open-Meteo nothing: the
 * file is fetched once an hour per server. Only a point whose flow the file lacks (its batch failed that day) is read
 * live, at most MAX_LIVE_POINTS a load, cached for the day.
 *
 * The lines in view are clipped to the box and taken most important first; each run takes the file's points on it and
 * is cut into up to MAX_REACHES reaches of equal length, whose flow is interpolated by distance between the run's points
 * (spec §13 allows modelled or interpolated values, so the network fills in).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type SeriesAxis } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { haversineKm } from "./_shared/geo";
import { layerColor } from "@/lib/render/palette";
import { createCache } from "@/lib/fetch";
import RIVER_PLACES from "@/data/river-places.json";

export const NE_RIVERS_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson";
/** Natural Earth's North America supplement: 4,897 more river lines (tributaries the world file leaves out). */
export const NE_RIVERS_NA_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_north_america.geojson";
export const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
/**
 * The daily file (scripts/build-river-flow.mts), on the `data` branch. raw.githubusercontent.com answers with
 * Access-Control-Allow-Origin: * and Cache-Control: max-age=300, so a new file shows within five minutes.
 */
export const RIVER_FLOW_URL = "https://raw.githubusercontent.com/kseylerp/wallymap/data/river-flow.json";
/** How long a server keeps the file before fetching it again. */
const FILE_TTL_SECONDS = 3600;
/** A file older than this many days is called out in the note. */
export const STALE_DAYS = 2;
/** Most points a load reads; the file costs nothing upstream, so this only bounds the work. */
export const MAX_POINTS = 1200;
/** Most points a load reads live from Open-Meteo, when the file lacks their flow (each costs about 7 calls). */
export const MAX_LIVE_POINTS = 20;
/** One sample per this much river when planning new points, at most MAX_SAMPLES_PER_RUN per run. */
export const SAMPLE_SPACING_KM = 700;
const MAX_SAMPLES_PER_RUN = 3;
/** Most reaches drawn; their flow is interpolated between the samples, so they cost nothing upstream. */
export const MAX_REACHES = 900;
/** The shortest reach drawn. */
export const MIN_REACH_KM = 20;
/** A river run shorter than this inside the box is left out. */
const MIN_RUN_KM = 60;
/** A reach whose median flow is under this (m³/s) sampled only local runoff: no river cell was found near it. */
const MIN_MEDIAN_M3S = 1;

const inputSchema = z.object({
  days: z.number().int().min(14).max(92).default(92).describe("Past days of daily flow, 14 to 92 (default 92, about three months)"),
  forecastDays: z.number().int().min(0).max(7).default(7).describe("Forecast days from today, 0 to 7 (default 7)"),
});

export type NeFeature = Feature<LineString | GeoJSON.MultiLineString, { name?: string | null; name_en?: string | null; scalerank?: number; featurecla?: string }>;

/** One run of a river inside the box: its name and importance, its line and length. */
export type Run = { name: string; rank: number; line: Position[]; km: number };
/** One reach as drawn: its run, its line, and how far along the run its middle lies. */
export type Reach = { id: string; run: number; name: string; line: Position[]; atKm: number; lengthKm: number };
/**
 * One point the flow is read at: its run, how far along it, where, and `cell` when its model cell is already known
 * (snapped ahead of time); without one it is snapped now.
 */
export type Sample = { run: number; atKm: number; at: Position; cell?: Position };

/** A point snapped ahead of time: its river, where on the river, and the model cell that carries the river there. */
export type KnownPoint = { name: string; at: Position; cell: Position };

/** The world file's lines and the supplement's, without the supplement's lines of a river the world file has. */
export function mergeRiverFiles(world: NeFeature[], extra: NeFeature[]): NeFeature[] {
  const named = new Set(world.map((f) => riverName(f).toLowerCase()));
  return [...world, ...extra.filter((f) => !named.has(riverName(f).toLowerCase()))];
}

function riverName(f: NeFeature): string {
  return (f.properties?.name_en || f.properties?.name || "").trim() || "Unnamed river";
}

function inBox([lng, lat]: Position, [w, s, e, n]: BBox): boolean {
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

/** The runs of a line that lie inside the box (consecutive vertices inside), each with at least two points. */
export function clipLine(coords: Position[], bbox: BBox): Position[][] {
  const runs: Position[][] = [];
  let run: Position[] = [];
  for (const p of coords) {
    if (inBox(p, bbox)) run.push([Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]);
    else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function lengthKm(line: Position[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

/** Cuts a line into pieces of about `stepKm` (the last piece joins the one before when it would be under a third). */
export function cutLine(line: Position[], stepKm: number): Position[][] {
  const pieces: Position[][] = [];
  let piece: Position[] = [line[0]];
  let km = 0;
  for (let i = 1; i < line.length; i++) {
    km += haversineKm(line[i - 1], line[i]);
    piece.push(line[i]);
    if (km >= stepKm && i < line.length - 1) {
      pieces.push(piece);
      piece = [line[i]];
      km = 0;
    }
  }
  if (piece.length >= 2) {
    if (pieces.length > 0 && km < stepKm / 3) pieces[pieces.length - 1].push(...piece.slice(1));
    else pieces.push(piece);
  }
  return pieces;
}

/** The point `km` along a line (its last point past the end). */
export function pointAlong(line: Position[], km: number): Position {
  let done = 0;
  for (let i = 1; i < line.length; i++) {
    const d = haversineKm(line[i - 1], line[i]);
    if (done + d >= km) {
      const t = d === 0 ? 0 : (km - done) / d;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    done += d;
  }
  return line[line.length - 1];
}

/** The river runs inside `bbox`, the most important first (Natural Earth scalerank, then length), none under MIN_RUN_KM. */
export function runsIn(lines: NeFeature[], bbox: BBox): Run[] {
  const runs: Run[] = [];
  for (const f of lines) {
    const g = f.geometry;
    const raw = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    const name = riverName(f);
    const rank = Number(f.properties?.scalerank ?? 12);
    for (const line of raw) for (const run of clipLine(line, bbox)) runs.push({ name, rank, line: run, km: lengthKm(run) });
  }
  return joinRuns(runs)
    .filter((r) => r.km >= MIN_RUN_KM)
    .sort((a, b) => a.rank - b.rank || b.km - a.km);
}

/** Two river ends closer than this are one river continuing (Natural Earth breaks rivers at lakes and confluences). */
const JOIN_KM = 2;

/** Runs of one river that meet end to end, joined into one run (each end reversed as needed), so it is read as one river. */
export function joinRuns(runs: Run[]): Run[] {
  const byName = new Map<string, Run[]>();
  for (const r of runs) byName.set(`${r.name}|${r.rank}`, [...(byName.get(`${r.name}|${r.rank}`) ?? []), r]);
  const out: Run[] = [];
  for (const group of byName.values()) {
    const left = group.map((r) => ({ ...r, line: [...r.line] }));
    while (left.length > 0) {
      const cur = left.shift()!;
      let grew = true;
      while (grew) {
        grew = false;
        for (let i = 0; i < left.length; i++) {
          const o = left[i];
          const [a0, a1] = [cur.line[0], cur.line[cur.line.length - 1]];
          const [b0, b1] = [o.line[0], o.line[o.line.length - 1]];
          let joined: Position[] | null = null;
          if (haversineKm(a1, b0) <= JOIN_KM) joined = [...cur.line, ...o.line.slice(1)];
          else if (haversineKm(a1, b1) <= JOIN_KM) joined = [...cur.line, ...[...o.line].reverse().slice(1)];
          else if (haversineKm(a0, b1) <= JOIN_KM) joined = [...o.line, ...cur.line.slice(1)];
          else if (haversineKm(a0, b0) <= JOIN_KM) joined = [...[...o.line].reverse(), ...cur.line.slice(1)];
          if (joined) {
            cur.line = joined;
            cur.km += o.km;
            left.splice(i, 1);
            grew = true;
            break;
          }
        }
      }
      out.push(cur);
    }
  }
  return out;
}

/** Metres from `p` to the segment a→b, on a flat projection at p's latitude (fine within a few kilometres). */
function segmentKm(p: Position, a: Position, b: Position): { km: number; t: number } {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111.32;
  const ax = (a[0] - p[0]) * k;
  const ay = (a[1] - p[1]) * 110.57;
  const bx = (b[0] - p[0]) * k;
  const by = (b[1] - p[1]) * 110.57;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return { km: Math.hypot(ax + t * dx, ay + t * dy), t };
}

/** How far `p` lies from a line (km) and how far along the line its nearest point is (km). */
export function nearestOnLine(line: Position[], p: Position): { km: number; atKm: number } {
  let best = { km: Infinity, atKm: 0 };
  let along = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = haversineKm(line[i - 1], line[i]);
    const { km, t } = segmentKm(p, line[i - 1], line[i]);
    if (km < best.km) best = { km, atKm: along + t * seg };
    along += seg;
  }
  return best;
}

/** A point snapped ahead of time belongs to a run when it names the same river and lies this close to its line. */
const KNOWN_KM = 12;

/**
 * Where the flow is read: runs most important first; a run takes the points snapped ahead of time on it (same river,
 * within KNOWN_KM), else up to MAX_SAMPLES_PER_RUN new points (one per SAMPLE_SPACING_KM) while fewer than `maxNew` new
 * points are planned (the daily build plans new points this way; a map load passes none); a run left without a point is
 * not drawn. At most `maxPoints` in all.
 */
export function planPoints(
  runs: Run[],
  known: readonly KnownPoint[],
  { maxPoints = MAX_POINTS, maxNew = 0 }: { maxPoints?: number; maxNew?: number } = {},
): { runs: Run[]; samples: Sample[] } {
  const byName = new Map<string, KnownPoint[]>();
  for (const k of known) byName.set(k.name.toLowerCase(), [...(byName.get(k.name.toLowerCase()) ?? []), k]);
  const kept: Run[] = [];
  const samples: Sample[] = [];
  let fresh = 0;
  for (const run of runs) {
    if (samples.length >= maxPoints) break;
    const on = (byName.get(run.name.toLowerCase()) ?? [])
      .map((k) => ({ k, near: nearestOnLine(run.line, k.at) }))
      .filter((x) => x.near.km <= KNOWN_KM)
      .slice(0, maxPoints - samples.length);
    if (on.length > 0) {
      const index = kept.length;
      kept.push(run);
      for (const { k, near } of on) samples.push({ run: index, atKm: near.atKm, at: k.at, cell: k.cell });
      continue;
    }
    if (fresh >= maxNew) continue;
    const n = Math.min(maxNew - fresh, maxPoints - samples.length, Math.max(1, Math.min(MAX_SAMPLES_PER_RUN, Math.round(run.km / SAMPLE_SPACING_KM))));
    const index = kept.length;
    kept.push(run);
    for (let k = 0; k < n; k++) {
      const atKm = ((k + 0.5) / n) * run.km;
      samples.push({ run: index, atKm, at: pointAlong(run.line, atKm) });
    }
    fresh += n;
  }
  return { runs: kept, samples };
}

/** Two rivers meet when one's end lies this close to the other's line. */
const MEET_KM = 3;

/**
 * Where each run leaves the network (spec §13: "discharge to the sea, every outlet combined"): its downstream end
 * (the end with more flow; on equal flow the end that meets another river, else the line's last point, as Natural Earth
 * draws rivers toward their mouths) when that end meets no other river, so it reaches the sea, a lake or the edge of the
 * box. Returns, per run, true at 0 km, at its far end, or null when it flows into another river.
 */
export function outletEnds(runs: Run[], flowAt: (run: number, atKm: number) => number | null): ("start" | "end" | null)[] {
  const meets = (p: Position, self: number) => runs.some((r, j) => j !== self && nearestOnLine(r.line, p).km <= MEET_KM);
  return runs.map((run, i) => {
    const a = run.line[0];
    const b = run.line[run.line.length - 1];
    const fa = flowAt(i, 0);
    const fb = flowAt(i, run.km);
    const meetA = meets(a, i);
    const meetB = meets(b, i);
    let down: "start" | "end";
    if (fa !== null && fb !== null && Math.abs(fa - fb) > 0.05 * Math.max(fa, fb)) down = fa > fb ? "start" : "end";
    else if (meetA !== meetB) down = meetA ? "start" : "end";
    else down = "end";
    return (down === "start" ? meetA : meetB) ? null : down;
  });
}

/** The kept runs cut into at most MAX_REACHES reaches of equal length (at least MIN_REACH_KM), each with its middle's distance. */
export function reachesOf(runs: Run[], maxReaches = MAX_REACHES): Reach[] {
  const total = runs.reduce((km, r) => km + r.km, 0);
  const step = Math.max(MIN_REACH_KM, total / maxReaches);
  const reaches: Reach[] = [];
  runs.forEach((run, i) => {
    let along = 0;
    cutLine(run.line, step).forEach((line, j) => {
      const km = lengthKm(line);
      reaches.push({ id: `r${i}-${j}`, run: i, name: run.name, line, atKm: along + km / 2, lengthKm: Math.round(km) });
      along += km;
    });
  });
  return reaches;
}

export const FloodRow = z.object({ daily: z.object({ time: z.array(z.string()), river_discharge: z.array(z.number().nullable()) }) });
export type Flood = { time: string[]; q: (number | null)[] };

/** One flood-API POST for `points` (lon, lat), cached under `key`; null for every point when the call fails. */
async function floodBatch(ctx: QueryContext, points: Position[], days: number, forecastDays: number, key: string, ttlSeconds: number): Promise<(Flood | null)[]> {
  const body = new URLSearchParams({
    latitude: points.map((p) => p[1].toFixed(3)).join(","),
    longitude: points.map((p) => p[0].toFixed(3)).join(","),
    daily: "river_discharge",
    past_days: String(days),
    forecast_days: String(forecastDays),
    timezone: "GMT",
  });
  try {
    const res = await ctx.fetch(FLOOD_API, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      cacheKey: key,
      ttlSeconds,
      timeoutMs: UPSTREAM_TIMEOUT_MS * 2,
    });
    if (!res.ok) return points.map(() => null);
    const json: unknown = await res.json();
    const rows = Array.isArray(json) ? json : [json];
    return points.map((_, i) => {
      const parsed = FloodRow.safeParse(rows[i]);
      return parsed.success ? { time: parsed.data.daily.time, q: parsed.data.daily.river_discharge } : null;
    });
  } catch {
    return points.map(() => null);
  }
}

function hashOf(points: Position[]): string {
  let h = 0;
  for (const p of points) for (const c of p) h = (Math.imul(h, 31) + Math.round(c * 1000)) | 0;
  return (h >>> 0).toString(36);
}

/** Locations per request when reading the months. */
const FLOW_BATCH = 100;

/**
 * Each point's daily flow for the period, from the cache when this point was read today (by any box), else read in
 * batches of FLOW_BATCH and cached until tomorrow. Returns the flows in point order and how many points were read.
 */
async function flowsFor(ctx: QueryContext, points: Position[], days: number, forecastDays: number, day: string): Promise<{ flows: (Flood | null)[]; read: number }> {
  const key = (p: Position) => `river-pulse:q:${day}:${days}:${forecastDays}:${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const flows: (Flood | null)[] = await Promise.all(
    points.map(async (p) => {
      try {
        const hit = await cells.get(key(p));
        const parsed = hit ? (JSON.parse(hit) as Flood) : null;
        return parsed && Array.isArray(parsed.time) && Array.isArray(parsed.q) ? parsed : null;
      } catch {
        return null;
      }
    }),
  );
  const missing = points.map((p, i) => ({ p, i })).filter((x) => flows[x.i] === null);
  const batches: { p: Position; i: number }[][] = [];
  for (let i = 0; i < missing.length; i += FLOW_BATCH) batches.push(missing.slice(i, i + FLOW_BATCH));
  const answers = await inTurns(
    batches.map((b) => () => floodBatch(ctx, b.map((x) => x.p), days, forecastDays, `river-pulse:flow:${day}:${days}:${forecastDays}:${hashOf(b.map((x) => x.p))}`, 86_400)),
    2,
  );
  await Promise.all(
    batches.flatMap((b, k) =>
      b.map(async ({ p, i }, j) => {
        const flow = answers[k][j];
        flows[i] = flow;
        if (flow) await cells.set(key(p), JSON.stringify(flow), 86_400).catch(() => {});
      }),
    ),
  );
  return { flows, read: missing.length };
}
const cells = createCache();

/** Runs `tasks` at most `limit` at a time, in order. */
async function inTurns<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A reach's daily flow: its run's samples interpolated by distance along the run (the nearest one beyond the ends). */
export function interpolateFlow(atKm: number, samples: { atKm: number; q: (number | null)[] }[]): (number | null)[] {
  const sorted = [...samples].sort((a, b) => a.atKm - b.atKm);
  if (sorted.length === 0) return [];
  if (atKm <= sorted[0].atKm) return sorted[0].q;
  const last = sorted[sorted.length - 1];
  if (atKm >= last.atKm) return last.q;
  const k = sorted.findIndex((s) => s.atKm >= atKm);
  const a = sorted[k - 1];
  const b = sorted[k];
  const t = (atKm - a.atKm) / (b.atKm - a.atKm);
  return a.q.map((va, d) => {
    const vb = b.q[d];
    if (va === null) return vb ?? null;
    if (vb === null || vb === undefined) return va;
    return va + (vb - va) * t;
  });
}

/** A reach is named after the nearest town within this distance ("Mississippi near Baton Rouge"), else by its river alone. */
export const NEAR_KM = 80;
type Town = [string, number, number];
const TOWNS = (RIVER_PLACES as unknown as { places: Town[] }).places;
let townGrid: Map<string, Town[]> | null = null;

/** The nearest town of at least 20,000 people (data/river-places.json) within NEAR_KM of `p`, or null. */
export function nearestTown(p: Position, towns: readonly Town[] = TOWNS): string | null {
  let grid = towns === TOWNS ? townGrid : null;
  if (!grid) {
    grid = new Map();
    for (const t of towns) {
      const k = `${Math.floor(t[1])},${Math.floor(t[2])}`;
      grid.set(k, [...(grid.get(k) ?? []), t]);
    }
    if (towns === TOWNS) townGrid = grid;
  }
  let best: { name: string; km: number } | null = null;
  const [x, y] = [Math.floor(p[0]), Math.floor(p[1])];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const t of grid.get(`${x + dx},${y + dy}`) ?? []) {
        const km = haversineKm(p, [t[1], t[2]]);
        if (km <= NEAR_KM && (!best || km < best.km)) best = { name: t[0], km };
      }
    }
  }
  return best?.name ?? null;
}

export const CFS_PER_M3S = 35.3147;

/** Boxes where people read US units first: the lower 48, Alaska and Hawaii (rough; a reach in southern Ontario reads US first). */
const US_UNIT_BOXES: BBox[] = [
  [-125, 24.5, -66.9, 49.1],
  [-170, 51, -141, 71.5],
  [-161, 18.8, -154.7, 22.3],
];

/** True when `p` lies where US units are read first (US_UNIT_BOXES). */
export function usUnitsAt(p: Position): boolean {
  return US_UNIT_BOXES.some((b) => inBox(p, b));
}

/** A modelled number as people write it: three significant figures from 1,000 up, whole numbers from 10, else one decimal. */
function roughly(n: number): string {
  if (n >= 1000) return Number(n.toPrecision(3)).toLocaleString("en-US");
  if (n >= 10) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n * 10) / 10);
}

/** A flow in both units, the reader's first: "23,800 cfs (675 m³/s)" in the US, "675 m³/s (23,800 cfs)" elsewhere. */
export function flowText(m3s: number, us: boolean): string {
  const metric = `${roughly(m3s)} m³/s`;
  const cfs = `${roughly(m3s * CFS_PER_M3S)} cfs`;
  return us ? `${cfs} (${metric})` : `${metric} (${cfs})`;
}

/** A length in both units, the reader's first: "45 mi (72 km)" in the US. */
function lengthText(km: number, us: boolean): string {
  const mi = Math.round(km / 1.609344);
  return us ? `${mi} mi (${km} km)` : `${km} km (${mi} mi)`;
}

/** An outlet end this close to an end of one of the file's whole river lines is where the river really ends. */
const LINE_END_KM = 1;

/**
 * Where each river's figure on the card is read: `mouth` at an outlet where its line really ends (the sea, a lake, or
 * where Natural Earth's line stops), `edge` at an outlet where the view cuts the river, `largest` its largest reach in
 * view when it only flows into another river here.
 */
export type RiverFigure = "mouth" | "edge" | "largest";

/** The card key that holds a river's figure for each kind (each under its own plain label). */
export const FIGURE_KEYS: Record<RiverFigure, string> = { mouth: "atMouth", edge: "atViewEdge", largest: "atLargest" };

/**
 * The reach features with their series (`series.q` flow in m³/s and `series.pct` the flow as a percent of the reach's
 * median over the past days), the plain `q` and `pct` at today's frame, and the period's low and peak with dates. A
 * reach between a run's sample points takes their flow interpolated by distance (`readAt` says so). Each reach also
 * carries its flows as text in both units (`flow`, `medianFlow`, `peakFlow`, `lowFlow`, cfs first in the US) and its
 * river's figure (`riverQ` in m³/s, `riverFigure` its kind, and the text under `atMouth`, `atViewEdge` or `atLargest`,
 * see RiverFigure).
 * `lineEnds` are the ends of the whole river lines the runs were clipped from: an outlet at none of them was cut by the
 * view (without them every outlet counts as a mouth).
 */
export function reachFeatures(
  reaches: Reach[],
  samples: Sample[],
  flows: (Flood | null)[],
  todayIso: string,
  runs?: Run[],
  lineEnds?: Position[],
): { data: FeatureCollection; series: SeriesAxis } | null {
  const times = flows.find((f) => f !== null)?.time;
  if (!times || times.length === 0) return null;
  const today = todayIso.slice(0, 10);
  let now = times.findLastIndex((t) => t <= today);
  if (now < 0) now = 0;
  const byRun = new Map<number, { atKm: number; q: (number | null)[] }[]>();
  samples.forEach((s, i) => {
    const flow = flows[i];
    if (!flow || flow.time.length !== times.length) return;
    byRun.set(s.run, [...(byRun.get(s.run) ?? []), { atKm: s.atKm, q: flow.q }]);
  });
  // The reach at each run's outlet (its downstream end, where it meets no other river) carries `outlet`: their sum is
  // the flow leaving the view, all outlets combined.
  const outletReach = new Map<Reach, "mouth" | "edge">();
  if (runs) {
    const flowAt = (run: number, atKm: number) => {
      const s = byRun.get(run);
      if (!s) return null;
      const vals = interpolateFlow(atKm, s).slice(0, now + 1).filter((v): v is number => typeof v === "number");
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    outletEnds(runs, flowAt).forEach((end, i) => {
      if (!end || !byRun.has(i)) return;
      const target = end === "start" ? 0 : runs[i].km;
      const at = end === "start" ? runs[i].line[0] : runs[i].line[runs[i].line.length - 1];
      const cut = lineEnds !== undefined && !lineEnds.some((e) => haversineKm(e, at) <= LINE_END_KM);
      let best: Reach | undefined;
      for (const r of reaches) if (r.run === i && (!best || Math.abs(r.atKm - target) < Math.abs(best.atKm - target))) best = r;
      if (best) outletReach.set(best, cut ? "edge" : "mouth");
    });
  }
  const headingOf = (reach: Reach) => {
    const town = nearestTown(pointAlong(reach.line, reach.lengthKm / 2));
    return town ? `${reach.name} near ${town}` : reach.name;
  };
  const features: Feature[] = [];
  for (const reach of reaches) {
    const runSamples = byRun.get(reach.run);
    if (!runSamples) continue;
    const raw = interpolateFlow(reach.atKm, runSamples);
    const past = raw.slice(0, now + 1).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const med = median(past);
    if (!(med >= MIN_MEDIAN_M3S)) continue;
    const q = raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? round1(v) : null));
    const pct = q.map((v) => (v === null ? null : Math.round((v / med) * 100)));
    let peak = -1;
    let low = -1;
    q.forEach((v, k) => {
      if (v === null || k > now) return;
      if (peak < 0 || v > (q[peak] ?? -Infinity)) peak = k;
      if (low < 0 || v < (q[low] ?? Infinity)) low = k;
    });
    const read = runSamples.some((s) => Math.abs(s.atKm - reach.atKm) <= reach.lengthKm / 2);
    const us = usUnitsAt(pointAlong(reach.line, reach.lengthKm / 2));
    const text = (m3s: number | null | undefined) => (typeof m3s === "number" ? flowText(m3s, us) : undefined);
    const outlet = outletReach.get(reach);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: reach.line },
      properties: {
        name: reach.name,
        // The card's title: the river and the town this reach passes.
        heading: headingOf(reach),
        // One river is one place: the Rank by list and the summary name it once, by its largest reach.
        project: reach.name,
        reachId: reach.id,
        lengthKm: reach.lengthKm,
        length: lengthText(reach.lengthKm, us),
        q: q[now],
        pct: pct[now],
        medianQ: round1(med),
        ...(peak >= 0 && { peakQ: q[peak], peakDate: times[peak] }),
        ...(low >= 0 && { lowQ: q[low], lowDate: times[low] }),
        ...(text(q[now]) !== undefined && { flow: text(q[now]) }),
        medianFlow: flowText(med, us),
        ...(peak >= 0 && text(q[peak]) !== undefined && { peakFlow: text(q[peak]) }),
        ...(low >= 0 && text(q[low]) !== undefined && { lowFlow: text(q[low]) }),
        readAt: read ? "model" : "between",
        units: us ? "us" : "metric",
        ...(outlet && { outlet: true, outletKind: outlet }),
        series: { q, pct },
      },
    });
  }
  if (features.length === 0) return null;
  // Each river's figure, so a reach's card reads beside the river's number in Rank by: its flow at its mouth (the
  // largest mouth outlet), else where the view cuts it, else (a river that only flows into another here) its largest
  // reach. Each kind sits under its own key and label (FIGURE_KEYS), so the card never calls the edge of the map a mouth.
  const best = { mouth: new Map<string, number>(), edge: new Map<string, number>(), largest: new Map<string, number>() };
  const raise = (m: Map<string, number>, k: string, q: number) => m.set(k, Math.max(q, m.get(k) ?? -Infinity));
  for (const f of features) {
    const { name, q, outletKind } = f.properties!;
    if (typeof q !== "number") continue;
    raise(best.largest, name, q);
    if (outletKind === "mouth" || outletKind === "edge") raise(best[outletKind as "mouth" | "edge"], name, q);
  }
  for (const f of features) {
    const p = f.properties!;
    const kind: RiverFigure | undefined = (["mouth", "edge", "largest"] as const).find((k) => best[k].has(p.name));
    if (!kind) continue;
    const q = best[kind].get(p.name)!;
    p.riverQ = q;
    p.riverFigure = kind;
    p[FIGURE_KEYS[kind]] = flowText(q, p.units === "us");
  }
  return {
    data: { type: "FeatureCollection", features },
    series: { times: times.map((t) => new Date(`${t}T00:00:00Z`).toISOString()), step: "day", now, ...(now < times.length - 1 && { forecastFrom: now + 1 }) },
  };
}

/**
 * The daily file (scripts/build-river-flow.mts). `start` is the first day of every point's `q` (one value a day, m³/s,
 * null where the model has none; `days` past days, then today and the forecast days after it, `days + forecastDays` in
 * all); `q` is null when the point's batch failed that day. `rivers` are the runs the points lie on, whole (not
 * clipped), simplified, with Natural Earth's name and scalerank.
 */
export type RiverFlowFile = {
  version: 1;
  built: string;
  source: string;
  license: string;
  url: string;
  start: string;
  days: number;
  forecastDays: number;
  calls: number;
  rivers: { name: string; rank: number; line: Position[] }[];
  points: (KnownPoint & { q: (number | null)[] | null })[];
};

/** True when `body` has the file's shape (checked loosely: the arrays and dates the layer reads). */
export function isRiverFlowFile(body: unknown): body is RiverFlowFile {
  if (!body || typeof body !== "object") return false;
  const f = body as Partial<RiverFlowFile>;
  return (
    f.version === 1 &&
    typeof f.built === "string" &&
    typeof f.start === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(f.start) &&
    Array.isArray(f.rivers) &&
    Array.isArray(f.points) &&
    f.points.every((p) => p && typeof p.name === "string" && Array.isArray(p.cell) && Array.isArray(p.at) && (p.q === null || Array.isArray(p.q)))
  );
}

/** The days of the file's series, `start` onward, as YYYY-MM-DD. */
export function fileDays(file: Pick<RiverFlowFile, "start" | "days" | "forecastDays">): string[] {
  const t0 = Date.parse(`${file.start}T00:00:00Z`);
  return Array.from({ length: file.days + file.forecastDays }, (_, k) => new Date(t0 + k * 86_400_000).toISOString().slice(0, 10));
}

/** The file's rivers as Natural Earth line features, for runsIn. */
export function fileLines(file: Pick<RiverFlowFile, "rivers">): NeFeature[] {
  return file.rivers.map((r) => ({ type: "Feature", geometry: { type: "LineString", coordinates: r.line }, properties: { name: r.name, scalerank: r.rank, featurecla: "River" } }));
}

/** Whole days from the file's build to `now`. */
export function fileAgeDays(file: Pick<RiverFlowFile, "built">, now: Date): number {
  return Math.floor((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${file.built.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export const cellKey = (p: Position) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/** `flow` moved onto the days `times` (null on a day it lacks). */
export function onDays(flow: Flood, times: string[]): (number | null)[] {
  const byDay = new Map(flow.time.map((t, k) => [t.slice(0, 10), flow.q[k]]));
  return times.map((t) => byDay.get(t) ?? null);
}

let memo: { file: RiverFlowFile; until: number } | null = null;

/** The daily file, kept in the server's fetch cache and in memory for FILE_TTL_SECONDS. */
async function riverFlowFile(ctx: QueryContext): Promise<RiverFlowFile> {
  if (memo && memo.until > Date.now()) return memo.file;
  const res = await ctx.fetch(RIVER_FLOW_URL, {
    cacheKey: "river-pulse:file",
    ttlSeconds: FILE_TTL_SECONDS,
    timeoutMs: 30_000,
    validate: (body) => body.trimStart().startsWith("{"),
  });
  if (!res.ok) throw new Error(`the file answered ${res.status}`);
  const body: unknown = await res.json();
  if (!isRiverFlowFile(body)) throw new Error("the file has an unexpected shape");
  memo = { file: body, until: Date.now() + FILE_TTL_SECONDS * 1000 };
  return body;
}

/** Tests only: forget the file kept in memory. */
export function _resetRiverFlowFile(): void {
  memo = null;
}

const GLOFAS_URL = "https://open-meteo.com/en/docs/flood-api";

const HELP: Record<string, FieldHelp> = {
  flow: {
    text:
      "River discharge: the water passing this reach that day, in cubic feet per second (cfs) and cubic metres per second (m³/s), US units first in " +
      "the United States. It comes from the GloFAS hydrological model (a 5 km grid driven by weather), not a gauge, read at the model cell with the " +
      "most flow near the middle of the reach.",
    source: "GloFAS v4 via the Open-Meteo flood API (CC BY 4.0)",
    url: GLOFAS_URL,
  },
  q: {
    text: "River discharge that day in cubic metres per second, from the GloFAS hydrological model, not a gauge.",
    unit: "m³/s",
    source: "GloFAS v4 via the Open-Meteo flood API (CC BY 4.0)",
    url: GLOFAS_URL,
  },
  pct: {
    text:
      "That day's flow as a percent of this reach's median flow over the days shown (about three months unless fewer were asked for). 100% is the " +
      "reach's typical flow in that stretch of time, 200% double it. It is not the long-term normal for the season: the file holds only these months.",
    unit: "%",
    source: "Computed from GloFAS discharge",
    url: GLOFAS_URL,
  },
  atMouth: {
    text:
      "The flow of this whole river where it ends in view: at the sea, a lake, or where the mapped river line stops. The number Rank by lists for " +
      "the river; Flow above is this one reach.",
  },
  atViewEdge: {
    text:
      "The flow of this whole river where it leaves the map: the view cuts the river before its mouth, so this is the most downstream point drawn, " +
      "not the mouth. The number Rank by lists for the river; Flow above is this one reach.",
  },
  atLargest: {
    text:
      "This river only flows into another river in view, so its figure is its largest reach, usually just above where it joins. The number Rank by " +
      "lists for the river; Flow above is this one reach.",
  },
  medianFlow: { text: "The reach's median daily flow over the days shown (about three months), not its long-term normal for the season." },
  peakFlow: { text: "The highest daily flow of the days shown, on the date in Peak on." },
  lowFlow: { text: "The lowest daily flow of the days shown, on the date in Low on." },
  length: { text: "Length of the reach as drawn: the network is cut into reaches of equal length." },
};

/** Short labels, so every row fits the card; the help popover gives each in full. Flows read in both units, US first in the US. */
const CARD: CardSpec = {
  measure: { key: "flow", label: "Flow" },
  facts: [
    { key: "atMouth", label: "River at its mouth" },
    { key: "atViewEdge", label: "River where it leaves the view" },
    { key: "atLargest", label: "River at its largest reach" },
    { key: "pct", label: "Vs. the 3-month median", unit: "%", format: "int" },
    { key: "medianFlow", label: "3-month median" },
    { key: "peakFlow", label: "Peak" },
    { key: "peakDate", label: "Peak on", format: "date" },
    { key: "lowFlow", label: "Low" },
    { key: "lowDate", label: "Low on", format: "date" },
    { key: "length", label: "Reach length" },
  ],
  hidden: [
    "reachId",
    "series",
    "project",
    "readAt",
    "outlet",
    "outletKind",
    "heading",
    "units",
    "q",
    "medianQ",
    "peakQ",
    "lowQ",
    "riverQ",
    "riverFigure",
    "mouthQ",
    "lengthKm",
  ],
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "q",
    type: "measure",
    label: "Flow",
    unit: "m³/s",
    encode: "size",
    aggregate: "sum",
    aggregateOver: "outlet",
    aggregateLabel: "Total flow leaving the view, all outlets combined",
  },
  { key: "pct", type: "measure", label: "Flow vs. the 3-month median", unit: "%" },
  { key: "name", type: "name", label: "River" },
];

/** Color is the day's flow against each reach's own 3-month median, low to high across the view; width is the flow. */
const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Flow vs. the 3-month median",
  field: "pct",
  unit: "%",
  stops: [
    { label: "Lowest in view against its median" },
    { label: "Highest in view against its median" },
  ],
  note: "Line width is the day's flow (modelled). Reaches the model has no flow for are not drawn.",
};

const riverPulse = defineLayer({
  id: "river-pulse",
  title: "River flow, daily",
  description:
    "How a region's rivers flowed day by day: the named rivers in the box that the daily file covers (Natural Earth rivers: about 250 in the contiguous United States with their tributaries, and the largest rivers worldwide, more each day), cut into reaches, with modelled daily discharge (GloFAS) for the past days (default 92, about three months) and the forecast days (default 7), played day by day on the time scrubber. " +
    "Each reach has name, q (flow in m³/s at today's frame; flow is the same as text in cfs and m³/s, cfs first in the US), pct (that day's flow as a percent of the reach's own median over the days shown, NOT a long-term normal: call it 'vs. the 3-month median'), medianQ, peakQ with peakDate, lowQ with lowDate, outlet (true where a river leaves the view), and a series of q and pct per day; line width is the day's flow and color is pct across the view (sage the lowest, purple the highest). " +
    "riverQ is the whole river's figure in m³/s and riverFigure says where it is read: 'mouth' (where the river really ends: the sea, a lake, or where its mapped line stops), 'edge' (where the view cuts the river short of its mouth; say 'where it leaves the view', not 'at the mouth') or 'largest' (a river that only joins another here: its largest reach). " +
    "Use it for 'how has the Mississippi's flow changed', 'is the Ohio running high this month', 'show the river flow of the Danube basin'. " +
    "The total is the flow leaving the view, all outlets combined (the sea, lakes and the edges of the view); the summary's story gives its low and peak with dates, the ratio, whether it repeats, and the rivers that swelled most (the drivers). " +
    "Caveats: GloFAS is a 5 km model driven by weather, not gauges (dams and diversions are only roughly modelled); each river is read at one to three points and interpolated between them; small rivers are left out; past days are capped at 92, so a yearly cycle cannot be seen and there is no long-term normal; the file is built once a day, and the note says which day. " +
    "Any box up to a continent answers; use streamflow for live gauge readings and flow against the long-term normal for the date.",
  coverage: "global",
  surface: "land",
  license: "GloFAS via Open-Meteo, CC BY 4.0 (free for non-commercial use); Natural Earth rivers, public domain",
  requiredEnv: [],
  maxAreaKm2: 25_000_000,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("river-pulse"), unit: "m³/s", encode: { size: "q", color: "pct" }, series: "day", basemap: "data-only" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // A daily frame for each day shown, the past months then the forecast.
  time: { shape: "continuous", step: "day" },
  legend: LEGEND,
  // One label per river at most in practice: the five reaches with the most flow.
  labels: { field: "name", max: 5, rankBy: "q" },
  // The model's days are UTC days (the file asks for timezone GMT); a local clock would move each day back by hours.
  display: { timeZone: "utc" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    let file: RiverFlowFile;
    try {
      file = await riverFlowFile(ctx);
    } catch (err) {
      return { error: `The daily river flow file could not be loaded: ${err instanceof Error ? err.message : "unknown error"}`, hint: "upstream" };
    }
    const builtDay = file.built.slice(0, 10);
    const citation = {
      source: "GloFAS v4 river discharge via the Open-Meteo flood API (CC BY 4.0), built daily into one file; rivers from Natural Earth (public domain)",
      url: GLOFAS_URL,
      retrieved: file.built,
    };
    const { runs, samples } = planPoints(runsIn(fileLines(file), ctx.bbox), file.points, { maxPoints: MAX_POINTS, maxNew: 0 });
    if (samples.length === 0) {
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features: [] },
        citation,
        coverageNote: `None of the ${new Set(file.points.map((p) => p.name)).size} rivers in the daily file (built ${builtDay}) runs through this box; zoom out or pick a larger basin`,
      };
    }
    // The days shown: `days` before today, today, and the forecast days after it, as far as the file reaches.
    const axis = fileDays(file);
    const today = now.toISOString().slice(0, 10);
    let at = axis.findLastIndex((t) => t <= today);
    if (at < 0) at = 0;
    const times = axis.slice(Math.max(0, at - input.days), Math.min(axis.length, at + Math.max(1, input.forecastDays)));
    const from = axis.indexOf(times[0]);
    const byCell = new Map(file.points.map((p) => [cellKey(p.cell), p.q]));
    const flows: (Flood | null)[] = samples.map((s) => {
      const q = s.cell ? byCell.get(cellKey(s.cell)) : null;
      return q ? { time: times, q: q.slice(from, from + times.length) } : null;
    });
    // Only points the file lacks are read live (cached for the day), at most MAX_LIVE_POINTS.
    const missing = flows.map((f, i) => ({ f, i })).filter((x) => x.f === null).slice(0, MAX_LIVE_POINTS);
    let live = 0;
    if (missing.length > 0) {
      const cellsAt = missing.map(({ i }) => samples[i].cell ?? samples[i].at);
      const { flows: read, read: asked } = await flowsFor(ctx, cellsAt, input.days, Math.max(1, input.forecastDays), today);
      read.forEach((flow, k) => {
        if (flow) flows[missing[k].i] = { time: times, q: onDays(flow, times) };
      });
      live = asked;
      if (asked > 0) console.info(`[river-pulse] ${asked} points missing from the file read live: about ${Math.round(asked * ((input.days + input.forecastDays) / 14))} Open-Meteo calls`);
    }
    if (flows.every((f) => f === null)) return { error: "The daily river flow file has no discharge for these rivers and the Open-Meteo flood API did not answer; try again shortly", hint: "upstream" };
    // Where each whole river line ends: an outlet at none of these was cut by the view, not a mouth.
    const lineEnds = file.rivers.flatMap((r) => (r.line.length > 0 ? [r.line[0], r.line[r.line.length - 1]] : []));
    const built = reachFeatures(reachesOf(runs), samples, flows, now.toISOString(), runs, lineEnds);
    if (!built) return { error: "The daily river flow file has no usable discharge here", hint: "upstream" };
    const rivers = new Set(built.data.features.map((f) => f.properties?.name)).size;
    const outlets = built.data.features.filter((f) => f.properties?.outlet === true);
    const edges = outlets.filter((f) => f.properties?.outletKind === "edge").length;
    const age = fileAgeDays(file, now);
    const notes = [
      `${rivers} rivers in ${built.data.features.length} reaches with daily GloFAS discharge (modelled, not gauged), ${times.length} days to ${times[times.length - 1]}`,
      `from the daily file built ${builtDay}` + (live > 0 ? ` (${live} points it lacked read live)` : ""),
      `read at ${samples.length} points and interpolated along each river; ${outlets.length} outlets (${outlets.length - edges} mouths or lakes, ${edges} at the edge of the view)`,
      "color compares each day with the reach's own median over these days, not with a long-term normal",
    ];
    if (age > STALE_DAYS) notes.unshift(`The daily file is ${age} days old (built ${builtDay}): its newest days are forecasts made then, and the latest days may be missing`);
    return { kind: "geojson", data: built.data, series: built.series, citation, coverageNote: notes.join("; "), title: `River flow, daily (${rivers} rivers)` };
  },
});

registerLayer(riverPulse);

export default riverPulse;

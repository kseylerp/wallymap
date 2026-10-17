/**
 * River pulse (spec §13, after mapped.earth's "North America's River Pulse"): the river network of a basin or region
 * with each reach's daily discharge for the past months and the forecast days, played day by day. Width is that day's
 * flow; color is the flow against the reach's own median over the period (no water temperature source covers every
 * reach, so this is the "otherwise" of the brief).
 *
 * Geometry: Natural Earth 10m rivers and lake centerlines (public domain), one 7.3 MB GeoJSON of 1,455 river lines
 * worldwide (verified 2026-10-17: properties name, name_en, scalerank 0 most important to 12, featurecla "River" or
 * "Lake Centerline"; the Mississippi is three MultiLineStrings, scalerank 1 and 5), fetched once and kept for 30 days.
 * The lines in view are clipped to the box and taken most important first; each run is read at one to three points
 * (MAX_SAMPLES in all) and cut into up to MAX_REACHES reaches of equal length, whose flow is interpolated by distance
 * between the run's points (spec §13 allows modelled or interpolated values, so the network fills in).
 *
 * Discharge: GloFAS v4 via the Open-Meteo flood API (CC BY 4.0), https://flood-api.open-meteo.com/v1/flood, POSTed
 * with many locations (verified 2026-10-17: a form body with latitude=a,b,…&longitude=… answers a JSON array, one object
 * per point, daily.time and daily.river_discharge in m³/s; past_days up to 92; 270 locations, 99 days, 563 KB in 1.3 s).
 * The free tier allows 600 calls a minute and 5,000 an hour, a location counting one call per 14 days asked for
 * (measured 2026-10-17: 800 locations of 99 days in a minute used up the hour).
 * GloFAS is a 0.05° (about 5 km) grid: a Natural Earth line rarely lies in the cell that carries the river (a Mississippi
 * point near Lake Pepin read 0.22 m³/s in its own cell and 576 m³/s one cell over), so each point is first read in its
 * 3 x 3 cells over one week and the cell with the most flow is remembered for 30 days; only those cells are asked for
 * the full months, cached for 6 hours.
 *
 * Live smoke 2026-10-17 (through runLayer), the Mississippi basin [-113,29,-78,49]: see layers/river-pulse.test.ts and
 * the commit; the lower Mississippi read about 17,000 m³/s in mid-July falling toward 11,000 m³/s by late October.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type QueryContext, type SeriesAxis } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { haversineKm } from "./_shared/geo";
import { layerColor } from "@/lib/render/palette";
import { createCache } from "@/lib/fetch";

export const NE_RIVERS_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson";
const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
/**
 * Most points the flow is read at. Open-Meteo's free tier allows 600 calls a minute and 5,000 an hour, where a location
 * is one call per two weeks of days (so 99 days count about 7): a point never seen before costs 9 for its 3 x 3 cells
 * over one week, then about 7 for its full months, so a cold query of 30 points costs about 480 and a warm one 210.
 */
export const MAX_SAMPLES = 30;
/** One sample per this much river, at most MAX_SAMPLES_PER_RUN per run. */
export const SAMPLE_SPACING_KM = 500;
const MAX_SAMPLES_PER_RUN = 5;
/** Most reaches drawn; their flow is interpolated between the samples, so they cost nothing upstream. */
export const MAX_REACHES = 320;
/** The shortest reach drawn. */
export const MIN_REACH_KM = 20;
/** A river run shorter than this inside the box is left out. */
const MIN_RUN_KM = 30;
/** Locations per flood-API request (a 3 x 3 neighbourhood is 9 per sample). */
const BATCH = 216;
/** Offsets in degrees: GloFAS cells are 0.05°, so these are the 3 x 3 cells around a point. */
const NEIGHBOURS: [number, number][] = [-0.05, 0, 0.05].flatMap((dy) => [-0.05, 0, 0.05].map((dx): [number, number] => [dx, dy]));
/** A reach whose median flow is under this (m³/s) sampled only local runoff: no river cell was found near it. */
const MIN_MEDIAN_M3S = 1;

const inputSchema = z.object({
  days: z.number().int().min(14).max(92).default(92).describe("Past days of daily flow, 14 to 92 (default 92, about three months)"),
  forecastDays: z.number().int().min(0).max(30).default(7).describe("Forecast days after today, 0 to 30 (default 7)"),
});

type NeFeature = Feature<LineString | GeoJSON.MultiLineString, { name?: string | null; name_en?: string | null; scalerank?: number; featurecla?: string }>;

/** One run of a river inside the box: its name and importance, its line and length. */
export type Run = { name: string; rank: number; line: Position[]; km: number };
/** One reach as drawn: its run, its line, and how far along the run its middle lies. */
export type Reach = { id: string; run: number; name: string; line: Position[]; atKm: number; lengthKm: number };
/** One point the flow is read at: its run, how far along it, and where. */
export type Sample = { run: number; atKm: number; at: Position };

let loading: Promise<NeFeature[]> | undefined;

/** The Natural Earth river lines, fetched once per process (and from the shared cache for 30 days). */
async function riverLines(ctx: QueryContext): Promise<NeFeature[]> {
  loading ??= (async () => {
    const res = await ctx.fetch(NE_RIVERS_URL, { cacheKey: "ne:rivers-centerlines", ttlSeconds: 30 * 86_400, timeoutMs: 45_000 });
    if (!res.ok) throw new Error(`Natural Earth rivers returned ${res.status}`);
    const body = (await res.json()) as { features?: NeFeature[] };
    if (!Array.isArray(body.features)) throw new Error("Natural Earth rivers: no features");
    return body.features.filter((f) => f.geometry && (f.properties?.featurecla === "River" || f.properties?.featurecla === "Lake Centerline"));
  })().catch((err) => {
    loading = undefined;
    throw err;
  });
  return loading;
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
    const name = (f.properties?.name_en || f.properties?.name || "").trim() || "Unnamed river";
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

/**
 * Where the flow is read: one to five points per run (one per SAMPLE_SPACING_KM, evenly spaced), the most important
 * runs first, until MAX_SAMPLES; runs left without a point are not drawn. Returns the runs kept and their points.
 */
export function planSamples(runs: Run[], maxSamples = MAX_SAMPLES): { runs: Run[]; samples: Sample[] } {
  const kept: Run[] = [];
  const samples: Sample[] = [];
  for (const run of runs) {
    const left = maxSamples - samples.length;
    if (left <= 0) break;
    const n = Math.min(left, Math.max(1, Math.min(MAX_SAMPLES_PER_RUN, Math.round(run.km / SAMPLE_SPACING_KM))));
    const index = kept.length;
    kept.push(run);
    for (let k = 0; k < n; k++) {
      const atKm = ((k + 0.5) / n) * run.km;
      samples.push({ run: index, atKm, at: pointAlong(run.line, atKm) });
    }
  }
  return { runs: kept, samples };
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

const FloodRow = z.object({ daily: z.object({ time: z.array(z.string()), river_discharge: z.array(z.number().nullable()) }) });
type Flood = { time: string[]; q: (number | null)[] };

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

const pointKey = (p: Position) => `river-pulse:cell:${p[0].toFixed(3)},${p[1].toFixed(3)}`;
const cells = createCache();

/**
 * For each sample point, the GloFAS cell around it that carries the most flow over the last week: remembered per point
 * for 30 days, so only points never seen before cost a (short, 7-day) call for their 3 x 3 cells. A point whose cells
 * all fail keeps its own position.
 */
async function riverCells(ctx: QueryContext, points: Position[]): Promise<Position[]> {
  const known = await Promise.all(
    points.map(async (p) => {
      try {
        const hit = await cells.get(pointKey(p));
        const parsed = hit ? (JSON.parse(hit) as unknown) : null;
        return Array.isArray(parsed) && parsed.length === 2 && parsed.every((n) => typeof n === "number") ? (parsed as Position) : null;
      } catch {
        return null;
      }
    }),
  );
  const unknown = points.map((p, i) => ({ p, i })).filter((x) => known[x.i] === null);
  if (unknown.length === 0) return known as Position[];
  const grid = unknown.flatMap(({ p }) => NEIGHBOURS.map(([dx, dy]): Position => [p[0] + dx, p[1] + dy]));
  const batches: Position[][] = [];
  for (let i = 0; i < grid.length; i += BATCH) batches.push(grid.slice(i, i + BATCH));
  const answers = (await inTurns(batches.map((b) => () => floodBatch(ctx, b, 7, 0, `river-pulse:cells:${hashOf(b)}`, 30 * 86_400)), 2)).flat();
  const out = [...known];
  await Promise.all(
    unknown.map(async ({ p, i }, u) => {
      let best: { at: Position; mean: number } | null = null;
      for (let k = 0; k < NEIGHBOURS.length; k++) {
        const vals = answers[u * NEIGHBOURS.length + k]?.q.filter((v): v is number => typeof v === "number") ?? [];
        if (vals.length === 0) continue;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (!best || mean > best.mean) best = { at: grid[u * NEIGHBOURS.length + k], mean };
      }
      out[i] = best?.at ?? p;
      if (best) await cells.set(pointKey(p), JSON.stringify(best.at), 30 * 86_400).catch(() => {});
    }),
  );
  return out as Position[];
}

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

/**
 * The reach features with their series (`series.q` flow in m³/s and `series.pct` the flow as a percent of the reach's
 * median over the past days), the plain `q` and `pct` at today's frame, and the period's low and peak with dates. A
 * reach between a run's sample points takes their flow interpolated by distance (`readAt` says so).
 */
export function reachFeatures(reaches: Reach[], samples: Sample[], flows: (Flood | null)[], todayIso: string): { data: FeatureCollection; series: SeriesAxis } | null {
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
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: reach.line },
      properties: {
        name: reach.name,
        // One river is one place: the Rank by list and the summary name it once, by its largest reach.
        project: reach.name,
        reachId: reach.id,
        lengthKm: reach.lengthKm,
        q: q[now],
        pct: pct[now],
        medianQ: round1(med),
        ...(peak >= 0 && { peakQ: q[peak], peakDate: times[peak] }),
        ...(low >= 0 && { lowQ: q[low], lowDate: times[low] }),
        readAt: read ? "model" : "between",
        series: { q, pct },
      },
    });
  }
  if (features.length === 0) return null;
  return {
    data: { type: "FeatureCollection", features },
    series: { times: times.map((t) => new Date(`${t}T00:00:00Z`).toISOString()), step: "day", now, ...(now < times.length - 1 && { forecastFrom: now + 1 }) },
  };
}

const GLOFAS_URL = "https://open-meteo.com/en/docs/flood-api";

const HELP: Record<string, FieldHelp> = {
  q: {
    text:
      "River discharge: the water passing this reach that day, in cubic metres per second, from the GloFAS hydrological model (a 5 km grid " +
      "driven by weather), not a gauge; read at the model cell with the most flow near the middle of the reach.",
    unit: "m³/s",
    source: "GloFAS v4 via the Open-Meteo flood API (CC BY 4.0)",
    url: GLOFAS_URL,
  },
  pct: {
    text:
      "That day's flow as a percent of this reach's median flow over the past days shown: 100% is the reach's typical flow in the period, " +
      "200% double it. It compares the reach with itself over these months, not with its long-term normal.",
    unit: "%",
    source: "Computed from GloFAS discharge",
    url: GLOFAS_URL,
  },
  medianQ: { text: "The reach's median daily flow over the past days shown.", unit: "m³/s" },
  peakQ: { text: "The highest daily flow of the past days shown, on peakDate.", unit: "m³/s" },
  lowQ: { text: "The lowest daily flow of the past days shown, on lowDate.", unit: "m³/s" },
  lengthKm: { text: "Length of the reach as drawn: the network is cut into reaches of equal length.", unit: "km" },
};

const CARD: CardSpec = {
  measure: { key: "q", label: "Flow", unit: "m³/s" },
  facts: [
    { key: "pct", label: "Flow vs. the period's median", unit: "%", format: "int" },
    { key: "medianQ", label: "Median flow over the period", unit: "m³/s", format: "int" },
    { key: "peakQ", label: "Peak flow", unit: "m³/s", format: "int" },
    { key: "peakDate", label: "Peak on", format: "date" },
    { key: "lowQ", label: "Lowest flow", unit: "m³/s", format: "int" },
    { key: "lowDate", label: "Lowest on", format: "date" },
    { key: "lengthKm", label: "Reach length", unit: "km", format: "int" },
  ],
  hidden: ["reachId", "series", "project", "readAt"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "q", type: "measure", label: "Flow", unit: "m³/s", encode: "size", aggregate: "max" },
  { key: "pct", type: "measure", label: "Flow vs. the period's median", unit: "%" },
  { key: "name", type: "name", label: "River" },
];

const riverPulse = defineLayer({
  id: "river-pulse",
  title: "River pulse (daily flow, whole network)",
  description:
    "How a whole river network's flow changed day by day: every river reach in the box (Natural Earth rivers cut into reaches) with its modelled daily discharge (GloFAS) for the past days (default 92, about three months) and the forecast days (default 7), played day by day on the time scrubber. " +
    "Each reach has name, q (flow in m³/s at today's frame), pct (that day's flow as a percent of the reach's own median over the period), medianQ, peakQ with peakDate, lowQ with lowDate, and a series of q and pct per day; line width is the day's flow and color is pct (sage below the median, purple well above). " +
    "Use it for 'how has the Mississippi's flow changed', 'is the Ohio running high this month', 'show the river pulse of the Danube basin'. " +
    "The summary's story gives the low and the peak of the largest reach with their dates, the ratio between them, whether it repeats, and the reaches that swelled most (the drivers). " +
    "Caveats: GloFAS is a 5 km model driven by weather, not gauges (dams and diversions are only roughly modelled); a reach is read at one model cell near its middle; small rivers are left out at wide views; past days are capped at 92, so a yearly cycle cannot be seen. " +
    "Any box up to a continent answers; use streamflow for live gauge readings.",
  coverage: "global",
  surface: "land",
  license: "GloFAS via Open-Meteo, CC BY 4.0 (free for non-commercial use); Natural Earth rivers, public domain",
  requiredEnv: [],
  maxAreaKm2: 25_000_000,
  input: inputSchema,
  style: { geometry: "line", color: layerColor("river-pulse"), unit: "m³/s", encode: { size: "q", color: "pct" }, series: "day" },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    let lines: NeFeature[];
    try {
      lines = await riverLines(ctx);
    } catch (err) {
      return { error: `Natural Earth rivers could not be loaded: ${err instanceof Error ? err.message : "unknown error"}`, hint: "upstream" };
    }
    const citation = {
      source: "GloFAS v4 river discharge via the Open-Meteo flood API (CC BY 4.0); rivers from Natural Earth (public domain)",
      url: GLOFAS_URL,
      retrieved: now.toISOString(),
    };
    const { runs, samples } = planSamples(runsIn(lines, ctx.bbox));
    if (samples.length === 0) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: "No Natural Earth rivers in this box; zoom out or pick a basin" };
    }
    const at = await riverCells(ctx, samples.map((s) => s.at));
    const day = now.toISOString().slice(0, 10);
    const flows = await floodBatch(ctx, at, input.days, input.forecastDays, `river-pulse:flow:${day}:${input.days}:${input.forecastDays}:${hashOf(at)}`, 6 * 3_600);
    if (flows.every((f) => f === null)) return { error: "The Open-Meteo flood API did not answer for these rivers (it may be over its minute limit); try again shortly", hint: "upstream" };
    const built = reachFeatures(reachesOf(runs), samples, flows, now.toISOString());
    if (!built) return { error: "The Open-Meteo flood API returned no usable discharge here", hint: "upstream" };
    const rivers = new Set(built.data.features.map((f) => f.properties?.name)).size;
    const notes = [
      `${built.data.features.length} reaches of ${rivers} rivers with daily GloFAS discharge (modelled, not gauged), ${input.days} past days and ${input.forecastDays} forecast days`,
      `read at ${samples.length} points and interpolated along each river between them`,
    ];
    return { kind: "geojson", data: built.data, series: built.series, citation, coverageNote: notes.join("; ") };
  },
});

registerLayer(riverPulse);

export default riverPulse;

/** Exposed for tests: the 3 x 3 cell offsets. */
export const _internal = { NEIGHBOURS };

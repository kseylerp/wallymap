/**
 * Builds the river-pulse layer's daily file (layers/river-pulse.ts): the rivers it covers, the points each is read at
 * (snapped to the GloFAS cell that carries the river), and each point's daily discharge for the past 92 days and 7
 * forecast days, from the Open-Meteo flood API (free tier, no key). Run once a day by .github/workflows/river-flow.yml,
 * which publishes the file to the `data` branch; a map load then costs Open-Meteo nothing.
 *
 *   node --env-file=.env.local --import tsx scripts/build-river-flow.mts [--out path] [--prev path|url|none] [--budget 4800]
 *
 * Budget: Open-Meteo's free tier allows 600 calls a minute, 5,000 an hour and 10,000 a day; a location counts one call
 * per 14 days asked for, so a point's 99 days cost about 7.07 calls, and snapping a new point (its 3 x 3 cells over one
 * week) costs 9. Each build reads every point it already has (from the last published file, --prev, else the seed
 * data/river-points.json) and spends what is left of --budget (default 4,800, under half the daily allowance) on new
 * points: Natural Earth's rivers worldwide, most important first (scalerank, then length), one to three points each.
 * Coverage grows day by day until reading the points takes the whole budget (about 680 points). A point whose cells
 * carry under 1 m³/s is remembered in `skipped`, so its river is not tried again. Requests are paced at --rate calls a
 * minute (default 400); a request that gets no answer tries again in 5 s, a 429 or 5xx after a minute, four tries in
 * all; a daily or hourly limit stops the reading, and points left unread keep their place with no flow (the layer reads
 * those live). --dry stops after planning, before any Open-Meteo call.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Position } from "geojson";
import { FloodRow, FLOOD_API, mergeRiverFiles, NE_RIVERS_NA_URL, NE_RIVERS_URL, planPoints, RIVER_FLOW_URL, runsIn, type KnownPoint, type NeFeature, type RiverFlowFile } from "@/layers/river-pulse";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = resolve(arg("--out") ?? ".river-flow/river-flow.json");
const PREV = arg("--prev") ?? RIVER_FLOW_URL;
const BUDGET = Number(arg("--budget") ?? 4800);
const RATE = Number(arg("--rate") ?? 400);
const SEED = new URL("../data/river-points.json", import.meta.url);
const DAYS = 92;
const FORECAST_DAYS = 7;
const FLOW_COST = (DAYS + FORECAST_DAYS) / 14;
const SNAP_COST = 9;
const SNAP_PER_REQUEST = 24;
const FLOW_PER_REQUEST = 50;
const MIN_MEAN_M3S = 1;
/** Simplification tolerance in degrees (about 1 km); the layer matches points to lines within 12 km. */
const SIMPLIFY_DEG = 0.01;
const OFFSETS: [number, number][] = [-0.05, 0, 0.05].flatMap((dy) => [-0.05, 0, 0.05].map((dx): [number, number] => [dx, dy]));
const WORLD = [-180, -90, 180, 90] as [number, number, number, number];

const round = (n: number, d: number) => Number(n.toFixed(d));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Skipped = { name: string; at: Position };

async function loadRivers(url: string): Promise<NeFeature[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { features: NeFeature[] };
  return body.features.filter((f) => f.geometry && (f.properties?.featurecla === "River" || f.properties?.featurecla === "Lake Centerline"));
}

/** The last published file's points and skipped points, or the seed's points when there is none. */
async function previous(): Promise<{ points: KnownPoint[]; skipped: Skipped[]; from: string }> {
  if (PREV !== "none") {
    try {
      const text = /^https?:/.test(PREV) ? await fetch(PREV).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))) : readFileSync(PREV, "utf8");
      const body = JSON.parse(text) as Partial<RiverFlowFile> & { skipped?: Skipped[] };
      if (Array.isArray(body.points) && body.points.length > 0) {
        return { points: body.points.map(({ name, at, cell }) => ({ name, at, cell })), skipped: body.skipped ?? [], from: PREV };
      }
    } catch (err) {
      console.log(`no previous file at ${PREV} (${err instanceof Error ? err.message : err}); starting from the seed`);
    }
  }
  const seed = JSON.parse(readFileSync(SEED, "utf8")) as { points: KnownPoint[] };
  return { points: seed.points, skipped: [], from: "data/river-points.json" };
}

let calls = 0;
let stopped: string | null = null;

/** One flood-API POST, paced to RATE calls a minute; null when it fails (after two retries) or a limit is reached. */
async function flood(points: Position[], pastDays: number, forecastDays: number): Promise<({ time: string[]; q: (number | null)[] } | null)[] | null> {
  if (stopped) return null;
  const weight = points.length * Math.max(1, (pastDays + forecastDays) / 14);
  const body = new URLSearchParams({
    latitude: points.map((p) => p[1].toFixed(3)).join(","),
    longitude: points.map((p) => p[0].toFixed(3)).join(","),
    daily: "river_discharge",
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
    timezone: "GMT",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(FLOOD_API, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      // On GitHub's runners about one request in three fails before an answer (a kept-alive socket the server closed
      // during the pause); a new connection a few seconds later answers. Not counted: nothing came back.
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      console.log(`request failed (${err instanceof Error ? err.message : err}${cause}); trying again in 5 s`);
      await sleep(5_000);
      continue;
    }
    // Every answer counts, a refusal included (Open-Meteo may count it).
    calls += weight;
    if (res.ok) {
      const json: unknown = await res.json();
      await sleep((weight / RATE) * 60_000);
      const rows = Array.isArray(json) ? json : [json];
      return points.map((_, i) => {
        const parsed = FloodRow.safeParse(rows[i]);
        return parsed.success ? { time: parsed.data.daily.time, q: parsed.data.daily.river_discharge } : null;
      });
    }
    const text = (await res.text()).slice(0, 200);
    if (/daily|hourly/i.test(text) && /limit/i.test(text)) {
      stopped = `${res.status}: ${text}`;
      console.log(`stopping: ${stopped}`);
      return null;
    }
    if (res.status !== 429 && res.status < 500) {
      console.log(`request answered ${res.status}: ${text}`);
      return null;
    }
    console.log(`request answered ${res.status}; waiting a minute`);
    await sleep(60_000);
  }
  return null;
}

/** Douglas-Peucker on lon/lat degrees. */
function simplify(line: Position[], tol: number): Position[] {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = line[a];
    const [bx, by] = line[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = line[i];
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Three significant figures or so: whole m³/s from 100, tenths from 10, hundredths below. */
function quantise(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return v >= 100 ? Math.round(v) : v >= 10 ? round(v, 1) : round(v, 2);
}

const t0 = Date.now();
const lines = mergeRiverFiles(await loadRivers(NE_RIVERS_URL), await loadRivers(NE_RIVERS_NA_URL));
const runs = runsIn(lines, WORLD);
const prev = await previous();
// Points still on a river line, one per cell.
const seen = new Set<string>();
const kept = planPoints(runs, prev.points, { maxPoints: Infinity });
const old: KnownPoint[] = [];
for (const p of prev.points) {
  const key = `${p.cell[0].toFixed(3)},${p.cell[1].toFixed(3)}`;
  if (seen.has(key) || !kept.samples.some((s) => s.cell === p.cell)) continue;
  seen.add(key);
  old.push(p);
}
const room = Math.max(0, Math.floor((BUDGET - old.length * FLOW_COST) / (SNAP_COST + FLOW_COST)));
// Skipped points count as covering their river, so it is not tried again.
const planned = planPoints(runs, [...old, ...prev.skipped.map((s) => ({ ...s, cell: s.at }))], { maxPoints: Infinity, maxNew: room });
const wanted = planned.samples.filter((s) => !s.cell).map((s) => ({ name: planned.runs[s.run].name, at: [round(s.at[0], 4), round(s.at[1], 4)] as Position }));
console.log(`${runs.length} river runs worldwide; ${old.length} points from ${prev.from}; room for ${room} new points, snapping ${wanted.length}`);
if (process.argv.includes("--dry")) {
  console.log(`new rivers: ${[...new Set(wanted.map((w) => w.name))].slice(0, 40).join(", ")}…`);
  process.exit(0);
}

// Snap the new points: the cell of the 3 x 3 around each with the most flow over the last week.
const fresh: KnownPoint[] = [];
const skipped: Skipped[] = [...prev.skipped];
for (let i = 0; i < wanted.length && !stopped; i += SNAP_PER_REQUEST) {
  const chunk = wanted.slice(i, i + SNAP_PER_REQUEST);
  const grid = chunk.flatMap((w) => OFFSETS.map(([dx, dy]): Position => [round(w.at[0] + dx, 3), round(w.at[1] + dy, 3)]));
  const rows = await flood(grid, 7, 0);
  if (!rows) continue;
  chunk.forEach((w, c) => {
    let best: { cell: Position; mean: number } | null = null;
    OFFSETS.forEach((_, k) => {
      const vals = rows[c * OFFSETS.length + k]?.q.filter((v): v is number => typeof v === "number") ?? [];
      if (vals.length === 0) return;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (!best || mean > best.mean) best = { cell: grid[c * OFFSETS.length + k], mean };
    });
    const b = best as { cell: Position; mean: number } | null;
    if (b && b.mean >= MIN_MEAN_M3S) fresh.push({ name: w.name, at: w.at, cell: b.cell });
    else skipped.push(w);
  });
  console.log(`snapped ${fresh.length} of ${Math.min(wanted.length, i + SNAP_PER_REQUEST)} (${skipped.length - prev.skipped.length} skipped); ${Math.round(calls)} calls`);
}

// Read every point's 99 days.
const points = [...old, ...fresh];
const flows: ({ time: string[]; q: (number | null)[] } | null)[] = points.map(() => null);
for (let i = 0; i < points.length && !stopped; i += FLOW_PER_REQUEST) {
  const rows = await flood(points.slice(i, i + FLOW_PER_REQUEST).map((p) => p.cell), DAYS, FORECAST_DAYS);
  rows?.forEach((r, k) => (flows[i + k] = r));
  console.log(`read ${Math.min(points.length, i + FLOW_PER_REQUEST)} of ${points.length}; ${Math.round(calls)} calls`);
}
const time = flows.find((f) => f !== null)?.time;
if (!time) {
  console.error(`no flow read${stopped ? ` (${stopped})` : ""}; nothing written`);
  process.exit(1);
}

// The rivers the points lie on, whole and simplified.
const drawn = planPoints(runs, points, { maxPoints: Infinity });
const rivers = drawn.runs.map((r) => ({ name: r.name, rank: r.rank, line: simplify(r.line, SIMPLIFY_DEG).map((p) => [round(p[0], 3), round(p[1], 3)]) }));
const file: RiverFlowFile & { skipped: Skipped[] } = {
  version: 1,
  built: new Date().toISOString(),
  source: "GloFAS v4 river discharge via the Open-Meteo flood API (https://open-meteo.com/en/docs/flood-api); rivers from Natural Earth 10m (public domain)",
  license: "Discharge CC BY 4.0, Open-Meteo.com and the Copernicus Emergency Management Service (GloFAS); Natural Earth public domain",
  url: "https://open-meteo.com/en/docs/flood-api",
  start: time[0],
  days: DAYS,
  forecastDays: FORECAST_DAYS,
  calls: Math.round(calls),
  rivers,
  points: points.map((p, i) => ({ name: p.name, at: p.at, cell: p.cell, q: flows[i] && flows[i]!.time.length === time.length && flows[i]!.time[0] === time[0] ? flows[i]!.q.map(quantise) : null })),
  skipped,
};
mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(file);
writeFileSync(OUT, text);
const withFlow = file.points.filter((p) => p.q !== null).length;
console.log(
  `wrote ${OUT}: ${(text.length / 1e6).toFixed(2)} MB, ${file.points.length} points (${withFlow} with flow) on ${new Set(file.points.map((p) => p.name)).size} rivers (${rivers.length} runs), ` +
    `${time[0]} to ${time[time.length - 1]}, about ${file.calls} Open-Meteo calls, ${Math.round((Date.now() - t0) / 1000)} s${stopped ? `; stopped early: ${stopped}` : ""}`,
);

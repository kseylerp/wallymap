/**
 * Builds data/river-points.json: the points the river-pulse layer reads each river's flow at, snapped ahead of time to
 * the GloFAS model cell that carries the river there, so a map load spends its Open-Meteo calls on flow, not on finding
 * rivers (layers/river-pulse.ts).
 *
 *   node --env-file=.env.local --import tsx scripts/river-points.mts [--max 290] [--box w,s,e,n]
 *
 * Rivers: Natural Earth 10m rivers and lake centerlines plus its North America supplement, clipped to the box (default
 * the contiguous United States), joined end to end per river, most important first (scalerank, then length), each read
 * at one point under 700 km, two under 1,600 km, else three, at most --max points. Each point's 3 x 3 GloFAS cells
 * (0.05°) are read over one week and the cell with the most flow is kept. Open-Meteo's free tier allows 600 calls a
 * minute and 5,000 an hour; each point costs 9 calls (a week counts once), sent 24 points per request, one request
 * every 30 seconds (432 calls a minute). Points whose cells all answer nothing are left out.
 */
import { writeFileSync } from "node:fs";
import type { Position } from "geojson";
import { mergeRiverFiles, NE_RIVERS_NA_URL, NE_RIVERS_URL, pointAlong, runsIn } from "@/layers/river-pulse";
import type { BBox } from "@/layers/types";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MAX = Number(arg("--max") ?? 290);
const BOX = (arg("--box")?.split(",").map(Number) ?? [-125, 24, -66, 50]) as BBox;
const OUT = new URL("../data/river-points.json", import.meta.url);
const OFFSETS: [number, number][] = [-0.05, 0, 0.05].flatMap((dy) => [-0.05, 0, 0.05].map((dx): [number, number] => [dx, dy]));
const POINTS_PER_REQUEST = 24;
const PAUSE_MS = 30_000;

type NeFile = { features: Parameters<typeof runsIn>[0] };

async function load(url: string): Promise<NeFile["features"]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as NeFile;
  return body.features.filter((f) => f.geometry && (f.properties?.featurecla === "River" || f.properties?.featurecla === "Lake Centerline"));
}

const round = (n: number, d: number) => Number(n.toFixed(d));

const lines = mergeRiverFiles(await load(NE_RIVERS_URL), await load(NE_RIVERS_NA_URL));
const runs = runsIn(lines, BOX);
const wanted: { name: string; at: Position }[] = [];
for (const run of runs) {
  if (wanted.length >= MAX) break;
  const n = Math.min(MAX - wanted.length, run.km < 700 ? 1 : run.km < 1600 ? 2 : 3);
  for (let k = 0; k < n; k++) {
    const p = pointAlong(run.line, ((k + 0.5) / n) * run.km);
    wanted.push({ name: run.name, at: [round(p[0], 4), round(p[1], 4)] });
  }
}
console.log(`${runs.length} runs in the box; snapping ${wanted.length} points of ${new Set(wanted.map((w) => w.name)).size} rivers`);
if (process.argv.includes("--dry")) process.exit(0);

const points: { name: string; at: Position; cell: Position }[] = [];
for (let i = 0; i < wanted.length; i += POINTS_PER_REQUEST) {
  const chunk = wanted.slice(i, i + POINTS_PER_REQUEST);
  const grid = chunk.flatMap((w) => OFFSETS.map(([dx, dy]): Position => [round(w.at[0] + dx, 3), round(w.at[1] + dy, 3)]));
  const body = new URLSearchParams({
    latitude: grid.map((p) => p[1]).join(","),
    longitude: grid.map((p) => p[0]).join(","),
    daily: "river_discharge",
    past_days: "7",
    forecast_days: "0",
    timezone: "GMT",
  });
  const res = await fetch("https://flood-api.open-meteo.com/v1/flood", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!res.ok) {
    console.error(`request ${i / POINTS_PER_REQUEST + 1} answered ${res.status}: ${(await res.text()).slice(0, 160)}; stopping with ${points.length} points`);
    break;
  }
  const rows = (await res.json()) as { daily?: { river_discharge?: (number | null)[] } }[];
  chunk.forEach((w, c) => {
    let best: { cell: Position; mean: number } | null = null;
    OFFSETS.forEach((_, k) => {
      const vals = (rows[c * OFFSETS.length + k]?.daily?.river_discharge ?? []).filter((v): v is number => typeof v === "number");
      if (vals.length === 0) return;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (!best || mean > best.mean) best = { cell: grid[c * OFFSETS.length + k], mean };
    });
    if (best) points.push({ name: w.name, at: w.at, cell: (best as { cell: Position }).cell });
  });
  console.log(`snapped ${points.length} of ${Math.min(wanted.length, i + POINTS_PER_REQUEST)}`);
  if (i + POINTS_PER_REQUEST < wanted.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
}

writeFileSync(OUT, `${JSON.stringify({ region: BOX, built: new Date().toISOString().slice(0, 10), source: "Natural Earth 10m rivers; GloFAS cells via the Open-Meteo flood API", points }, null, 1)}\n`);
console.log(`wrote ${points.length} points of ${new Set(points.map((p) => p.name)).size} rivers to data/river-points.json`);

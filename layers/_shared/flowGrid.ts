/**
 * A vector field on a regular grid from Open-Meteo (spec §13a: currents and wind as moving particles), shared by the
 * ocean-currents and wind-flow layers. The box is covered by at most `maxNodes` nodes about equally far apart in km,
 * one multi-location request (POSTed: latitude=…&longitude=… as comma lists) reads every node's hourly speed, direction
 * and a second variable, and each node becomes a Point feature (its grid index under `node`, its position as `name`)
 * with its `east` and `north` parts in m/s, its speed
 * and the second variable at the frame of the query, and all of them per hour under `series`. Nodes the model has no
 * value for (land, for currents) keep nulls, so particles die there. The result's `flow` names the grid for the
 * particle layer (lib/render/particles.ts) and `series` the hours for the scrubber.
 */
import { z } from "zod";
import type { Feature, FeatureCollection } from "geojson";
import type { BBox, FlowField, QueryContext, SeriesAxis } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

/** Where the nodes go: `nx` across and `ny` up, the outer ones on the box's edges, about equally far apart in km. */
export function gridFor(bbox: BBox, maxNodes: number): { nx: number; ny: number; lons: number[]; lats: number[] } {
  const [w, s, e, n] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const widthKm = Math.max(1, (e - w) * 111.32 * Math.cos(midLat));
  const heightKm = Math.max(1, (n - s) * 110.57);
  const spacing = Math.sqrt((widthKm * heightKm) / maxNodes);
  let nx = Math.max(2, Math.round(widthKm / spacing) + 1);
  let ny = Math.max(2, Math.round(heightKm / spacing) + 1);
  while (nx * ny > maxNodes) {
    if (nx >= ny) nx -= 1;
    else ny -= 1;
  }
  const lons = Array.from({ length: nx }, (_, i) => Number((w + ((e - w) * i) / (nx - 1)).toFixed(4)));
  const lats = Array.from({ length: ny }, (_, j) => Number((s + ((n - s) * j) / (ny - 1)).toFixed(4)));
  return { nx, ny, lons, lats };
}

/** One node's hourly values, as Open-Meteo names them. */
type Hourly = { time: string[] } & Record<string, (number | null)[] | string[]>;

const Row = z.object({ hourly: z.object({ time: z.array(z.string()) }).catchall(z.array(z.number().nullable())) });

export type FlowRequest = {
  url: string;
  /** Hourly variables: speed, direction (degrees), and the second variable. */
  speed: string;
  direction: string;
  color?: string;
  /** Extra query parameters (units, models). */
  params?: Record<string, string>;
  /** How the speed arrives: km/h is divided by 3.6. */
  speedUnit: "km/h" | "m/s";
  /** Currents give the direction the water flows toward; wind the direction it comes from. */
  directionIs: "toward" | "from";
  pastDays: number;
  forecastDays: number;
  cacheKey: string;
  ttlSeconds: number;
};

/** Reads every node's hourly values in batches; null for a batch that failed. */
async function readNodes(ctx: QueryContext, req: FlowRequest, points: [number, number][]): Promise<(Hourly | null)[] | { error: string }> {
  const BATCH = 200;
  const out: (Hourly | null)[] = [];
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    const body = new URLSearchParams({
      latitude: batch.map((p) => p[1].toFixed(4)).join(","),
      longitude: batch.map((p) => p[0].toFixed(4)).join(","),
      hourly: [req.speed, req.direction, ...(req.color ? [req.color] : [])].join(","),
      past_days: String(req.pastDays),
      forecast_days: String(req.forecastDays),
      timezone: "GMT",
      ...req.params,
    });
    try {
      const res = await ctx.fetch(req.url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        cacheKey: `${req.cacheKey}:${i}`,
        ttlSeconds: req.ttlSeconds,
        timeoutMs: UPSTREAM_TIMEOUT_MS * 2,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const reason = /limit exceeded/i.test(text) ? "its free request limit is used up for now" : `it returned ${res.status}`;
        return { error: `Open-Meteo did not answer: ${reason}` };
      }
      const json: unknown = await res.json();
      const rows = Array.isArray(json) ? json : [json];
      for (let k = 0; k < batch.length; k++) {
        const parsed = Row.safeParse(rows[k]);
        out.push(parsed.success ? (parsed.data.hourly as Hourly) : null);
      }
    } catch {
      return { error: "Open-Meteo did not answer in time" };
    }
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** "60.88°N 151.04°W": a grid node by its position. */
export function nodeName(lon: number, lat: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

/**
 * The field: one Point per node, row by row from the south-west corner, with `u`, `v`, `speed` (m/s) and the second
 * variable under `color` at the frame `now`, and per hour under `series`. Null when no node had any value.
 */
export function fieldFeatures(
  grid: { nx: number; ny: number; lons: number[]; lats: number[] },
  rows: (Hourly | null)[],
  req: Pick<FlowRequest, "speed" | "direction" | "color" | "speedUnit" | "directionIs">,
  nowIso: string,
  colorKey: string,
): { data: FeatureCollection; series: SeriesAxis } | null {
  const times = rows.find((r) => r !== null)?.time;
  if (!times || times.length === 0) return null;
  const hour = nowIso.slice(0, 13);
  let now = times.findLastIndex((t) => t.slice(0, 13) <= hour);
  if (now < 0) now = 0;
  const features: Feature[] = [];
  let any = false;
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const row = rows[j * grid.nx + i];
      const speeds = (row?.[req.speed] as (number | null)[] | undefined) ?? [];
      const dirs = (row?.[req.direction] as (number | null)[] | undefined) ?? [];
      const second = req.color ? ((row?.[req.color] as (number | null)[] | undefined) ?? []) : [];
      const u: (number | null)[] = [];
      const v: (number | null)[] = [];
      const speed: (number | null)[] = [];
      const color: (number | null)[] = [];
      for (let k = 0; k < times.length; k++) {
        const sRaw = speeds[k];
        const d = dirs[k];
        if (typeof sRaw !== "number" || typeof d !== "number") {
          u.push(null);
          v.push(null);
          speed.push(null);
        } else {
          const s = req.speedUnit === "km/h" ? sRaw / 3.6 : sRaw;
          const rad = (d * Math.PI) / 180;
          const sign = req.directionIs === "toward" ? 1 : -1;
          u.push(r2(sign * s * Math.sin(rad)));
          v.push(r2(sign * s * Math.cos(rad)));
          speed.push(r2(s));
          any = true;
        }
        const c = second[k];
        color.push(typeof c === "number" ? r2(c) : null);
      }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [grid.lons[i], grid.lats[j]] },
        properties: {
          // Where the node is, as the summary names it (the grid has no place names).
          name: nodeName(grid.lons[i], grid.lats[j]),
          // The node's place in the grid (row by row from the south-west), so a result may leave out nodes with no data.
          node: j * grid.nx + i,
          east: u[now],
          north: v[now],
          speed: speed[now],
          ...(req.color && { [colorKey]: color[now] }),
          series: { east: u, north: v, speed, ...(req.color && { [colorKey]: color }) },
        },
      });
    }
  }
  if (!any) return null;
  return {
    data: { type: "FeatureCollection", features },
    series: {
      times: times.map((t) => new Date(`${t}:00Z`).toISOString()),
      step: "hour",
      now,
      ...(now < times.length - 1 && { forecastFrom: now + 1 }),
    },
  };
}

/** Most cells a side of the water mask has. */
const MASK_MAX = 96;
/** The smallest mask cell, in degrees (about 2 km). */
const MASK_MIN_DEG = 0.02;

/**
 * A water mask over `bbox` from a land test: cells about MASK_MIN_DEG or larger, at most MASK_MAX a side, one bit each
 * (1 water), base64; null when the land test is not available.
 */
export function waterMask(bbox: BBox, isLand: (lon: number, lat: number) => boolean): FlowField["water"] | null {
  const [w, s, e, n] = bbox;
  const nx = Math.max(2, Math.min(MASK_MAX, Math.ceil((e - w) / MASK_MIN_DEG)));
  const ny = Math.max(2, Math.min(MASK_MAX, Math.ceil((n - s) / MASK_MIN_DEG)));
  const bytes = new Uint8Array(Math.ceil((nx * ny) / 8));
  try {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const lon = w + ((i + 0.5) / nx) * (e - w);
        const lat = s + ((j + 0.5) / ny) * (n - s);
        if (!isLand(lon, lat)) {
          const k = j * nx + i;
          bytes[k >> 3] |= 1 << (k & 7);
        }
      }
    }
  } catch {
    return null;
  }
  return { nx, ny, bits: Buffer.from(bytes).toString("base64") };
}

/** Reads a field over `bbox` with at most `maxNodes` nodes; the result's parts, or an error. */
export async function readField(
  ctx: QueryContext,
  req: FlowRequest,
  maxNodes: number,
  colorKey: string,
): Promise<{ data: FeatureCollection; series: SeriesAxis; flow: FlowField } | { error: string }> {
  const grid = gridFor(ctx.bbox, maxNodes);
  const points: [number, number][] = [];
  for (const lat of grid.lats) for (const lon of grid.lons) points.push([lon, lat]);
  const rows = await readNodes(ctx, req, points);
  if ("error" in rows) return rows;
  const built = fieldFeatures(grid, rows, req, new Date().toISOString(), colorKey);
  if (!built) return { error: "Open-Meteo has no values for this box (for currents: is it on land?)" };
  return {
    ...built,
    flow: {
      nx: grid.nx,
      ny: grid.ny,
      bbox: [grid.lons[0], grid.lats[0], grid.lons[grid.nx - 1], grid.lats[grid.ny - 1]],
      u: "east",
      v: "north",
      ...(req.color && { color: colorKey }),
    },
  };
}

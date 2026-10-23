import { inflateSync } from "node:zlib";
import type { Feature, LineString, MultiLineString, Position } from "geojson";
import { gainLoss } from "@/lib/render/wally/sample";
import { haversineKm } from "./geo";

/**
 * Whole hikes from OpenStreetMap ways (audit R4, 2026-10-23): a trail is mapped as many ways, split at every junction
 * and bridge, so Boulder came back as 2,000 of 59,830 ways and Portland's Wildwood Trail (30 miles) as 10.8 and 8.5 km
 * pieces. Ways of one name that touch are one hike, with its whole length, its ends, whether it is a loop or an out and
 * back, and its climb, read from the AWS Terrain Tiles (Terrarium PNGs, open data, about 30 m in the US) until the
 * terrain helper in lib/spatial lands. Pure apart from the tile fetches.
 */

/* ---------- Grouping ways into hikes ---------- */

/** How far apart two way ends may be and still join (a mapped junction is the same node; a bridge leaves a small gap). */
const JOIN_M = 40;
/** Pieces of one name this close at their ends are one trail with a way missing between them. */
const GAP_M = 1_000;
/** A hike whose two ends lie this close together is a loop. */
const LOOP_M = 150;

const fold = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function linesOf(f: Feature): Position[][] {
  const g = f.geometry;
  if (g?.type === "LineString") return [g.coordinates];
  if (g?.type === "MultiLineString") return g.coordinates;
  return [];
}

function lineKm(line: Position[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

const close = (a: Position, b: Position, m: number) => haversineKm(a, b) * 1000 <= m;

/** Lines joined end to end where they meet (either direction), longest chain first. */
export function chainLines(lines: Position[][]): Position[][] {
  const pool = lines.filter((l) => l.length >= 2).map((l) => [...l]);
  const chains: Position[][] = [];
  while (pool.length > 0) {
    let chain = pool.shift() as Position[];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        const [head, tail] = [chain[0], chain[chain.length - 1]];
        if (close(tail, l[0], JOIN_M)) chain = [...chain, ...l.slice(1)];
        else if (close(tail, l[l.length - 1], JOIN_M)) chain = [...chain, ...[...l].reverse().slice(1)];
        else if (close(head, l[l.length - 1], JOIN_M)) chain = [...l.slice(0, -1), ...chain];
        else if (close(head, l[0], JOIN_M)) chain = [...[...l].reverse().slice(0, -1), ...chain];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => lineKm(b) - lineKm(a));
}

/** The ways of one name that touch one another, as groups (union-find over their ends). */
function connected(ways: Feature[]): Feature[][] {
  const parent = ways.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = ways.map((w) => linesOf(w).flatMap((l) => [l[0], l[l.length - 1]]));
  const all = ways.map((w) => linesOf(w).flat());
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      if (find(i) === find(j)) continue;
      // Ends meet, or one way's end lies on a vertex of the other (a trail that joins mid-way).
      const meet = ends[i].some((a) => ends[j].some((b) => close(a, b, JOIN_M))) || ends[i].some((a) => all[j].some((b) => close(a, b, JOIN_M / 4))) || ends[j].some((a) => all[i].some((b) => close(a, b, JOIN_M / 4)));
      if (meet) parent[find(i)] = find(j);
    }
  }
  // Pieces of one name whose ends lie within GAP_M are one trail with a way missing between them (the box held more
  // ways than came back, or a junction is mapped apart): Portland's Wildwood Trail came back as four pieces.
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      if (find(i) !== find(j) && ends[i].some((a) => ends[j].some((b) => close(a, b, GAP_M)))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Feature[]>();
  ways.forEach((w, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), w]);
  });
  return [...groups.values()];
}

const SAC_ORDER = ["hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking"];

/** The hardest rated difficulty among the ways, else not rated. */
function hardest(ways: Feature[], notRated: string): string {
  let best = -1;
  for (const w of ways) best = Math.max(best, SAC_ORDER.indexOf(String(w.properties?.sac_scale ?? "")));
  return best >= 0 ? SAC_ORDER[best] : notRated;
}

/** The most common value of a property among the ways. */
function commonest(ways: Feature[], key: string): string | undefined {
  const counts = new Map<string, number>();
  for (const w of ways) {
    const v = w.properties?.[key];
    if (typeof v === "string" && v !== "") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Named ways merged into whole hikes, one per name and connected piece (two trails called "Lake Trail" in one box stay
 * two), longest first, followed by the unnamed ways as they are: kind and sac_scale (the hardest of its ways),
 * lengthKm (the whole hike in view), shape loop or out and back with roundTripKm, its two ends (start, end) and how
 * many ways it joins. A hike that branches (three ends or more) is a trail network: no round trip.
 */
export function mergeHikes(ways: Feature[], notRated = "not_rated"): Feature[] {
  const byName = new Map<string, Feature[]>();
  const unnamed: Feature[] = [];
  for (const w of ways) {
    const name = typeof w.properties?.name === "string" ? w.properties.name : "";
    if (!name) unnamed.push(w);
    else byName.set(fold(name), [...(byName.get(fold(name)) ?? []), w]);
  }
  const hikes: Feature<LineString | MultiLineString>[] = [];
  for (const group of byName.values()) {
    for (const part of connected(group)) {
      const chains = chainLines(part.flatMap(linesOf));
      if (chains.length === 0) continue;
      const lengthKm = part.reduce((s, w) => s + linesOf(w).reduce((t, l) => t + lineKm(l), 0), 0);
      const main = chains[0];
      const start = main[0];
      const end = main[main.length - 1];
      const loop = chains.length === 1 && close(start, end, LOOP_M);
      const network = chains.length > 1;
      const first = part[0].properties ?? {};
      const properties: Record<string, string | number | boolean> = {
        name: String(first.name),
        kind: commonest(part, "kind") ?? "path",
        sac_scale: hardest(part, notRated),
        lengthKm: round(lengthKm),
        shape: loop ? "loop" : network ? "network" : "out-and-back",
        ways: part.length,
        start: `${round(start[1], 5)}, ${round(start[0], 5)}`,
        end: `${round(end[1], 5)}, ${round(end[0], 5)}`,
        osmId: String(first.osmId ?? ""),
      };
      if (!network) properties.roundTripKm = round(loop ? lengthKm : 2 * lengthKm);
      for (const key of ["trail_visibility", "surface", "wikidata", "wikipedia"]) {
        const v = commonest(part, key);
        if (v !== undefined) properties[key] = v;
      }
      if (part.every((w) => w.properties?.informal === true)) properties.informal = true;
      hikes.push({
        type: "Feature",
        geometry: chains.length === 1 ? { type: "LineString", coordinates: main } : { type: "MultiLineString", coordinates: chains },
        properties,
      });
    }
  }
  hikes.sort((a, b) => Number(b.properties?.lengthKm) - Number(a.properties?.lengthKm));
  return [...hikes, ...unnamed];
}

/* ---------- Climb from terrain tiles ---------- */

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_ZOOM = 12;
const TILE_SIZE = 256;
/** Tiles kept in memory across queries (each 256 KB as floats). */
const TILE_CACHE_MAX = 48;
const tileCache = new Map<string, Promise<Float32Array | null>>();

/** A Terrarium PNG's elevations in metres (8-bit RGB or RGBA, non-interlaced), or null when it cannot be read. */
export function decodeTerrarium(png: Uint8Array): Float32Array | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || !sig.every((b, i) => png[i] === b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || data[12] !== 0) return null;
      channels = color === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!width || !height || !channels || idat.length === 0) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Float32Array(width * height);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      row[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const o = px * channels;
      out[y * width + px] = row[o] * 256 + row[o + 1] + row[o + 2] / 256 - 32768;
    }
    prev.set(row);
  }
  return out;
}

async function tile(x: number, y: number, fetchImpl: typeof fetch): Promise<Float32Array | null> {
  const key = `${TILE_ZOOM}/${x}/${y}`;
  let found = tileCache.get(key);
  if (!found) {
    found = fetchImpl(`${TILE_URL}/${key}.png`, { signal: AbortSignal.timeout(8_000) })
      .then(async (res) => (res.ok ? decodeTerrarium(new Uint8Array(await res.arrayBuffer())) : null))
      .catch(() => null);
    tileCache.set(key, found);
    if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value as string);
  }
  return found;
}

/** Where a point falls in the zoom-12 tile grid: the tile and the pixel (fractional). */
function tilePixel([lng, lat]: Position): { x: number; y: number; px: number; py: number } {
  const n = 2 ** TILE_ZOOM;
  const fx = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return { x, y, px: (fx - x) * TILE_SIZE, py: (fy - y) * TILE_SIZE };
}

/** Points every `stepKm` along a line, ends included, at most `max`. */
export function along(line: Position[], stepKm: number, max: number): Position[] {
  const total = lineKm(line);
  const step = Math.max(stepKm, total / max);
  const out: Position[] = [line[0]];
  let carried = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = haversineKm(line[i - 1], line[i]);
    let d = step - carried;
    while (d <= seg) {
      const t = d / seg;
      out.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]);
      d += step;
    }
    carried = (carried + seg) % step;
  }
  out.push(line[line.length - 1]);
  return out;
}

export type ClimbOptions = { fetch?: typeof fetch; maxTiles?: number; maxHikes?: number; budgetMs?: number };

/**
 * Each hike's climb, from terrain tiles along its longest chain sampled every 50 m: gainM (the climb walking it from
 * start to end), lossM, roundTripGainM for an out and back (up and back down: gain plus loss), gainPerKm, and its
 * lowest and highest points. The longest hikes go first, within `maxTiles` tiles and `budgetMs`; the rest keep no
 * climb. Returns how many hikes got one.
 */
export async function addClimb(hikes: Feature[], opts: ClimbOptions = {}): Promise<number> {
  const fetchImpl = opts.fetch ?? fetch;
  const maxTiles = opts.maxTiles ?? 64;
  const deadline = Date.now() + (opts.budgetMs ?? 9_000);
  const named = hikes.filter((h) => typeof h.properties?.name === "string").slice(0, opts.maxHikes ?? 150);
  const tilesUsed = new Set<string>();
  let done = 0;
  for (const hike of named) {
    if (Date.now() > deadline) break;
    const main = chainLines(linesOf(hike))[0];
    if (!main || main.length < 2) continue;
    const points = along(main, 0.05, 400);
    const cells = points.map(tilePixel);
    const keys = new Set(cells.map((c) => `${c.x}/${c.y}`));
    const fresh = [...keys].filter((k) => !tilesUsed.has(k));
    if (tilesUsed.size + fresh.length > maxTiles) continue;
    for (const k of fresh) tilesUsed.add(k);
    const tiles = new Map<string, Float32Array | null>();
    await Promise.all([...keys].map(async (k) => tiles.set(k, await tile(Number(k.split("/")[0]), Number(k.split("/")[1]), fetchImpl))));
    const heights = cells.map((c) => {
      const data = tiles.get(`${c.x}/${c.y}`);
      if (!data) return null;
      // Bilinear between the four pixel centres around the point (clamped at the tile edge).
      const fx = Math.min(TILE_SIZE - 1.001, Math.max(0, c.px - 0.5));
      const fy = Math.min(TILE_SIZE - 1.001, Math.max(0, c.py - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const at = (x: number, y: number) => data[y * TILE_SIZE + x];
      const v = at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty;
      return Number.isFinite(v) && v > -500 ? v : null;
    });
    const known = heights.filter((h): h is number => h !== null);
    if (known.length < Math.max(2, heights.length * 0.8)) continue;
    // A trail cut across a slope reads the pixel beside it now and then: wiggles under 8 m are noise, not climb.
    const { gain, loss } = gainLoss(heights, 8);
    const props = hike.properties ?? {};
    // The climb is along the longest stretch, so is its rate (a trail network's other branches are not walked here).
    const lengthKm = lineKm(main);
    props.gainM = Math.round(gain);
    props.lossM = Math.round(loss);
    props.gainPerKm = lengthKm > 0 ? round(gain / lengthKm, 1) : 0;
    props.highM = Math.round(Math.max(...known));
    props.lowM = Math.round(Math.min(...known));
    if (props.shape === "out-and-back") props.roundTripGainM = Math.round(gain + loss);
    else if (props.shape === "loop") props.roundTripGainM = Math.round(gain);
    hike.properties = props;
    done += 1;
  }
  return done;
}

/** Forgets cached tiles; for tests. */
export function resetTerrainTiles(): void {
  tileCache.clear();
}

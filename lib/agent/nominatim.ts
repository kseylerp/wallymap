import type { BBox } from "@/layers/types";

/**
 * Natural features and named routes from OpenStreetMap's own search (Nominatim), for the names the place geocoder gets
 * wrong (audit R2, 2026-10-23): Mapbox has no natural features, so "Lake Powell" was a town in Victoria, Australia,
 * "Tomales Bay" a street in Las Vegas and "Mount Rainier" the town in Maryland. Nominatim knows the reservoir, the bay,
 * the volcano and the river with their real extents.
 *
 * Usage policy (operations.osmfoundation.org/policies/nominatim): at most one request per second for the whole app,
 * an identifying User-Agent, and results cached. Every request here waits its turn in one queue spaced 1.1 s apart, and
 * answers are kept for a day, so a repeat lookup never reaches the service.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "WallyMap/1.0 (outdoor map research; https://wallymap.vercel.app)";
// Tests run against mocked fetch, where waiting would only slow them.
const SPACING_MS = process.env.VITEST ? 0 : 1_100;
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 86_400_000;

export type OsmPlace = {
  name: string;
  label: string;
  category: string;
  type: string;
  importance: number;
  bbox: BBox;
  center: [number, number];
};

let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;
const cache = new Map<string, { at: number; value: OsmPlace[] }>();

/** Runs `fn` after the requests queued before it, at least SPACING_MS after the last one started. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Forgets cached answers and the queue's clock; for tests. */
export function resetNominatim(): void {
  cache.clear();
  lastAt = 0;
}

function parse(raw: unknown): OsmPlace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const box = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : [];
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (box.length !== 4 || !box.every(Number.isFinite) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [south, north, west, east] = box;
  return {
    name: typeof r.name === "string" && r.name !== "" ? r.name : String(r.display_name ?? "").split(",")[0],
    label: String(r.display_name ?? ""),
    category: String(r.category ?? r.class ?? ""),
    type: String(r.type ?? ""),
    importance: Number(r.importance ?? 0) || 0,
    bbox: [west, south, east, north],
    center: [lon, lat],
  };
}

/** Places matching `query`, most important first as Nominatim ranks them; empty on any failure. Never throws. */
export async function nominatimSearch(query: string, limit = 10): Promise<OsmPlace[]> {
  const key = `${query.toLowerCase().trim()}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const value = await inTurn(async () => {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(limit));
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT, "accept-language": "en" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      return Array.isArray(body) ? body.map(parse).filter((p): p is OsmPlace => p !== null) : [];
    });
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return [];
  }
}

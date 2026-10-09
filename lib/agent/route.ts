import type { LineString, Position } from "geojson";
import { z } from "zod";
import type { BBox } from "@/layers/types";
import { createLayerFetch, type CachedFetch } from "@/lib/fetch";
import type { RouteState } from "@/lib/render/state";
import { geocode as defaultGeocode, type GeocodeError, type GeocodeResult } from "./geocode";

/** The `route` tool (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md §6): Mapbox Directions v5. */

export const ROUTE_PROFILES = ["walking", "cycling", "driving"] as const;
export type RouteProfile = (typeof ROUTE_PROFILES)[number];

const ENDPOINT = "https://api.mapbox.com/directions/v5/mapbox";
const TTL_SECONDS = 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Simplification starts at this tolerance and doubles until the line has at most `MAX_POINTS` vertices. */
const SIMPLIFY_TOLERANCE_M = 2;
/** Keeps a long driving route small enough to resend with the chat history (the chat route caps requests at 256 KB). */
const MAX_POINTS = 1500;
/** Five decimals is about a meter, plenty for a drawn route. */
const COORD_DECIMALS = 5;

export type RouteWaypoint = RouteState["waypoints"][number] & { name?: string };

export type FetchedRoute = {
  line: LineString;
  distanceKm: number;
  durationMin: number;
  waypoints: RouteWaypoint[];
};

export type RouteError = { error: string };

const LngLat = z.tuple([z.number(), z.number()]);
const directionsSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  routes: z
    .array(
      z.object({
        distance: z.number(),
        duration: z.number(),
        geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(LngLat) }),
      }),
    )
    .optional(),
  waypoints: z.array(z.object({ name: z.string().optional(), location: LngLat })).optional(),
});

const errorBodySchema = z.object({ message: z.string().optional() });

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** Perpendicular distance in meters from `p` to segment `a`–`b` on a local flat projection. */
function offsetMeters(p: Position, a: Position, b: Position): number {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_574;
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * ky;
  const dx = (b[0] - a[0]) * kx;
  const dy = (b[1] - a[1]) * ky;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/** Douglas–Peucker with an explicit stack (a long line would overflow recursion). */
function douglasPeucker(coords: Position[], toleranceM: number): Position[] {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let worstAt = -1;
    for (let i = start + 1; i < end; i++) {
      const d = offsetMeters(coords[i], coords[start], coords[end]);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst > toleranceM) {
      keep[worstAt] = 1;
      stack.push([start, worstAt], [worstAt, end]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

/**
 * Rounds to about a meter, drops repeated vertices, and simplifies (2 m tolerance, loosened until the line has
 * at most 1500 vertices) so a long route stays small in the chat history.
 */
export function simplifyLine(coords: Position[], maxPoints = MAX_POINTS): Position[] {
  const rounded: Position[] = [];
  for (const [lng, lat] of coords) {
    const p: Position = [round(lng, COORD_DECIMALS), round(lat, COORD_DECIMALS)];
    const last = rounded[rounded.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) rounded.push(p);
  }
  let tolerance = SIMPLIFY_TOLERANCE_M;
  let out = douglasPeucker(rounded, tolerance);
  while (out.length > maxPoints) {
    tolerance *= 2;
    out = douglasPeucker(rounded, tolerance);
  }
  return out;
}

/** The Directions request URL without the token (also the cache key). */
export function directionsPath(from: [number, number], to: [number, number], profile: RouteProfile): string {
  const pair = ([lng, lat]: [number, number]) => `${round(lng, 6)},${round(lat, 6)}`;
  return `${ENDPOINT}/${profile}/${pair(from)};${pair(to)}?geometries=geojson&overview=full`;
}

let sharedFetch: CachedFetch | undefined;

/**
 * A route between two points from Mapbox Directions v5, simplified for drawing. Cached for 24 hours by request.
 * Never throws: failures come back as `{ error }`.
 */
export async function fetchRoute(
  { from, to, profile }: { from: [number, number]; to: [number, number]; profile: RouteProfile },
  fetchImpl?: CachedFetch,
): Promise<FetchedRoute | RouteError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return { error: "MAPBOX_TOKEN is not set" };
  const path = directionsPath(from, to, profile);
  const fetch = fetchImpl ?? (sharedFetch ??= createLayerFetch("route", { ttlSeconds: TTL_SECONDS }));
  try {
    const res = await fetch(`${path}&access_token=${encodeURIComponent(token)}`, {
      cacheKey: `route:${path}`,
      ttlSeconds: TTL_SECONDS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // A non-JSON error page; reported by status below.
    }
    const body = directionsSchema.safeParse(json);
    if (!res.ok) {
      const upstream = errorBodySchema.safeParse(json);
      const message = upstream.success && upstream.data.message ? `: ${upstream.data.message}` : "";
      return { error: `Directions failed with HTTP ${res.status}${message}` };
    }
    if (!body.success) return { error: "Directions returned an unexpected response" };
    const route = body.data.routes?.[0];
    if (body.data.code !== "Ok" || !route) {
      return { error: body.data.message ?? `No ${profile} route found (${body.data.code})` };
    }
    const coordinates = simplifyLine(route.geometry.coordinates);
    if (coordinates.length < 2) return { error: `No ${profile} route found: the two places are the same point` };
    const located = body.data.waypoints ?? [];
    const waypoints: RouteWaypoint[] = located.map((w, i) => ({
      lngLat: [round(w.location[0], 6), round(w.location[1], 6)],
      type: i === 0 ? "start" : i === located.length - 1 ? "end" : "via",
      ...(w.name ? { name: w.name } : {}),
    }));
    return {
      line: { type: "LineString", coordinates },
      distanceKm: round(route.distance / 1000, 2),
      durationMin: Math.round(route.duration / 60),
      waypoints,
    };
  } catch (err) {
    // A network error can echo the request URL; never hand the token to the model or the chat.
    const message = String(err).split(token).join("[token]").split(encodeURIComponent(token)).join("[token]");
    return { error: `Directions failed: ${message}` };
  }
}

export type RouteToolInput = {
  from: string | [number, number];
  to: string | [number, number];
  profile?: RouteProfile;
  name?: string;
};

export type RouteToolOutput = FetchedRoute & {
  id: string;
  name: string;
  profile: RouteProfile;
  bbox: BBox;
  /** The geocoded names of the two ends (or their coordinates, when given as coordinates). */
  resolved: { from: string; to: string };
};

type Deps = {
  geocode?: (place: string, opts?: { proximity?: [number, number] }) => Promise<GeocodeResult | GeocodeError>;
  fetch?: CachedFetch;
};

/** The line's [west, south, east, north]. */
export function lineBBox(line: LineString): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of line.coordinates) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

const MAX_ID_LENGTH = 60;

/** FNV-1a, as 8 hex digits: a short, stable fingerprint (no node:crypto, so it runs anywhere). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A Mapbox-safe id; a long one keeps its start and swaps the tail for a hash of the whole, so two long ids sharing a prefix stay apart. */
export function routeId(text: string): string {
  const full =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "route";
  if (full.length <= MAX_ID_LENGTH) return full;
  return `${full.slice(0, MAX_ID_LENGTH - 9).replace(/-+$/, "")}-${fnv1a(full)}`;
}

function label(place: string | [number, number]): string {
  return typeof place === "string" ? place.trim() : `${place[1].toFixed(4)}, ${place[0].toFixed(4)}`;
}

type Resolved = { lngLat: [number, number]; found?: string };

async function resolve(
  place: string | [number, number],
  geocode: NonNullable<Deps["geocode"]>,
  proximity?: [number, number],
): Promise<Resolved | RouteError> {
  if (typeof place !== "string") return { lngLat: place };
  const found = await geocode(place, proximity ? { proximity } : undefined);
  if ("error" in found) return { error: `Could not find ${place}: ${found.error}` };
  return { lngLat: found.center, found: found.name };
}

/**
 * The `route` tool: geocodes place names, asks Directions for a route, and returns the line with an id (stable
 * for the same request, so asking twice replaces the drawn route), a name, and its bbox for the camera fit. A
 * failure names the places the names resolved to, so the model can see "Emerald Bay" landed in Laguna Beach and
 * retry with a fuller name.
 */
export async function runRouteTool(input: RouteToolInput, deps: Deps = {}): Promise<RouteToolOutput | RouteError> {
  const profile = input.profile ?? "walking";
  const geocode = deps.geocode ?? defaultGeocode;
  // The start resolves first and biases the end's lookup toward it: a route's two ends are near each other.
  const from = await resolve(input.from, geocode);
  if ("error" in from) return from;
  const to = await resolve(input.to, geocode, from.lngLat);
  if ("error" in to) return to;
  const fetched = await fetchRoute({ from: from.lngLat, to: to.lngLat, profile }, deps.fetch);
  if ("error" in fetched) {
    const places = [from, to].flatMap((r, i) => (r.found ? [`${label([input.from, input.to][i])} resolved to ${r.found}`] : []));
    return places.length > 0 ? { error: `${fetched.error} (${places.join("; ")})` } : fetched;
  }
  const name = input.name?.trim() || `${label(input.from)} to ${label(input.to)}`;
  return {
    id: routeId(`${profile} ${label(input.from)} to ${label(input.to)}`),
    name,
    profile,
    ...fetched,
    bbox: lineBBox(fetched.line),
    // Where each end landed, so the model can tell the user (and catch a wrong "Emerald Bay").
    resolved: { from: from.found ?? label(input.from), to: to.found ?? label(input.to) },
  };
}

/** What the model sees for a route (also what the browser resends): everything but the line's coordinates. */
export { routeOutputForModel } from "./compactMessages";

import type { LineString, Position } from "geojson";
import { z } from "zod";
import type { BBox } from "@/layers/types";
import { createLayerFetch, type CachedFetch } from "@/lib/fetch";
import type { RouteState } from "@/lib/render/state";
import { distanceKm, geocodeWaypoint, type GeocodeError, type GeocodeResult, type WaypointOptions } from "./geocode";
import type { MapView } from "./view";

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
export function directionsPath(
  from: [number, number],
  to: [number, number],
  profile: RouteProfile,
  via: [number, number][] = [],
): string {
  const pair = ([lng, lat]: [number, number]) => `${round(lng, 6)},${round(lat, 6)}`;
  const stops = [from, ...via, to].map(pair).join(";");
  return `${ENDPOINT}/${profile}/${stops}?geometries=geojson&overview=full`;
}

let sharedFetch: CachedFetch | undefined;

/**
 * A route between two points from Mapbox Directions v5, simplified for drawing. Cached for 24 hours by request.
 * Never throws: failures come back as `{ error }`.
 */
export async function fetchRoute(
  { from, to, profile, via }: { from: [number, number]; to: [number, number]; profile: RouteProfile; via?: [number, number][] },
  fetchImpl?: CachedFetch,
): Promise<FetchedRoute | RouteError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return { error: "MAPBOX_TOKEN is not set" };
  const path = directionsPath(from, to, profile, via);
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
  /** Trails or places to pass along the way, in order ("Mist Trail"); "X via Y" in `to` means the same. */
  via?: string | string[];
  profile?: RouteProfile;
  name?: string;
};

export type RouteToolOutput = FetchedRoute & {
  id: string;
  name: string;
  profile: RouteProfile;
  bbox: BBox;
  /** The geocoded names of the two ends (or their coordinates, when given as coordinates). */
  resolved: { from: string; to: string; via?: string[] };
  /** What the model should tell the user, such as a trail that could not be located and was left out. */
  notes?: string[];
};

type Deps = {
  geocode?: (place: string, opts?: WaypointOptions) => Promise<GeocodeResult | GeocodeError>;
  fetch?: CachedFetch;
  /** The map the user is looking at: centres the first lookup and, at zoom 8 and closer, limits it to the view. */
  view?: MapView | null;
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
type Geocoder = NonNullable<Deps["geocode"]>;

/** At zoom 8 and closer the view is a region the user means; wider than that, only its centre biases the lookup. */
const VIEW_BBOX_MIN_ZOOM = 8;
/** Two waypoints more than this many view-spans apart are probably one wrong match. */
const FAR_VIEW_SPANS = 10;
/** A tiny view (a block or two) still allows a 50 km route. */
const MIN_VIEW_SPAN_KM = 5;
/** Nobody walks farther than this between two named places in one request. */
const MAX_WALKING_KM = 300;
/** A named trail more than this far from the place before it is a different trail with the same name. */
const MAX_TRAIL_OFFSET_KM = 25;

const KM_PER_DEGREE = 111.32;

/** The longer side of the view's box in km, or null when the view has no box (the whole globe). */
function viewSpanKm(view: MapView | null | undefined): number | null {
  if (!view?.bbox) return null;
  const [w, s, e, n] = view.bbox;
  const width = (e - w) * KM_PER_DEGREE * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return Math.max(width, (n - s) * KM_PER_DEGREE);
}

/** How far apart two consecutive waypoints may be before the later one is doubted; null for no limit. */
function farLimitKm(view: MapView | null | undefined, profile: RouteProfile): number | null {
  const span = viewSpanKm(view);
  const limits = [
    span === null ? null : FAR_VIEW_SPANS * Math.max(span, MIN_VIEW_SPAN_KM),
    profile === "walking" ? MAX_WALKING_KM : null,
  ].filter((limit): limit is number => limit !== null);
  return limits.length > 0 ? Math.min(...limits) : null;
}

/** A box of `radiusKm` around a point. */
function boxAround([lng, lat]: [number, number], radiusKm: number): BBox {
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLng = radiusKm / (KM_PER_DEGREE * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** "Nevada Fall via the Mist Trail" is the place "Nevada Fall" and the trail "Mist Trail". */
function splitVia(place: string | [number, number]): { place: string | [number, number]; via: string[] } {
  if (typeof place !== "string") return { place, via: [] };
  const match = /^(.+?)\s+via\s+(?:the\s+)?(.+)$/i.exec(place.trim());
  return match ? { place: match[1].trim(), via: [match[2].trim()] } : { place, via: [] };
}

type Stop = { place: string | [number, number]; trail: boolean };

function noneIfEmpty(opts: WaypointOptions): WaypointOptions | undefined {
  return opts.proximity || opts.bbox ? opts : undefined;
}

/**
 * The `route` tool: geocodes place names (points of interest as well as towns, biased to the map view and to the
 * waypoint before), asks Directions for a route, and returns the line with an id (stable for the same request, so
 * asking twice replaces the drawn route), a name, and its bbox for the camera fit. A name that lands far from its
 * neighbour is looked up again close to it, then reported as ambiguous instead of routed across the state. A failure
 * names the places the names resolved to, so the model can see "Emerald Bay" landed in Laguna Beach and retry with
 * a fuller name.
 */
export async function runRouteTool(input: RouteToolInput, deps: Deps = {}): Promise<RouteToolOutput | RouteError> {
  const profile = input.profile ?? "walking";
  const geocode: Geocoder = deps.geocode ?? geocodeWaypoint;
  const view = deps.view ?? null;

  const end = splitVia(input.to);
  const trails = [
    ...(Array.isArray(input.via) ? input.via : input.via ? [input.via] : []),
    ...end.via,
  ]
    .map((t) => t.trim())
    .filter(Boolean);
  const stops: Stop[] = [
    { place: input.from, trail: false },
    ...trails.map((place) => ({ place, trail: true })),
    { place: end.place, trail: false },
  ];

  const limit = farLimitKm(view, profile);
  const notes: string[] = [];
  const resolved: (Resolved & { query: string })[] = [];
  let anchor: [number, number] | undefined = view?.center;

  for (const [index, stop] of stops.entries()) {
    if (typeof stop.place !== "string") {
      resolved.push({ lngLat: stop.place, query: label(stop.place) });
      anchor = stop.place;
      continue;
    }
    const query = stop.place.trim();
    // The view box only helps the first lookup: later waypoints are expected to leave the screen.
    const box = index === 0 && view?.bbox && view.zoom >= VIEW_BBOX_MIN_ZOOM ? view.bbox : undefined;
    let found = await geocode(query, noneIfEmpty({ proximity: anchor, bbox: box, ...(stop.trail ? { trail: true } : {}) }));

    if (stop.trail) {
      // A trail is a bonus: if the geocoder cannot place it near the route, say so and route without it.
      if ("error" in found || (anchor && distanceKm(anchor, found.center) > MAX_TRAIL_OFFSET_KM)) {
        notes.push(`Could not locate the ${query} near the route, so the route does not follow it.`);
        continue;
      }
      resolved.push({ lngLat: found.center, found: found.name, query });
      anchor = found.center;
      continue;
    }

    const previous = resolved[resolved.length - 1];
    if (!("error" in found) && previous && limit !== null && distanceKm(previous.lngLat, found.center) > limit) {
      // Probably a same-named place elsewhere: ask again, this time only near the waypoint before.
      const first = found;
      found = await geocode(query, { proximity: previous.lngLat, bbox: boxAround(previous.lngLat, limit / 2) });
      if ("error" in found || distanceKm(previous.lngLat, found.center) > limit) {
        const km = Math.round(distanceKm(previous.lngLat, first.center));
        return {
          error:
            `"${query}" is ambiguous: the best match is ${first.name}, ${km} km from ${previous.found ?? previous.query}, ` +
            `too far for a ${profile} route between two named places. Name it more fully (the park, town or state), or give coordinates.`,
        };
      }
    }
    if ("error" in found) return { error: `Could not find ${query}: ${found.error}` };
    resolved.push({ lngLat: found.center, found: found.name, query });
    anchor = found.center;
  }

  const from = resolved[0];
  const to = resolved[resolved.length - 1];
  const via = resolved.slice(1, -1);
  const fetched = await fetchRoute(
    { from: from.lngLat, to: to.lngLat, via: via.map((v) => v.lngLat), profile },
    deps.fetch,
  );
  if ("error" in fetched) {
    const places = [from, to].flatMap((r) => (r.found ? [`${r.query} resolved to ${r.found}`] : []));
    return places.length > 0 ? { error: `${fetched.error} (${places.join("; ")})` } : fetched;
  }
  const fromLabel = label(input.from);
  const toLabel = label(end.place);
  const trailLabel = trails.length > 0 ? ` via ${trails.join(" and ")}` : "";
  const name = input.name?.trim() || `${fromLabel} to ${toLabel}${trailLabel}`;
  return {
    id: routeId(`${profile} ${fromLabel} to ${toLabel}${trailLabel}`),
    name,
    profile,
    ...fetched,
    bbox: lineBBox(fetched.line),
    // Where each end landed, so the model can tell the user (and catch a wrong "Emerald Bay").
    resolved: {
      from: from.found ?? fromLabel,
      to: to.found ?? toLabel,
      ...(via.length > 0 ? { via: via.map((v) => v.found ?? v.query) } : {}),
    },
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** What the model sees for a route (also what the browser resends): everything but the line's coordinates. */
export { routeOutputForModel } from "./compactMessages";

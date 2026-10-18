/**
 * Popularity estimates: a 0-100 score per named trail (layer `popularity`) or per camp site (`popularity-campsites`),
 * computed from free public signals. 100 means "busiest-looking in this view", not a visitor count.
 *
 * Trails: OpenStreetMap ways (from osm-trails) are merged into one feature per named trail, so one trail takes one rank
 * slot; an unnamed way takes the name of the hiking route it belongs to, and unnamed ways in no route are left out. Each
 * trail is scored on Wikipedia page views (its own article, scaled by the share of a long route in view, plus the
 * best-known waterfall, summit, viewpoint or lake it leads to), geotagged photos along its busiest kilometre, how many
 * named destinations it reaches, the largest parking lot near it and whether it is part of a mapped hiking route
 * (weights in popularity.config.ts). Calibrated 2026-10-18 against famous trails (ranks in popularity.test.ts).
 *
 * Camp sites keep the original signals: photos within 500 m, parking within 1 km, a wiki link, informal trails and a name.
 *
 * Not used: OpenStreetMap's public GPS traces (the API serves 5,000 points a page under a policy against bulk use, so a
 * busy valley would need dozens of calls per view) and Strava's heatmap (needs an account).
 *
 * When a signal's source fails, the score uses the remaining signals (weights rescaled) and coverageNote says which were
 * left out; when the target layer itself fails, its error is returned.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  bboxAreaKm2,
  defineLayer,
  type BBox,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type Layer,
  type LayerError,
  type LayerResult,
  type LegendSpec,
  type QueryContext,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { MAPILLARY_CELL_DEG, MAPILLARY_MAX_CELLS, tileBBox } from "./photos";
import { GridIndex, haversineKm, lineMidpoint } from "./_shared/geo";
import { runComposed, type ComposedResult } from "./_shared/compose";
import { overpassQuery } from "./_shared/overpass";
import { wikimediaFetch } from "./_shared/wikimedia";
import {
  BUSIEST_STRETCH_KM,
  DESTINATION_CAP,
  INFORMAL_RADIUS_KM,
  MAX_SAMPLE_POINTS_PER_LINE,
  MIN_TRAIL_KM,
  ON_TRAIL_KM,
  OTHER_DESTINATION_SHARE,
  PIECE_MAX_KM,
  PAGEVIEW_DAYS,
  PARKING_RADIUS_KM,
  PHOTO_RADIUS_KM,
  POPULARITY_WEIGHTS,
  REACH_KM,
  TRAIL_PARKING_RADIUS_KM,
  TRAIL_PHOTO_RADIUS_KM,
  TRAIL_WEIGHTS,
  UNKNOWN_LOT_SPACES,
  type PopularitySignal,
  type TrailSignal,
} from "./popularity.config";
import { layerColor, PINK, PURPLE } from "@/lib/render/palette";
import { rampColor, rgbToHex } from "@/lib/render/ramp";

export type PopularityTarget = "trails" | "campsites";

export type PopularitySignals = {
  photos: number | null;
  parking: number | null;
  wiki: boolean;
  informal: number | null;
  named: boolean;
};

/**
 * Rank-normalizes values to 0..1 among the non-zero values only: zero (or less) maps to 0, the
 * smallest non-zero value to 1/k (k = how many are non-zero) and the largest to 1; ties share a rank.
 * Ranking only non-zero values keeps a crowd of zeros from making the first photo worth more
 * than the next hundred.
 */
export function rankNormalize(values: number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = sorted.length;
  return values.map((v) => {
    if (!(v > 0)) return 0;
    // Upper bound: index of the first value greater than v.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  });
}

/** Scales counts to 0..1 on a log scale against the largest: log(1 + v) / log(1 + max); all zeros stay 0. */
export function logNormalize(values: number[]): number[] {
  const max = Math.max(0, ...values);
  if (!(max > 0)) return values.map(() => 0);
  const top = Math.log1p(max);
  return values.map((v) => (v > 0 ? Math.log1p(v) / top : 0));
}

/** Evenly spaced vertices (at most `max`) plus the distance midpoint, so long trails are measured along their length. */
export function samplePoints(feature: Feature): Position[] {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === "Point") return [g.coordinates];
  const lines: Position[][] =
    g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
  const all = lines.flat();
  if (all.length === 0) return [];
  const out: Position[] = [];
  const step = Math.max(1, Math.ceil(all.length / MAX_SAMPLE_POINTS_PER_LINE));
  for (let i = 0; i < all.length; i += step) out.push(all[i]);
  out.push(all[all.length - 1]);
  for (const line of lines) {
    const mid = lineMidpoint(line);
    if (mid) out.push(mid);
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hasWiki(feature: Feature): boolean {
  return str(feature.properties?.wikidata) !== undefined || str(feature.properties?.wikipedia) !== undefined;
}

function isNamed(feature: Feature): boolean {
  return str(feature.properties?.name) !== undefined;
}

/** Distinct payloads within `km` of any of `points`. */
function distinctWithin<T>(index: GridIndex<T>, points: Position[], km: number): Set<T> {
  const found = new Set<T>();
  for (const p of points) index.forEachWithin(p, km, (value) => found.add(value));
  return found;
}

/* ================================================================================================================
 * Camp sites: the original per-feature score.
 * ============================================================================================================== */

export type ScoreInputs = {
  targets: Feature[];
  /** Photo points, or null when the photos layer failed. */
  photos: Feature[] | null;
  /** Parking points with `capacity`, or null when the campsites layer failed. */
  parking: Feature[] | null;
  /** All trail lines (informal ones are counted), or null when the trails layer failed. */
  trails: Feature[] | null;
  /** True when `targets` are the trail features themselves, so a trail never counts itself as nearby. */
  targetsAreTrails: boolean;
  refLat: number;
};

/** Computes signals and the 0-100 score for every target feature (the camp site score). */
export function scorePopularity(inputs: ScoreInputs): Feature[] {
  const { targets, photos, parking, trails, targetsAreTrails, refLat } = inputs;

  const photoIndex = new GridIndex<number>(PHOTO_RADIUS_KM, refLat);
  photos?.forEach((f, i) => {
    if (f.geometry?.type === "Point") photoIndex.add(f.geometry.coordinates, i);
  });

  const capacities: number[] = [];
  const parkingIndex = new GridIndex<number>(PARKING_RADIUS_KM, refLat);
  parking?.forEach((f) => {
    const cap: unknown = f.properties?.capacity;
    if (f.geometry?.type !== "Point" || typeof cap !== "number" || cap <= 0) return;
    parkingIndex.add(f.geometry.coordinates, capacities.length);
    capacities.push(cap);
  });

  // Informal trails are indexed by their position in `trails`, so a target trail can skip itself.
  const informalIndex = new GridIndex<number>(INFORMAL_RADIUS_KM, refLat);
  trails?.forEach((f, i) => {
    if (f.properties?.informal !== true) return;
    for (const p of samplePoints(f)) informalIndex.add(p, i);
  });

  const signals: PopularitySignals[] = targets.map((feature, i) => {
    const points = samplePoints(feature);
    let informal: number | null = null;
    if (trails !== null) {
      const near = distinctWithin(informalIndex, points, INFORMAL_RADIUS_KM);
      if (targetsAreTrails) near.delete(i);
      informal = near.size;
    }
    let parkingSum: number | null = null;
    if (parking !== null) {
      parkingSum = 0;
      for (const j of distinctWithin(parkingIndex, points, PARKING_RADIUS_KM)) parkingSum += capacities[j];
    }
    return {
      photos: photos === null ? null : distinctWithin(photoIndex, points, PHOTO_RADIUS_KM).size,
      parking: parkingSum,
      wiki: hasWiki(feature),
      informal,
      named: isNamed(feature),
    };
  });

  const norm: Record<PopularitySignal, number[] | null> = {
    photosWithin500m: photos === null ? null : rankNormalize(signals.map((s) => s.photos ?? 0)),
    parkingCapacityWithin1km: parking === null ? null : rankNormalize(signals.map((s) => s.parking ?? 0)),
    hasWikiLink: signals.map((s) => (s.wiki ? 1 : 0)),
    informalTrailsWithin500m: trails === null ? null : rankNormalize(signals.map((s) => s.informal ?? 0)),
    named: signals.map((s) => (s.named ? 1 : 0)),
  };

  // Missing signals drop out and the remaining weights are rescaled, so scores still span 0-100.
  const used = (Object.keys(POPULARITY_WEIGHTS) as PopularitySignal[]).filter((k) => norm[k] !== null);
  const weightSum = used.reduce((s, k) => s + POPULARITY_WEIGHTS[k], 0);

  return targets.map((feature, i) => {
    let total = 0;
    for (const k of used) total += POPULARITY_WEIGHTS[k] * (norm[k] as number[])[i];
    const score = weightSum > 0 ? Math.round((100 * total) / weightSum) : 0;
    return {
      type: "Feature",
      geometry: feature.geometry,
      properties: { ...feature.properties, v: score, signals: signals[i], popularityNote: "estimate" },
    };
  });
}

/* ================================================================================================================
 * Trails: hiking routes and destinations from OpenStreetMap.
 * ============================================================================================================== */

/** A hiking route relation that holds some of the ways in view. `totalKm` is its whole length (0 when unknown). */
export type RouteRelation = {
  id: number;
  name: string;
  network?: string;
  totalKm: number;
  wikidata?: string;
  wikipedia?: string;
  wayIds: number[];
};

/** A named place a trail can lead to: a waterfall, summit, viewpoint, rock, lake or attraction. */
export type Destination = { name: string; kind: string; coord: Position; wikidata?: string; wikipedia?: string };

/** A parking lot: its centre and its spaces (UNKNOWN_LOT_SPACES when not mapped). */
export type ParkingLot = { coord: Position; spaces: number };

export type TrailExtras = { relations: RouteRelation[]; destinations: Destination[]; parking: ParkingLot[] };

const DESTINATION_KINDS: Record<string, string> = {
  waterfall: "waterfall",
  peak: "summit",
  volcano: "summit",
  cliff: "cliff",
  arch: "arch",
  rock: "rock",
  bare_rock: "rock",
  saddle: "pass",
  spring: "spring",
  hot_spring: "hot spring",
  geyser: "geyser",
  cave_entrance: "cave",
  glacier: "glacier",
  beach: "beach",
  viewpoint: "viewpoint",
  attraction: "attraction",
  water: "lake",
};

/**
 * Overpass QL for what the trail score needs beyond the ways themselves: the hiking route relations holding paths in the
 * box (members and bounds), the named destinations (lakes and attractions only with a Wikipedia or Wikidata link, so
 * every pond and plaque is not one), and every parking lot. Overpass bbox order is (south,west,north,east).
 */
export function extrasQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const a = `(${south},${west},${north},${east})`;
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(path|footway|track)$"]${a}->.w;` +
    `rel(bw.w)["route"~"^(hiking|foot)$"]->.r;` +
    `.r out body bb;` +
    `(` +
    `nwr["natural"~"^(peak|volcano|waterfall|cliff|arch|rock|bare_rock|saddle|spring|hot_spring|geyser|cave_entrance|glacier|beach)$"]["name"]${a};` +
    `nwr["waterway"="waterfall"]["name"]${a};` +
    `nwr["tourism"="viewpoint"]["name"]${a};` +
    `nwr["tourism"="attraction"]["name"]["wikidata"]${a};` +
    `nwr["natural"="water"]["name"]["wikidata"]${a};` +
    `nwr["amenity"="parking"]${a};` +
    `);out center tags 5000;`
  );
}

const overpassElement = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  bounds: z.object({ minlat: z.number(), minlon: z.number(), maxlat: z.number(), maxlon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  members: z.array(z.object({ type: z.string(), ref: z.number() })).optional(),
});

/** A route's length in km from its `distance` tag ("19.5", "19.5 km", "12 mi"); 0 when absent or unreadable. */
export function distanceTagKm(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^\s*([\d.]+)\s*(km|mi|m)?\s*$/i.exec(raw.replace(",", "."));
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = (m[2] ?? "km").toLowerCase();
  return unit === "mi" ? n * 1.609344 : unit === "m" ? n / 1000 : n;
}

/** Parses the extrasQuery answer; malformed elements are skipped. */
export function parseExtras(json: unknown): TrailExtras {
  const elements = (json as { elements?: unknown })?.elements;
  const out: TrailExtras = { relations: [], destinations: [], parking: [] };
  if (!Array.isArray(elements)) return out;
  for (const raw of elements) {
    const parsed = overpassElement.safeParse(raw);
    if (!parsed.success) continue;
    const el = parsed.data;
    const tags = el.tags ?? {};
    if (el.type === "relation" && el.members) {
      const name = str(tags.official_name) ?? str(tags.name);
      if (!name) continue;
      const b = el.bounds;
      const diagonalKm = b ? haversineKm([b.minlon, b.minlat], [b.maxlon, b.maxlat]) : 0;
      out.relations.push({
        id: el.id,
        name: str(tags.name) ?? name,
        ...(str(tags.network) && { network: str(tags.network) }),
        // A route is at least as long as its bounding box is across.
        totalKm: Math.max(distanceTagKm(tags.distance), diagonalKm),
        ...(str(tags.wikidata) && { wikidata: str(tags.wikidata) }),
        ...(str(tags.wikipedia) && { wikipedia: str(tags.wikipedia) }),
        wayIds: el.members.filter((m) => m.type === "way").map((m) => m.ref),
      });
      continue;
    }
    const at = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : undefined);
    if (!at) continue;
    const coord: Position = [at.lon, at.lat];
    if (tags.amenity === "parking") {
      const cap = Number(tags.capacity);
      out.parking.push({ coord, spaces: Number.isFinite(cap) && cap > 0 ? Math.round(cap) : UNKNOWN_LOT_SPACES });
      continue;
    }
    const name = str(tags.name);
    const kindKey = tags.waterway === "waterfall" ? "waterfall" : (tags.natural ?? tags.tourism);
    const kind = kindKey ? DESTINATION_KINDS[kindKey] : undefined;
    if (!name || !kind) continue;
    out.destinations.push({
      name,
      kind,
      coord,
      ...(str(tags.wikidata) && { wikidata: str(tags.wikidata) }),
      ...(str(tags.wikipedia) && { wikipedia: str(tags.wikipedia) }),
    });
  }
  return out;
}

/* ---------- Grouping ways into trails ---------- */

/** One named trail: its ways in view, their lines, its length in view and the hiking routes its ways belong to. */
export type TrailGroup = {
  name: string;
  lines: Position[][];
  osmIds: string[];
  lengthKm: number;
  /** Every hiking route holding one of its ways. */
  routes: RouteRelation[];
  /** The routes that are this trail (same name), whose Wikipedia article is the trail's own. */
  own: RouteRelation[];
  /** Wikipedia or Wikidata tags on the ways themselves. */
  wayRefs: string[];
};

/** A name folded for comparison: lower case, letters and digits only. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** True when a route is this trail: the same name, or one name holding the other ("Yosemite Valley Loop Trail"). */
function sameTrail(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  return shorter.length >= 8 && (x.includes(y) || y.includes(x));
}

const NETWORK_RANK: Record<string, number> = { lwn: 0, rwn: 1, nwn: 2, iwn: 3 };

/** The most local route first (local, regional, national, international), then the shortest. */
function localFirst(a: RouteRelation, b: RouteRelation): number {
  const na = NETWORK_RANK[a.network ?? ""] ?? 1.5;
  const nb = NETWORK_RANK[b.network ?? ""] ?? 1.5;
  return na - nb || (a.totalKm || Infinity) - (b.totalKm || Infinity) || a.id - b.id;
}

function lineKm(line: Position[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

function linesOf(f: Feature): Position[][] {
  const g = f.geometry;
  if (g?.type === "LineString") return [g.coordinates];
  if (g?.type === "MultiLineString") return g.coordinates;
  return [];
}

/** The numeric id of an osm-trails feature ("way/123" → 123), or null. */
function wayIdOf(f: Feature): number | null {
  const m = /^way\/(\d+)$/.exec(String(f.properties?.osmId ?? ""));
  return m ? Number(m[1]) : null;
}

/** The hiking route a way's name says it is (the same name, or one holding the other), its own routes first; null when none. */
function routeNamed(name: string, own: RouteRelation[], all: RouteRelation[]): RouteRelation | null {
  return own.find((r) => sameTrail(r.name, name)) ?? [...all].sort(localFirst).find((r) => sameTrail(r.name, name)) ?? null;
}

/**
 * Merges ways into named trails, so a trail split at every bridge and junction takes one rank slot. A way joins the
 * hiking route its name matches ("Valley Loop Trail" ways join "Yosemite Valley Loop Trail"); a short named piece of a
 * route ("The Cables", under PIECE_MAX_KM) and an unnamed way join the most local route holding them; any other named
 * way goes under its own name. Unnamed ways in no route are left out (counted in `unnamed`), and so are trails shorter
 * than MIN_TRAIL_KM in view.
 */
export function groupTrails(ways: Feature[], relations: RouteRelation[]): { groups: TrailGroup[]; unnamed: number } {
  const routesOfWay = new Map<number, RouteRelation[]>();
  for (const r of relations) {
    for (const id of r.wayIds) {
      const list = routesOfWay.get(id);
      if (list) list.push(r);
      else routesOfWay.set(id, [r]);
    }
  }
  const byKey = new Map<string, TrailGroup>();
  let unnamed = 0;
  for (const way of ways) {
    const lines = linesOf(way).filter((l) => l.length >= 2);
    if (lines.length === 0) continue;
    const id = wayIdOf(way);
    const routes = id === null ? [] : [...(routesOfWay.get(id) ?? [])].sort(localFirst);
    const km = lines.reduce((s, l) => s + lineKm(l), 0);
    const own = str(way.properties?.name);
    const named = own ? routeNamed(own, routes, relations) : null;
    const name = named?.name ?? (own && (routes.length === 0 || km >= PIECE_MAX_KM) ? own : routes[0]?.name);
    if (!name) {
      unnamed += 1;
      continue;
    }
    const key = fold(name);
    let group = byKey.get(key);
    if (!group) {
      group = { name, lines: [], osmIds: [], lengthKm: 0, routes: [], own: [], wayRefs: [] };
      byKey.set(key, group);
    }
    group.lines.push(...lines);
    if (way.properties?.osmId) group.osmIds.push(String(way.properties.osmId));
    group.lengthKm += km;
    for (const r of routes) if (!group.routes.includes(r)) group.routes.push(r);
    for (const ref of refsOf(way.properties ?? {})) if (!group.wayRefs.includes(ref)) group.wayRefs.push(ref);
  }
  const groups = [...byKey.values()].filter((g) => g.lengthKm >= MIN_TRAIL_KM);
  for (const g of groups) {
    g.own = g.routes.filter((r) => sameTrail(r.name, g.name));
    g.routes.sort(localFirst);
  }
  return { groups, unnamed };
}

/** True for a trail whose name says it is closed ("Hidden Canyon - Closed Indefinitely"). */
export function isClosed(name: string): boolean {
  return /\bclosed\b/i.test(name);
}

/* ---------- Wikipedia page views ---------- */

/** Wiki references as strings: `wikidata:Q123` or `wikipedia:en:Half Dome`. */
export function refsOf(tags: { wikidata?: unknown; wikipedia?: unknown }): string[] {
  const out: string[] = [];
  const wd = str(tags.wikidata);
  if (wd && /^Q\d+$/.test(wd)) out.push(`wikidata:${wd}`);
  const wp = str(tags.wikipedia);
  if (wp) out.push(`wikipedia:${pageKey(wp)}`);
  return out;
}

/** A Wikipedia tag ("en:Half Dome", "Half_Dome") as a page key "en:Half Dome". */
export function pageKey(tag: string): string {
  const m = /^([a-z][a-z-]{1,11}):(.+)$/.exec(tag.trim());
  const lang = m ? m[1] : "en";
  const title = (m ? m[2] : tag).replace(/_/g, " ").trim();
  return `${lang}:${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

/** A page's views and where to read it. */
export type PageInfo = { page: string; views: number; url: string };

/** What a reference resolves to: its page and views, keyed by the reference string. */
export type PageViews = Map<string, PageInfo>;

const NOT_WIKIPEDIA = new Set(["commons", "species", "meta", "wikidata", "outreach", "sources", "mediawiki", "incubator", "wikimania"]);

/** The Wikipedia page for a Wikidata item's sitelinks: English first, else the first other language; null when none. */
export function sitelinkPage(sitelinks: Record<string, { title?: string }>): string | null {
  const keys = Object.keys(sitelinks);
  const wikis = keys.filter((k) => /^[a-z_]+wiki$/.test(k) && !NOT_WIKIPEDIA.has(k.slice(0, -4)));
  const pick = wikis.includes("enwiki") ? "enwiki" : wikis.sort()[0];
  const title = pick ? sitelinks[pick]?.title : undefined;
  if (!pick || !title) return null;
  return `${pick.slice(0, -4).replace(/_/g, "-")}:${title}`;
}

const WIKI_TTL_SECONDS = 7 * 86_400;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type PageviewsAnswer = {
  continue?: { pvipcontinue?: string };
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: { title: string; missing?: boolean; pageviews?: Record<string, number | null> }[];
  };
};

/**
 * Page views over the last PAGEVIEW_DAYS days for each reference: Wikidata items go to their Wikipedia page through
 * their sitelinks (one call per 50), then each language's pages are read 50 at a time through the Wikipedia API's
 * pageviews property (redirects followed). A reference with no page is left out. Throws when a call fails.
 */
export async function fetchPageViews(ctx: Pick<QueryContext, "fetch">, refs: string[]): Promise<PageViews> {
  const pageOf = new Map<string, string>();
  for (const ref of refs) if (ref.startsWith("wikipedia:")) pageOf.set(ref, ref.slice("wikipedia:".length));

  const items = [...new Set(refs.filter((r) => r.startsWith("wikidata:")).map((r) => r.slice("wikidata:".length)))].sort();
  for (const batch of chunks(items, 50)) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&format=json&formatversion=2&ids=${batch.join("|")}`;
    const res = await wikimediaFetch(ctx.fetch, url, { ttlSeconds: WIKI_TTL_SECONDS });
    if (!res.ok) throw new Error(`Wikidata returned ${res.status}`);
    const json = (await res.json()) as { entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }> };
    for (const id of batch) {
      const page = sitelinkPage(json.entities?.[id]?.sitelinks ?? {});
      if (page) pageOf.set(`wikidata:${id}`, page);
    }
  }

  const byLang = new Map<string, Set<string>>();
  for (const page of pageOf.values()) {
    const i = page.indexOf(":");
    const lang = page.slice(0, i);
    if (!byLang.has(lang)) byLang.set(lang, new Set());
    byLang.get(lang)!.add(page.slice(i + 1));
  }

  const viewsOf = new Map<string, PageInfo>();
  for (const [lang, titleSet] of [...byLang.entries()].sort()) {
    for (const batch of chunks([...titleSet].sort(), 50)) {
      const totals = new Map<string, number>();
      const alias = new Map<string, string>();
      let cont: string | undefined;
      for (let round = 0; round < 4; round++) {
        const url =
          `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageviews&pvipdays=${PAGEVIEW_DAYS}&redirects=1&format=json&formatversion=2` +
          `&titles=${batch.map(encodeURIComponent).join("|")}` +
          (cont ? `&pvipcontinue=${encodeURIComponent(cont)}` : "");
        const res = await wikimediaFetch(ctx.fetch, url, { ttlSeconds: WIKI_TTL_SECONDS });
        if (!res.ok) throw new Error(`Wikipedia (${lang}) returned ${res.status}`);
        const json = (await res.json()) as PageviewsAnswer;
        for (const n of [...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])]) alias.set(n.from, n.to);
        for (const p of json.query?.pages ?? []) {
          if (p.missing || !p.pageviews) continue;
          const sum = Object.values(p.pageviews).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
          totals.set(p.title, Math.max(totals.get(p.title) ?? 0, sum));
        }
        cont = json.continue?.pvipcontinue;
        if (!cont) break;
      }
      for (const title of batch) {
        let t = title;
        for (let hop = 0; hop < 3 && alias.has(t); hop++) t = alias.get(t)!;
        const views = totals.get(t);
        if (views === undefined) continue;
        viewsOf.set(`${lang}:${title}`, {
          page: t,
          views,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`,
        });
      }
    }
  }

  const out: PageViews = new Map();
  for (const [ref, page] of pageOf) {
    const info = viewsOf.get(page);
    if (info) out.set(ref, info);
  }
  return out;
}

/* ---------- Scoring trails ---------- */

export type TrailScoreInputs = {
  groups: TrailGroup[];
  /** Named destinations, or null when the OpenStreetMap extras failed. */
  destinations: Destination[] | null;
  /** Parking lots, or null when the OpenStreetMap extras failed. */
  parking: ParkingLot[] | null;
  /** True when the hiking routes are known (the extras answered). */
  routesKnown: boolean;
  /** Page views by reference, or null when Wikipedia failed. */
  views: PageViews | null;
  /** Photo points, or null when the photos layer failed. */
  photos: Feature[] | null;
  refLat: number;
};

/** The trail's raw signals, as its card shows them (null when that source failed). */
export type TrailSignals = {
  wikipediaViews: number | null;
  photos: number | null;
  destinations: number | null;
  parkingSpaces: number | null;
  hikingRoute: boolean | null;
  ownArticle: boolean;
};

/** Points along a line at most `stepKm` apart (every vertex kept). */
function densify(line: Position[], stepKm: number): Position[] {
  const out: Position[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const d = haversineKm(a, b);
    const n = Math.floor(d / stepKm);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

/** A photo point and how near the trail it must be to count: Mapillary images only on the trail, others within 250 m. */
type PhotoPoint = { id: number; reachKm: number };

/** Indexes photos for busiestStretchPhotos. */
function photoGrid(photos: Feature[], refLat: number): GridIndex<PhotoPoint> {
  const index = new GridIndex<PhotoPoint>(TRAIL_PHOTO_RADIUS_KM, refLat);
  photos.forEach((f, id) => {
    if (f.geometry?.type !== "Point") return;
    const reachKm = f.properties?.source === "mapillary" ? ON_TRAIL_KM : TRAIL_PHOTO_RADIUS_KM;
    index.add(f.geometry.coordinates, { id, reachKm });
  });
  return index;
}

/**
 * Photos along the trail's busiest stretch: for each point along the trail, the distinct photos near the trail inside a
 * BUSIEST_STRETCH_KM-wide circle around it; the largest such count. A long trail is credited only for its busiest
 * kilometre, not for its length. Commons photos count within TRAIL_PHOTO_RADIUS_KM; Mapillary images only within
 * ON_TRAIL_KM (taken on the trail, not from the road beside it).
 */
function busiestStretchPhotos(lines: Position[][], photoIndex: GridIndex<PhotoPoint>, refLat: number): number {
  const points = lines.flatMap((l) => densify(l, ON_TRAIL_KM / 2));
  const near: number[][] = points.map((p) => {
    const ids: number[] = [];
    photoIndex.forEachWithin(p, TRAIL_PHOTO_RADIUS_KM, (photo, d) => {
      if (d <= photo.reachKm) ids.push(photo.id);
    });
    return ids;
  });
  const pointIndex = new GridIndex<number>(BUSIEST_STRETCH_KM / 2, refLat);
  points.forEach((p, i) => {
    if (near[i].length > 0) pointIndex.add(p, i);
  });
  if (pointIndex.size === 0) return 0;
  let best = 0;
  const stride = Math.max(1, Math.ceil(points.length / 400));
  for (let c = 0; c < points.length; c += stride) {
    const seen = new Set<number>();
    pointIndex.forEachWithin(points[c], BUSIEST_STRETCH_KM / 2, (i) => {
      for (const id of near[i]) seen.add(id);
    });
    if (seen.size > best) best = seen.size;
  }
  return best;
}

/** Every vertex of the trail (for reach and parking tests). */
function vertices(lines: Position[][]): Position[] {
  return lines.flat();
}

/** Scores named trails 0-100 from the signals in TRAIL_WEIGHTS, one feature per trail, ranked busiest first. */
export function scoreTrails(inputs: TrailScoreInputs): Feature[] {
  const { groups, destinations, parking, routesKnown, views, photos, refLat } = inputs;

  const photoIndex = photoGrid(photos ?? [], refLat);
  const destIndex = new GridIndex<number>(REACH_KM, refLat);
  destinations?.forEach((d, i) => destIndex.add(d.coord, i));
  const lotIndex = new GridIndex<number>(TRAIL_PARKING_RADIUS_KM, refLat);
  parking?.forEach((p, i) => lotIndex.add(p.coord, i));

  const viewOf = (ref: string): PageInfo | undefined => views?.get(ref);

  type Row = { group: TrailGroup; signals: TrailSignals; leadsTo: string[]; topPage?: PageInfo };
  const rows: Row[] = groups.map((group) => {
    const verts = vertices(group.lines);

    // Destinations reached, best known first.
    const reached = destinations === null ? [] : [...distinctWithin(destIndex, verts, REACH_KM)].map((i) => destinations[i]);
    const destViews = (d: Destination) => Math.max(0, ...refsOf(d).map((r) => viewOf(r)?.views ?? 0));
    reached.sort((a, b) => destViews(b) - destViews(a) || a.name.localeCompare(b.name));
    const leadsTo = [...new Set(reached.map((d) => d.name))];

    // Wikipedia: the trail's own pages (a long route's views scaled to the share of it in view), then its destinations.
    let wikipediaViews: number | null = null;
    let topPage: PageInfo | undefined;
    if (views !== null) {
      const own = new Map<string, { info: PageInfo; share: number }>();
      const addOwn = (ref: string, share: number) => {
        const info = viewOf(ref);
        if (!info) return;
        const prev = own.get(info.url);
        if (!prev || prev.share < share) own.set(info.url, { info, share });
      };
      for (const ref of group.wayRefs) addOwn(ref, 1);
      for (const r of group.own) {
        const share = r.totalKm > 0 ? Math.min(1, group.lengthKm / r.totalKm) : 1;
        for (const ref of refsOf(r)) addOwn(ref, share);
      }
      const ownViews = [...own.values()].reduce((s, o) => s + o.info.views * o.share, 0);
      const destPages = new Map<string, PageInfo>();
      for (const d of reached) {
        for (const ref of refsOf(d)) {
          const info = viewOf(ref);
          if (info && !own.has(info.url)) destPages.set(info.url, info);
        }
      }
      const sorted = [...destPages.values()].sort((a, b) => b.views - a.views);
      const destTotal = sorted.reduce((s, p, i) => s + p.views * (i === 0 ? 1 : OTHER_DESTINATION_SHARE), 0);
      wikipediaViews = Math.round(ownViews + destTotal);
      const ownTop = [...own.values()].sort((a, b) => b.info.views * b.share - a.info.views * a.share)[0]?.info;
      topPage = ownTop ?? sorted[0];
    }

    let parkingSpaces: number | null = null;
    if (parking !== null) {
      parkingSpaces = 0;
      for (const i of distinctWithin(lotIndex, verts, TRAIL_PARKING_RADIUS_KM)) parkingSpaces = Math.max(parkingSpaces, parking[i].spaces);
    }

    return {
      group,
      leadsTo,
      ...(topPage && { topPage }),
      signals: {
        wikipediaViews,
        photos: photos === null ? null : busiestStretchPhotos(group.lines, photoIndex, refLat),
        destinations: destinations === null ? null : leadsTo.length,
        parkingSpaces,
        hikingRoute: routesKnown ? group.routes.length > 0 : null,
        ownArticle: group.wayRefs.length > 0 || group.own.some((r) => refsOf(r).length > 0),
      },
    };
  });

  const col = (k: keyof TrailSignals) => rows.map((r) => Number(r.signals[k] ?? 0));
  const norm: Record<TrailSignal, number[] | null> = {
    wikipediaViews: views === null ? null : logNormalize(col("wikipediaViews")),
    photos: photos === null ? null : logNormalize(col("photos")),
    destinations: destinations === null ? null : col("destinations").map((n) => Math.min(n, DESTINATION_CAP) / DESTINATION_CAP),
    parking: parking === null ? null : logNormalize(col("parkingSpaces")),
    hikingRoute: routesKnown ? col("hikingRoute") : null,
    ownArticle: col("ownArticle"),
  };
  const used = (Object.keys(TRAIL_WEIGHTS) as TrailSignal[]).filter((k) => norm[k] !== null);
  const weightSum = used.reduce((s, k) => s + TRAIL_WEIGHTS[k], 0);

  const scored = rows.map((row, i) => {
    let total = 0;
    for (const k of used) total += TRAIL_WEIGHTS[k] * (norm[k] as number[])[i];
    // A trail its own name calls closed is not busy, whatever its signals say.
    const v = isClosed(row.group.name) || weightSum === 0 ? 0 : Math.round((100 * total) / weightSum);
    return { row, v };
  });
  scored.sort(
    (a, b) =>
      b.v - a.v ||
      (b.row.signals.wikipediaViews ?? 0) - (a.row.signals.wikipediaViews ?? 0) ||
      (b.row.signals.photos ?? 0) - (a.row.signals.photos ?? 0) ||
      a.row.group.name.localeCompare(b.row.group.name),
  );

  return scored.map(({ row, v }, i): Feature => {
    const { group, signals, leadsTo, topPage } = row;
    const routes = group.routes.filter((r) => !sameTrail(r.name, group.name)).map((r) => r.name);
    return {
      type: "Feature",
      geometry: group.lines.length === 1 ? { type: "LineString", coordinates: group.lines[0] } : { type: "MultiLineString", coordinates: group.lines },
      properties: {
        name: group.name,
        v,
        rank: i + 1,
        lengthKm: Math.round(group.lengthKm * 10) / 10,
        ...(leadsTo.length > 0 && { leadsTo: leadsTo.slice(0, 5) }),
        ...(signals.wikipediaViews !== null && { wikipediaViews: signals.wikipediaViews }),
        ...(signals.photos !== null && { photos: signals.photos }),
        ...(signals.parkingSpaces !== null && signals.parkingSpaces > 0 && { parkingSpaces: signals.parkingSpaces }),
        ...(routes.length > 0 && { routes: [...new Set(routes)] }),
        ...(topPage && { wikipediaUrl: topPage.url }),
        ...(isClosed(group.name) && { status: "Closed" }),
        osmIds: group.osmIds,
        popularityNote: "estimate",
      },
    };
  });
}

/* ================================================================================================================
 * Layer definitions.
 * ============================================================================================================== */

const SIGNAL_LABELS = {
  photos: "photo counts",
  parking: "parking capacity",
  informal: "informal trail counts",
  routes: "hiking routes, destinations and parking lots",
  wikipedia: "Wikipedia page views",
} as const;

/**
 * True when the photos layer would query Mapillary for only part of `bbox` (its central squares).
 * Then popularity asks for Commons alone, so every feature is scored on the same photo source.
 */
export function mapillaryPartial(bbox: BBox): boolean {
  return tileBBox(bbox, MAPILLARY_CELL_DEG, MAPILLARY_CELL_DEG).length > MAPILLARY_MAX_CELLS;
}

const COMMONS_ONLY_NOTE =
  "Photo counts use Wikimedia Commons only: Mapillary covers just the centre of a view this large, which would favour central features; zoom in to about 15 km across to include it";

const pct = (weight: number) => `${Math.round(weight * 100)}%`;

const TRAIL_DESCRIPTION =
  "An estimate of how popular each named trail in view is, as a score from 0 (quietest) to 100 (busiest-looking in this view); for camp sites use popularity-campsites. " +
  "It is built from public signals, not live or measured foot traffic. OpenStreetMap ways are merged by trail name (an unnamed way takes the name of the hiking route it belongs to; unnamed paths in no route are left out), so each trail appears once. " +
  `Signals: Wikipedia page views over the last ${PAGEVIEW_DAYS} days for the trail's own article (a long route counts only the share of it in view) and for the waterfalls, summits, viewpoints and lakes it leads to (${pct(TRAIL_WEIGHTS.wikipediaViews)}); ` +
  `geotagged photos along its busiest kilometre (Wikimedia Commons, plus Mapillary when configured and the view is about 15 km across or less) (${pct(TRAIL_WEIGHTS.photos)}); ` +
  `how many named destinations it reaches (${pct(TRAIL_WEIGHTS.destinations)}); the largest parking lot near it (${pct(TRAIL_WEIGHTS.parking)}); and whether it is part of a mapped hiking route (${pct(TRAIL_WEIGHTS.hikingRoute)}). ` +
  "Each trail has v (the score), rank, name, lengthKm (in view), leadsTo, wikipediaViews, photos, parkingSpaces, routes and popularityNote 'estimate'. " +
  "Scores rank trails against each other in the current view, so the same trail can score differently in a different view. " +
  "Coverage is global but the signals are richer where OpenStreetMap, Wikipedia and photo coverage is dense; if a signal's source fails the score uses the others and the result says which were left out. " +
  "Zoom in to a region under 2,500 km² (about a 50 km square) first.";

const CAMPSITE_DESCRIPTION =
  "An estimate of how popular each camp site in view is, as a score from 0 (quietest) to 100 (busiest-looking in this view); for trails use popularity. " +
  "It is an estimate built from public signals, not live or measured foot traffic. " +
  "Signals: geotagged photos within 500 m (Wikimedia Commons, plus Mapillary when configured and the view is small enough, about 15 km across, for Mapillary to cover all of it), parking capacity within 1 km, a Wikipedia or Wikidata link, informal (social) trails within 500 m, and whether the site is named. " +
  "Each site has v (the score), signals { photos, parking (spaces), wiki, informal, named } (null when that signal was unavailable) and popularityNote 'estimate'. " +
  "Scores rank sites against each other in the current view, so the same site can score differently in a different view. " +
  "Coverage is global but the signals are richer in the US and Europe, where OpenStreetMap and photo coverage is denser; " +
  "if a signal's source fails the score uses the others and the result says which were left out. Zoom in to a region under 2,500 km² (about a 50 km square) first.";

const TRAIL_SCORE: FieldHelp = {
  text:
    "An estimate computed by this app, not a visitor count. Each named trail is compared with the other trails in view on five things: " +
    `how often people read Wikipedia about the trail and the best-known place it leads to (${pct(TRAIL_WEIGHTS.wikipediaViews)}), ` +
    `how many geotagged photos were taken along its busiest kilometre (${pct(TRAIL_WEIGHTS.photos)}), ` +
    `how many named waterfalls, summits, viewpoints or lakes it reaches (${pct(TRAIL_WEIGHTS.destinations)}), ` +
    `how big the largest parking lot near it is (${pct(TRAIL_WEIGHTS.parking)}), ` +
    `and whether it is part of a mapped hiking route (${pct(TRAIL_WEIGHTS.hikingRoute)}). A missing signal is dropped and the rest reweighted.`,
  scale: "0 (quietest trail in view) to 100 (busiest-looking trail in view); compares trails in the same view only",
  source: "This app, from OpenStreetMap, Wikipedia, Wikidata, Wikimedia Commons and Mapillary",
};

const CAMPSITE_SCORE: FieldHelp = {
  text:
    "An estimate computed by this app, not a visitor count: each site's signals (geotagged photos within 500 m, parking spaces within 1 km, " +
    "a Wikipedia or Wikidata link, informal trails within 500 m, and having a name) are ranked against the other sites in view and weighted " +
    `${pct(POPULARITY_WEIGHTS.photosWithin500m)}, ${pct(POPULARITY_WEIGHTS.parkingCapacityWithin1km)}, ${pct(POPULARITY_WEIGHTS.hasWikiLink)}, ` +
    `${pct(POPULARITY_WEIGHTS.informalTrailsWithin500m)} and ${pct(POPULARITY_WEIGHTS.named)}; a missing signal is dropped and the rest reweighted.`,
  scale: "0 (quietest in view) to 100 (busiest-looking in view); compares sites in the same view only",
  source: "This app, from OpenStreetMap, Wikimedia Commons and Mapillary",
};

const SCORE_PRESETS = [
  { label: "Quiet (under 25)", max: 25 },
  { label: "Moderate (25 to 50)", min: 25, max: 50 },
  { label: "Busy (50 to 75)", min: 50, max: 75 },
  { label: "Busiest (75 and up)", min: 75 },
];

const scoreAttribute = (help: FieldHelp): Attribute => ({ key: "v", type: "measure", label: "Popularity", unit: "score", help, presets: SCORE_PRESETS });

/** The score ramp the legend draws: it starts at a visible tone (not pale sage, which sinks into green Topo). */
export const RAMP_START = rgbToHex(rampColor("scoreLine", 0.4));

/**
 * The key names the ends of the drawn range, not numbers: the score is a weighted sum of signals ranked within the view,
 * so the busiest in view is rarely 100 (the top trail of the recorded Lake Tahoe sample scores 62), and the map scales its colors and widths to the scores loaded.
 * A fixed 0 to 100 here disagreed with the ranges the map draws by.
 */
const legendFor = (noun: string): LegendSpec => ({
  kind: "ramp",
  title: "Popularity score",
  field: "v",
  unit: "score",
  stops: [
    { label: `Quietest ${noun} in view`, color: RAMP_START },
    { label: "Middle", color: PINK },
    { label: `Busiest ${noun} in view`, color: PURPLE },
  ],
  note: `An estimate from public signals, compared within this view; not a visitor count.${noun === "trail" ? " Wider lines are busier. Unnamed paths are left out." : ""}`,
});

const TRAIL_HELP: Record<string, FieldHelp> = {
  v: TRAIL_SCORE,
  wikipediaViews: {
    text:
      `Wikipedia page views over the last ${PAGEVIEW_DAYS} days for the trail's own article (for a long route, only the share of it in view) ` +
      "plus the best-known place it leads to and a quarter of the views of the others.",
    source: "Wikipedia page views (Wikimedia), linked through OpenStreetMap and Wikidata",
    url: "https://www.mediawiki.org/wiki/Extension:PageViewInfo",
  },
  photos: { text: "Geotagged photos taken within 250 m of the trail along its busiest kilometre.", source: "Wikimedia Commons and Mapillary" },
  leadsTo: { text: "Named waterfalls, summits, viewpoints, lakes and other landmarks within 300 m of the trail, best known first.", source: "OpenStreetMap" },
  parkingSpaces: {
    text: `Spaces in the largest parking lot within 500 m of the trail; a lot mapped without a capacity counts as ${UNKNOWN_LOT_SPACES}.`,
    source: "OpenStreetMap",
  },
  routes: { text: "Mapped hiking routes this trail is part of.", source: "OpenStreetMap" },
  lengthKm: { text: "Length of the trail inside the current view." },
  popularityNote: { text: "Always 'estimate': the score is built from public signals, not measured foot traffic." },
};

const CAMPSITE_HELP: Record<string, FieldHelp> = {
  v: CAMPSITE_SCORE,
  signals: {
    text:
      "The raw signals behind the score: photos (geotagged photos within 500 m), parking (spaces within 1 km), wiki (has a Wikipedia or Wikidata " +
      "link), informal (informal trails within 500 m) and named; null when that source failed.",
  },
  popularityNote: { text: "Always 'estimate': the score is built from public signals, not measured foot traffic." },
};

const TRAIL_CARD: CardSpec = {
  measure: { key: "v", label: "Popularity score" },
  facts: [
    { key: "leadsTo", label: "Leads to", format: "list" },
    { key: "wikipediaViews", label: `Wikipedia views, last ${PAGEVIEW_DAYS} days`, format: "int" },
    { key: "photos", label: "Photos along its busiest kilometre", format: "int" },
    { key: "parkingSpaces", label: "Largest parking lot nearby", unit: "spaces", format: "int" },
    { key: "routes", label: "Part of", format: "list" },
    { key: "lengthKm", label: "Length in view", format: "km" },
  ],
  links: [{ key: "wikipediaUrl", label: "Read on Wikipedia" }],
  hidden: ["osmIds", "rank", "popularityNote", "wikidata", "wikipedia"],
};

const CAMPSITE_CARD: CardSpec = {
  measure: { key: "v", label: "Popularity score" },
  facts: [{ key: "name", label: "Name" }],
  hidden: ["osmId", "popularityNote"],
};

function citation(target: PopularityTarget): LayerResult["citation"] {
  return {
    source:
      target === "trails"
        ? "WallyMap popularity estimate derived from OpenStreetMap contributors (ODbL), Wikipedia page views (Wikimedia, CC0), Wikidata, Wikimedia Commons and Mapillary (CC BY-SA 4.0)"
        : "WallyMap popularity estimate derived from OpenStreetMap contributors (ODbL), Wikimedia Commons and Mapillary (CC BY-SA 4.0)",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date().toISOString(),
  };
}

function photosRunFor(ctx: QueryContext): { run: Promise<ComposedResult>; commonsOnly: boolean } {
  const commonsOnly = mapillaryPartial(ctx.bbox);
  return {
    commonsOnly,
    run: runComposed("photos", ctx, commonsOnly ? { sources: ["commons"] } : {}, commonsOnly ? "photos:commons" : "photos"),
  };
}

async function queryTrails(ctx: QueryContext): Promise<LayerResult | LayerError> {
  const { run: photosPromise, commonsOnly } = photosRunFor(ctx);
  const [trailsRun, photosRun, extrasRun] = await Promise.all([
    runComposed("osm-trails", ctx, { namedOnly: false }, "trails"),
    photosPromise,
    overpassQuery(ctx, extrasQuery(ctx.bbox), { cacheSuffix: "extras" }),
  ]);
  if (!trailsRun.ok) return trailsRun.error;

  const extras = extrasRun.ok ? parseExtras(extrasRun.json) : null;
  const { groups, unnamed } = groupTrails(trailsRun.data.features, extras?.relations ?? []);
  const reachedRefs = new Set<string>();
  if (extras) {
    const refLat = (ctx.bbox[1] + ctx.bbox[3]) / 2;
    const destIndex = new GridIndex<number>(REACH_KM, refLat);
    extras.destinations.forEach((d, i) => destIndex.add(d.coord, i));
    for (const g of groups) {
      for (const i of distinctWithin(destIndex, vertices(g.lines), REACH_KM)) for (const r of refsOf(extras.destinations[i])) reachedRefs.add(r);
    }
  }
  for (const g of groups) {
    for (const r of g.wayRefs) reachedRefs.add(r);
    for (const route of g.own) for (const r of refsOf(route)) reachedRefs.add(r);
  }

  let views: PageViews | null = null;
  let wikiError: string | null = null;
  try {
    views = await fetchPageViews(ctx, [...reachedRefs].sort());
  } catch (err) {
    wikiError = err instanceof Error ? err.message : String(err);
  }

  const features = scoreTrails({
    groups,
    destinations: extras?.destinations ?? null,
    parking: extras?.parking ?? null,
    routesKnown: extras !== null,
    views,
    photos: photosRun.ok ? photosRun.data.features : null,
    refLat: (ctx.bbox[1] + ctx.bbox[3]) / 2,
  });

  const missing: string[] = [];
  if (!photosRun.ok) missing.push(`${SIGNAL_LABELS.photos} (${photosRun.error.error})`);
  if (!extrasRun.ok) missing.push(`${SIGNAL_LABELS.routes} (${extrasRun.error})`);
  if (wikiError !== null) missing.push(`${SIGNAL_LABELS.wikipedia} (${wikiError})`);
  const notes: string[] = [];
  if (missing.length > 0) notes.push(`Scored without ${missing.join("; ")}; the other signals were reweighted`);
  if (unnamed > 0) notes.push(`${unnamed.toLocaleString("en-US")} unnamed path${unnamed === 1 ? " is" : "s are"} left out (not part of a named trail or route)`);
  if (commonsOnly && photosRun.ok) notes.push(COMMONS_ONLY_NOTE);
  if (photosRun.ok && photosRun.coverageNote) notes.push(`Photos: ${photosRun.coverageNote}`);
  if (trailsRun.coverageNote) notes.push(`Trails: ${trailsRun.coverageNote}`);

  return {
    kind: "geojson",
    data: { type: "FeatureCollection", features },
    ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    citation: citation("trails"),
  };
}

async function queryCampsites(ctx: QueryContext): Promise<LayerResult | LayerError> {
  const { run: photosPromise, commonsOnly } = photosRunFor(ctx);
  const [trailsRun, campsRun, photosRun]: ComposedResult[] = await Promise.all([
    runComposed("osm-trails", ctx, { namedOnly: false }, "trails"),
    runComposed("campsites", ctx, { includeParking: true, backcountryOnly: false }, "campsites"),
    photosPromise,
  ]);
  if (!campsRun.ok) return campsRun.error;

  const kindOf = (f: Feature) => f.properties?.kind;
  const missing: string[] = [];
  if (!photosRun.ok) missing.push(`${SIGNAL_LABELS.photos} (${photosRun.error.error})`);
  if (!trailsRun.ok) missing.push(`${SIGNAL_LABELS.informal} (${trailsRun.error.error})`);

  const features = scorePopularity({
    targets: campsRun.data.features.filter((f) => kindOf(f) === "camp_site"),
    photos: photosRun.ok ? photosRun.data.features : null,
    parking: campsRun.data.features.filter((f) => kindOf(f) === "parking"),
    trails: trailsRun.ok ? trailsRun.data.features : null,
    targetsAreTrails: false,
    refLat: (ctx.bbox[1] + ctx.bbox[3]) / 2,
  });

  const notes: string[] = [];
  if (missing.length > 0) notes.push(`Scored without ${missing.join("; ")}; the other signals were reweighted`);
  if (commonsOnly && photosRun.ok) notes.push(COMMONS_ONLY_NOTE);
  if (photosRun.ok && photosRun.coverageNote) notes.push(`Photos: ${photosRun.coverageNote}`);
  if (campsRun.coverageNote) notes.push(`Campsites: ${campsRun.coverageNote}`);

  const data: FeatureCollection = { type: "FeatureCollection", features };
  return {
    kind: "geojson",
    data,
    ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    citation: citation("campsites"),
  };
}

/** Builds the popularity layer for one target; trails and campsites are registered as separate layers so each has the right style. */
function popularityLayer(target: PopularityTarget): Layer {
  const trails = target === "trails";
  const layer = defineLayer({
    id: trails ? "popularity" : "popularity-campsites",
    title: trails ? "Trail popularity estimate" : "Campsite popularity estimate",
    description: trails ? TRAIL_DESCRIPTION : CAMPSITE_DESCRIPTION,
    coverage: "global",
    surface: "land",
    license: "Derived (see signals)",
    requiredEnv: [],
    // Composed layers read these from the same ctx.env, so they must be declared here.
    optionalEnv: ["MAPILLARY_TOKEN", "OVERPASS_URL"],
    maxAreaKm2: 2_500,
    input: z.object({}),
    style: {
      geometry: trails ? "line" : "point",
      color: layerColor(trails ? "popularity" : "popularity-campsites"),
      unit: "score",
      // The score sizes and colors each trail (wider and darker is busier); camp sites are colored by it.
      encode: trails ? { size: "v", color: "v" } : { color: "v" },
    },
    fieldHelp: trails ? TRAIL_HELP : CAMPSITE_HELP,
    card: trails ? TRAIL_CARD : CAMPSITE_CARD,
    attributes: [scoreAttribute(trails ? TRAIL_SCORE : CAMPSITE_SCORE), nameAttribute()],
    time: { shape: "none" },
    legend: legendFor(trails ? "trail" : "camp site"),
    labels: { field: "name", max: 10, rankBy: "v" },
    display: { timeZone: "local" },

    async query(ctx): Promise<LayerResult | LayerError> {
      const area = bboxAreaKm2(ctx.bbox);
      if (area > layer.maxAreaKm2) {
        return {
          error: `Area is ${Math.round(area)} km²; zoom in to under ${layer.maxAreaKm2} km²`,
          hint: "zoom_in",
        };
      }
      return trails ? queryTrails(ctx) : queryCampsites(ctx);
    },
  });
  return layer;
}

const popularity = popularityLayer("trails");
export const popularityCampsites = popularityLayer("campsites");

registerLayer(popularity);
registerLayer(popularityCampsites);

export default popularity;

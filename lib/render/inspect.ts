import type { Feature, Geometry, Position } from "geojson";
import type { BBox } from "@/layers/types";
import type { RenderMode, Selection } from "@/lib/render/state";
import { DECK_TERRAIN_TAG } from "@/lib/render/wally/deckTerrain";

/** Side B of a compare draws under `<layerId>~b` (lib/render/compareView.ts `compareBId`). */
const COMPARE_B_SUFFIX = "~b";

/**
 * Appended to the deck id of a hex compare's extruded delta columns (`<layerId>@hexdelta:points`), so the columns
 * (a GeoJsonLayer) never reuse the id of the flat H3HexagonLayer, which deck would then try to update in place.
 */
export const HEX_DELTA_TAG = "@hexdelta";

/** Mapbox layer and source ids for vector tile layers start with this (see components/mapTiles.ts). */
const TILES_PREFIX = "tiles-";
const RENDER_MODES: readonly RenderMode[] = ["points", "lines", "polygons", "heat", "columns", "hexbin"];

/** What deck.gl's picking returns for a click (the fields we read). */
export type DeckPick = {
  object?: unknown;
  layer?: { id: string } | null;
  coordinate?: number[] | null;
  x?: number;
  y?: number;
};

/** A feature from `map.queryRenderedFeatures` (the fields we read), plus the click. */
export type TilePick = {
  feature: {
    id?: string | number;
    source?: string;
    layer?: { id: string };
    geometry?: Geometry | null;
    properties?: Record<string, unknown> | null;
  };
  lngLat: [number, number];
  point?: { x: number; y: number };
};

export type Pick = DeckPick | TilePick;

function isTilePick(pick: Pick): pick is TilePick {
  return "feature" in pick && typeof pick.feature === "object" && pick.feature !== null;
}

function isFeature(value: unknown): value is Feature {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "Feature";
}

/**
 * The app layer id behind a deck layer id. Deck layers are named `<layerId>:<mode>` (`<layerId>@3d:<mode>` while draped on terrain); the white casing under a
 * line (`<layerId>:lines:casing`) and any sublayer are not inspectable, so they map to null.
 */
export function layerIdFromDeckId(deckId: string): string | null {
  const cut = deckId.lastIndexOf(":");
  if (cut <= 0) return null;
  const mode = deckId.slice(cut + 1);
  if (!RENDER_MODES.includes(mode as RenderMode)) return null;
  const layerId = deckId.slice(0, cut);
  // Layers draped on 3D terrain carry a tag after the layer id (see DECK_TERRAIN_TAG); hex delta columns carry theirs.
  for (const tag of [DECK_TERRAIN_TAG, HEX_DELTA_TAG]) if (layerId.endsWith(tag)) return layerId.slice(0, -tag.length);
  return layerId;
}

/** The app layer id behind a vector tile source (`tiles-<id>`) or Mapbox layer (`tiles-<id>`, `tiles-<id>-line`). */
export function layerIdFromTiles(feature: TilePick["feature"], known: Record<string, unknown>): string | null {
  if (feature.source?.startsWith(TILES_PREFIX)) {
    const id = feature.source.slice(TILES_PREFIX.length);
    if (id in known) return id;
  }
  const layer = feature.layer?.id;
  if (layer?.startsWith(TILES_PREFIX)) {
    const id = layer.slice(TILES_PREFIX.length).replace(/-line$/, "");
    if (id in known) return id;
  }
  return null;
}

/**
 * Turns a deck.gl pick or a vector tile feature into a selection, or null when the click hit nothing
 * inspectable (empty map, a casing, a layer that is no longer loaded). `known` is any record keyed by loaded
 * layer id (the map state's layers, or the catalog).
 */
export function pickToSelection(pick: Pick | null | undefined, known: Record<string, unknown>): Selection | null {
  if (!pick) return null;
  if (isTilePick(pick)) {
    const layerId = layerIdFromTiles(pick.feature, known);
    if (!layerId || !pick.feature.geometry) return null;
    // Mapbox features are live objects; keep a plain GeoJSON copy that can be copied and serialized.
    const feature: Feature = {
      type: "Feature",
      geometry: pick.feature.geometry,
      properties: { ...(pick.feature.properties ?? {}) },
      ...(pick.feature.id !== undefined && { id: pick.feature.id }),
    };
    return { layerId, feature, lngLat: pick.lngLat, ...(pick.point && { screen: pick.point }) };
  }
  if (!pick.layer || !isFeature(pick.object)) return null;
  const deckLayerId = layerIdFromDeckId(pick.layer.id);
  if (!deckLayerId) return null;
  // A compare's side B draws under a view-only id; the card belongs to the layer behind it, marked as side B.
  const sideB = deckLayerId.endsWith(COMPARE_B_SUFFIX);
  const layerId = sideB ? deckLayerId.slice(0, -COMPARE_B_SUFFIX.length) : deckLayerId;
  if (!(layerId in known)) return null;
  const coord = pick.coordinate;
  const lngLat: [number, number] =
    coord && coord.length >= 2 ? [coord[0], coord[1]] : (featureCenter(pick.object) ?? [0, 0]);
  const screen = typeof pick.x === "number" && typeof pick.y === "number" ? { x: pick.x, y: pick.y } : undefined;
  return { layerId, feature: pick.object, lngLat, ...(screen && { screen }), ...(sideB && { side: "b" as const }) };
}

function eachPosition(geometry: Geometry | null | undefined, visit: (p: Position) => void): void {
  if (!geometry) return;
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(visit);
      return;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach((ring) => ring.forEach(visit));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(visit)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((g) => eachPosition(g, visit));
  }
}

/** The feature's bounding box, or null when it has no coordinates. */
export function featureBBox(feature: Feature): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  eachPosition(feature.geometry, ([lng, lat]) => {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  });
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/** The center of the feature's bounding box: where the camera eases on select. */
export function featureCenter(feature: Feature): [number, number] | null {
  const bbox = featureBBox(feature);
  return bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null;
}

/** True for features a route preview can follow. */
export function isLineFeature(feature: Feature): boolean {
  return feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString";
}

/* ---------- Friendly property display ---------- */

/** Keys the card shows elsewhere (title, chip, value, signals) rather than as plain rows. */
const SPECIAL_KEYS = new Set(["name", "t", "v", "signals", "popularityNote"]);
/** Identifiers and links: real but rarely what a reader wants first, so they go under "Details". */
const DETAIL_KEY = /^(id|fid|gid|ref|h3|wikidata|wikipedia|osm_?id|osm_?type|objectid|globalid|irwinid|uuid)$|(_id|Id|ID)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/;

const LABELS: Record<string, string> = {
  sac_scale: "Difficulty (SAC)",
  trail_visibility: "Trail visibility",
  acres: "Acres",
  agency: "Agency",
  designation: "Designation",
  backcountry: "Backcountry",
  tents: "Tents allowed",
  caravans: "RVs allowed",
  fee: "Fee",
  capacity: "Capacity",
  kind: "Kind",
  year: "Year",
  informal: "Informal trail",
};

/** Labels for the `signals` of popularity and remoteness scores (some keys collide with plain properties). */
const SIGNAL_LABELS: Record<string, string> = {
  photos: "Photos within 500 m",
  parking: "Parking spaces within 1 km",
  wiki: "Has a Wikipedia link",
  informal: "Informal trails within 500 m",
  named: "Named",
  roadDistanceKm: "Nearest road",
  inWilderness: "In designated wilderness",
  campsitesWithin2km: "Campsites within 2 km",
};

const UNITS: Record<string, string> = { roadDistanceKm: "km" };

/** `sac_scale` → "Sac scale", `roadDistanceKm` → "Road distance km". */
export function friendlyKey(key: string, signal = false): string {
  const known = signal ? (SIGNAL_LABELS[key] ?? LABELS[key]) : LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "2021-08-14" → "Aug 14, 2021" (read as a calendar date, so no time-zone shift). */
export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatValue(value: unknown, unit?: string, key = ""): string {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  // Years read as "2021", not "2,021".
  if (typeof value === "number" && /year/i.test(key)) return String(value);
  if (typeof value === "number") {
    const text = Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return unit ? `${text} ${unit}` : text;
  }
  if (typeof value === "string") {
    if (value === "yes") return "Yes";
    if (value === "no") return "No";
    if (ISO_DATE.test(value)) return formatDate(value);
    // OSM enumerations like "mountain_hiking" read better with spaces.
    const text = /^[a-z0-9]+(_[a-z0-9]+)+$/.test(value) ? value.replace(/_/g, " ") : value;
    return unit ? `${text} ${unit}` : text;
  }
  return JSON.stringify(value);
}

export type Row = { key: string; label: string; value: string };

export type FeatureSummary = {
  /** The feature's name, or null when it has none. */
  name: string | null;
  /** `t` as a readable date, for the status chip. */
  date: string | null;
  /** `v` with the layer unit, e.g. "72 / 100" for scores or "1,204 acres". */
  value: Row | null;
  /** Up to `maxRows` plain property rows. */
  rows: Row[];
  /** Identifiers, links and any rows past `maxRows`. */
  details: Row[];
  /** `signals` for popularity and remoteness scores. */
  signals: Row[];
  estimate: boolean;
};

/** Mapbox stringifies nested properties in vector tiles; parse them back when they look like JSON objects. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

/** Splits a feature's properties into what the inspect card shows: name, date chip, value, rows, signals. */
export function summarizeFeature(feature: Feature, unit?: string, maxRows = 8): FeatureSummary {
  const props = feature.properties ?? {};
  const name = typeof props.name === "string" && props.name.trim() ? props.name.trim() : null;
  const date = typeof props.t === "string" ? formatDate(props.t) : typeof props.t === "number" ? String(props.t) : null;
  let value: Row | null = null;
  // Layers often copy a named property into `v` (fire perimeters: v = acres); the stat then takes that name.
  const twin =
    props.v === undefined ? undefined : Object.keys(props).find((k) => !SPECIAL_KEYS.has(k) && props[k] === props.v);
  if (typeof props.v === "number" || typeof props.v === "string") {
    value =
      unit === "score"
        ? { key: "v", label: "Score", value: `${formatValue(props.v)} / 100` }
        : { key: "v", label: twin ? friendlyKey(twin) : "Value", value: formatValue(props.v, unit) };
  }
  const signalsObj = asObject(props.signals);
  const signals: Row[] = signalsObj
    ? Object.entries(signalsObj).map(([key, v]) => ({ key, label: friendlyKey(key, true), value: formatValue(v, UNITS[key]) }))
    : [];

  const rows: Row[] = [];
  const details: Row[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (SPECIAL_KEYS.has(key) || key === twin || raw === null || raw === undefined || raw === "") continue;
    const row = { key, label: friendlyKey(key), value: formatValue(raw, undefined, key) };
    if (DETAIL_KEY.test(key) || rows.length >= maxRows) details.push(row);
    else rows.push(row);
  }
  if (feature.id !== undefined && !("id" in props)) details.unshift({ key: "id", label: "Id", value: String(feature.id) });
  return { name, date, value, rows, details, signals, estimate: props.popularityNote === "estimate" };
}

/** The chat message "Ask about this" sends: the layer, the feature's name and a short property summary. */
export function askAboutText(layerTitle: string, selection: Selection, unit?: string): string {
  const summary = summarizeFeature(selection.feature, unit, 6);
  const parts = [...(summary.value ? [summary.value] : []), ...summary.rows, ...summary.signals]
    .slice(0, 8)
    .map((r) => `${r.label}: ${r.value}`);
  if (summary.date) parts.unshift(`Date: ${summary.date}`);
  const [lng, lat] = selection.lngLat;
  parts.push(`at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  const subject = summary.name ? `"${summary.name}"` : "this feature";
  return `Tell me about ${layerTitle} ${subject} (${parts.join("; ")}).`;
}

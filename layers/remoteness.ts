/**
 * Remoteness score: fills the view with H3 hexagons and scores each 0-100 (100 = most remote)
 * from vector signals: distance from the cell centre to the nearest OSM road or track vertex
 * (Overpass, `out ids geom`), whether the centre is inside designated US wilderness (the
 * wilderness layer) or a Forest Service inventoried roadless area (EDW ArcGIS service, half the
 * bonus), and whether no camp site is within 2 km (the campsites layer). Each hexagon is named for
 * the nearest named peak, lake or glacier, else its wilderness, else its distance from a road.
 * By default only hexagons scoring 40 and up are returned (`minScore`), so the map shows where it is remote.
 * Weights and limits live in remoteness.config.ts.
 *
 * Not used: the global travel time to cities map (Weiss et al. 2018, Malaria Atlas Project) is a raster download with no
 * free live query this layer can read per hexagon, so it is left out.
 */
import { z } from "zod";
import { cellToBoundary, cellToLatLng, getHexagonAreaAvg, latLngToCell, polygonToCells } from "h3-js";
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp, type LegendSpec } from "./types";
import { getLayer, registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
import { arcgisQuery } from "./_shared/arcgis";
import { outsideUs } from "./_shared/coverage";
import { GridIndex, geometryBBox, haversineKm, pointInPolygon } from "./_shared/geo";
import { runComposed, type ComposedResult } from "./_shared/compose";
import { cacheKeyFor } from "@/lib/fetch/cache";
import {
  CAMP_RADIUS_KM,
  DEFAULT_MIN_SCORE,
  MAX_CELLS,
  MAX_ROAD_VERTICES,
  REMOTENESS_WEIGHTS,
  ROAD_DISTANCE_CAP_KM,
  ROAD_HIGHWAYS,
  PLACE_RADIUS_KM,
  ROAD_PADDING_KM,
  ROADLESS_SHARE,
} from "./remoteness.config";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  resolution: z.number().int().min(5).max(8).default(7),
  /** Hexagons scoring under this are left out; 0 returns every hexagon. */
  minScore: z.number().min(0).max(100).default(DEFAULT_MIN_SCORE),
});

/** Forest Service inventoried roadless areas (2001 Roadless Rule), US national forests. Public domain. */
export const ROADLESS_URL = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InventoriedRoadlessAreas2001_01/MapServer/0";

/** Coarsest H3 resolution the layer steps down to. */
const MIN_RESOLUTION = 5;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;
/** Long road segments get extra points this far apart, so distance to a vertex tracks distance to the road. */
const DENSIFY_KM = 1;
/** Road points closer together than this collapse to one; far below the scale of an H3 cell. */
const COLLAPSE_KM = 0.2;

export type RemotenessSignals = {
  roadDistanceKm: number;
  inWilderness: boolean | null;
  /** Present for US views when the roadless-area service answered. */
  inRoadlessArea?: boolean;
  campsitesWithin2km: number | null;
};

/** `bbox` grown by `km` on every side, clamped to valid longitudes and latitudes. */
export function padBBox(bbox: BBox, km: number): BBox {
  const [w, s, e, n] = bbox;
  const dLat = km / KM_PER_DEG_LAT;
  const midLat = (s + n) / 2;
  const dLon = km / (KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos((midLat * Math.PI) / 180), 0.05));
  return [Math.max(-180, w - dLon), Math.max(-90, s - dLat), Math.min(180, e + dLon), Math.min(90, n + dLat)];
}

/** Halves `bbox` along its longer side until every piece is under `maxKm2`. */
export function splitBBox(bbox: BBox, maxKm2: number): BBox[] {
  if (bboxAreaKm2(bbox) <= maxKm2) return [bbox];
  const [w, s, e, n] = bbox;
  const midLatRad = (((s + n) / 2) * Math.PI) / 180;
  const wide = (e - w) * Math.cos(midLatRad) >= n - s;
  const halves: BBox[] = wide
    ? [
        [w, s, (w + e) / 2, n],
        [(w + e) / 2, s, e, n],
      ]
    : [
        [w, s, e, (s + n) / 2],
        [w, (s + n) / 2, e, n],
      ];
  return halves.flatMap((h) => splitBBox(h, maxKm2));
}

/**
 * Overpass QL for roads and tracks with geometry only (no tags), then the named peaks, lakes and glaciers that name the
 * hexagons (centres and tags, at most 5,000). Overpass bbox order is (south,west,north,east).
 */
export function buildRoadsQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const a = `(${south},${west},${north},${east})`;
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(${ROAD_HIGHWAYS.join("|")})$"]${a};` +
    `out ids geom qt;` +
    `(node["natural"="peak"]["name"]${a};nwr["natural"~"^(water|glacier)$"]["name"]${a};);` +
    `out center qt 5000;`
  );
}

/** A named place a hexagon can be named after. */
export type Place = { name: string; kind: "peak" | "lake" | "glacier"; coord: Position };

/** Named peaks, lakes and glaciers from the roads query's answer (elements with a name and a position). */
export function placePoints(json: unknown): Place[] {
  const elements = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const out: Place[] = [];
  for (const raw of elements) {
    const el = (raw ?? {}) as { lat?: unknown; lon?: unknown; center?: { lat?: unknown; lon?: unknown }; tags?: Record<string, unknown> };
    const name = typeof el.tags?.name === "string" ? el.tags.name.trim() : "";
    const natural = el.tags?.natural;
    const kind = natural === "peak" ? "peak" : natural === "water" ? "lake" : natural === "glacier" ? "glacier" : null;
    const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
    const lon = typeof el.lon === "number" ? el.lon : el.center?.lon;
    if (!name || !kind || typeof lat !== "number" || typeof lon !== "number") continue;
    out.push({ name, kind, coord: [lon, lat] });
  }
  return out;
}

/**
 * Keeps the first point in each ~`cellKm` square, so dense town grids collapse while every point
 * of a sparse, lone track survives.
 */
export function collapseToGrid(points: Position[], cellKm: number): Position[] {
  const seen = new Set<string>();
  const out: Position[] = [];
  for (const p of points) {
    const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos((p[1] * Math.PI) / 180), 0.01);
    const key = `${Math.floor((p[0] * kmPerDegLon) / cellKm)},${Math.floor((p[1] * KM_PER_DEG_LAT) / cellKm)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Road vertices as [lng, lat] from an Overpass `out geom` body. Long segments are densified to
 * about 1 km, points are collapsed to one per ~200 m square, and only if still over `max` is the
 * set thinned evenly.
 */
export function roadVertices(json: unknown, max: number = MAX_ROAD_VERTICES): Position[] {
  const elements = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const all: Position[] = [];
  for (const el of elements) {
    const geometry = (el as { geometry?: unknown })?.geometry;
    if (!Array.isArray(geometry)) continue;
    let prev: Position | null = null;
    for (const raw of geometry) {
      const { lat, lon } = (raw ?? {}) as { lat?: unknown; lon?: unknown };
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      const p: Position = [lon, lat];
      if (prev) {
        const steps = Math.floor(haversineKm(prev, p) / DENSIFY_KM);
        for (let k = 1; k <= steps; k++) {
          const t = k / (steps + 1);
          all.push([prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t]);
        }
      }
      all.push(p);
      prev = p;
    }
  }
  const collapsed = collapseToGrid(all, COLLAPSE_KM);
  if (collapsed.length <= max) return collapsed;
  const stride = collapsed.length / max;
  return Array.from({ length: max }, (_, i) => collapsed[Math.floor(i * stride)]);
}

/** 0..1, rising fast over the first few kilometres from a road and flattening toward the cap. */
export function roadDistanceScore(km: number): number {
  const d = Math.min(Math.max(km, 0), ROAD_DISTANCE_CAP_KM);
  return Math.log1p(d) / Math.log1p(ROAD_DISTANCE_CAP_KM);
}

/** H3 cells whose centres fall in `bbox` (at least the cell under the bbox centre). */
export function cellsForBBox(bbox: BBox, resolution: number): string[] {
  const [w, s, e, n] = bbox;
  const ring = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  const cells = polygonToCells([ring], resolution, true);
  return cells.length > 0 ? cells : [latLngToCell((s + n) / 2, (w + e) / 2, resolution)];
}

/** The cell's hexagon as a closed [lng, lat] ring (h3-js closes GeoJSON-format loops; close it if not). */
export function cellPolygon(cell: string): Polygon {
  const ring = cellToBoundary(cell, true);
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = first[0] === last[0] && first[1] === last[1];
  return { type: "Polygon", coordinates: [closed ? ring : [...ring, first]] };
}

type Container = { bbox: [number, number, number, number]; geometry: Geometry };

export type ScoreCellsInputs = {
  cells: string[];
  roads: Position[];
  /** Wilderness polygons (with `name`), or null when unknown (outside the US or the layer failed). */
  wilderness: Feature[] | null;
  /** Forest Service inventoried roadless areas (with `name`), or null when unknown (outside the US or the service failed). */
  roadless?: Feature[] | null;
  /** Camp site points, or null when the campsites layer failed. */
  camps: Feature[] | null;
  /** Named peaks, lakes and glaciers to name the hexagons by. */
  places?: Place[];
  refLat: number;
};

type NamedContainer = Container & { name: string };

function containersOf(features: Feature[] | null | undefined): NamedContainer[] {
  const out: NamedContainer[] = [];
  features?.forEach((f) => {
    const bbox = geometryBBox(f.geometry);
    const name = typeof f.properties?.name === "string" ? f.properties.name.trim() : "";
    if (bbox && f.geometry) out.push({ bbox, geometry: f.geometry, name });
  });
  return out;
}

/** The first area holding `center`, or null. */
function holder(containers: NamedContainer[], center: Position): NamedContainer | null {
  const [lng, lat] = center;
  return containers.find((c) => lng >= c.bbox[0] && lng <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && pointInPolygon(center, c.geometry)) ?? null;
}

/** "12 km from the nearest road", or "20 km or more" at the cap. */
export function roadDistanceName(km: number): string {
  if (km >= ROAD_DISTANCE_CAP_KM) return `${ROAD_DISTANCE_CAP_KM} km or more from the nearest road`;
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${rounded.toLocaleString("en-US")} km from the nearest road`;
}

/**
 * One scored hexagon per cell, named for a person to read: "Near Gannett Peak" (the nearest named peak, lake or glacier
 * within PLACE_RADIUS_KM), else "In Bridger Wilderness", else "14 km from the nearest road".
 */
export function scoreCells(inputs: ScoreCellsInputs): Feature<Polygon>[] {
  const { cells, roads, wilderness, roadless = null, camps, places = [], refLat } = inputs;

  const roadIndex = new GridIndex<null>(1, refLat);
  for (const p of roads) roadIndex.add(p, null);

  const campIndex = new GridIndex<null>(CAMP_RADIUS_KM, refLat);
  camps?.forEach((f) => {
    if (f.geometry?.type === "Point") campIndex.add(f.geometry.coordinates, null);
  });

  const placeIndex = new GridIndex<number>(PLACE_RADIUS_KM, refLat);
  places.forEach((p, i) => placeIndex.add(p.coord, i));

  const wild = containersOf(wilderness);
  const unroaded = containersOf(roadless);

  return cells.map((cell) => {
    const [lat, lng] = cellToLatLng(cell);
    const center: Position = [lng, lat];

    const nearest = roadIndex.nearestKm(center, ROAD_DISTANCE_CAP_KM);
    const roadDistanceKm = Math.min(nearest, ROAD_DISTANCE_CAP_KM);

    const wildArea = wilderness === null ? null : holder(wild, center);
    const inWilderness = wilderness === null ? null : wildArea !== null;
    const roadlessArea = roadless === null ? null : holder(unroaded, center);
    const inRoadlessArea = roadless === null ? null : roadlessArea !== null;

    let campsitesWithin2km: number | null = null;
    if (camps !== null) {
      let n = 0;
      campIndex.forEachWithin(center, CAMP_RADIUS_KM, () => (n += 1));
      campsitesWithin2km = n;
    }

    let place: { p: Place; km: number } | null = null;
    placeIndex.forEachWithin(center, PLACE_RADIUS_KM, (i, km) => {
      if (!place || km < place.km) place = { p: places[i], km };
    });
    const near = place as { p: Place; km: number } | null;

    const protection = inWilderness === true ? 1 : inRoadlessArea === true ? ROADLESS_SHARE : 0;
    const score =
      REMOTENESS_WEIGHTS.roadDistance * roadDistanceScore(roadDistanceKm) +
      REMOTENESS_WEIGHTS.wilderness * protection +
      REMOTENESS_WEIGHTS.noCamps * (campsitesWithin2km === 0 ? 1 : 0);

    const signals: RemotenessSignals = {
      roadDistanceKm: Math.round(roadDistanceKm * 10) / 10,
      inWilderness,
      ...(inRoadlessArea !== null && { inRoadlessArea }),
      campsitesWithin2km,
    };
    const wildName = wildArea?.name || undefined;
    const name = near ? `Near ${near.p.name}` : wildName ? `In ${wildName}` : roadDistanceName(roadDistanceKm);
    return {
      type: "Feature",
      geometry: cellPolygon(cell),
      properties: {
        h3: cell,
        v: Math.round(100 * score),
        name,
        ...(near && { near: near.p.name, nearKind: near.p.kind, nearKm: Math.round(near.km * 10) / 10 }),
        ...(wildName && { wilderness: wildName }),
        ...(roadlessArea?.name && { roadlessArea: roadlessArea.name }),
        signals,
      },
    };
  });
}

function tooManyCells(count: number, resolution: number): LayerError {
  return {
    error: `This view needs about ${Math.round(count).toLocaleString("en-US")} hexagons even at resolution ${resolution}, over the ${MAX_CELLS.toLocaleString("en-US")} limit; zoom in`,
    hint: "zoom_in",
  };
}

const pct = (weight: number) => `${Math.round(weight * 100)}%`;

const SCORE_HELP: FieldHelp = {
  text:
    "An estimate computed by this app from map data, not a measure of solitude: distance from the hexagon centre to the nearest " +
    `OpenStreetMap road or track (on a log scale up to ${ROAD_DISTANCE_CAP_KM} km, ${pct(REMOTENESS_WEIGHTS.roadDistance)}), ` +
    `inside designated US wilderness (${pct(REMOTENESS_WEIGHTS.wilderness)}) or a Forest Service roadless area (half that; both US only), ` +
    `and no camp site within ${CAMP_RADIUS_KM} km (${pct(REMOTENESS_WEIGHTS.noCamps)}).`,
  scale: "0 (on a road, by a campground) to 100 (far from roads, in wilderness); 40 and up is remote; outside the US at most 80",
  source: "This app, from OpenStreetMap, US wilderness boundaries, Forest Service roadless areas and the campsites layer",
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "v",
    type: "measure",
    label: "Remoteness",
    unit: "score",
    help: SCORE_HELP,
    presets: [
      { label: "Near roads (under 40)", max: 40 },
      { label: "Remote (40 to 70)", min: 40, max: 70 },
      { label: "Very remote (70 and up)", min: 70 },
    ],
  },
  { key: "name", type: "name", label: "Place" },
];

const HELP: Record<string, FieldHelp> = {
  v: SCORE_HELP,
  signals: {
    text:
      "The raw signals behind the score: roadDistanceKm (to the nearest mapped road or track, capped), inWilderness, inRoadlessArea (US) and " +
      "campsitesWithin2km; null when that source was unavailable.",
  },
  near: { text: `The nearest named peak, lake or glacier within ${PLACE_RADIUS_KM} km of the hexagon's centre.`, source: "OpenStreetMap" },
  nearKm: { text: "Distance from the hexagon's centre to that place." },
  wilderness: { text: "The designated wilderness the hexagon's centre lies in.", source: "Wilderness.net / USGS" },
  roadlessArea: {
    text: "The Forest Service inventoried roadless area (2001 Roadless Rule) the hexagon's centre lies in: national forest land kept free of new roads.",
    source: "USDA Forest Service",
    url: "https://data.fs.usda.gov/geodata/edw/datasets.php",
  },
  h3: { text: "The H3 hexagon cell id (Uber's hexagonal grid) this score is for." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Remoteness score" },
  facts: [
    { key: "near", label: "Nearest named place" },
    { key: "nearKm", label: "Distance to it", format: "km" },
    { key: "wilderness", label: "Wilderness" },
    { key: "roadlessArea", label: "Forest Service roadless area" },
  ],
  hidden: ["h3", "nearKind"],
};

const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Remoteness score",
  field: "v",
  unit: "score",
  stops: [
    { label: "Beside a road", value: 0 },
    { label: "Remote: about 5 km from a road", value: DEFAULT_MIN_SCORE },
    { label: "Very remote", value: 70 },
    { label: "Far from any road, in wilderness", value: 100 },
  ],
  note: `Hexagons under ${DEFAULT_MIN_SCORE} are hidden by default. An estimate from map data; outside the US scores reach at most 80.`,
};

const remoteness = defineLayer({
  id: "remoteness",
  title: "Remoteness score",
  description:
    "How remote each hexagon in view is, from 0 (on a road, by a campground) to 100 (far from any road, inside wilderness, no campsites near). It is an estimate from map data, not a measure of solitude. " +
    `By default only hexagons scoring ${DEFAULT_MIN_SCORE} and up (remote: about 5 km or more from a road) are returned, so the map shows where it is remote; set minScore to 0 for every hexagon, or higher for the most remote. ` +
    "Signals: distance from the hexagon centre to the nearest OpenStreetMap road or track (counts up to 20 km; most weight), inside a designated US wilderness area or (half the bonus) a Forest Service inventoried roadless area (US only, so scores elsewhere top out at 80), and no camp site within 2 km (a small bonus). " +
    `Each hexagon has v (the score), name (the nearest named peak, lake or glacier within ${PLACE_RADIUS_KM} km as "Near Gannett Peak", else "In <wilderness>", else "12 km from the nearest road"), near, nearKm, wilderness, roadlessArea, h3 (the H3 cell id) and signals { roadDistanceKm, inWilderness, inRoadlessArea, campsitesWithin2km } (null when that signal was unavailable). ` +
    "resolution sets the hexagon size: 5 (about 250 km² each), 6 (36 km²), 7 (default, 5 km²) or 8 (0.7 km²); at most 4,000 hexagons per request, so a large view steps down to a coarser resolution on its own. " +
    "Caveats: OpenStreetMap misses some roads and tracks, so remote-looking cells can have unmapped access. " +
    "The view can be up to 60,000 km² (about a 245 km square); if it needs more than 4,000 hexagons the resolution is lowered automatically and the coverageNote says which was used.",
  coverage: "global",
  surface: "land",
  license: "Derived (see signals)",
  requiredEnv: [],
  // The campsites layer reads OVERPASS_URL from the same ctx.env, so it must be declared here.
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 60_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("remoteness"), unit: "score", encode: { color: "v" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: LEGEND,
  labels: { field: "name", max: 5, rankBy: "v" },
  display: { timeZone: "local" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > remoteness.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${remoteness.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }
    const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

    // Step the resolution down (7 to 6 to 5) until the view fits under the cell cap.
    let resolution = input.resolution;
    let cells: string[] | null = null;
    for (;;) {
      // Estimate first so an oversized request never builds a huge cell list.
      const estimate = area / getHexagonAreaAvg(resolution, "km2");
      const over = estimate > MAX_CELLS * 1.25 ? estimate : null;
      if (over === null) {
        const found = cellsForBBox(ctx.bbox, resolution);
        if (found.length <= MAX_CELLS) {
          cells = found;
          break;
        }
        if (resolution <= MIN_RESOLUTION) return tooManyCells(found.length, resolution);
      } else if (resolution <= MIN_RESOLUTION) {
        return tooManyCells(over, resolution);
      }
      resolution -= 1;
    }

    const us = !outsideUs(ctx.bbox);
    const campsLayer = getLayer("campsites");
    const campBoxes = splitBBox(padBBox(ctx.bbox, CAMP_RADIUS_KM), campsLayer?.maxAreaKm2 ?? Infinity);

    // Signals do not depend on resolution, so their cache keys leave it out and every resolution shares them.
    const shared = { ...ctx, cacheKey: ctx.cacheKey === undefined ? undefined : cacheKeyFor(remoteness.id, ctx.bbox, {}) };

    // Wilderness and roadless areas are ArcGIS, so they run alongside the roads query; campsites wait for roads so
    // only one Overpass query is in flight at a time (Overpass limits concurrent queries per IP).
    const wildPromise = us ? runComposed("wilderness", shared, {}, "wilderness") : Promise.resolve(null);
    const roadlessPromise = us
      ? arcgisQuery(shared, ROADLESS_URL, {
          outFields: ["name", "forest"],
          bbox: ctx.bbox,
          maxAllowableOffset: 0.002,
          orderByFields: "acres DESC",
          ttlSeconds: 30 * 86_400,
          cacheSuffix: "roadless",
        })
      : Promise.resolve(null);
    const roadsRun = await overpassQuery(shared, buildRoadsQuery(padBBox(ctx.bbox, ROAD_PADDING_KM)), {
      cacheSuffix: "roads-places",
    });
    if (!roadsRun.ok) return { error: roadsRun.error, hint: "upstream" };

    const campRuns: ComposedResult[] = [];
    for (const [i, bbox] of campBoxes.entries()) {
      const run = await runComposed(
        "campsites",
        { ...shared, bbox },
        { includeParking: false, backcountryOnly: false },
        `campsites:${i}`,
      );
      campRuns.push(run);
      if (!run.ok) break;
    }
    const [wildRun, roadlessRun] = await Promise.all([wildPromise, roadlessPromise]);

    const notes: string[] = [];
    if (resolution !== input.resolution) {
      notes.push(`Used resolution ${resolution} instead of ${input.resolution} to keep the view under ${MAX_CELLS.toLocaleString("en-US")} hexagons`);
    }
    let wilderness: Feature[] | null = null;
    let roadless: Feature[] | null = null;
    if (!us) {
      notes.push("Outside the US there is no wilderness or roadless-area bonus, so scores reach at most 80");
    } else {
      if (wildRun && wildRun.ok) {
        wilderness = wildRun.data.features;
        if (wildRun.coverageNote) notes.push(`Wilderness: ${wildRun.coverageNote}`);
      } else if (wildRun && !wildRun.ok) {
        notes.push(`Scored without the wilderness bonus (${wildRun.error.error})`);
      }
      if (roadlessRun && roadlessRun.ok) {
        roadless = roadlessRun.fc.features.map((f) => ({ ...f, properties: { name: roadlessName(f.properties ?? {}) } }));
      } else if (roadlessRun && !roadlessRun.ok) {
        notes.push(`Scored without Forest Service roadless areas (${roadlessRun.error})`);
      }
    }

    let camps: Feature[] | null = [];
    for (const run of campRuns) {
      if (!run.ok) {
        camps = null;
        notes.push(`Scored without the no-campsite bonus (${run.error.error})`);
        break;
      }
      camps.push(...run.data.features.filter((f) => f.properties?.kind === "camp_site"));
      if (run.coverageNote) notes.push(`Campsites: ${run.coverageNote}`);
    }

    const scored = scoreCells({
      cells,
      roads: roadVertices(roadsRun.json),
      wilderness,
      roadless,
      camps,
      places: placePoints(roadsRun.json),
      refLat: (ctx.bbox[1] + ctx.bbox[3]) / 2,
    });
    const features = minScore > 0 ? scored.filter((f) => (f.properties?.v as number) >= minScore) : scored;
    if (minScore > 0) {
      notes.push(
        features.length === 0
          ? `No hexagon in view scores ${minScore} or more, so none is remote by this measure; ask for minScore 0 to see every hexagon`
          : `Showing the ${features.length.toLocaleString("en-US")} of ${scored.length.toLocaleString("en-US")} hexagons scoring ${minScore} or more; ask for minScore 0 to see every hexagon`,
      );
    }

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source:
          "WallyMap remoteness estimate derived from OpenStreetMap contributors (ODbL), US wilderness boundaries (Wilderness.net / USGS) and USDA Forest Service inventoried roadless areas; H3 hexagons",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

/** A roadless area's name as a person reads it: "West Slope Winds roadless area (Bridger-Teton National Forest)". */
export function roadlessName(props: Record<string, unknown>): string {
  const name = typeof props.name === "string" ? props.name.trim() : "";
  const forest = typeof props.forest === "string" ? props.forest.trim() : "";
  const label = name ? `${name} roadless area` : "Roadless area";
  return forest ? `${label} (${forest} National Forest)` : label;
}

registerLayer(remoteness);

export default remoteness;

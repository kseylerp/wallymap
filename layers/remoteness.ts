/**
 * Remoteness score: fills the view with H3 hexagons and scores each 0-100 (100 = most remote)
 * from vector signals: distance from the cell centre to the nearest OSM road or track vertex
 * (Overpass, `out ids geom`), whether the centre is inside designated US wilderness (the
 * wilderness layer), and whether no camp site is within 2 km (the campsites layer).
 * Weights and limits live in remoteness.config.ts. Raster signals (human footprint, night
 * lights, population) arrive in Milestone 3.
 */
import { z } from "zod";
import { cellToBoundary, cellToLatLng, getHexagonAreaAvg, latLngToCell, polygonToCells } from "h3-js";
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { getLayer, registerLayer } from "./registry";
import { overpassQuery } from "./_shared/overpass";
import { outsideUs } from "./_shared/coverage";
import { GridIndex, geometryBBox, haversineKm, pointInPolygon } from "./_shared/geo";
import { runComposed, type ComposedResult } from "./_shared/compose";
import { cacheKeyFor } from "@/lib/fetch/cache";
import {
  CAMP_RADIUS_KM,
  MAX_CELLS,
  MAX_ROAD_VERTICES,
  REMOTENESS_WEIGHTS,
  ROAD_DISTANCE_CAP_KM,
  ROAD_HIGHWAYS,
  ROAD_PADDING_KM,
} from "./remoteness.config";
import { layerColor } from "@/lib/render/palette";

const inputSchema = z.object({
  resolution: z.number().int().min(5).max(8).default(7),
});

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

/** Overpass QL for roads and tracks with geometry only (no tags). Overpass bbox order is (south,west,north,east). */
export function buildRoadsQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return (
    `[out:json][timeout:25];` +
    `way["highway"~"^(${ROAD_HIGHWAYS.join("|")})$"](${south},${west},${north},${east});` +
    `out ids geom qt;`
  );
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
  /** Wilderness polygons, or null when unknown (outside the US or the layer failed). */
  wilderness: Feature[] | null;
  /** Camp site points, or null when the campsites layer failed. */
  camps: Feature[] | null;
  refLat: number;
};

/** One scored hexagon per cell. */
export function scoreCells(inputs: ScoreCellsInputs): Feature<Polygon>[] {
  const { cells, roads, wilderness, camps, refLat } = inputs;

  const roadIndex = new GridIndex<null>(1, refLat);
  for (const p of roads) roadIndex.add(p, null);

  const campIndex = new GridIndex<null>(CAMP_RADIUS_KM, refLat);
  camps?.forEach((f) => {
    if (f.geometry?.type === "Point") campIndex.add(f.geometry.coordinates, null);
  });

  const containers: Container[] = [];
  wilderness?.forEach((f) => {
    const bbox = geometryBBox(f.geometry);
    if (bbox && f.geometry) containers.push({ bbox, geometry: f.geometry });
  });

  return cells.map((cell) => {
    const [lat, lng] = cellToLatLng(cell);
    const center: Position = [lng, lat];

    const nearest = roadIndex.nearestKm(center, ROAD_DISTANCE_CAP_KM);
    const roadDistanceKm = Math.min(nearest, ROAD_DISTANCE_CAP_KM);

    let inWilderness: boolean | null = null;
    if (wilderness !== null) {
      inWilderness = containers.some(
        (c) =>
          lng >= c.bbox[0] && lng <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && pointInPolygon(center, c.geometry),
      );
    }

    let campsitesWithin2km: number | null = null;
    if (camps !== null) {
      let n = 0;
      campIndex.forEachWithin(center, CAMP_RADIUS_KM, () => (n += 1));
      campsitesWithin2km = n;
    }

    const score =
      REMOTENESS_WEIGHTS.roadDistance * roadDistanceScore(roadDistanceKm) +
      REMOTENESS_WEIGHTS.wilderness * (inWilderness === true ? 1 : 0) +
      REMOTENESS_WEIGHTS.noCamps * (campsitesWithin2km === 0 ? 1 : 0);

    const signals: RemotenessSignals = {
      roadDistanceKm: Math.round(roadDistanceKm * 10) / 10,
      inWilderness,
      campsitesWithin2km,
    };
    return {
      type: "Feature",
      geometry: cellPolygon(cell),
      properties: { h3: cell, v: Math.round(100 * score), signals },
    };
  });
}

function tooManyCells(count: number, resolution: number): LayerError {
  return {
    error: `This view needs about ${Math.round(count).toLocaleString("en-US")} hexagons even at resolution ${resolution}, over the ${MAX_CELLS.toLocaleString("en-US")} limit; zoom in`,
    hint: "zoom_in",
  };
}

const remoteness = defineLayer({
  id: "remoteness",
  title: "Remoteness score",
  description:
    "How remote each hexagon in view is, from 0 (on a road, by a campground) to 100 (far from any road, inside wilderness, no campsites near). It is an estimate from map data, not a measure of solitude. " +
    "Signals: distance from the hexagon centre to the nearest OpenStreetMap road or track (counts up to 20 km; most weight), inside a designated US wilderness area (a bonus, US only, so scores elsewhere top out at 80), and no camp site within 2 km (a small bonus). " +
    "Each hexagon has v (the score), h3 (the H3 cell id) and signals { roadDistanceKm, inWilderness, campsitesWithin2km } (null when that signal was unavailable). " +
    "resolution sets the hexagon size: 5 (about 250 km² each), 6 (36 km²), 7 (default, 5 km²) or 8 (0.7 km²); at most 4,000 hexagons per request, so a large view steps down to a coarser resolution on its own. " +
    "Caveats: OpenStreetMap misses some roads and tracks, so remote-looking cells can have unmapped access; raster signals (human footprint, night lights, population) arrive in Milestone 3. " +
    "The view can be up to 60,000 km² (about a 245 km square); if it needs more than 4,000 hexagons the resolution is lowered automatically and the coverageNote says which was used.",
  coverage: "global",
  license: "Derived (see signals)",
  requiredEnv: [],
  // The campsites layer reads OVERPASS_URL from the same ctx.env, so it must be declared here.
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 60_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("remoteness"), unit: "score" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > remoteness.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${remoteness.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

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

    // Wilderness is ArcGIS, so it runs alongside the roads query; campsites wait for roads so
    // only one Overpass query is in flight at a time (Overpass limits concurrent queries per IP).
    const wildPromise = us ? runComposed("wilderness", shared, {}, "wilderness") : Promise.resolve(null);
    const roadsRun = await overpassQuery(shared, buildRoadsQuery(padBBox(ctx.bbox, ROAD_PADDING_KM)), {
      cacheSuffix: "roads",
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
    const wildRun = await wildPromise;

    const notes: string[] = [];
    if (resolution !== input.resolution) {
      notes.push(`Used resolution ${resolution} instead of ${input.resolution} to keep the view under ${MAX_CELLS.toLocaleString("en-US")} hexagons`);
    }
    let wilderness: Feature[] | null = null;
    if (!us) {
      notes.push("Outside the US there is no wilderness bonus, so scores reach at most 80");
    } else if (wildRun && wildRun.ok) {
      wilderness = wildRun.data.features;
      if (wildRun.coverageNote) notes.push(`Wilderness: ${wildRun.coverageNote}`);
    } else if (wildRun && !wildRun.ok) {
      notes.push(`Scored without the wilderness bonus (${wildRun.error.error})`);
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

    const features = scoreCells({
      cells,
      roads: roadVertices(roadsRun.json),
      wilderness,
      camps,
      refLat: (ctx.bbox[1] + ctx.bbox[3]) / 2,
    });

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source:
          "WildMap remoteness estimate derived from OpenStreetMap contributors (ODbL) and US wilderness boundaries (Wilderness.net / USGS); H3 hexagons",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(remoteness);

export default remoteness;

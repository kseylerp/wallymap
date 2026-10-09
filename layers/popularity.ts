/**
 * Popularity estimate: a 0-100 score per trail (or campsite) computed from free signals by
 * calling other layers' queries directly (osm-trails, campsites with parking, photos).
 * Signals and weights live in popularity.config.ts. Each signal is rank-normalized within the
 * features in view, so 100 means "busiest-looking feature in this view", not a visitor count.
 * When a signal's layer fails, the score uses the remaining signals (weights rescaled) and
 * coverageNote says which were left out; when the target layer itself fails, its error is returned.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { GridIndex, lineMidpoint } from "./_shared/geo";
import { runComposed, type ComposedResult } from "./_shared/compose";
import {
  INFORMAL_RADIUS_KM,
  MAX_SAMPLE_POINTS_PER_LINE,
  PARKING_RADIUS_KM,
  PHOTO_RADIUS_KM,
  POPULARITY_WEIGHTS,
  type PopularitySignal,
} from "./popularity.config";

const inputSchema = z.object({
  target: z.enum(["trails", "campsites"]).default("trails"),
});

export type PopularitySignals = {
  photos: number | null;
  parking: number | null;
  wiki: boolean;
  informal: number | null;
  named: boolean;
};

/**
 * Rank-normalizes values to 0..1: zero (or less) maps to 0, otherwise the share of values at or
 * below it, so the largest value maps to 1 and ties share a rank.
 */
export function rankNormalize(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
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
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

/** Computes signals and the 0-100 score for every target feature. */
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

const SIGNAL_LABELS = {
  photos: "photo counts",
  parking: "parking capacity",
  informal: "informal trail counts",
} as const;

const popularity = defineLayer({
  id: "popularity",
  title: "Popularity estimate",
  description:
    "An estimate of how popular each trail (default) or campsite in view is, as a score from 0 (quietest) to 100 (busiest-looking in this view). It is an estimate built from public signals, not live or measured foot traffic. " +
    "Signals: geotagged photos within 500 m (Wikimedia Commons and, when configured, Mapillary), parking capacity within 1 km, a Wikipedia or Wikidata link, informal (social) trails within 500 m, and whether the feature is named. " +
    "Each feature has v (the score), signals { photos, parking (spaces), wiki, informal, named } (null when that signal was unavailable) and popularityNote 'estimate'. " +
    "Scores rank features against each other in the current view, so the same trail can score differently in a different view. " +
    "Set target to 'campsites' to score camp sites instead of trails. Coverage is global but the signals are richer in the US and Europe, where OpenStreetMap and photo coverage is denser; " +
    "if a signal's source fails the score uses the others and the result says which were left out. Zoom in to a region under 2,500 km² (about a 50 km square) first.",
  coverage: "global",
  license: "Derived (see signals)",
  requiredEnv: [],
  // Composed layers read these from the same ctx.env, so they must be declared here.
  optionalEnv: ["MAPILLARY_TOKEN", "OVERPASS_URL"],
  maxAreaKm2: 2_500,
  input: inputSchema,
  style: { geometry: "line", color: "#F2A33A", unit: "score" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > popularity.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${popularity.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const [trailsRun, campsRun, photosRun]: ComposedResult[] = await Promise.all([
      runComposed("osm-trails", ctx, { namedOnly: false }, "trails"),
      runComposed("campsites", ctx, { includeParking: true, backcountryOnly: false }, "campsites"),
      runComposed("photos", ctx, {}, "photos"),
    ]);

    const targetRun = input.target === "trails" ? trailsRun : campsRun;
    if (!targetRun.ok) return targetRun.error;

    const kindOf = (f: Feature) => f.properties?.kind;
    const targets =
      input.target === "trails"
        ? targetRun.data.features
        : targetRun.data.features.filter((f) => kindOf(f) === "camp_site");

    const missing: string[] = [];
    if (!photosRun.ok) missing.push(`${SIGNAL_LABELS.photos} (${photosRun.error.error})`);
    if (!campsRun.ok) missing.push(`${SIGNAL_LABELS.parking} (${campsRun.error.error})`);
    if (!trailsRun.ok) missing.push(`${SIGNAL_LABELS.informal} (${trailsRun.error.error})`);

    const features = scorePopularity({
      targets,
      photos: photosRun.ok ? photosRun.data.features : null,
      parking: campsRun.ok ? campsRun.data.features.filter((f) => kindOf(f) === "parking") : null,
      trails: trailsRun.ok ? trailsRun.data.features : null,
      targetsAreTrails: input.target === "trails",
      refLat: (ctx.bbox[1] + ctx.bbox[3]) / 2,
    });

    const notes: string[] = [];
    if (missing.length > 0) {
      notes.push(`Scored without ${missing.join("; ")}; the other signals were reweighted`);
    }
    if (photosRun.ok && photosRun.coverageNote) notes.push(`Photos: ${photosRun.coverageNote}`);
    if (campsRun.ok && campsRun.coverageNote) notes.push(`Campsites: ${campsRun.coverageNote}`);

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation: {
        source:
          "WildMap popularity estimate derived from OpenStreetMap contributors (ODbL), Wikimedia Commons and Mapillary (CC BY-SA 4.0)",
        url: "https://www.openstreetmap.org/copyright",
        retrieved: new Date().toISOString(),
      },
    };
  },
});

registerLayer(popularity);

export default popularity;

import type { Feature, LineString, Position } from "geojson";
import { haversineM } from "@/lib/spatial/geo";
import type { MapState } from "@/lib/render/state";
import { createStore } from "@/lib/render/wally/playback";

/**
 * The cross-section chart's side of the elevation-profile layer (layers/elevation-profile.ts): reading the answer's
 * profile off its line, the vertical exaggeration a chart draws at, and the point on the map the chart's cursor
 * stands for. Browser-safe: no elevation tiles here (lib/terrain reads those on the server).
 */

export const CROSS_SECTION_LAYER = "elevation-profile";

/**
 * The vertical exaggeration a chart `width` by `height` pixels draws a profile at: how many times steeper it looks than
 * the ground is (1 is true to scale; a short, steep line can draw under 1).
 */
export function verticalExaggeration(lengthM: number, reliefM: number, width = 360, height = 140): number {
  if (!(lengthM > 0) || !(reliefM > 0) || !(width > 0) || !(height > 0)) return 1;
  const ve = height / reliefM / (width / lengthM);
  return ve >= 2 ? Math.round(ve) : Math.round(ve * 10) / 10;
}

export type CrossSectionView = {
  name: string;
  line: Position[];
  distancesM: number[];
  /** Metres; null where the elevation model had nothing. */
  elevationsM: (number | null)[];
  startName?: string;
  endName?: string;
  highestAtM?: number;
  steepest?: { fromM: number; toM: number; gradePct: number; deg: number };
  receivedAt: string;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** The profile a cross-section feature carries, or null when it carries none. */
export function profileOfFeature(feature: Feature, receivedAt = ""): CrossSectionView | null {
  if (feature.geometry?.type !== "LineString") return null;
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const d = p.profileDistancesM;
  const e = p.profileElevationsM;
  if (!Array.isArray(d) || !Array.isArray(e) || d.length < 2 || d.length !== e.length) return null;
  const from = num(p.steepestFromM);
  const to = num(p.steepestToM);
  const grade = num(p.steepestGradePct);
  const deg = num(p.steepestDeg);
  return {
    name: str(p.name) ?? "Cross-section",
    line: (feature.geometry as LineString).coordinates,
    distancesM: d.map((x) => Number(x)),
    elevationsM: e.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : null)),
    ...(str(p.startName) && { startName: str(p.startName) }),
    ...(str(p.endName) && { endName: str(p.endName) }),
    ...(num(p.highestAtM) !== undefined && { highestAtM: num(p.highestAtM) }),
    ...(from !== undefined && to !== undefined && grade !== undefined && deg !== undefined && { steepest: { fromM: from, toM: to, gradePct: grade, deg } }),
    receivedAt,
  };
}

/** The cross-section on the map (the elevation-profile layer, drawn), or null. */
export function crossSectionOnMap(state: Pick<MapState, "layers" | "renderOps">): CrossSectionView | null {
  const layer = state.layers[CROSS_SECTION_LAYER];
  if (!layer || layer.result.kind !== "geojson") return null;
  const op = state.renderOps.find((o) => o.layerId === CROSS_SECTION_LAYER);
  if (op && op.visible === false) return null;
  for (const f of layer.result.data.features) {
    const view = profileOfFeature(f, layer.receivedAt);
    if (view) return view;
  }
  return null;
}

/** The point `distanceM` along a line (clamped to its ends), interpolated on each straight segment. */
export function pointAlong(line: Position[], distanceM: number): [number, number] | null {
  if (line.length === 0) return null;
  let left = Math.max(0, distanceM);
  for (let i = 1; i < line.length; i++) {
    const seg = haversineM(line[i - 1], line[i]);
    if (left <= seg && seg > 0) {
      const k = left / seg;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k];
    }
    left -= seg;
  }
  const last = line[line.length - 1];
  return [last[0], last[1]];
}

/** Where the cross-section chart's cursor stands on the map, while a pointer is over the chart; MapCanvas draws a dot there. */
export const profileCursorStore = createStore<[number, number] | null>(null);

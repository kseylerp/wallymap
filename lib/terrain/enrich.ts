import type { Feature, Position } from "geojson";
import type { Attribute, CardFact, FieldHelp, Layer, LayerError, LayerResult } from "@/layers/types";
import { pathsOf, verticesOf } from "@/lib/spatial/geo";
import { compass8, profileOf, resample, shadedThrough, steepestFaceNear, sunPath } from "./analysis";
import { type Dem, loadDemTiles, metresPerPixel, TERRAIN_CITATION_SOURCE, tileKeyOf, type TileSource } from "./dem";

/**
 * Terrain on the cards of layers whose question needs it (audit R7): a crag's aspect, the slope around it and whether
 * it is in shade through the afternoon; a trail's climb, descent and high point; a ski route's steepest ground. Run
 * by lib/layers/run.ts on every answer of these layers (never in tests: TERRAIN_ENRICH=off), within a time budget; on
 * failure the answer is unchanged but for one clause in its coverage note, so a missing number is never silent.
 * The extra card facts, attributes and help join the layer's own at registration (withTerrainFields).
 */

type Kind = "point" | "line";
type Spec = { kind: Kind; slope?: boolean };

/** The layers enriched, and how. */
export const TERRAIN_ENRICHED: Record<string, Spec> = {
  climbing: { kind: "point" },
  "osm-trails": { kind: "line" },
  popularity: { kind: "line" },
  "mtb-trails": { kind: "line" },
  "ski-routes": { kind: "line", slope: true },
};

const ELEVATION_SOURCE = `${TERRAIN_CITATION_SOURCE}; computed by this app`;

export const TERRAIN_HELP: Record<string, FieldHelp> = {
  aspect: {
    text: "The way the steepest ground within 150 m of the crag faces (its wall, when the mapped point sits at the base), from a 10 to 30 m elevation model; a wall in a gully or on a buttress can face another way.",
    source: ELEVATION_SOURCE,
  },
  slopeDeg: { text: "The steepest ground within 150 m of the crag, from the elevation model (a cliff itself is steeper than a 10 to 30 m model can see).", unit: "°", source: ELEVATION_SOURCE },
  afternoonShade: {
    text: "True when a wall facing this way gets no direct sun for most of 1 to 5 pm solar time today: it faces away from the afternoon sun. Shadows cast by other ridges are not counted.",
    source: ELEVATION_SOURCE,
  },
  gainM: {
    text: "Total climb along the line as drawn, from the elevation model sampled every 10 to 30 m, counting rises of more than 3 m.",
    unit: "m",
    source: ELEVATION_SOURCE,
  },
  lossM: { text: "Total descent along the line as drawn, counted the same way as the climb.", unit: "m", source: ELEVATION_SOURCE },
  highM: { text: "The highest point on the line, from the elevation model.", unit: "m", source: ELEVATION_SOURCE },
  maxSlopeDeg: {
    text: "The steepest ground the route crosses (the slope of the terrain, not the track's grade); 30 to 45° is where most slab avalanches start.",
    unit: "°",
    source: ELEVATION_SOURCE,
  },
};

const ASPECT_LEVELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((v) => ({ value: v, label: v }));

const POINT_FACTS: CardFact[] = [
  { key: "aspect", label: "Faces" },
  { key: "slopeDeg", label: "Steepest ground nearby", unit: "°", format: "int" },
  { key: "afternoonShade", label: "Afternoon shade", values: { true: "Yes, faces away from the afternoon sun", false: "No, in the afternoon sun" } },
];
const LINE_FACTS: CardFact[] = [
  { key: "gainM", label: "Climb", unit: "m", format: "int" },
  { key: "lossM", label: "Descent", unit: "m", format: "int" },
  { key: "highM", label: "High point", unit: "m", format: "int" },
];
const SLOPE_FACT: CardFact = { key: "maxSlopeDeg", label: "Steepest ground crossed", unit: "°", format: "int" };

const POINT_ATTRIBUTES: Attribute[] = [
  { key: "afternoonShade", type: "flag", label: "Shaded in the afternoon" },
  { key: "aspect", type: "category", label: "Faces", levels: ASPECT_LEVELS },
];
const LINE_ATTRIBUTES: Attribute[] = [
  {
    key: "gainM",
    type: "measure",
    label: "Climb",
    unit: "m",
    presets: [
      { label: "Flat: under 100 m", max: 100 },
      { label: "Rolling: 100 to 500 m", min: 100, max: 500 },
      { label: "Big climb: 500 m and up", min: 500 },
    ],
  },
];
const SLOPE_ATTRIBUTE: Attribute = {
  key: "maxSlopeDeg",
  type: "measure",
  label: "Steepest ground crossed",
  unit: "°",
  presets: [
    { label: "Low-angle: under 30°", max: 30 },
    { label: "Avalanche terrain: 30 to 45°", min: 30, max: 45 },
    { label: "Over 45°", min: 45 },
  ],
};

/** The layer with the terrain card facts, attributes and help added (unchanged for layers not enriched). */
export function withTerrainFields<L extends Layer>(layer: L): L {
  const spec = TERRAIN_ENRICHED[layer.id];
  if (!spec) return layer;
  const facts = spec.kind === "point" ? POINT_FACTS : [...LINE_FACTS, ...(spec.slope ? [SLOPE_FACT] : [])];
  // A layer's first measure is its primary one (what a ranked view and "the highest" read): the terrain measures are
  // added only after a measure of the layer's own, never in its place. Without one, gainM and maxSlopeDeg are still
  // properties that render.filters and rankBy read.
  const ownMeasure = (layer.attributes ?? []).some((a) => a.type === "measure");
  const attributes = (spec.kind === "point" ? POINT_ATTRIBUTES : [...LINE_ATTRIBUTES, ...(spec.slope ? [SLOPE_ATTRIBUTE] : [])]).filter(
    (a) => a.type !== "measure" || ownMeasure,
  );
  const keys = new Set(facts.map((f) => f.key));
  const help = Object.fromEntries([...keys].map((k) => [k, TERRAIN_HELP[k]]));
  const own = layer.card ?? {};
  return {
    ...layer,
    card: { ...own, facts: [...(own.facts ?? []).filter((f) => !keys.has(f.key)), ...facts] },
    attributes: [...(layer.attributes ?? []).filter((a) => !keys.has(a.key)), ...attributes],
    fieldHelp: { ...layer.fieldHelp, ...help },
    description: `${layer.description} ${spec.kind === "point" ? "Each crag also carries aspect (the way it faces), slopeDeg and afternoonShade (true when it faces away from the afternoon sun today) from an elevation model." : `Each line also carries gainM, lossM and highM (climb, descent and high point in metres from an elevation model)${spec.slope ? " and maxSlopeDeg (the steepest ground it crosses)" : ""}.`}`,
  };
}

/** True when enrichment should run here (it never does in tests unless asked). */
export function terrainEnrichEnabled(): boolean {
  return process.env.TERRAIN_ENRICH !== "off";
}

/** Most elevation tiles one answer may load (each about 130 KB); past it the zoom drops, then enrichment is skipped. */
const MAX_TILES = 64;
const BUDGET_MS = 8_000;

function tilesFor(features: Feature[], kind: Kind, z: number): Set<string> {
  const keys = new Set<string>();
  // About 200 m of margin in degrees: the crag's wall is looked for within 150 m, so a tile edge nearby loads its neighbour.
  const pad = 0.002;
  for (const f of features) {
    if (kind === "point") {
      const p = verticesOf(f.geometry)[0];
      if (!p) continue;
      for (const [dx, dy] of [[0, 0], [-pad, -pad], [pad, -pad], [-pad, pad], [pad, pad]]) keys.add(tileKeyOf(p[0] + dx, p[1] + dy, z));
    } else {
      for (const path of pathsOf(f.geometry)) for (const p of resample(path, 200)) keys.add(tileKeyOf(p[0], p[1], z));
    }
  }
  return keys;
}

function enrichPoint(f: Feature, dem: Dem, path: ReturnType<typeof sunPath>): Feature {
  const p: Position | undefined = verticesOf(f.geometry)[0];
  if (!p) return f;
  const sa = steepestFaceNear(dem, p[0], p[1], 150);
  if (!sa) return f;
  const props: Record<string, unknown> = { slopeDeg: Math.round(sa.slope) };
  // Under about 15° nothing nearby is steep enough to be the wall: no face is claimed (a boulder field on a bench).
  if (sa.slope >= 15 && !Number.isNaN(sa.aspect)) {
    props.aspect = compass8(sa.aspect);
    props.afternoonShade = shadedThrough(90, sa.aspect, path);
  }
  return { ...f, properties: { ...f.properties, ...props } };
}

function enrichLine(f: Feature, dem: Dem, slope: boolean): Feature {
  const profile = profileOf(dem, pathsOf(f.geometry), { slope });
  if (!profile) return f;
  return {
    ...f,
    properties: { ...f.properties, gainM: profile.gainM, lossM: profile.lossM, highM: profile.maxM, ...(slope && { maxSlopeDeg: profile.maxSlopeDeg }) },
  };
}

/**
 * The properties to filter or rank by and the top features by them, in the coverage note the model reads: "(gainM
 * and lossM in metres: rank by gainM or filter its range; most climb: Saddle Rock Trail 420 m, ...)".
 */
function terrainHint(features: Feature[], spec: Spec): string {
  const named = features.filter((f) => typeof f.properties?.name === "string");
  if (spec.kind === "point") {
    const shaded = features.filter((f) => f.properties?.afternoonShade === true).length;
    return ` (aspect N to NW and afternoonShade true or false: filter on them; ${shaded} face away from the afternoon sun today)`;
  }
  const key = spec.slope ? "maxSlopeDeg" : "gainM";
  const top = named
    .filter((f) => typeof f.properties?.[key] === "number")
    .sort((x, y) => (y.properties![key] as number) - (x.properties![key] as number))
    .filter((f, i, all) => all.findIndex((g) => g.properties?.name === f.properties?.name) === i)
    .slice(0, 3)
    .map((f) => `${f.properties!.name} ${f.properties![key]}${spec.slope ? "°" : " m"}`);
  const keys = spec.slope ? "gainM and lossM in metres and maxSlopeDeg in degrees" : "gainM and lossM in metres";
  return ` (${keys}: rank by ${key} or filter its range${top.length > 0 ? `; most ${spec.slope ? "steep" : "climb"}: ${top.join(", ")}` : ""})`;
}

function withNote<R extends LayerResult>(result: R, clause: string): R {
  return { ...result, coverageNote: [result.coverageNote, clause].filter(Boolean).join("; ") };
}

/**
 * Adds terrain to an answer of an enriched layer: features gain the properties above, and the coverage note says
 * where the numbers come from (or why they are missing). Other layers, errors and tiles pass through.
 */
export async function enrichWithTerrain<R extends LayerResult | LayerError>(
  layerId: string,
  result: R,
  opts: { source?: TileSource; now?: Date; budgetMs?: number } = {},
): Promise<R> {
  const spec = TERRAIN_ENRICHED[layerId];
  if (!spec || "error" in result || result.kind !== "geojson" || result.data.features.length === 0) return result;
  const features = result.data.features;
  const work = async (): Promise<R> => {
    let z = 12;
    let keys = tilesFor(features, spec.kind, z);
    while (keys.size > MAX_TILES && z > 10) keys = tilesFor(features, spec.kind, --z);
    if (keys.size > MAX_TILES) return withNote(result, "Elevation numbers were left out: the features spread over too wide an area") as R;
    const dem = await loadDemTiles(z, keys, opts.source);
    if (dem.tileCount === 0) return withNote(result, "Elevation numbers were left out: the terrain tiles did not answer") as R;
    const lat = features.map((f) => verticesOf(f.geometry)[0]?.[1]).find((v) => v !== undefined) ?? 0;
    const path = sunPath(lat, opts.now ?? new Date(), "afternoon");
    const enriched = features.map((f) => (spec.kind === "point" ? enrichPoint(f, dem, path) : enrichLine(f, dem, spec.slope === true)));
    const done = enriched.filter((f, i) => f !== features[i]).length;
    const what = spec.kind === "point" ? "Aspect, slope and afternoon shade" : spec.slope ? "Climb, descent and steepest ground" : "Climb and descent";
    const clause = `${what} for ${done} of ${features.length} from AWS Terrain Tiles at about ${Math.round(metresPerPixel(lat, z))} m${terrainHint(enriched, spec)}`;
    return { ...withNote(result, clause), data: { ...result.data, features: enriched } } as R;
  };
  const timeout = new Promise<R>((resolve) =>
    setTimeout(() => resolve(withNote(result, "Elevation numbers were left out: the terrain tiles were too slow") as R), opts.budgetMs ?? BUDGET_MS).unref?.(),
  );
  try {
    return await Promise.race([work(), timeout]);
  } catch {
    return withNote(result, "Elevation numbers were left out: the terrain tiles could not be read") as R;
  }
}

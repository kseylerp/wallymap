import { NoSuchToolError, tool, type JSONValue, type ToolCallRepairFunction, type ToolSet } from "ai";
import { z } from "zod";
import { getLayer, listLayers } from "@/layers/registry";
import { BBoxSchema, bboxAreaKm2, hardMaxAreaKm2, type BBox, type Coverage, type Layer, type LayerError, type LayerResult } from "@/layers/types";
import { runLayer } from "@/lib/layers/run";
import { encodingSentence, highestOf, isFullLayerResult, summarizeLayerResult, type GeojsonSummary, type SummaryStyle } from "@/lib/layers/summarize";
import { VIEW_KINDS, type Basemap, type RenderMode, type TimeMode } from "@/lib/render/state";
import { boxAround, nearBox, nearPlace, OFF_RADIUS_KM, offPlace } from "./places";
import { matchingQuestion, withReading } from "./readingGuard";
import { inUS, usSpeeds, usSpeedsDeep } from "./units";
import { normalizeRenderInput } from "./renderInput";
import { ROUTE_PROFILES, routeOutputForModel, runRouteTool } from "./route";
import { checkNote } from "./noteCheck";
import { createTurn, inputKeyOf, isWideQuery, MAX_STEPS, placeKey, type Turn } from "./turn";
import { canonicalLayerId, repairToolName } from "./toolNames";
import { combineTool } from "@/lib/spatial/tool";
import { gistFor } from "./vocabulary";
import type { GeocodeResult } from "./geocode";
import type { MapView } from "./view";

const BASEMAPS = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2", "data-only"] as const satisfies readonly Basemap[];
/**
 * `render.mode` as the model sees it. `symbols` is the map's `points` mode; `points` and `hexbin` (flat hex tiles) are
 * still accepted from older replies. lib/agent/applyToolResult.ts maps them onto RenderMode.
 */
export const TOOL_RENDER_MODES = [
  "symbols",
  "clusters",
  "heat",
  "columns",
  "lines",
  "polygons",
  "points",
  "hexbin",
] as const satisfies readonly (RenderMode | "symbols")[];

/** Per property: keep only these category values, and/or only numbers inside [min, max]. */
export const LayerFiltersSchema = z.record(
  z.string(),
  z.object({
    include: z
      .array(z.string())
      .optional()
      .describe("Keep features whose value (or any item of a list) is one of these: a chip's include values from the query summary's attributes"),
    range: z.tuple([z.number(), z.number()]).optional().describe("Keep features whose number is in [min, max]: a measure preset's range"),
    match: z.string().optional().describe("Keep features whose text (a name) contains these words"),
  }),
);

/** `render.hexBasis` as the model sees it: what a hex cell's color means (spec §12d); share takes `hexShare`. */
export const HEX_BASES = ["count", "sum", "share", "recency"] as const;

const TIME_MODES = ["slide", "cumulative"] as const satisfies readonly TimeMode[];

const COMPARE_MODES = ["swipe", "toggle", "delta"] as const;

/** `YYYY-MM-DD` or a full ISO timestamp. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use YYYY-MM-DD or a full ISO timestamp")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a real date");
const CompareWindowSchema = z.tuple([IsoDateSchema, IsoDateSchema]);

const LngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/**
 * One list_layers row: "id | title | coverage | gist", plus " | unavailable" when this server lacks the layer's key.
 * Kept to one short line on purpose: the system prompt already carries every layer's synonyms and notes, and each
 * query_<id> tool its description, so the list only has to say what exists and where.
 */
export type LayerRow = string;

/** A list_layers row asked for by id: the layer's full description and data licence. */
export type LayerDetail = {
  id: string;
  title: string;
  coverage: string;
  available: boolean;
  gist: string;
  description: string;
  license: string;
};

function isAvailable(layer: Layer): boolean {
  return layer.outage === undefined && layer.requiredEnv.every((name) => Boolean(process.env[name]));
}

/** The sentence a layer under a documented outage leads its tool description with. */
function outageSentence(layer: Layer): string {
  return layer.outage ? `Unavailable since ${layer.outage.since}: ${layer.outage.reason}; say so plainly if asked. ` : "";
}

function describeCoverage(coverage: Coverage): string {
  if (coverage === "global") return "worldwide";
  if (coverage === "us") return "the United States";
  return `the bbox [${coverage.bbox.join(", ")}]`;
}

/** Coverage in a list_layers row: "worldwide", "US" or the bbox. */
function rowCoverage(coverage: Coverage): string {
  if (coverage === "global") return "worldwide";
  if (coverage === "us") return "US";
  return `[${coverage.bbox.join(", ")}]`;
}

/** Most characters of a layer's own description that go into its query tool on every turn. */
export const TOOL_DESCRIPTION_MAX_CHARS = 600;

/**
 * Sections that only route words to layers, which the vocabulary table in the system prompt already does:
 * "User words: ..." and "Example questions: ...", each up to the sentence that follows it.
 */
const ROUTING_SECTION = /\s*(?:User words|Example questions?):[\s\S]*?\.(?=\s+[A-Z(]|\s*$)/g;

/** Sentences kept even past the cap: the area limit (the model must zoom in first) and "map tiles, not features" honesty. */
const ESSENTIAL_SENTENCE = /km²|map tiles/i;
const MAP_TILES_SENTENCE = /map tiles/i;

/** A sentence that leans on the one before it. */
const REFERS_BACK = /^(?:It|Its|This|These|They|That|Those)\b|^Leave (?:it|them|both) out\b/;

/** Splits prose into sentences at a stop and a space, except after "e.g." and similar abbreviations. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|vs|approx|Mt|St)\.)\s+/).filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sentences that explain inputs may take a description up to this length; the rest (properties, units, caveats)
 * only fill up to TOOL_DESCRIPTION_MAX_CHARS.
 */
export const TOOL_DESCRIPTION_INPUT_CEILING = 1_100;

/**
 * A layer description as its query tool carries it. The "User words" and "Example questions" sections go (the
 * vocabulary routes words), then whole sentences are kept, in their original order, by priority: the first
 * sentence (what the layer is) and the area-limit and map-tiles sentences always (with `wide`, only map tiles: the
 * query tool states the area limits in wideSentence); sentences that name one of
 * `inputs` (how to call it) up to TOOL_DESCRIPTION_INPUT_CEILING; then the rest (properties, units, caveats)
 * while the whole stays within `max`. list_layers with ids returns the full text.
 */
export function compactDescription(
  description: string,
  { inputs = [], max = TOOL_DESCRIPTION_MAX_CHARS, wide = false }: { inputs?: string[]; max?: number; wide?: boolean } = {},
): string {
  const stripped = description.replace(ROUTING_SECTION, "").trim();
  if (stripped.length <= max) return stripped;
  const all = sentences(stripped);
  const inputPattern = inputs.length > 0 ? new RegExp(`\\b(?:${inputs.map(escapeRegExp).join("|")})\\b`) : null;
  // A layer with a wide strategy gets its area limits from wideSentence, so its own km² sentences only fill.
  const essential = wide ? MAP_TILES_SENTENCE : ESSENTIAL_SENTENCE;
  const keep = all.map((sentence, i) => i === 0 || essential.test(sentence));
  let length = all.reduce((sum, sentence, i) => (keep[i] ? sum + sentence.length + 1 : sum), 0);
  const fill = (ceiling: number, wanted: (sentence: string) => boolean) =>
    all.forEach((sentence, i) => {
      if (keep[i] || !wanted(sentence) || length + sentence.length + 1 > ceiling) return;
      // "It is given for ..." or "Leave it out ..." means nothing once the sentence it refers to is gone.
      if (REFERS_BACK.test(sentence) && !keep[i - 1]) return;
      keep[i] = true;
      length += sentence.length + 1;
    });
  if (inputPattern) fill(Math.max(max, TOOL_DESCRIPTION_INPUT_CEILING), (sentence) => inputPattern.test(sentence));
  fill(max, () => true);
  return all.filter((_, i) => keep[i]).join(" ");
}

/** The input field names a layer's query tool takes (its own, before bbox and zoom are added). */
function inputNames(layer: Layer): string[] {
  const shape = (layer.input as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * What the model sees for a query result. A full result (often megabytes of
 * GeoJSON) becomes a short summary; errors and results the browser already
 * summarized before resending the history pass through unchanged.
 */
export function layerResultForModel(output: unknown, layerId?: string, style?: SummaryStyle, fieldHelp?: Layer["fieldHelp"]): JSONValue {
  if (isFullLayerResult(output)) return summarizeLayerResult(output, layerId, style, fieldHelp) as JSONValue;
  return output as JSONValue;
}

/** One "at a wider scale, use" suggestion: a layer, and the input that makes it work over a wide view. */
export type WiderScaleHint = { layerId: string; input?: Record<string, string | number | boolean | string[]> };

/**
 * outdoor-features answers up to 1,500,000 km² with named features only (over 10,000 km²); every suggestion of it asks for
 * huts, viewpoints and waterfalls, the kinds worth hiking to, so peaks do not crowd them out of the 2,000 kept.
 */
const WIDE_OUTDOOR_FEATURES: WiderScaleHint = { layerId: "outdoor-features", input: { kinds: ["hut", "viewpoint", "waterfall"] } };

/**
 * At a wider scale, use: for a layer with a small area cap, the layers that answer the same kind of question over a
 * view too wide for it, best first. Each query_<id> tool names them, and a zoom_in error for the user's current view
 * lists the ones whose cap and coverage fit that view (`widerScale`), so the model can still draw an answer at the
 * scale the user is looking at instead of only asking them to zoom in.
 * Hiking and trail questions fall back to places worth hiking to (peaks; huts, viewpoints and waterfalls; recreation
 * sites; protected areas), never to where people live (population, night-lights): osm-trails itself already answers
 * up to 400,000 km² with named routes.
 */
export const WIDER_SCALE: Record<string, WiderScaleHint[]> = {
  "osm-trails": [
    { layerId: "peaks" },
    WIDE_OUTDOOR_FEATURES,
    { layerId: "recreation-sites" },
    { layerId: "protected-areas-world" },
  ],
  popularity: [{ layerId: "osm-trails" }, { layerId: "peaks" }, WIDE_OUTDOOR_FEATURES, { layerId: "recreation-sites" }, { layerId: "protected-areas-world" }],
  "mtb-trails": [{ layerId: "recreation-sites" }, { layerId: "public-lands" }, { layerId: "protected-areas-world" }],
  "ski-routes": [{ layerId: "peaks" }, { layerId: "snow-cover" }],
  paddling: [{ layerId: "streamflow" }, { layerId: "surface-water" }],
  photos: [{ layerId: "peaks" }, WIDE_OUTDOOR_FEATURES, { layerId: "protected-areas-world" }],
  "wikipedia-nearby": [WIDE_OUTDOOR_FEATURES, { layerId: "peaks" }, { layerId: "protected-areas-world" }],
  campsites: [{ layerId: "recreation-sites" }, { layerId: "public-lands" }, { layerId: "protected-areas-world" }, { layerId: "wilderness" }],
  "forest-roads": [{ layerId: "public-lands" }, { layerId: "recreation-sites" }],
  climbing: [{ layerId: "peaks" }, { layerId: "geology" }],
  // Past its 1,500,000 km² hard limit, fall back to these.
  "outdoor-features": [{ layerId: "peaks" }, { layerId: "protected-areas-world" }],
  "recreation-sites": [{ layerId: "public-lands" }, { layerId: "wilderness" }, { layerId: "protected-areas-world" }],
  peaks: [{ layerId: "physical-regions" }, { layerId: "protected-areas-world" }],
  species: [{ layerId: "gbif-occurrences", input: { density: true } }],
  fishing: [{ layerId: "streamflow" }, { layerId: "surface-water" }],
  lakes: [{ layerId: "surface-water" }],
  glaciers: [{ layerId: "snow-cover" }, { layerId: "land-cover" }],
  "tree-mortality": [{ layerId: "forest-loss" }, { layerId: "disturbance" }],
  remoteness: [{ layerId: "night-lights" }, { layerId: "population" }, { layerId: "protected-areas-world" }],
  "mining-claims": [{ layerId: "public-lands" }],
  mines: [{ layerId: "geology" }],
};

/**
 * "query_peaks", "query_gbif-occurrences with density: true" or "query_outdoor-features with kinds: [\"hut\",...]";
 * `short` (for the tool descriptions sent every turn) writes a list as "kinds hut/viewpoint/waterfall".
 */
function hintText({ layerId, input }: WiderScaleHint, style: "full" | "short" = "full"): string {
  const args = Object.entries(input ?? {}).map(([key, value]) =>
    Array.isArray(value) ? (style === "short" ? `${key} ${value.join("/")}` : `${key}: ${JSON.stringify(value)}`) : `${key}: ${String(value)}`,
  );
  return args.length > 0 ? `query_${layerId} with ${args.join(", ")}` : `query_${layerId}`;
}

/** Rough boxes of the lower 48, Alaska and Hawaii, for layers whose coverage is "us". */
const US_BOXES: BBox[] = [
  [-125, 24, -66, 50],
  [-170, 51, -129, 72],
  [-161, 18, -154, 23],
];

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function coversBBox(coverage: Coverage, bbox: BBox): boolean {
  if (coverage === "global") return true;
  if (coverage === "us") return US_BOXES.some((box) => intersects(box, bbox));
  return intersects(coverage.bbox, bbox);
}

/** The wider-scale suggestions for `layerId` whose layers exist, are available, cover `bbox` and accept its area, best first. */
export function widerScaleHints(layerId: string, bbox: BBox): WiderScaleHint[] {
  const area = bboxAreaKm2(bbox);
  return (WIDER_SCALE[layerId] ?? []).filter((hint) => {
    const layer = getLayer(hint.layerId);
    return layer !== undefined && isAvailable(layer) && area <= hardMaxAreaKm2(layer) && coversBBox(layer.coverage, bbox);
  });
}

/** The wider-scale layers for `layerId` that exist, are available, cover `bbox` and accept its area. */
export function widerScaleFor(layerId: string, bbox: BBox): string[] {
  return widerScaleHints(layerId, bbox).map((hint) => hintText(hint));
}

/** The query tool's sentence naming its wider-scale layers, or "" when it has none. */
function widerScaleSentence(layerId: string): string {
  const hints = WIDER_SCALE[layerId];
  if (!hints || hints.length === 0) return "";
  return ` At a wider scale, use ${hints.map((h) => hintText(h, "short").replace(/^query_/, "")).join(", ")}.`;
}

const km2 = (n: number) => `${Math.round(n).toLocaleString("en-US")} km²`;

/**
 * The query tool's sentence on its wide strategy, or "" without one: over maxAreaKm2 (up to the hard cap) the layer
 * still answers, with the N largest (or named) and a note, so the model must not shrink the box itself.
 */
export function wideSentence(layer: Pick<Layer, "maxAreaKm2" | "hardMaxAreaKm2" | "wide">): string {
  const wide = layer.wide;
  if (wide === undefined || !Number.isFinite(layer.maxAreaKm2)) return "";
  const hard = hardMaxAreaKm2(layer);
  const upTo = Number.isFinite(hard) ? ` (to ${km2(hard)})` : "";
  const limit = wide.limit.toLocaleString("en-US");
  const by = wide.orderBy ? ` by ${wide.orderBy}` : "";
  const kept =
    wide.mode === "tiles" ? "a density map" : wide.mode === "named" ? `the ${limit} named${by}` : `the ${limit} ${wide.rank ?? "largest"}${by}`;
  return ` Over ${km2(layer.maxAreaKm2)}${upTo} it returns ${kept}; never shrink the box.`;
}

/** A zoom_in error for the user's view, with the layers that can answer at that scale. */
export { repairToolName };

/** A series result's caption in the data's shape (the summary's story.caption), for the note check. */
function storyCaption(body: Extract<LayerResult, { kind: "geojson" }>, layer: Layer): string | undefined {
  const summary = summarizeLayerResult(body, layer.id, { ...layer.style, ...(layer.attributes && { attributes: layer.attributes }) }, layer.fieldHelp);
  return "story" in summary ? (summary as GeojsonSummary).story?.caption : undefined;
}

/** A zoom_in error for the user's view, with the layers that can answer at this scale. */
export type ZoomInError = LayerError & { widerScale?: string[] };

/** Query-tool input: the layer's own input fields plus the area to search. */
type QueryArgs = { bbox: BBox; zoom: number } & Record<string, unknown>;

/** How far (as a share of the view's width or height) a query box may poke past the view and still count as from it. */
const VIEW_TOLERANCE = 0.02;

/** True when `bbox` lies inside the view's box (within a small rounding margin): the query is about what is on screen. */
export function isWithinView(bbox: BBox, view: BBox): boolean {
  const [w, s, e, n] = view;
  const dx = (e - w) * VIEW_TOLERANCE;
  const dy = (n - s) * VIEW_TOLERANCE;
  return bbox[0] >= w - dx && bbox[1] >= s - dy && bbox[2] <= e + dx && bbox[3] <= n + dy;
}

/** The view a query answers from, or undefined when it does not (no view bbox, a place was geocoded, or the box is elsewhere). */
type ViewSource = (bbox: BBox) => { bbox: BBox; zoom: number } | undefined;

/** The part two boxes share, or null when they do not overlap. */
function intersectBox(a: BBox, b: BBox): BBox | null {
  const box: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}

/** The smallest box holding every box. */
function unionBox(boxes: BBox[]): BBox {
  return boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]);
}

/** True when a point lies in a box. */
function pointIn([lng, lat]: [number, number], [w, s, e, n]: BBox): boolean {
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

/**
 * The box a query runs on: for "near <town>" (a layer with a default radius), the radius box around the town the
 * query is about, which is the latest place geocoded this turn whose center lies in the box the model passed (so a
 * first lookup that found a same-named place elsewhere is never used); otherwise the box the model passed.
 */
function queryBox(turn: Turn, layerId: string, bbox: BBox): BBox {
  // A named region (a basin, a park, a range) the model searched well past: the part of the box inside the region ("dams
  // in the Colorado River basin" asked a box to 95°W and drew Fort Randall Dam in South Dakota; a box over the basin and
  // west Texas drew the Colorado River of Texas). Every region of the turn the box covers most of counts, so a box over
  // two named places keeps both.
  if (!nearPlace(turn.question)) {
    const parts = turn.places
      .filter((p) => p.source !== "mapbox")
      .map((p) => ({ p, inter: intersectBox(bbox, p.bbox) }))
      .filter((x): x is { p: GeocodeResult; inter: BBox } => x.inter !== null && bboxAreaKm2(x.inter) >= 0.5 * bboxAreaKm2(x.p.bbox));
    if (parts.length > 0) {
      const held = unionBox(parts.map((x) => x.inter));
      if (bboxAreaKm2(bbox) > 1.5 * bboxAreaKm2(held)) {
        turn.note(`${layerId}: queried within ${parts.map((x) => x.p.name).join(" and ")}, [${held.join(", ")}] instead of the wider [${bbox.join(", ")}]`);
        return held;
      }
    }
  }
  // "Off <town>": the sea next to it, a wide box around the town (its own box is land).
  const off = offPlace(turn.question);
  const offFrom = off ? turn.places.findLast((p) => pointIn(p.center, bbox)) : undefined;
  if (off && offFrom && bboxAreaKm2(bbox) < bboxAreaKm2(boxAround(offFrom.center, OFF_RADIUS_KM))) {
    const box = boxAround(offFrom.center, OFF_RADIUS_KM);
    turn.note(`${layerId}: "off ${off}" queried over the water around it, [${box.join(", ")}] instead of [${bbox.join(", ")}]`);
    return box;
  }
  const near = nearPlace(turn.question);
  const place = near ? turn.places.findLast((p) => pointIn(p.center, bbox)) : undefined;
  if (!place || !near) return bbox;
  const box = nearBox(turn.question, layerId, place);
  if (!box || (box[0] === bbox[0] && box[1] === bbox[1] && box[2] === bbox[2] && box[3] === bbox[3])) return bbox;
  turn.note(`${layerId}: "near ${near}" queried within the layer's radius around it, [${box.join(", ")}] instead of [${bbox.join(", ")}]`);
  return box;
}

/** A filter on a river's name: the key names a river or stream, or a value says River, Creek or Fork. */
function isRiverFilter(key: string, entry: Record<string, unknown>): boolean {
  if (/river|stream|waterway/i.test(key)) return true;
  const values = [...(Array.isArray(entry.include) ? entry.include : []), entry.match].filter((v): v is string => typeof v === "string");
  return values.some((v) => /\b(river|creek|fork)\b/i.test(v));
}

/**
 * A river's name held to the place the turn named: "dams on the Colorado River" filtered by river name also matched
 * the Colorado River of Texas (Robert Lee Dam ranked fourth). Each river-name filter gets `within`, the latest named
 * region of this turn (a basin, a park, a range: not a street or town), so only features inside it are kept, on the
 * map and in a permalink alike.
 */
export function holdToPlace<T extends Record<string, unknown>>(out: T, turn: Pick<Turn, "places">): T {
  const filters = out.filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return out;
  const region = turn.places.findLast((p) => p.source !== "mapbox");
  if (!region) return out;
  let changed = false;
  const held: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(filters as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && isRiverFilter(key, entry as Record<string, unknown>)) {
      held[key] = { ...entry, within: { bbox: region.bbox, name: region.name.replace(/\s*\(.*\)\s*$/, "") } };
      changed = true;
    } else held[key] = entry;
  }
  return changed ? { ...out, filters: held } : out;
}

/** True when a layer result has something to draw: features, or map tiles. */
function drawable(body: unknown): boolean {
  if (!body || typeof body !== "object" || "error" in body) return false;
  const b = body as { kind?: string; data?: { features?: unknown[] } };
  return b.kind === "tiles" || (b.kind === "geojson" && (b.data?.features?.length ?? 0) > 0);
}

function queryTool(layer: Layer, fromView: ViewSource = () => undefined, turn: Turn = createTurn()) {
  const style = { ...layer.style, ...(layer.attributes && { attributes: layer.attributes }), ...(layer.time && { time: layer.time }), title: layer.title };
  const speedy = style.unit === "m/s";
  /** What the model reads of an answer: its summary, speeds in mph or knots first for a US place (lib/agent/units.ts). */
  const summaryFor = (body: unknown) => {
    const base = layerResultForModel(body, layer.id, style, layer.fieldHelp);
    // The features that match the question's own filters, named, so the note can list candidates (lib/agent/readingGuard.ts).
    const matching = base && typeof base === "object" && !Array.isArray(base) ? matchingQuestion(body, layer.id, turn) : null;
    const summary = matching ? { ...(base as Record<string, JSONValue>), matchingQuestion: matching } : base;
    return speedy && inUS(summaryBox(summary)) ? withUsSpeeds(summary, layer.id) : summary;
  };
  /** What the model reads of an answer, with the features' own values a note may quote, for the grounding check. */
  const modelView = (body: unknown) => ({ summary: summaryFor(body), body });
  // The registry erases each layer's input shape, so zod cannot infer bbox and
  // zoom through extend(); the cast restores the two fields this tool adds.
  const inputSchema = layer.input.extend({
    bbox: BBoxSchema,
    zoom: z.number().default(10),
  }) as unknown as z.ZodType<QueryArgs>;
  return tool({
    // The licence and the trimmed sentences are in list_layers' detail (ids); the citation comes with each result.
    description: `${outageSentence(layer)}${compactDescription(layer.description, { inputs: inputNames(layer), wide: layer.wide !== undefined })} Covers ${describeCoverage(layer.coverage)}.${wideSentence(layer)}${widerScaleSentence(layer.id)} bbox is [west, south, east, north].`,
    inputSchema,
    execute: async ({ bbox: asked, zoom, ...input }) => {
      const bbox = queryBox(turn, layer.id, asked);
      const view = fromView(bbox);
      const body = (await runLayer(layer.id, { bbox, zoom, input, fromView: view })).body;
      const ok = !("error" in body);
      const highest = "kind" in body && body.kind === "geojson" ? highestOf(body.data.features, { ...layer.style, attributes: layer.attributes }) : undefined;
      const top = highest?.top[0] && { ...highest.top[0], by: highest.by, ...(highest.unit !== undefined && { unit: highest.unit }) };
      const zoomIn = "error" in body && body.hint === "zoom_in";
      const story = "kind" in body && body.kind === "geojson" && body.series ? body : undefined;
      const us = speedy && inUS(bbox);
      const rawCaption = story ? storyCaption(story, layer) : undefined;
      const rawMeaning = story ? encodingSentence({ ...layer.style, ...(layer.attributes && { attributes: layer.attributes }) }, story.flow !== undefined) : undefined;
      const caption = rawCaption && us ? usSpeeds(rawCaption, layer.id) : rawCaption;
      const meaning = rawMeaning && us ? usSpeeds(rawMeaning, layer.id) : rawMeaning;
      turn.queries.push({
        layerId: layer.id,
        bbox,
        inputKey: inputKeyOf(input),
        ok,
        drawable: drawable(body),
        wide: ok && isWideQuery(layer, bbox),
        ...(top && { top }),
        ...(zoomIn && { zoomIn }),
        ...(caption && { caption }),
        ...(meaning && { meaning }),
      });
      if (ok && layer.id === "physical-regions") turn.regionQueried = true;
      // What the model reads of this answer, kept for the note's grounding check (lib/agent/grounding.ts).
      turn.outputs.push(modelView(body));
      // A view or a named place too wide for this layer: name the layers that can still answer at this scale.
      if ("error" in body && body.hint === "zoom_in") {
        const widerScale = widerScaleFor(layer.id, view?.bbox ?? bbox);
        return widerScale.length > 0 || view ? ({ ...body, widerScale } satisfies ZoomInError) : body;
      }
      return body;
    },
    // The UI part keeps the full body for the map; the model gets a summary with v's statistics in the layer's unit.
    toModelOutput: ({ output }) => ({ type: "json", value: summaryFor(output) }),
  });
}

/** The extent a summary reports, if any. */
function summaryBox(summary: JSONValue): BBox | null {
  const box = summary && typeof summary === "object" && !Array.isArray(summary) ? (summary as Record<string, JSONValue>).bbox : null;
  return Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === "number") ? (box as unknown as BBox) : null;
}

/** A summary with its speeds in US units first, and its m/s statistics also in mph (or knots for water). */
function withUsSpeeds(summary: JSONValue, layerId: string): JSONValue {
  const out = usSpeedsDeep(summary, layerId);
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;
  const stats = (out as Record<string, JSONValue>).stats as Record<string, JSONValue> | null | undefined;
  if (!stats || typeof stats !== "object" || Array.isArray(stats) || stats.unit !== "m/s") return out;
  const water = layerId === "ocean-currents";
  const k = water ? 1.943844 : 2.236936;
  const conv = (v: JSONValue | undefined) => (typeof v === "number" ? Math.round(v * k * 10) / 10 : null);
  return { ...out, statsUS: { unit: water ? "knots" : "mph", min: conv(stats.min), max: conv(stats.max), mean: conv(stats.mean) } };
}

/** Tool names already repaired and logged, so each is logged once per server process. */
const repairedLogged = new Set<string>();

/**
 * For streamText / generateText `repairToolCall`: renames a call whose tool name carries trailing junk to the one tool
 * it means (logging each repaired name once); anything else, including a bad input, is left to fail as before.
 */
export const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, error }) => {
  if (!NoSuchToolError.isInstance(error)) return null;
  const fixed = repairToolName(toolCall.toolName, Object.keys(tools));
  if (fixed === null || fixed === toolCall.toolName) return null;
  if (!repairedLogged.has(toolCall.toolName)) {
    repairedLogged.add(toolCall.toolName);
    console.warn(`Repaired tool name ${JSON.stringify(toolCall.toolName)} to ${fixed}`);
  }
  return { ...toolCall, toolName: fixed };
};

/** The text of a geocode as the per-turn repeat guard compares it: case, punctuation and spacing ignored. */
export function geocodeKey(place: string): string {
  return place.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Builds the agent's tool set from the current layer registry. `view` is the map the user is looking at; the route tool
 * biases its place lookups to it. `turn` is this turn's shared record (lib/agent/turn.ts): the tools write what they
 * did into it, and the step guard reads it.
 */
export function buildTools({ view = null, turn = createTurn({ view }) }: { view?: MapView | null; turn?: Turn } = {}): ToolSet {
  // Tools are built per request, so this is per turn: once a place is geocoded, queries are about that place.
  let geocoded = false;
  // The geocode texts already answered this turn, so a repeat is marked as one.
  const answered = new Set<string>();
  const fromView: ViewSource = (bbox) =>
    view?.bbox && !geocoded && !turn.place && isWithinView(bbox, view.bbox) ? { bbox: view.bbox, zoom: view.zoom } : undefined;
  const tools: ToolSet = {
    list_layers: tool({
      description:
        "List every dataset layer, one row each: \"id | title | coverage | gist\", where coverage is worldwide, US or a bbox [west, south, east, north], " +
        "and \"| unavailable\" ends the row when this server lacks the layer's key. " +
        "Each query_<id> tool describes its layer briefly; pass ids to get those layers' full descriptions (every caveat and input) and data licences.",
      inputSchema: z.object({
        ids: z.array(z.string().max(64)).max(8).optional().describe("Layer ids to describe in full; omit to list every layer"),
      }),
      execute: async ({ ids }): Promise<LayerRow[] | LayerDetail[]> => {
        if (ids === undefined || ids.length === 0) {
          return listLayers().map((layer) =>
            [layer.id, layer.title, rowCoverage(layer.coverage), gistFor(layer.id), isAvailable(layer) ? "" : "unavailable"]
              .filter(Boolean)
              .join(" | "),
          );
        }
        return listLayers()
          .filter((layer) => ids.includes(layer.id))
          .map((layer) => ({
            id: layer.id,
            title: layer.title,
            coverage: describeCoverage(layer.coverage),
            available: isAvailable(layer),
            gist: gistFor(layer.id),
            description: layer.description,
            license: layer.license,
          }));
      },
    }),
    geocode: tool({
      description:
        "Find a place by name. Returns its bbox [west, south, east, north], center [lon, lat], and full name. " +
        "Named mountain ranges, deserts, plateaus and similar regions (for example the Andes) come back as the whole region, with source \"natural-earth\"; " +
        "a smaller range (the Wind River Range) comes back as a box about 76 km across around its high point. " +
        "The map camera moves to the place by itself: it fits the features your queries return there (or this bbox when none come back). " +
        "Geocode each place once: asking for the same text again returns the first answer with repeated: true.",
      inputSchema: z.object({ place: z.string().min(1) }),
      execute: async ({ place }) => {
        geocoded = true;
        turn.geocodes += 1;
        // Retrying the same text gets the same answer: hand back the first one, marked, so the model stops looping.
        const key = placeKey(place);
        const repeated = answered.has(key);
        answered.add(key);
        // The lookup is shared with the step guard, which may have looked this text up already.
        const found = await turn.lookup(place);
        turn.outputs.push(found);
        if (!("error" in found)) {
          turn.place ??= found;
          if (!turn.places.includes(found)) turn.places.push(found);
        }
        return repeated ? { ...found, repeated: true } : found;
      },
    }),
    set_view: tool({
      description:
        "Move the map camera. Give a bbox to fit, or a center [lon, lat] with zoom. The map is 3D by default: at zoom 10 " +
        "and above it tilts to pitch 45 over terrain on its own, so only pass pitch (0 flat, 45 explore, 72 close-up), " +
        "bearing or terrain when the user asks for a particular angle or a flat map.",
      inputSchema: z.object({
        bbox: BBoxSchema.optional(),
        center: LngLatSchema.optional(),
        zoom: z.number().min(0).max(22).optional(),
        pitch: z.number().min(0).max(85).optional(),
        bearing: z.number().optional(),
        terrain: z.boolean().optional().describe("Show 3D terrain relief; on by default"),
      }),
      execute: async (input) => input,
    }),
    set_basemap: tool({
      description:
        "Switch the basemap style: outdoors-satellite (default: trails, contours and labels over satellite imagery), outdoors, satellite, natural-earth-2, " +
        "or data-only (WallyMap's plain land and water with no roads, labels or relief, so a dense network such as river-pulse, ocean-currents or wind-flow draws the land by itself).",
      inputSchema: z.object({ style: z.enum(BASEMAPS) }),
      execute: async (input) => input,
    }),
    render: tool({
      description:
        "Draw a layer you already queried. mode picks the drawing style: for point layers symbols (one shape per " +
        "feature), clusters (blobs with counts), heat (a density heatmap) or columns (hexagon columns as tall as the " +
        "count, or the value v, in 3D; flat hexagons in 2D); lines for line layers; polygons for areas, or columns to " +
        "extrude areas by their value v in 3D (fire perimeters by acres, glaciers). Omit mode to keep the layer's " +
        "current style (new layers start as symbols, or clusters when dense). filters narrows it by its own properties " +
        "(the query summary's sample properties name them), e.g. { sac_scale: { include: [\"alpine_hiking\"] } } or " +
        "{ acres: { range: [1000, 1000000] } }, written from the query summary's attributes so the layer row's chips show " +
        "the same choice; they replace the layer's filters, and {} clears them. rankBy ranks by a measure (the row lists the " +
        "top 10, symbols sized by it). hexBasis colors hex cells: count, sum of the measure, share of hexShare, or recency. sizeBy and colorBy put two " +
        "measures on one mark (width or symbol size, and color), from the summary's attributes; the layer has its own pair. view names the " +
        "standard view the answer is drawn in: change (two versions or two dates of one layer: then vs now, what changed), " +
        "timeline (dated features: over time, year by year, since), ranked (largest, most, deepest, highest, how full), " +
        "density (where are the most, hotspots, many points), detail (one thing: tell me about, how deep is), scenario (a " +
        "scenario amount such as sea level rise) or route; omit it and the map picks one from the data.",
      inputSchema: z.object({
        layerId: z.string(),
        mode: z.enum(TOOL_RENDER_MODES).optional(),
        color: z.string().optional().describe("Only set when the user asked for a specific color; otherwise omit"),
        filters: LayerFiltersSchema.optional().describe("Show only features matching every entry; omit to keep the current filters"),
        scenario: z.number().optional().describe("Scenario layers: amount to show, e.g. sea level rise feet"),
        view: z.enum(VIEW_KINDS).optional().describe("The standard view: change, timeline, ranked, density, detail, scenario or route"),
        rankBy: z.string().optional().describe("Rank by this measure's key (from the summary's attributes of type measure)"),
        hexBasis: z.enum(HEX_BASES).optional().describe("Hex cells' color: count (default), sum of the measure, share (with hexShare), recency"),
        hexShare: z.string().optional().describe("With hexBasis share: the chip value whose share colors the cells, e.g. wind"),
        sizeBy: z
          .string()
          .optional()
          .describe("Two measures on one mark: the measure key that sizes it (line width, symbol size, column height); \"\" for none. Omit for the layer's own pair"),
        colorBy: z
          .string()
          .optional()
          .describe("Two measures on one mark: the measure (or class) key that colors it on the sage to purple ramp; \"\" for none. Omit for the layer's own pair"),
      }),
      // Labels become values and "most … by <measure>" becomes hex cells by its sum, before the map or the trace sees it.
      execute: async (input) => {
        // "query_peaks" (the tool's name) is the peaks layer; template junk is cut off.
        const layerId = canonicalLayerId(input.layerId, listLayers().map((l) => l.id));
        const out = holdToPlace(withReading(normalizeRenderInput({ ...input, layerId }, getLayer(layerId), turn.question), turn), turn);
        turn.drawn.add(layerId);
        if (typeof out.view === "string") turn.views.set(layerId, out.view);
        return out;
      },
    }),
    set_time: tool({
      description:
        "Set the map's time window: only features dated inside it show (layers without dates are untouched), and the " +
        "time scrubber in the data console follows it. start and end are a year (\"2016\"), a month (\"2016-07\") " +
        "or a date (\"2016-07-04\"); a year or month as end means its last day. play: true animates the window one " +
        "step at a time (for \"year by year\" give one year as the window). mode: slide moves the whole window, " +
        "cumulative keeps the first date and grows the end.",
      inputSchema: z.object({
        start: z.string().min(1).describe("Window start: a year, month or ISO date"),
        end: z.string().min(1).describe("Window end: a year, month or ISO date"),
        play: z.boolean().optional().describe("Animate the window forward one step at a time"),
        mode: z.enum(TIME_MODES).optional().describe("slide (default) or cumulative"),
      }),
      execute: async (input) => input,
    }),
    compare: tool({
      description:
        "Compare one layer across two time windows. a and b are each [start, end] as YYYY-MM-DD or full ISO dates. " +
        "mode: delta shows what changed (only in A, only in B, in both), swipe puts the two windows side by side " +
        "behind a draggable divider, toggle flips between them. aLabel and bLabel name the windows. Query the layer " +
        "for both windows first. Presets: forest-loss 2015 vs 2025 (delta: a [\"2015-01-01\", \"2015-12-31\"], b " +
        "[\"2025-01-01\", \"2025-12-31\"]); night-lights 2020-01-01 vs three days ago (toggle: a and b each a single day); " +
        "fire-perimeters 2016-2020 vs 2021-today (delta: a [\"2016-01-01\", \"2020-12-31\"], b [\"2021-01-01\", today]).",
      inputSchema: z.object({
        layerId: z.string().min(1),
        a: CompareWindowSchema.optional().describe("First window [start, end]; omit for a scenario compare"),
        b: CompareWindowSchema.optional().describe("Second window [start, end]; omit for a scenario compare"),
        scenario: z
          .tuple([z.number(), z.number()])
          .optional()
          .describe("Scenario layers: the two amounts to compare, e.g. sea level rise feet [1, 6]"),
        mode: z.enum(COMPARE_MODES).default("delta"),
        aLabel: z.string().optional().describe("Short name for window A, e.g. \"2015\""),
        bLabel: z.string().optional().describe("Short name for window B, e.g. \"2025\""),
      }),
      // A compare needs either the two time windows or the two scenario amounts.
      execute: async (input) => {
        if (input.scenario === undefined && (input.a === undefined || input.b === undefined)) {
          return { error: "compare needs both windows a and b, or scenario with two amounts" };
        }
        const layerId = canonicalLayerId(input.layerId, listLayers().map((l) => l.id));
        turn.drawn.add(layerId);
        turn.compared.add(layerId);
        return { ...input, layerId };
      },
    }),
    route: tool({
      description:
        "Get a walking, cycling or driving route between two places from Mapbox Directions and draw it on the map " +
        "(purple-to-coral line with direction arrows, mile markers and a start pin); the map fits to it. from and to " +
        "are each a place name or [lon, lat]. Pass place names as the user said them, with no need to geocode first, " +
        "and qualify ambiguous ones (\"Emerald Bay, Lake Tahoe\"); they also name the route. Returns the distance in " +
        "km and the duration in minutes. Use it for \"route from A to B\", \"how far is it to hike from A to B\", or " +
        "driving directions; it follows roads and mapped paths, not off-trail lines.",
      inputSchema: z.object({
        from: z.union([z.string().min(1), LngLatSchema]).describe("Start: a place name or [lon, lat]"),
        to: z.union([z.string().min(1), LngLatSchema]).describe("End: a place name or [lon, lat]"),
        profile: z.enum(ROUTE_PROFILES).default("walking"),
        via: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe(
            "Trail names or places the route should pass, in order, for \"via the Mist Trail\" (also accepted inside to as \"Nevada Fall via the Mist Trail\"). " +
              "A trail that cannot be located is left out and the result's notes say so; tell the user.",
          ),
        name: z.string().optional().describe("A short name for the route; defaults to \"<from> to <to>\""),
      }),
      execute: async (input) => {
        const out = await runRouteTool(input, { view });
        turn.outputs.push(routeOutputForModel(out));
        return out;
      },
      // The UI part keeps the line for the map; the model gets distance, duration and waypoints.
      toModelOutput: ({ output }) => ({ type: "json", value: routeOutputForModel(output) as JSONValue }),
    }),
    note: tool({
      description: "Show a short markdown note beside the map: the answer, at most 120 words.",
      inputSchema: z.object({ markdown: z.string() }),
      // A note too long, or one that leaves out the top item a "which is highest" question asks for, comes back once to be rewritten.
      // On the last step there is no step left to rewrite, so the note is shown (cut to the limit when too long).
      execute: async (input) => checkNote(input.markdown, turn, { lastStep: turn.step >= MAX_STEPS - 1 }) ?? input,
    }),
  };

  for (const layer of listLayers()) {
    tools[`query_${layer.id}`] = queryTool(layer, fromView, turn);
  }

  // combine: two answered layers joined into a new map layer (within, outside, near, along, overlap, drive_time).
  // Its contract lives in lib/spatial/tool.ts; keep this block separate from the tools above.
  tools.combine = combineTool({ turn, view });
  return tools;
}

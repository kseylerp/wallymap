import { tool, type JSONValue, type ToolSet } from "ai";
import { z } from "zod";
import { getLayer, listLayers } from "@/layers/registry";
import { BBoxSchema, bboxAreaKm2, type BBox, type Coverage, type Layer, type LayerError } from "@/layers/types";
import { runLayer } from "@/lib/layers/run";
import { isFullLayerResult, summarizeLayerResult, type SummaryStyle } from "@/lib/layers/summarize";
import type { Basemap, RenderMode, TimeMode } from "@/lib/render/state";
import { geocode } from "./geocode";
import { ROUTE_PROFILES, routeOutputForModel, runRouteTool } from "./route";
import { gistFor } from "./vocabulary";
import type { MapView } from "./view";

const BASEMAPS = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2"] as const satisfies readonly Basemap[];
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
    include: z.array(z.string()).optional().describe("Keep features whose value is one of these"),
    range: z.tuple([z.number(), z.number()]).optional().describe("Keep features whose number is in [min, max]"),
  }),
);

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
  return layer.requiredEnv.every((name) => Boolean(process.env[name]));
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
export const TOOL_DESCRIPTION_MAX_CHARS = 700;

/**
 * Sections that only route words to layers, which the vocabulary table in the system prompt already does:
 * "User words: ..." and "Example questions: ...", each up to the sentence that follows it.
 */
const ROUTING_SECTION = /\s*(?:User words|Example questions?):[\s\S]*?\.(?=\s+[A-Z(]|\s*$)/g;

/** Sentences kept even past the cap: the area limit (the model must zoom in first) and "map tiles, not features" honesty. */
const ESSENTIAL_SENTENCE = /km²|map tiles/i;

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
 * sentence (what the layer is) and the area-limit and map-tiles sentences always; sentences that name one of
 * `inputs` (how to call it) up to TOOL_DESCRIPTION_INPUT_CEILING; then the rest (properties, units, caveats)
 * while the whole stays within `max`. list_layers with ids returns the full text.
 */
export function compactDescription(
  description: string,
  { inputs = [], max = TOOL_DESCRIPTION_MAX_CHARS }: { inputs?: string[]; max?: number } = {},
): string {
  const stripped = description.replace(ROUTING_SECTION, "").trim();
  if (stripped.length <= max) return stripped;
  const all = sentences(stripped);
  const inputPattern = inputs.length > 0 ? new RegExp(`\\b(?:${inputs.map(escapeRegExp).join("|")})\\b`) : null;
  const keep = all.map((sentence, i) => i === 0 || ESSENTIAL_SENTENCE.test(sentence));
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
export function layerResultForModel(output: unknown, layerId?: string, style?: SummaryStyle): JSONValue {
  if (isFullLayerResult(output)) return summarizeLayerResult(output, layerId, style);
  return output as JSONValue;
}

/** One "at a wider scale, use" suggestion: a layer, and the input that makes it work over a wide view. */
export type WiderScaleHint = { layerId: string; input?: Record<string, string | number | boolean | string[]> };

/**
 * outdoor-features takes a region up to 150,000 km² only for huts, viewpoints and waterfalls (all kinds stop at
 * 10,000 km²), so every suggestion of it asks for those kinds.
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
  // Its own zoom_in error already says that huts, viewpoints and waterfalls alone reach 150,000 km².
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

/** The wider-scale layers for `layerId` that exist, are available, cover `bbox` and accept its area. */
export function widerScaleFor(layerId: string, bbox: BBox): string[] {
  const area = bboxAreaKm2(bbox);
  return (WIDER_SCALE[layerId] ?? [])
    .filter((hint) => {
      const layer = getLayer(hint.layerId);
      return layer !== undefined && isAvailable(layer) && area <= layer.maxAreaKm2 && coversBBox(layer.coverage, bbox);
    })
    .map((hint) => hintText(hint));
}

/** The query tool's sentence naming its wider-scale layers, or "" when it has none. */
function widerScaleSentence(layerId: string): string {
  const hints = WIDER_SCALE[layerId];
  if (!hints || hints.length === 0) return "";
  return ` At a wider scale, use ${hints.map((h) => hintText(h, "short").replace(/^query_/, "")).join(", ")}.`;
}

/** A zoom_in error for the user's view, with the layers that can answer at that scale. */
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

function queryTool(layer: Layer, fromView: ViewSource = () => undefined) {
  // The registry erases each layer's input shape, so zod cannot infer bbox and
  // zoom through extend(); the cast restores the two fields this tool adds.
  const inputSchema = layer.input.extend({
    bbox: BBoxSchema,
    zoom: z.number().default(10),
  }) as unknown as z.ZodType<QueryArgs>;
  return tool({
    // The licence and the trimmed sentences are in list_layers' detail (ids); the citation comes with each result.
    description: `${compactDescription(layer.description, { inputs: inputNames(layer) })} Covers ${describeCoverage(layer.coverage)}.${widerScaleSentence(layer.id)} bbox is [west, south, east, north].`,
    inputSchema,
    execute: async ({ bbox, zoom, ...input }) => {
      const view = fromView(bbox);
      const body = (await runLayer(layer.id, { bbox, zoom, input, fromView: view })).body;
      // The user is looking at a view too wide for this layer: name the layers that can still answer at this scale.
      if (view && "error" in body && body.hint === "zoom_in") {
        const widerScale = widerScaleFor(layer.id, view.bbox);
        return { ...body, widerScale } satisfies ZoomInError;
      }
      return body;
    },
    // The UI part keeps the full body for the map; the model gets a summary with v's statistics in the layer's unit.
    toModelOutput: ({ output }) => ({ type: "json", value: layerResultForModel(output, layer.id, layer.style) }),
  });
}

/** Builds the agent's tool set from the current layer registry. `view` is the map the user is looking at; the route tool biases its place lookups to it. */
export function buildTools({ view = null }: { view?: MapView | null } = {}): ToolSet {
  // Tools are built per request, so this is per turn: once a place is geocoded, queries are about that place.
  let geocoded = false;
  const fromView: ViewSource = (bbox) =>
    view?.bbox && !geocoded && isWithinView(bbox, view.bbox) ? { bbox: view.bbox, zoom: view.zoom } : undefined;
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
        "Named mountain ranges, deserts, plateaus and similar regions (for example the Andes) come back as the whole region, with source \"natural-earth\".",
      inputSchema: z.object({ place: z.string().min(1) }),
      execute: async ({ place }) => {
        geocoded = true;
        return geocode(place);
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
        "Switch the basemap style: outdoors-satellite (default: trails, contours and labels over satellite imagery), outdoors, satellite, or natural-earth-2.",
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
        "{ acres: { range: [1000, 1000000] } }; they replace the layer's filters, and {} clears them.",
      inputSchema: z.object({
        layerId: z.string(),
        mode: z.enum(TOOL_RENDER_MODES).optional(),
        color: z.string().optional().describe("Only set when the user asked for a specific color; otherwise omit"),
        filters: LayerFiltersSchema.optional().describe("Show only features matching every entry; omit to keep the current filters"),
      }),
      execute: async (input) => input,
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
        a: CompareWindowSchema.describe("First window [start, end]"),
        b: CompareWindowSchema.describe("Second window [start, end]"),
        mode: z.enum(COMPARE_MODES).default("delta"),
        aLabel: z.string().optional().describe("Short name for window A, e.g. \"2015\""),
        bLabel: z.string().optional().describe("Short name for window B, e.g. \"2025\""),
      }),
      execute: async (input) => input,
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
      execute: async (input) => runRouteTool(input, { view }),
      // The UI part keeps the line for the map; the model gets distance, duration and waypoints.
      toModelOutput: ({ output }) => ({ type: "json", value: routeOutputForModel(output) as JSONValue }),
    }),
    note: tool({
      description: "Show a short markdown note beside the map.",
      inputSchema: z.object({ markdown: z.string() }),
      execute: async (input) => input,
    }),
  };

  for (const layer of listLayers()) {
    tools[`query_${layer.id}`] = queryTool(layer, fromView);
  }
  return tools;
}

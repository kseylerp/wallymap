import { tool, type JSONValue, type ToolSet } from "ai";
import { z } from "zod";
import { listLayers } from "@/layers/registry";
import { BBoxSchema, type BBox, type Coverage, type Layer } from "@/layers/types";
import { runLayer } from "@/lib/layers/run";
import { isFullLayerResult, summarizeLayerResult } from "@/lib/layers/summarize";
import type { Basemap, RenderMode, TimeMode } from "@/lib/render/state";
import { geocode } from "./geocode";
import { ROUTE_PROFILES, routeOutputForModel, runRouteTool } from "./route";
import { synonymsFor } from "./vocabulary";
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
 * One list_layers row. Kept short on purpose: the model already has every layer's description in
 * its query_<id> tool definition, so repeating it here only cost tokens on every later turn.
 */
export type LayerSummary = {
  id: string;
  title: string;
  /** Plain words, e.g. "worldwide" or "the United States". */
  coverage: string;
  available: boolean;
  /** Words people use that should route to this layer, comma-separated on one line. */
  synonyms: string;
};

function isAvailable(layer: Layer): boolean {
  return layer.requiredEnv.every((name) => Boolean(process.env[name]));
}

function describeCoverage(coverage: Coverage): string {
  if (coverage === "global") return "worldwide";
  if (coverage === "us") return "the United States";
  return `the bbox [${coverage.bbox.join(", ")}]`;
}

/**
 * What the model sees for a query result. A full result (often megabytes of
 * GeoJSON) becomes a short summary; errors and results the browser already
 * summarized before resending the history pass through unchanged.
 */
export function layerResultForModel(output: unknown): JSONValue {
  if (isFullLayerResult(output)) return summarizeLayerResult(output);
  return output as JSONValue;
}

/** Query-tool input: the layer's own input fields plus the area to search. */
type QueryArgs = { bbox: BBox; zoom: number } & Record<string, unknown>;

function queryTool(layer: Layer) {
  // The registry erases each layer's input shape, so zod cannot infer bbox and
  // zoom through extend(); the cast restores the two fields this tool adds.
  const inputSchema = layer.input.extend({
    bbox: BBoxSchema,
    zoom: z.number().default(10),
  }) as unknown as z.ZodType<QueryArgs>;
  return tool({
    description: `${layer.description} Covers ${describeCoverage(layer.coverage)}; data license ${layer.license}. bbox is [west, south, east, north].`,
    inputSchema,
    execute: async ({ bbox, zoom, ...input }) => (await runLayer(layer.id, { bbox, zoom, input })).body,
    // The UI part keeps the full body for the map; the model gets a summary.
    toModelOutput: ({ output }) => ({ type: "json", value: layerResultForModel(output) }),
  });
}

/** Builds the agent's tool set from the current layer registry. `view` is the map the user is looking at; the route tool biases its place lookups to it. */
export function buildTools({ view = null }: { view?: MapView | null } = {}): ToolSet {
  const tools: ToolSet = {
    list_layers: tool({
      description:
        "List every dataset layer: its id, title, where it has coverage, whether it is available on this server, and the words that route to it. Each query_<id> tool describes its layer in full.",
      inputSchema: z.object({}),
      execute: async (): Promise<LayerSummary[]> =>
        listLayers().map((layer) => ({
          id: layer.id,
          title: layer.title,
          coverage: describeCoverage(layer.coverage),
          available: isAvailable(layer),
          synonyms: synonymsFor(layer.id).join(", "),
        })),
    }),
    geocode: tool({
      description:
        "Find a place by name. Returns its bbox [west, south, east, north], center [lon, lat], and full name. " +
        "Named mountain ranges, deserts, plateaus and similar regions (for example the Andes) come back as the whole region, with source \"natural-earth\".",
      inputSchema: z.object({ place: z.string().min(1) }),
      execute: async ({ place }) => geocode(place),
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
    tools[`query_${layer.id}`] = queryTool(layer);
  }
  return tools;
}

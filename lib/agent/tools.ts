import { tool, type JSONValue, type ToolSet } from "ai";
import { z } from "zod";
import { listLayers } from "@/layers/registry";
import { BBoxSchema, type BBox, type Coverage, type Layer } from "@/layers/types";
import { runLayer } from "@/lib/layers/run";
import { isFullLayerResult, summarizeLayerResult } from "@/lib/layers/summarize";
import type { Basemap, RenderMode } from "@/lib/render/state";
import { geocode } from "./geocode";

const BASEMAPS = ["outdoors-satellite", "outdoors", "satellite", "natural-earth-2"] as const satisfies readonly Basemap[];
const RENDER_MODES = [
  "points",
  "lines",
  "polygons",
  "heat",
  "columns",
  "hexbin",
] as const satisfies readonly RenderMode[];

const LngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export type LayerSummary = {
  id: string;
  title: string;
  description: string;
  coverage: Coverage;
  license: string;
  available: boolean;
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

/** Builds the agent's tool set from the current layer registry. */
export function buildTools(): ToolSet {
  const tools: ToolSet = {
    list_layers: tool({
      description:
        "List every dataset layer: what it shows, where it has coverage, its license, and whether it is available on this server.",
      inputSchema: z.object({}),
      execute: async (): Promise<LayerSummary[]> =>
        listLayers().map((layer) => ({
          id: layer.id,
          title: layer.title,
          description: layer.description,
          coverage: layer.coverage,
          license: layer.license,
          available: isAvailable(layer),
        })),
    }),
    geocode: tool({
      description:
        "Find a place by name. Returns its bbox [west, south, east, north], center [lon, lat], and full name.",
      inputSchema: z.object({ place: z.string().min(1) }),
      execute: async ({ place }) => geocode(place),
    }),
    set_view: tool({
      description:
        "Move the map camera. Give a bbox to fit, or a center [lon, lat] with zoom; pitch and bearing are optional.",
      inputSchema: z.object({
        bbox: BBoxSchema.optional(),
        center: LngLatSchema.optional(),
        zoom: z.number().min(0).max(22).optional(),
        pitch: z.number().min(0).max(85).optional(),
        bearing: z.number().optional(),
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
        "Draw a layer you already queried. mode picks the drawing style; color is an optional CSS color.",
      inputSchema: z.object({
        layerId: z.string(),
        mode: z.enum(RENDER_MODES),
        color: z.string().optional(),
      }),
      execute: async (input) => input,
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

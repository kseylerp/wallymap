import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Tool } from "ai";
import "@/layers";
import { clearRegistry, defineLayer, listLayers, registerLayer } from "@/layers";
import { buildTools } from "@/lib/agent/tools";

const callOptions = { toolCallId: "test-call", messages: [], context: {} };

function schemaOf(t: Tool): z.ZodType {
  return t.inputSchema as z.ZodType;
}

async function run(t: Tool, input: unknown): Promise<unknown> {
  if (!t.execute) throw new Error("tool has no execute");
  return await t.execute(input as never, callOptions);
}

describe("buildTools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes the fixed tools plus one query tool per registered layer", () => {
    const tools = buildTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        "list_layers",
        "geocode",
        "set_view",
        "set_basemap",
        "render",
        "note",
        "route",
        "set_time",
        "compare",
        ...listLayers().map((layer) => `query_${layer.id}`),
      ].sort(),
    );
  });

  it("query_osm-trails accepts layer input plus bbox and rejects a bad bbox", () => {
    const schema = schemaOf(buildTools()["query_osm-trails"]);
    const ok = schema.safeParse({ bbox: [-120.2, 38.85, -120, 39], namedOnly: true });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ zoom: 10, namedOnly: true });
    expect(schema.safeParse({ bbox: [0, 0, 1, 91] }).success).toBe(false);
  });

  it("query_osm-trails resolves to a zoom_in error for an oversized bbox", async () => {
    const t = buildTools()["query_osm-trails"];
    const result = await run(t, { bbox: [-125, 30, -110, 45], zoom: 5, namedOnly: false });
    expect(result).toMatchObject({ hint: "zoom_in" });
  });

  it("query_osm-trails gives the model a summary without the features array", async () => {
    const t = buildTools()["query_osm-trails"];
    if (!t.toModelOutput) throw new Error("query tool has no toModelOutput");
    const output = {
      kind: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { name: "Rim" }, geometry: { type: "LineString", coordinates: [[-120.1, 38.9], [-120, 39]] } },
        ],
      },
      citation: { source: "OSM", url: "https://www.openstreetmap.org/copyright", retrieved: "2026-10-09T00:00:00Z" },
    };
    const modelOutput = await t.toModelOutput({ toolCallId: "c1", input: {}, output });
    if (modelOutput.type !== "json") throw new Error("expected json model output");
    const value = modelOutput.value as Record<string, unknown>;
    expect(value).toMatchObject({ kind: "geojson", featureCount: 1, bbox: [-120.1, 38.9, -120, 39] });
    expect(JSON.stringify(value)).not.toContain('"features"');
    expect(value).not.toHaveProperty("data");

    const error = { error: "Overpass returned 429", hint: "upstream" };
    expect(await t.toModelOutput({ toolCallId: "c2", input: {}, output: error })).toEqual({ type: "json", value: error });
  });

  it("echoes its input from the view, basemap, render and note tools", async () => {
    const tools = buildTools();
    const view = { bbox: [-120.2, 38.85, -120, 39], pitch: 45 };
    expect(await run(tools.set_view, view)).toEqual(view);
    expect(await run(tools.set_basemap, { style: "satellite" })).toEqual({ style: "satellite" });
    const op = { layerId: "osm-trails", mode: "lines", color: "#ff0000" };
    expect(await run(tools.render, op)).toEqual(op);
    expect(await run(tools.note, { markdown: "**hi**" })).toEqual({ markdown: "**hi**" });
  });

  it("set_view accepts pitch, bearing and terrain", () => {
    const schema = schemaOf(buildTools().set_view);
    expect(schema.safeParse({ center: [6.87, 45.92], zoom: 12, pitch: 72, bearing: 40, terrain: true }).success).toBe(true);
    expect(schema.safeParse({ terrain: "yes" }).success).toBe(false);
    expect(schema.safeParse({ pitch: 90 }).success).toBe(false);
  });

  it("restricts render.mode and set_basemap.style to known values", () => {
    const tools = buildTools();
    expect(schemaOf(tools.render).safeParse({ layerId: "x", mode: "blobs" }).success).toBe(false);
    expect(schemaOf(tools.set_basemap).safeParse({ style: "dark" }).success).toBe(false);
    expect(schemaOf(tools.set_basemap).safeParse({ style: "outdoors-satellite" }).success).toBe(true);
  });

  it("render accepts optional filters by property (include values, numeric range)", () => {
    const schema = schemaOf(buildTools().render);
    expect(schema.safeParse({ layerId: "osm-trails", mode: "lines", filters: { sac_scale: { include: ["alpine_hiking"] } } }).success).toBe(true);
    expect(schema.safeParse({ layerId: "fire-perimeters", mode: "polygons", filters: { acres: { range: [1000, 50000] } } }).success).toBe(true);
    expect(schema.safeParse({ layerId: "x", mode: "lines", filters: { acres: { range: [1] } } }).success).toBe(false);
    expect(schema.safeParse({ layerId: "x", mode: "lines", filters: { sac_scale: { include: "alpine" } } }).success).toBe(false);
  });

  it("set_time takes a start, an end, play and a mode, and echoes them", async () => {
    const tools = buildTools();
    const schema = schemaOf(tools.set_time);
    expect(schema.safeParse({ start: "2016", end: "2016", play: true, mode: "slide" }).success).toBe(true);
    expect(schema.safeParse({ start: "2016", end: "2025" }).success).toBe(true);
    expect(schema.safeParse({ start: "2016" }).success).toBe(false);
    expect(schema.safeParse({ start: "2016", end: "2025", mode: "rolling" }).success).toBe(false);
    expect(schema.safeParse({ start: "2016", end: "2025", play: "yes" }).success).toBe(false);
    const input = { start: "2016", end: "2016", play: true };
    expect(await run(tools.set_time, input)).toEqual(input);
  });

  it("compare takes a layer and two ISO windows, defaults to delta, and echoes the input", async () => {
    const tools = buildTools();
    const schema = schemaOf(tools.compare);
    const input = { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01T00:00:00Z", "2025-12-31T23:59:59Z"] };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ mode: "delta" });
    expect(schema.safeParse({ ...input, mode: "swipe", aLabel: "2015", bLabel: "2025" }).success).toBe(true);
    expect(schema.safeParse({ ...input, mode: "fade" }).success).toBe(false);
    expect(schema.safeParse({ ...input, a: ["2015", "2015"] }).success).toBe(false);
    expect(schema.safeParse({ ...input, a: ["2015-01-01"] }).success).toBe(false);
    expect(schema.safeParse({ ...input, b: ["2025-13-45", "2025-12-31"] }).success).toBe(false);
    expect(await run(tools.compare, parsed.data)).toEqual(parsed.data);
    const description = tools.compare.description ?? "";
    expect(description).toContain("forest-loss 2015 vs 2025");
    expect(description).toContain("night-lights 2020-01-01 vs three days ago");
    expect(description).toContain("fire-perimeters 2016-2020 vs 2021-today");
  });

  it("list_layers includes vocabulary synonyms for each layer", async () => {
    const result = (await run(buildTools().list_layers, {})) as { id: string; synonyms: string }[];
    expect(result.find((l) => l.id === "fire-perimeters")?.synonyms).toBe("wildfire, fire, burn, burned area");
    for (const layer of result) expect(layer.synonyms.length).toBeGreaterThan(0);
  });

  it("list_layers stays short: no descriptions or licenses", async () => {
    const result = (await run(buildTools().list_layers, {})) as Record<string, unknown>[];
    for (const layer of result) expect(Object.keys(layer).sort()).toEqual(["available", "coverage", "id", "synonyms", "title"]);
    expect(JSON.stringify(result).length).toBeLessThan(8000);
  });

  it("list_layers marks a layer whose env is missing as unavailable", async () => {
    clearRegistry();
    try {
      vi.stubEnv("NOPE_KEY", "");
      registerLayer(
        defineLayer({
          id: "needs-key",
          title: "Needs key",
          description: "A layer that needs a key",
          coverage: "us",
          license: "CC0",
          requiredEnv: ["NOPE_KEY"],
          maxAreaKm2: 1000,
          input: z.object({}),
          query: async () => ({ error: "unused" }),
          style: { geometry: "point", color: "#000" },
        }),
      );
      registerLayer(
        defineLayer({
          id: "free",
          title: "Free",
          description: "A layer with no keys",
          coverage: "global",
          license: "ODbL",
          requiredEnv: [],
          maxAreaKm2: 1000,
          input: z.object({}),
          query: async () => ({ error: "unused" }),
          style: { geometry: "point", color: "#000" },
        }),
      );

      const result = await run(buildTools().list_layers, {});
      expect(result).toEqual([
        {
          id: "needs-key",
          title: "Needs key",
          coverage: "the United States",
          available: false,
          synonyms: "",
        },
        {
          id: "free",
          title: "Free",
          coverage: "worldwide",
          available: true,
          synonyms: "",
        },
      ]);
    } finally {
      clearRegistry();
      const { default: osmTrails } = await import("@/layers/osm-trails");
      registerLayer(osmTrails);
    }
  });
});

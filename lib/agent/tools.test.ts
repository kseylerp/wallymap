import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Tool } from "ai";
import "@/layers";
import { clearRegistry, defineLayer, listLayers, registerLayer } from "@/layers";
import { TOOL_DESCRIPTION_INPUT_CEILING, TOOL_DESCRIPTION_MAX_CHARS, buildTools, compactDescription } from "@/lib/agent/tools";

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

  it("query_glaciers gives the model stats over every outline in km², not just the first few", async () => {
    const t = buildTools()["query_glaciers"];
    if (!t.toModelOutput) throw new Error("query tool has no toModelOutput");
    const square = { type: "Polygon", coordinates: [[[-109.6, 43.1], [-109.5, 43.1], [-109.5, 43.2], [-109.6, 43.1]]] };
    const outline = (name: string, glacierId: string, v: number) => ({
      type: "Feature",
      geometry: square,
      properties: { name, glacierId, v, areaKm2: v, t: "2015-08-01T00:00:00.000Z" },
    });
    const output = {
      kind: "geojson",
      data: {
        type: "FeatureCollection",
        features: [outline("Unnamed glacier", "A", 0.2), outline("Unnamed glacier", "B", 0.29), outline("Gannett Glacier", "GAN", 3.06)],
      },
      citation: { source: "GLIMS", url: "https://www.glims.org/", retrieved: "2026-10-11T00:00:00Z" },
    };
    const modelOutput = await t.toModelOutput({ toolCallId: "c1", input: {}, output });
    if (modelOutput.type !== "json") throw new Error("expected json model output");
    expect(modelOutput.value).toMatchObject({
      stats: { unit: "km²", count: 3, max: 3.06, sum: 3.55, top: [{ name: "Gannett Glacier", v: 3.06 }, { v: 0.29 }, { v: 0.2 }] },
      totalArea: { value: 3.55, unit: "km²" },
      dates: { from: "2015-08-01", to: "2015-08-01", years: ["2015"] },
    });
  });

  it("geocode returns the first answer with repeated: true when the same text is asked again in a turn", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "test-mapbox-token");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          features: [{ properties: { name: "Lake Tahoe", bbox: [-120.5, 38.6, -119.7, 39.4], coordinates: { longitude: -120.1, latitude: 39.1 } } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tools = buildTools({ view: { bbox: [-121, 38, -119, 40], zoom: 8, center: [-120, 39] } });
      const first = await run(tools.geocode, { place: "Lake Tahoe" });
      expect(first).not.toHaveProperty("repeated");
      expect(await run(tools.geocode, { place: "lake  tahoe." })).toEqual({ ...(first as object), repeated: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The lookup leans toward the place on screen.
      expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("proximity")).toBe("-120,39");
      // A new turn (new tools) asks Mapbox again.
      await run(buildTools().geocode, { place: "Lake Tahoe" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("list_layers rows are one line each: id, title, coverage and a gist, no synonyms", async () => {
    const result = (await run(buildTools().list_layers, {})) as string[];
    expect(result).toHaveLength(listLayers().length);
    expect(result.find((row) => row.startsWith("fire-perimeters |"))).toBe(
      "fire-perimeters | Wildfire perimeters | US | current and past wildfire outlines with acres and year",
    );
    expect(result.find((row) => row.startsWith("reservoir-levels |"))).toContain("| [-123.5, 32, -104, 43.5] |");
    for (const row of result) {
      expect(row.split(" | ").length).toBeGreaterThanOrEqual(4);
      expect(row).not.toContain("wildfire, fire");
    }
  });

  it("list_layers stays short: about 9,000 characters for every layer", async () => {
    const result = await run(buildTools().list_layers, {});
    // With synonyms repeated from the system prompt the rows were 13,475 characters for 81 layers.
    expect(JSON.stringify(result).length).toBeLessThan(9_000);
  });

  it("list_layers with ids returns those layers' full descriptions and licences", async () => {
    const result = (await run(buildTools().list_layers, { ids: ["snowpack", "surf", "nope"] })) as Record<string, string>[];
    expect(result.map((r) => r.id)).toEqual(["snowpack", "surf"]);
    const snowpack = listLayers().find((l) => l.id === "snowpack");
    expect(result[0].description).toBe(snowpack?.description);
    expect(result[0].license).toBe(snowpack?.license);
  });

  it("query tool descriptions are trimmed: no routing sections, near the cap, inputs and area limits kept", () => {
    const tools = buildTools();
    let total = 0;
    for (const layer of listLayers()) {
      const description = tools[`query_${layer.id}`].description ?? "";
      total += description.length;
      expect(description).not.toMatch(/User words:|Example questions?:/);
      // Coverage and the bbox order are appended after the trimmed description.
      expect(description.length).toBeLessThan(TOOL_DESCRIPTION_INPUT_CEILING + 200);
      if (/km²/.test(layer.description)) expect(description).toMatch(/km²/);
    }
    // The 54 layer descriptions were about 88,000 characters in full.
    expect(total).toBeLessThan(66_000);
    const surf = tools["query_surf"].description ?? "";
    expect(surf).toContain("Set forecast to true");
    expect(surf).toContain("Set season to true");
    expect(tools["query_species"].description).toContain("Set taxon");
    expect(tools["query_lakes"].description).toMatch(/\bname\b/);
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
      expect(result).toEqual(["needs-key | Needs key | US | unavailable", "free | Free | worldwide"]);
      const detail = (await run(buildTools().list_layers, { ids: ["needs-key"] })) as { available: boolean }[];
      expect(detail[0].available).toBe(false);
    } finally {
      clearRegistry();
      const { default: osmTrails } = await import("@/layers/osm-trails");
      registerLayer(osmTrails);
    }
  });
});

describe("compactDescription", () => {
  const long = (n: number) => `${"Filler words here. ".repeat(n)}`.trim();

  it("leaves a short description alone", () => {
    expect(compactDescription("A short layer. It has v.")).toBe("A short layer. It has v.");
  });

  it("drops User words and Example questions sections", () => {
    const text =
      "Live snow at stations. User words: snow, powder, how much snow. Each point has v in inches. " +
      "Example questions: 'How much snow is at Mount Rose?', 'Did it snow?'. Caveats: one clearing.";
    expect(compactDescription(text)).toBe("Live snow at stations. Each point has v in inches. Caveats: one clearing.");
  });

  it("keeps the first sentence, input sentences and the area limit, then fills to the cap in order", () => {
    const text = [
      "What the layer is.",
      long(30),
      "Set depth to true for depth.",
      "A caveat that fits.",
      "Needs a region under 400,000 km².",
    ].join(" ");
    const out = compactDescription(text, { inputs: ["depth"], max: 120 });
    expect(out.startsWith("What the layer is.")).toBe(true);
    expect(out).toContain("Set depth to true for depth.");
    expect(out).toContain("Needs a region under 400,000 km².");
    expect(out.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX_CHARS);
    // Kept sentences stay in their original order.
    expect(out.indexOf("Set depth")).toBeLessThan(out.indexOf("km²"));
  });

  it("drops a sentence that refers back to one that was cut", () => {
    const text = `First. ${"x".repeat(800)} is a long property list. It is given for the 30 largest gauges only. A short caveat.`;
    const out = compactDescription(text, { max: 200 });
    expect(out).not.toContain("It is given");
    expect(out).toContain("A short caveat.");
  });

  it("does not split after e.g.", () => {
    const text = `First. Event names, e.g. 'Red Flag Warning', filter it. ${"y".repeat(900)}.`;
    expect(compactDescription(text, { max: 100 })).toBe("First. Event names, e.g. 'Red Flag Warning', filter it.");
  });
});

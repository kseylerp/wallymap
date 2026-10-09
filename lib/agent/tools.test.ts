import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Tool } from "ai";
import "@/layers";
import { clearRegistry, defineLayer, registerLayer } from "@/layers";
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
      ["list_layers", "geocode", "set_view", "set_basemap", "render", "note", "query_osm-trails"].sort(),
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

  it("echoes its input from the view, basemap, render and note tools", async () => {
    const tools = buildTools();
    const view = { bbox: [-120.2, 38.85, -120, 39], pitch: 45 };
    expect(await run(tools.set_view, view)).toEqual(view);
    expect(await run(tools.set_basemap, { style: "satellite" })).toEqual({ style: "satellite" });
    const op = { layerId: "osm-trails", mode: "lines", color: "#ff0000" };
    expect(await run(tools.render, op)).toEqual(op);
    expect(await run(tools.note, { markdown: "**hi**" })).toEqual({ markdown: "**hi**" });
  });

  it("restricts render.mode and set_basemap.style to known values", () => {
    const tools = buildTools();
    expect(schemaOf(tools.render).safeParse({ layerId: "x", mode: "blobs" }).success).toBe(false);
    expect(schemaOf(tools.set_basemap).safeParse({ style: "dark" }).success).toBe(false);
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
          description: "A layer that needs a key",
          coverage: "us",
          license: "CC0",
          available: false,
        },
        {
          id: "free",
          title: "Free",
          description: "A layer with no keys",
          coverage: "global",
          license: "ODbL",
          available: true,
        },
      ]);
    } finally {
      clearRegistry();
      const { default: osmTrails } = await import("@/layers/osm-trails");
      registerLayer(osmTrails);
    }
  });
});

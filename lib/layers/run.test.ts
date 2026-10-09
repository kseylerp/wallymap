import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type QueryContext } from "@/layers/types";
import { registerLayer, clearRegistry } from "@/layers/registry";
import { runLayer } from "@/lib/layers/run";

const BBOX = [-120, 38, -119, 39];

const passthroughResult: LayerResult = {
  kind: "geojson",
  data: { type: "FeatureCollection", features: [] },
  citation: { source: "Fake", url: "https://example.test", retrieved: "2026-10-09T00:00:00Z" },
};

const query = vi.fn(
  async (_ctx: QueryContext, _input: unknown): Promise<LayerResult | LayerError> => passthroughResult,
);

const fake = defineLayer({
  id: "fake",
  title: "Fake",
  description: "d",
  coverage: "global",
  license: "CC0",
  requiredEnv: [],
  maxAreaKm2: 100,
  input: z.object({ n: z.number().optional() }),
  query,
  style: { geometry: "point", color: "#000" },
});

describe("runLayer", () => {
  beforeEach(() => {
    clearRegistry();
    query.mockClear();
    query.mockImplementation(async () => passthroughResult);
    registerLayer(fake);
  });

  it("returns 404 for an unknown layer id", async () => {
    const res = await runLayer("nope", { bbox: BBOX });
    expect(res).toEqual({ status: 404, body: { error: "Unknown layer nope" } });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid bbox", async () => {
    const res = await runLayer("fake", { bbox: [179, 38, -179, 39] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringMatching(/^Invalid bbox: /) });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 503 without querying when a required env var is missing", async () => {
    const keyed = defineLayer({ ...fake, id: "keyed", requiredEnv: ["X_KEY"] });
    clearRegistry();
    registerLayer(keyed);
    delete process.env.X_KEY;

    const res = await runLayer("keyed", { bbox: BBOX });
    expect(res).toEqual({
      status: 503,
      body: { error: "Layer keyed needs X_KEY", hint: "unavailable" },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 422 when the layer asks the user to zoom in", async () => {
    query.mockImplementation(async () => ({ error: "Area is 9000 km²; zoom in", hint: "zoom_in" }));
    const res = await runLayer("fake", { bbox: BBOX });
    expect(res).toEqual({
      status: 422,
      body: { error: "Area is 9000 km²; zoom in", hint: "zoom_in" },
    });
  });

  it("returns 200 with the layer result unchanged", async () => {
    const res = await runLayer("fake", { bbox: BBOX, zoom: 12, input: { n: 3 } });
    expect(res).toEqual({ status: 200, body: passthroughResult });
    expect(query).toHaveBeenCalledTimes(1);
    const [ctx, input] = query.mock.calls[0];
    expect(ctx.zoom).toBe(12);
    expect(ctx.bbox).toEqual(BBOX);
    expect(input).toEqual({ n: 3 });
  });
});

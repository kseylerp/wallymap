import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type QueryContext } from "@/layers/types";
import { registerLayer, clearRegistry } from "@/layers/registry";
import { runLayer, suggestedZoomFor } from "@/lib/layers/run";

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
  maxAreaKm2: 100000,
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

  it("returns 422 zoom_in without querying when the bbox exceeds maxAreaKm2", async () => {
    const tiny = defineLayer({ ...fake, id: "tiny", maxAreaKm2: 100 });
    clearRegistry();
    registerLayer(tiny);

    const res = await runLayer("tiny", { bbox: BBOX });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: expect.stringMatching(/^Area is \d+ km²; zoom in to under 100 km²$/),
      hint: "zoom_in",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 503 upstream when query rejects", async () => {
    query.mockImplementation(async () => {
      throw new Error("boom");
    });
    const res = await runLayer("fake", { bbox: BBOX });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Error: boom", hint: "upstream" });
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

  it("gives the same cacheKey to bboxes that differ only past the 3rd decimal", async () => {
    await runLayer("fake", { bbox: [-120.0001, 38.0002, -119.0004, 39.0001], input: { n: 1 } });
    await runLayer("fake", { bbox: [-120.0003, 38.0001, -119.0001, 39.0004], input: { n: 1 } });
    const [first, second] = query.mock.calls.map(([ctx]) => ctx.cacheKey);
    expect(first).toBe("fake:-120,38,-119,39:{\"n\":1}");
    expect(second).toBe(first);
  });

  it("passes only the layer's declared env vars to query", async () => {
    vi.stubEnv("SECRET_X", "do-not-leak");
    vi.stubEnv("OPT_Y", "opt-value");
    try {
      await runLayer("fake", { bbox: BBOX });
      expect(query.mock.calls[0][0].env).not.toHaveProperty("SECRET_X");
      expect(query.mock.calls[0][0].env).toEqual({});

      const withOptional = defineLayer({ ...fake, id: "opt", optionalEnv: ["OPT_Y", "OPT_MISSING"] });
      registerLayer(withOptional);
      await runLayer("opt", { bbox: BBOX });
      const env = query.mock.calls[1][0].env;
      expect(env).toEqual({ OPT_Y: "opt-value", OPT_MISSING: undefined });
      expect(env).not.toHaveProperty("SECRET_X");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("adds suggestedZoom to an area-cap error only when the query came from the user's view", async () => {
    const huge = [-125, 30, -110, 45];
    const plain = await runLayer("fake", { bbox: huge });
    expect(plain.status).toBe(422);
    expect(plain.body).not.toHaveProperty("suggestedZoom");

    const fromView = await runLayer("fake", { bbox: huge, fromView: { bbox: huge as [number, number, number, number], zoom: 5 } });
    expect(fromView.status).toBe(422);
    expect(fromView.body).toMatchObject({ hint: "zoom_in", suggestedZoom: expect.any(Number) });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("suggestedZoomFor", () => {
  it("adds half a zoom level per doubling of area over the cap, rounded up past it", () => {
    // The owner's Baltic view: 417,205 km² at zoom 5.9 against the trails' 2,500 km² needs zoom 9.6, so 10.
    expect(suggestedZoomFor(417_205, 5.9, 2_500)).toBe(10);
    // Exactly four times the cap at zoom 8 lands on the cap at 9, which is not under it.
    expect(suggestedZoomFor(10_000, 8, 2_500)).toBe(10);
    expect(suggestedZoomFor(10_001, 8.2, 2_500)).toBe(10);
  });

  it("never goes past the deepest zoom", () => {
    expect(suggestedZoomFor(1e12, 20, 1)).toBe(22);
  });
});

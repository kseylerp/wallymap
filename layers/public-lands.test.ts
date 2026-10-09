import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { OUTSIDE_US_NOTE } from "./_shared/coverage";
import layer from "./public-lands";

const TAHOE: [number, number, number, number] = [-120.3, 38.8, -119.8, 39.3];
const ALPS: [number, number, number, number] = [6, 45, 8, 47];

function ctx(bbox: [number, number, number, number], stub = vi.fn()) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("public-lands layer", () => {
  it("declares US coverage, the public-domain license and no input", () => {
    expect(layer.id).toBe("public-lands");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USGS PAD-US 4.1)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#B9A6FF" });
  });

  it("returns the PAD-US vector tiles without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(TAHOE, stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toEqual({
      url: "https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf",
      minzoom: 3,
      maxzoom: 12,
      format: "vector",
      sourceLayer: "padus",
      geometry: "polygon",
    });
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toContain("PAD-US");
  });

  it("still returns the tiles outside the US, with a coverage note", async () => {
    const r = await layer.query(ctx(ALPS), {});
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.format).toBe("vector");
    expect(r.coverageNote).toBe(OUTSIDE_US_NOTE);
  });

  it("explains managers and that ownership is not access rules", () => {
    expect(layer.description).toMatch(/federal/i);
    expect(layer.description).toMatch(/state/i);
    expect(layer.description).toMatch(/private/i);
    expect(layer.description).toMatch(/not .*access|access rules/i);
    expect(layer.description).toContain("You cannot see the rendered map");
  });

  it("summarizes to a vector tiles result with the source layer", async () => {
    const r = await layer.query(ctx(TAHOE), {});
    expect(summarizeLayerResult(r)).toMatchObject({ kind: "tiles", format: "vector", sourceLayer: "padus", geometry: "polygon" });
  });

  it("runs through runLayer", async () => {
    const ok = await runLayer("public-lands", { bbox: TAHOE, zoom: 9 });
    expect(ok.status).toBe(200);
  });
});

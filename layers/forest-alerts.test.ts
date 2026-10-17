import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import layer, { alertTileUrl } from "./forest-alerts";

const AMAZON: [number, number, number, number] = [-60, -10, -50, 0];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: AMAZON, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("forest-alerts layer", () => {
  it("builds the verified true-color dynamic tile URL with a start date", () => {
    expect(alertTileUrl("2026-07-11")).toBe(
      "https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png" +
        "?render_type=true_color&start_date=2026-07-11",
    );
  });

  it("covers the tropics and says so, including that Europe is not in this dataset", () => {
    expect(layer.coverage).toEqual({ bbox: [-180, -30, 180, 30] });
    expect(layer.requiredEnv).toEqual([]);
    expect(Object.keys(layer.input.shape)).toEqual([]);
  });

  it("returns raster tiles starting 90 days back, without calling upstream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    try {
      const stub = vi.fn();
      const r = await layer.query(ctx(stub), {});
      expect(stub).not.toHaveBeenCalled();
      if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
      expect(r.data.format).toBe("raster");
      expect(r.data.url).toContain("gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png");
      expect(r.data.url).toContain("start_date=2026-07-11");
      expect(r.coverageNote).toMatch(/Europe/);
      expect(r.coverageNote).toMatch(/30/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("summarizes to the tile URL, format and coverage note", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), {}));
    expect(summary).toMatchObject({
      kind: "tiles",
      format: "raster",
      url: expect.stringContaining("gfw_integrated_alerts"),
      coverageNote: expect.stringContaining("Europe"),
    });
  });

  it("describes weekly alerts and warns they are not logging", () => {
    expect(layer.description).toMatch(/week/i);
    expect(layer.description).toMatch(/logging/i);
  });

  it("answers a box outside the tropics with an error that names disturbance, not an empty layer", async () => {
    const r = await layer.query({ ...ctx(vi.fn()), bbox: [-125, 48, -115, 56] }, {});
    expect(r).toMatchObject({ error: expect.stringContaining("disturbance"), hint: "unavailable" });
    // A box that reaches the tropics still draws.
    expect(await layer.query({ ...ctx(vi.fn()), bbox: [-60, 20, -50, 40] }, {})).toMatchObject({ kind: "tiles" });
  });

  it("runs through runLayer", async () => {
    const res = await runLayer("forest-alerts", { bbox: AMAZON, zoom: 6 });
    expect(res.status).toBe(200);
  });
});

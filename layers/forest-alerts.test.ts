import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { alertTileUrl } from "./forest-alerts";

const AMAZON: [number, number, number, number] = [-60, -10, -50, 0];

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: AMAZON, zoom: 6, env: {}, fetch: stub as unknown as CachedFetch };
}

async function at<T>(iso: string, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("forest-alerts layer", () => {
  it("builds the verified true-color dynamic tile URL with a start and an end date", () => {
    expect(alertTileUrl("2026-07-11")).toBe(
      "https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png" + "?render_type=true_color&start_date=2026-07-11",
    );
    expect(alertTileUrl("2026-07-11", "{date}")).toContain("start_date=2026-07-11&end_date={date}");
  });

  it("covers the tropics, needs no env, and takes a window of 7 to 365 days", () => {
    expect(layer.coverage).toEqual({ bbox: [-180, -30, 180, 30] });
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.input.parse({})).toEqual({ days: 90 });
    expect(layer.input.safeParse({ days: 3 }).success).toBe(false);
  });

  it("draws the last 90 days up to today, and the scrubber moves the window's end (audit 2026-10-17: no time control)", async () => {
    const r = await at("2026-10-09T12:00:00Z", () => layer.query(ctx(vi.fn()), layer.input.parse({})));
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.format).toBe("raster");
    expect(r.data.url).toContain("gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png");
    expect(r.data.url).toContain("start_date=2026-07-12&end_date=2026-10-09");
    expect(r.data.time).toEqual({ template: alertTileUrl("2026-07-12", "{date}"), cadence: "daily", from: "2026-07-12", to: "2026-10-09", daysBack: 0 });
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-07-12", "2026-08-01T00:00:00Z"], Date.parse("2026-10-09T12:00:00Z"))).toContain("end_date=2026-08-01");
    // Inside the tropics the row does not repeat that alerts cover the tropics only.
    expect(r.coverageNote).toBe("Alerts from 2026-07-12 to 2026-10-09");
    const week = await at("2026-10-09T12:00:00Z", () => layer.query(ctx(vi.fn()), layer.input.parse({ days: 7 })));
    expect(week).toMatchObject({ data: { url: expect.stringContaining("start_date=2026-10-03&end_date=2026-10-09") } });
  });

  it("notes the tropics limit only when the view reaches outside them", async () => {
    const r = await layer.query({ ...ctx(vi.fn()), bbox: [-60, 20, -50, 40] }, layer.input.parse({}));
    expect(r).toMatchObject({ kind: "tiles", coverageNote: expect.stringContaining("tropics only") });
  });

  it("keys the three confidence shades and continuous daily time", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.color)).toEqual(["#C92A6D", "#DC6699", "#EDA4C2"]);
    expect(timeShapeOf(layer)).toMatchObject({ shape: "continuous", step: "day" });
    expect(layer.style.raster).toMatchObject({ saturation: 0, opacity: 1 });
  });

  it("summarizes to the tile URL, format and coverage note", async () => {
    const summary = summarizeLayerResult(await layer.query(ctx(vi.fn()), layer.input.parse({})));
    expect(summary).toMatchObject({ kind: "tiles", format: "raster", url: expect.stringContaining("gfw_integrated_alerts"), coverageNote: expect.stringContaining("Alerts from") });
  });

  it("describes weekly alerts and warns they are not logging", () => {
    expect(layer.description).toMatch(/week/i);
    expect(layer.description).toMatch(/logging/i);
  });

  it("answers a box outside the tropics with an error that names disturbance, not an empty layer", async () => {
    const r = await layer.query({ ...ctx(vi.fn()), bbox: [-125, 48, -115, 56] }, layer.input.parse({}));
    expect(r).toMatchObject({ error: expect.stringContaining("disturbance"), hint: "unavailable" });
  });

  it("runs through runLayer", async () => {
    const res = await runLayer("forest-alerts", { bbox: AMAZON, zoom: 6 });
    expect(res.status).toBe(200);
  });
});

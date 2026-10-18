import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { tileUrlForTime } from "@/lib/time";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import layer, { distTileUrl, newestVersionDay, VERSIONS_URL } from "./disturbance";

const RONDONIA: [number, number, number, number] = [-63.5, -10.5, -62.5, -9.5];
/** The GFW data API's dataset answer, trimmed, recorded 2026-10-18 ~06:40 UTC. */
const DATASET = { data: { dataset: "umd_glad_dist_alerts", versions: ["v20260919", "v20260926", "v20261003", "v20261017"] } };

function ctx(stub: ReturnType<typeof vi.fn>) {
  return { bbox: RONDONIA, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

function gfw(down = false) {
  return vi.fn(async (_url: string, _init?: unknown) => (down ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(DATASET), { status: 200 })));
}

async function tiles(input: Record<string, unknown>, stub = gfw()) {
  const r = await layer.query(ctx(stub), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("disturbance layer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T06:40:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("declares global coverage, no env and no area cap", () => {
    expect(layer.id).toBe("disturbance");
    expect(layer.coverage).toBe("global");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
  });

  it("draws every alert of the last 30 days up to GFW's newest day, transparent elsewhere (audit 2026-10-17: one blank or black-squared day)", async () => {
    const stub = gfw();
    const r = await tiles({}, stub);
    expect(stub.mock.calls[0][0]).toBe(VERSIONS_URL);
    expect(stub.mock.calls[0][1]).toMatchObject({ cacheKey: "disturbance:gfw-versions", ttlSeconds: 21_600 });
    expect(r.data.url).toBe(
      "https://tiles.globalforestwatch.org/umd_glad_dist_alerts/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_date=2026-09-18&end_date=2026-10-17",
    );
    expect(r.data).toMatchObject({ minzoom: 3, maxzoom: 12, format: "raster" });
    expect(r.data.time).toEqual({ template: distTileUrl("2026-09-18", "{date}", "all"), cadence: "daily", from: "2026-09-18", to: "2026-10-17", daysBack: 0 });
    expect(r.coverageNote).toBe("Vegetation loss alerts from 2026-09-18 to 2026-10-17");
    // The scrubber moves the window's end and never past the newest day.
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-09-18", "2026-10-01T00:00:00Z"], Date.now())).toContain("start_date=2026-09-18&end_date=2026-10-01");
    expect(tileUrlForTime(r.data.url, r.data.time, ["2026-09-18", "2026-10-18T00:00:00Z"], Date.now())).toContain("end_date=2026-10-17");
  });

  it("takes a window length, a past end day and confirmed-only alerts, and clamps a day past the newest", async () => {
    const r = await tiles({ date: "2026-08-31", days: 7, confidence: "high" });
    expect(r.data.url).toContain("start_date=2026-08-25&end_date=2026-08-31&alert_confidence=high");
    expect(r.coverageNote).toBe("Vegetation loss alerts from 2026-08-25 to 2026-08-31, confirmed only");
    const late = await tiles({ date: "2026-10-18" });
    expect(late.data.url).toContain("end_date=2026-10-17");
    expect(late.coverageNote).toContain("showing 2026-10-17");
    expect(await layer.query(ctx(gfw()), layer.input.parse({ date: "2023-01-01" }))).toMatchObject({ error: expect.stringContaining("2024-10-17") });
  });

  it("falls back to a week's lag, and says so, when the data API does not answer", async () => {
    const r = await tiles({}, gfw(true));
    expect(r.data.url).toContain("end_date=2026-10-11");
    expect(r.coverageNote).toContain("taken as a week ago");
  });

  it("reads the newest version day", () => {
    expect(newestVersionDay(DATASET)).toBe("2026-10-17");
    expect(newestVersionDay({ data: { versions: ["latest"] } })).toBeNull();
    expect(newestVersionDay(null)).toBeNull();
  });

  it("names the two shades in its key, continuous daily time, and the user's words", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual(["Confirmed (high confidence)", "Possible (low confidence)"]);
    expect(timeShapeOf(layer)).toMatchObject({ shape: "continuous", step: "day" });
    for (const word of ["weekly", "30 m", "new clearing", "forest-loss", "does not prove deforestation", "US"]) {
      expect(layer.description).toContain(word);
    }
    expect(layer.input.safeParse({ date: "last week" }).success).toBe(false);
    expect(layer.input.safeParse({ days: 0 }).success).toBe(false);
  });

  it("summarizes to the tile URL and time range for the model", async () => {
    expect(summarizeLayerResult(await layer.query(ctx(gfw()), layer.input.parse({})))).toMatchObject({
      kind: "tiles",
      time: { cadence: "daily", from: "2026-09-18", to: "2026-10-17" },
    });
  });

  it("runs through runLayer", async () => {
    expect((await runLayer("disturbance", { bbox: RONDONIA, input: { date: "x" } })).status).toBe(400);
  });
});

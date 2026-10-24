import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { toExpression } from "@/lib/ee/expr";
import { GREENUP_YEARS, greenupScale, parseGreenupQuery, readYears, yearsExpression } from "@/lib/ee/greenup";
import { EE_TILE_LAYERS } from "@/lib/ee/tiles";

/** Earth Engine is stubbed: `compute` answers with each year's green-up day over the box (Asheville's, read live 2026-10-23, rounded). */
const compute = vi.fn();
vi.mock("@/lib/ee/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ee/client")>()),
  createEeClient: () => ({ project: "test", compute, mapName: vi.fn(), tile: vi.fn() }),
  eeConfigured: () => true,
}));

const { default: layer, earlyLate, greenupReading, greenupSentence, greenupStrip, GREENUP_LEGEND } = await import("./phenology");

const ASHEVILLE: [number, number, number, number] = [-82.8, 35.4, -82.3, 35.8];
const DAYS = [92, 90, 88, 85, 87, 86, 80, 89, 94, 91, 77, 75, 94, 89, 86, 84, 83, 87, 88, 85, 86, 90, 87, 85, 87];
const yearsResult = Object.fromEntries(GREENUP_YEARS.map((y, i) => [`y${y}`, DAYS[i]]));

function ctx(env: Record<string, string> = { EE_PROJECT: "wally-14e22" }, bbox = ASHEVILLE) {
  return { bbox, zoom: 10, env, fetch: vi.fn() as unknown as CachedFetch };
}

describe("phenology greenup view (MODIS MCD12Q2 on Earth Engine)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    compute.mockReset();
    compute.mockResolvedValue(yearsResult);
  });
  afterEach(() => vi.useRealTimers());

  it("reads each year's day, the usual (median) date and how early or late the latest year came", () => {
    const years = readYears({ ...yearsResult, y2003: null });
    expect(years).toHaveLength(24);
    const r = greenupReading(years)!;
    expect(r.usual).toBe(87);
    expect(r.latest).toEqual({ year: 2025, day: 87 });
    expect(r.earliest).toEqual({ year: 2012, day: 75 });
    expect(greenupReading(years.slice(0, 3))).toBeNull();
    expect(earlyLate(-9)).toBe("9 days early");
    expect(earlyLate(4)).toBe("4 days late");
    expect(earlyLate(1)).toBe("about on time (1 day late)");
    expect(greenupSentence("around Asheville", r)).toMatch(/^Spring green-up around Asheville usually arrives about Mar 29 \(in March; median of 2001–2025/);
  });

  it("the strip counts the springs per month and marks the usual date", () => {
    const years = readYears(yearsResult);
    const strip = greenupStrip("Asheville", years, greenupReading(years)!);
    const row = strip.rows[0];
    expect(row.kind).toBe("cells");
    if (row.kind !== "cells") return;
    expect(row.values.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(25);
    expect(row.values[2]).toBeGreaterThan(15);
    expect(strip.mark).toMatchObject({ month: 2, label: "Usual green-up, Mar 29" });
  });

  it("view greenup draws our own tiles of the usual date, states it first and carries the strip", async () => {
    const r = await layer.query(ctx(), layer.input.parse({ view: "greenup", name: "Asheville" }));
    if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
    expect(r.data.url).toBe("/api/ee/tiles/phenology/{z}/{x}/{y}?view=greenup");
    expect(r.coverageNote).toMatch(/^Spring green-up around Asheville usually arrives about Mar 29/);
    expect(r.coverageNote).toContain("in 2025 it came on Mar 29, right on the usual date");
    expect(r.legend).toBe(GREENUP_LEGEND);
    expect(r.months?.rows[0]).toMatchObject({ key: "greenup" });
    expect(r.time).toEqual({ shape: "none" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("the anomaly view adds the usual date for a local box only, and stands alone when Earth Engine fails", async () => {
    const r = await layer.query(ctx(), layer.input.parse({ name: "Asheville" }));
    expect(r).toMatchObject({ kind: "tiles", coverageNote: expect.stringMatching(/^Spring green-up around Asheville usually arrives about Mar 29.*The map: First leaf spring index anomaly/) });
    compute.mockClear();
    const wide = await layer.query(ctx(undefined, [-125, 25, -66, 49]), layer.input.parse({}));
    expect(wide).toMatchObject({ kind: "tiles", coverageNote: expect.stringMatching(/^First leaf/) });
    expect(compute).not.toHaveBeenCalled();
    compute.mockRejectedValueOnce(new Error("down"));
    const failed = await layer.query(ctx(), layer.input.parse({}));
    expect(failed).toMatchObject({ kind: "tiles", coverageNote: expect.stringMatching(/^First leaf/) });
  });

  it("without EE_PROJECT the greenup view is unavailable and the anomaly view does not ask", async () => {
    expect(await layer.query(ctx({}), layer.input.parse({ view: "greenup" }))).toMatchObject({ hint: "unavailable" });
    await layer.query(ctx({}), layer.input.parse({}));
    expect(compute).not.toHaveBeenCalled();
  });

  it("the tile route draws only the whitelisted green-up picture; the box is read at MODIS scale or coarser", () => {
    expect(parseGreenupQuery(new URLSearchParams("view=greenup"))).toBe(true);
    expect(parseGreenupQuery(new URLSearchParams("view=greenup&x=1"))).toBe(false);
    expect(EE_TILE_LAYERS.phenology.picture(new URLSearchParams("view=greenup"))?.key).toBe("phenology:greenup:v2");
    expect(EE_TILE_LAYERS.phenology.picture(new URLSearchParams("view=other"))).toBeNull();
    expect(greenupScale(ASHEVILLE)).toBe(500);
    expect(greenupScale([-125, 25, -66, 49])).toBeGreaterThan(20_000);
    const expr = JSON.stringify(toExpression(yearsExpression(ASHEVILLE)));
    expect(expr).toContain("MODIS/061/MCD12Q2/2001_01_01");
    expect(expr).toContain("MODIS/061/MCD12Q2/2025_01_01");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Position } from "geojson";
import riverPulse, { _resetRiverFlowFile, nearestTown, clipLine, cutLine, fileDays, flowText, interpolateFlow, isRiverFlowFile, joinRuns, onDays, outletEnds, planPoints, reachesOf, reachFeatures, RIVER_FLOW_URL, runsIn, usUnitsAt, type RiverFlowFile, type Run } from "./river-pulse";
import { displayOf, labelsOf, legendOf, timeShapeOf } from "./contract";
import type { CachedFetch } from "@/lib/fetch";
import { attributeProblems } from "./attributes";
import { biggestSwing, ratioWords, repeatLag, seriesStory } from "@/lib/layers/story";
import { summarizeLayerResult } from "@/lib/layers/summarize";

/** A straight east-west line at `lat` from `w` to `e`, a vertex every 0.1°. */
function line(w: number, e: number, lat = 40): Position[] {
  const out: Position[] = [];
  for (let x = w; x <= e + 1e-9; x += 0.1) out.push([Number(x.toFixed(4)), lat]);
  return out;
}

const DAYS = Array.from({ length: 6 }, (_, k) => `2026-10-${String(12 + k).padStart(2, "0")}`);

describe("river pulse geometry", () => {
  it("clips a line to the runs inside the box", () => {
    const runs = clipLine(line(-1, 3), [0, 39, 2, 41]);
    expect(runs).toHaveLength(1);
    expect(runs[0][0][0]).toBe(0);
    expect(runs[0][runs[0].length - 1][0]).toBe(2);
  });

  it("joins runs of one river that meet end to end, whichever way they run", () => {
    const a: Run = { name: "Big", rank: 1, line: line(0, 1), km: 85 };
    const b: Run = { name: "Big", rank: 1, line: [...line(1, 2)].reverse(), km: 85 };
    const other: Run = { name: "Small", rank: 1, line: line(1, 2, 41), km: 85 };
    const joined = joinRuns([a, b, other]);
    expect(joined).toHaveLength(2);
    expect(joined.find((r) => r.name === "Big")?.km).toBe(170);
  });

  it("cuts a run into reaches of about the step, and reads the most important rivers first within the budget", () => {
    expect(cutLine(line(0, 10), 170).length).toBeGreaterThanOrEqual(4);
    const features = [
      { type: "Feature", geometry: { type: "LineString", coordinates: line(0, 10) }, properties: { name: "Main", scalerank: 1, featurecla: "River" } },
      { type: "Feature", geometry: { type: "LineString", coordinates: line(0, 5, 41) }, properties: { name: "Creek", scalerank: 9, featurecla: "River" } },
    ] as never;
    const runs = runsIn(features, [-1, 39, 11, 42]);
    expect(runs[0].name).toBe("Main");
    // A point snapped ahead of time on Main is used as it is; Creek gets a new one.
    const known = [{ name: "Main", at: [5, 40.02], cell: [5.05, 40] }];
    const { runs: kept, samples } = planPoints(runs, known, { maxNew: 40 });
    expect(kept.map((r) => r.name)).toEqual(["Main", "Creek"]);
    expect(samples[0]).toMatchObject({ run: 0, cell: [5.05, 40] });
    expect(samples.filter((x) => !x.cell)).toHaveLength(1);
    // A map load plans no new points: Creek, which the file does not cover, is not drawn.
    expect(planPoints(runs, known).runs.map((r) => r.name)).toEqual(["Main"]);
    expect(reachesOf(kept).length).toBeGreaterThan(5);
  });

  it("finds where rivers leave the view: a tributary flows into its river, the river's mouth is an outlet", () => {
    const main: Run = { name: "Main", rank: 1, line: line(0, 4), km: 340 };
    // A tributary from the north, ending on Main's line at 2°E.
    const trib: Run = { name: "Trib", rank: 5, line: [[2, 42], [2, 41], [2, 40.001]], km: 220 };
    // Main gains flow toward its east end (its mouth); the tributary toward its south end.
    const flow = (run: number, km: number) => (run === 0 ? 100 + km : 50 + km);
    expect(outletEnds([main, trib], flow)).toEqual(["end", null]);
  });

  it("totals the flow at the outlets, so water is not counted twice", () => {
    const main: Run = { name: "Main", rank: 1, line: line(0, 4), km: 340 };
    const trib: Run = { name: "Trib", rank: 5, line: [[2, 42], [2, 41], [2, 40.001]], km: 220 };
    const reaches = reachesOf([main, trib], 6);
    const samples = [
      { run: 0, atKm: 10, at: [0.1, 40] },
      { run: 0, atKm: 330, at: [3.9, 40] },
      { run: 1, atKm: 110, at: [2, 41] },
    ];
    const t = (q: number) => ({ time: DAYS, q: DAYS.map(() => q) });
    const built = reachFeatures(reaches, samples, [t(100), t(400), t(50)], "2026-10-15T10:00:00Z", [main, trib])!;
    const outlets = built.data.features.filter((f) => f.properties?.outlet === true);
    expect(outlets.map((f) => f.properties?.name)).toEqual(["Main"]);
    // Every reach carries its river's figure: Main's outlet (a mouth, with no line ends given), and the tributary (no
    // outlet) its largest reach, each under its own label.
    const figureOf = (name: string) => new Set(built.data.features.filter((f) => f.properties?.name === name).map((f) => `${f.properties?.riverFigure} ${f.properties?.riverQ}`));
    expect([...figureOf("Main")]).toEqual([`mouth ${outlets[0].properties?.q}`]);
    expect([...figureOf("Trib")]).toEqual(["largest 50"]);
    expect(built.data.features.find((f) => f.properties?.name === "Trib")?.properties?.atLargest).toBe("50 m³/s (1,770 cfs)");
    const story = seriesStory(built.data.features, built.series, riverPulse.attributes)!;
    expect(story.measure).toMatch(/^Total flow leaving the view, all outlets combined/);
    expect(story.peak.value).toBe(Math.round(outlets[0].properties?.q as number));
  });

  it("says a river is cut by the view, not at its mouth, when its outlet is at none of its line's ends", () => {
    // Main runs from 0°E to 6°E; the view keeps 0 to 4°E, so its outlet (east end) is where the view cuts it.
    const main: Run = { name: "Main", rank: 1, line: line(0, 4), km: 340 };
    const reaches = reachesOf([main], 4);
    const samples = [{ run: 0, atKm: 170, at: [2, 40] }];
    const t = { time: DAYS, q: DAYS.map(() => 675) };
    const cut = reachFeatures(reaches, samples, [t], "2026-10-15T10:00:00Z", [main], [[0, 40], [6, 40]])!;
    const outlet = cut.data.features.find((f) => f.properties?.outlet === true)!.properties!;
    expect(outlet.outletKind).toBe("edge");
    expect(cut.data.features.every((f) => f.properties?.riverFigure === "edge" && f.properties?.atViewEdge && !f.properties?.atMouth)).toBe(true);
    // With the line ending at 4°E, the same outlet is the river's mouth.
    const whole = reachFeatures(reaches, samples, [t], "2026-10-15T10:00:00Z", [main], [[0, 40], [4, 40]])!;
    expect(whole.data.features[0].properties?.riverFigure).toBe("mouth");
    expect(whole.data.features[0].properties?.atMouth).toBe("675 m³/s (23,800 cfs)");
  });

  it("writes flows in cfs first in the United States and m³/s first elsewhere", () => {
    expect(flowText(675, true)).toBe("23,800 cfs (675 m³/s)");
    expect(flowText(675, false)).toBe("675 m³/s (23,800 cfs)");
    expect(flowText(4.26, true)).toBe("150 cfs (4.3 m³/s)");
    expect(usUnitsAt([-90.1, 35.1])).toBe(true);
    expect(usUnitsAt([4.8, 45.7])).toBe(false);
    const run: Run = { name: "Ohio", rank: 1, line: line(-88, -86, 37.5), km: 176 };
    const built = reachFeatures(reachesOf([run], 1), [{ run: 0, atKm: 88, at: [-87, 37.5] }], [{ time: DAYS, q: [100, 200, 400, 200, 100, 50] }], "2026-10-15T10:00:00Z")!;
    const p = built.data.features[0].properties!;
    expect(p.flow).toBe("7,060 cfs (200 m³/s)");
    expect(p.medianFlow).toBe("7,060 cfs (200 m³/s)");
    expect(p.length).toMatch(/^\d+ mi \(\d+ km\)$/);
  });

  it("declares a daily scrubber, a key for the color, labels, UTC days and honest card words", () => {
    expect(timeShapeOf(riverPulse)).toMatchObject({ shape: "continuous", step: "day" });
    const legend = legendOf(riverPulse);
    expect(legend).toMatchObject({ kind: "ramp", field: "pct", unit: "%", title: "Flow vs. the 3-month median" });
    expect(labelsOf(riverPulse)).toEqual({ field: "name", max: 5, rankBy: "q" });
    expect(displayOf(riverPulse).timeZone).toBe("utc");
    const labels = (riverPulse.card?.facts ?? []).map((f) => f.label);
    expect(labels).toContain("Vs. the 3-month median");
    expect(labels).toContain("River where it leaves the view");
    expect(labels.join(" ")).not.toMatch(/normal|At the mouth/i);
    expect(riverPulse.card?.measure?.key).toBe("flow");
  });

  it("names a reach after the nearest town within reach, else by its river alone", () => {
    const towns: [string, number, number][] = [["Baton Rouge", -91.15, 30.45], ["Memphis", -90.05, 35.15]];
    expect(nearestTown([-91.2, 30.3], towns)).toBe("Baton Rouge");
    expect(nearestTown([-80, 30.3], towns)).toBeNull();
  });

  it("interpolates a reach's flow between its river's sample points by distance", () => {
    const flow = interpolateFlow(150, [
      { atKm: 100, q: [10, 20] },
      { atKm: 200, q: [30, null] },
    ]);
    expect(flow).toEqual([20, 20]);
    expect(interpolateFlow(50, [{ atKm: 100, q: [5] }])).toEqual([5]);
  });

  it("builds reach features with today's flow, its percent of the median, the low and the peak, and the frames", () => {
    const run: Run = { name: "Big", rank: 1, line: line(0, 2), km: 170 };
    const reaches = reachesOf([run], 2);
    const built = reachFeatures(reaches, [{ run: 0, atKm: 85, at: [1, 40] }], [{ time: DAYS, q: [100, 200, 400, 200, 100, 50] }], "2026-10-15T10:00:00Z");
    expect(built?.series).toMatchObject({ step: "day", now: 3, forecastFrom: 4 });
    const p = built!.data.features[0].properties!;
    expect(p).toMatchObject({ name: "Big", q: 200, pct: 100, medianQ: 200, peakQ: 400, peakDate: "2026-10-14", lowQ: 100, lowDate: "2026-10-12" });
    expect(p.series.q).toHaveLength(6);
  });

  it("declares its attributes, its pair and its card cleanly", () => {
    expect(attributeProblems(riverPulse)).toEqual([]);
    expect(riverPulse.style.encode).toEqual({ size: "q", color: "pct" });
  });
});

describe("the series story for the note", () => {
  it("finds a tide's repeat and no repeat in a season's drift", () => {
    const tide = Array.from({ length: 168 }, (_, h) => Math.sin((2 * Math.PI * h) / 12.4));
    expect(repeatLag(tide)?.lag).toBeGreaterThanOrEqual(12);
    expect(repeatLag(tide)?.lag).toBeLessThanOrEqual(13);
    const drift = Array.from({ length: 99 }, (_, d) => 1000 + 10 * d + (d > 40 && d < 50 ? 400 : 0));
    expect(repeatLag(drift)).toBeNull();
  });

  it("names the biggest swing within half a day", () => {
    const times = Array.from({ length: 10 }, (_, h) => new Date(Date.UTC(2026, 9, 18, h)).toISOString());
    expect(biggestSwing(times, [9, 8, 4, 1, 0, 2, 5, 8, 9, 9], 8, "m", "hour")).toMatch(/^dropped 9 m in 4 hours, 00:00 UTC 2026-10-18 to 04:00 UTC/);
  });

  it("gives the low, the peak, their ratio and dates, the forecast's end and the drivers", () => {
    const run: Run = { name: "Big", rank: 1, line: line(0, 2), km: 170 };
    const reaches = reachesOf([run], 1);
    const built = reachFeatures(reaches, [{ run: 0, atKm: 85, at: [1, 40] }], [{ time: DAYS, q: [100, 200, 400, 200, 100, 50] }], "2026-10-15T10:00:00Z")!;
    const story = seriesStory(built.data.features, built.series, riverPulse.attributes)!;
    expect(story.low).toEqual({ value: 100, date: "2026-10-12" });
    expect(story.peak).toEqual({ value: 400, date: "2026-10-14" });
    expect(story.ratio).toBe(4);
    expect(story.forecastEnd).toEqual({ value: 50, date: "2026-10-17" });
    expect(story.drivers?.[0].name).toBe("Big");
    expect(story.caption).toContain("lowest 100 m³/s on 2026-10-12, peak 400 m³/s on 2026-10-14 (it about quadruples)");
    expect(ratioWords(2.7)).toBe("nearly triples");
    expect(ratioWords(4.6)).toBe("more than quadruples");
    const summary = summarizeLayerResult({ kind: "geojson", data: built.data, series: built.series, citation: { source: "s", url: "https://e.org", retrieved: "x" } }, "river-pulse", { ...riverPulse.style, attributes: riverPulse.attributes });
    expect("story" in summary && summary.story?.ratio).toBe(4);
    // The caption ends with what width and color mean.
    expect("story" in summary && summary.story?.caption).toMatch(/Line width is Flow \(m³\/s\); color is Flow vs\. the 3-month median/);
    expect(JSON.stringify(summary)).not.toContain('"series":');
  });
});

describe("the daily file", () => {
  afterEach(() => _resetRiverFlowFile());

  /** A file built on `built` with one river, Main, read at two points, the second one's flow missing. */
  function file(built: string): RiverFlowFile {
    const start = new Date(Date.parse(`${built}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    return {
      version: 1,
      built: `${built}T06:30:00Z`,
      source: "s",
      license: "CC BY 4.0",
      url: "https://open-meteo.com/en/docs/flood-api",
      start,
      days: 3,
      forecastDays: 3,
      calls: 14,
      rivers: [{ name: "Main", rank: 1, line: line(0, 4) }],
      points: [
        { name: "Main", at: [1, 40], cell: [1.05, 40], q: [100, 200, 400, 300, 250, 200] },
        { name: "Main", at: [3, 40], cell: [3.05, 40], q: null },
      ],
    };
  }

  const ctx = (stub: ReturnType<typeof vi.fn>) => ({ bbox: [-1, 39, 5, 41] as [number, number, number, number], zoom: 6, env: {}, fetch: stub as unknown as CachedFetch });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("checks the file's shape and lays its days out from start", () => {
    expect(isRiverFlowFile(file("2026-10-17"))).toBe(true);
    expect(isRiverFlowFile({ version: 2 })).toBe(false);
    expect(fileDays(file("2026-10-17"))).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(onDays({ time: ["2026-10-16", "2026-10-17"], q: [5, 6] }, ["2026-10-15", "2026-10-16", "2026-10-17"])).toEqual([null, 5, 6]);
  });

  it("draws the file's rivers, reads live only the point the file lacks, and says which day the file was built", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const live = { daily: { time: ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"], river_discharge: [10, 20, 40, 30, 25, 20] } };
    const stub = vi.fn(async (url: string, _init?: RequestInit) => (url === RIVER_FLOW_URL ? json(file("2026-10-17")) : json([live])));
    try {
      const r = await riverPulse.query(ctx(stub), { days: 3, forecastDays: 3 });
      if ("error" in r || r.kind !== "geojson") throw new Error("expected features");
      expect(r.data.features.length).toBeGreaterThan(0);
      expect(r.coverageNote).toContain("from the daily file built 2026-10-17 (1 points it lacked read live)");
      expect(r.coverageNote).not.toContain("days old");
      expect(r.series?.now).toBe(3);
      // One file fetch and one live POST for the missing point, with no Natural Earth or snapping calls.
      expect(stub.mock.calls.map((c) => c[0])).toEqual([RIVER_FLOW_URL, "https://flood-api.open-meteo.com/v1/flood"]);
      const body = String(stub.mock.calls[1][1]?.body);
      expect(body).toContain("latitude=40.000&longitude=3.050");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the file is more than two days old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const f = file("2026-10-17");
    f.points = [f.points[0]];
    const stub = vi.fn(async () => json(f));
    try {
      const r = await riverPulse.query(ctx(stub), { days: 3, forecastDays: 3 });
      if ("error" in r || r.kind !== "geojson") throw new Error("expected features");
      expect(r.coverageNote).toMatch(/^The daily file is 3 days old \(built 2026-10-17\)/);
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an upstream error when the file cannot be loaded", async () => {
    const r = await riverPulse.query(ctx(vi.fn(async () => new Response("x", { status: 404 }))), { days: 92, forecastDays: 7 });
    expect(r).toMatchObject({ hint: "upstream" });
  });
});

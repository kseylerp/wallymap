import { describe, expect, it } from "vitest";
import type { Position } from "geojson";
import riverPulse, { clipLine, cutLine, interpolateFlow, joinRuns, MAX_SAMPLES, planSamples, reachesOf, reachFeatures, runsIn, type Run } from "./river-pulse";
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

  it("cuts a run into reaches of about the step, and samples the most important rivers first", () => {
    expect(cutLine(line(0, 10), 170).length).toBeGreaterThanOrEqual(4);
    const features = [
      { type: "Feature", geometry: { type: "LineString", coordinates: line(0, 10) }, properties: { name: "Main", scalerank: 1, featurecla: "River" } },
      { type: "Feature", geometry: { type: "LineString", coordinates: line(0, 5, 41) }, properties: { name: "Creek", scalerank: 9, featurecla: "River" } },
    ] as never;
    const runs = runsIn(features, [-1, 39, 11, 42]);
    expect(runs[0].name).toBe("Main");
    const { runs: kept, samples } = planSamples(runs, 3);
    expect(samples).toHaveLength(3);
    expect(kept.map((r) => r.name)).toEqual(["Main", "Creek"].slice(0, kept.length));
    expect(samples.every((s) => s.run === 0 || s.run === 1)).toBe(true);
    const reaches = reachesOf(kept);
    expect(reaches.length).toBeGreaterThan(5);
    expect(MAX_SAMPLES).toBeLessThanOrEqual(48);
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
    expect("story" in summary && summary.story?.caption).toMatch(/Line width is Flow \(m³\/s\); color is Flow vs\. the period's median/);
    expect(JSON.stringify(summary)).not.toContain('"series":');
  });
});

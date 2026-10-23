import { describe, expect, it, vi } from "vitest";
import type { Feature } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { cardContent } from "@/lib/render/card";
import { displayOf, legendOf, legendProblems, timeShapeOf } from "./contract";
import layer, { LEGEND, currentNotes, currentText, towardText } from "./ocean-currents";

const TOMALES: [number, number, number, number] = [-123.0, 38.05, -122.8, 38.25];

/** Open-Meteo Marine for a batch of nodes: two hours, flowing toward the northeast at a speed (km/h) that grows with the index. */
function marine() {
  return vi.fn(async (url: string, init?: { body?: URLSearchParams }) => {
    if (!init?.body) return new Response("{}", { status: 404 });
    const n = String(init.body.get("latitude")).split(",").length;
    const rows = Array.from({ length: n }, (_, k) => ({
      hourly: {
        time: ["2026-10-18T00:00", "2026-10-18T01:00"],
        ocean_current_velocity: [(k % 5) * 0.9, (k % 5) * 0.9],
        ocean_current_direction: [45, 45],
        sea_surface_temperature: [13, 13],
      },
    }));
    return new Response(JSON.stringify(rows), { status: 200 });
  });
}

describe("ocean-currents", () => {
  it("keys what the particles draw: color is water temperature, brightness is speed", () => {
    expect(legendOf(layer)).toBe(LEGEND);
    expect(legendProblems(LEGEND, "ocean-currents")).toEqual([]);
    expect(LEGEND).toMatchObject({ kind: "ramp", field: "sst", unit: "°C" });
    expect(LEGEND.note).toMatch(/brighter, longer streaks are faster/);
    expect(layer.style.encode).toEqual({ size: "speed", color: "sst" });
  });

  it("steps hourly and reads knots first, metric second (R12)", () => {
    expect(timeShapeOf(layer)).toEqual({ shape: "continuous", step: "hour" });
    expect(displayOf(layer).units).toBe("us");
    expect(currentText(0.6)).toBe("1.2 knots (0.60 m/s)");
    expect(towardText(1, 1)).toBe("northeast (45°)");
    expect(towardText(0, -1)).toBe("south (180°)");
    expect(towardText(0, 0)).toBeNull();
  });

  it("puts knots and the flow direction on every wet node and the card, and names the current at the asked place", async () => {
    const r = await layer.query({ bbox: TOMALES, zoom: 10, env: {}, fetch: marine() as unknown as CachedFetch }, { days: 1, pastDays: 0 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    const wet = r.data.features.find((f) => (f.properties?.speed as number) > 0) as Feature;
    // 0.9 km/h = 0.25 m/s = 0.49 knots.
    expect(wet.properties).toMatchObject({ speedKt: expect.any(Number), toward: "northeast (45°)" });
    expect(wet.properties?.speedKt).toBeCloseTo((wet.properties?.speed as number) * 1.94384, 1);
    const card = cardContent(wet, { card: layer.card, fieldHelp: layer.fieldHelp, display: displayOf(layer) });
    expect(card.measure?.value).toMatch(/knots \(.* km\/h\)$/);
    expect(card.facts.find((f) => f.label === "Flows toward")?.value).toBe("northeast (45°)");
    expect(card.facts.some((f) => /Eastward|Northward/.test(f.label))).toBe(false);
    expect(r.coverageNote).toMatch(/Current nearest the asked place now \(.*\): \d+\.\d knots? \(\d\.\d\d m\/s\)/);
    expect(r.coverageNote).toMatch(/Strongest current in view now: 1\.9 knots \(1\.00 m\/s\) toward the northeast/);
  });

  it("names no nearest current when the closest wet node is far from the center", () => {
    const node = (lon: number, lat: number, speed: number): Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { name: `${lat}N`, speed },
    });
    const notes = currentNotes([node(-123.9, 38.1, 0.5)], TOMALES);
    expect(notes).toEqual(["Strongest current in view now: 1.0 knot (0.50 m/s) at 38.1N"]);
  });
});

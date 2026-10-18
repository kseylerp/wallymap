import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { legendOf, timeShapeOf } from "./contract";
import layer, { LEGEND } from "./wind-flow";

const SIERRA: [number, number, number, number] = [-120.5, 37.5, -118.5, 39];

/** Open-Meteo's answer for a batch of nodes: two hours, wind from the west at a speed that grows with the node's index. */
function openMeteo() {
  return vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
    const n = String(init.body.get("latitude")).split(",").length;
    const rows = Array.from({ length: n }, (_, k) => ({
      hourly: {
        time: ["2026-10-18T00:00", "2026-10-18T01:00"],
        wind_speed_10m: [k % 12, (k % 12) + 1],
        wind_direction_10m: [270, 270],
        temperature_2m: [8, 7],
      },
    }));
    return new Response(JSON.stringify(rows), { status: 200 });
  });
}

describe("wind-flow", () => {
  it("colors the particles by speed, not temperature, with a speed key", async () => {
    const stub = openMeteo();
    const r = await layer.query({ bbox: SIERRA, zoom: 7, env: {}, fetch: stub as unknown as CachedFetch }, { days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
    expect(r.flow?.color).toBe("speed");
    expect(r.data.features[0].properties).toMatchObject({ tempC: expect.any(Number), speed: expect.any(Number) });
    expect(layer.style.encode).toEqual({ size: "speed", color: "tempC" });
    expect(legendOf(layer)).toBe(LEGEND);
    expect(LEGEND).toMatchObject({ kind: "ramp", field: "speed", unit: "m/s" });
    expect(timeShapeOf(layer, r)).toMatchObject({ shape: "continuous", step: "hour" });
    expect(layer.description).toMatch(/color and brightness are the speed/);
  });
});

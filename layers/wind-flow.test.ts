import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { cardContent } from "@/lib/render/card";
import { displayOf, legendOf, timeShapeOf } from "./contract";
import layer, { LEGEND, compass, hereNote, inUs, windText, type PointBody } from "./wind-flow";

const SIERRA: [number, number, number, number] = [-120.5, 37.5, -118.5, 39];

/** Open-Meteo at the asked place (timezone=auto): Pacific time, two days, gusts beside the wind. */
function pointBody(): PointBody {
  const time = [...Array.from({ length: 24 }, (_, h) => `2026-10-18T${String(h).padStart(2, "0")}:00`), ...Array.from({ length: 24 }, (_, h) => `2026-10-19T${String(h).padStart(2, "0")}:00`)];
  // Day one peaks at 3 PM (6 m/s), day two at 2 PM (12 m/s, gust 20 m/s at 3 PM).
  const speed = time.map((t) => (t === "2026-10-18T15:00" ? 6 : t === "2026-10-19T14:00" ? 12 : 2));
  const gusts = time.map((t) => (t === "2026-10-19T15:00" ? 20 : t === "2026-10-18T15:00" ? 9 : 4));
  return { timezone: "America/Los_Angeles", utc_offset_seconds: -25_200, hourly: { time, wind_speed_10m: speed, wind_gusts_10m: gusts, wind_direction_10m: time.map(() => 248) } };
}

/** Open-Meteo for a batch of grid nodes (POST): two hours, wind from the west at a speed that grows with the index; the point call (GET) answers pointBody. */
function openMeteo() {
  return vi.fn(async (_url: string, init?: { body?: URLSearchParams }) => {
    if (!init?.body) return new Response(JSON.stringify(pointBody()), { status: 200 });
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

  it("reads mph first with m/s second (R12): display, card, and speedMph and from on every node", async () => {
    expect(displayOf(layer).units).toBe("us");
    const r = await layer.query({ bbox: SIERRA, zoom: 7, env: {}, fetch: openMeteo() as unknown as CachedFetch }, { days: 1 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const node = r.data.features.find((f) => f.properties?.speed === 10);
    expect(node?.properties).toMatchObject({ speedMph: 22.4, from: "west (270°)" });
    const card = cardContent(node!, { card: layer.card, fieldHelp: layer.fieldHelp, display: displayOf(layer) });
    expect(card.measure?.value).toBe("22.4 mph (10 m/s)");
    expect(card.facts.find((f) => f.label === "From")?.value).toBe("west (270°)");
    expect(card.facts.some((f) => /Eastward|Northward|mph/i.test(f.label))).toBe(false);
  });

  it("states the wind at the asked place, with gusts and each day's peak hour, before the grid", async () => {
    const r = await layer.query({ bbox: SIERRA, zoom: 7, env: {}, fetch: openMeteo() as unknown as CachedFetch }, { days: 2 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/^Wind at the asked place \(38\.25°N 119\.50°W, the center of the view; local times/);
    expect(r.coverageNote).toMatch(/grid nodes, hourly/);
  });

  it("words the place's wind in the reader's units, from the current hour on", () => {
    const now = new Date("2026-10-18T19:30:00Z"); // 12:30 PM PDT
    const us = hereNote(pointBody(), [-116.1, 34.03], now, true);
    expect(us).toBe(
      "Wind at the asked place (34.03°N 116.10°W, the center of the view; local times, PDT): " +
        "now 4 mph (2.0 m/s) from the west-southwest, gusts 9 mph (4.0 m/s); " +
        "Sun, Oct 18 peak 13 mph (6.0 m/s) at 3 PM, gusts to 20 mph (9.0 m/s) at 3 PM; " +
        "Mon, Oct 19 peak 27 mph (12.0 m/s) at 2 PM, gusts to 45 mph (20.0 m/s) at 3 PM",
    );
    expect(hereNote(pointBody(), [6.87, 45.92], now, false)).toMatch(/now 7 km\/h \(2\.0 m\/s\)/);
    // After day one's peak hour, today's peak is the rest of today, not the morning.
    const late = hereNote(pointBody(), [-116.1, 34.03], new Date("2026-10-19T00:30:00Z"), true);
    expect(late).toMatch(/Sun, Oct 18 peak 4 mph \(2\.0 m\/s\) at 5 PM/);
    expect(hereNote({ ...pointBody(), hourly: { time: [], wind_speed_10m: [], wind_direction_10m: [] } }, [0, 0], now, true)).toBeNull();
  });

  it("knows US places, compass words and both unit orders", () => {
    expect(inUs([-116.1, 34.03])).toBe(true);
    expect(inUs([-150, 61])).toBe(true);
    expect(inUs([6.87, 45.92])).toBe(false);
    expect(compass(0)).toBe("north");
    expect(compass(248)).toBe("west-southwest");
    expect(compass(359)).toBe("north");
    expect(windText(10, true)).toBe("22 mph (10.0 m/s)");
    expect(windText(10, false)).toBe("36 km/h (10.0 m/s)");
  });
});

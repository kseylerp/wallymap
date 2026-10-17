import { describe, expect, it } from "vitest";
import { fieldFeatures, gridFor, nodeName, waterMask } from "@/layers/_shared/flowGrid";
import oceanCurrents from "@/layers/ocean-currents";
import windFlow from "@/layers/wind-flow";
import { attributeProblems } from "@/layers/attributes";
import { fieldAt, flowFrame, flowLayersOf, MAX_PARTICLES, ParticleSystem, sampleField, TRAIL, type ParticleView } from "@/lib/render/particles";
import { buildDeckLayers } from "@/lib/render/deck";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { reduce } from "@/lib/render/reducer";

const HOURS = Array.from({ length: 4 }, (_, h) => new Date(Date.UTC(2026, 9, 17, h)).toISOString().slice(0, 16));

/** A 3 x 3 grid where every node flows east at 1 m/s (km/h 3.6, toward 90°), warming hour by hour. */
function eastField(): LoadedLayer {
  const grid = gridFor([0, 0, 2, 2], 9);
  const rows = Array.from({ length: 9 }, () => ({
    time: HOURS,
    speed_kmh: HOURS.map(() => 3.6),
    dir: HOURS.map(() => 90),
    temp: HOURS.map((_, h) => 5 + h),
  }));
  const built = fieldFeatures(grid, rows as never, { speed: "speed_kmh", direction: "dir", color: "temp", speedUnit: "km/h", directionIs: "toward" }, "2026-10-17T01:30:00Z", "sst")!;
  return {
    id: "ocean-currents",
    title: "Ocean currents",
    style: oceanCurrents.style,
    attributes: oceanCurrents.attributes,
    result: {
      kind: "geojson",
      data: built.data,
      series: built.series,
      flow: { nx: grid.nx, ny: grid.ny, bbox: [0, 0, 2, 2], u: "east", v: "north", color: "sst" },
      citation: { source: "s", url: "https://e.org", retrieved: "x" },
    },
    receivedAt: "x",
  };
}

const VIEW: ParticleView = { bounds: [0, 0, 2, 2], metersPerPixel: 1000, widthPx: 800, heightPx: 600 };

describe("a flow grid from Open-Meteo", () => {
  it("covers the box with nodes about equally far apart, under the cap", () => {
    const g = gridFor([-154.5, 58.6, -149.4, 61.6], 360);
    expect(g.nx * g.ny).toBeLessThanOrEqual(360);
    expect(g.lons[0]).toBe(-154.5);
    expect(g.lats[g.lats.length - 1]).toBe(61.6);
    expect(nodeName(-151.04, 60.88)).toBe("60.88°N 151.04°W");
  });

  it("turns speed and direction into east and north parts: currents flow toward, wind comes from", () => {
    const layer = eastField();
    const p = layer.result.kind === "geojson" ? layer.result.data.features[0].properties : null;
    expect(p).toMatchObject({ node: 0, east: 1, north: 0, speed: 1, sst: 6 });
    const wind = fieldFeatures(gridFor([0, 0, 1, 1], 4), Array.from({ length: 4 }, () => ({ time: HOURS, s: HOURS.map(() => 2), d: HOURS.map(() => 0) })) as never, { speed: "s", direction: "d", speedUnit: "m/s", directionIs: "from" }, "2026-10-17T00:00:00Z", "tempC")!;
    // A north wind (from 0°) blows south.
    expect(wind.data.features[0].properties).toMatchObject({ east: -0, north: -2 });
    expect(wind.series).toMatchObject({ step: "hour", now: 0 });
  });

  it("masks the land finer than the grid", () => {
    const mask = waterMask([0, 0, 1, 1], (lon) => lon < 0.5)!;
    const bits = Buffer.from(mask.bits, "base64");
    expect(mask.nx).toBeGreaterThan(10);
    // The first cell (west, land) is off; the last (east, water) is on.
    expect(bits[0] & 1).toBe(0);
    const last = mask.nx * mask.ny - 1;
    expect((bits[last >> 3] >> (last & 7)) & 1).toBe(1);
  });

  it("declares both layers cleanly, each drawn as particles with brightness and color", () => {
    expect(attributeProblems(oceanCurrents)).toEqual([]);
    expect(attributeProblems(windFlow)).toEqual([]);
    expect(windFlow.style.encode).toEqual({ size: "speed", color: "tempC" });
  });
});

describe("particles through the field", () => {
  it("samples the field between nodes and nowhere outside it", () => {
    const field = fieldAt(eastField(), 1)!;
    expect(sampleField(field, 1, 1)).toMatchObject({ u: 1, v: 0 });
    expect(sampleField(field, 3, 1)).toBeNull();
    expect(field.fast).toBe(1);
  });

  it("moves particles east with the flow, a streak each, brighter for faster", () => {
    const system = new ParticleSystem(2_000, 1);
    const field = fieldAt(eastField(), 1)!;
    const n = system.step(field, VIEW);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(2_000);
    const before = Array.from(system.target.slice(0, 2 * 50));
    for (let k = 0; k < TRAIL + 2; k++) system.step(field, VIEW);
    let east = 0;
    for (let p = 0; p < 50; p++) if (system.target[p * 2] > before[p * 2] && Math.abs(system.target[p * 2 + 1] - before[p * 2 + 1]) < 1e-6) east += 1;
    expect(east).toBeGreaterThan(25);
    // Streak tails trail behind their heads.
    expect(system.source[0]).toBeLessThanOrEqual(system.target[0]);
    expect(system.layer("x:particles").id).toBe("x:particles");
  });

  it("wants about one particle per 55 px² of field on screen, never past the cap", () => {
    expect(ParticleSystem.wanted({ bbox: [0, 0, 2, 2] }, VIEW)).toBe(Math.round((800 * 600) / 55));
    expect(ParticleSystem.wanted({ bbox: [0, 0, 2, 2] }, { ...VIEW, widthPx: 4000, heightPx: 3000 })).toBe(MAX_PARTICLES);
  });

  it("draws a flow layer only as particles: no grid symbols, and the scrubber steps its hours", () => {
    const layer = eastField();
    let state: MapState = reduce(initialMapState, { type: "layer_loaded", layer });
    state = reduce(state, { type: "render", op: { layerId: layer.id, mode: "points", visible: true } });
    expect(buildDeckLayers(state, { mapboxToken: "" })).toHaveLength(0);
    expect(flowLayersOf(state)).toHaveLength(1);
    expect(state.time?.index.bucket).toBe("hour");
    expect(flowFrame(layer, state, 2.5)).toBe(2.5);
  });
});

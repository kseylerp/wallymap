import { deflateSync } from "node:zlib";
import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { addClimb, along, chainLines, decodeTerrarium, mergeHikes, resetTerrainTiles } from "./hikes";

const way = (name: string | undefined, coordinates: [number, number][], extra: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties: { ...(name && { name }), kind: "path", sac_scale: "not_rated", osmId: `way/${coordinates[0][0]}`, ...extra },
});

/** A 256 by 256 Terrarium PNG whose elevation is `height(x, y)` metres. */
function terrarium(height: (x: number, y: number) => number): Uint8Array {
  const size = 256;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const v = height(x, y) + 32768;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.floor(v / 256);
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = Math.round((v % 1) * 256);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

describe("mergeHikes", () => {
  it("joins the ways of one name that touch into one hike with its whole length (the Wildwood Trail was two pieces)", () => {
    const hikes = mergeHikes([
      way("Wildwood Trail", [[-122.75, 45.53], [-122.74, 45.54]]),
      way("Wildwood Trail", [[-122.74, 45.54], [-122.73, 45.55]]),
      way(undefined, [[-122.7, 45.5], [-122.69, 45.5]]),
    ]);
    expect(hikes).toHaveLength(2);
    expect(hikes[0].properties).toMatchObject({ name: "Wildwood Trail", ways: 2, shape: "out-and-back" });
    expect(hikes[0].geometry.type).toBe("LineString");
    expect(Number(hikes[0].properties?.lengthKm)).toBeCloseTo(2.7, 1);
    expect(hikes[0].properties?.roundTripKm).toBeCloseTo(Number(hikes[0].properties?.lengthKm) * 2, 1);
    // The unnamed path stays a way.
    expect(hikes[1].properties?.name).toBeUndefined();
  });

  it("keeps two trails of one name far apart as two hikes, and reads a loop", () => {
    const hikes = mergeHikes([
      way("Lake Trail", [[-105.3, 40], [-105.29, 40]]),
      way("Lake Trail", [[-105.0, 40.2], [-104.99, 40.2]]),
      way("Ring Loop", [[-105.1, 40.1], [-105.09, 40.1], [-105.09, 40.11]]),
      way("Ring Loop", [[-105.09, 40.11], [-105.1, 40.1]]),
    ]);
    expect(hikes.filter((h) => h.properties?.name === "Lake Trail")).toHaveLength(2);
    expect(hikes.find((h) => h.properties?.name === "Ring Loop")?.properties).toMatchObject({ shape: "loop" });
  });

  it("takes the hardest rated difficulty among the ways", () => {
    const [hike] = mergeHikes([way("Ridge", [[0, 0], [0.01, 0]], { sac_scale: "hiking" }), way("Ridge", [[0.01, 0], [0.02, 0]], { sac_scale: "alpine_hiking" })]);
    expect(hike.properties?.sac_scale).toBe("alpine_hiking");
  });
});

describe("chainLines", () => {
  it("joins lines end to end in either direction", () => {
    const chains = chainLines([[[0, 0], [1, 0]], [[2, 0], [1, 0]], [[2, 0], [3, 0]]]);
    expect(chains).toEqual([[[0, 0], [1, 0], [2, 0], [3, 0]]]);
  });
});

describe("terrain climb", () => {
  it("decodes a Terrarium PNG to metres", () => {
    const heights = decodeTerrarium(terrarium((x) => 1000 + x));
    expect(heights?.[0]).toBeCloseTo(1000, 1);
    expect(heights?.[255]).toBeCloseTo(1255, 1);
    expect(decodeTerrarium(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("adds the climb end to end and the round trip's from the tiles under the hike", async () => {
    resetTerrainTiles();
    const png = terrarium((x) => 2000 + 4 * x);
    const fetchStub = (async () => new Response(Buffer.from(png), { status: 200 })) as unknown as typeof fetch;
    // About 3 km west to east inside one zoom-12 tile near Boulder: the ground rises along x.
    const [hike] = mergeHikes([way("East Ridge", [[-105.27, 40.02], [-105.235, 40.02]])]);
    expect(await addClimb([hike], { fetch: fetchStub })).toBe(1);
    expect(Number(hike.properties?.gainM)).toBeGreaterThan(300);
    expect(hike.properties?.lossM).toBe(0);
    expect(hike.properties?.roundTripGainM).toBe(Number(hike.properties?.gainM));
    expect(Number(hike.properties?.gainPerKm)).toBeGreaterThan(100);
  });

  it("samples a line every step, ends included", () => {
    const pts = along([[0, 0], [0.01, 0]], 0.2, 100);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([0.01, 0]);
    expect(pts.length).toBeGreaterThan(5);
  });
});

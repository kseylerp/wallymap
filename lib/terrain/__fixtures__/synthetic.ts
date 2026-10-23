import { type DemTile, type TileSource, TILE_SIZE, xToLon, yToLat } from "../dem";

/**
 * Elevation tiles computed from a formula, for tests: a tilted plane has one known slope and aspect everywhere, so
 * every number the terrain code derives from it can be checked exactly.
 */

const M_PER_DEG = 111_195;

/**
 * Ground rising `slopeDeg` toward the compass direction `upTo` (degrees from north); it faces the opposite way.
 * Distances are measured from `origin` on a flat projection there, so the plane stays a plane near it.
 */
export function plane(slopeDeg: number, upTo: number, origin: [number, number] = [-110.92, 43.47], base = 1000): (lon: number, lat: number) => number {
  const k = Math.tan((slopeDeg * Math.PI) / 180);
  const ux = Math.sin((upTo * Math.PI) / 180);
  const uy = Math.cos((upTo * Math.PI) / 180);
  const kx = M_PER_DEG * Math.cos((origin[1] * Math.PI) / 180);
  return (lon, lat) => base + k * ((lon - origin[0]) * kx * ux + (lat - origin[1]) * M_PER_DEG * uy);
}

/** A tile source drawing `elevation` at every pixel centre; counts the tiles asked for. */
export function syntheticTiles(elevation: (lon: number, lat: number) => number): TileSource & { asked: string[] } {
  const asked: string[] = [];
  const source = async (z: number, x: number, y: number): Promise<DemTile> => {
    asked.push(`${z}/${x}/${y}`);
    const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let j = 0; j < TILE_SIZE; j++) {
      const lat = yToLat(y + (j + 0.5) / TILE_SIZE, z);
      for (let i = 0; i < TILE_SIZE; i++) elev[j * TILE_SIZE + i] = elevation(xToLon(x + (i + 0.5) / TILE_SIZE, z), lat);
    }
    return { z, x, y, elev };
  };
  return Object.assign(source, { asked });
}

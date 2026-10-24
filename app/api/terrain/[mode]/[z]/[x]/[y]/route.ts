import { encodePng } from "@/lib/terrain/png";
import { FACES, renderTile, TERRAIN_MODES, type Face, type TerrainMode, type TerrainOptions } from "@/lib/terrain/view";

/**
 * One map tile of the terrain layer (layers/terrain.ts): `/api/terrain/<slope|aspect|shade|elevation>/<z>/<x>/<y>` with
 * `min`, `faces`, `date` and `period` as the layer's inputs, and `step`, `lo`, `hi` (the elevation bands). Computed from AWS Terrain Tiles and cached by the CDN for
 * a month (the elevation does not change; a shade tile names its date in the URL).
 */

export const maxDuration = 30;

const DAY = 86_400;

export async function GET(req: Request, ctx: { params: Promise<{ mode: string; z: string; x: string; y: string }> }) {
  const { mode, z: zs, x: xs, y: ys } = await ctx.params;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys.replace(/\.png$/, ""));
  if (!TERRAIN_MODES.includes(mode as TerrainMode) || ![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return new Response("Bad tile", { status: 400 });
  }
  const q = new URL(req.url).searchParams;
  const min = Number(q.get("min"));
  const faces = (q.get("faces") ?? "").split(",").filter((f): f is Face => FACES.includes(f as Face));
  const date = q.get("date");
  const opts: TerrainOptions = {
    mode: mode as TerrainMode,
    ...(q.has("min") && Number.isFinite(min) && { minSlope: min }),
    ...(faces.length > 0 && { faces }),
    ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) && { date }),
    period: q.get("period") === "morning" ? "morning" : "afternoon",
  };
  // Elevation bands: `step` in metres and the lowest and highest band in the view (`lo`, `hi`), as the query chose them.
  const step = Number(q.get("step"));
  const lo = Number(q.get("lo"));
  const hi = Number(q.get("hi"));
  if (opts.mode === "elevation" && step > 0 && step <= 10_000 && Number.isInteger(lo) && Number.isInteger(hi) && hi >= lo && hi - lo <= 100) {
    Object.assign(opts, { bandStepM: step, bandLo: lo, bandHi: hi });
  }
  // Under zoom 9 one tile spans too much ground to read slope from; it is drawn clear. Elevation bands draw from zoom 5.
  const minZoom = opts.mode === "elevation" ? 5 : 9;
  const pixels = z < minZoom ? new Uint8Array(256 * 256 * 4) : await renderTile(z, x, y, opts);
  const png = encodePng({ width: 256, height: 256, data: pixels });
  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": `public, max-age=${DAY}, s-maxage=${30 * DAY}, stale-while-revalidate=${DAY}`,
    },
  });
}

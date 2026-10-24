import { renderDepthTile, type DepthTileOptions } from "@/lib/depth/view";
import { encodePng } from "@/lib/terrain/png";

/**
 * One map tile of the water-depth layer (layers/water-depth.ts): `/api/water-depth/<z>/<x>/<y>?max=<m>&step=<m>&deep=<lon>,<lat>`,
 * where `max` is the depth the ramp ends at, `step` the contour interval and `deep` the deepest point to ring, all set
 * by the layer's query for the view. Computed from NOAA NCEI's DEM mosaic and cached by the CDN for a month (the
 * surveys do not change; the URL names the ramp).
 */

export const maxDuration = 30;

const DAY = 86_400;
/** Under this zoom a tile spans so much that the mosaic answers with coarse overviews; still drawn. */
const MIN_ZOOM = 2;

export async function GET(req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: zs, x: xs, y: ys } = await ctx.params;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys.replace(/\.png$/, ""));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return new Response("Bad tile", { status: 400 });
  }
  const q = new URL(req.url).searchParams;
  const max = Number(q.get("max"));
  const step = Number(q.get("step"));
  const deep = (q.get("deep") ?? "").split(",").map(Number);
  const opts: DepthTileOptions = {
    maxM: Number.isFinite(max) && max > 0 ? Math.min(max, 11_000) : 200,
    stepM: Number.isFinite(step) && step > 0 ? Math.max(step, 1) : 0,
    ...(deep.length === 2 && deep.every(Number.isFinite) && Math.abs(deep[0]) <= 180 && Math.abs(deep[1]) <= 90 && { deepest: [deep[0], deep[1]] as [number, number] }),
  };
  // Contours closer than about a metre apart would fill the tile; the layer never asks for them.
  if (opts.stepM > 0 && opts.maxM / opts.stepM > 200) opts.stepM = 0;
  const pixels = z < MIN_ZOOM ? new Uint8Array(256 * 256 * 4) : await renderDepthTile(z, x, y, opts);
  // A failed fetch is never cached as a clear tile for a month.
  if (!pixels) return new Response("The NOAA elevation mosaic did not answer", { status: 502, headers: { "cache-control": "no-store" } });
  const png = encodePng({ width: 256, height: 256, data: pixels });
  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": `public, max-age=${DAY}, s-maxage=${30 * DAY}, stale-while-revalidate=${DAY}`,
    },
  });
}

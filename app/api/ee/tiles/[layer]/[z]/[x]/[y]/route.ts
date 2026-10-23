import { createEeClient, EeError } from "@/lib/ee/client";
import { EE_TILE_LAYERS, TILE_CACHE_CONTROL } from "@/lib/ee/tiles";
import { eeTileRules, limitRequest } from "@/lib/fetch/rateLimit";

export const maxDuration = 30;

const INT = /^\d{1,7}$/;

/**
 * One Earth Engine map tile, drawn by Google with this server's credentials and handed on as a PNG with long browser and
 * CDN caching (lib/ee/tiles.ts), so the browser never sees a key or a map id and a tile is computed once per picture.
 * The query names the picture (whitelisted per layer); a bad layer, tile or query is a 400, an Earth Engine failure a
 * 502 or 503 that is never cached.
 */
export async function GET(req: Request, ctx: { params: Promise<{ layer: string; z: string; x: string; y: string }> }) {
  const { layer: layerId, z: zs, x: xs, y: ys } = await ctx.params;
  const layer = EE_TILE_LAYERS[layerId];
  const y = ys.replace(/\.png$/, "");
  if (!layer || !INT.test(zs) || !INT.test(xs) || !INT.test(y)) return Response.json({ error: "Unknown tile" }, { status: 400 });
  const [z, x, yi] = [Number(zs), Number(xs), Number(y)];
  const n = 2 ** z;
  if (z < 0 || z > 22 || x >= n || yi >= n) return Response.json({ error: "Tile out of range" }, { status: 400 });
  const picture = layer.picture(new URL(req.url).searchParams);
  if (!picture) return Response.json({ error: "Unknown picture" }, { status: 400 });

  const limited = await limitRequest(req, eeTileRules());
  if (limited) return limited;

  try {
    const tile = await createEeClient().tile(picture.key, picture.image, z, x, yi);
    return new Response(tile.body, { status: 200, headers: { "content-type": tile.contentType, "cache-control": TILE_CACHE_CONTROL } });
  } catch (error) {
    // The server log names the tile and Earth Engine's own message (never a credential), for diagnosis.
    console.warn(`Earth Engine tile ${layerId}/${z}/${x}/${yi} failed: ${error instanceof Error ? error.message : String(error)}`);
    const status = error instanceof EeError && error.sourceStatus.reason === "rate-limited" ? 503 : 502;
    const message = error instanceof EeError ? error.sourceStatus.message : "Earth Engine tile failed.";
    return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
  }
}

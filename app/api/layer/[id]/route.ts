import "@/layers";
import { runLayer } from "@/lib/layers/run";
import { layerRules, limitRequest } from "@/lib/fetch/rateLimit";

export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = await limitRequest(req, layerRules());
  if (limited) return limited;

  const { id } = await ctx.params;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { status, body: result } = await runLayer(id, {
    bbox: body.bbox,
    zoom: typeof body.zoom === "number" ? body.zoom : undefined,
    input: body.input,
  });
  return Response.json(result, { status });
}

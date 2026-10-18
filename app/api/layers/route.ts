import { hardMaxAreaKm2, listLayers } from "@/layers";

/** Public layer catalog for the browser: titles and styles, never env or query code. */
export async function GET(): Promise<Response> {
  return Response.json(
    listLayers().map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      coverage: l.coverage,
      license: l.license,
      style: l.style,
      // The largest box the layer answers (km²); a restored link shrinks its box to it rather than ask and be refused.
      ...(Number.isFinite(hardMaxAreaKm2(l)) && { maxAreaKm2: hardMaxAreaKm2(l) }),
      ...(l.fieldHelp && { fieldHelp: l.fieldHelp }),
      ...(l.card && { card: l.card }),
      ...(l.attributes && { attributes: l.attributes }),
      // The layer contract (docs/layer-contract.md): the browser resolves time shape, legend, labels and units from these.
      ...(l.time && { time: l.time }),
      ...(l.legend && { legend: l.legend }),
      ...(l.labels && { labels: l.labels }),
      ...(l.display && { display: l.display }),
      // A raster layer a tap can ask what is drawn at a point (POST /api/layer/<id>/identify).
      ...(l.identify && { identify: true }),
    })),
  );
}

import { hardMaxAreaKm2, type Layer } from "@/layers/types";

/**
 * One layer's public catalog entry, as `GET /api/layers` sends it to the browser: titles, styles and the layer contract,
 * never env or query code. The eval and the server's answer replay the map through the same entry, so their legend,
 * labels, time and units match the real map's.
 */
export function catalogEntry(l: Layer) {
  return {
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
    // A raster layer colored by class whose legend can ask how much of the view each class covers (POST /api/layer/<id>/shares).
    ...(l.viewShares && { shares: true }),
  };
}

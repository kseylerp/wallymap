import { describe, expect, it } from "vitest";
import { listLayers } from "@/layers";
import { cardRowProblems, cardRows } from "./mapChecks";
import { readSamples } from "@/scripts/card-samples.mjs";

/**
 * Every layer's card in words: the card check (raw keys, bare numbers under their key, unexplained scores, bare URLs)
 * over a recorded live sample of every layer (scripts/card-samples.mts), not only the layers an eval question happens to
 * draw. A raster layer has no card; a source that was down when recorded is named, not passed silently.
 */
const samples = readSamples();
const layers = listLayers();

describe("card text on every layer's recorded sample", () => {
  it("has a sample for every registered layer", () => {
    expect(layers.filter((l) => !samples[l.id]).map((l) => l.id)).toEqual([]);
  });

  for (const layer of layers) {
    const sample = samples[layer.id];
    if (sample?.kind !== "geojson") continue;
    it(`${layer.id}: every card row reads as words`, () => {
      const problems = new Set<string>();
      for (const f of sample.features) for (const p of cardRowProblems(cardRows(f, layer), layer)) problems.add(p);
      expect([...problems]).toEqual([]);
    });
  }

  it("names the layers whose source was down when the samples were recorded", () => {
    const down = layers.filter((l) => samples[l.id]?.kind === "unavailable").map((l) => l.id);
    // Only layers with a documented outage may lack a feature sample.
    expect(down.filter((id) => !DOCUMENTED_OUTAGES.has(id))).toEqual([]);
  });
});

/** Layers whose upstream is down by a documented outage (layer description says so), allowed to lack a sample. */
const DOCUMENTED_OUTAGES = new Set<string>(["mining-claims"]);

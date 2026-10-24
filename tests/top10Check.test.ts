import { describe, expect, it } from "vitest";
import { getLayer, listLayers } from "@/layers";
import { mapAfter } from "@/scripts/eval-model.mjs";
import { TOP10, top10For, type Top10Expect } from "@/scripts/top10.expectations";
import { PHONE_FIRST_SENTENCE_WORDS, filterHolds, firstSentence, inputHolds, top10Rule, type ToolCall } from "@/scripts/top10Check";

/** The top 10 use cases' golden questions (docs/top-10-use-cases.md) and their strict checker (scripts/top10Check.ts). */

describe("top 10 expectations", () => {
  it("has 5 questions for each of the 10 use cases, ids in order, the last of each a phone 'here' question", () => {
    expect(TOP10).toHaveLength(50);
    for (let u = 1; u <= 10; u++) {
      const id = `T${String(u).padStart(2, "0")}`;
      const mine = TOP10.filter((e) => e.useCase === id);
      expect(mine.map((e) => e.id), id).toEqual([1, 2, 3, 4, 5].map((n) => `${id}.${n}`));
      expect(mine[4].question, id).toMatch(/\b(?:here|this)\b.*@view=\[/i);
      expect(mine.slice(0, 4).every((e) => !e.question.includes("@view")), id).toBe(true);
    }
    expect(new Set(TOP10.map((e) => e.question.toLowerCase())).size).toBe(50);
  });

  it("names only registered layers, in layers, main, filters and inputs", () => {
    const ids = new Set(listLayers().map((l) => l.id));
    const named = TOP10.flatMap((e) => [
      ...e.layers.filter((g) => !g.startsWith("combine:")).flatMap((g) => g.split("|")),
      ...e.main.split("|"),
      ...(e.filters ?? []).flatMap((f) => f.layer.split("|")),
      ...(e.inputs ?? []).flatMap((i) => i.layer.split("|")),
      ...(e.anyOf?.layers ?? []),
    ]);
    expect(named.filter((id) => id !== "combine" && !ids.has(id))).toEqual([]);
  });

  it("asks only for filter keys, chip labels and inputs the layers have", () => {
    const problems: string[] = [];
    for (const e of TOP10) {
      for (const f of e.filters ?? []) {
        const layers = f.layer.split("|").filter((id) => id !== "combine").map((id) => getLayer(id)!);
        const keys = f.key.split("|");
        const attrs = layers.flatMap((l) => (l.attributes ?? []).filter((a) => keys.includes(a.key)));
        if (attrs.length === 0) problems.push(`${e.id}: no attribute ${f.key} on ${f.layer}`);
        for (const want of f.labels ?? []) {
          const labels = attrs.flatMap((a) => (a.levels ?? []).map((l) => l.label.toLowerCase()));
          if (attrs.some((a) => a.levels) && !want.split("|").some((w) => labels.includes(w.toLowerCase()))) problems.push(`${e.id}: no chip ${want} on ${f.key}`);
        }
      }
      for (const i of e.inputs ?? []) {
        const shapes = i.layer.split("|").map((id) => Object.keys((getLayer(id)!.input as unknown as { shape: object }).shape));
        if (!shapes.some((s) => s.includes(i.key))) problems.push(`${e.id}: no input ${i.key} on ${i.layer}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("asks for card rows the main layer's card declares, in its order", () => {
    const problems: string[] = [];
    for (const e of TOP10) {
      if (!e.card) continue;
      // The first alternative that is a registered layer with a card (a joined layer keeps its source's card).
      const layer = e.main.split("|").map((id) => getLayer(id)).find((l) => l?.card);
      if (!layer?.card) continue;
      const rows = [layer.card.measure?.label, ...(layer.card.facts ?? []).map((f) => f.label)].filter(Boolean) as string[];
      let at = 0;
      for (const want of e.card) {
        const i = rows.indexOf(want, at);
        if (i === -1) problems.push(`${e.id}: ${layer.id} card has no ${want} after row ${at}`);
        else at = i + 1;
      }
    }
    expect(problems).toEqual([]);
  });

  it("finds a question with or without its @view", () => {
    expect(top10For("Easy bike trails here")?.id).toBe("T03.5");
    expect(top10For("easy bike trails here @view=[-111.85,34.8,-111.7,34.92]")?.id).toBe("T03.5");
    expect(top10For("Show hiking trails around Lake Tahoe")).toBeUndefined();
  });
});

// A small Bentonville answer: two blue trails and a green one, filtered to blue, with a note and three follow-ups.
const BBOX = [-94.3, 36.3, -94.15, 36.42];
const trail = (name: string, v: number, x: number, lengthKm: number) => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[x, 36.35], [x + 0.01, 36.36]] },
  properties: { name, v, level: v >= 2 ? "intermediate" : "beginner", imba: v, mtbScale: v - 1, lengthKm, kind: "rated" },
});
const QUERY: ToolCall = {
  toolName: "query_mtb-trails",
  input: { bbox: BBOX },
  output: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [trail("Slaughter Pen", 2, -94.25, 3.2), trail("Back 40", 2, -94.22, 5.1), trail("All American", 2, -94.2, 2.4), trail("Lake Bella Vista Loop", 0, -94.18, 4.0)] },
    citation: { source: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", retrieved: "2026-10-23" },
  },
};
const GEOCODE: ToolCall = { toolName: "geocode", input: { query: "Bentonville" }, output: { name: "Bentonville, Arkansas, United States", bbox: BBOX, center: [-94.21, 36.37] } };
const RENDER = (filters?: unknown): ToolCall => ({ toolName: "render", input: {}, output: { layerId: "mtb-trails", ...(filters ? { filters } : {}) } });
const NOTE = (markdown: string): ToolCall => ({ toolName: "note", input: { markdown }, output: { markdown } });
const GOOD_NOTE =
  "Three blue trails near Bentonville run 1.5 to 3.2 mi: Slaughter Pen is 3.2 km, Back 40 is 5.1 km and All American is 2.4 km.\n\n" +
  "- Slaughter Pen: 3.2 km\n- Back 40: 5.1 km\n- All American: 2.4 km";
const FOLLOW_UPS = "- How long is the Slaughter Pen loop end to end?\n- Which trails near Back 40 are black?\n- Is there parking near All American?";

const EXPECT: Top10Expect = {
  id: "X.1",
  useCase: "T03",
  question: "Intermediate blue mountain bike trails near Bentonville",
  layers: ["mtb-trails"],
  main: "mtb-trails",
  basemap: ["outdoors-satellite", "outdoors"],
  filters: [{ layer: "mtb-trails", key: "v|level", labels: ["Blue|Intermediate"] }],
  labels: 3,
  legend: ["Difficulty"],
  card: ["IMBA color", "Length"],
  facts: [{ what: "trail length", re: /\d+(?:\.\d+)?\s*(?:mi|km)\b/ }],
  names: 3,
};

function run(calls: ToolCall[], text = FOLLOW_UPS) {
  return top10Rule(EXPECT, { calls, text, state: mapAfter(calls), question: EXPECT.question });
}
const failedIds = (r: ReturnType<typeof run>) => r.failed.map((a) => a.id);
const BLUE = { v: { include: ["2"] } };

describe("top 10 checker", () => {
  it("passes a complete answer: filter set, labels, legend, card in order, grounded note answering first, 3 specific follow-ups", () => {
    const r = run([GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)]);
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails the filter when the chips were never set, and names what was set instead", () => {
    const r = run([GEOCODE, QUERY, RENDER(), NOTE(GOOD_NOTE)]);
    expect(failedIds(r)).toContain("filters");
    const wrong = run([GEOCODE, QUERY, RENDER({ v: { include: ["3"] } }), NOTE(GOOD_NOTE)]);
    expect(wrong.failed.find((a) => a.id === "filters")?.detail).toMatch(/black/i);
  });

  it("fails a layer that never answered, and the card, labels and camera that need it", () => {
    const r = run([GEOCODE, NOTE(GOOD_NOTE)]);
    expect(failedIds(r)).toEqual(expect.arrayContaining(["layers", "main", "card"]));
  });

  it("fails a note that names a trail no result holds, or a number nothing returned", () => {
    const r = run([GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE + "\n\nColer Mountain Preserve Trail is 7.7 km.")]);
    expect(failedIds(r)).toContain("grounded");
  });

  it("fails a note whose first sentence carries no deciding number, and the phone screen with it", () => {
    const r = run([GEOCODE, QUERY, RENDER(BLUE), NOTE("The map shows mountain bike trails near Bentonville.\n\n" + GOOD_NOTE)]);
    expect(failedIds(r)).toEqual(expect.arrayContaining(["answerFirst", "phone"]));
  });

  it("fails a first sentence too long for the folded phone sheet", () => {
    const long = `Three blue trails ${"and more words ".repeat(PHONE_FIRST_SENTENCE_WORDS / 3)}run 3.2 km at most.\n\n${GOOD_NOTE}`;
    expect(failedIds(run([GEOCODE, QUERY, RENDER(BLUE), NOTE(long)]))).toContain("phone");
  });

  it("fails two follow-ups, and three generic ones", () => {
    expect(failedIds(run([GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)], "- Which are black?\n- Any parking?"))).toContain("followUps");
    const generic = "- Any other trails you need?\n- Want to see a different area?\n- Interested in the weather?";
    expect(failedIds(run([GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)], generic))).toContain("followUps");
  });

  it("fails a missing deciding fact, and too few named features", () => {
    const r = run([GEOCODE, QUERY, RENDER(BLUE), NOTE("3 blue trails near Bentonville: Slaughter Pen is the busiest.")]);
    expect(failedIds(r)).toEqual(expect.arrayContaining(["facts", "names"]));
  });

  it("fails a card whose rows are missing or out of order", () => {
    const r = top10Rule({ ...EXPECT, card: ["Length", "IMBA color"] }, { calls: [GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)], text: FOLLOW_UPS, state: mapAfter([GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)]), question: EXPECT.question });
    expect(r.failed.map((a) => a.id)).toEqual(["card"]);
  });

  it("fails a basemap, view and legend the question does not want", () => {
    const calls = [GEOCODE, QUERY, RENDER(BLUE), NOTE(GOOD_NOTE)];
    const r = top10Rule({ ...EXPECT, basemap: ["data-only"], view: ["change"], legend: ["Snow depth"] }, { calls, text: FOLLOW_UPS, state: mapAfter(calls), question: EXPECT.question });
    expect(r.failed.map((a) => a.id).sort()).toEqual(["basemap", "legend", "view"]);
  });
});

describe("top 10 checker helpers", () => {
  it("reads the first sentence past headings, emphasis and abbreviations", () => {
    expect(firstSentence("## Answer\n**Three trails** run 3.2 mi, e.g. Back 40. More here.")).toBe("Three trails run 3.2 mi, e.g. Back 40.");
  });

  it("holds a range filter to its bound with 5% slack, and accepts a filter a combine call put on its side", () => {
    const state = mapAfter([GEOCODE, QUERY, { toolName: "render", input: {}, output: { layerId: "mtb-trails", filters: { lengthKm: { range: [0, 9.9] } } } }]);
    expect(filterHolds({ layer: "mtb-trails", key: "lengthKm", max: 9.66 }, [], state).ok).toBe(true);
    expect(filterHolds({ layer: "mtb-trails", key: "lengthKm", max: 8 }, [], state).ok).toBe(false);
    const combine: ToolCall = { toolName: "combine", input: { op: "near", a: { layerId: "osm-trails", filters: { shape: { include: ["loop"] } } } }, output: { kind: "geojson", data: { type: "FeatureCollection", features: [] } } };
    expect(filterHolds({ layer: "osm-trails|combine", key: "shape", labels: ["Loop"] }, [combine], mapAfter([])).ok).toBe(true);
  });

  it("reads a query input by equality, pattern and bounds", () => {
    const call: ToolCall = { toolName: "query_species", input: { taxon: "Alces alces", days: 30 }, output: { kind: "geojson", data: { type: "FeatureCollection", features: [] } } };
    expect(inputHolds({ layer: "species", key: "taxon", match: "moose|alces" }, [call])).toBe(true);
    expect(inputHolds({ layer: "species", key: "days", max: 31 }, [call])).toBe(true);
    expect(inputHolds({ layer: "species", key: "days", max: 7 }, [call])).toBe(false);
    expect(inputHolds({ layer: "gbif-occurrences", key: "month", equals: 3 }, [call])).toBe(false);
  });
});

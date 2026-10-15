// @vitest-environment jsdom
/**
 * Chat and controls share one state (spec §12c): the render op's filters are the attribute selections, so "only sport
 * crags" from the agent presses the Sport chip, and Rank by and the hex basis travel the same way (and in the link).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LayerStack } from "@/components/LayerStack";
import { getLayer, listLayers } from "@/layers";
import { hexBasisOf, toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { buildTools } from "@/lib/agent/tools";
import { summarizeLayerResult, type GeojsonSummary } from "@/lib/layers/summarize";
import { decodeState, encodeState } from "@/lib/render/permalink";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";

afterEach(cleanup);

const catalog: LayerCatalog = Object.fromEntries(
  listLayers().map((l) => [l.id, { title: l.title, style: l.style, ...(l.fieldHelp && { fieldHelp: l.fieldHelp }), ...(l.attributes && { attributes: l.attributes }) }]),
);
const citation = { source: "OpenBeta and OpenStreetMap", url: "https://openbeta.io/", retrieved: "2026-10-15" };
const crag = (i: number, disciplines: string[], gradeBands: string[], v: number): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-83.66 + i * 0.01, 37.8] },
  properties: { name: `Crag ${i}`, kind: "crag", disciplines, gradeBands, v },
});
const crags = [
  crag(0, ["sport"], ["intermediate", "advanced"], 110),
  crag(1, ["trad"], ["beginner", "intermediate"], 40),
  crag(2, ["sport", "trad"], ["advanced", "elite"], 80),
  crag(3, ["boulder"], ["beginner"], 12),
];
const result = { kind: "geojson" as const, data: { type: "FeatureCollection" as const, features: crags }, citation };

function afterTools(calls: [string, unknown, unknown][]): MapState {
  let state = reduce(initialMapState, { type: "turn_start" });
  for (const [name, input, output] of calls) {
    for (const action of toolResultToActions(name, input, output, { width: 1280, height: 800 }, catalog, state.renderOps)) state = reduce(state, action);
  }
  return state;
}

describe("the agent's render.filters are the row's chips", () => {
  it("summarises climbing's attributes with the include values a chip stands for", () => {
    const layer = getLayer("climbing")!;
    const summary = summarizeLayerResult(result, "climbing", { ...layer.style, attributes: layer.attributes }, layer.fieldHelp) as GeojsonSummary;
    const discipline = summary.attributes?.find((a) => a.key === "disciplines");
    expect(discipline?.type).toBe("category");
    expect(discipline?.values?.find((v) => v.label === "Sport")).toEqual({ label: "Sport", include: ["sport"], count: 2 });
    const grade = summary.attributes?.find((a) => a.key === "gradeBands");
    expect(grade).toMatchObject({ type: "ordinal", scale: "YDS, UIAA, French and V-scale" });
    expect(grade?.values?.map((v) => v.label)).toEqual(["Beginner", "Intermediate", "Advanced", "Elite"]);
  });

  it("'only sport crags': the render op's include presses the Sport chip, the count follows, and a ranked measure lists the top", () => {
    const state = afterTools([
      ["query_climbing", { bbox: [-83.7, 37.75, -83.55, 37.85] }, result],
      ["render", {}, { layerId: "climbing", filters: { disciplines: { include: ["sport"] } }, rankBy: "v" }],
    ]);
    const op = state.renderOps.find((o) => o.layerId === "climbing")!;
    expect(op.filters).toEqual({ disciplines: { include: ["sport"] } });
    expect(op.rankBy).toBe("v");
    render(
      <LayerStack layers={state.layers} renderOps={state.renderOps} catalog={catalog} dispatch={() => {}} open onOpenChange={() => {}} shownLayers={visibleState(state).layers} />,
    );
    const card = screen.getByTestId("layer-card");
    const chips = within(within(card).getByRole("group", { name: "Discipline" })).getAllByRole("button");
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-pressed")])).toEqual([
      ["All", "false"],
      ["Sport 2", "true"],
      ["Trad 2", "false"],
      ["Boulder 1", "false"],
    ]);
    expect(within(card).getByTestId("layer-count").textContent).toBe("2 of 4");
    expect(within(card).getByTestId("filter-summary").textContent).toBe("Filtered: Discipline: Sport");
    const top = within(card).getByTestId("top-list");
    expect(within(top).getAllByRole("button").map((b) => b.textContent)).toEqual(["1Crag 0110 routes", "2Crag 280 routes"]);
  });

  it("maps hexBasis and hexShare onto the cells' basis, and ignores a share without a value", () => {
    expect(hexBasisOf("sum", undefined)).toBe("sum");
    expect(hexBasisOf("share", "wind")).toBe("share:wind");
    expect(hexBasisOf("share", undefined)).toBeNull();
    expect(hexBasisOf("bogus", undefined)).toBeNull();
    const state = afterTools([
      ["query_power-plants", { bbox: [-104, 30, -98, 34] }, { ...result, data: { type: "FeatureCollection", features: crags.map((f) => ({ ...f, properties: { ...f.properties, kind: "wind" } })) } }],
      ["render", {}, { layerId: "power-plants", view: "density", hexBasis: "share", hexShare: "wind", filters: { name: { match: "Crag" } } }],
    ]);
    expect(state.renderOps[0]).toMatchObject({ mode: "hexbin", hexBasis: "share:wind", filters: { name: { match: "Crag" } } });
  });

  it("offers rankBy, hexBasis and hexShare on the render tool, and name search in its filters", () => {
    const schema = buildTools().render.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ layerId: "power-plants", view: "density", hexBasis: "sum", rankBy: "v" }).success).toBe(true);
    expect(schema.safeParse({ layerId: "power-plants", hexBasis: "share", hexShare: "wind" }).success).toBe(true);
    expect(schema.safeParse({ layerId: "climbing", filters: { name: { match: "Muir" } } }).success).toBe(true);
    expect(schema.safeParse({ layerId: "power-plants", hexBasis: "most" }).success).toBe(false);
  });

  it("keeps Rank by, the hex basis and a name search in the share link", () => {
    const state = afterTools([
      ["query_climbing", { bbox: [-83.7, 37.75, -83.55, 37.85] }, result],
      ["render", {}, { layerId: "climbing", mode: "hexbin", rankBy: "v", hexBasis: "share", hexShare: "sport", filters: { name: { match: "Muir Valley" }, disciplines: { include: ["sport"] } } }],
    ]);
    const hash = encodeState({ ...state, time: undefined });
    const decoded = decodeState(hash);
    expect(decoded?.layers[0]).toMatchObject({
      id: "climbing",
      mode: "hexbin",
      rankBy: "v",
      hexBasis: "share:sport",
      filters: { name: { match: "Muir Valley" }, disciplines: { include: ["sport"] } },
    });
    // Rank by None survives the link as "-", not as "rank by default".
    const none = reduce(state, { type: "set_rank_by", layerId: "climbing", key: "" });
    const link = encodeState({ ...none, time: undefined });
    expect(link).toContain("climbing:hexbin:1:-:share%3Asport");
    expect(decodeState(link)?.layers[0].rankBy).toBe("");
  });
});

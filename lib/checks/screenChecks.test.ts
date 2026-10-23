import { describe, expect, it } from "vitest";
import {
  areaFillProblem,
  CHOROPLETH_FILL_VISIBLE_DIFF,
  isOceanDemTile404,
  labelProblems,
  layoutProblems,
  levelVisibilityProblems,
  lineVisibilityProblem,
  placeholderProblems,
  type LayoutMeasure,
  type MeasuredElement,
  type MeasuredLabel,
} from "@/lib/checks/screenChecks";

const viewport = { width: 1440, height: 900 };
const consoleRect = { x: 1104, y: 76, width: 320, height: 560 };

function measure(elements: MeasuredElement[], panel = consoleRect): LayoutMeasure {
  return { viewport, panels: [{ name: "console", rect: panel, elements }] };
}

describe("layout", () => {
  it("passes a row inside its panel", () => {
    expect(layoutProblems(measure([{ desc: 'li "layer-card"', rect: { x: 1110, y: 100, width: 300, height: 80 } }]))).toEqual([]);
  });

  it("fails the owner's layer row spilling outside its panel", () => {
    // The climbing row's mode switcher ran 22px past the console's right edge.
    const problems = layoutProblems(measure([{ desc: 'div "mode-control"', rect: { x: 1290, y: 300, width: 156, height: 28 } }]));
    expect(problems).toEqual(['In the console, an element sits outside the panel: div "mode-control" (22px past the right edge).']);
  });

  it("lets content scroll out of view vertically inside a scroller, but not sideways", () => {
    const scroller = { x: 1104, y: 120, width: 320, height: 400 };
    const below = { desc: 'li "layer-card"', rect: { x: 1110, y: 700, width: 300, height: 80 }, scroller };
    expect(layoutProblems(measure([below]))).toEqual([]);
    const wide = { desc: 'li "layer-card"', rect: { x: 1110, y: 700, width: 340, height: 80 }, scroller };
    expect(layoutProblems(measure([wide]))[0]).toMatch(/outside the panel: li "layer-card" \(26px past the right edge\)/);
  });

  it("fails a panel that scrolls sideways", () => {
    const el: MeasuredElement = { desc: 'ol "top-list"', rect: { x: 1110, y: 100, width: 300, height: 200 }, scroll: { scrollWidth: 340, clientWidth: 300, overflowX: "auto" } };
    expect(layoutProblems(measure([el]))).toEqual(['In the console, content is wider than its box and scrolls sideways: ol "top-list" (content 340px wide in a 300px box).']);
  });

  it("fails text cut without an ellipsis or spilling, passes a truncated label with one", () => {
    const rect = { x: 1110, y: 100, width: 120, height: 20 };
    const text = { left: 1110, right: 1290, boxLeft: 1110, boxRight: 1230 };
    const cut: MeasuredElement = { desc: "span (\"Parking spaces within 1 km\")", rect, text: { ...text, overflowX: "hidden", textOverflow: "clip" } };
    const spill: MeasuredElement = { desc: "p (\"Hex labels\")", rect, text: { ...text, overflowX: "visible", textOverflow: "clip" } };
    const ellipsis: MeasuredElement = { desc: "span (\"Informal trails within 500 m\")", rect, text: { ...text, overflowX: "hidden", textOverflow: "ellipsis" } };
    expect(layoutProblems(measure([cut]))).toEqual(['In the console, text does not fit: span ("Parking spaces within 1 km") is cut off without an ellipsis.']);
    expect(layoutProblems(measure([spill]))).toEqual(['In the console, text does not fit: p ("Hex labels") spills 60px out of its box.']);
    expect(layoutProblems(measure([ellipsis]))).toEqual([]);
  });

  it("fails a card label cut even with an ellipsis (the coordinator's \"Flow vs. the period's …\")", () => {
    const rect = { x: 540, y: 430, width: 140, height: 20 };
    const label: MeasuredElement = { desc: 'span ("Flow vs. the period\'s median")', rect, text: { left: 540, right: 720, boxLeft: 540, boxRight: 680, overflowX: "hidden", textOverflow: "ellipsis" } };
    const card: LayoutMeasure = { viewport, panels: [{ name: "card", rect: { x: 526, y: 326, width: 340, height: 560 }, elements: [label] }] };
    expect(layoutProblems(card)).toEqual(['In the card, text does not fit: span ("Flow vs. the period\'s median") is cut off with an ellipsis (40px hidden).']);
  });

  it("fails a panel off the screen and an element off the screen", () => {
    const off = { x: 1300, y: 76, width: 320, height: 500 };
    expect(layoutProblems(measure([], off))).toEqual(["The console runs off the screen (180px past the right edge)."]);
    const tall = { x: 1104, y: 76, width: 320, height: 900 };
    const low: MeasuredElement = { desc: "button (\"Ask about this\")", rect: { x: 1120, y: 880, width: 280, height: 44 } };
    expect(layoutProblems(measure([low], tall))[1]).toBe('In the console, an element runs off the screen: button ("Ask about this") (24px below the bottom).');
  });
});

describe("chat placeholder", () => {
  it("passes a placeholder that fits and is on top", () => {
    expect(placeholderProblems({ text: "Ask about trails, terrain, anywhere…", textWidth: 240, contentWidth: 290, onTop: Array(8).fill(true) })).toEqual([]);
  });

  it("fails the owner's hidden placeholder: covered by the dev tools badge", () => {
    const onTop = [false, false, false, true, true, true, true, true];
    expect(placeholderProblems({ text: "Ask about trails, terrain, anywhere…", textWidth: 240, contentWidth: 290, onTop, coveredBy: "button Open Next.js Dev Tools" })).toEqual([
      'Something covers the chat placeholder "Ask about trails, terrain, anywhere…" (3 of 8 points, under button Open Next.js Dev Tools).',
    ]);
  });

  it("fails a placeholder wider than its input, and a missing input", () => {
    expect(placeholderProblems({ text: "Ask about trails, terrain, anywhere…", textWidth: 262, contentWidth: 214, onTop: Array(8).fill(true) })).toEqual([
      'The chat placeholder "Ask about trails, terrain, anywhere…" is cut off: it needs 262px and the input shows 214px.',
    ]);
    expect(placeholderProblems(null)).toHaveLength(1);
  });
});

describe("map labels", () => {
  const canvas = { x: 0, y: 0, width: 1440, height: 900 };
  const hex = (text: string, width: number, cellPx: number): MeasuredLabel => ({ kind: "hex", layerId: "power-plants", text, width, height: 11, x: 600, y: 400, cellPx });

  it("fails the owner's hex label cut off by its cell, passes one that fits", () => {
    expect(labelProblems([hex("1.5k", 31, 24)], canvas)).toEqual(['power-plants: 1 hex label does not fit the cell, e.g. "1.5k" is 31px wide in a 24px cell.']);
    expect(labelProblems([hex("12", 13, 40)], canvas)).toEqual([]);
  });

  it("fails a symbol label cut by the edge of the map, passes one inside or wholly outside", () => {
    const at = (x: number): MeasuredLabel => ({ kind: "symbol", layerId: "uranium", text: "Jackpile-Paguate", width: 100, height: 11, x, y: 300 });
    expect(labelProblems([at(1420)], canvas)).toEqual(['uranium: 1 symbol label is cut by the edge of the map, e.g. "Jackpile-Paguate".']);
    expect(labelProblems([at(700), at(1700)], canvas)).toEqual([]);
  });
});

describe("line visibility", () => {
  it("judges each level of a line layer colored by levels on its own (Leadville's passenger-car roads on Topo)", () => {
    const labels = new Map([["5", "Passenger car"], ["4", "Passenger car"], ["3", "Passenger car"], ["2", "High clearance"]]);
    // High-clearance roads show and carry the layer's average; the passenger-car ones do not.
    const samples = [..."3333344".split("").map((g) => ({ g })), ..."222222222222".split("").map((g) => ({ g })), {}];
    const diffs = [8, 9, 12, 10, 8, 6, 7, 90, 95, 88, 92, 99, 85, 91, 94, 90, 87, 93, 96, 50];
    expect(lineVisibilityProblem("Forest roads", "Topo", diffs)).toBeNull();
    const { problems, readings } = levelVisibilityProblems("Forest roads", "Topo", samples, diffs, labels);
    expect(problems).toEqual(["Forest roads (Passenger car) lines barely show on Topo: hiding them changes the pixels along them by 8.6 of 255 on average (needs 32)."]);
    expect(readings).toHaveLength(2);
    // A level with under five points on screen is not judged.
    expect(levelVisibilityProblems("Forest roads", "Topo", [{ g: "3" }, { g: "3" }], [1, 2], labels).problems).toEqual([]);
  });

  it("fails the owner's sage trails on green Topo, passes dark trails", () => {
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [6, 9, 12, 10, 8])).toBe(
      "OpenStreetMap trails lines barely show on Topo: hiding them changes the pixels along them by 9.0 of 255 on average (needs 32).",
    );
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [110, 95, 120])).toBeNull();
    // The Tahoe reading at 331355b: most samples on sage over green forest, a few in clearings.
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [15, 22, 23, 26, 32, 43, 52, 26, 22, 15])).not.toBeNull();
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [])).toBeNull();
  });

  it("fails a network whose widest lines carry the average while most of its lines do not show", () => {
    // Three big rivers change a lot; the thin ones on satellite change nothing.
    const diffs = [180, 170, 160, 150, 140, 3, 4, 2, 5, 3, 6, 2];
    expect(lineVisibilityProblem("River flow", "Topo + Satellite", diffs)).toBe(
      "River flow lines mostly do not show on Topo + Satellite: hiding them changes only 42% of the points along them by 32 or more (needs 60%); the widest lines carry the average.",
    );
    expect(lineVisibilityProblem("River flow", "Topo + Satellite", [60, 48, 45, 40, 36, 20, 5])).toBeNull();
  });
});

describe("isOceanDemTile404", () => {
  it("leaves out only 404s from Mapbox's terrain DEM tiles", () => {
    expect(isOceanDemTile404("https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/6/19/25@2x.pngraw?access_token=x", 404)).toBe(true);
    expect(isOceanDemTile404("https://api.mapbox.com/raster/v1/mapbox.mapbox-terrain-dem-v1/7/39/50.png?access_token=x", 404)).toBe(true);
    expect(isOceanDemTile404("https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/6/19/25@2x.pngraw", 500)).toBe(false);
    expect(isOceanDemTile404("https://api.mapbox.com/v4/mapbox.satellite/6/19/25@2x.jpg90", 404)).toBe(false);
    expect(isOceanDemTile404("http://localhost:5600/api/layer/climbing", 404)).toBe(false);
  });
});

describe("console rows", () => {
  const panel = (rows: { id: string; top: number; bottom: number }[]) => ({
    viewport: { width: 1440, height: 900 },
    panels: [{ name: "console", rect: { x: 1104, y: 16, width: 320, height: 640 }, elements: [], rows: { scroller: { top: 316, bottom: 640 }, rows } }],
  });

  it("fails a row scrolled mid-row (the dams row at its opacity slider, Rank by cut off), and passes one shown from its header", () => {
    expect(layoutProblems(panel([{ id: "dams", top: 136, bottom: 640 }]))).toEqual(["In the console, the dams row is scrolled mid-row: its header is 180px above the top of the list."]);
    expect(layoutProblems(panel([{ id: "dams", top: 316, bottom: 820 }]))).toEqual([]);
  });
});


describe("area fills (owner, 2026-10-18: choropleths too faint on satellite)", () => {
  it("holds a choropleth's fill to a higher bar than a tinted, hatched area", () => {
    const faint = [14, 16, 18, 15];
    expect(areaFillProblem("Glaciers", "Satellite", faint)).toBeNull();
    expect(areaFillProblem("Temperature anomaly", "Satellite", faint, true)).toMatch(/fills barely show on Satellite: .* by 15\.8 of 255 .*needs 24/);
    expect(areaFillProblem("Temperature anomaly", "Satellite", [CHOROPLETH_FILL_VISIBLE_DIFF, 50], true)).toBeNull();
    expect(areaFillProblem("Temperature anomaly", "Satellite", [], true)).toBeNull();
  });
});

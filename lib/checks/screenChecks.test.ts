import { describe, expect, it } from "vitest";
import {
  labelProblems,
  layoutProblems,
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
  it("fails the owner's sage trails on green Topo, passes dark trails", () => {
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [6, 9, 12, 10, 8])).toBe(
      "OpenStreetMap trails lines barely show on Topo: hiding them changes the pixels along them by 9.0 of 255 on average (needs 32).",
    );
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [110, 95, 120])).toBeNull();
    // The Tahoe reading at 331355b: most samples on sage over green forest, a few in clearings.
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [15, 22, 23, 26, 32, 43, 52, 26, 22, 15])).not.toBeNull();
    expect(lineVisibilityProblem("OpenStreetMap trails", "Topo", [])).toBeNull();
  });
});

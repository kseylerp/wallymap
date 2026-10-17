import { describe, expect, it } from "vitest";
import { WebMercatorViewport } from "@math.gl/web-mercator";
import { clearInsets, LABEL_EDGE_MARGIN_PX as M, placeLabel, type Bounds } from "@/lib/render/labelPlacement";
import { placeAll } from "@/lib/render/placedLabels";

const phone: Bounds = { left: 0, top: 0, right: 375, bottom: 812 };
const label = (x: number, y: number, width = 100) => ({ x, y, width, height: 11, gap: 20 });
/** The label's box on screen for a point and its offset. */
const box = (x: number, y: number, width: number, [dx, dy]: [number, number]) => ({
  left: x + dx - width / 2,
  right: x + dx + width / 2,
  top: y + dy - 5.5,
  bottom: y + dy + 5.5,
});

describe("ranked labels stay inside the clear map", () => {
  it("sits centered above its symbol away from the edges", () => {
    expect(placeLabel(label(180, 400), phone)).toEqual([0, -20]);
  });

  it("near the right edge, the label moves left so its end stays on screen", () => {
    const at = placeLabel(label(370, 400), phone)!;
    expect(at[0]).toBeLessThan(0);
    expect(box(370, 400, 100, at).right).toBe(375 - M);
    expect(at[1]).toBe(-20);
  });

  it("near the left edge, the label moves right", () => {
    const at = placeLabel(label(10, 400, 120), phone)!;
    expect(at[0]).toBeGreaterThan(0);
    expect(box(10, 400, 120, at).left).toBe(M);
  });

  it("near the top, the label flips below its symbol", () => {
    expect(placeLabel(label(180, 12), phone)).toEqual([0, 20]);
  });

  it("near the bottom, the label stays above its symbol", () => {
    expect(placeLabel(label(180, 808), phone)).toEqual([0, -20]);
  });

  it("in a corner, it moves on both axes", () => {
    const at = placeLabel(label(372, 5), phone)!;
    const b = box(372, 5, 100, at);
    expect(b.right).toBeLessThanOrEqual(375 - M);
    expect(b.top).toBeGreaterThanOrEqual(M);
  });

  it("a label wider than the map is centered in it", () => {
    const at = placeLabel(label(50, 400, 500), phone)!;
    expect(50 + at[0]).toBe(187.5);
  });

  it("is not drawn when its point is off screen or under a panel", () => {
    expect(placeLabel(label(-3, 400), phone)).toBeNull();
    expect(placeLabel(label(180, 900), phone)).toBeNull();
    const clear: Bounds = { left: 0, top: 56, right: 375, bottom: 740 };
    expect(placeLabel(label(180, 760), clear)).toBeNull();
    // Just inside the clear part, under the top bar's edge: below the symbol instead.
    expect(placeLabel(label(180, 60), clear)).toEqual([0, 20]);
  });

  it("holds at desktop size with a chat panel on the left and the layer panel on the right", () => {
    const clear: Bounds = { left: 452, top: 64, right: 1088, bottom: 900 };
    const at = placeLabel(label(1080, 300, 140), clear)!;
    expect(box(1080, 300, 140, at).right).toBe(1088 - M);
    expect(placeLabel(label(300, 300), clear)).toBeNull();
  });
});

describe("placing a ranked view's labels on a phone map", () => {
  // West Texas at 375×812: one wind farm near each side edge, one in the middle, one off screen to the east.
  const viewport = new WebMercatorViewport({ width: 375, height: 812, longitude: -101.5, latitude: 32.25, zoom: 6.4 });
  type Farm = { name: string; at: [number, number] };
  const edge = viewport.unproject([372, 300]) as [number, number];
  const west = viewport.unproject([3, 500]) as [number, number];
  const farms: Farm[] = [
    { name: "Graham", at: edge },
    { name: "Section 16 deposit", at: west },
    { name: "Roscoe", at: [-101.5, 32.25] },
    { name: "Far away", at: [-90, 32.25] },
  ];
  const placed = placeAll(farms, {
    canvas: { width: 375, height: 812 },
    project: (p) => viewport.project(p),
    getPosition: (f) => f.at,
    getText: (f) => f.name,
    getGap: () => 20,
    size: 11,
    measure: (text) => text.length * 6.6,
  });

  it("keeps every label whose point is on screen fully inside it", () => {
    expect(placed.data.map((f) => f.name)).toEqual(["Graham", "Section 16 deposit", "Roscoe"]);
    for (const f of placed.data) {
      const [x, y] = viewport.project(f.at);
      const b = box(x, y, f.name.length * 6.6, placed.offsets.get(f)!);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(375);
    }
    expect(placed.offsets.get(farms[0])![0]).toBeLessThan(0);
    expect(placed.offsets.get(farms[1])![0]).toBeGreaterThan(0);
    expect(placed.offsets.get(farms[2])).toEqual([0, -20]);
  });
});

describe("the clear map between floating panels", () => {
  it("insets each panel from the side that leaves more map", () => {
    const desktop = { width: 1440, height: 900 };
    const chat = { left: 16, top: 72, right: 436, bottom: 884 };
    const layers = { left: 1104, top: 72, right: 1424, bottom: 884 };
    const bar = { left: 0, top: 0, right: 1440, bottom: 56 };
    expect(clearInsets(desktop, [bar, chat, layers])).toEqual({ top: 56, right: 336, bottom: 0, left: 436 });
  });

  it("insets a phone's bottom sheet from the bottom and ignores what is off the canvas", () => {
    const sheet = { left: 0, top: 438, right: 375, bottom: 812 };
    const away = { left: 400, top: 0, right: 700, bottom: 300 };
    expect(clearInsets({ width: 375, height: 812 }, [sheet, away])).toEqual({ top: 0, right: 0, bottom: 374, left: 0 });
  });
});

describe("labels on a tilted map", () => {
  it("keep the wider margin they are given (drawn lifted onto terrain, they shift near the edges)", () => {
    const placed = placeAll([{ p: [0, 0] as [number, number], text: "Left Flank" }], {
      canvas: { width: 1440, height: 900 },
      project: () => [16, 500],
      getPosition: (d) => d.p,
      getText: (d) => d.text,
      getGap: () => 10,
      size: 11,
      measure: () => 54,
      margin: 24,
    });
    const [dx] = placed.offsets.values().next().value as [number, number];
    expect(16 + dx - 27).toBeGreaterThanOrEqual(24);
  });
});

import { describe, expect, it } from "vitest";
import { rowScrollTop, rowsCutAtTop } from "./consoleScroll";

const scroller = { top: 310, bottom: 640 };

describe("console scroll", () => {
  it("brings a row whose header is above the visible area to the top (the dams row scrolled to its opacity slider)", () => {
    // The dams row starts 180px above the list's top: Rank by and its header are cut off.
    expect(rowScrollTop(scroller, 400, { top: 130, bottom: 640 })).toBe(220);
  });

  it("brings a row below the visible area to the top, and leaves a row whose header shows", () => {
    expect(rowScrollTop(scroller, 0, { top: 700, bottom: 900 })).toBe(390);
    expect(rowScrollTop(scroller, 120, { top: 330, bottom: 900 })).toBeNull();
    expect(rowScrollTop(scroller, 0, { top: 310, bottom: 500 })).toBeNull();
  });

  it("finds a row cut mid-row at the top, not one scrolled wholly away or shown from its header", () => {
    const cut = { name: "Dams", top: 130, bottom: 640 };
    const away = { name: "Rivers", top: 0, bottom: 300 };
    const whole = { name: "Lakes", top: 310, bottom: 600 };
    expect(rowsCutAtTop(scroller, [away, cut, whole])).toEqual([cut]);
    expect(rowsCutAtTop(scroller, [away, whole])).toEqual([]);
  });
});

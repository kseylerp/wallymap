import { describe, expect, it } from "vitest";
import { CLOSE_BELOW_PEEK, releaseSnap, sheetHeights } from "@/components/PhoneSheet";

describe("the phone layer sheet's snaps", () => {
  const h = sheetHeights(844, 98);

  it("peeks, halves and fills up to the map pills", () => {
    expect(h).toEqual({ peek: 168, half: 464, full: 746 });
    const small = sheetHeights(667, 98);
    expect(small.half).toBeLessThan(small.full);
    expect(small.peek).toBeLessThan(small.half);
  });

  it("lands on the nearest snap, moves on along a fling, and closes when dragged or flung down from peek", () => {
    expect(releaseSnap(500, 0, h)).toBe("half");
    expect(releaseSnap(700, 0, h)).toBe("full");
    expect(releaseSnap(200, 0, h)).toBe("peek");
    expect(releaseSnap(500, -1.2, h)).toBe("full");
    expect(releaseSnap(500, 1.2, h)).toBe("half");
    expect(releaseSnap(h.peek - CLOSE_BELOW_PEEK - 1, 0, h)).toBe("close");
    expect(releaseSnap(h.peek, 1, h)).toBe("close");
  });
});

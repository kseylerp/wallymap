import { describe, expect, it } from "vitest";
import { bboxToViewport } from "@/lib/render/deck";
import { visibleMapPadding } from "@/lib/render/viewportPadding";

describe("visibleMapPadding", () => {
  it("clears the open desktop panel on the left and the header on top", () => {
    expect(visibleMapPadding({ width: 1440, height: 900, panelOpen: true, isMobile: false })).toEqual({
      top: 104,
      right: 96,
      bottom: 40,
      left: 476,
    });
  });

  it("clears the input pill instead of the panel when the desktop panel is closed", () => {
    expect(visibleMapPadding({ width: 1440, height: 900, panelOpen: false, isMobile: false })).toEqual({
      top: 104,
      right: 96,
      bottom: 112,
      left: 40,
    });
  });

  it("clears the 46vh bottom sheet on phones", () => {
    expect(visibleMapPadding({ width: 390, height: 844, panelOpen: true, isMobile: true })).toEqual({
      top: 104,
      right: 40,
      bottom: 40 + Math.round(844 * 0.46),
      left: 40,
    });
  });

  it("shrinks padding on a tiny canvas so fitBounds still has room", () => {
    const p = visibleMapPadding({ width: 500, height: 300, panelOpen: true, isMobile: false });
    expect(500 - p.left - p.right).toBeGreaterThanOrEqual(120);
    expect(300 - p.top - p.bottom).toBeGreaterThanOrEqual(120);
    expect(() => bboxToViewport([-120.2, 38.85, -120.0, 39.0], 500, 300, p)).not.toThrow();
  });
});

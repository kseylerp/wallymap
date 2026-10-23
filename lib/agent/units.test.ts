import { describe, expect, it } from "vitest";
import { inUS, usSpeeds, usSpeedsDeep } from "@/lib/agent/units";

describe("usSpeeds", () => {
  it("puts mph first for wind and knots for currents, keeping m/s second", () => {
    expect(usSpeeds("weakest 10.7 m/s, strongest 13.4 m/s", "wind-flow")).toBe("weakest 24 mph (10.7 m/s), strongest 30 mph (13.4 m/s)");
    expect(usSpeeds("up to 1.2 m/s", "ocean-currents")).toBe("up to 2.3 knots (1.2 m/s)");
    // Already converted text is left alone.
    expect(usSpeeds("24 mph (10.7 m/s)", "wind-flow")).toBe("24 mph (10.7 m/s)");
    expect(usSpeedsDeep({ caption: "now 13.2 m/s", stats: { max: 13.2 } }, "wind-flow")).toEqual({ caption: "now 30 mph (13.2 m/s)", stats: { max: 13.2 } });
  });

  it("knows a US place from its box", () => {
    expect(inUS([-116.71, 33.45, -115.26, 34.13])).toBe(true);
    expect(inUS([6.8, 45.8, 7.0, 46.0])).toBe(false);
    expect(inUS([-150, 60, -149, 61])).toBe(true);
  });
});

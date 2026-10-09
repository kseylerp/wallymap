import { afterEach, describe, expect, it, vi } from "vitest";
import { basemapStyleUrl } from "@/lib/render/basemaps";

const OUTDOORS = "mapbox://styles/mapbox/outdoors-v12";

describe("basemapStyleUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps outdoors-satellite to the Outdoors style (imagery is added on style load)", () => {
    expect(basemapStyleUrl("outdoors-satellite")).toBe(OUTDOORS);
  });

  it("maps outdoors to the Mapbox Outdoors style", () => {
    expect(basemapStyleUrl("outdoors")).toBe(OUTDOORS);
  });

  it("maps satellite to the Mapbox Satellite Streets style", () => {
    expect(basemapStyleUrl("satellite")).toBe("mapbox://styles/mapbox/satellite-streets-v12");
  });

  it("uses NEXT_PUBLIC_NATURAL_EARTH_STYLE for natural-earth-2 when set", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", "mapbox://styles/someone/natural-earth-2");
    expect(basemapStyleUrl("natural-earth-2")).toBe("mapbox://styles/someone/natural-earth-2");
  });

  it("falls back to outdoors for natural-earth-2 when the env var is blank", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", "");
    expect(basemapStyleUrl("natural-earth-2")).toBe(OUTDOORS);
  });

  it("falls back to outdoors for natural-earth-2 when the env var is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_NATURAL_EARTH_STYLE", undefined);
    expect(basemapStyleUrl("natural-earth-2")).toBe(OUTDOORS);
  });
});

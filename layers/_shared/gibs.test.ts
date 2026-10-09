import { describe, expect, it } from "vitest";
import { gibsTileUrl } from "./gibs";

describe("gibsTileUrl", () => {
  it("builds a WMTS template with the layer, date and level", () => {
    expect(gibsTileUrl("MODIS_Terra_CorrectedReflectance_TrueColor", "2026-10-01", 9)).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-10-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
    );
  });
});

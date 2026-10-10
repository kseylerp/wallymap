import { describe, expect, it } from "vitest";
import { wmsTileUrl } from "./wms";

describe("wmsTileUrl", () => {
  it("builds a 1.3.0 GetMap template with the bbox placeholder and no time", () => {
    expect(wmsTileUrl("https://example.org/wms", "a:b")).toBe(
      "https://example.org/wms?service=WMS&version=1.3.0&request=GetMap&layers=a:b&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}",
    );
  });

  it("uses srs for 1.1.1, keeps a time placeholder and joins to an existing query string", () => {
    const url = wmsTileUrl("https://example.org/wms?map=x", "l", { version: "1.1.1", time: "{date}", size: 512 });
    expect(url).toContain("wms?map=x&service=WMS&version=1.1.1");
    expect(url).toContain("&srs=EPSG:3857&width=512&height=512&");
    expect(url.endsWith("&time={date}")).toBe(true);
  });
});

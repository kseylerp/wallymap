import { describe, expect, it } from "vitest";
import { imageServerExportTileUrl, mapServerExportTileUrl } from "./arcgis-tiles";

describe("arcgis tile URL templates", () => {
  it("builds a MapServer export template with the Mapbox bbox token left in place", () => {
    const url = mapServerExportTileUrl("https://example.com/arcgis/rest/services/x/MapServer", { layers: "show:28" });
    expect(url).toBe(
      "https://example.com/arcgis/rest/services/x/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&transparent=true&layers=show:28",
    );
  });

  it("omits layers unless asked and honours the tile size", () => {
    const url = mapServerExportTileUrl("https://example.com/MapServer", { tileSize: 512 });
    expect(url).toContain("size=512,512");
    expect(url).not.toContain("layers=");
  });

  it("builds an ImageServer exportImage template with no-data handling", () => {
    const url = imageServerExportTileUrl("https://example.com/ImageServer", { noData: 0 });
    expect(url).toBe(
      "https://example.com/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&interpolation=RSP_NearestNeighbor&noData=0&noDataInterpretation=esriNoDataMatchAny",
    );
    expect(imageServerExportTileUrl("https://example.com/ImageServer")).not.toContain("noData");
  });
});

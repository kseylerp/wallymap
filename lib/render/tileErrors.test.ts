import { afterEach, describe, expect, it } from "vitest";
import type { MapState } from "@/lib/render/state";
import { hasMissingImage, missingTilesStore, noteTile, resetTileNotes } from "@/lib/render/tileErrors";

const SNOW = "https://gibs.test/snow/2026-09-10/{z}/{y}/{x}.png";
const tiles = (url: string, dated = true): MapState["layers"][string] => ({
  id: "snow",
  title: "Snow",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "tiles",
    data: { url, format: "raster", ...(dated && { time: { template: url, cadence: "daily", from: "2026-08-01" } }) },
    citation: { source: "s", url: "u", retrieved: "r" },
  } as MapState["layers"][string]["result"],
  receivedAt: "now",
});

describe("missing tile images", () => {
  afterEach(resetTileNotes);

  it("marks a template missing when its tiles fail and none load", () => {
    noteTile(SNOW, false);
    noteTile(SNOW, false);
    expect(missingTilesStore.get().has(SNOW)).toBe(true);
    expect(hasMissingImage({ snow: tiles(SNOW) }, missingTilesStore.get())).toBe(true);
    // Another date of the same layer is not affected.
    expect(hasMissingImage({ snow: tiles(SNOW.replace("09-10", "09-09")) }, missingTilesStore.get())).toBe(false);
    // A layer without a time series never says "no image".
    expect(hasMissingImage({ snow: tiles(SNOW, false) }, missingTilesStore.get())).toBe(false);
  });

  it("does not count one failed edge tile among loaded ones", () => {
    noteTile(SNOW, true);
    noteTile(SNOW, false);
    expect(missingTilesStore.get().size).toBe(0);
    const other = SNOW.replace("09-10", "09-01");
    noteTile(other, false);
    expect(missingTilesStore.get().has(other)).toBe(true);
    noteTile(other, true);
    expect(missingTilesStore.get().has(other)).toBe(false);
  });
});

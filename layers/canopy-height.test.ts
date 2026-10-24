import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { EE_TILE_LAYERS } from "@/lib/ee/tiles";
import { heightColor, PALETTE, readStats } from "@/lib/ee/canopyHeight";
import { fakeEeFetch, testEnv } from "@/lib/ee/__fixtures__/fakeEe";
import recorded from "@/lib/ee/__fixtures__/living-cover.json";
import { OFF_WHITE, PURPLE, SAGE } from "@/lib/render/palette";
import { hexToRgb, rgbToOklch } from "@/lib/render/ramp";
import layer, { heightText, LEGEND, statsSentence } from "./canopy-height";
import { contractProblems, legendOf } from "./contract";
import type { LayerResult } from "./types";

const HOOD: [number, number, number, number] = [-121.95, 45.2, -121.5, 45.5];

function ctx(bbox = HOOD) {
  return { bbox, zoom: 10, env: testEnv(), fetch: vi.fn() as unknown as CachedFetch };
}

describe("canopy-height layer", () => {
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
    const fake = fakeEeFetch({ compute: (expression) => (JSON.stringify(expression).includes("Reducer.percentile") ? recorded.canopyStatsHood : { cover_code: 28 }) });
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("declares the contract and a ramp key in metres and feet, off-white to sage to purple", () => {
    expect(contractProblems(layer)).toEqual([]);
    const key = legendOf(layer);
    expect(key.kind).toBe("ramp");
    expect(key.stops?.map((s) => s.label)).toEqual(["Under 5 m (16 ft)", "15 m (49 ft)", "30 m (98 ft)", "40 m (131 ft)", "50 m (164 ft) and taller"]);
    expect(heightColor(2)).toBe(OFF_WHITE);
    expect(heightColor(30)).toBe(SAGE);
    expect(heightColor(80)).toBe(PURPLE);
    expect(PALETTE).toHaveLength(51);
    // Sage to purple stays in their family: no cyan or blue-green on the way (hue between sage's and purple's, chroma low).
    for (const m of [33, 36, 40, 44]) {
      const [, c] = rgbToOklch(hexToRgb(heightColor(m)));
      expect(c).toBeLessThan(0.2);
    }
    expect(LEGEND.title).toBe("Canopy height");
  });

  it("states median, 90th percentile and tallest canopy in feet first in the US, with the tree share and the place", async () => {
    const r = (await layer.query(ctx(), layer.input.parse({ place: "Mount Hood" }))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(r.data.url).toBe("/api/ee/tiles/canopy-height/{z}/{x}/{y}?view=height&v=1");
    expect(r.coverageNote).toBe(
      "Meta and WRI canopy height (1 m, imagery mostly 2018 to 2020) in the box asked for Mount Hood: trees (canopy 16 ft (5 m) or taller) cover 83% of the box; " +
        "their canopy is median 56 ft (17 m) tall, 90th percentile 79 ft (24 m), tallest reading 128 ft (39 m) (heights read on a 59 m grid). The model reads low in very tall forest",
    );
    expect(EE_TILE_LAYERS["canopy-height"].picture(new URLSearchParams("view=height&v=1"))).not.toBeNull();
  });

  it("reads metres first outside the US and says when there are no trees", () => {
    expect(heightText(21, false)).toBe("21 m (69 ft)");
    expect(statsSentence({ medianM: null, p90M: null, maxM: null, treeShare: 0 }, false, 100)).toMatch(/^no trees 5 m \(16 ft\) or taller/);
    expect(readStats({ treeShare: 0.2, h_p50: null, h_p90: null, h_p100: null })).toEqual({ medianM: null, p90M: null, maxM: null, treeShare: 0.2 });
  });

  it("reads the height at a tapped point", async () => {
    const f = await layer.identify!(ctx(), { lon: -121.8, lat: 45.3 }, layer.input.parse({}));
    expect(f && "properties" in f && f.properties).toMatchObject({ name: "Trees 92 ft (28 m) tall", heightM: 28 });
  });
});

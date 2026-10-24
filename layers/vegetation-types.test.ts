import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { EE_TILE_LAYERS } from "@/lib/ee/tiles";
import { EVT_CLASSES, GROUPS, readShares } from "@/lib/ee/vegetation";
import { fakeEeFetch, functionNames, testEnv } from "@/lib/ee/__fixtures__/fakeEe";
import recorded from "@/lib/ee/__fixtures__/living-cover.json";
import { isPaletteColor } from "@/lib/render/palette";
import layer, { classesSentence, groupsSentence, LEGEND } from "./vegetation-types";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import type { LayerResult } from "./types";

const SMOKIES: [number, number, number, number] = [-84.0, 35.42, -83.1, 35.8];

function ctx(bbox = SMOKIES) {
  return { bbox, zoom: 10, env: testEnv(), fetch: vi.fn() as unknown as CachedFetch };
}

describe("vegetation-types layer", () => {
  let fake: ReturnType<typeof fakeEeFetch>;
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
    fake = fakeEeFetch({
      compute: (expression) => (JSON.stringify(expression).includes("frequencyHistogram") ? recorded.evtSharesSmokies : recorded.evtPointClingmans),
    });
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("declares the contract: US land, no time, an eight-group key in palette-derived colors", () => {
    expect(layer.coverage).toBe("us");
    expect(contractProblems(layer)).toEqual([]);
    expect(timeShapeOf(layer).shape).toBe("none");
    const items = legendOf(layer).items ?? [];
    expect(items).toHaveLength(8);
    expect(items[0].label).toBe("Conifer forest and woodland");
    expect(GROUPS.find((g) => g.key === "water")!.color).toBe("#6E5BFF");
    expect(GROUPS.find((g) => g.key === "hardwood")!.color).toBe("#9FB693");
    expect(isPaletteColor(GROUPS.find((g) => g.key === "developed")!.color)).toBe(true);
    expect(layer.license).toMatch(/Public domain.*LANDFIRE/);
  });

  it("keeps all 849 LANDFIRE classes, each in one of the eight groups", () => {
    expect(EVT_CLASSES.size).toBe(849);
    const keys = new Set(GROUPS.map((g) => g.key));
    for (const c of EVT_CLASSES.values()) expect(keys.has(c.group), c.name).toBe(true);
    expect(EVT_CLASSES.get(3350)).toMatchObject({ name: "Central and Southern Appalachian Spruce-Fir Forest", group: "conifer" });
    expect(EVT_CLASSES.get(3080)?.group).toBe("shrub");
    expect(EVT_CLASSES.get(3292)?.group).toBe("water");
  });

  it("draws the groups through our tile route and states the named types' and groups' shares for the place", async () => {
    const r = (await layer.query(ctx(), layer.input.parse({ place: "Great Smoky Mountains" }))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(r.kind).toBe("tiles");
    expect(r.data.url).toBe("/api/ee/tiles/vegetation-types/{z}/{x}/{y}?view=groups&v=1");
    expect(r.coverageNote).toMatch(/^LANDFIRE 1\.4\.0 \(about 2014\), share of the mapped land in the box asked for Great Smoky Mountains/);
    expect(r.coverageNote).toMatch(/Southern and Central Appalachian Cove Forest 34%, Southern Appalachian Oak Forest 29%/);
    expect(r.coverageNote).toMatch(/Central and Southern Appalachian Spruce-Fir Forest 4%/);
    expect(r.coverageNote).toMatch(/by group hardwood and mixed forest 80%/);
    expect(r.legend).toBe(LEGEND);
    const picture = EE_TILE_LAYERS["vegetation-types"].picture(new URLSearchParams("view=groups&v=1"));
    expect(picture && functionNames(picture.image)).toContain("Image.remap");
    expect(EE_TILE_LAYERS["vegetation-types"].picture(new URLSearchParams("view=other"))).toBeNull();
  });

  it("refuses a box outside the lower 48 without asking Earth Engine", async () => {
    const r = await layer.query(ctx([117.6, 4.8, 118.0, 5.1]), layer.input.parse({}));
    expect(r).toMatchObject({ error: expect.stringMatching(/lower 48/) });
    expect(fake.calls.filter((c) => c.url.endsWith("/value:compute"))).toHaveLength(0);
  });

  it("gives the legend each group's share of the view and a tap the type's own name", async () => {
    const shares = await layer.viewShares!(ctx(), {}, layer.input.parse({}));
    expect(shares).toMatchObject({ field: "group" });
    const s = (shares as { shares: Record<string, number> }).shares;
    expect(s["2"]).toBeCloseTo(0.8, 1);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    const f = await layer.identify!(ctx(), { lon: -83.4985, lat: 35.5628 }, layer.input.parse({}));
    expect(f && "properties" in f && f.properties).toMatchObject({
      name: "Central and Southern Appalachian Spruce-Fir Forest",
      groupLabel: "Conifer forest and woodland",
      lifeForm: "Conifer",
      map: "LANDFIRE 1.4.0 (about 2014)",
    });
  });

  it("writes the shares in words: names with whole percents, groups largest first", () => {
    const shares = readShares(recorded.evtSharesBend)!;
    expect(classesSentence(shares)).toMatch(/^Northern Rocky Mountain Ponderosa Pine Woodland and Savanna 22%, Inter-Mountain Basins Big Sagebrush Steppe 17%/);
    expect(classesSentence(shares)).toMatch(/Columbia Plateau Western Juniper Woodland and Savanna 6%/);
    expect(groupsSentence(shares)).toMatch(/^conifer forest and woodland 35%, shrubland 33%/);
    expect(readShares({ EVT: { "0": 10 } })).toBeNull();
  });
});

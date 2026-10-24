import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { EE_TILE_LAYERS } from "@/lib/ee/tiles";
import { EVT_CLASSES, GROUPS, parseTypesQuery, readShares, topTypes, typeColors } from "@/lib/ee/vegetation";
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

  it("draws the largest named types through our tile route and states the named types' and groups' shares for the place", async () => {
    const r = (await layer.query(ctx(), layer.input.parse({ place: "Great Smoky Mountains" }))) as Extract<LayerResult, { kind: "tiles" }>;
    expect(r.kind).toBe("tiles");
    const top = topTypes(readShares(recorded.evtSharesSmokies)!).map((c) => c.value);
    expect(top.length).toBeGreaterThanOrEqual(5);
    expect(r.data.url).toBe(`/api/ee/tiles/vegetation-types/{z}/{x}/{y}?view=types&v=2&c=${top.join(",")}`);
    expect(r.coverageNote).toMatch(/^LANDFIRE 1\.4\.0 \(about 2014\), share of the mapped land in the box asked for Great Smoky Mountains/);
    expect(r.coverageNote).toMatch(/Southern and Central Appalachian Cove Forest 34%, Southern Appalachian Oak Forest 29%/);
    expect(r.coverageNote).toMatch(/Central and Southern Appalachian Spruce-Fir Forest 4%/);
    expect(r.coverageNote).toMatch(/by group hardwood and mixed forest 80%/);
    // The key names the colored types in LANDFIRE's words, spruce-fir in a deep conifer sage, the rest under one entry.
    const items = r.legend?.items ?? [];
    expect(r.legend).toMatchObject({ title: "Vegetation type", field: "evt" });
    expect(items.map((i) => i.label)).toContain("Southern Appalachian Oak Forest");
    expect(items.map((i) => i.label)).toContain("Central and Southern Appalachian Spruce-Fir Forest");
    expect(items[items.length - 1].label).toMatch(/^Other types/);
    expect(new Set(items.map((i) => i.color)).size).toBe(items.length);
    expect(LEGEND.items).toHaveLength(8);
    const picture = EE_TILE_LAYERS["vegetation-types"].picture(new URLSearchParams(r.data.url.split("?")[1]));
    expect(picture && functionNames(picture.image)).toContain("Image.remap");
    expect(EE_TILE_LAYERS["vegetation-types"].picture(new URLSearchParams("view=groups&v=1"))).not.toBeNull();
    expect(EE_TILE_LAYERS["vegetation-types"].picture(new URLSearchParams("view=other"))).toBeNull();
  });

  it("refuses a types picture with codes outside LANDFIRE's table, repeated or too many", () => {
    expect(parseTypesQuery(new URLSearchParams("view=types&v=2&c=3350,3080"))).toEqual([3350, 3080]);
    expect(parseTypesQuery(new URLSearchParams("view=types&v=2&c=3350,3350"))).toBeNull();
    expect(parseTypesQuery(new URLSearchParams("view=types&v=2&c=9999"))).toBeNull();
    expect(parseTypesQuery(new URLSearchParams("view=types&v=2&c=33a0"))).toBeNull();
    expect(parseTypesQuery(new URLSearchParams(`view=types&v=2&c=${[...EVT_CLASSES.keys()].slice(0, 8).join(",")}`))).toBeNull();
  });

  it("gives each colored type its own palette-derived color: conifer deep sage, water purple", () => {
    const pick = (...codes: number[]) => codes.map((c) => EVT_CLASSES.get(c)!);
    const [spruce, shrub, water] = typeColors(pick(3350, 3080, 3292));
    expect(spruce).toBe(GROUPS.find((g) => g.key === "conifer")!.color);
    expect(water).toBe("#6E5BFF");
    expect(shrub).not.toBe(spruce);
  });

  it("refuses a box outside the lower 48 without asking Earth Engine", async () => {
    const r = await layer.query(ctx([117.6, 4.8, 118.0, 5.1]), layer.input.parse({}));
    expect(r).toMatchObject({ error: expect.stringMatching(/lower 48/) });
    expect(fake.calls.filter((c) => c.url.endsWith("/value:compute"))).toHaveLength(0);
  });

  it("gives the legend each type's share of the view and a tap the type's own name", async () => {
    const shares = await layer.viewShares!(ctx(), {}, layer.input.parse({}));
    expect(shares).toMatchObject({ field: "evt" });
    const s = (shares as { shares: Record<string, number> }).shares;
    expect(s["3350"]).toBeCloseTo(0.04, 1);
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

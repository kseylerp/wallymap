import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import { ROCK_FAMILY_FIELD, ROCK_TYPE_FIELD } from "@/lib/render/rockFamily";
import { ROCK_TYPE_COLORS } from "@/lib/render/palette";
import layer, { GEOLOGY_SOURCE_LAYER, GEOLOGY_TILE_URL, gridPoints, rockWords, unitsNote, type SampledUnit } from "./geology";
import fixture from "./__fixtures__/geologic-unit.tahoe.json";

const BBOX: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.0];

describe("geology layer", () => {
  it("declares global coverage, no env, no area cap, no input and a plain polygon style", () => {
    expect(layer.id).toBe("geology");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toContain("CC BY 4.0");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "polygon" });
    expect(layer.style).not.toHaveProperty("fillOpacity");
  });

  it("hands the map the vector tiles and samples the box's units on a 6 by 6 grid of points", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query({ bbox: BBOX, zoom: 12, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(r).toMatchObject({
      kind: "tiles",
      data: {
        url: "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt",
        minzoom: 0,
        maxzoom: 16,
        format: "vector",
        sourceLayer: "units",
        geometry: "polygon",
      },
    });
    expect(GEOLOGY_TILE_URL).toContain("{z}/{x}/{y}");
    expect(GEOLOGY_SOURCE_LAYER).toBe("units");
    expect(stub).toHaveBeenCalledTimes(36);
    const [url, init] = stub.mock.calls[0] as unknown as [string, { cacheKey?: string; headers?: Record<string, string> }];
    expect(url).toBe("https://macrostrat.org/api/v2/geologic_units/map?lat=38.81667&lng=-120.16667");
    expect(init.cacheKey).toBe("geology:point:38.81667,-120.16667");
    expect(init.headers?.["user-agent"]).toContain("WallyMap");
    if (!("kind" in r)) throw new Error("expected a result");
    // Every point answers the Tahoe fixture: its most detailed unit is Till.
    expect(r.coverageNote).toContain("Till: ");
    expect(r.coverageNote).toContain("Pleistocene, 11,700 to 2.6 million years; about 100% of sampled points");
    expect(r.coverageNote).toContain("By rock family: loose sediment about 100%");
  });

  it("spreads the grid's points over the box, south-west first", () => {
    const pts = gridPoints([0, 0, 6, 3]);
    expect(pts).toHaveLength(36);
    expect(pts[0]).toEqual([0.5, 0.25]);
    expect(pts[35]).toEqual([5.5, 2.75]);
  });

  it("notes the main units by name with rocks, ages, formations and shares, and the rock families", () => {
    const navajo: SampledUnit = {
      name: "Navajo Sandstone",
      strat_name: "Navajo Sandstone",
      lith: "",
      descrip: "White, pink, and brown sandstone; forms cliffs",
      t_int_name: "Early Jurassic",
      b_int_name: "Early Jurassic",
      t_age: 166.65,
      b_age: 180.55,
      scale: "large",
      family: "sedimentary",
    };
    const kayenta: SampledUnit = {
      name: "Navajo Sandstone, Kayenta and Moenave Formations",
      strat_name: "Navajo Sandstone; Kayenta Formation; Moenave Formation",
      lith: "Major:{arenite,sandstone mudstone}, Incidental:{limestone}",
      t_int_name: "Middle Jurassic",
      b_int_name: "Early Jurassic",
      t_age: 166.65,
      b_age: 201.3,
      scale: "medium",
      family: "sedimentary",
    };
    const alluvium: SampledUnit = { name: "Alluvium", lith: "alluvium", t_int_name: "Holocene", b_int_name: "Holocene", t_age: 0, b_age: 0.0117, scale: "large", family: "unconsolidated" };
    const note = unitsNote([navajo, navajo, navajo, kayenta, alluvium, null], 6);
    expect(note).toContain("from 5 points sampled on a 6 by 6 grid (1 of 6 points did not answer)");
    expect(note).toContain("Navajo Sandstone: white, pink, and brown sandstone; Early Jurassic, 167 to 181 million years; about 60% of sampled points");
    expect(note).toContain("(formations: Navajo Sandstone, Kayenta Formation, Moenave Formation): ");
    expect(note).toContain("Early Jurassic to Middle Jurassic, 167 to 201 million years; about 20%");
    expect(note).toContain("By rock family: sedimentary about 80% and loose sediment about 20%");
    expect(note).toContain("faults");
    expect(unitsNote([null], 1)).toMatch(/no geologic map unit/);
    const tongue: SampledUnit = { name: "Kayenta Formation, Tenney Canyon Tongue", lith: "", descrip: "(Mapped as single line where thin.) Red sandstone and siltstone.", t_age: 180.55, b_age: 190.8, family: "sedimentary" };
    expect(rockWords(tongue)).toBe("red sandstone and siltstone");
  });

  it("does not sample a continent-sized box", async () => {
    const stub = vi.fn();
    const r = await layer.query({ bbox: [-170, -60, 170, 70], zoom: 2, env: {}, fetch: stub as unknown as CachedFetch }, {});
    expect(stub).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: "tiles" });
  });

  it("pairs an area with geologic-unit at its centre (the card), and names the faults layer", () => {
    expect(layer.description).toContain("geologic-unit at the place's centre");
    expect(layer.description).toContain("plus faults when faults are asked");
    expect(layer.description).toMatch(/AREA/);
    expect(layer.description).not.toMatch(/colou?red by|per-unit colou?r|each polygon/i);
  });

  it("accepts any size of view through runLayer (tiles need no area cap)", async () => {
    const r = await runLayer("geology", { bbox: [-170, -60, 170, 70] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "tiles" });
  });

  it("keys units by rock type in geologic-map colors, filters by rock family and age, with a card for a tapped unit", () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", title: "Rock type", field: ROCK_TYPE_FIELD });
    expect(legend.items?.find((i) => i.value === "sandstone")?.color).toBe(ROCK_TYPE_COLORS.sandstone);
    expect(legend.items?.find((i) => i.value === "limestone")?.color).toBe(ROCK_TYPE_COLORS.limestone);
    expect(layer.style.encode).toBeUndefined();
    expect(layer.attributes?.map((a) => a.key)).toEqual([ROCK_FAMILY_FIELD, "best_age_top"]);
    expect(layer.card?.facts?.map((f) => f.key)).toEqual(["rock_type_label", "age", "age_span", "descrip"]);
    expect(contractProblems(layer)).toEqual([]);
  });

  it("cards a tapped unit without the coded rock list, the repeated ages or a raw 'Ref url' row", () => {
    // A unit shaped like those in Macrostrat's carto tiles (the property names the tiles carry).
    const unit = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-120, 39] },
      properties: {
        map_id: 1234,
        source_id: 7,
        legend_id: 44707,
        name: "Colluvium",
        age: "Holocene",
        lith: "Major:{unconsolidated colluvium}",
        descrip: "Unsorted slope debris.",
        best_age_top: 0,
        best_age_bottom: 0.0117,
        t_int: 1,
        b_int: 1,
        color: "#FFF8DC",
        ref_url: "https://ngmdb.usgs.gov/Prodesc/proddesc_1234.htm",
      },
    };
    const card = cardContent(unit, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((r) => [r.label, r.value])).toEqual([
      ["Age", "Holocene"],
      ["Description", "Unsorted slope debris."],
    ]);
    expect(card.details).toEqual([]);
    expect(card.links).toEqual([{ key: "ref_url", label: "Source map", url: "https://ngmdb.usgs.gov/Prodesc/proddesc_1234.htm" }]);
  });
});

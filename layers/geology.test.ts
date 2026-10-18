import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import layer, { ERAS, GEOLOGY_SOURCE_LAYER, GEOLOGY_TILE_URL } from "./geology";

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

  it("hands the map the vector tiles and makes no upstream call", async () => {
    const stub = vi.fn();
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
    expect(stub).not.toHaveBeenCalled();
  });

  it("points 'what rock is here' questions at geologic-unit and does not claim per-unit colours", () => {
    expect(layer.description).toContain("geologic-unit");
    expect(layer.description).toContain("lon and lat");
    expect(layer.description).not.toMatch(/colou?red by|per-unit colou?r|each polygon/i);
  });

  it("accepts any size of view through runLayer (tiles need no area cap)", async () => {
    const r = await runLayer("geology", { bbox: [-170, -60, 170, 70] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "tiles" });
  });

  it("fills units by the era of their youngest rock with a stepped legend and a card for a tapped unit", () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "ramp", field: "best_age_top", unit: "million years" });
    expect(legend.stops?.map((st) => st.value)).toEqual([0, 2.58, 66, 252, 541]);
    expect(new Set(legend.stops?.map((st) => st.color)).size).toBe(5);
    expect(ERAS[4].color).toBe("#3A3A3C");
    expect(layer.style.encode).toEqual({ color: "best_age_top" });
    expect(layer.card?.facts?.map((f) => f.key)).toEqual(["age", "descrip"]);
    expect(layer.description).not.toMatch(/does not colour rock types/);
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

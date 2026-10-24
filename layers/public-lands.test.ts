import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { summarizeLayerResult } from "@/lib/layers/summarize";
import { OUTSIDE_US_NOTE } from "./_shared/coverage";
import layer, { MANAGER_GROUPS, landUnitsNote, parseLandUnits } from "./public-lands";
import { contractProblems, legendOf } from "./contract";
import { cardContent } from "@/lib/render/card";
import { PURPLE } from "@/lib/render/palette";

const TAHOE: [number, number, number, number] = [-120.3, 38.8, -119.8, 39.3];
const ALPS: [number, number, number, number] = [6, 45, 8, 47];

function ctx(bbox: [number, number, number, number], stub = vi.fn()) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch };
}

describe("public-lands layer", () => {
  it("declares US coverage, the public-domain license and no input", () => {
    expect(layer.id).toBe("public-lands");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (USGS PAD-US 4.1)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(Number.POSITIVE_INFINITY);
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toEqual({ geometry: "polygon", color: "#9FB693", fillOpacity: 0.28 });
  });

  it("returns the PAD-US vector tiles without calling upstream", async () => {
    const stub = vi.fn();
    const r = await layer.query(ctx(TAHOE, stub), {});
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data).toEqual({
      url: "https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf",
      minzoom: 3,
      maxzoom: 12,
      format: "vector",
      sourceLayer: "padus",
      geometry: "polygon",
    });
    // Ownership is not access: the Tahoe box's note quotes the basin's dispersed-camping order.
    expect(r.coverageNote).toMatch(/^Camping rule here: Lake Tahoe Basin Management Unit .*Forest Order 19-24-05, 2024-06-28\), https:\/\/fs\.usda\.gov\//);
    expect(r.citation.source).toContain("PAD-US");
  });

  it("names Moab's BLM rule near Moab, and says to check closure orders where no rule is kept (Leadville)", async () => {
    const moab = await layer.query(ctx([-109.75, 38.45, -109.4, 38.7]), {});
    expect("coverageNote" in moab && moab.coverageNote).toMatch(/Bureau of Land Management, Moab Field Office, Moab area: many areas near Moab/);
    const leadville = await layer.query(ctx([-106.5, 39.1, -106.1, 39.4]), {});
    expect("coverageNote" in leadville && leadville.coverageNote).toMatch(/^No camping closure order on file for this area; check the ranger district's/);
  });

  it("serves PADUS_TILES_URL instead of the default bucket when set", async () => {
    const own = "https://tiles.example.test/padus/{z}/{x}/{y}.pbf";
    const r = await layer.query({ ...ctx(TAHOE), env: { PADUS_TILES_URL: own } }, {});
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.url).toBe(own);
    const blank = await layer.query({ ...ctx(TAHOE), env: { PADUS_TILES_URL: "" } }, {});
    if (!("kind" in blank) || blank.kind !== "tiles") throw new Error("expected tiles");
    expect(blank.data.url).toBe("https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf");
  });

  it("still returns the tiles outside the US, with a coverage note", async () => {
    const r = await layer.query(ctx(ALPS), {});
    if (!("kind" in r) || r.kind !== "tiles") throw new Error("expected tiles");
    expect(r.data.format).toBe("vector");
    expect(r.coverageNote).toBe(OUTSIDE_US_NOTE);
  });

  it("explains managers and that ownership is not access rules", () => {
    expect(layer.description).toMatch(/federal/i);
    expect(layer.description).toMatch(/state/i);
    expect(layer.description).toMatch(/private/i);
    expect(layer.description).toMatch(/not .*access|access rules/i);
    expect(layer.description).toContain("You cannot see the rendered map");
  });

  it("fills by manager in six groups, keys every raw agency value to its group color, and names codes on the card", () => {
    const legend = legendOf(layer);
    expect(legend).toMatchObject({ kind: "categories", field: "agency", title: "Managed by" });
    const byValue = Object.fromEntries((legend.items ?? []).map((i) => [i.value, i]));
    // Values seen in the live tiles (Moab, 2026-10-18): BLM, USFS, State, State Parks, Local.
    for (const v of ["NPS", "FWS", "USFS", "BLM", "USACE", "USBR", "DOD", "DOE", "TVA", "ARS", "NRCS", "State", "State Parks", "Local", "Tribal", "NGO"]) {
      expect(byValue[v], v).toBeDefined();
    }
    expect(byValue.NPS.color).toBe(byValue.FWS.color);
    expect(byValue.State.label).toBe(byValue["State Parks"].label);
    expect(byValue.BLM).toMatchObject({ label: "Bureau of Land Management", color: "#3A3A3C" });
    expect(new Set((legend.items ?? []).map((i) => i.label)).size).toBe(MANAGER_GROUPS.length);
    expect(new Set(MANAGER_GROUPS.map((g) => g.color)).size).toBe(MANAGER_GROUPS.length);
    expect(layer.attributes?.find((a) => a.key === "agency")).toMatchObject({ encode: "color", primary: true });
    const facts = Object.fromEntries((layer.card?.facts ?? []).map((f) => [f.key, f]));
    expect(facts.agency.values?.BLM).toBe("Bureau of Land Management");
    expect(facts.designation.values?.PUB).toBe("Public land (no special designation)");
    expect(facts.category).toBeUndefined();
    expect(layer.card?.hidden).toContain("category");
    expect(facts.access.help?.text).toMatch(/restricted/);
    expect(contractProblems(layer)).toEqual([]);
  });

  it("keys every group the map fills, state land in purple among the first four (the phone's short key)", () => {
    const legend = legendOf(layer);
    const labels = [...new Set((legend.items ?? []).map((i) => i.label))];
    expect(labels).toEqual(MANAGER_GROUPS.map((g) => g.label));
    expect(labels.slice(0, 4)).toContain("State land and state parks");
    // The tiles are filled from these items (value → color), so each value keys the color its group draws.
    for (const g of MANAGER_GROUPS) {
      for (const v of Object.keys(g.agencies)) expect(legend.items?.find((i) => i.value === v)?.color, v).toBe(g.color);
    }
    expect(legend.items?.find((i) => i.value === "State")?.color).toBe(PURPLE);
    expect(legend.items?.find((i) => i.value === "State Parks")?.color).toBe(PURPLE);
  });

  it("cards a tapped area with its designation once, not again as a kind of land", () => {
    // An area shaped like the PAD-US tiles' features (the property names the tiles carry).
    const area = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [-109.74, 38.47] }, properties: { name: "Dead Horse Point State Park", agency: "State Parks", designation: "State Park", access: "open", category: "state_park" } };
    const card = cardContent(area, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.map((r) => [r.label, r.value])).toEqual([
      ["Managed by", "State parks agency"],
      ["Designation", "State Park"],
      ["Public access", "Open"],
    ]);
    expect(card.details).toEqual([]);
  });

  it("summarizes to a vector tiles result with the source layer", async () => {
    const r = await layer.query(ctx(TAHOE), {});
    expect(summarizeLayerResult(r)).toMatchObject({ kind: "tiles", format: "vector", sourceLayer: "padus", geometry: "polygon" });
  });

  it("runs through runLayer", async () => {
    const ok = await runLayer("public-lands", { bbox: TAHOE, zoom: 9 });
    expect(ok.status).toBe(200);
  });

  it("names the land units in view with their managers, largest first, and the general camping rules", () => {
    const units = parseLandUnits({
      features: [
        { attributes: { Unit_Nm: "Royal Gorge Field Office", Mang_Name: "BLM", GIS_Acres: 670237 } },
        { attributes: { Unit_Nm: "San Isabel National Forest", Mang_Name: "USFS", GIS_Acres: 1108492 } },
        { attributes: { Unit_Nm: "San Isabel National Forest", Mang_Name: "USFS", GIS_Acres: 1108492 } },
        { attributes: { Unit_Nm: "Arkansas Headwaters", Mang_Name: "SPR", GIS_Acres: 1286 } },
      ],
    });
    expect(units.map((u) => u.name)).toEqual(["San Isabel National Forest", "Royal Gorge Field Office", "Arkansas Headwaters"]);
    const note = landUnitsNote(units);
    expect(note).toMatch(/^Land here, largest units first: San Isabel National Forest \(US Forest Service\), Royal Gorge Field Office \(Bureau of Land Management\), Arkansas Headwaters \(State parks agency\)/);
    expect(note).toMatch(/national forest land generally allows dispersed camping .*; BLM land generally allows dispersed camping up to 14 days/);
    expect(landUnitsNote([])).toBe("");
  });

  it("asks PAD-US's feature service who manages the land in view when lookups are on", async () => {
    vi.stubEnv("AUX_LOOKUPS", "on");
    try {
      const stub = vi.fn(async () => new Response(JSON.stringify({ features: [{ attributes: { Unit_Nm: "San Isabel National Forest", Mang_Name: "USFS", GIS_Acres: 1 } }] }), { status: 200 }));
      const r = await layer.query(ctx([-106.45, 39.15, -106.2, 39.3], stub), {});
      expect(String((stub.mock.calls[0] as unknown[])[0])).toContain("Fee_Managers_PADUS/FeatureServer/0/query");
      expect("coverageNote" in r && r.coverageNote).toMatch(/^Land here, largest units first: San Isabel National Forest \(US Forest Service\)/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

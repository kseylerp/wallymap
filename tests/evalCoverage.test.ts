import { describe, expect, it } from "vitest";
import { listLayers } from "@/layers";
import { VIEW_KINDS } from "@/lib/render/state";
import { COVERAGE_QUESTIONS, LAYERS_IN_OLDER_QUESTIONS, coverageFor, coverageRule, outageSkip, readEvalSet } from "@/scripts/eval-model.mjs";

/** The coverage questions (scripts/eval-model.mts, docs/questions.md "Coverage questions"). */
describe("eval coverage questions", () => {
  const set = readEvalSet();
  const expects = Object.values(COVERAGE_QUESTIONS);

  it("every coverage question is in the eval set, and every set question it names has one expectation", () => {
    const covered = set.filter((q) => coverageFor(q) !== undefined);
    expect(covered.length).toBe(Object.keys(COVERAGE_QUESTIONS).length);
    expect(covered.length).toBeGreaterThanOrEqual(40);
  });

  it("names only registered layers", () => {
    const ids = new Set(listLayers().map((l) => l.id));
    const named = [...expects.flatMap((e) => e.layers.flatMap((a) => a.split("|"))), ...LAYERS_IN_OLDER_QUESTIONS];
    expect(named.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("asks about every registered layer, with the older questions", () => {
    const asked = new Set([...expects.flatMap((e) => e.layers.flatMap((a) => a.split("|"))), ...LAYERS_IN_OLDER_QUESTIONS]);
    expect(listLayers().map((l) => l.id).filter((id) => !asked.has(id))).toEqual([]);
  });

  it("expects every standard view at least twice", () => {
    for (const view of VIEW_KINDS) expect(expects.filter((e) => e.view === view).length, view).toBeGreaterThanOrEqual(2);
  });

  it("fails a question whose expected layer was never queried, and passes a route on the map", () => {
    expect(coverageRule({ layers: ["tides"] }, []).ok).toBe(false);
    const route = {
      toolName: "route",
      input: { from: "Banff", to: "Lake Louise", profile: "cycling" },
      output: {
        id: "r1",
        name: "Banff to Lake Louise",
        line: { type: "LineString", coordinates: [[-115.57, 51.18], [-116.18, 51.43]] },
        distanceKm: 58,
        waypoints: [
          { lngLat: [-115.57, 51.18], type: "start" },
          { lngLat: [-116.18, 51.43], type: "end" },
        ],
      },
    };
    expect(coverageRule({ layers: [], view: "route" }, []).ok).toBe(false);
    expect(coverageRule({ layers: [], view: "route" }, [route]).ok).toBe(true);
  });

  it("passes an expected layer that answered empty without drawing, and fails one that errored", () => {
    const empty = { toolName: "query_tides", input: {}, output: { kind: "geojson", data: { type: "FeatureCollection", features: [] } } };
    const errored = { toolName: "query_tides", input: {}, output: { error: "upstream down" } };
    expect(coverageRule({ layers: ["tides"] }, [empty]).ok).toBe(true);
    expect(coverageRule({ layers: ["tides"] }, [errored]).ok).toBe(false);
  });
});

describe("documented outages", () => {
  it("skips a coverage question whose layer is down by a documented outage, and counts one that answered", () => {
    const expect_ = coverageFor("Active mining claims near Moab");
    expect(expect_).toBeDefined();
    const down = [{ toolName: "query_mining-claims", input: {}, output: { error: "Mining claims are unavailable since 2026-10-14", hint: "unavailable" } }];
    expect(outageSkip(expect_!, down)).toMatch(/documented outage: mining-claims since 2026-10-14/);
    const answered = [{ toolName: "query_mining-claims", input: {}, output: { kind: "geojson", data: { type: "FeatureCollection", features: [] } } }];
    expect(outageSkip(expect_!, answered)).toBeUndefined();
    expect(outageSkip(coverageFor("Where is the Ogallala aquifer?")!, [])).toBeUndefined();
  });
});

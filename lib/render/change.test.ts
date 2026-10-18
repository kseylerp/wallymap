import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { changeStatement, epochLabel, identityKey, snapshotEpochs } from "@/lib/render/change";
import { compareSummary, deltaFeatures, splitWindows } from "@/lib/render/compare";
import { snapshotCompare } from "@/lib/render/compareView";
import { layerChange, defaultView } from "@/lib/render/views";
import { newestOfEach, visibleState } from "@/lib/render/view";
import { reduce, timeCritical } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";
import { timeIndex } from "@/lib/time";

/** A square outline of `side` degrees at x, for one glacier at one survey date. */
function outline(id: string, x: number, side: number, date: string, areaKm2: number): Feature {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[x, 0], [x + side, 0], [x + side, side], [x, side], [x, 0]]] },
    properties: { glacierId: id, name: `G ${id}`, areaKm2, v: areaKm2, t: `${date}T00:00:00.000Z` },
  };
}

/** Wind River-like surveys: four glaciers seen in 1966 and 2015 (one via 1974, one only in 1966, one only in 2019). */
function surveys(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      outline("a", 0, 0.2, "1966-09-09", 2.0),
      outline("a", 0, 0.1, "2015-09-09", 1.0),
      outline("b", 1, 0.2, "1966-09-09", 4.0),
      outline("b", 1, 0.15, "2015-09-09", 2.0),
      outline("c", 2, 0.2, "1974-09-09", 1.0),
      outline("c", 2, 0.15, "2015-09-09", 0.5),
      outline("d", 3, 0.2, "1966-09-09", 3.0),
      outline("e", 4, 0.2, "1963-09-09", 0.4),
      outline("f", 5, 0.2, "2019-09-09", 0.3),
    ],
  };
}

function glaciers(data: FeatureCollection = surveys()): LoadedLayer {
  return {
    id: "glaciers",
    title: "Glacier outlines (GLIMS)",
    style: { geometry: "polygon", color: "#3A3A3C" },
    attributes: [{ key: "areaKm2", type: "measure", label: "Area", unit: "km²", encode: "size" }],
    result: { kind: "geojson", data, citation: { source: "GLIMS", url: "https://www.glims.org", retrieved: "2026-10-18" } },
    receivedAt: "2026-10-18",
  };
}

describe("snapshot epochs", () => {
  it("group survey campaigns: 1963, 1966 and 1974 against 2015 and 2019", () => {
    const epochs = snapshotEpochs(["1966-09-09", "2015-09-09", "1974-09-09", "1963-09-09", "2019-09-09"]);
    expect(epochs).toEqual([["1963-09-09", "1966-09-09", "1974-09-09"], ["2015-09-09", "2019-09-09"]]);
    expect(epochs.map(epochLabel)).toEqual(["the 1960s–70s", "the 2010s"]);
  });
  it("keep evenly spaced epochs apart (land cover)", () => {
    expect(snapshotEpochs(["2001", "2006", "2011", "2016", "2019", "2021"])).toHaveLength(6);
    expect(epochLabel(["2015-09-09"])).toBe("2015");
  });
});

describe("identity across dates", () => {
  it("finds the glacier id, not the name or a per-outline key", () => {
    expect(identityKey(surveys().features)).toBe("glacierId");
  });
  it("finds none when every feature is its own thing", () => {
    const quakes = [1, 2, 3].map((i) => ({ ...outline(String(i), i, 0.1, `2026-10-0${i}`, 1) }));
    expect(identityKey(quakes)).toBeUndefined();
  });
});

describe("the change statement", () => {
  it("states the glaciers mapped at both times and how much area they lost, from the data", () => {
    const layer = glaciers();
    const change = layerChange(layer)!;
    expect(change.matched).toBe(3);
    expect(change.before).toBeCloseTo(7.0);
    expect(change.after).toBeCloseTo(3.5);
    expect(change.text).toBe(
      "3 glacier outlines mapped in both the 1960s–70s and the 2010s lost 50% of their area (7 to 3.5 km²). 2 mapped only in the 1960s–70s, 1 only in the 2010s.",
    );
  });
  it("counts each side when there is no id", () => {
    expect(changeStatement([outline("x", 0, 1, "2001-01-01", 1)], [], { noun: "fires", aLabel: "2001", bLabel: "2020" })?.text).toBe("1 fires in 2001, 0 in 2020.");
  });
});

describe("the snapshot compare (owner: 'both 0' in delta mode)", () => {
  it("opens on the first and last epoch, labelled as people say them", () => {
    const compare = snapshotCompare(glaciers())!;
    expect(compare).toMatchObject({ mode: "delta", aLabel: "the 1960s–70s", bLabel: "the 2010s" });
  });
  it("matches a glacier whose outline changed as both, with its earlier edge, never lost and new at once", () => {
    const layer = glaciers();
    const compare = snapshotCompare(layer)!;
    const { a, b } = splitWindows(surveys(), compare);
    const delta = deltaFeatures(a, b, { idKey: "glacierId", measureKey: "areaKm2" });
    expect(compareSummary(delta)).toMatchObject({ aOnly: 2, bOnly: 1, both: 3 });
    const both = delta.features.filter((f) => f.properties?.delta === "both");
    expect(both.map((f) => [f.properties?.glacierId, f.properties?.before, f.properties?.after])).toEqual([
      ["a", 2, 1],
      ["b", 4, 2],
      ["c", 1, 0.5],
    ]);
    // Each changed glacier keeps its earlier edge and, where it shrank, the ground it lost as its own area.
    expect(delta.features.filter((f) => f.properties?.deltaEdge === true && f.properties?.deltaLost !== true)).toHaveLength(3);
    expect(delta.features.filter((f) => f.properties?.deltaLost === true).length).toBeGreaterThan(0);
    // Matched by shape alone (the old way) every changed glacier was lost and new.
    expect(compareSummary(deltaFeatures(a, b)).both).toBe(0);
  });
});

describe("snapshots draw the newest of each thing", () => {
  it("keeps one outline per glacier, its newest", () => {
    const newest = newestOfEach(surveys());
    expect(newest.features.map((f) => `${f.properties?.glacierId}:${String(f.properties?.t).slice(0, 4)}`)).toEqual([
      "a:2015",
      "b:2015",
      "c:2015",
      "d:1966",
      "e:1963",
      "f:2019",
    ]);
  });

  function loaded(): MapState {
    const actions: MapAction[] = [
      { type: "layer_loaded", layer: glaciers() },
      { type: "render", op: { layerId: "glaciers", mode: "polygons", visible: true }, defaultMode: true },
    ];
    return actions.reduce(reduce, initialMapState);
  }

  it("on load: a stepper between the dates, folded, no forced view, the newest of each drawn", () => {
    const s = loaded();
    expect(s.time?.index.snapshots?.stops.map((x) => x.label)).toEqual(["1963", "1966", "1974", "2015", "2019"]);
    expect(s.time?.open).toBe(false);
    expect(s.renderOps[0].view).toBeUndefined();
    expect(defaultView(s.layers.glaciers)).toBeUndefined();
    const drawn = visibleState(s).layers.glaciers;
    expect(drawn.result.kind === "geojson" && drawn.result.data.features).toHaveLength(6);
  });

  it("a stepped date draws that date's outlines and opens the panel", () => {
    const s = reduce(loaded(), { type: "set_time_window", window: ["2015-01-01T00:00:00.000Z", "2015-12-31T23:59:59.999Z"] });
    expect(s.time?.open).toBe(true);
    const drawn = visibleState(s).layers.glaciers;
    expect(drawn.result.kind === "geojson" && drawn.result.data.features.map((f) => f.properties?.glacierId)).toEqual(["a", "b", "c"]);
  });
});

describe("the time panel opens by itself only for current continuous data", () => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  const fires = (dates: string[]): LoadedLayer => ({
    ...glaciers({ type: "FeatureCollection", features: dates.map((d, i) => ({ ...outline(String(i), i, 0.1, d, 1), properties: { t: `${d}T00:00:00.000Z` } })) }),
    id: "fire-detections",
    time: { shape: "continuous" },
  });
  it("opens for detections from the last days, not for an archive", () => {
    expect(timeCritical(timeIndex({ f: fires(["2026-10-10", "2026-10-16", "2026-10-17"]) })!, now)).toBe(true);
    expect(timeCritical(timeIndex({ f: fires(["1990-10-10", "2005-10-16", "2016-10-17"]) })!, now)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import type { Attribute } from "@/layers/types";
import { askedEncoding, channelExtent, channelText, colorT, lineWidthAt, resolveEncoding, sizeT } from "@/lib/render/encode";
import { lineEntries, lineLayerSpecs, lineSourceData } from "@/lib/render/nativeLines";
import { buildDeckLayers } from "@/lib/render/deck";
import { decodeState, encodeState } from "@/lib/render/permalink";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

const ATTRS: Attribute[] = [
  { key: "q", type: "measure", label: "Flow", unit: "m³/s" },
  { key: "temp", type: "measure", label: "Water temperature", unit: "°C" },
  { key: "conf", type: "ordinal", label: "Confidence", scale: "l, n, h", levels: [{ value: "l", label: "Low" }, { value: "n", label: "Nominal" }, { value: "h", label: "High" }] },
];

function point(q: number | undefined, temp: number | undefined, conf?: string): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { q, temp, conf } };
}

const DATA: FeatureCollection = { type: "FeatureCollection", features: [point(100, 4), point(400, 20, "h"), point(0, undefined, "l")] };

function layer(geometry: "point" | "line", data: FeatureCollection, encode = { size: "q", color: "temp" }): LoadedLayer {
  return {
    id: "x",
    title: "X",
    style: { geometry, color: "#3A3A3C", encode },
    attributes: ATTRS,
    result: { kind: "geojson", data, citation: { source: "s", url: "https://e.org", retrieved: "2026-10-17" } },
    receivedAt: "2026-10-17",
  };
}

describe("two measures on one mark", () => {
  it("takes the layer's pair, the op's choice over it, and switches a channel off with an empty key", () => {
    const l = layer("point", DATA);
    expect(askedEncoding(l, undefined)).toEqual({ size: "q", color: "temp" });
    expect(askedEncoding(l, { encode: { color: "conf" } })).toEqual({ size: "q", color: "conf" });
    expect(askedEncoding(l, { encode: { size: "" } })).toEqual({ color: "temp" });
  });

  it("resolves channels against the data with their words and range", () => {
    const enc = resolveEncoding(layer("point", DATA), undefined, DATA);
    expect(enc?.size).toEqual({ key: "q", label: "Flow", unit: "m³/s", extent: [0, 400] });
    expect(enc?.color?.extent).toEqual([4, 20]);
    expect(channelText(enc!.size!)).toBe("Flow 0–400 m³/s");
    expect(channelText(enc!.color!)).toBe("Water temperature 4–20 °C");
  });

  it("keeps the range of every loaded feature when a frame or a filter narrows the data", () => {
    const narrowed: FeatureCollection = { type: "FeatureCollection", features: [DATA.features[0]] };
    const enc = resolveEncoding({ ...layer("point", DATA), allData: DATA }, undefined, narrowed);
    expect(enc?.size?.extent).toEqual([0, 400]);
  });

  it("never sizes by a class, and drops a key the layer does not declare", () => {
    expect(resolveEncoding(layer("point", DATA, { size: "conf", color: "nope" }), undefined, DATA)).toBeNull();
  });

  it("colors an ordinal by its levels in order", () => {
    const enc = resolveEncoding(layer("point", DATA), { encode: { color: "conf" } }, DATA);
    expect(enc?.color?.levels?.map((l) => l.label)).toEqual(["Low", "Nominal", "High"]);
    expect(colorT("h", enc!.color!)).toBe(1);
    expect(colorT("l", enc!.color!)).toBe(0);
    expect(channelText(enc!.color!)).toBe("Confidence: Low → High");
  });

  it("sizes by the square root of the share of the largest, so area grows with the value", () => {
    expect(sizeT(400, [0, 400])).toBe(1);
    expect(sizeT(100, [0, 400])).toBe(0.5);
    expect(sizeT(undefined, [0, 400])).toBe(0);
    expect(lineWidthAt(1)).toBeGreaterThan(lineWidthAt(0.5));
    // Values far from zero (a magnitude) size by their place in the range.
    expect(sizeT(2.5, [2.5, 5.7])).toBe(0);
    expect(sizeT(5.7, [2.5, 5.7])).toBe(1);
  });

  it("reads every frame of a series for the range", () => {
    const series: Feature = { type: "Feature", geometry: null as never, properties: { q: 5, series: { q: [1, 900, 5] } } };
    expect(channelExtent({ type: "FeatureCollection", features: [series] }, "q")).toEqual([1, 900]);
  });

  it("draws an encoded line layer with width and color shares the paint reads (feature state first)", () => {
    const lines: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { q: 400, temp: 20 } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 1], [1, 2]] }, properties: { q: 100, temp: 4 } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [[0, 2], [1, 3]] }, properties: { q: 10 } },
      ],
    };
    const l = layer("line", lines);
    const state: MapState = { ...initialMapState, layers: { x: l }, renderOps: [{ layerId: "x", mode: "lines", visible: true }] };
    const [entry] = lineEntries(state);
    expect(entry.look.kind).toBe("encoded");
    const source = lineSourceData(entry);
    expect(source.features[0].id).toBe(0);
    expect(source.features[0].properties).toMatchObject({ sz: 1, ct: 1 });
    expect(source.features[1].properties).toMatchObject({ sz: 0.5, ct: 0 });
    const core = lineLayerSpecs(entry).find((s) => s.id.endsWith(":core"));
    expect(JSON.stringify(core?.paint?.["line-width"])).toContain("feature-state");
  });

  it("draws encoded points as discs on the ramp, and keeps shaped symbols when only size applies", () => {
    const l = layer("point", DATA);
    const state: MapState = { ...initialMapState, terrain: false, layers: { x: l }, renderOps: [{ layerId: "x", mode: "points", visible: true }] };
    const ids = buildDeckLayers(state, { mapboxToken: "" }).map((d) => d.id);
    expect(ids).toContain("x:encoded");
    const sizeOnly: MapState = { ...state, renderOps: [{ layerId: "x", mode: "points", visible: true, encode: { color: "" } }] };
    const ids2 = buildDeckLayers(sizeOnly, { mapboxToken: "" }).map((d) => d.id);
    expect(ids2).toContain("x:points");
  });

  it("round-trips the op's pair through a share link", () => {
    const l = layer("point", DATA);
    const hash = encodeState({ ...initialMapState, layers: { x: l }, renderOps: [{ layerId: "x", mode: "points", visible: true, encode: { size: "", color: "conf" } }] });
    expect(decodeState(hash)?.layers[0].encode).toEqual({ size: "", color: "conf" });
    const untouched = encodeState({ ...initialMapState, layers: { x: l }, renderOps: [{ layerId: "x", mode: "points", visible: true, encode: { color: "conf" } }] });
    expect(decodeState(untouched)?.layers[0].encode).toEqual({ color: "conf" });
  });
});

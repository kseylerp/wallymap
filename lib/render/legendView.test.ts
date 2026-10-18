import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import type { Attribute } from "@/layers/types";
import { failureLine } from "@/lib/render/contract";
import { rowLegend } from "@/lib/render/legendView";
import { decodeState, encodeState } from "@/lib/render/permalink";
import { PINK, PURPLE } from "@/lib/render/palette";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer } from "@/lib/render/state";

const citation = { source: "s", url: "https://x", retrieved: "r" };
const KIND: Attribute = { key: "kind", type: "category", label: "Kind", levels: [{ value: "hut", label: "Huts" }, { value: "spring", label: "Springs" }] };
const pt = (kind: string): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { kind } });

describe("the row legend (docs/layer-contract.md legend)", () => {
  it("lists a declared key's name once when several values share it, adding their counts (public lands' other federal)", () => {
    const pts = ["DOD", "BOR", "DOD", "NPS"].map((agency) => ({ ...pt("x"), properties: { agency } }));
    const layer: LoadedLayer = {
      id: "public-lands",
      title: "Public lands",
      style: { geometry: "polygon", color: "#3A3A3C" },
      legend: {
        kind: "categories",
        field: "agency",
        items: [
          { label: "Parks", value: "NPS", color: PURPLE },
          { label: "Other federal", value: "DOD", color: PINK },
          { label: "Other federal", value: "BOR", color: PINK },
        ],
      },
      result: { kind: "geojson", data: { type: "FeatureCollection", features: pts }, citation },
      receivedAt: "",
    };
    const blocks = rowLegend(layer, { layerId: layer.id, mode: "polygons", visible: true }, layer.result.kind === "geojson" ? layer.result.data : null);
    const block = blocks.find((b) => b.field === "agency");
    expect(block?.entries.map((e) => [e.label, e.count])).toEqual([
      ["Parks", 1],
      ["Other federal", 3],
    ]);
  });

  it("keys a category in the colors the map draws, with counts", () => {
    const layer: LoadedLayer = {
      id: "outdoor-features",
      title: "Outdoor features",
      style: { geometry: "point", color: "#3A3A3C" },
      attributes: [KIND],
      result: { kind: "geojson", data: { type: "FeatureCollection", features: [pt("hut"), pt("hut"), pt("spring")] }, citation },
      receivedAt: "",
    };
    const [block] = rowLegend(layer, { layerId: layer.id, mode: "points", visible: true }, layer.result.kind === "geojson" ? layer.result.data : null);
    expect(block).toMatchObject({ kind: "categories", title: "Kind", shape: "point" });
    expect(block.entries).toEqual([
      { label: "Huts", color: PURPLE, count: 2 },
      { label: "Springs", color: PINK, count: 1 },
    ]);
  });

  it("gives a raster layer its declared image, or its one-line note", () => {
    const base = {
      title: "Hardiness zones",
      style: { geometry: "polygon" as const, color: "#3A3A3C", raster: null },
      result: { kind: "tiles" as const, data: { url: "https://t/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 9, format: "raster" as const }, citation },
      receivedAt: "",
    };
    const image = rowLegend({ ...base, id: "a", legend: { kind: "image", title: "Zone", imageUrl: "https://t/legend.png" } }, undefined, null);
    expect(image[0]).toMatchObject({ kind: "image", imageUrl: "https://t/legend.png" });
    const note = rowLegend({ ...base, id: "b", description: "USDA zones by coldest night. More text." }, undefined, null);
    expect(note[0]).toMatchObject({ kind: "symbol", note: "USDA zones by coldest night." });
  });
});

describe("failures are visible", () => {
  it("says what the source did and what the map shows", () => {
    expect(failureLine({ ok: false, reason: "server-error", message: "NOAA's weather service is returning errors (503)." }, 0)).toBe(
      "NOAA's weather service is returning errors (503). Showing nothing for this layer.",
    );
    expect(failureLine({ ok: true }, 3)).toBeNull();
  });

  it("keeps a failed layer in the share link, with its input, so the link restores the reason", () => {
    const s = reduce(initialMapState, {
      type: "layer_error",
      layerId: "weather-alerts",
      message: "upstream failed",
      sourceStatus: { ok: false, reason: "server-error", message: "NOAA's weather service is returning errors (503)." },
      input: { severity: "severe" },
    });
    expect(s.errors).toHaveLength(1);
    const hash = encodeState({ ...s, failed: s.errors });
    expect(hash).toContain("l=weather-alerts::1");
    expect(decodeState(hash)?.layers[0]).toMatchObject({ id: "weather-alerts", visible: true, input: { severity: "severe" } });
    // Removing the failed row clears it.
    expect(reduce(s, { type: "remove_layer", layerId: "weather-alerts" }).errors).toEqual([]);
  });
});

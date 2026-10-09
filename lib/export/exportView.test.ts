import { describe, expect, it } from "vitest";
import { buildExportBundle, formatBytes, zipBundle } from "@/lib/export/exportView";
import { crc32, zipStored } from "@/lib/export/zip";
import type { LayerResult } from "@/layers/types";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

const geo = (id: string, title: string): LoadedLayer => ({
  id,
  title,
  style: { geometry: "line", color: "#000" },
  receivedAt: "2026-10-09T10:00:00Z",
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "A" }, geometry: { type: "Point", coordinates: [1, 2] } }] },
    citation: { source: "OpenStreetMap contributors", url: "https://osm.org", retrieved: "2026-10-09T10:00:00Z" },
  } satisfies LayerResult,
});
const tiles: LoadedLayer = {
  id: "gfw-loss",
  title: "Forest loss",
  style: { geometry: "polygon", color: "#f00" },
  receivedAt: "2026-10-09T10:01:00Z",
  result: {
    kind: "tiles",
    data: { url: "https://t/{z}/{x}/{y}", minzoom: 0, maxzoom: 12, format: "raster" },
    citation: { source: "Global Forest Watch", url: "https://gfw.org", retrieved: "2026-10-09T10:01:00Z" },
  },
};
const state: MapState = {
  ...initialMapState,
  viewport: { longitude: -120.1, latitude: 39.2, zoom: 11, pitch: 45, bearing: 10 },
  layers: { "osm-trails": geo("osm-trails", "Trails"), campsites: geo("campsites", "Campsites"), "gfw-loss": tiles },
  renderOps: [
    { layerId: "osm-trails", mode: "lines", visible: true },
    { layerId: "campsites", mode: "points", visible: false },
    { layerId: "gfw-loss", mode: "polygons", visible: true },
  ],
};
const catalog = { "osm-trails": { title: "Trails", style: state.layers["osm-trails"].style, license: "ODbL" } };
const now = new Date("2026-10-09T12:00:00Z");

describe("buildExportBundle", () => {
  it("writes one geojson per visible GeoJSON layer with a wallymap block, and a citations file", async () => {
    const { files } = buildExportBundle(state, catalog, now);
    expect(files.map((f) => f.name)).toEqual(["osm-trails.geojson", "citations.md"]);
    const json = JSON.parse(await files[0].blob.text());
    expect(json.type).toBe("FeatureCollection");
    expect(json.features).toHaveLength(1);
    expect(json.wallymap).toMatchObject({ layer: "Trails", retrieved: "2026-10-09T10:00:00Z", license: "ODbL" });
    expect(json.wallymap.citation.url).toBe("https://osm.org");
  });

  it("lists every visible layer in citations.md (tiles included, hidden layers left out) with the view and time", async () => {
    const md = await buildExportBundle(state, catalog, now).files[1].blob.text();
    expect(md).toContain("**Trails**");
    expect(md).toContain("https://osm.org");
    expect(md).toContain("license: ODbL");
    expect(md).toContain("**Forest loss**");
    expect(md).toContain("https://gfw.org");
    expect(md).toContain("license: not recorded");
    expect(md).not.toContain("Campsites");
    expect(md).toContain("2026-10-09T12:00:00.000Z");
    expect(md).toContain("longitude -120.10000, latitude 39.20000, zoom 11.00");
  });
});

describe("buildExportBundle with a time window", () => {
  const dated: LoadedLayer = {
    ...geo("fire-perimeters", "Fire perimeters"),
    result: {
      kind: "geojson",
      citation: { source: "NIFC", url: "https://nifc.gov", retrieved: "2026-10-09T10:00:00Z" },
      data: {
        type: "FeatureCollection",
        features: Array.from({ length: 12 }, (_, k) => ({
          type: "Feature" as const,
          properties: { name: `F${k}`, t: `${2014 + k}-07-01T00:00:00.000Z` },
          geometry: { type: "Point" as const, coordinates: [1, 2] },
        })),
      },
    },
  };
  const timed = [
    { type: "layer_loaded", layer: dated },
    { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
    { type: "set_time_window", window: ["2019-01-01T00:00:00.000Z", "2020-12-31T23:59:59.999Z"] },
  ] satisfies MapAction[];
  const withTime = timed.reduce(reduce, initialMapState);

  it("exports only the features inside the window and notes the window in citations.md", async () => {
    const { files } = buildExportBundle(withTime, null, now);
    const json = JSON.parse(await files[0].blob.text());
    expect(json.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(["F5", "F6"]);
    expect(json.wallymap.timeWindow).toEqual(["2019-01-01T00:00:00.000Z", "2020-12-31T23:59:59.999Z"]);
    const md = await files[1].blob.text();
    expect(md).toContain("Time window: 2019 – 2020 (2019-01-01T00:00:00.000Z to 2020-12-31T23:59:59.999Z)");
    expect(md).toContain("2 of 12 features exported");
  });

  it("stamps the time window only on layers with dates", async () => {
    const both = reduce(reduce(withTime, { type: "layer_loaded", layer: geo("osm-trails", "Trails") }), {
      type: "render",
      op: { layerId: "osm-trails", mode: "lines", visible: true },
    });
    const { files } = buildExportBundle(both, null, now);
    const byName = Object.fromEntries(await Promise.all(files.map(async (f) => [f.name, await f.blob.text()] as const)));
    expect(JSON.parse(byName["fire-perimeters.geojson"]).wallymap.timeWindow).toBeDefined();
    expect(JSON.parse(byName["osm-trails.geojson"]).wallymap.timeWindow).toBeUndefined();
  });
});

describe("buildExportBundle during a compare", () => {
  const fires: LoadedLayer = {
    ...geo("fire-perimeters", "Fire perimeters"),
    result: {
      kind: "geojson",
      citation: { source: "NIFC", url: "https://nifc.gov", retrieved: "2026-10-09T10:00:00Z" },
      data: {
        type: "FeatureCollection",
        features: [2013, 2017, 2018, 2022].map((year) => ({
          type: "Feature" as const,
          properties: { name: `F${year}`, year, t: `${year}-07-01T00:00:00.000Z` },
          geometry: { type: "Point" as const, coordinates: [1, 2] },
        })),
      },
    },
  };
  const comparing = (
    [
      { type: "layer_loaded", layer: fires },
      { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
      { type: "set_time_window", window: ["2013-01-01T00:00:00.000Z", "2013-12-31T23:59:59.999Z"] },
      {
        type: "set_compare",
        compare: { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"], b: ["2021-01-01", "2026-10-09"], mode: "swipe" },
      },
    ] satisfies MapAction[]
  ).reduce(reduce, initialMapState);

  it("exports the whole loaded layer with a compare note instead of the time window", async () => {
    const { files } = buildExportBundle(comparing, null, now);
    const json = JSON.parse(await files[0].blob.text());
    expect(json.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(["F2013", "F2017", "F2018", "F2022"]);
    expect(json.wallymap.timeWindow).toBeUndefined();
    expect(json.wallymap.compare).toEqual({
      layerId: "fire-perimeters",
      mode: "swipe",
      a: ["2016-01-01", "2020-12-31"],
      b: ["2021-01-01", "2026-10-09"],
      counts: { aOnly: 2, bOnly: 1, both: 0 },
    });
  });

  it("adds a compare section to citations.md", async () => {
    const md = await buildExportBundle(comparing, null, now).files[1].blob.text();
    expect(md).toContain("## Compare");
    expect(md).toContain("Fire perimeters (`fire-perimeters`), swipe mode. A: 2016-01-01 to 2020-12-31 (2016–2020). B: 2021-01-01 to 2026-10-09");
    expect(md).toContain("Delta: 2 A only, 1 B only, 0 both.");
    expect(md).not.toContain("features exported");
  });

  it("drops the compare section once the compare ends", async () => {
    const md = await buildExportBundle(reduce(comparing, { type: "clear_compare" }), null, now).files[1].blob.text();
    expect(md).not.toContain("## Compare");
  });
});

describe("buildExportBundle with filters", () => {
  it("exports only the filtered features and notes the filters", async () => {
    const trail = (name: string, sac: string) => ({
      type: "Feature" as const,
      properties: { name, sac_scale: sac },
      geometry: { type: "Point" as const, coordinates: [1, 2] },
    });
    const layer: LoadedLayer = {
      ...geo("osm-trails", "Trails"),
      result: {
        kind: "geojson",
        citation: { source: "OpenStreetMap contributors", url: "https://osm.org", retrieved: "2026-10-09T10:00:00Z" },
        data: {
          type: "FeatureCollection",
          features: [trail("A", "hiking"), trail("B", "alpine_hiking"), trail("C", "hiking"), trail("D", "alpine_hiking")],
        },
      },
    };
    const filtered = (
      [
        { type: "layer_loaded", layer },
        { type: "render", op: { layerId: "osm-trails", mode: "lines", visible: true } },
        { type: "set_filters", layerId: "osm-trails", filters: { sac_scale: { include: ["alpine_hiking"] } } },
      ] satisfies MapAction[]
    ).reduce(reduce, initialMapState);
    const { files } = buildExportBundle(filtered, catalog, now);
    const json = JSON.parse(await files[0].blob.text());
    expect(json.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(["B", "D"]);
    expect(json.wallymap.filters).toEqual({ sac_scale: { include: ["alpine_hiking"] } });
    const md = await files[1].blob.text();
    expect(md).toContain("2 of 4 features exported; filtered: sac_scale: alpine_hiking");
    expect(md).toContain("Filters set in the layer panel apply");
  });
});

/** Reads a stored zip back: [name, bytes, crc ok] per entry, walking the central directory. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: { name: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    out.push({ name, data, crcOk: crc32(data) === crc });
    at += 46 + nameLen;
  }
  return out;
}

describe("zip writer", () => {
  it("matches the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("stores every file intact with correct sizes, names and checksums", () => {
    const enc = new TextEncoder();
    const bytes = zipStored([
      { name: "a.geojson", data: enc.encode('{"x":1}') },
      { name: "citations.md", data: enc.encode("# héllo") },
      { name: "empty.txt", data: new Uint8Array() },
    ]);
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(["a.geojson", "citations.md", "empty.txt"]);
    expect(entries.every((e) => e.crcOk)).toBe(true);
    expect(new TextDecoder().decode(entries[1].data)).toBe("# héllo");
  });

  it("zips a bundle blob", async () => {
    const blob = await zipBundle(buildExportBundle(state, catalog, now), now);
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["osm-trails.geojson", "citations.md"]);
    expect(blob.type).toBe("application/zip");
  });
});

describe("formatBytes", () => {
  it("writes sizes for the confirm step", () => {
    expect(formatBytes(377)).toBe("377 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2_223_321)).toBe("2.1 MB");
  });
});

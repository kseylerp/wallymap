import { afterEach, describe, expect, it, vi } from "vitest";
import { useTileSource } from "@/lib/terrain/dem";
import { syntheticTiles } from "@/lib/terrain/__fixtures__/synthetic";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
import layer, {
  MAX_FEATURES,
  SPARQL_ENDPOINT,
  dedupePeaks,
  mergePeaks,
  normalizePeaks,
  osmPeaksQuery,
  parseOsmPeaks,
  peaksQuery,
  widePeaksQuery,
} from "./peaks";
import { heightText, inUnitedStates, matchName, usUnitsFirst } from "./peaks-units";
import fixture from "./__fixtures__/peaks.tahoe.json";
import leadvilleWikidata from "./__fixtures__/peaks.leadville.wikidata.json";
import leadvilleOsm from "./__fixtures__/peaks.leadville.osm.json";

/**
 * peaks.tahoe.json is a real Wikidata SPARQL answer for the Tahoe box (recorded 2026-10-09 with the layer's own query).
 * peaks.leadville.wikidata.json (16 of its rows) and peaks.leadville.osm.json (all 71 named peaks, tags trimmed to what the layer
 * reads) are real answers for the Leadville box -106.6,38.9,-106.2,39.3, recorded 2026-10-18.
 */
vi.mock("./_shared/wikimedia", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_shared/wikimedia")>();
  return { ...real, wikimediaFetch: (f: never, u: string, i?: never) => real.wikimediaFetch(f, u, i, { sleep: async () => {} }) };
});

const TAHOE: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.2];
const LEADVILLE: [number, number, number, number] = [-106.6, 38.9, -106.2, 39.3];
const bindings = fixture.results.bindings;
/** An item with two coordinate statements comes back as two rows; the layer keeps one point per item. */
const uniqueItems = new Set(bindings.map((b) => b.item.value)).size;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers Wikidata with `wikidata` and Overpass with `overpass` (each a body or a Response maker). */
function route(wikidata: unknown | (() => Response), overpass: unknown | (() => Response) = { elements: [] }) {
  const answer = (x: unknown) => (typeof x === "function" ? (x as () => Response)() : json(x));
  return vi.fn(async (url: string) => (url === SPARQL_ENDPOINT ? answer(wikidata) : answer(overpass)));
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string, bbox = TAHOE) {
  return { bbox, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

const byName = (features: { properties: Record<string, unknown> | null }[], name: string) => features.find((f) => f.properties?.name === name)?.properties;

describe("peaksQuery", () => {
  it("puts the south-west and north-east corners as Point(lon lat) and asks for normalised metres", () => {
    const q = peaksQuery(TAHOE);
    expect(q).toContain('wikibase:cornerSouthWest "Point(-120.2 38.8)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:cornerNorthEast "Point(-119.8 39.2)"^^geo:wktLiteral');
    expect(q).toContain("p:P2044/psn:P2044/wikibase:quantityAmount");
    expect(q).toContain("p:P2660/psn:P2660/wikibase:quantityAmount");
    expect(q).toContain("wd:Q8502");
    expect(q).toContain("ORDER BY DESC(?elev) DESC(?prom)");
    expect(q).toContain("wdt:P1705");
    expect(q).toContain('wikibase:language "en,mul"');
    expect(q).toContain("LIMIT 1000");
  });
});

describe("widePeaksQuery", () => {
  it("starts from items with a prominence, filters to the box and ranks by prominence with a little slack for unnamed rows", () => {
    const q = widePeaksQuery([-108.5, 37, -104.5, 41], 1000);
    expect(q).toContain("p:P2660/psn:P2660/wikibase:quantityAmount ?promM");
    expect(q).toContain("geof:longitude(?c) >= -108.5 && geof:longitude(?c) <= -104.5 && geof:latitude(?c) >= 37 && geof:latitude(?c) <= 41");
    expect(q).not.toContain("wikibase:box");
    expect(q).toContain("wdt:P31/wdt:P279* ?cls");
    expect(q.trimEnd().endsWith("ORDER BY DESC(?prom)\nLIMIT 1050")).toBe(true);
  });
});

describe("osmPeaksQuery", () => {
  it("asks Overpass for named peaks and volcanoes in the box (south, west, north, east), counted, at most 3,000", () => {
    const q = osmPeaksQuery(LEADVILLE);
    expect(q).toBe(
      '[out:json][timeout:20];node["natural"~"^(peak|volcano)$"]["name"](38.9,-106.6,39.3,-106.2)->.p;.p out count;.p out 3000;',
    );
  });
});

describe("normalizePeaks", () => {
  const features = normalizePeaks(bindings);

  it("turns each named item into a point with elevation, prominence and v = elevation", () => {
    expect(bindings.length).toBeGreaterThan(uniqueItems);
    expect(features).toHaveLength(uniqueItems);
    const freel = features.find((f) => f.properties?.name === "Freel Peak");
    expect(freel?.geometry).toEqual({ type: "Point", coordinates: [-119.9, 38.8575] });
    expect(freel?.properties).toMatchObject({
      elevation: 3318.1,
      prominence: 959,
      v: 3318.1,
      url: expect.stringMatching(/^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/),
    });
  });

  it("uses elevation for v on every peak that has one and leaves v off the rest", () => {
    for (const f of features) {
      const p = f.properties ?? {};
      if (p.elevation !== undefined) expect(p.v).toBe(p.elevation);
      else expect(p).not.toHaveProperty("v");
    }
    expect(features.find((f) => f.properties?.name === "Becker Peak")?.properties).not.toHaveProperty("v");
  });

  it("falls back to the native label when there is no English one, and drops a disambiguating bracket", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q10"), itemLabel: { value: "Q10" }, native: { value: "Cerro Torre" }, coord: { value: "Point(-73.1 -49.3)" }, elev: { value: "3128" } },
      { item: item("Q11"), itemLabel: { value: "Q11" }, coord: { value: "Point(-73 -49)" } },
      { item: item("Q12"), itemLabel: { value: "Ice Mountain (Colorado)" }, coord: { value: "Point(-106.437 38.9144)" } },
    ]);
    expect(out.map((f) => f.properties?.name)).toEqual(["Cerro Torre", "Ice Mountain"]);
    expect(out[0].properties).toMatchObject({ v: 3128 });
  });

  it("lists one summit once when Wikidata holds it twice at one point (Mount Watkins), keeping the one with the elevation", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q3322181"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-119.5176494 37.7828327)" }, elev: { value: "2590" } },
      { item: item("Q131056543"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-119.5176494 37.7828327)" } },
      { item: item("Q99"), itemLabel: { value: "Mount Watkins" }, coord: { value: "Point(-110 40)" } },
    ]);
    expect(out.map((f) => f.properties?.wikidata)).toEqual(["Q3322181", "Q99"]);
  });

  it("drops unnamed items, repeated ids, bad coordinates and impossible heights", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizePeaks([
      { item: item("Q1"), itemLabel: { value: "Q1" }, coord: { value: "Point(-120 39)" } },
      { item: item("Q2"), coord: { value: "Point(-120 39)" } },
      { item: item("Q3"), itemLabel: { value: "Good Peak" }, coord: { value: "Point(-120.5 39.5)" }, elev: { value: "2500.44" } },
      { item: item("Q3"), itemLabel: { value: "Good Peak" }, coord: { value: "Point(-120.5 39.5)" } },
      { item: item("Q4"), itemLabel: { value: "Odd Peak" }, coord: { value: "somewhere" } },
      { item: item("Q5"), itemLabel: { value: "Feet Peak" }, coord: { value: "Point(-121 40)" }, elev: { value: "10638" } },
    ]);
    expect(out.map((f) => f.properties?.name)).toEqual(["Good Peak", "Feet Peak"]);
    expect(out[0].properties).toMatchObject({ name: "Good Peak", elevation: 2500.4, v: 2500.4, wikidata: "Q3" });
    expect(out[1].properties).not.toHaveProperty("elevation");
  });
});

describe("parseOsmPeaks", () => {
  it("reads every named peak in the Leadville answer with its elevation in metres", () => {
    const peaks = parseOsmPeaks(leadvilleOsm);
    expect(peaks).toHaveLength(71);
    expect(peaks.every((p) => p.elevation !== undefined)).toBe(true);
    expect(peaks.find((p) => p.name === "Mount Elbert")).toMatchObject({ elevation: 4401.2, wikidata: "Q657225", kind: "peak", coords: [-106.4453787, 39.1177521] });
  });

  it("converts feet, prefers the English name, keeps the first of several values and rejects impossible heights", () => {
    const node = (id: number, tags: Record<string, string>) => ({ type: "node", id, lat: 39, lon: -106, tags });
    const peaks = parseOsmPeaks({
      elements: [
        { type: "count", id: 0, tags: { total: "5" } },
        node(1, { natural: "peak", name: "Pico", "name:en": "Peak One", ele: "14440 ft" }),
        node(2, { natural: "volcano", name: "Two", ele: "3000;2990", wikidata: "nope" }),
        node(3, { natural: "peak", name: "Three", ele: "14440" }),
        node(4, { natural: "peak", ele: "1000" }),
        node(5, { natural: "peak", name: "Five", ele: "1,234", prominence: "300 m" }),
      ],
    });
    expect(peaks.map((p) => [p.name, p.elevation, p.kind])).toEqual([
      ["Peak One", 4401.3, "peak"],
      ["Two", 3000, "volcano"],
      ["Three", undefined, "peak"],
      ["Five", 1234, "peak"],
    ]);
    expect(peaks[1]).not.toHaveProperty("wikidata");
    expect(peaks[3]).toMatchObject({ prominence: 300 });
  });

  it("returns nothing for a body without elements", () => {
    expect(parseOsmPeaks({ remark: "x" })).toEqual([]);
    expect(parseOsmPeaks(null)).toEqual([]);
  });
});

describe("matchName and units", () => {
  it("reads Mt. as Mount and ignores case and punctuation", () => {
    expect(matchName("Mt. Elbert")).toBe(matchName("Mount Elbert"));
    expect(matchName("Mt Elbert")).toBe("mount elbert");
    expect(matchName("Peak 13,762")).toBe("peak 13 762");
    expect(matchName("Mount Massive")).not.toBe(matchName("Mount Elbert"));
  });

  it("puts US units first in the United States only", () => {
    for (const p of [[-106.4, 39.1], [-120, 39.1], [-68.9, 46.9], [-82.9, 42.4], [-97.48, 25.92], [-149.9, 61.2], [-157.9, 21.3], [-134.4, 58.3]]) {
      expect(inUnitedStates(p), String(p)).toBe(true);
    }
    for (const p of [[-79.4, 43.7], [-123.1, 49.3], [-117.0, 32.4], [-106.4, 31.6], [-135.1, 60.7], [7.7, 45.9], [-73.6, 45.5]]) {
      expect(inUnitedStates(p), String(p)).toBe(false);
    }
    expect(usUnitsFirst(LEADVILLE)).toBe(true);
    expect(usUnitsFirst([6, 45, 8, 46])).toBe(false);
    expect(heightText(4401.2, true)).toBe("14,440 ft (4,401 m)");
    expect(heightText(4401.2, false)).toBe("4,401 m (14,440 ft)");
  });
});

describe("mergePeaks", () => {
  const wikidata = normalizePeaks(leadvilleWikidata.results.bindings);
  const osm = parseOsmPeaks(leadvilleOsm);
  const merged = mergePeaks(wikidata, osm, { usFirst: true });
  const props = merged.map((f) => f.properties ?? {});

  it("joins the two lists, keeping OSM-only and Wikidata-only peaks", () => {
    expect(wikidata).toHaveLength(16);
    expect(merged).toHaveLength(74);
    const count = (s: string) => props.filter((p) => p.sources === s).length;
    expect([count("both"), count("osm"), count("wikidata")]).toEqual([13, 58, 3]);
  });

  it("gives a joined peak the OSM point and elevation and the Wikidata name, prominence and link, with feet first in words", () => {
    const elbert = merged.find((f) => f.properties?.name === "Mount Elbert");
    expect(elbert?.geometry.coordinates).toEqual([-106.4453787, 39.1177521]);
    expect(elbert?.properties).toMatchObject({
      kind: "peak",
      elevation: 4401.2,
      elevationFt: 14440,
      elevationSource: "osm",
      elevationText: "14,440 ft (4,401 m)",
      prominence: 2765,
      prominenceText: "9,072 ft (2,765 m)",
      v: 4401.2,
      sources: "both",
      wikidata: "Q657225",
      url: "https://www.wikidata.org/wiki/Q657225",
      osmUrl: "https://www.openstreetmap.org/node/358915477",
    });
  });

  it("joins by name and distance when the OSM node has no wikidata tag, the Wikidata bracket dropped", () => {
    const ice = props.filter((p) => p.name === "Ice Mountain");
    expect(ice).toHaveLength(1);
    expect(ice[0]).toMatchObject({ sources: "both", elevation: 4220, elevationSource: "osm", wikidata: "Q14684616" });
  });

  it("keeps two same-named summits apart when they are over a kilometre apart (Winfield Peak)", () => {
    const winfield = props.filter((p) => p.name === "Winfield Peak");
    expect(winfield.map((p) => p.sources).sort()).toEqual(["osm", "wikidata"]);
  });

  it("sorts highest first, and a peak with no elevation last, saying so in words", () => {
    expect(props.slice(0, 3).map((p) => p.name)).toEqual(["Mount Elbert", "Mount Massive", "Mount Harvard"]);
    const heights = props.map((p) => (typeof p.elevation === "number" ? p.elevation : -1));
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    const last = props[props.length - 1];
    expect(last).toMatchObject({ name: "Sayres Benchmark", elevationText: "Not recorded", sources: "wikidata" });
    expect(last).not.toHaveProperty("v");
  });

  it("puts metres first outside the United States", () => {
    const metric = mergePeaks(wikidata, osm, { usFirst: false });
    expect(byName(metric, "Mount Elbert")).toMatchObject({ elevationText: "4,401 m (14,440 ft)" });
  });
});

describe("peaks layer", () => {
  it("declares global coverage, both licenses, no required env and the extrude hint", () => {
    expect(layer.id).toBe("peaks");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("ODbL (OpenStreetMap contributors); CC0 (Wikidata)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["OVERPASS_URL"]);
    expect(layer.maxAreaKm2).toBe(40_000);
    expect(layer.hardMaxAreaKm2).toBe(600_000);
    expect(layer.wide).toEqual({ orderBy: "prominence", rank: "most prominent", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.style).toMatchObject({ geometry: "point", extrude: "v", unit: "m", encode: { size: "elevation" } });
  });

  it("declares no time, a size legend by elevation, the five highest labelled and a clean contract", () => {
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
    expect(legendOf(layer)).toMatchObject({ kind: "size", field: "elevation", unit: "m" });
    expect(labelsOf(layer)).toEqual({ field: "name", max: 5, rankBy: "elevation" });
    expect(layer.attributes?.find((a) => a.key === "elevation")).toMatchObject({ type: "measure", encode: "size" });
    expect(contractProblems(layer)).toEqual([]);
  });

  it("asks Wikidata and Overpass once each and merges the answers (Leadville)", async () => {
    const stub = route(leadvilleWikidata, leadvilleOsm);
    const r = geojson(await layer.query(ctx(stub, "peaks:key", LEADVILLE), {}));
    expect(r.data.features).toHaveLength(74);
    expect(r.data.features[0].properties).toMatchObject({ name: "Mount Elbert", elevationText: "14,440 ft (4,401 m)" });
    expect(r.coverageNote).toBe("1 of 74 peaks have no elevation recorded");
    expect(r.sourceStatus).toEqual({ ok: true });
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.citation.source).toContain("Wikidata");

    expect(stub).toHaveBeenCalledTimes(2);
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][];
    const [, wdInit] = calls.find(([u]) => u === SPARQL_ENDPOINT) ?? [];
    expect(wdInit?.method).toBe("POST");
    expect((wdInit?.headers as Record<string, string>)["user-agent"]).toBe("WallyMap/0.1 (https://wallymap.vercel.app)");
    expect(new URLSearchParams(String(wdInit?.body)).get("query")).toContain("Point(-106.6 38.9)");
    expect(wdInit?.cacheKey).toBe("peaks:key");
    const [, opInit] = calls.find(([u]) => u !== SPARQL_ENDPOINT) ?? [];
    expect(decodeURIComponent(String(opInit?.body))).toContain('node["natural"~"^(peak|volcano)$"]["name"](38.9,-106.6,39.3,-106.2)');
  });

  it("the card leads with elevation in feet and metres and names its sources, and says when no elevation is recorded", async () => {
    const r = geojson(await layer.query(ctx(route(leadvilleWikidata, leadvilleOsm), undefined, LEADVILLE), {}));
    const card = (name: string) => {
      const f = r.data.features.find((x) => x.properties?.name === name);
      if (!f) throw new Error(name);
      return cardContent(f, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp });
    };
    const elbert = card("Mount Elbert");
    expect(elbert.measure).toMatchObject({ label: "Elevation", value: "14,440 ft (4,401 m)" });
    expect(elbert.facts.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "Prominence: 9,072 ft (2,765 m)",
      "Kind: Peak",
      "Elevation from: OpenStreetMap",
      "Listed in: OpenStreetMap and Wikidata",
    ]);
    expect(elbert.links.map((l) => l.label)).toEqual(["Wikidata", "OpenStreetMap"]);
    expect(elbert.details).toEqual([]);
    expect(card("Sayres Benchmark").measure).toMatchObject({ value: "Not recorded" });
  });

  it("falls back to Wikidata alone with a note when Overpass fails", async () => {
    const stub = route(leadvilleWikidata, () => new Response("busy", { status: 504 }));
    const r = geojson(await layer.query(ctx(stub, undefined, LEADVILLE), {}));
    expect(r.data.features).toHaveLength(16);
    expect(r.data.features.every((f) => f.properties?.sources === "wikidata")).toBe(true);
    expect(r.coverageNote).toContain("OpenStreetMap did not answer (Overpass returned 504), so these are Wikidata peaks only");
    expect(r.sourceStatus).toMatchObject({ ok: false, reason: "server-error", message: expect.stringContaining("Wikidata only") });
    expect(r.citation.source).not.toContain("OpenStreetMap");
  });

  it("falls back to OpenStreetMap alone with a note when Wikidata fails", async () => {
    const stub = route(() => new Response("boom", { status: 500 }), leadvilleOsm);
    const r = geojson(await layer.query(ctx(stub, undefined, LEADVILLE), {}));
    expect(r.data.features).toHaveLength(71);
    expect(r.coverageNote).toContain("Wikidata did not answer (Wikidata returned 500)");
    expect(r.sourceStatus).toMatchObject({ ok: false, reason: "server-error" });
  });

  it("says when Wikidata's 1,000 peak cap is hit", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => bindings[i % bindings.length]);
    const r = geojson(await layer.query(ctx(route({ results: { bindings: many } })), {}));
    expect(r.coverageNote).toContain("Wikidata sent its 1,000 highest peaks here");
  });

  it("keeps at most the 2,000 highest", async () => {
    // 110 m apart: distinct summits, not one drawn twice (dedupePeaks).
    const node = (i: number) => ({ type: "node", id: i, lat: 39 + i / 1e3, lon: -106, tags: { natural: "peak", name: `P${i}`, ele: String(1000 + i) } });
    const r = geojson(await layer.query(ctx(route({ results: { bindings: [] } }, { elements: Array.from({ length: 2100 }, (_, i) => node(i)) })), {}));
    expect(r.data.features).toHaveLength(MAX_FEATURES);
    expect(r.data.features[0].properties?.name).toBe("P2099");
    expect(r.coverageNote).toContain("Showing the 2,000 highest peaks");
  });

  it("says so when nothing is found", async () => {
    const r = geojson(await layer.query(ctx(route({ results: { bindings: [] } })), {}));
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toBe("No named peaks in OpenStreetMap or Wikidata for this area");
  });

  it("retries once when Wikidata says 429 and returns the answer", async () => {
    let calls = 0;
    const stub = route(() => (++calls === 1 ? new Response("slow", { status: 429 }) : json(fixture)));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(calls).toBe(2);
    expect(r.data.features).toHaveLength(uniqueItems);
  });

  it("returns Wikidata's error, hinted, when both sources fail", async () => {
    const both = (res: () => Response) => layer.query(ctx(vi.fn(async () => res())), {});
    expect(await both(() => new Response("slow down", { status: 429 }))).toEqual({
      error: "Wikidata is rate-limiting requests; try again in a minute",
      hint: "upstream",
    });
    expect(await both(() => new Response("boom", { status: 500 }))).toEqual({ error: "Wikidata returned 500", hint: "upstream" });
    expect(await both(() => new Response("<html>"))).toMatchObject({ hint: "upstream" });
    expect(await both(() => json({ head: {} }))).toEqual({ error: "Wikidata returned an unexpected response", hint: "upstream" });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(await layer.query(ctx(slow), {})).toMatchObject({ error: expect.stringContaining("timed out"), hint: "upstream" });
  });

  it("rejects a view over the hard cap (600,000 km², a whole range) through runLayer", async () => {
    const r = await runLayer("peaks", { bbox: [-115, 33, -103, 45] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 600000 km²$/) });
  });

  it("answers a Colorado box of about 155,000 km² wide from Wikidata alone: the most prominent, with a note", async () => {
    const stub = vi.fn(async () => json(fixture));
    vi.stubGlobal("fetch", stub);
    try {
      const r = await runLayer("peaks", { bbox: [-108.5, 37, -104.5, 41], zoom: 6 });
      expect(r.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const init = stub.mock.calls[0] as unknown as [string, RequestInit];
      const query = new URLSearchParams(String(init[1].body)).get("query") ?? "";
      expect(query).toContain("ORDER BY DESC(?prom)\nLIMIT 1050");
      expect(r.body).toMatchObject({
        coverageNote: expect.stringContaining(
          `Showing all ${uniqueItems} in this wide view (ranked by prominence); only Wikidata peaks with a recorded prominence are listed at this scale`,
        ),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps at most the wide limit and leaves the truncation note to run.ts", async () => {
    const item = (i: number) => ({
      item: { value: `http://www.wikidata.org/entity/Q${i}` },
      itemLabel: { value: `Peak ${i}` },
      // 110 m apart: distinct summits, not one drawn twice (dedupePeaks).
      coord: { value: `Point(-106 ${39 + i / 1e3})` },
      prom: { value: String(3000 - i) },
    });
    const stub = vi.fn(async () => json({ results: { bindings: Array.from({ length: 1050 }, (_, i) => item(i)) } }));
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, {}));
    expect(stub).toHaveBeenCalledTimes(1);
    expect(r.data.features).toHaveLength(1000);
    expect(r.data.features[0].properties).toMatchObject({ name: "Peak 0", prominence: 3000 });
    expect(r.coverageNote).toContain("only Wikidata peaks with a recorded prominence are listed at this scale");
  });
});

describe("dedupePeaks", () => {
  const peak = (name: string, lon: number, lat: number, props: Record<string, string | number> = {}) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: { name, ...props } as Record<string, string | number>,
  });

  it("draws one peak per spot: within 40 m, or 200 m under one name, the one with more data stays and names the other", () => {
    const out = dedupePeaks([
      // Chamonix, live 2026-10-23: a Wikidata item and its summit's OSM node 10 m apart under two names.
      peak("Grandes Jorasses", 6.98822, 45.86889, { sources: "wikidata", elevation: 4208, wikidata: "Q30453" }),
      peak("Pointe Walker", 6.98834, 45.86885, { sources: "both", elevation: 4208, wikidata: "Q2403858", osmId: 1 }),
      // One name 86 m apart.
      peak("La Vierge", 6.9, 45.9, { sources: "wikidata", elevation: 3244, wikidata: "Q31640409" }),
      peak("La Vierge", 6.9011, 45.9, { sources: "osm", elevation: 3244, osmId: 2, wikidata: "Q136377138" }),
      // Two names 120 m apart: two summits.
      peak("Aiguille A", 6.8, 45.95, { sources: "osm", elevation: 3000, osmId: 3 }),
      peak("Aiguille B", 6.8015, 45.95, { sources: "osm", elevation: 2990, osmId: 4 }),
    ]);
    expect(out.map((f) => f.properties?.name)).toEqual(["Pointe Walker", "La Vierge", "Aiguille A", "Aiguille B"]);
    expect(out[0].properties).toMatchObject({ alsoNamed: "Grandes Jorasses" });
    expect(out[1].properties).not.toHaveProperty("alsoNamed");
    const card = cardContent(out[0], { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.facts.find((f) => f.label === "Also listed as")?.value).toBe("Grandes Jorasses");
  });
});

describe("lowest point (input lowest)", () => {
  /** A Death-Valley-like box: a basin floor at -84 m (the elevation model's reading), rising to 1,000 m at the edges. */
  const DV: [number, number, number, number] = [-117.3, 36.1, -116.5, 36.8];
  const FLOOR: [number, number] = [-116.83, 36.25];
  const ground = (lon: number, lat: number) => Math.min(1000, -84 + Math.hypot(lon - FLOOR[0], lat - FLOOR[1]) * 1500);
  const telescope = {
    item: { value: "http://www.wikidata.org/entity/Q916811" },
    itemLabel: { value: "Telescope Peak" },
    coord: { value: "Point(-117.0892 36.1699)" },
    elev: { value: "3366" },
  };
  const named = (label: string, q: string, [lon, lat]: [number, number], elev: number) => ({
    item: { value: `http://www.wikidata.org/entity/${q}` },
    itemLabel: { value: label },
    coord: { value: `Point(${lon} ${lat})` },
    elev: { value: String(elev) },
  });
  /** Wikidata answers the lowest-places query with `lows` and the peaks query with Telescope Peak; Overpass with nothing. */
  function stub(lows: unknown[]) {
    return vi.fn(async (url: string, init?: { body?: string }) => {
      if (url !== SPARQL_ENDPOINT) return json({ elements: [] });
      const query = new URLSearchParams(init?.body ?? "").get("query") ?? "";
      return json({ results: { bindings: /ASC\(\?elev\)/.test(query) ? lows : [telescope] } });
    });
  }
  afterEach(() => useTileSource());

  it("names the lowest point after the recorded place that agrees with the elevation model, and leads the note with both", async () => {
    useTileSource(syntheticTiles(ground));
    const lows = [
      // A record far below the ground the model reads at its spot: skipped.
      named("Bad record", "Q1", [-116.9, 36.3], -300),
      named("Badwater Basin", "Q799720", [-116.8258, 36.2503], -86),
      named("Furnace Creek", "Q2", [-116.87, 36.46], -58),
    ];
    const r = geojson(await layer.query(ctx(stub(lows), "k", DV), { lowest: true }));
    const low = r.data.features.find((f) => f.properties?.kind === "lowest");
    expect(low?.properties).toMatchObject({ name: "Badwater Basin", elevation: -86, elevationFt: -282, elevationText: "-282 ft (-86 m)", elevationSource: "wikidata" });
    expect(r.data.features.at(-1)).toBe(low);
    expect(r.coverageNote).toMatch(/^Highest: Telescope Peak, 11,043 ft \(3,366 m\); lowest: Badwater Basin, -282 ft \(-86 m\), 282 ft below sea level at -116\.8258, 36\.2503/);
    expect(r.legend).toMatchObject({ kind: "size", title: "Elevation" });
    const card = cardContent(low!, { card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure).toMatchObject({ label: "Elevation", value: "-282 ft (-86 m)" });
    expect(card.facts.find((f) => f.label === "Kind")?.value).toBe("Lowest point");
  });

  it("falls back to the elevation model's floor when no recorded place agrees", async () => {
    useTileSource(syntheticTiles(ground));
    const r = geojson(await layer.query(ctx(stub([named("Furnace Creek", "Q2", [-116.87, 36.46], -58)]), "k", DV), { lowest: true }));
    const low = r.data.features.find((f) => f.properties?.kind === "lowest");
    expect(low?.properties).toMatchObject({ name: "Lowest point in view", elevationSource: "dem" });
    expect(Number(low?.properties?.elevation)).toBeLessThan(-60);
  });

  it("adds nothing without lowest, and still keys the answer by elevation", async () => {
    const r = geojson(await layer.query(ctx(stub([]), "k", DV), {}));
    expect(r.data.features.some((f) => f.properties?.kind === "lowest")).toBe(false);
    expect(r.legend?.title).toBe("Elevation");
  });
});

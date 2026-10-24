import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { cardContent } from "@/lib/render/card";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
import { WIKIMEDIA_USER_AGENT } from "./_shared/wikimedia";
import layer, {
  GEOMETRY_MAX_KM2,
  LIMIT,
  OSM_LIMIT,
  SPARQL_ENDPOINT,
  areaText,
  assembleRings,
  lakesByNameQuery,
  lakesQuery,
  mergeLakes,
  nameVariants,
  normalizeLakes,
  osmLakeShapesQuery,
  osmLakesQuery,
  parseOsmLakes,
  ringAreaKm2,
  shapeAreaKm2,
  volumeText,
  wideLakesQuery,
} from "./lakes";
import fixture from "./__fixtures__/lakes.tahoe.json";
import tahoeWikidata from "./__fixtures__/lakes.tahoe.wikidata.json";
import tahoeOsm from "./__fixtures__/lakes.tahoe.osm.json";

/**
 * lakes.tahoe.json is a real Wikidata SPARQL answer for the box -120.2,38.8,-119.8,39.2 (recorded 2026-10-09, no name filter).
 * lakes.tahoe.wikidata.json and lakes.tahoe.osm.json are real answers for the audit's box -120.25,38.93,-119.95,39.23 (recorded
 * 2026-10-18): the Overpass one keeps every lake's tags and centre but only three shorelines, Lake Tahoe's thinned to every 40th
 * point (member ends kept, so it still closes), Cascade Lake (a way) and Eagle Lake (a relation with an island) whole.
 */
const TAHOE: [number, number, number, number] = [-120.2, 38.8, -119.8, 39.2];
const AUDIT_BOX: [number, number, number, number] = [-120.25, 38.93, -119.95, 39.23];
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

describe("lakesQuery", () => {
  it("puts the corners as Point(lon lat), asks for normalised values and caps the rows", () => {
    const q = lakesQuery(TAHOE);
    expect(q).toContain('wikibase:cornerSouthWest "Point(-120.2 38.8)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:cornerNorthEast "Point(-119.8 39.2)"^^geo:wktLiteral');
    expect(q).toContain("?ds psn:P4511/wikibase:quantityAmount ?depthM");
    // Crater Lake's 350 m average must not be read as a maximum, and the average is read on its own.
    expect(q).toContain("FILTER NOT EXISTS { ?ds pq:P1013 ?dc . FILTER(?dc IN (wd:Q202785");
    expect(q).toContain("?ms pq:P1013 ?mc ; psn:P4511/wikibase:quantityAmount ?meanM");
    expect(q).toContain("(MAX(?meanM) AS ?mean)");
    expect(q).toContain("wd:Q23397");
    expect(q).toContain("wd:Q131681");
    expect(q).toContain(`LIMIT ${LIMIT}`);
    expect(q).not.toContain("CONTAINS");
  });

  it("adds a lower-cased, escaped name filter", () => {
    expect(lakesQuery(TAHOE, "  Tahoe ")).toContain('FILTER(CONTAINS(LCASE(STR(?label)), "tahoe"))');
    expect(lakesQuery(TAHOE, 'a"b\\c')).toContain('"a\\"b\\\\c"');
  });
});

describe("wideLakesQuery", () => {
  it("keeps the box query and name filter but ranks by area alone, with slack for repeated items", () => {
    const q = wideLakesQuery([-94.4, 45.4, -91, 48], 1000, "mille");
    expect(q).toContain('wikibase:cornerSouthWest "Point(-94.4 45.4)"^^geo:wktLiteral');
    expect(q).toContain('FILTER(CONTAINS(LCASE(STR(?label)), "mille"))');
    expect(q).not.toContain("DESC(?depth)");
    expect(q.endsWith("ORDER BY DESC(?area)\nLIMIT 1050")).toBe(true);
  });
});

describe("osmLakesQuery", () => {
  it("asks for named standing water (untagged or lake, reservoir, pond, oxbow, lagoon) with centres, and shorelines when asked", () => {
    const q = osmLakesQuery(AUDIT_BOX, { geometry: true });
    expect(q).toBe(
      '[out:json][timeout:20];(nwr["natural"="water"]["name"][!"water"](38.93,-120.25,39.23,-119.95);' +
        'nwr["natural"="water"]["name"]["water"~"^(lake|reservoir|pond|oxbow|lagoon)$"](38.93,-120.25,39.23,-119.95);)->.l;' +
        `.l out count;.l out tags center ${OSM_LIMIT};way.l->.w;.w out ids geom ${OSM_LIMIT};rel.l->.r;.r out skel geom ${OSM_LIMIT};`,
    );
    expect(osmLakesQuery(AUDIT_BOX, { geometry: false })).not.toContain("geom");
  });

  it("filters by name case-insensitively, with regex characters read as any character", () => {
    expect(osmLakesQuery(AUDIT_BOX, { name: " Tahoe ", geometry: false })).toContain('["name"]["name"~"Tahoe",i][!"water"]');
    expect(osmLakesQuery(AUDIT_BOX, { name: 'Lake "A" (1)', geometry: false })).toContain('["name"~"Lake .A. .1.",i]');
  });
});

describe("shoreline areas", () => {
  const square = (lat: number, lon: number, d: number) => [
    { lat, lon },
    { lat, lon: lon + d },
    { lat: lat + d, lon: lon + d },
    { lat: lat + d, lon },
    { lat, lon },
  ];

  it("measures a ring on a local flat projection", () => {
    // 0.01° square at the equator: 1.1132 km by 1.1057 km.
    expect(ringAreaKm2(square(0, 0, 0.01))).toBeCloseTo(1.2309, 3);
    expect(ringAreaKm2(square(60, 0, 0.01))).toBeCloseTo(0.6155, 3);
  });

  it("joins way pieces end to end (either direction) into rings and drops open leftovers", () => {
    const s = square(0, 0, 0.01);
    const rings = assembleRings([s.slice(0, 3), s.slice(2).reverse(), [{ lat: 5, lon: 5 }, { lat: 6, lon: 6 }]]);
    expect(rings).toHaveLength(1);
    expect(ringAreaKm2(rings[0])).toBeCloseTo(1.2309, 3);
  });

  it("takes islands out of the outer rings", () => {
    const km2 = shapeAreaKm2([
      { role: "outer", geometry: square(0, 0, 0.02) },
      { role: "inner", geometry: square(0.005, 0.005, 0.01) },
    ]);
    expect(km2).toBeCloseTo(4 * 1.2309 - 1.2309, 2);
    expect(shapeAreaKm2([{ role: "inner", geometry: square(0, 0, 0.01) }])).toBeUndefined();
  });
});

describe("parseOsmLakes", () => {
  const lakes = parseOsmLakes(tahoeOsm);

  it("lists every named lake in the Tahoe answer at its centre, with kinds in the layer's words", () => {
    expect(lakes).toHaveLength(51);
    expect(new Set(lakes.map((l) => l.kind))).toEqual(new Set(["lake", "reservoir", "pond"]));
    expect(lakes.find((l) => l.name === "Lake Tahoe")).toMatchObject({ type: "relation", id: 1823287, center: [-120.044998, 39.0885933] });
  });

  it("measures the lakes whose shorelines came back: a way, a relation with an island, and Tahoe's 61 member ways", () => {
    const area = (name: string) => lakes.find((l) => l.name === name)?.areaKm2;
    expect(area("Cascade Lake")).toBe(0.857);
    expect(area("Eagle Lake")).toBe(0.0739);
    // Thinned to every 40th point it reads 492 km² (the full shoreline reads 495; the published figure is 496).
    expect(area("Lake Tahoe")).toBe(492);
    expect(lakes.filter((l) => l.areaKm2 !== undefined)).toHaveLength(3);
  });

  it("returns nothing for a body without elements", () => {
    expect(parseOsmLakes({})).toEqual([]);
  });
});

describe("words and units", () => {
  it("gives areas in acres or square miles first in the US and km² first elsewhere", () => {
    expect(areaText(495, true)).toBe("191 mi² (495 km²)");
    expect(areaText(0.857, true)).toBe("212 acres (0.86 km²)");
    expect(areaText(0.0101, true)).toBe("2.5 acres (0.01 km²)");
    expect(areaText(495, false)).toBe("495 km² (191 mi²)");
  });

  it("gives volumes in acre-feet first in the US and in km³ or million m³ elsewhere", () => {
    expect(volumeText(150, true)).toBe("122 million acre-feet (150 km³)");
    expect(volumeText(0.0123, false)).toBe("12.3 million m³ (9,972 acre-feet)");
  });
});

describe("normalizeLakes", () => {
  const features = normalizeLakes(bindings);

  it("turns Lake Tahoe into a point with its measures in friendly units", () => {
    expect(bindings.length).toBeGreaterThan(uniqueItems);
    expect(features).toHaveLength(uniqueItems);
    const tahoe = features.find((f) => f.properties?.name === "Lake Tahoe");
    expect(tahoe?.geometry).toEqual({ type: "Point", coordinates: [-120.033333333, 39.083333333] });
    expect(tahoe?.properties).toMatchObject({
      depthM: 501,
      kind: "lake",
      areaKm2: 502,
      elevationM: 1899.5,
      volumeKm3: 150,
      wikipedia: "https://en.wikipedia.org/wiki/Lake_Tahoe",
      wikidata: "Q169962",
      url: "https://www.wikidata.org/wiki/Q169962",
    });
  });

  it("leaves depth off when Wikidata has none, and marks reservoirs", () => {
    const cascade = features.find((f) => f.properties?.name === "Cascade Lake");
    expect(cascade?.properties).toMatchObject({ kind: "lake" });
    expect(cascade?.properties).not.toHaveProperty("depthM");
    expect(cascade?.properties).not.toHaveProperty("areaKm2");
    expect(features.find((f) => f.properties?.name === "Spooner Lake")?.properties?.kind).toBe("reservoir");
  });

  it("drops unnamed items, repeated ids and bad coordinates, ignores non-positive numbers and drops a disambiguating bracket", () => {
    const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
    const out = normalizeLakes([
      { item: item("Q1"), label: { value: "Q1" }, coord: { value: "Point(-120 39)" } },
      { item: item("Q2"), coord: { value: "Point(-120 39)" } },
      { item: item("Q3"), label: { value: "Good Lake (Somewhere)" }, coord: { value: "Point(-120.5 39.5)" }, depth: { value: "12.34" }, area: { value: "0" } },
      { item: item("Q3"), label: { value: "Good Lake" }, coord: { value: "Point(-120.5 39.5)" } },
      { item: item("Q4"), label: { value: "Odd Lake" }, coord: { value: "somewhere" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].properties).toMatchObject({ name: "Good Lake", depthM: 12.3, wikidata: "Q3" });
    expect(out[0].properties).not.toHaveProperty("areaKm2");
  });
});

describe("mergeLakes", () => {
  const merged = mergeLakes(normalizeLakes(tahoeWikidata.results.bindings), parseOsmLakes(tahoeOsm), true);
  const props = merged.map((f) => f.properties ?? {});

  it("joins all five Wikidata lakes to OSM ones and keeps the other 46 OSM lakes", () => {
    expect(merged).toHaveLength(51);
    expect(props.filter((p) => p.sources === "both")).toHaveLength(5);
    expect(props.filter((p) => p.sources === "osm")).toHaveLength(46);
  });

  it("gives Lake Tahoe the OSM centre and measured area with Wikidata's depth, volume and elevation, in US words first", () => {
    const tahoe = merged[0];
    expect(tahoe.geometry.coordinates).toEqual([-120.044998, 39.0885933]);
    expect(tahoe.properties).toMatchObject({
      name: "Lake Tahoe",
      kind: "lake",
      areaKm2: 492,
      v: 492,
      areaSource: "osm",
      depthM: 501,
      depthText: "1,644 ft (501 m)",
      areaText: "190 mi² (492 km²)",
      elevationText: "6,232 ft (1,900 m)",
      volumeText: "122 million acre-feet (150 km³)",
      sources: "both",
      osmUrl: "https://www.openstreetmap.org/relation/1823287",
      wikipedia: "https://en.wikipedia.org/wiki/Lake_Tahoe",
    });
  });

  it("joins by name and distance when OSM carries no wikidata tag, drops Wikidata's bracket, and keeps reservoirs as reservoirs", () => {
    const eagle = props.find((p) => p.name === "Eagle Lake");
    expect(eagle).toMatchObject({ sources: "both", wikidata: "Q5325151", areaKm2: 0.0739, areaText: "18 acres (0.074 km²)" });
    expect(props.find((p) => p.name === "Quail Lake")).toMatchObject({ kind: "reservoir", sources: "both" });
  });

  it("sorts largest first, lakes with no area last, and says 'Not recorded' for a missing depth", () => {
    expect(props.slice(0, 3).map((p) => p.name)).toEqual(["Lake Tahoe", "Cascade Lake", "Eagle Lake"]);
    expect(props[3].v).toBeNull();
    expect(props.find((p) => p.name === "Cascade Lake")).toMatchObject({ depthText: "Not recorded" });
  });
});

describe("lakes layer", () => {
  it("declares global coverage, both licenses, no required env, a name input and the size and cluster hints", () => {
    expect(layer.id).toBe("lakes");
    expect(layer.coverage).toBe("global");
    expect(layer.license).toBe("ODbL (OpenStreetMap contributors); CC0 (Wikidata)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.optionalEnv).toEqual(["OVERPASS_URL"]);
    expect(layer.maxAreaKm2).toBe(20_000);
    expect(layer.hardMaxAreaKm2).toBeUndefined();
    expect(layer.wide).toEqual({ orderBy: "area", limit: 1000 });
    expect(layer.input.parse({})).toEqual({});
    expect(layer.input.parse({ name: " tahoe " })).toEqual({ name: "tahoe" });
    expect(layer.style).toMatchObject({ geometry: "point", cluster: true, unit: "km²", encode: { size: "areaKm2" } });
  });

  it("declares no time, a size legend by area, five lakes labelled deepest first and a clean contract", () => {
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
    expect(legendOf(layer)).toMatchObject({ kind: "size", field: "areaKm2", unit: "km²" });
    expect(labelsOf(layer)).toEqual({ field: "label", max: 5, rankBy: "labelRank" });
    expect(contractProblems(layer)).toEqual([]);
  });

  it("asks Wikidata and Overpass (with shorelines, in a small view) once each and merges the answers", async () => {
    const stub = route(tahoeWikidata, tahoeOsm);
    const r = geojson(await layer.query(ctx(stub, "lakes:key", AUDIT_BOX), { name: "tahoe" }));
    expect(r.data.features).toHaveLength(51);
    expect(r.coverageNote).toBe("1 of 51 lakes have a recorded maximum depth");
    expect(r.sourceStatus).toEqual({ ok: true });
    expect(r.citation.source).toContain("OpenStreetMap");
    expect(r.citation.source).toContain("Wikidata");

    expect(stub).toHaveBeenCalledTimes(2);
    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string }][];
    const [, wdInit] = calls.find(([u]) => u === SPARQL_ENDPOINT) ?? [];
    expect(wdInit?.method).toBe("POST");
    expect((wdInit?.headers as Record<string, string>)["user-agent"]).toBe(WIKIMEDIA_USER_AGENT);
    const query = new URLSearchParams(String(wdInit?.body)).get("query");
    expect(query).toContain("Point(-120.25 38.93)");
    expect(query).toContain('"tahoe"');
    expect(wdInit?.cacheKey).toBe("lakes:key");
    const [, opInit] = calls.find(([u]) => u !== SPARQL_ENDPOINT) ?? [];
    const ql = decodeURIComponent(String(opInit?.body));
    expect(ql).toContain('["name"~"tahoe",i]');
    expect(ql).toContain("out skel geom");
  });

  it("measures lakes in a view over 4,000 km² from shorelines fetched in a second query, so every mapped outline ranks by area", async () => {
    // The audit's z9.5 view of Tahoe (about 8,600 km²) listed 332 lakes with 2 areas (Wikidata's): Rank by Area listed two.
    const elements = tahoeOsm.elements as Record<string, unknown>[];
    const tagged = { ...tahoeOsm, elements: elements.filter((e) => "tags" in e) };
    const shorelines = { elements: elements.filter((e) => !("tags" in e)) };
    const stub = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === SPARQL_ENDPOINT) return json(tahoeWikidata);
      return json(decodeURIComponent(String(init?.body)).includes("out count") ? tagged : shorelines);
    });
    const r = geojson(await layer.query(ctx(stub, undefined, [-120.6, 38.6, -119.6, 39.5]), {}));
    expect(GEOMETRY_MAX_KM2).toBe(4_000);
    const bodies = (stub.mock.calls as unknown as [string, RequestInit][]).filter(([u]) => u !== SPARQL_ENDPOINT).map(([, i]) => decodeURIComponent(String(i?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies.find((b) => b.includes("out count"))).not.toContain("geom");
    expect(bodies.find((b) => !b.includes("out count"))).toContain("out skel geom");
    const area = (name: string) => r.data.features.find((f) => f.properties?.name === name)?.properties?.areaKm2;
    expect(area("Lake Tahoe")).toBe(492);
    expect(area("Cascade Lake")).toBe(0.857);
    expect(area("Eagle Lake")).toBe(0.0739);
    expect(r.coverageNote).not.toContain("shorelines");
  });

  it("still lists the lakes, unmeasured and with a note, when the shoreline query fails in a wide view", async () => {
    const elements = tahoeOsm.elements as Record<string, unknown>[];
    const tagged = { ...tahoeOsm, elements: elements.filter((e) => "tags" in e) };
    const stub = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === SPARQL_ENDPOINT) return json(tahoeWikidata);
      return decodeURIComponent(String(init?.body)).includes("out count") ? json(tagged) : new Response("busy", { status: 504 });
    });
    const r = geojson(await layer.query(ctx(stub, undefined, [-120.6, 38.6, -119.6, 39.5]), {}));
    expect(r.data.features).toHaveLength(51);
    expect(r.coverageNote).toContain("the shorelines did not come back");
  });

  it("asks for the same lakes' shorelines alone in the second query", () => {
    const q = osmLakeShapesQuery(AUDIT_BOX, "tahoe");
    expect(q).toContain('["name"~"tahoe",i]');
    expect(q).toContain("->.l;way.l->.w;.w out ids geom 2000;rel.l->.r;.r out skel geom 2000;");
    expect(q).not.toContain("out count");
    expect(q).not.toContain("out tags");
  });

  it("the card leads with depth in feet and metres, spells out the kind, and says when the depth is not recorded", async () => {
    const r = geojson(await layer.query(ctx(route(tahoeWikidata, tahoeOsm), undefined, AUDIT_BOX), {}));
    const card = (name: string) => {
      const f = r.data.features.find((x) => x.properties?.name === name);
      if (!f) throw new Error(name);
      return cardContent(f, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp });
    };
    const tahoe = card("Lake Tahoe");
    expect(tahoe.measure).toMatchObject({ label: "Maximum depth", value: "1,644 ft (501 m)" });
    expect(tahoe.facts.map((f) => `${f.label}: ${f.value}`)).toEqual([
      "Kind: Lake (natural standing water)",
      "Area: 190 mi² (492 km²)",
      "Surface elevation: 6,232 ft (1,900 m)",
      "Volume: 122 million acre-feet (150 km³)",
      "Area from: OpenStreetMap shoreline",
      "Listed in: OpenStreetMap and Wikidata",
    ]);
    expect(tahoe.links.map((l) => l.label)).toEqual(["Wikipedia", "Wikidata", "OpenStreetMap"]);
    expect(tahoe.details).toEqual([]);
    const spooner = card("Quail Lake");
    expect(spooner.measure).toMatchObject({ value: "Not recorded" });
    expect(spooner.facts[0]).toMatchObject({ label: "Kind", value: "Reservoir (water held back by a dam)" });
  });

  it("falls back to Wikidata alone with a note when Overpass fails", async () => {
    const stub = route(tahoeWikidata, () => new Response("busy", { status: 429 }));
    const r = geojson(await layer.query(ctx(stub, undefined, AUDIT_BOX), {}));
    expect(r.data.features).toHaveLength(5);
    expect(r.coverageNote).toContain("OpenStreetMap did not answer (Overpass returned 429), so only lakes listed in Wikidata are shown");
    expect(r.sourceStatus).toMatchObject({ ok: false, reason: "rate-limited" });
  });

  it("falls back to OpenStreetMap alone with a note when Wikidata fails", async () => {
    const stub = route(() => new Response("boom", { status: 500 }), tahoeOsm);
    const r = geojson(await layer.query(ctx(stub, undefined, AUDIT_BOX), {}));
    expect(r.data.features).toHaveLength(51);
    expect(r.coverageNote).toContain("Wikidata did not answer (Wikidata returned 500), so no depths");
    expect(r.sourceStatus).toMatchObject({ ok: false, reason: "server-error" });
  });

  it("says when Wikidata's 500 lake cap is hit", async () => {
    const many = Array.from({ length: LIMIT }, (_, i) => bindings[i % bindings.length]);
    const r = geojson(await layer.query(ctx(route({ results: { bindings: many } })), {}));
    expect(r.coverageNote).toContain(`Wikidata sent its ${LIMIT} largest lakes`);
  });

  it("says so when nothing is found, naming the filter", async () => {
    const stub = route({ results: { bindings: [] } });
    expect(geojson(await layer.query(ctx(stub, undefined, AUDIT_BOX), {})).coverageNote).toBe("No named lakes in this area");
    expect(geojson(await layer.query(ctx(stub, undefined, AUDIT_BOX), { name: "zzz" })).coverageNote).toBe("No lake named like “zzz” in this area");
  });

  it("retries Wikidata once after a 429 and uses the second answer", async () => {
    let n = 0;
    const stub = route(() => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : json(fixture)));
    const r = geojson(await layer.query(ctx(stub), {}));
    expect(n).toBe(2);
    expect(r.data.features).toHaveLength(uniqueItems);
  });

  it("returns Wikidata's error, hinted, when both sources fail", async () => {
    const both = (res: () => Response) => layer.query(ctx(vi.fn(async () => res())), {});
    expect(await both(() => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))).toEqual({
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

  it("rejects a view over the hard cap (4 x 20,000 km²) through runLayer", async () => {
    const r = await runLayer("lakes", { bbox: [-110, 35, -105, 40] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/zoom in to under 80000 km²$/) });
  });

  it("answers a Minnesota box of about 70,000 km² wide from Wikidata alone, keeping the name filter", async () => {
    const stub = vi.fn(async () => json(fixture));
    vi.stubGlobal("fetch", stub);
    try {
      const r = await runLayer("lakes", { bbox: [-94.4, 45.4, -91, 48], zoom: 6, input: { name: "tahoe" } });
      expect(r.status).toBe(200);
      expect(stub).toHaveBeenCalledTimes(1);
      const init = stub.mock.calls[0] as unknown as [string, RequestInit];
      const query = new URLSearchParams(String(init[1].body)).get("query") ?? "";
      expect(query).toContain('"tahoe"');
      expect(query).toContain("ORDER BY DESC(?area)\nLIMIT 1050");
      expect(r.body).toMatchObject({
        coverageNote: `Showing all ${uniqueItems} in this wide view (ranked by area); only lakes listed in Wikidata are shown at this scale; 1 of 27 lakes have a recorded maximum depth`,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps at most the wide limit in wide mode", async () => {
    const row = (i: number) => ({
      item: { value: `http://www.wikidata.org/entity/Q${i}` },
      label: { value: `Lake ${i}` },
      coord: { value: "Point(-93 46)" },
      area: { value: String(1e9 - i) },
    });
    const stub = vi.fn(async () => json({ results: { bindings: Array.from({ length: 1050 }, (_, i) => row(i)) } }));
    const r = geojson(await layer.query({ ...ctx(stub), wide: true, wideStrategy: layer.wide }, {}));
    expect(r.data.features).toHaveLength(1000);
    expect(r.coverageNote).not.toContain("largest lakes");
  });
});

describe("mean depth, depth labels and a namesake elsewhere", () => {
  const item = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
  /** Crater Lake as Wikidata holds it (2026-10-23): 594 m maximum and 350 m average under P4511, 1,883 m, 17.46 km³. */
  const crater = {
    item: item("Q329266"),
    label: { value: "Crater Lake" },
    coord: { value: "Point(-122.108 42.944)" },
    depth: { value: "594" },
    mean: { value: "350" },
    area: { value: "53200000" },
    elev: { value: "1883" },
    vol: { value: "17460000000" },
  };
  const box: [number, number, number, number] = [-123.7, 45.28, -123.5, 45.42];
  const pond = { elements: [{ type: "way", id: 1412652756, center: { lat: 45.3496, lon: -123.6012 }, tags: { natural: "water", name: "Lake Tahoe" } }] };
  /** Wikidata answers the box query with nothing and the by-name query with `byName`; Overpass with the namesake pond. */
  const namesake = (byName: unknown[]) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== SPARQL_ENDPOINT) return json(pond);
      const query = new URLSearchParams(String(init?.body)).get("query") ?? "";
      return json({ results: { bindings: query.includes("VALUES ?label") ? byName : [] } });
    });

  it("reads the average depth apart from the maximum and drops an average as deep as the maximum", () => {
    const [f] = normalizeLakes([crater]);
    expect(f.properties).toMatchObject({ depthM: 594, meanDepthM: 350 });
    const [slip] = normalizeLakes([{ ...crater, mean: { value: "594" } }]);
    expect(slip.properties).not.toHaveProperty("meanDepthM");
  });

  it("puts mean depth on the card after area and names deep lakes with their depth before larger shallow ones", () => {
    const merged = mergeLakes(normalizeLakes([crater]), [{ type: "way", id: 1, name: "Big Pond", kind: "pond", center: [-122.1, 42.9], areaKm2: 900 }], true);
    const deep = merged.find((f) => f.properties?.name === "Crater Lake");
    const big = merged.find((f) => f.properties?.name === "Big Pond");
    expect(deep?.properties).toMatchObject({ label: "Crater Lake, 1,949 ft deep", meanDepthText: "1,148 ft (350 m)" });
    expect(big?.properties).toMatchObject({ label: "Big Pond", labelRank: 900 });
    expect(Number(deep?.properties?.labelRank)).toBeGreaterThan(Number(big?.properties?.labelRank));
    if (!deep) throw new Error("Crater Lake");
    const card = cardContent(deep, { unit: layer.style.unit, card: layer.card, fieldHelp: layer.fieldHelp });
    expect(card.measure).toMatchObject({ label: "Maximum depth", value: "1,949 ft (594 m)" });
    expect(card.facts.map((x) => x.label).slice(0, 5)).toEqual(["Kind", "Area", "Mean depth", "Surface elevation", "Volume"]);
    expect(mergeLakes(normalizeLakes([crater]), [], false)[0].properties?.label).toBe("Crater Lake, 594 m deep");
  });

  it("spells a lake's name the ways Wikidata labels it and asks for those labels anywhere", () => {
    expect(nameVariants(" lake  tahoe ")).toEqual(["lake tahoe", "Lake Tahoe", "Tahoe"]);
    expect(nameVariants("Crater")).toEqual(["Crater", "Lake Crater", "Crater Lake"]);
    const q = lakesByNameQuery("Lake Tahoe");
    expect(q).toContain('VALUES ?label { "Lake Tahoe"@en "Tahoe"@en }');
    expect(q).toContain("wd:Q23397");
    expect(q).not.toContain("wikibase:box");
  });

  it("says where the well-known lake of that name is when the box holds only a namesake pond", async () => {
    // The 2026-10-23 eval: "Lake Tahoe" geocoded to a 2-acre pond in Tillamook County, Oregon.
    const tahoe = { item: item("Q169962"), label: { value: "Lake Tahoe" }, coord: { value: "Point(-120.033333333 39.083333333)" }, depth: { value: "501" }, area: { value: "502000000" } };
    const stub = namesake([tahoe]);
    const r = geojson(await layer.query(ctx(stub, "lakes:k", box), { name: "Lake Tahoe" }));
    expect(r.data.features).toHaveLength(1);
    expect(r.coverageNote).toBe(
      "0 of 1 lakes have a recorded maximum depth; Wikidata lists a larger Lake Tahoe elsewhere, at 39.083, -120.033: maximum depth 1,644 ft (501 m), " +
        "area 194 mi² (502 km²). This box is not where that lake is: geocode Lake Tahoe again with its state or country and query it there",
    );
    // Its own cache entry, so the box's cached answer is not handed back.
    const calls = stub.mock.calls as unknown as [string, { cacheKey?: string }][];
    expect(calls.filter(([u]) => u === SPARQL_ENDPOINT).map(([, i]) => i.cacheKey)).toEqual(["lakes:k", "lakes:k:by-name"]);
  });

  it("does not point elsewhere when the lake here is the larger one or Wikidata knows it here", async () => {
    const tiny = { item: item("Q9"), label: { value: "Lake Tahoe" }, coord: { value: "Point(-84.48 33.55)" }, area: { value: "1000" } };
    expect(geojson(await layer.query(ctx(namesake([tiny]), undefined, box), { name: "Lake Tahoe" })).coverageNote).not.toContain("elsewhere");
    const known = route(tahoeWikidata, tahoeOsm);
    await layer.query(ctx(known, undefined, AUDIT_BOX), { name: "tahoe" });
    expect(known).toHaveBeenCalledTimes(2);
  });
});

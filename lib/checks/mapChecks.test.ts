import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import { getLayer } from "@/layers";
import type { Layer } from "@/layers/types";
import { isLand, shoreOffsetKm } from "@/lib/checks/landMask";
import {
  cardRowProblems,
  checkCards,
  checkDuplicates,
  checkLattice,
  checkLayerIds,
  checkPlace,
  checkSurface,
  drawnLayers,
  findLattice,
  fitsSurface,
  grownPlace,
  normalName,
  runMapChecks,
  type LayerInfo,
  type LayerLookup,
  type SectionRow,
} from "@/lib/checks/mapChecks";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapState, type RenderMode } from "@/lib/render/state";

const lookup: LayerLookup = (id) => getLayer(id) as Layer | undefined;

const point = (lon: number, lat: number, props: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: props,
});

const line = (coords: [number, number][], props: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: coords },
  properties: props,
});

/** The map after the browser loaded and drew these layers, as the eval replays it. */
function mapWith(...layers: { id: string; features: Feature[]; mode?: RenderMode; info?: LayerInfo }[]): MapState {
  let state = reduce(initialMapState, { type: "turn_start" });
  for (const { id, features, mode, info } of layers) {
    const meta = info ?? lookup(id);
    const data: FeatureCollection = { type: "FeatureCollection", features };
    state = reduce(state, {
      type: "layer_loaded",
      layer: {
        id,
        title: meta?.title ?? id,
        style: meta?.style ?? { geometry: "point", color: "#000" },
        result: { kind: "geojson", data, citation: { source: "test", url: "https://example.org", retrieved: "2026-10-16" } },
        receivedAt: "2026-10-16T00:00:00Z",
        ...(meta?.card && { card: meta.card }),
        ...(meta?.fieldHelp && { fieldHelp: meta.fieldHelp }),
        ...(meta?.attributes && { attributes: meta.attributes }),
      },
    });
    state = reduce(state, { type: "render", op: { layerId: id, mode: mode ?? "points", visible: true } });
  }
  return state;
}

const drawn = (state: MapState, l: LayerLookup = lookup) => drawnLayers(state, l);

describe("land mask", () => {
  it("reads land, sea and the distance to the coast", () => {
    expect(isLand(-104.99, 39.74)).toBe(true); // Denver
    expect(isLand(-140, 30)).toBe(false); // open Pacific
    expect(shoreOffsetKm(-104.99, 39.74)).toBe(60);
    expect(shoreOffsetKm(-122.9, 36.3)).toBeLessThan(-30); // well off Monterey
    expect(Math.abs(shoreOffsetKm(-122.497, 37.495))).toBeLessThan(3); // Mavericks, at the shore
  });

  it("fits each surface with a 2 km coast tolerance", () => {
    expect(fitsSurface("land", -1.5)).toBe(true);
    expect(fitsSurface("land", -5)).toBe(false);
    expect(fitsSurface("water", 1)).toBe(true);
    expect(fitsSurface("water", 20)).toBe(false);
    expect(fitsSurface("coast", -8)).toBe(true);
    expect(fitsSurface("coast", -40)).toBe(false);
    expect(fitsSurface("coast", 15)).toBe(false);
    expect(fitsSurface("any", 999)).toBe(true);
  });
});

/** The owner's Half Moon Bay case: Open-Meteo's forecast grid over the box, 16 symbols in a 4 × 4 grid off Monterey. */
const OFFSHORE_GRID = [0, 1, 2, 3].flatMap((i) =>
  [0, 1, 2, 3].map((j) => point(-123.2 + i * 0.1, 36.3 + j * 0.1, { kind: "forecast", name: `Forecast ${i}-${j}`, v: 1.8 })),
);

describe("surface (on land / at sea)", () => {
  it("fails the 4 × 4 surf forecast grid out in open ocean", () => {
    const result = checkSurface(drawn(mapWith({ id: "surf", features: OFFSHORE_GRID })));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/^Surf and waves \(NOAA buoys, live\) \(surf\): 16 of 16 features are away from the coast/);
    expect(result.failures[0]).toMatch(/e\.g\. "Forecast 0-0" at 36\.30, -123\.20/);
  });

  it("passes named surf spots at the shore and a buoy far out at sea", () => {
    const features = [
      point(-122.497, 37.495, { kind: "forecast", name: "Mavericks" }),
      point(-122.03, 36.95, { kind: "forecast", name: "Steamer Lane" }),
      point(-122.88, 37.36, { kind: "buoy", name: "Half Moon Bay buoy 46012" }),
    ];
    expect(checkSurface(drawn(mapWith({ id: "surf", features }))).ok).toBe(true);
  });

  it("fails crags out at sea and passes crags on land", () => {
    const sea = checkSurface(drawn(mapWith({ id: "climbing", features: [point(-125, 36, { name: "Phantom Wall" })] })));
    expect(sea.ok).toBe(false);
    expect(sea.failures[0]).toMatch(/out at sea, more than 2 km from land, e\.g\. "Phantom Wall"/);
    expect(checkSurface(drawn(mapWith({ id: "climbing", features: [point(-83.68, 37.82, { name: "Muir Valley" })] }))).ok).toBe(true);
  });

  it("fails sea ice drawn inland", () => {
    const ice: Feature = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] }, properties: {} };
    const result = checkSurface(drawn(mapWith({ id: "sea-ice", features: [ice], mode: "polygons" })));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/inland, more than 2 km from the sea/);
  });

  it("forgives a few strays among many (small islands the mask lacks)", () => {
    const features = [...Array.from({ length: 30 }, (_, i) => point(-83.6 + i * 0.001, 37.8, { name: `Crag ${i}` })), point(-125, 36, { name: "Stray" })];
    expect(checkSurface(drawn(mapWith({ id: "climbing", features }))).ok).toBe(true);
  });
});

describe("lattice", () => {
  it("finds the 4 × 4 grid and fails the layer", () => {
    expect(findLattice(OFFSHORE_GRID.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]))).toMatchObject({ cols: 4, rows: 4, count: 16 });
    const result = checkLattice(drawn(mapWith({ id: "surf", features: OFFSHORE_GRID })));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/16 points sit on a regular 4 × 4 grid \(0\.100° by 0\.100° apart\)/);
  });

  it("passes scattered real places and a grid smaller than 3 × 3", () => {
    const scattered = Array.from({ length: 40 }, (_, i) => [-120 + Math.sin(i * 1.7) * 0.3, 39 + Math.cos(i * 2.3) * 0.3] as [number, number]);
    expect(findLattice(scattered)).toBeNull();
    const small = [0, 1].flatMap((i) => [0, 1, 2, 3, 4].map((j) => [-120 + i * 0.1, 39 + j * 0.1] as [number, number]));
    expect(findLattice(small)).toBeNull();
  });

  it("passes a sparse scatter that happens to share rounded coordinates", () => {
    // Coordinates rounded to 0.1° (as some records are) but far from filling a grid.
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) if ((i * 7 + j * 3) % 5 === 0) pts.push([-120 + i * 0.1, 39 + j * 0.1]);
    expect(findLattice(pts)).toBeNull();
  });
});

/** The owner's Red River Gorge case: one wall mapped in OSM as a node and as a cliff line, listed twice in the top 10. */
const CRAG_TWICE = [
  point(-83.6601, 37.7201, { name: "Bob Marley Crag", kind: "crag", v: 120 }),
  line(
    [
      [-83.6605, 37.7205],
      [-83.6595, 37.7209],
    ],
    { name: "Bob Marley Crag", kind: "crag", v: 118 },
  ),
  point(-83.7, 37.75, { name: "Muir Valley", kind: "area", v: 400 }),
];

describe("duplicates", () => {
  it("fails a crag drawn twice (OSM point and cliff line) and listed twice in Rank by's top 10", () => {
    const result = checkDuplicates(drawn(mapWith({ id: "climbing", features: CRAG_TWICE })));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/1 place is drawn twice within 1 km, e\.g\. "Bob Marley Crag" twice/);
    // Rank by lists one row per place since 9a73dd3; rankedTopCheck.test.ts holds the check against the old list.
    expect(result.failures).toHaveLength(1);
  });

  it("passes one name at two far-apart places, two trail segments, and repeated sightings", () => {
    const far = [point(-83.66, 37.72, { name: "The Gallery", v: 5 }), point(-84.5, 38.5, { name: "The Gallery", v: 3 })];
    expect(checkDuplicates(drawn(mapWith({ id: "climbing", features: far }))).ok).toBe(true);
    const segments = [
      line([[-120, 39], [-120.01, 39.01]], { name: "Tahoe Rim Trail" }),
      line([[-120.01, 39.01], [-120.02, 39.02]], { name: "Tahoe Rim Trail" }),
    ];
    expect(checkDuplicates(drawn(mapWith({ id: "osm-trails", features: segments, mode: "lines" }))).ok).toBe(true);
    const sightings = [point(-115.57, 51.18, { name: "Elk", t: "2026-06-01" }), point(-115.571, 51.18, { name: "Elk", t: "2026-06-01" })];
    expect(checkDuplicates(drawn(mapWith({ id: "species", features: sightings }))).ok).toBe(true);
  });

  it("fails one fire drawn twice by two agencies (Empire and EMPIRE, same year, same outline)", () => {
    const ring = (dx: number): GeoJSON.Position[][] => [[[-119.6 + dx, 37.6], [-119.5 + dx, 37.6], [-119.5 + dx, 37.7], [-119.6 + dx, 37.6]]];
    const fire = (name: string, dx: number, acres: number): Feature => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: ring(dx) },
      properties: { name, year: 2017, t: "2017-01-01T00:00:00.000Z", acres, v: acres },
    });
    const result = checkDuplicates(drawn(mapWith({ id: "fire-perimeters", features: [fire("Empire", 0, 8581), fire("EMPIRE", 0.0001, 8577)], mode: "polygons" })));
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/"Empire" twice as two nearly identical areas/);
    expect(result.failures).toHaveLength(1);
  });

  it("passes sites that share a name a few hundred metres apart (Potato Bottom A, B, C) and generic names", () => {
    const potato = [point(-110.004, 38.4215, { name: "Potato Bottom" }), point(-110.0095, 38.4297, { name: "Potato Bottom" }), point(-110.0109, 38.4314, { name: "Potato Bottom" })];
    const generic = [point(-109.99, 38.52, { name: "Designated Campsite" }), point(-109.994, 38.523, { name: "Designated Campsite" })];
    expect(checkDuplicates(drawn(mapWith({ id: "campsites", features: [...potato, ...generic] }))).ok).toBe(true);
    const sameSpot = [...potato, point(-110.004, 38.4215, { name: "Potato Bottom" })];
    expect(checkDuplicates(drawn(mapWith({ id: "campsites", features: sameSpot }))).ok).toBe(false);
  });

  it("passes two dated events of one name (dams rebuilt, not listed twice)", () => {
    const dated = [point(-111.49, 36.94, { name: "Glen Canyon", t: "1964", v: 1 }), point(-111.4901, 36.9401, { name: "Glen Canyon", t: "1966", v: 2 })];
    expect(checkDuplicates(drawn(mapWith({ id: "dams", features: dated }))).ok).toBe(true);
  });

  it("normalises names: case, accents and punctuation", () => {
    expect(normalName("Café  du Lac!")).toBe(normalName("cafe du lac"));
  });
});

const row = (key: string, label: string, value: string, section: SectionRow["section"] = "fact", help?: { text: string }): SectionRow => ({
  section,
  row: { key, label, value, ...(help && { help }) },
});

describe("card text", () => {
  const climbing = lookup("climbing")!;

  it("fails the owner's climbing card: VALUE 5, Trad 1, Max length m, a raw URL and osm+openbeta", () => {
    // The card as it read before the card schema (generic rows): every one of these was on screen.
    const rows = [
      row("v", "Value", "5", "measure"),
      row("trad", "Trad", "1"),
      row("sport", "Sport", "4"),
      row("maxLengthM", "Max length m", "30"),
      row("url", "Url", "https://openbeta.io/area/abc"),
      row("source", "Source", "osm+openbeta"),
    ];
    const problems = cardRowProblems(rows, climbing);
    expect(problems).toContain('"Value" stands where the layer names its measure ("Routes")');
    expect(problems).toContain('"Trad 1" is a bare number under its raw key');
    expect(problems).toContain('label "Max length m" is a raw property key');
    expect(problems).toContain('"Url" shows a bare URL as text');
    expect(problems).toContain('"Source" shows a raw code ("osm+openbeta")');
  });

  it("fails snake_case and camelCase labels, mostly n/a, and an unexplained score", () => {
    const problems = cardRowProblems(
      [row("sac_scale", "sac_scale", "T3"), row("hazardScore", "hazardScore", "n/a"), row("a", "Agency", "n/a"), row("score", "Hazard score", "1,200"), row("x", "Kind", "n/a")],
      {},
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'label "sac_scale" is a raw property key',
        'label "hazardScore" is a raw property key',
        '"Hazard score 1,200" has no help explaining the number',
        '3 of 5 rows say "n/a"',
      ]),
    );
  });

  it("fails the owner's Tahoe trail card: a part in view longer than the full length", () => {
    const rows = [row("lengthKm", "Length in view", "50.1 km", "measure"), row("distanceKm", "Full length", "48.1 km")];
    expect(cardRowProblems(rows, {})).toEqual(['"Length in view 50.1 km" is more than "Full length 48.1 km"']);
    expect(cardRowProblems([row("lengthKm", "Length in view", "12.4 km", "measure"), row("distanceKm", "Full length", "48.1 km")], {})).toEqual([]);
  });

  it("passes a score with help, years and plain labels", () => {
    expect(cardRowProblems([row("v", "Hazard score", "1,200", "measure", { text: "Navajo AUM score" }), row("year", "Year", "2021"), row("kind", "Kind", "crag")], {})).toEqual([]);
  });

  it("builds the card with the card's own row builder and passes today's climbing card", () => {
    const crag = point(-83.66, 37.72, {
      name: "Bob Marley Crag",
      kind: "crag",
      v: 120,
      trad: 30,
      sport: 90,
      routesOsm: 12,
      routesOpenbeta: 120,
      maxLengthM: 35,
      url: "https://openbeta.io/area/abc",
      source: "osm+openbeta",
      disciplines: ["sport", "trad"],
    });
    const result = checkCards(drawn(mapWith({ id: "climbing", features: [crag] })));
    expect(result).toEqual({ check: "card", ok: true, failures: [] });
  });

  it("passes today's methane and county cards (they read \"Uncertainty 177.6\", \"Persistence 0.22\", \"Fips 06019\" before)", () => {
    const source = point(-103.5, 31.9, { kind: "source", sector: "Oil & gas", v: 1273, uncertainty: 177.6, persistence: 0.22, plumeCount: 14, firstSeen: "2024-05-01", t: "2026-09-01T00:00:00.000Z", sourceName: "P1" });
    expect(checkCards(drawn(mapWith({ id: "methane-plumes", features: [source] }))).ok).toBe(true);
    const county: Feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-120, 36], [-119, 36], [-119, 37], [-120, 36]]] },
      properties: { name: "Fresno County", state: "CA", fips: "06019", v: 2.4, kind: "warmer", t: "2026-09-30", period: "September 2026", months: 1, averageF: 75.1, normalF: 72.7, warmestRank: 60, years: 132 },
    };
    expect(checkCards(drawn(mapWith({ id: "temperature-anomaly", features: [county], mode: "polygons" })))).toEqual({ check: "card", ok: true, failures: [] });
  });

  it("fails a card whose measure is missing (v shown under its raw key)", () => {
    const info: LayerInfo = { id: "fake", title: "Fake", surface: "any", style: { geometry: "point", color: "#000" }, card: { measure: { key: "routes", label: "Routes" } } };
    // The measure key is missing, so v lands in Details as "V 5" (the website is a named link since d8ceb7c).
    const features = [point(0, 0, { name: "A", v: 5, website: "https://example.org" })];
    const result = checkCards(drawnLayers(mapWith({ id: "fake", features, info }), (id) => (id === "fake" ? info : undefined)));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['Fake (fake) card: "V 5" is a bare number under its raw key ("A").']);
  });
});

describe("layer ids", () => {
  it("fails the phantom layer named climbing<|channel|>commentary", () => {
    const state = mapWith({ id: "climbing", features: [point(-83.66, 37.72, { name: "A" })] });
    const garbled = reduce(state, { type: "layer_error", layerId: "climbing<|channel|>commentary", message: "Unknown layer" });
    const result = checkLayerIds(garbled, lookup);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['The map holds a layer named "climbing<|channel|>commentary", which is not a registered layer (a garbled tool name?).']);
    expect(checkLayerIds(state, lookup).ok).toBe(true);
  });

  it("passes a route the route tool drew under its own id", () => {
    const route = reduce(initialMapState, {
      type: "route_loaded",
      route: { id: "walking-tahoe-city-to-emerald-bay", line: { type: "LineString", coordinates: [[-120.14, 39.17], [-120.1, 38.95]] }, source: "tool", distanceKm: 25, waypoints: [] },
    });
    const drawnRoute = reduce(route, { type: "render", op: { layerId: "walking-tahoe-city-to-emerald-bay", mode: "lines", visible: true } });
    expect(checkLayerIds(drawnRoute, lookup).ok).toBe(true);
  });
});

describe("inside the place", () => {
  const tahoe = { name: "Lake Tahoe", bbox: [-120.25, 38.9, -119.9, 39.3] as [number, number, number, number] };

  it("grows the place box by 25% on each side, and a point-like place to 0.5°", () => {
    expect(grownPlace([0, 0, 1, 1])).toEqual([-0.25, -0.25, 1.25, 1.25]);
    const p = grownPlace([10, 10, 10, 10]);
    expect(p[2] - p[0]).toBeCloseTo(0.75);
  });

  it("fails the owner's uranium mines placed against a street the geocoder found (Navajo Nation Drive, Flagstaff)", () => {
    const street = { name: "Navajo Nation Drive, Flagstaff, Arizona 86004, United States", bbox: [-111.62, 35.2, -111.61, 35.21] as [number, number, number, number] };
    const mines = Array.from({ length: 20 }, (_, i) => point(-110.4 + i * 0.05, 36.9, { name: `Tract ${i}`, v: 10 }));
    const result = checkPlace(drawn(mapWith({ id: "uranium", features: mines })), street);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/only 0 of 20 features are in or near Navajo Nation Drive/);
  });

  it("fails trails loaded around another place, passes trails at Tahoe", () => {
    const yosemite = Array.from({ length: 10 }, (_, i) => line([[-119.6 + i * 0.01, 37.7], [-119.59 + i * 0.01, 37.71]], { name: `Trail ${i}` }));
    const result = checkPlace(drawn(mapWith({ id: "osm-trails", features: yosemite, mode: "lines" })), tahoe);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/only 0 of 10 features are in or near Lake Tahoe/);
    const local = Array.from({ length: 10 }, (_, i) => line([[-120.1 + i * 0.01, 39.1], [-120.09 + i * 0.01, 39.11]], { name: `Trail ${i}` }));
    expect(checkPlace(drawn(mapWith({ id: "osm-trails", features: local, mode: "lines" })), tahoe).ok).toBe(true);
    expect(checkPlace(drawn(mapWith({ id: "osm-trails", features: yosemite, mode: "lines" })), null).ok).toBe(true);
  });
});

describe("runMapChecks", () => {
  it("returns all six checks in order", () => {
    const results = runMapChecks(mapWith({ id: "climbing", features: [point(-83.66, 37.72, { name: "Muir Valley", v: 3 })] }), { lookup, place: null });
    expect(results.map((r) => r.check)).toEqual(["surface", "lattice", "duplicates", "card", "layerIds", "place"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

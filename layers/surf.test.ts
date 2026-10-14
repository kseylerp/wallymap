import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import type { Cache } from "@/lib/fetch";
import layer, {
  addHistoryYear,
  buoyFeatures,
  climatologyFrom,
  compass,
  forecastAtSpots,
  marineProps,
  NUDGE_STEPS_KM,
  offsetKm,
  parseOsmSpots,
  parseWikidataSpots,
  pickSpots,
  SPOT_CAP,
  surfSpotsQuery,
  surfSpotsSparql,
  keepLargest,
  parseLatestObs,
  parseStationList,
  parseStationNames,
  seasonFeature,
  seasonStations,
  SEASON_BUOY_CAP,
  setClimatologyCache,
  waveStationIds,
  WIDE_LIMIT,
} from "./surf";
import { hardMaxAreaKm2 } from "./types";
import { haversineKm } from "./_shared/geo";
import marineFixture from "./__fixtures__/marine.sf.json";

/** Recorded 2026-10-10 ~02:11 UTC: latest_obs trimmed to 11 stations, activestations to 5, marine for SF's 4 x 4 grid. */
const OBS = readFileSync(join(__dirname, "__fixtures__/ndbc-latest-obs.txt"), "utf8");
const XML = readFileSync(join(__dirname, "__fixtures__/ndbc-stations.xml"), "utf8");
/** Seasonal fixtures: 4 stations (two Oahu buoys, a Honolulu tide gauge, SF) and every 30th row of 51201's 2025 file. */
const OAHU_XML = readFileSync(join(__dirname, "__fixtures__/ndbc-stations.oahu.xml"), "utf8");
const HISTORY = readFileSync(join(__dirname, "__fixtures__/ndbc-history.51201h2025.txt"), "utf8");
const OAHU: [number, number, number, number] = [-158.4, 21.2, -157.6, 21.75];
const SF: [number, number, number, number] = [-123.2, 37.3, -122.3, 38.0];

function memoryCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
}
const NOW = new Date("2026-10-10T02:15:00Z");

function text(body: string): Response {
  return new Response(body, { status: 200 });
}

function routedStub() {
  return vi.fn(async (url: string) => {
    if (url.includes("latest_obs")) return text(OBS);
    if (url.includes("activestations")) return text(XML);
    if (url.includes("overpass")) return text(JSON.stringify(OSM_SPOTS));
    if (url.includes("wikidata")) return text(JSON.stringify(WD_SPOTS));
    return text(JSON.stringify(marineFixture));
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = SF, cacheKey?: string) {
  return { bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

function calls(stub: ReturnType<typeof vi.fn>) {
  return stub.mock.calls as unknown as [string, { cacheKey?: string; ttlSeconds?: number }][];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parsing", () => {
  it("reads latest_obs columns by header name, with MM as missing", () => {
    const obs = parseLatestObs(OBS);
    const halfMoon = obs.find((o) => o.id === "46012");
    expect(halfMoon).toMatchObject({ lat: 37.356, lon: -122.881, wvht: 2.2, dpd: 11, wtmp: 16.3, wspd: 4 });
    expect(halfMoon?.apd).toBeUndefined();
    expect(new Date(halfMoon?.time ?? 0).toISOString()).toBe("2026-10-10T01:00:00.000Z");
    expect(obs.find((o) => o.id === "46026")?.wvht).toBeUndefined();
  });

  it("reads station names from activestations.xml", () => {
    const names = parseStationNames(XML);
    expect(names.get("46237")).toBe("San Francisco Bar, CA (142)");
    expect(names.get("46012")).toMatch(/HALF MOON BAY/);
  });

  it("turns degrees into a 16-point compass direction", () => {
    expect(compass(0)).toBe("N");
    expect(compass(261)).toBe("W");
    expect(compass(292)).toBe("WNW");
    expect(compass(359)).toBe("N");
  });
});

describe("buoyFeatures", () => {
  it("keeps buoys in the bbox with a wave height, with period, direction and water temperature", () => {
    const fc = buoyFeatures(parseLatestObs(OBS), parseStationNames(XML), SF, NOW);
    expect(fc.features.map((f) => f.properties?.stationId).sort()).toEqual(["46012", "46237"]);
    const bar = fc.features.find((f) => f.properties?.stationId === "46237");
    expect(bar?.properties).toMatchObject({
      name: "San Francisco Bar, CA (142)",
      kind: "buoy",
      t: "2026-10-10T01:30:00.000Z",
      v: 1.8,
      waveFt: 5.9,
      periodS: 11,
      avgPeriodS: 9.2,
      directionDeg: 261,
      directionFrom: "W",
      waterTempC: 15.6,
    });
    expect(bar?.geometry.coordinates).toEqual([-122.634, 37.788]);
  });

  it("drops observations older than 12 hours", () => {
    const later = new Date("2026-10-10T14:00:00Z");
    expect(buoyFeatures(parseLatestObs(OBS), new Map(), SF, later).features).toHaveLength(0);
  });

  it("names a buoy by id when the station list lacks it", () => {
    const fc = buoyFeatures(parseLatestObs(OBS), new Map(), SF, NOW);
    expect(fc.features[0].properties?.name).toMatch(/^NDBC \d+/);
  });
});

/** One marine row for the fixture's first point, as the API returns it for a single point. */
const MARINE_ROW = (marineFixture as unknown[])[2];
const NULL_ROW = { latitude: 39, longitude: -120, hourly: { time: ["2026-10-10T02:00", "2026-10-10T03:00"], wave_height: [null, null] } };

const OSM_SPOTS = {
  elements: [
    { type: "node", id: 1, lat: 37.4953, lon: -122.4968, tags: { name: "Mavericks", sport: "surfing" } },
    { type: "way", id: 2, center: { lat: 37.4955, lon: -122.4975 }, tags: { name: "Mavericks Beach", natural: "beach", surfing: "yes" } },
    { type: "node", id: 3, lat: 37.5, lon: -122.45, tags: { sport: "surfing" } },
    { type: "node", id: 4, lat: 37.51, lon: -122.46, tags: { name: "Surf Shack", shop: "surf", sport: "surfing" } },
    { type: "way", id: 5, center: { lat: 37.46, lon: -122.44 }, tags: { name: "Venice Beach Point", natural: "beach" } },
  ],
};
const WD_SPOTS = {
  results: {
    bindings: [
      { label: { value: "Mavericks" }, coord: { value: "Point(-122.469922 37.485211)" } },
      { label: { value: "Bad" }, coord: { value: "nonsense" } },
    ],
  },
};

describe("surf spots", () => {
  it("asks Overpass for surfing-tagged places and surf-ish beach names inside the bbox", () => {
    const q = surfSpotsQuery([-122.6, 37.35, -122.35, 37.55]);
    expect(q).toContain('nwr["sport"="surfing"](37.35,-122.6,37.55,-122.35)');
    expect(q).toContain('nwr["surfing"="yes"]');
    expect(q).toContain('["name"~"surf|point|reef",i]');
    expect(surfSpotsSparql([-123, 36.5, -121.5, 38])).toContain('"Point(-123 36.5)"');
  });

  it("keeps named spots only, with a rank for how surely they are surf spots, and drops shops", () => {
    const spots = parseOsmSpots(OSM_SPOTS);
    expect(spots.map((s) => [s.name, s.rank])).toEqual([
      ["Mavericks", 1],
      ["Mavericks Beach", 1],
      ["Venice Beach Point", 2],
    ]);
    expect(spots[1]).toMatchObject({ lat: 37.4955, lon: -122.4975 });
    expect(parseOsmSpots({ nope: true })).toEqual([]);
  });

  it("reads Wikidata Point(lon lat) and skips unreadable coordinates", () => {
    expect(parseWikidataSpots(WD_SPOTS)).toEqual([{ name: "Mavericks", lat: 37.485211, lon: -122.469922, source: "Wikidata", rank: 0 }]);
    expect(parseWikidataSpots("x")).toEqual([]);
  });

  it("merges sources within 1 km, preferring Wikidata, and caps at 40 nearest the centre", () => {
    const box: [number, number, number, number] = [-122.6, 37.35, -122.35, 37.55];
    const all = [...parseOsmSpots(OSM_SPOTS), ...parseWikidataSpots(WD_SPOTS)];
    const { spots, distinct } = pickSpots(all, box);
    // OSM Mavericks is 1.7 km from Wikidata's coordinate (kept both); Mavericks Beach is within 1 km of OSM Mavericks.
    expect(spots.map((s) => s.name)).toEqual(["Mavericks", "Mavericks", "Venice Beach Point"]);
    expect(spots[0].source).toBe("Wikidata");
    expect(spots.filter((s) => s.name === "Mavericks Beach")).toHaveLength(0);
    expect(distinct).toBe(3);

    const many: typeof all = Array.from({ length: 60 }, (_, i) => ({
      name: `Spot ${i}`,
      lat: 36.6 + i * 0.02,
      lon: -122.5,
      source: "OpenStreetMap" as const,
      rank: 1,
    }));
    const tall: [number, number, number, number] = [-122.6, 36.5, -122.35, 38];
    const capped = pickSpots(many, tall);
    expect(capped.spots).toHaveLength(SPOT_CAP);
    expect(capped.distinct).toBe(60);
    expect(pickSpots([{ name: "Out", lat: 10, lon: 10, source: "Wikidata", rank: 0 }], box).spots).toEqual([]);
  });

  it("offsets a point about the stated distance on a bearing", () => {
    const [lat, lon] = offsetKm(37.5, -122.5, 270, 1);
    expect(lat).toBeCloseTo(37.5, 4);
    expect(haversineKm([-122.5, 37.5], [lon, lat])).toBeCloseTo(1, 1);
    expect(offsetKm(37.5, -122.5, 0, 2)[0]).toBeGreaterThan(37.5);
  });
});

describe("forecast", () => {
  it("gives the current hour's waves and the biggest in the next 48 hours for one point", () => {
    const p = marineProps(MARINE_ROW, NOW);
    expect(p).not.toBeNull();
    expect(p?.t).toBe("2026-10-10T02:00:00.000Z");
    expect(typeof p?.v).toBe("number");
    expect(Number(p?.maxNext48hM)).toBeGreaterThanOrEqual(Number(p?.v));
    expect(typeof p?.periodS).toBe("number");
    expect(p).not.toHaveProperty("name");
  });

  it("is null where every hour is null (land)", () => {
    expect(marineProps(NULL_ROW, NOW)).toBeNull();
    expect(marineProps("junk", NOW)).toBeNull();
  });

  function marineByCoords() {
    // Null at the shore of the first spot; waves 1 km west of it; the second spot has waves at the shore; the third has none within 3 km.
    return vi.fn(async (url: string) => {
      if (!url.includes("marine-api")) return text("{}");
      const u = new URL(url);
      const lats = u.searchParams.get("latitude")!.split(",").map(Number);
      const lons = u.searchParams.get("longitude")!.split(",").map(Number);
      const rows = lats.map((lat, i) => {
        const lon = lons[i];
        const openWater = Math.abs(lat - 37.1) < 0.0005 && Math.abs(lon + 122.1) < 0.0005;
        const westOfShore = Math.abs(lat - 37.2) < 0.0005 && lon < -122.31 && lon > -122.33;
        return openWater || westOfShore ? MARINE_ROW : NULL_ROW;
      });
      return text(JSON.stringify(rows.length === 1 ? rows[0] : rows));
    });
  }

  const SPOTS = [
    { name: "Shore Null", lat: 37.2, lon: -122.3, source: "OpenStreetMap" as const, rank: 1 },
    { name: "Open Water", lat: 37.1, lon: -122.1, source: "Wikidata" as const, rank: 0 },
    { name: "Lake", lat: 39.0, lon: -120.0, source: "OpenStreetMap" as const, rank: 1 },
  ];

  it("reads a nudged point when the model is null at the shore, and drops a spot with none within 3 km", async () => {
    const stub = marineByCoords();
    const r = await forecastAtSpots(ctx(stub), SPOTS, NOW);
    expect(r.features.map((f) => f.properties?.name)).toEqual(["Shore Null", "Open Water"]);
    const [shore, open] = r.features;
    expect(shore.properties).toMatchObject({ kind: "forecast", nudgedKm: 1, spotSource: "OpenStreetMap" });
    expect(open.properties).not.toHaveProperty("nudgedKm");
    // Features sit on the spot, not on the nudged model point.
    expect(shore.geometry.coordinates).toEqual([-122.3, 37.2]);
    expect(r.dropped).toBe(1);
    expect(r.nudged).toBe(1);
    // First request has the 3 spots; then 4 bearings each for the 2 still null at 1 km, then Lake alone at 2 and 3 km.
    const lens = calls(stub).map((c) => new URL(c[0]).searchParams.get("latitude")!.split(",").length);
    expect(lens).toEqual([3, 8, 4, 4]);
    expect(NUDGE_STEPS_KM).toEqual([1, 2, 3]);
  });

  it("does not nudge points whose request failed", async () => {
    const down = vi.fn(async () => new Response("busy", { status: 429 }));
    const r = await forecastAtSpots(ctx(down), SPOTS, NOW);
    expect(r.features).toHaveLength(0);
    expect(r.dropped).toBe(0);
    expect(r.error).toMatch(/429/);
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe("seasonal climatology", () => {
  it("reads only moored buoys with coordinates from the station list", () => {
    const list = parseStationList(OAHU_XML);
    expect(list.map((s) => s.id).sort()).toEqual(["46026", "51201", "51202"]);
    expect(list.find((s) => s.id === "51201")).toEqual({ id: "51201", name: "Waimea Bay, HI (106)", lat: 21.671, lon: -158.118 });
  });

  it("picks buoys in view nearest the centre, capped", () => {
    const { chosen, inView } = seasonStations(parseStationList(OAHU_XML), OAHU);
    expect(inView).toBe(2);
    expect(chosen.map((s) => s.id)).toEqual(["51201", "51202"]);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: String(i), lon: -158 + i * 0.01, lat: 21.5 }));
    expect(seasonStations(many, OAHU).chosen).toHaveLength(SEASON_BUOY_CAP);
  });

  it("computes monthly mean and 90th percentile, skipping 99.00 missing heights", () => {
    const acc = Array.from({ length: 12 }, () => ({ h: [] as number[], p: [] as number[], d: [] as number[] }));
    addHistoryYear(HISTORY, acc);
    addHistoryYear("2025 10 01 00 00 999 99.0 99.0 99.00 99.00 99.00 999 9999.0 999.0 25.6 999.0 99.0 99.00", acc);
    const clim = climatologyFrom(acc, [2025]);
    const oct = clim.months[9]!;
    expect(oct.n).toBe(49);
    expect(oct.meanM).toBeCloseTo(1.65, 2);
    expect(oct.p90M).toBeGreaterThan(oct.meanM);
    expect(oct.periodS).toBeGreaterThan(5);
    expect(oct.directionDeg).toBeGreaterThanOrEqual(0);
    expect(clim.months.every((m) => m !== null)).toBe(true);
    // Waimea is a north-shore buoy: winter waves are bigger than summer ones.
    expect(clim.months[0]!.meanM).toBeGreaterThan(clim.months[6]!.meanM);
  });

  it("averages directions on the circle", () => {
    const acc = Array.from({ length: 12 }, () => ({ h: [] as number[], p: [] as number[], d: [] as number[] }));
    acc[0] = { h: [1, 1], p: [10, 10], d: [350, 10] };
    expect(climatologyFrom(acc, [2025]).months[0]?.directionDeg).toBe(0);
  });

  it("builds a point with v as the month's mean and the 12-month curves", () => {
    const acc = Array.from({ length: 12 }, () => ({ h: [] as number[], p: [] as number[], d: [] as number[] }));
    addHistoryYear(HISTORY, acc);
    const station = { id: "51201", name: "Waimea Bay, HI (106)", lat: 21.671, lon: -158.118 };
    const f = seasonFeature(station, climatologyFrom(acc, [2023, 2024, 2025]), 10);
    expect(f?.properties).toMatchObject({ kind: "climatology", month: "Oct", years: "2023-2025", samples: 49 });
    expect(f?.properties?.v).toBeCloseTo(1.65, 2);
    expect(f?.properties?.monthlyMeanM).toHaveLength(12);
    expect(f?.properties?.monthlyP90M).toHaveLength(12);
    const empty = climatologyFrom(Array.from({ length: 12 }, () => ({ h: [], p: [], d: [] })), [2025]);
    expect(seasonFeature(station, empty, 10)).toBeNull();
  });
});

/** A live file where 51201 reports waves and 51202 only wind (no wave sensor working). */
const OAHU_OBS = [
  "#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE",
  "#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft",
  "51201    21.671 -158.118 2026 10 10 01 56  MM    MM    MM  1.4  13  7.9 318     MM    MM    MM  27.1    MM   MM     MM",
  "51202    21.414 -157.681 2026 10 10 01 56  60   6.0   8.0   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM",
].join("\n");

describe("surf layer, season mode", () => {
  it("counts a station as a wave buoy when any wave column is present", () => {
    const ids = waveStationIds(parseLatestObs(OAHU_OBS + "\n" + OBS));
    expect(ids.has("51201")).toBe(true);
    expect(ids.has("51202")).toBe(false);
    // 46026's newest row lacks WVHT but still has average period and direction.
    expect(ids.has("46026")).toBe(true);
  });

  function seasonStub() {
    return vi.fn(async (url: string) => {
      if (url.includes("activestations")) return text(OAHU_XML);
      if (url.includes("latest_obs")) return text(OAHU_OBS);
      if (url.includes("view_text_file") && url.includes("51201h")) return text(HISTORY);
      return text("<html>Unable to access file</html>");
    });
  }

  it("fetches the last 3 complete years per wave buoy without caching the raw files, then caches the climatology a week", async () => {
    const cache = memoryCache();
    const ttls: number[] = [];
    setClimatologyCache({ ...cache, set: async (k, v, ttl) => (ttls.push(ttl), cache.set(k, v, ttl)) });
    const stub = seasonStub();
    const r = await layer.query(ctx(stub, OAHU, "surf:k"), { forecast: false, season: true, month: 10 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const history = calls(stub).filter((c) => c[0].includes("view_text_file"));
    expect(history.map((c) => new URL(c[0]).searchParams.get("filename")).sort()).toEqual([
      "51201h2023.txt.gz",
      "51201h2024.txt.gz",
      "51201h2025.txt.gz",
    ]);
    for (const [, init] of history) expect((init as { shouldCache?: (b: string) => boolean }).shouldCache?.("x")).toBe(false);
    expect(r.data.features).toHaveLength(1);
    expect(r.data.features[0].properties).toMatchObject({ stationId: "51201", kind: "climatology", month: "Oct" });
    expect(r.coverageNote).toMatch(/Oct over the last 3 complete years/);
    expect([...cache.store.keys()]).toEqual(["surf:clim:v1:51201:2023-2025"]);
    expect(ttls).toEqual([7 * 86_400]);

    // Second ask: served from the cached climatology, no history downloads.
    const again = seasonStub();
    await layer.query(ctx(again, OAHU), { forecast: false, season: true, month: 1 });
    expect(calls(again).filter((c) => c[0].includes("51201h"))).toHaveLength(0);
    setClimatologyCache(null);
  });

  it("tries every moored buoy, with a note, when the live file is unavailable", async () => {
    setClimatologyCache(memoryCache());
    const stub = vi.fn(async (url: string) => {
      if (url.includes("activestations")) return text(OAHU_XML);
      if (url.includes("latest_obs")) return new Response("down", { status: 503 });
      if (url.includes("51201h")) return text(HISTORY);
      return text("<html>Unable to access file</html>");
    });
    const r = await layer.query(ctx(stub, OAHU), { forecast: false, season: true, month: 10 });
    expect(calls(stub).filter((c) => c[0].includes("51202h"))).toHaveLength(3);
    expect((r as { coverageNote?: string }).coverageNote).toMatch(/every moored buoy was tried/);
    setClimatologyCache(null);
  });

  it("defaults to the current month and says when no buoy is in view", async () => {
    setClimatologyCache(memoryCache());
    const r = await layer.query(ctx(seasonStub(), OAHU), { forecast: false, season: true });
    expect((r as { coverageNote?: string }).coverageNote).toMatch(/in Oct/);
    const none = await layer.query(ctx(seasonStub(), [-120.6, 38.6, -119.8, 39.3]), { forecast: false, season: true });
    expect(none).toMatchObject({ coverageNote: expect.stringMatching(/No NDBC wave buoys/) });
    setClimatologyCache(null);
  });
});

describe("surf layer", () => {
  it("fetches the global observation file and station list under shared cache keys with short TTLs", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, SF, "surf:k"), { forecast: false, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    const [obs, stations] = calls(stub);
    expect(obs[0]).toBe("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt");
    expect(obs[1]).toMatchObject({ cacheKey: "surf:ndbc-latest", ttlSeconds: 600 });
    expect(stations[0]).toBe("https://www.ndbc.noaa.gov/activestations.xml");
    expect(stations[1].cacheKey).toBe("surf:ndbc-stations");
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("adds forecasts at named surf spots on top of the buoys, never grid points", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, SF, "surf:k"), { forecast: true, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const all = calls(stub);
    const marine = all.find((c) => c[0].includes("marine-api.open-meteo.com"));
    expect(marine).toBeDefined();
    const url = new URL(marine![0]);
    // Mavericks (Wikidata), the OSM Mavericks pair merged to one (100 m apart), and Venice Beach Point; the unnamed and shop elements are gone.
    expect(url.searchParams.get("latitude")?.split(",")).toHaveLength(3);
    expect(url.searchParams.get("hourly")).toBe("wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period");
    expect(marine![1].cacheKey).toBe("surf:k:marine:0:0");
    const overpass = all.find((c) => c[0].includes("overpass"))!;
    expect(overpass[1]).toMatchObject({ method: "POST", headers: { "user-agent": expect.stringContaining("WallyMap") } });
    const forecasts = r.data.features.filter((f) => f.properties?.kind === "forecast");
    expect(forecasts.map((f) => f.properties?.name)).toEqual(["Mavericks", "Mavericks Beach", "Venice Beach Point"]);
    expect(forecasts.map((f) => f.properties?.spotSource)).toEqual(["Wikidata", "OpenStreetMap", "OpenStreetMap"]);
    expect(forecasts.some((f) => String(f.properties?.name).startsWith("Forecast "))).toBe(false);
    expect(new Set(r.data.features.map((f) => f.properties?.kind))).toEqual(new Set(["buoy", "forecast"]));
    expect(r.coverageNote).toMatch(/^2 NOAA buoys \(measured\) and 3 surf spots \(modelled forecast\)/);
    expect(r.citation.source).toMatch(/non-commercial/);
  });

  it("returns the buoys with a note when there are no named surf spots in view", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url.includes("latest_obs")) return text(OBS);
      if (url.includes("activestations")) return text(XML);
      if (url.includes("overpass")) return text(JSON.stringify({ elements: [] }));
      if (url.includes("wikidata")) return text(JSON.stringify({ results: { bindings: [] } }));
      throw new Error("marine must not be asked without spots");
    });
    const r = await layer.query(ctx(stub), { forecast: true, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    expect(r.data.features.every((f) => f.properties?.kind === "buoy")).toBe(true);
    expect(r.coverageNote).toBe("No named surf spots in view");
  });

  it("suggests the forecast when no buoy is in view, without fetching names", async () => {
    const stub = routedStub();
    const r = await layer.query(ctx(stub, [-120.6, 38.6, -119.8, 39.3]), { forecast: false, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(0);
    expect(r.coverageNote).toMatch(/forecast true/);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("keeps buoys when the forecast fails, and errors when the observations fail", async () => {
    const marineDown = vi.fn(async (url: string) => {
      if (url.includes("latest_obs")) return text(OBS);
      if (url.includes("activestations")) return text(XML);
      if (url.includes("overpass")) return text(JSON.stringify(OSM_SPOTS));
      if (url.includes("wikidata")) return text(JSON.stringify(WD_SPOTS));
      return new Response("busy", { status: 429 });
    });
    const r = await layer.query(ctx(marineDown), { forecast: true, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toHaveLength(2);
    expect(r.coverageNote).toMatch(/forecast failed/);

    const down = vi.fn(async () => new Response("no", { status: 503 }));
    expect(await layer.query(ctx(down), { forecast: false, season: false })).toMatchObject({ hint: "upstream" });

    const spotsDown = vi.fn(async (url: string) => {
      if (url.includes("latest_obs")) return text(OBS);
      if (url.includes("activestations")) return text(XML);
      return new Response("busy", { status: 429 });
    });
    const s = await layer.query(ctx(spotsDown), { forecast: true, season: false });
    if (!("kind" in s) || s.kind !== "geojson") throw new Error("expected geojson");
    expect(s.data.features).toHaveLength(2);
    expect(s.coverageNote).toMatch(/No named surf spots in view \(Overpass returned 429; Wikidata returned 429\)/);
  });

  it("describes units, freshness, licence and the user's words", () => {
    for (const word of ["surf", "swell", "waves", "metres", "period", "non-commercial", "forecast", "season", "this time of year"]) {
      expect(layer.description.toLowerCase()).toContain(word);
    }
    expect(layer.license).toMatch(/NOAA/);
    expect(layer.license).toMatch(/non-commercial/);
    expect(layer.style).toMatchObject({ geometry: "point", unit: "m" });
    expect(layer.coverage).toBe("global");
  });

  it("rejects bad input and an oversized bbox through runLayer", async () => {
    expect((await runLayer("surf", { bbox: SF, input: { forecast: "yes" } })).status).toBe(400);
    expect((await runLayer("surf", { bbox: SF, input: { season: true, month: 13 } })).status).toBe(400);
    const huge = await runLayer("surf", { bbox: [-180, -60, 180, 80] });
    expect(huge.status).toBe(422);
    expect(huge.body).toMatchObject({ hint: "zoom_in", error: expect.stringMatching(/under 50000000 km²$/) });
  });
});

describe("surf wide mode (over 500,000 km²)", () => {
  it("declares every buoy up to 1,000, biggest waves first, with a hard cap of the US-sized 50 million km²", () => {
    expect(layer.wide).toEqual({ orderBy: "wave height in metres", limit: 1000 });
    expect(WIDE_LIMIT).toBe(1000);
    expect(hardMaxAreaKm2(layer)).toBe(50_000_000);
    expect(layer.description).toMatch(/over 500,000 km² up to 1,000 buoys, biggest waves first/);
    expect(layer.description).not.toMatch(/zoom in to under/);
  });

  it("answers a 2.3 million km² box through runLayer from the one global file, with a wide note", async () => {
    const stub = routedStub();
    vi.stubGlobal("fetch", stub);
    try {
      const res = await runLayer("surf", { bbox: [-130, 20, -110, 45] });
      expect(res.status).toBe(200);
      expect(stub.mock.calls.filter((c) => String(c[0]).includes("latest_obs"))).toHaveLength(1);
      expect(res.body).toMatchObject({ coverageNote: expect.stringMatching(/^Showing all \d+ in this wide view \(ranked by wave height in metres\)/) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cuts at the limit by wave height and counts every point", async () => {
    const r = await layer.query({ ...ctx(routedStub(), [-130, 20, -110, 45]), wide: true, wideStrategy: { ...layer.wide!, limit: 2 } }, { forecast: false, season: false });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    const all = buoyFeatures(parseLatestObs(OBS), new Map(), [-130, 20, -110, 45], NOW).features;
    expect(all.length).toBeGreaterThan(2);
    expect(r.total).toBe(all.length);
    const top = all.map((f) => Number(f.properties?.v)).sort((a, b) => b - a).slice(0, 2);
    expect(r.data.features.map((f) => f.properties?.v)).toEqual(top);
    expect(keepLargest(all, all.length)).toEqual({ features: all });
  });

  it("summarises 6 buoys in a wide seasonal view and lists the rest as kind 'station', counting them at the limit", async () => {
    setClimatologyCache(memoryCache());
    const xml =
      `<stations>` +
      Array.from({ length: 8 }, (_, i) => `<station id="9900${i}" lat="${20 + i}" lon="${-150 - i}" name="Buoy ${i}" type="buoy"/>`).join("") +
      `</stations>`;
    const stub = vi.fn(async (url: string) => {
      if (url.includes("activestations")) return text(xml);
      if (url.includes("latest_obs")) return new Response("down", { status: 503 });
      return text(HISTORY);
    });
    const box: [number, number, number, number] = [-160, 18, -148, 30];
    const r = await layer.query({ ...ctx(stub, box), wide: true, wideStrategy: layer.wide }, { forecast: false, season: true, month: 10 });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.filter((f) => f.properties?.kind === "climatology")).toHaveLength(SEASON_BUOY_CAP);
    expect(r.data.features.filter((f) => f.properties?.kind === "station")).toHaveLength(2);
    expect(r.total).toBeUndefined();
    expect(r.coverageNote).toMatch(/the others are kind 'station' without values/);
    expect(r.coverageNote).not.toMatch(/zoom in/);

    const cut = await layer.query({ ...ctx(stub, box), wide: true, wideStrategy: { ...layer.wide!, limit: 7 } }, { forecast: false, season: true, month: 10 });
    if (!("kind" in cut) || cut.kind !== "geojson") throw new Error("expected geojson");
    expect(cut.data.features).toHaveLength(7);
    expect(cut.total).toBe(8);
    setClimatologyCache(null);
  });
});

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CachedFetch } from "@/lib/fetch";
import { contractProblems, legendOf } from "./contract";
import layer, { DANGER, locationText, plainText, problemText, zonesInBox } from "./avalanche";
import type { BBox, LayerResult } from "./types";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
/** Four zones as avalanche.org served them on 2026-10-23 (all unrated: between seasons), geometry rounded. */
const MAP = fixture("avalanche.map-layer.json") as { type: string; features: { id: number; properties: Record<string, unknown> }[] };
/** GNFAC's real forecast of 2026-01-15 for the Bridger Range and its neighbours (/v2/public/product/178000). */
const FORECAST = fixture("avalanche.forecast-gnfac.json");

const STEVENS: BBox = [-121.2, 47.6, -120.9, 47.85];
const BRIDGERS: BBox = [-111.1, 45.7, -110.8, 46.0];
const ALPS: BBox = [6.75, 45.85, 7.0, 46.0];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The map layer as it reads in season: the Bridger Range rated 2 Moderate (same keys, values as the center sets them). */
function inSeason() {
  const copy = structuredClone(MAP);
  for (const f of copy.features) {
    if (f.properties.name === "Bridger Range") Object.assign(f.properties, { off_season: false, danger: "moderate", danger_level: 2, color: "#fff300" });
  }
  return copy;
}

function run(bbox: BBox, handler: (url: string) => Response) {
  const stub = vi.fn(async (url: string) => handler(url));
  return { stub, result: layer.query({ bbox, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch }, {}) };
}

function geojson(r: unknown): Extract<LayerResult, { kind: "geojson" }> {
  if (typeof r !== "object" || r === null || !("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r as Extract<LayerResult, { kind: "geojson" }>;
}

describe("avalanche layer", () => {
  it("keys the North American danger scale in its own colors", () => {
    expect(contractProblems(layer)).toEqual([]);
    const legend = legendOf(layer);
    expect(legend.field).toBe("danger");
    expect(legend.items?.map((i) => [i.label, i.color])).toEqual(DANGER.map((d) => [d.label, d.color]));
    expect(legend.items?.find((i) => i.value === 3)?.color).toBe("#F7941E");
  });

  it("finds the zones whose outline meets the box", () => {
    expect(zonesInBox(MAP, STEVENS).map((z) => z.properties.name)).toContain("Stevens Pass");
    expect(zonesInBox(MAP, ALPS)).toEqual([]);
  });

  it("writes problems, places and the bottom line in plain words", () => {
    expect(locationText(["north upper", "northeast upper", "east upper", "southeast upper", "south upper", "southwest upper", "west upper", "northwest upper"])).toBe(
      "all aspects above treeline",
    );
    expect(locationText(["north upper", "north middle", "east upper", "east middle"])).toBe("north, east aspects above and near treeline");
    expect(problemText({ name: "Wind Slab", likelihood: "possible", size: ["1", "1.5"], location: ["north upper"] })).toBe("Wind Slab: possible, size 1 to 1.5, north aspects above treeline");
    expect(plainText("<p>It&rsquo;s getting <em>harder</em>.</p>")).toBe("It's getting harder.");
  });

  it("says plainly that nothing is rated out of season, and links the center (Stevens Pass, 2026-10-23)", async () => {
    const { stub, result } = run(STEVENS, () => json(MAP));
    const r = geojson(await result);
    expect(stub).toHaveBeenCalledTimes(1);
    const stevens = r.data.features.find((f) => f.properties?.name === "Stevens Pass")!;
    expect(stevens.properties).toMatchObject({ danger: 0, center: "Northwest Avalanche Center", season: "Out of season: no daily rating", link: "https://nwac.us/forecasts/avalanche/stevens-pass" });
    expect(stevens.properties?.issued).toBeUndefined();
    expect(r.coverageNote).toMatch(/^No avalanche danger rating today for the \d+ zones? in view \(Northwest Avalanche Center\)/);
    expect(r.coverageNote).toContain("between seasons");
  });

  it("reads a rated zone's forecast: danger by elevation, problems, bottom line, issue time in local time", async () => {
    const { stub, result } = run(BRIDGERS, (url) => (url.includes("map-layer") ? json(inSeason()) : json(FORECAST)));
    const r = geojson(await result);
    expect(stub.mock.calls.map((c) => c[0])).toContain("https://api.avalanche.org/v2/public/product?type=forecast&center_id=GNFAC&zone_id=2819");
    const bridger = r.data.features[0].properties as Record<string, unknown>;
    expect(bridger).toMatchObject({ name: "Bridger Range", danger: 2, upper: "2 Moderate", middle: "1 Low", lower: "1 Low" });
    expect(bridger.problems).toEqual(["Wind Slab: possible, size 1 to 1.5, all aspects above treeline"]);
    expect(String(bridger.bottomLine)).toMatch(/^It's getting harder to find soft snow\./);
    expect(bridger.issued).toBe("Jan 15, 6:28 AM MST");
    expect(r.coverageNote).toMatch(/^1 of \d+ zones rated today; highest: Bridger Range \(Gallatin NF Avalanche Center\) 2 Moderate/);
  });

  it("answers an empty map outside the US zones, and an upstream error when avalanche.org is down", async () => {
    const empty = geojson(await run(ALPS, () => json(MAP)).result);
    expect(empty.data.features).toEqual([]);
    expect(empty.coverageNote).toContain("US backcountry zones only");
    expect(await run(STEVENS, () => json({}, 503)).result).toMatchObject({ hint: "upstream" });
  });
});

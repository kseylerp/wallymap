import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sitePath, siteTileUrl } from "@/components/mapTiles";
import { GET } from "@/app/api/ee/tiles/[layer]/[z]/[x]/[y]/route";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { TILE_CACHE_CONTROL } from "@/lib/ee/tiles";
import { fakeEeFetch, testEnv } from "@/lib/ee/__fixtures__/fakeEe";

const params = (layer: string, z: string, x: string, y: string) => ({ params: Promise.resolve({ layer, z, x, y }) });
const req = (query: string) => new Request(`https://wallymap.test/api/ee/tiles/forest-types/8/214/125?${query}`, { headers: { "x-forwarded-for": "203.0.113.9" } });

describe("Earth Engine tile route", () => {
  let fake: ReturnType<typeof fakeEeFetch>;
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
    for (const [k, v] of Object.entries(testEnv())) vi.stubEnv(k, v);
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    fake = fakeEeFetch({});
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("hands on Earth Engine's PNG with long browser and CDN caching", async () => {
    const res = await GET(req("view=classes&src=2020v1&conf=all"), params("forest-types", "8", "214", "125"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(TILE_CACHE_CONTROL);
    expect(TILE_CACHE_CONTROL).toMatch(/public.*s-maxage=\d{6,}/);
    expect(fake.calls.at(-1)?.url).toBe("https://earthengine.googleapis.com/v1/projects/wally-14e22/maps/map1/tiles/8/214/125");
    // A second tile of the same picture reuses the map id.
    await GET(req("view=classes&src=2020v1&conf=all"), params("forest-types", "8", "215", "125"));
    expect(fake.calls.filter((c) => c.url.endsWith("/maps"))).toHaveLength(1);
  });

  it("refuses unknown layers, pictures and tiles without asking Earth Engine", async () => {
    for (const [query, p] of [
      ["view=classes&src=2020v1&conf=all", params("forest-loss", "8", "1", "1")],
      ["view=anything", params("forest-types", "8", "1", "1")],
      ["view=classes&src=2020v1&conf=all", params("forest-types", "8", "256", "1")],
      ["view=classes&src=2020v1&conf=all", params("forest-types", "x", "1", "1")],
    ] as const) {
      expect((await GET(req(query), p)).status).toBe(400);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("answers an Earth Engine failure with an uncached error", async () => {
    vi.stubGlobal("fetch", fakeEeFetch({ tile: () => Response.json({ error: { message: "boom" } }, { status: 500 }) }).fetch);
    const res = await GET(req("view=classes&src=2020v1&conf=all"), params("forest-types", "8", "214", "125"));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Google Earth Engine's server is returning errors (500)." });
  });
});

describe("site tile URLs", () => {
  it("gives our own tile routes the site's origin for Mapbox, and takes it off again", () => {
    const path = "/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src=2020v1&conf=all";
    expect(siteTileUrl(path, "https://wallymap.vercel.app")).toBe(`https://wallymap.vercel.app${path}`);
    expect(sitePath(`https://wallymap.vercel.app${path}`, "https://wallymap.vercel.app")).toBe(path);
    expect(siteTileUrl("https://tiles.example/{z}/{x}/{y}.png", "https://wallymap.vercel.app")).toBe("https://tiles.example/{z}/{x}/{y}.png");
    expect(siteTileUrl("//cdn.example/{z}", "https://a")).toBe("//cdn.example/{z}");
    expect(siteTileUrl(path, undefined)).toBe(path);
  });
});

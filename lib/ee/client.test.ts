import { beforeEach, describe, expect, it } from "vitest";
import { clearMapCache, createEeClient, EeError, MAP_REFRESH_MARGIN_MS, MAP_TTL_MS } from "./client";
import { clearTokenCache } from "./auth";
import { constant, constantImage } from "./expr";
import { fakeEeFetch, testEnv } from "./__fixtures__/fakeEe";

const image = constantImage(1);

describe("Earth Engine client", () => {
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
  });

  it("bills the project in every request and sends the bearer token, never the key", async () => {
    const fake = fakeEeFetch({ compute: () => 42 });
    const ee = createEeClient({ env: testEnv(), fetch: fake.fetch });
    expect(await ee.compute(constant(1))).toBe(42);
    const call = fake.calls.find((c) => c.url.endsWith("value:compute"))!;
    expect(call.url).toBe("https://earthengine.googleapis.com/v1/projects/wally-14e22/value:compute");
    expect(call.headers["x-goog-user-project"]).toBe("wally-14e22");
    expect(call.headers.authorization).toBe("Bearer ya29.test-token");
    expect(JSON.stringify(call)).not.toContain("PRIVATE KEY");
    expect(call.body).toEqual({ expression: { result: "0", values: { "0": { constantValue: 1 } } } });
    expect(createEeClient({ env: testEnv({ EE_PROJECT: "other-proj" }), fetch: fake.fetch }).project).toBe("other-proj");
  });

  it("makes one map id per picture and reuses it until near its TTL", async () => {
    let now = 0;
    const fake = fakeEeFetch({});
    const ee = createEeClient({ env: testEnv(), fetch: fake.fetch, now: () => now });
    const [a, b] = await Promise.all([ee.mapName("k", image), ee.mapName("k", image)]);
    expect(a).toBe("projects/wally-14e22/maps/map1");
    expect(b).toBe(a);
    now = MAP_TTL_MS - MAP_REFRESH_MARGIN_MS - 1;
    expect(await ee.mapName("k", image)).toBe("projects/wally-14e22/maps/map1");
    now += 2;
    expect(await ee.mapName("k", image)).toBe("projects/wally-14e22/maps/map2");
    expect(await ee.mapName("other", image)).toBe("projects/wally-14e22/maps/map3");
    const create = fake.calls.find((c) => c.url.endsWith("/maps"))!;
    expect(create.body).toMatchObject({ fileFormat: "PNG", expression: { result: "0" } });
  });

  it("fetches a tile, and makes a new map id once when Earth Engine has forgotten the old one", async () => {
    let first = true;
    const fake = fakeEeFetch({
      tile: (url) => {
        if (first && url.includes("map1")) {
          first = false;
          return Response.json({ error: { message: "Map not found" } }, { status: 404 });
        }
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      },
    });
    const ee = createEeClient({ env: testEnv(), fetch: fake.fetch });
    const tile = await ee.tile("k", image, 8, 214, 125);
    expect(new Uint8Array(tile.body)).toEqual(new Uint8Array([1, 2, 3]));
    expect(tile.contentType).toBe("image/png");
    expect(fake.calls.filter((c) => c.url.includes("/tiles/")).map((c) => c.url)).toEqual([
      "https://earthengine.googleapis.com/v1/projects/wally-14e22/maps/map1/tiles/8/214/125",
      "https://earthengine.googleapis.com/v1/projects/wally-14e22/maps/map2/tiles/8/214/125",
    ]);
  });

  it("turns failures into a sourceStatus the row can say", async () => {
    const busy = createEeClient({ env: testEnv(), fetch: fakeEeFetch({ compute: () => new Response("slow down", { status: 429 }) }).fetch });
    const e1 = await busy.compute(constant(1)).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(EeError);
    expect((e1 as EeError).sourceStatus).toMatchObject({ ok: false, reason: "rate-limited", message: "Google Earth Engine is limiting requests right now (429)." });

    const broken = createEeClient({ env: testEnv(), fetch: fakeEeFetch({ compute: () => Response.json({ error: { message: "Internal" } }, { status: 500 }) }).fetch });
    expect(((await broken.compute(constant(1)).catch((e: unknown) => e)) as EeError).sourceStatus.reason).toBe("server-error");

    const bad = createEeClient({ env: testEnv(), fetch: fakeEeFetch({ compute: () => Response.json({ error: { message: "Image.unmask, argument 'value': Invalid type." } }, { status: 400 }) }).fetch });
    const e3 = (await bad.compute(constant(1)).catch((e: unknown) => e)) as EeError;
    expect(e3.message).toContain("Invalid type");
    expect(e3.status).toBe(400);

    const offline = createEeClient({
      env: testEnv(),
      fetch: (async (url: string) => {
        if (String(url).includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    });
    expect(((await offline.compute(constant(1)).catch((e: unknown) => e)) as EeError).sourceStatus).toMatchObject({ reason: "offline", message: "Google Earth Engine did not answer in time." });
  });

  it("says Earth Engine is not set up when there are no credentials", async () => {
    const ee = createEeClient({ env: {}, credentials: null, fetch: fakeEeFetch({}).fetch });
    const e = (await ee.compute(constant(1)).catch((x: unknown) => x)) as EeError;
    expect(e).toBeInstanceOf(EeError);
    expect(e.sourceStatus).toMatchObject({ ok: false, reason: "offline" });
    expect(e.sourceStatus.message).toMatch(/not set up on this server/);
  });
});

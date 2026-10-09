# Adding a layer

A layer is one dataset the agent can draw on the map. Each layer is a single file in `layers/` that exports a `Layer` object. The agent gets a `query_<id>` tool for it automatically, so you do not touch the chat code.

## The `Layer` interface

Defined in `layers/types.ts`. Build it with `defineLayer({...})` so the input type is inferred.

- `id`: unique, lowercase, dash-separated name; the agent tool becomes `query_<id>`.
- `title`: short human name shown in the UI.
- `description`: one or two sentences the model reads to decide when to use the layer.
- `coverage`: `"global"`, `"us"`, or `{ bbox }`; tells the model where data exists.
- `license`: the data license, shown with the citation.
- `requiredEnv`: env var names the layer needs (an empty array if none).
- `optionalEnv`: env var names the layer reads when they are set but can work without (optional).
- `maxAreaKm2`: largest bounding box, in square kilometres, the layer will answer for.
- `input`: a zod object describing the layer's own options (the bbox is added for you).
- `query(ctx, input)`: fetches data and returns a `LayerResult` or a `LayerError`.
- `style`: `{ geometry: "point" | "line" | "polygon", color, unit? }` hints for drawing.

`ctx` holds `bbox` as `[west, south, east, north]`, `zoom`, an optional `route`, `env`, a cached `fetch`, and a `cacheKey`. `ctx.env` contains only the names listed in `requiredEnv` and `optionalEnv`, so read keys from `ctx.env`, never from `process.env`. Use `ctx.fetch` for network calls and pass `cacheKey: ctx.cacheKey` in its options so nearby requests share a cache entry.

A `LayerResult` is either `{ kind: "geojson", data, citation }` or `{ kind: "tiles", data: { url, minzoom, maxzoom }, citation }`. The citation is `{ source, url, retrieved }`. Add `coverageNote` for caveats such as "No data outside the US".

A `LayerError` is `{ error, hint }` where `hint` is `"zoom_in"` (area too big), `"unavailable"` (missing key or data), or `"upstream"` (the data source failed).

## The `t` and `v` convention

Feature properties may carry two optional fields the renderer understands:

- `t`: an ISO date string. It feeds the time scrubber.
- `v`: a number. It feeds column height, color ramps, and route charts.

A layer that sets neither still draws as plain points, lines, or polygons.

## What `runLayer` does for you

Both the HTTP route and the agent tools call `runLayer` in `lib/layers/run.ts` before your `query`. It already rejects a bad bbox, input that fails the `input` schema, a bbox larger than `maxAreaKm2` (as `zoom_in`), and missing `requiredEnv` (as `unavailable`). Your `query` does not need to re-check these. The one exception is area: `osm-trails` re-checks it because its tests call `query` directly, and you may do the same.

It also builds `ctx.env` from just your `requiredEnv` and `optionalEnv` names (a missing optional one is `undefined`), and computes `ctx.cacheKey` from the layer id, the bbox rounded to 3 decimals, and your parsed input.

## The `requiredEnv` rule

If a layer needs an API key, list the variable name in `requiredEnv`. When the key is missing the layer still appears in `list_layers`, marked unavailable, and queries return an `unavailable` error. A layer is never hidden, so the agent can tell the user what is missing. Add the variable to `.env.example` with a comment saying what it unlocks.

## Test it with a fixture

Tests must pass with no network and no keys. Save one real response in `layers/__fixtures__/`, then stub `fetch` to return it. This is modeled on `layers/osm-trails.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import layer from "./my-layer";
import fixture from "./__fixtures__/my-layer.sample.json";

const BBOX: [number, number, number, number] = [-120.2, 38.85, -120, 39];

describe("my-layer", () => {
  it("returns a cited FeatureCollection", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const r = await layer.query(
      { bbox: BBOX, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      {},
    );
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.length).toBeGreaterThan(0);
    expect(r.citation.source).toBeTruthy();
  });

  it("maps an upstream failure to a hinted error", async () => {
    const stub = vi.fn(async () => new Response("slow down", { status: 429 }));
    const r = await layer.query(
      { bbox: BBOX, zoom: 11, env: {}, fetch: stub as unknown as CachedFetch },
      {},
    );
    expect(r).toMatchObject({ hint: "upstream" });
  });
});
```

## Checklist

- [ ] `id` is unique across `layers/`.
- [ ] `coverage` is accurate.
- [ ] `license` is set.
- [ ] `maxAreaKm2` is set to what the data source can handle.
- [ ] A fixture is committed in `layers/__fixtures__/`.
- [ ] The layer is imported in `layers/index.ts` (below the "Layer imports" comment).
- [ ] Any new env var is in `.env.example`.
- [ ] `pnpm test` passes with no keys set.

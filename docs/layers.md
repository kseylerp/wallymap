# Adding a layer

A layer is one dataset the WildMap agent can draw on the map. Each layer is a single file in `layers/` that exports a `Layer` object. The agent gets a `query_<id>` tool for it automatically, so you do not touch the chat code.

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

A `LayerResult` is either `{ kind: "geojson", data, citation }` or `{ kind: "tiles", data, citation }`. The citation is `{ source, url, retrieved }`. Add `coverageNote` for caveats such as "No data outside the US".

## Tile layers: raster and vector

A tiles result carries `data: { url, minzoom, maxzoom, format, tileSize?, sourceLayer?, geometry? }`, where `url` is a `{z}/{x}/{y}` template the map fills in.

- `format: "raster"` is a picture per tile (forest loss, night lights, population). Set `tileSize` when the server does not use 256 pixel tiles; Global Forest Watch serves 512.
- `format: "vector"` is geometry per tile (public lands). Set `sourceLayer` to the layer name inside each tile and `geometry` to `"point"`, `"line"`, or `"polygon"` so the map knows how to draw it.

Tile layers have no features for the model to read, so the model only gets the URL, zoom range, and citation. Put anything it should tell the user (the date shown, the year range) in `coverageNote`.

## Shared helpers in `layers/_shared/`

Use these instead of rewriting fetch, retry, and error handling:

- `overpassQuery(ctx, ql, { cacheSuffix? })` posts an Overpass QL query to `ctx.env.OVERPASS_URL`, retries once on the public endpoint, and treats a 200 with a "timed out" remark as a failure. Returns `{ ok, json }` or `{ ok: false, error }`. A layer that calls it should list `OVERPASS_URL` in `optionalEnv`.
- `arcgisQuery(ctx, serviceUrl, { where, outFields, bbox, maxRecords, orderByFields })` queries an ArcGIS feature service for a bbox and returns GeoJSON plus `truncated`, which is true when the service capped the result.
- `gibsTileUrl(layerId, date, level)` builds a NASA GIBS tile URL for raster layers.
- Coverage gate: `outsideUs(bbox)` and `OUTSIDE_US_NOTE` for US-only layers. Return an empty result with that note instead of querying a service that has nothing there.
- `geo.ts` has distance, centroid, point-in-polygon, and a grid index. `constants.ts` holds the 25 second upstream timeout.

## Computed layers

A computed layer builds its answer from other layers instead of an outside service. `popularity`, `popularity-campsites`, and `remoteness` are examples. Call `runComposed(id, ctx, input, suffix)` from `layers/_shared/compose.ts`. It runs the other layer's `query` with a copy of your `ctx` whose `cacheKey` gets `:suffix` appended, so each sub-call has its own cache entry. It never throws; you get `{ ok: true, data }` or `{ ok: false, error }`.

Rules for computed layers:

- List every env var the sub-layers read in your own `optionalEnv`, because `ctx.env` only holds your declared names.
- Keep going when a signal's layer fails: score with the rest and say in `coverageNote` which signals were left out. Return the error only when the layer you are scoring fails.
- Mark results as estimates (for example `popularityNote: "estimate"`) and describe the signals in `description`, so the model does not present a score as a measurement.

A `LayerError` is `{ error, hint }` where `hint` is `"zoom_in"` (area too big), `"unavailable"` (missing key or data), or `"upstream"` (the data source failed).

## Caps and `coverageNote`

When a source can return more than the map or the model can use, cap the result and say so. Pick a cap (for example 5,000 points or 2,000 features), keep the most useful items (the strongest detections, the largest fires), and set `coverageNote` to something like `Showing 5,000 of 12,000 sites; zoom in for the rest`. Also set it for empty results ("No SNOTEL stations in this area") and for out-of-coverage views. An empty result with a note is better than an error when nothing is wrong.

## The `t` and `v` convention

Feature properties may carry two optional fields:

- `t`: an ISO date string. From Milestone 3 the renderer will use it for the time scrubber.
- `v`: a number. From Milestone 3 the renderer will use it for column height and route charts.

The renderer does not read them yet; set them now so the layer is ready. A layer that sets neither still draws as plain points, lines, or polygons.

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

## Teach the agent your layer's words

This step is easy to forget and the layer is hard for the agent to find without it. Add an entry to `VOCABULARY` in `lib/agent/vocabulary.ts` with your layer's `id` (as `layerId`), the words people use for it (`synonyms`), and a short `notes` line. The entry is rendered into the system prompt and returned by `list_layers`; a test fails if a registered layer has no entry. Put layers that should be queried together next to each other, since the agent queries matches in table order. Keep the note short, because the whole table must stay under about 1,800 characters.

## Checklist

- [ ] `id` is unique across `layers/`.
- [ ] `coverage` is accurate.
- [ ] `license` is set.
- [ ] `maxAreaKm2` is set to what the data source can handle.
- [ ] A fixture is committed in `layers/__fixtures__/`.
- [ ] The layer is imported in `layers/index.ts` (below the "Layer imports" comment).
- [ ] Any new env var is in `.env.example`.
- [ ] The layer has a `VOCABULARY` entry in `lib/agent/vocabulary.ts`.
- [ ] A tile layer sets `format`, and a vector one also sets `sourceLayer` and `geometry`.
- [ ] A capped or empty result sets `coverageNote`.
- [ ] `scripts/layer-table.mts` has an entry for the layer; then run it with `--write` to refresh the README table.
- [ ] `pnpm test` passes with no keys set.

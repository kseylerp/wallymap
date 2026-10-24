# Adding a layer

A layer is one dataset the WallyMap agent can draw on the map. Each layer is a single file in `layers/` that exports a `Layer` object. The agent gets a `query_<id>` tool for it automatically, so you do not touch the chat code.

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
- `style`: `{ geometry: "point" | "line" | "polygon", color, unit? }` hints for drawing. Set `unit: "score"` when `v` is a 0 to 100 score (see "Score layers" below).

`ctx` holds `bbox` as `[west, south, east, north]`, `zoom`, an optional `route`, `env`, a cached `fetch`, and a `cacheKey`. `ctx.env` contains only the names listed in `requiredEnv` and `optionalEnv`, so read keys from `ctx.env`, never from `process.env`. Use `ctx.fetch` for network calls and pass `cacheKey: ctx.cacheKey` in its options so nearby requests share a cache entry.

A `LayerResult` is either `{ kind: "geojson", data, citation }` or `{ kind: "tiles", data, citation }`. The citation is `{ source, url, retrieved }`. Add `coverageNote` for caveats such as "No data outside the US".

## Tile layers: raster and vector

A tiles result carries `data: { url, minzoom, maxzoom, format, tileSize?, sourceLayer?, geometry? }`, where `url` is a `{z}/{x}/{y}` template the map fills in.

- `format: "raster"` is a picture per tile (forest loss, night lights, population). Set `tileSize` (256 or 512) when the server does not use 256 pixel tiles; Global Forest Watch serves 512, and a wrong value draws the tiles at the wrong scale. Leave it out for standard 256 pixel tiles.
- `format: "vector"` is geometry per tile (public lands). Set `sourceLayer` to the layer name inside each tile and `geometry` to `"point"`, `"line"`, or `"polygon"` so the map knows how to draw it.

Tile layers have no features for the model to read, so the model only gets the URL, zoom range, and citation. Put anything it should tell the user (the date shown, the year range) in `coverageNote`.

### Dated tile layers

A tile layer whose imagery changes over time sets `data.time: { template, cadence, from, to?, daysBack? }` (the `TileTime` type in `layers/types.ts`). `template` is the tile URL with `{date}` (YYYY-MM-DD) or `{year}` where the time goes; `cadence` is `daily`, `8day`, `16day`, `monthly` or `yearly` (8-day and 16-day periods restart every 1 January, as MODIS composites do); `daysBack` keeps the newest period that many days behind today (negative for forecast days). The `_shared/dated-tiles.ts`, `_shared/gibs-dated.ts` and `_shared/wms.ts` helpers build it for you.

With `data.time` set, loading the layer opens the time scrubber on its own, with one step per published image: the last 30 days for a daily layer, and every period from `from` for the other cadences, at most 120 steps, ending at the date the layer was loaded for when that is older. The scrubber names the cadence ("one image per 16 days"), play steps through the images, and `tileUrlForTime` in `lib/time/index.ts` fills the template for each step. With dated GeoJSON layers on the map too, their features pick the buckets and the tile layer shows the window's end date. Compare works the same way.

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

Feature properties may carry two optional fields, and the map reads both:

- `t`: an ISO date string (`2016-07-04T00:00:00.000Z`, or a bare `2016-07-04`). The time scrubber builds its histogram from every loaded layer's `t` and picks day, month, or year buckets from the data span (at most 60 buckets). Moving the window hides dated features outside it; features with no `t` are never hidden, and a layer with no `t` at all does not make the scrubber appear. Fire perimeters set `t` to the start of their year, fire detections to the detection time. The `set_time` agent tool drives the same window. Tile layers carry no features, so they follow the scrubber through `data.time` instead (see "Dated tile layers" below).
- `v`: a number, the layer's one headline value (acres, a 0 to 100 score, a count). The inspect card shows it with the layer's `style.unit`, the layer console offers it as a numeric range filter (labelled "Value", or "Score (0 to 100)" for `unit: "score"`; it is left out when another property holds the same number on every feature), and route preview plots it along the route in the elevation panel. In 3D, the columns render mode sets column height from it (or from the count when a layer has no `v`).

A layer that sets neither still draws as plain points, lines, or polygons.

## Filters

Each layer card in the layer console has a Filters disclosure. The fields come from the data itself, so a layer needs no filter code: `deriveFilterFields` in `lib/render/filters.ts` scans the GeoJSON properties and offers:

- **Category chips** for text or true/false properties with 2 to 12 distinct values. A property that is mostly unique (more than half the values differ once there are 8 or more) is treated as free text and skipped.
- **Numeric ranges** for number properties with at least 5 distinct values, or a real spread across 20 or more features.
- **Never** ids and names: `id`, `name`, `title`, `url`, `t`, `signals`, `h3`, `wikidata`, `wikipedia`, `popularityNote`, `osmId`, and any key ending in `Id` or `_id`. Properties that mix text and numbers, or hold objects, are skipped too.

At most 8 fields show, categories first. So to make a layer filterable, keep short, repeated labels (`sac_scale`, `agency`, `kind`) and real numbers (`acres`, `year`) in `properties`, and keep long free text out of them or under an id-like key. Add a friendlier heading for a new key in `LABELS` in `lib/render/filters.ts`.

Filters live on the render op (`RenderOp.filters`, a map from property name to `{ include?: string[]; range?: [min, max] }`), narrow the map, the shown/total counts, the inspect card and the export together, and the agent can set them through `render` (`{ sac_scale: { include: ["alpine_hiking"] } }`; `{}` clears them). A feature must pass every entry, and one with no value for a filtered property is hidden.

## Score layers

Set `style.unit: "score"` on a layer whose `v` is a 0 to 100 estimate (`popularity`, `popularity-campsites`, and `remoteness` do). The map then shades the layer's polygons by `v` as a ramp from faint to strong instead of a flat tint (the ramp colors are due for the palette pass), the inspect card shows the value out of 100, the legend shows a five-step ramp key instead of a symbol, and the filter reads "Score (0 to 100)". The map ramp only appears when the unit is set; the legend alone falls back to the layer id for `remoteness` and `popularity`, so a new score layer must declare the unit.

## Legend symbols

The layer console draws each layer's legend key the same way the map draws it, and `lib/render/wally/pins.ts` decides the shape for point layers. Symbols are a monochrome set (`camp`, `parking`, `species`, `photo`, `gauge`, `snow`, `fire`, `road`, `trailhead`, `point`) drawn from `public/pins/<symbol>.svg`, with a `<symbol>-selected.svg` twin that fills solid ink.

- A new point layer picks an existing shape by adding `"<layer-id>": "<symbol>"` to `LAYER_SYMBOLS`. A layer left out gets the plain circle (`point`).
- A new shape needs two 24 by 24 SVGs (`<name>.svg` and `<name>-selected.svg`, 1.5 px dark stroke, white fill, centred) and the name added to `PIN_SYMBOLS`.
- A layer whose points are camp sites or parking lots, told apart by a `kind` property, goes in `CAMPSITE_LAYERS`.
- Line layers get a dash pattern from `lineDashFor` and polygon layers an ink wash from `POLYGON_INK_FILL`, both in `lib/render/palette.ts`; add an entry there to tell a new layer apart from the rest. Raster tile layers show a hatched square.

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

This step is easy to forget and the layer is hard for the agent to find without it. Add an entry to `VOCABULARY` in `lib/agent/vocabulary.ts` with your layer's `id` (as `layerId`), the words people use for it (`synonyms`), and a short `notes` line. The entry is rendered into the system prompt and returned by `list_layers`; a test fails if a registered layer has no entry. Put layers that should be queried together next to each other, since the agent queries matches in table order. Keep the note short, because the whole table must stay under 6,600 characters (`lib/agent/vocabulary.test.ts`). Give the layer a palette role too: one line in `LAYER_ROLES` in `lib/render/palette.ts` (`hazard`, `natural`, `data`, `score` or `raster`), which `layerColor(id)` reads for `style.color`.

## The layers today

WallyMap ships 91 data layers. This table is generated from the layer registry by `pnpm exec tsx scripts/layer-table.mts --write`, which also refreshes the copy in the README.

<!-- layers:start -->
| Id | Title | What it shows | Source | Coverage | Area (km²) | Key needed | Freshness | Attributes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `osm-trails` | OpenStreetMap trails | Hiking paths and tracks with difficulty and surface | OpenStreetMap | Global | 2,500; to 400,000 the 150 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) | Difficulty (ordinal, sac_scale (SAC hiking scale T1 to T6)): Hiking (T1), Mountain hiking (T2), Demanding mountain hiking (T3), Alpine hiking (T4), Demanding alpine (T5), Difficult alpine (T6); Kind (category): Path, Footpath, Track, Named route; Length (measure, km, 3 presets); Round trip (measure, km); Climb per km (measure, m/km); Shape (category): Loop, Out and back, Trail network; Name (name); Climb (measure, m, 3 presets) |
| `fire-perimeters` | Wildfire perimeters | Current and past US wildfire outlines | NIFC (WFIGS) | US | 60,000; to 16,000,000 the 500 largest by acres burned | None | Updated through the fire season | Acres burned (measure, acres, 5 presets); Year (time); Agency (category, from the data); Status (category): Still burning, Contained, Out; Name (name) |
| `fire-detections` | Active fire detections | Satellite hotspots from the last 1 to 10 days | NASA FIRMS | Global | 2,000,000; to 8,000,000 the 5,000 newest by detection time | `FIRMS_MAP_KEY` (required) | Near real time (hours) | Confidence (ordinal, VIIRS detection confidence (low, nominal, high); MODIS gives 0 to 100): Low, Nominal, High; Fire power (measure, MW, 2 presets); Brightness (measure, K); Pass (category): Day, Night; Satellite (category): Suomi NPP (VIIRS), NOAA-20 (VIIRS), NOAA-21 (VIIRS), Terra and Aqua (MODIS); Seen (time) |
| `forest-loss` | Tree cover loss | Where tree cover was lost, by year | UMD / Global Forest Watch | Global | Any | None | Yearly |  |
| `forest-alerts` | Forest disturbance alerts | Recent forest clearing in the tropics | Global Forest Watch (GLAD, RADD) | Tropics (30°S to 30°N) | Any | None | Weekly |  |
| `snowpack` | Snowpack (SNOTEL, live) | Snow depth, water equivalent, density and snow type at mountain weather stations | USDA NRCS SNOTEL | Western US | 400,000; to 50,000,000 the 1,000 largest by snow depth in inches | None | Live (hourly readings) | Snow type (category): No snow, Powder, Settled, Wet or dense; Snow depth (measure, in); Compared with normal (ordinal, Percent of the 1991-2020 median snow water equivalent for the day): Well below normal (under 70%), Below normal (70 to 89%), Near normal (90 to 109%), Above normal (110 to 129%), Well above normal (130% and up); Percent of normal (measure, %); Name (name) |
| `forest-roads` | Forest Service roads open to motor vehicles | Forest Service roads open to motor vehicles | USDA Forest Service MVUM | US | 25,000; to 50,000,000 the 2,000 longest by segment length in miles | None | Yearly | Maintenance level (ordinal, Forest Service operational maintenance level, 1 to 5): Passenger car, High clearance; Surface (category): Paved, Gravel, Dirt; Seasonal (closed part of the year) (flag); Segment length (measure, mi); Ranger district (category, from the data); Name (name) |
| `campsites` | Campsites and parking lots | Campsites and parking lots | OpenStreetMap | Global | 25,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) | Kind (category): Camp sites, RV and caravan sites, Parking lots; Fee (category): Free, Fee, Fee not mapped; Backcountry (walk-in) (flag); Tents allowed (flag); RVs allowed (flag); Capacity (measure, pitches or spaces); Name (name) |
| `streamflow` | Stream flow (USGS gauges, live) | River flow, gauge height and flow against the usual for the day at stream gauges | USGS Water Data | Global | 400,000; to 1,600,000 the 1,000 largest by current flow or gage height | `USGS_API_KEY` (optional), `OVERPASS_URL` (optional) | Live (15 minutes), provisional | Flow vs. normal for the date (ordinal, USGS WaterWatch percentile classes for the day of the year): Lowest on record for the date, Much below normal, Below normal, Normal, Above normal, Much above normal, Highest on record for the date; Flow (measure, cfs); Flow vs. the date's median (measure, %); Water temperature (measure, °F); Reading (category): USGS gauge, Modelled river, NWS river gauge, Dam release; Flooding now (ordinal, NWS flood categories for the gauge): Below flood stage, Action stage, Minor flooding, Moderate flooding, Major flooding; Forecast flooding (ordinal, NWS flood categories, the highest in the river forecast): Below flood stage, Action stage, Minor flooding, Moderate flooding, Major flooding |
| `river-pulse` | River flow, daily | Named rivers' daily flow, past three months and the forecast, played day by day (width flow, color against the median); the total is the flow to the sea | GloFAS via Open-Meteo; Natural Earth rivers | Global | 25,000,000 | None | Daily model, built once a day into one file | Flow (measure, m³/s); Flow vs. the 3-month median (measure, %); River (name) |
| `gbif-occurrences` | GBIF occurrence records | Species records by scientific name, or a world density map | GBIF | Global | 50,000; to any size a density map | None | Daily | Record type (category, 9 values); Species (category, from the data); Published by (category): iNaturalist, Museums, surveys and others; Month seen (category, 12 values); Season seen (category): Spring (Mar to May), Summer (Jun to Aug), Fall (Sep to Nov), Winter (Dec to Feb); Year (time) |
| `species` | Species sightings | Wildlife and plant sightings | iNaturalist | Global | 50,000; to 1,500,000 the 2,000 most recent by date observed | None | Daily | Species (category, from the data); Seen (time); Month seen (category, 12 values) |
| `population` | Population density | Where people live | NASA GIBS (GPW v4) | Global | Any | None | Fixed at 2020 |  |
| `night-lights` | Night lights | Satellite picture of the Earth at night | NASA GIBS (VIIRS) | Global | Any | None | Daily (date in the note) |  |
| `wilderness` | Wilderness areas | Designated wilderness boundaries | Wilderness.net / USGS | US | 400,000 | None | Updated occasionally | Managed by (category): US Forest Service, Bureau of Land Management, National Park Service, US Fish and Wildlife Service; Designated (category): Before 1980, 1980 to 1999, 2000 and later; Area (measure, acres, 3 presets); Name (name) |
| `photos` | Photo density | Where geotagged photos were taken | Wikimedia Commons, Mapillary | Global | 2,500; to 10,000 the 500 named by number of Wikipedia languages | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Live | What it is (category): Commons photo, Viewpoint, Street-level image; Commons photos within 500 m (measure, photos, 2 presets); Name (name) |
| `physical-regions` | Named physical regions | Named mountain ranges, deserts and plateaus | Natural Earth | Global | 30,000,000 | None | Static | Landform (category, 8 values); Area (measure, km²); Name (name) |
| `public-lands` | Public land ownership | Who owns and manages the land | USGS PAD-US 4.1 | US | Any | `PADUS_TILES_URL` (optional) | Static (release 4.1) | Managed by (category): National parks and wildlife refuges, National forests, Bureau of Land Management, State land and state parks, Local, tribal and private conservation land, Other federal (military, dams, energy); Public access (category): Open, Restricted, Closed, Unknown |
| `popularity` | Trail popularity estimate | Estimated popularity score (0 to 100) per trail | Computed from OSM, Commons, Mapillary | Global | 2,500 | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query | Popularity (measure, score, 4 presets); Name (name); Climb (measure, m, 3 presets) |
| `popularity-campsites` | Campsite popularity estimate | Estimated popularity score (0 to 100) per campsite | Computed from OSM, Commons, Mapillary | Global | 2,500 | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query | Popularity (measure, score, 4 presets); Name (name) |
| `remoteness` | Remoteness score | Remoteness score (0 to 100) per hexagon | Computed from OSM and wilderness boundaries | Global | 60,000 | `OVERPASS_URL` (optional) | Computed per query | Remoteness (measure, score, 3 presets); Place (name) |
| `mtb-trails` | Mountain bike trails | Mountain bike trails rated 0 to 6 on the Singletrack Scale | OpenStreetMap | Global | 2,500; to 100,000 the 1,000 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) | Difficulty (ordinal, mtb:scale:imba (IMBA 0 to 4), else mtb:scale converted (S0 green, S1 to S2 blue, S3 black, S4 to S6 double black)): Green, Blue, Black, Double black; Rider level (ordinal, IMBA color or Singletrack Scale, either one): Beginner, Intermediate, Advanced, Expert; Kind (category): Singletrack rated, IMBA rated only, Named route; Name (name) |
| `earthquakes` | Earthquakes | Recent earthquakes with magnitude, depth and time | USGS Earthquake Catalog | Global | 5,000,000; to 20,000,000 the 2,000 strongest by magnitude | None | Live (minutes) | Magnitude (measure, M, 5 presets); Depth (measure, km, 3 presets); Kind (category, from the data); When (time); Place (name) |
| `ski-routes` | Ski runs, nordic trails and ski touring routes | Downhill runs, nordic trails and ski touring routes | OpenStreetMap | Global | 2,500; to 100,000 the 1,000 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) | Kind (category, 13 values); Difficulty (ordinal, piste:difficulty (green · blue · black in North America; green · blue · red · black in Europe)): Easy, Moderate, Hard, Expert; Lit at night (flag); Name (name) |
| `recreation-sites` | Recreation sites | Developed recreation sites: campgrounds, trailheads, boat ramps, day use | USDA Forest Service, BLM | US | 10,000; to 1,500,000 the 2,000 named | None | Nightly feeds | Kind (category, 10 values); Managed by (category): US Forest Service, Bureau of Land Management; Status (category): Open, Closed; Reservable (flag); Name (name) |
| `glaciers` | Glaciers | Glacier and ice cap outlines with area | GLIMS (NSIDC) | Global | 8,000; to 3,000,000 the 1,500 largest by area in km² | None | Static (survey dates per glacier) | Area (measure, km², 4 presets); Ice lost since the first survey (measure, %); Survey (category, from the data); Name (name) |
| `geology` | Geology | Geologic map units as map tiles | Macrostrat | Global | Any | None | Static | Age of the youngest rock (measure, million years, 5 presets) |
| `climbing` | Climbing crags, boulders and areas | Climbing crags, boulders and areas with route counts | OpenStreetMap, OpenBeta | Global | 10,000; to 40,000 the 1,000 largest by route count | `OVERPASS_URL` (optional) | Live (cached up to a day) | Discipline (category, 8 values); Grade (ordinal, YDS, UIAA, French and V-scale): Beginner, Intermediate, Advanced, Elite; Sport grade (ordinal, YDS (else French) of each sport route): Beginner, Intermediate, Advanced, Elite; Trad grade (ordinal, YDS (else French) of each trad route): Beginner, Intermediate, Advanced, Elite; Boulder grade (ordinal, V-scale of each boulder problem): V0 to V2, V3 to V5, V6 to V9, V10 and up; Routes (measure, routes); Sport routes (measure, routes); Trad routes (measure, routes); Boulder problems (measure, problems); Kind (category): Crag, Boulder, Area, Gym; Fee charged (flag); Listed by (category): OpenStreetMap, OpenBeta, OpenStreetMap + OpenBeta; Name (name); Shaded in the afternoon (flag); Faces (category, 8 values) |
| `critical-habitat` | Critical habitat | Designated critical habitat for threatened and endangered species | US Fish and Wildlife Service | US | 300,000; to 1,200,000 the 1,000 largest by area | None | Updated as designated | Listed as (category): Endangered, Threatened, Proposed for listing; Species (category, from the data); Designation (category): Final (in force), Proposed (not yet in force) |
| `grazing-allotments` | BLM grazing allotments and wild horse areas | Livestock grazing allotments and wild horse and burro areas | Bureau of Land Management | US | 150,000; to 600,000 the 1,000 largest by acres | None | Updated occasionally | Kind of area (category): Wild horse and burro management area, Historic herd area (1971), Grazing allotment; Animals (category): Horses, Burros, Horses and burros; Size (measure, acres, 3 presets); Name (name) |
| `paddling` | Whitewater rapids, put-ins and canoe routes | Rapids, river sections, put-ins and canoe routes | OpenStreetMap | Global | 2,500; to 100,000 the 1,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) | Kind (category, 7 values); Class (ordinal, International Scale of River Difficulty (class I to VI; a half step is a plus)): Class I, Class II, Class III, Class IV, Class V, Class VI; Name (name) |
| `surf` | Surf and waves (NOAA buoys, live) | Wave height, period and direction at buoys; forecast and typical months | NOAA NDBC, Open-Meteo Marine | Global | 500,000; to 50,000,000 the 1,000 largest by wave height in metres | `OVERPASS_URL` (optional) | Live (under an hour) | Kind (category): Buoy, Spot forecast, Typical month, Buoy, no summary; Wave height (measure, ft, 4 presets); Period (measure, s); Reading (time); Name (name) |
| `peaks` | Peaks | Named peaks with elevation and prominence | Wikidata | Global | 40,000; to 600,000 the 1,000 most prominent by prominence | `OVERPASS_URL` (optional) | Live (community edits) | Elevation (measure, m); Prominence (measure, m); Kind (category): Peak, Volcano; Name (name) |
| `greenness` | Vegetation greenness | How green the vegetation is (NDVI or EVI) | NASA GIBS (MODIS Terra) | Global | Any | None | Every 16 days, back to 2000 |  |
| `protected-areas-world` | Protected areas of the world | Protected areas worldwide as map tiles | WDPA (UNEP-WCMC, IUCN) | Global | 25,000,000 | None | Monthly | Protection (category): Strict reserve or wilderness, National park, Monument or habitat area, Lived-in or sustainable use, No IUCN category; IUCN category (category, 7 values); Area (measure, km², 3 presets); Name (name) |
| `fire-hazard` | Wildfire hazard potential | Long-run wildfire hazard potential in five classes | USDA Forest Service (WHP 2023) | US | Any | None | Static (2023) |  |
| `flood-zones` | FEMA flood zones | FEMA flood hazard zones (zoom 14 and closer) | FEMA National Flood Hazard Layer | US | Any | None | Updated as maps change |  |
| `snow-cover` | Snow cover | Where the ground is snow-covered; US snow depth | NASA GIBS (MODIS Terra), NOAA NOHRSC | Global | Any | None | Daily, back to 2000 |  |
| `outdoor-features` | Huts, springs, peaks and other backcountry features | Huts, shelters, springs, viewpoints, caves, hot springs, waterfalls, passes | OpenStreetMap | Global | 10,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) | Kind (category, 10 values); Mapped safe to drink (flag); Name (name) |
| `tides` | Tides (NOAA, next high and low) | Next high and low tides at tide stations | NOAA CO-OPS | US | 50,000; to 50,000,000 the 1,000 nearest by distance from the centre | None | Live predictions and gauges | Station (category): Live gauge, Predictions only; Next tide (category): High next (rising), Low next (falling); Tide height (measure, ft); Name (name) |
| `land-cover` | Land cover | What covers the ground: trees, crops, built-up, water | ESA WorldCover, USGS NLCD | Global | Any | None | Static (2021; NLCD map years) |  |
| `wikipedia-nearby` | Wikipedia nearby | Wikipedia articles about places in view | Wikipedia | Global | 1,000; to 4,000 the 500 named by number of Wikipedia languages | None | Live | Article (name); Wikipedia languages (measure, editions, 3 presets) |
| `surface-water` | Surface water history | Where surface water has been seen, 1984 to 2021 | EC JRC Global Surface Water | Global | Any | None | Static (1984 to 2021) |  |
| `flood-extent` | Flood and surface water extent | Open water and floods from satellite | NASA GIBS (OPERA, MODIS) | Global | Any | None | Daily, a few days behind |  |
| `disturbance` | Vegetation disturbance alerts | Where vegetation was just lost or damaged | NASA GIBS (OPERA) | Global | Any | None | Daily, about 3 days behind |  |
| `sea-ice` | Sea ice | Sea ice concentration and extent | NASA GIBS (GHRSST MUR, MODIS) | Global | Any | None | Daily, back to 2000 |  |
| `fire-weather` | Fire weather (fire danger) | Fire danger forecast (Fire Weather Index) | EC JRC GWIS / EFFIS | Global | Any | None | Daily, up to 9 days ahead |  |
| `lakes` | Lakes and reservoirs | Named lakes and reservoirs with maximum depth | Wikidata | Global | 20,000; to 80,000 the 1,000 largest by area | `OVERPASS_URL` (optional) | Live (community edits) | Area (measure, km²); Maximum depth (measure, m); Kind (category): Lake, Reservoir, Pond, Oxbow lake, Lagoon; Name (name) |
| `drought` | Drought | Weekly drought categories D0 to D4 | U.S. Drought Monitor (NDMC) | US | 16,000,000 | None | Weekly | Category (ordinal, US Drought Monitor categories D0 to D4): D0 Abnormally Dry, D1 Moderate Drought, D2 Severe Drought, D3 Extreme Drought, D4 Exceptional Drought |
| `phenology` | Spring arrival (leaf-out and bloom) | Whether spring leaf-out and bloom came early or late | USA National Phenology Network | Lower 48 states | Any | None | Daily this year; yearly back to 1981 |  |
| `burn-severity` | Burn severity of large fires (MTBS) | Burned areas of large fires, by year | MTBS (USGS, USFS) | US | Any | None | Yearly, about 18 months behind |  |
| `smoke` | Wildfire smoke | Wildfire smoke plumes by density | NOAA Hazard Mapping System | North and Central America | Any | None | Daily | Smoke (ordinal, NOAA HMS density (Light, Medium, Heavy) and NDGD near-surface PM2.5 classes (3-25, 25-63, 63-158, 158+ µg/m³)): Light, Medium, Heavy, Very heavy |
| `geologic-unit` | Geologic unit at a point | The rock unit, age and rock type under one point | Macrostrat | Global | Any | None | Static |  |
| `fishing` | Fishing (access, boat ramps, recent catches, water temperature) | Fishing access, boat ramps, piers, recent fish sightings, water temperature | OpenStreetMap, USFS, iNaturalist, USGS | Global | 50,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live | Kind (category): Access, Boat ramp, Pier, Fish seen; Water temperature for trout (ordinal, Trout bands: feed best at 50 to 64 °F (10 to 18 °C), stressed above about 68 °F (20 °C)): Cold: under 50 °F (10 °C), Good: 50 to 64 °F (10 to 18 °C), Warm: 64 to 68 °F (18 to 20 °C), Too warm: over 68 °F (20 °C); Water temperature (measure, °F); Species (category, from the data) |
| `weather-alerts` | Weather alerts (NWS, live) and current weather | Active weather warnings and the weather right now | NOAA National Weather Service, Open-Meteo | Global | 400,000; to 1,600,000 the 1,000 most severe by severity | None | Live (minutes) | Severity (ordinal, NWS alert severity (Common Alerting Protocol): Minor, Moderate, Severe, Extreme): Minor, Moderate, Severe, Extreme; Alert (category, from the data) |
| `sequoia-groves` | Giant sequoia groves | The 96 giant sequoia groves | NPS Sequoia and Kings Canyon, USFS | Sierra Nevada, California | 120,000; to 480,000 the 1,000 largest by acres | None | Static (2024) | Area (measure, acres, 3 presets); Name (name) |
| `sea-level-trends` | Sea level trends (NOAA tide gauges) | Measured long-term sea level trend at tide gauges (mm/yr) | NOAA CO-OPS | Global | 30,000,000; to 120,000,000 the 1,000 fastest-rising by trend in mm/yr | None | Yearly | Direction (category): Falling, Rising; Sea level trend (measure, mm/yr, 4 presets); Name (name) |
| `sequoia-mortality` | Giant sequoia fire survival | Giant sequoias alive or dead after the 2020 and 2021 fires | USGS | Sequoia and Kings Canyon NPs | 400,000; to 1,600,000 the 3,000 largest by trunk diameter in cm | None | Static (post-fire surveys) | Status (category): Dead, Alive; Grove (category, from the data); Trunk diameter (measure, cm) |
| `reservoir-levels` | Reservoir levels | Storage, level, percent full and history of major reservoirs | US Bureau of Reclamation, California CDEC | Western US | 3,000,000; to 12,000,000 the 1,000 largest by storage in acre-feet | None | Daily, 1 to 2 days behind; provisional | Storage (measure, acre-feet, 4 presets); Percent full (measure, %, 4 presets); Reading (time); Name (name) |
| `sea-level-rise` | Sea level rise flooding (NOAA scenarios) | Coastal land under water at high tide for 0 to 10 feet of rise | NOAA Sea Level Rise Viewer | US | Any | None | Static scenarios |  |
| `old-growth` | Old-growth and mature forest | Old-growth and mature forest acres per fireshed | US Forest Service | US | 300,000; to 1,200,000 the 1,000 largest by old-growth acres | None | Static (2023 inventory) | Old-growth forest (ordinal, Old-growth acres on federal land in the fireshed): Under 5,000 acres of old growth, 5,000 to 20,000 acres, 20,000 to 50,000 acres, 50,000 acres and up; Old-growth forest (measure, acres, 4 presets); Mature forest (measure, acres); Forest type (category, from the data); Fireshed (name) |
| `carbon-flux` | Forest carbon flux | Forest carbon sink or source per hectare per year | Global Forest Watch (Harris et al.) | Global | Any | None | Static (2001 to 2025 average) |  |
| `condor-range` | California condor range | California condor range today and in the early 1800s | NPS Sequoia and Kings Canyon | Western North America | 20,000,000; to 80,000,000 the 1,000 largest by area | None | Static | When (category): Today, Early 1800s; Range (category): Current range, Experimental release area, Historic range |
| `dams` | Dams | Dams with storage, height, purpose, hazard and year built | USACE National Inventory of Dams | US | 250,000; to 50,000,000 the 2,000 largest by storage in acre-feet | None | Updated yearly | Hazard potential (category): Low, Significant, High, Undetermined; Storage (measure, acre-feet, 4 presets); Height (measure, ft, 3 presets); Purpose (category, from the data); Year completed (measure, 3 presets); Name (name) |
| `wolf-packs` | Wolf packs (Washington) | Gray wolf pack ranges by year | Washington Dept. of Fish and Wildlife | Washington state | 300,000; to 1,200,000 the 1,000 newest by year | None | Yearly (2014 to 2025) | Pack status (category): Breeding pair, Pack, not breeding, Single wolf's territory, Not published for this year; Pack (name) |
| `methane-plumes` | Methane plumes (Carbon Mapper) | Methane plumes and emission sources with rates | Carbon Mapper (non-commercial) | Global | 500,000; to 2,000,000 the 1,000 largest by emission rate in kg/h | None | Days to weeks after each pass | Emission rate (measure, kg/h, 2 presets); Kind (category): Recurring source, Single plume; Sector (category, from the data) |
| `ports` | Principal US ports | The 150 principal US ports by 2023 cargo tonnage | USACE via BTS | US | Any | None | Yearly (2023) | Port type (category): Coastal, Inland (rivers and waterways), Great Lakes; Cargo in 2023 (measure, short tons, 4 presets); Name (name) |
| `river-basins` | River basins and watersheds | Watersheds at a level that follows the zoom (HUC2 to HUC10) | USGS Watershed Boundary Dataset | US | 20,000,000; to 80,000,000 the 1,000 largest by area in km² | None | Updated occasionally | Drains to region (category, 22 values); Area (measure, km²); Name (name) |
| `hardiness-zones` | Plant hardiness zones | Plant hardiness zones as map tiles | USDA-ARS, Oregon State PRISM | Lower 48 states | Any | None | Static (2023) | Hardiness zone (category, 19 values) |
| `temperature-anomaly` | Temperature anomaly by county (NOAA) | County temperature against the 1901-2000 normal (°F) | NOAA NCEI Climate at a Glance | Lower 48 states | 16,000,000 | None | Monthly, about the 8th | Anomaly (measure, °F, 3 presets); Compared with normal (category): Warmer than normal, Normal, Cooler than normal; Warmest on record (flag); Coolest on record (flag) |
| `pipelines-lines` | Pipelines and power lines | Gas, oil and products pipelines and high-voltage power lines | EIA, HIFLD | US | 150,000; to 600,000 the 3,000 largest by length, power lines by voltage | None | Updated occasionally | Kind (category): Petroleum products, Gas liquids, Crude oil, Gas pipeline, Power line; Voltage (power lines) (ordinal, HIFLD voltage class, kV): Under 100 kV, 100 to 161 kV, 230 kV, 345 kV, 500 kV and up; Voltage (measure, kV); Gas pipeline type (category): Interstate, Intrastate; Name (name) |
| `aquifers` | Principal aquifers | Principal aquifer outlines by rock type | USGS Principal Aquifers | US | 6,000,000; to 24,000,000 the 1,000 largest by area | None | Static (2003) | Aquifer rock (category): Unconsolidated sand and gravel, Semiconsolidated sand and gravel, Sandstone, Carbonate rock, Sandstone and carbonate rock, Igneous and metamorphic rock; High Plains (Ogallala) aquifer (flag); Aquifer name (name) |
| `groundwater` | Groundwater levels | Depth to water at monitoring wells (newest reading) | USGS Water Data | US | 40,000; to 160,000 the 2,000 first | `USGS_API_KEY` (optional) | As wells are measured | Depth to water (measure, ft, 4 presets); Compared with its record (ordinal, USGS Groundwater Watch percentile classes): Much below normal, Below normal, Normal, Above normal, Much above normal; Water level (category): Static, Pumped or disturbed, Not given; Well (name) |
| `power-plants` | Power plants, wind and solar | Power plants by fuel, wind turbines and large solar, in MW | EIA, USGS wind and solar databases | US | 250,000; to 50,000,000 the 2,000 largest by capacity in MW | None | Quarterly to yearly | Fuel (category, 12 values); Fuel group (clean to fossil) (ordinal, EIA energy sources (EIA-860M), grouped from clean to fossil): Solar, Wind, Hydro and other renewables, Nuclear, Natural gas, Coal and oil; Capacity (measure, MW, 4 presets); Year online (measure); Online (time); Name (name) |
| `disasters` | Disasters (GDACS alerts and FEMA declarations) | Disaster alerts worldwide and FEMA declarations per US county | GDACS, OpenFEMA | Global | Any | None | Live (hourly) | Shown as (category): FEMA county declarations, GDACS alerts; GDACS alert level (ordinal, GDACS alert level (green, orange, red)): Green (minor), Orange (moderate), Red (severe); Disaster (category, 9 values); FEMA declarations (measure, 4 presets); Peak wind (measure, km/h); Name (name) |
| `monuments` | BLM national monuments and conservation areas | BLM national monuments now and Utah's 2021 boundaries | BLM, Utah AGRC | US | 20,000,000; to 80,000,000 the 1,000 largest by area | None | Current (July 2026 changes) | Boundary (category): 2021 boundary, Current boundary; Designation (category): National Monument, National Conservation Area, Other conservation designation; Area (measure, km²); Name (name) |
| `tree-mortality` | Dead-tree patches (beetles, drought, disease) | Where trees died each year (beetles, drought, disease) | USFS aerial survey, California DFW | US | 20,000; to 700,000 the 2,000 worst by trees killed, or percent dead from 2021 | None | Yearly (California to 2019, US 2021 to 2025) | Share of trees dead (measure, %, 3 presets); Trees killed (measure, trees); Cause (category, from the data); Year (time) |
| `permafrost` | Permafrost zones | Permafrost zones from continuous to isolated | IPA Circum-Arctic map, NRCan | Northern Hemisphere | 7,000,000 | None | Static | Permafrost zone (ordinal, IPA extent classes (share of ground frozen)): Isolated (0 to 10%), Sporadic (10 to 50%), Discontinuous (50 to 90%), Continuous (90 to 100%); Ground ice (category): High (over 20%), Medium (10 to 20%), Low (under 10%) |
| `mining-claims` | Mining claims | Active and closed mining claims on public land | BLM MLRS | US | 2,500; to 20,000 the 2,000 named | None | Daily | Status (category): Active, Closed; Claim type (category): Lode claim, Placer claim, Mill site, Tunnel site; Claims (measure, 3 presets); Claim name (name) |
| `imagery-by-date` | Satellite image by date (Landsat and Sentinel-2) | True-colour 30 m satellite picture on a chosen day | NASA HLS (Landsat, Sentinel-2) via GIBS | Global | 1,000,000 | None | Every few days, about 2 days behind |  |
| `mines` | Mines and mineral deposits | Mines, prospects and mineral deposits by commodity | USGS MRDS, USMIN | US | 15,000; to 1,200,000 the 2,000 named | None | Static (about 2011) | Status (about 2011) (category): Prospect or occurrence, Past producer, Producer; Commodity (category, 28 values); Feature type (category, from the data); Record (category): Deposit records (MRDS, about 2011), Old topographic map symbols (USMIN); Name (name) |
| `uranium` | Uranium legacy sites | Navajo Nation abandoned uranium mines and DOE mill-tailings sites | Navajo Nation AUM program, DOE Legacy Management | Western US | 20,000,000; to 80,000,000 the 2,000 named | None | Static (2007 hazard scores) | Kind (category): Abandoned mine, Mill tailings site, Leasing program; Hazard score (2007) (measure, score, 3 presets); EPA cleanup step (ordinal, EPA Superfund removal steps: site screening, removal site evaluation, removal site assessment, design for cleanup): Screened, Evaluated, Assessed, Cleanup designed; Cleanup paid by (category): Tronox bankruptcy settlement, Environmental response trust (phase 1), Environmental response trust (phase 2), A responsible company, under EPA enforcement, No settlement or enforcement yet; EPA priority mine (flag); Name (name) |
| `ocean-currents` | Ocean currents (hourly, moving) | Surface and tidal currents hour by hour as moving particles, with the tide at the nearest station | Open-Meteo Marine (Météo-France SMOC); NOAA CO-OPS | Global | 4,000,000 | None | Hourly forecast (cached 3 hours) | Current speed (measure, m/s); Water temperature (measure, °C) |
| `wind-flow` | Wind (hourly, moving) | Wind 10 m above the ground hour by hour as moving particles, colored by temperature | Open-Meteo forecast | Global | 4,000,000 | None | Hourly forecast (cached 1 hour) | Wind speed (measure, m/s); Air temperature (measure, °C) |
| `forest-types` | Forest types | Primary, regenerating and planted forest, plantations, tree crops; natural forest converted since a year | ForTy (Google DeepMind, WRI, IIASA) via Earth Engine | Global | Any | `EE_PROJECT` (required), `EE_SERVICE_ACCOUNT_JSON` (optional), `GOOGLE_APPLICATION_CREDENTIALS` (optional) | 2020 baseline; yearly beta 2017–2025 | Forest type (category): Primary forest, Naturally regenerating forest, Planted forest, Plantation forest, Tree crops and agroforestry, Other land |
| `terrain` | Terrain: slope, aspect and shade | Slope angle, aspect and ground in its own shade, computed from an elevation model | AWS Terrain Tiles (USGS 3DEP, SRTM) | Global | 5,000 | None | Static |  |
| `weather-forecast` | Weather forecast (7 days, hourly) | Hourly 7-day forecast at the asked place: temperature, rain or snow, wind and gusts | National Weather Service; Open-Meteo outside the US | Global | 2,000,000 | None | Live (hourly) | Temperature (measure, °F); Chance of rain or snow (measure, %); Wind (measure, mph); Gusts (measure, mph); Point (category): Asked place, Across the view |
| `avalanche` | Avalanche forecasts (US avalanche centers) | Today's avalanche danger by backcountry forecast zone | US avalanche centers via avalanche.org | US | 10,000,000 | None | Daily in season | Avalanche danger (ordinal, North American Public Avalanche Danger Scale (1 Low to 5 Extreme)): No rating, 1 Low, 2 Moderate, 3 Considerable, 4 High, 5 Extreme; Avalanche center (category, from the data) |
| `vegetation-types` | Vegetation types | 849 named vegetation types (ecological systems) in eight groups, with their shares of the view | LANDFIRE EVT (USGS, US Forest Service) via Earth Engine | US | Any | `EE_PROJECT` (required), `EE_SERVICE_ACCOUNT_JSON` (optional), `GOOGLE_APPLICATION_CREDENTIALS` (optional) | Static (about 2014) | Vegetation group (category, 8 values) |
| `ecoregions` | Ecoregions | Named ecoregion outlines with their share of the view: EPA Level III and IV, RESOLVE outside the US | US EPA; RESOLVE Ecoregions 2017, via Earth Engine | Global | Any | `EE_PROJECT` (required), `EE_SERVICE_ACCOUNT_JSON` (optional), `GOOGLE_APPLICATION_CREDENTIALS` (optional) | Static (2013, 2017) | Level (category): EPA Level III ecoregion, EPA Level IV ecoregion, RESOLVE ecoregion; Share of view (measure, share of 1) |
| `canopy-height` | Canopy height | Height of the tree canopy at about 1 m, with the median and tallest trees in view | Meta and WRI canopy height via Earth Engine | Global | Any | `EE_PROJECT` (required), `EE_SERVICE_ACCOUNT_JSON` (optional), `GOOGLE_APPLICATION_CREDENTIALS` (optional) | Static (imagery 2018–2020) |  |
<!-- layers:end -->

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
- [ ] Dated features carry `t`; a headline number goes in `v`, and a 0 to 100 score sets `style.unit: "score"`.
- [ ] A point layer has a legend symbol in `lib/render/wally/pins.ts` (or accepts the plain circle).
- [ ] `scripts/layer-table.mts` has an entry for the layer; then run it with `--write` to refresh the tables in the README and here.
- [ ] `pnpm test` passes with no keys set.

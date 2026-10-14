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

WallyMap ships 81 data layers. This table is generated from the layer registry by `pnpm exec tsx scripts/layer-table.mts --write`, which also refreshes the copy in the README.

<!-- layers:start -->
| Id | Title | What it shows | Source | Coverage | Area (km²) | Key needed | Freshness |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `osm-trails` | OpenStreetMap trails | Hiking paths and tracks with difficulty and surface | OpenStreetMap | Global | 2,500; to 400,000 the 150 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `fire-perimeters` | Wildfire perimeters | Current and past US wildfire outlines | NIFC (WFIGS) | US | 60,000; to 16,000,000 the 500 largest by acres burned | None | Updated through the fire season |
| `fire-detections` | Active fire detections | Satellite hotspots from the last 1 to 10 days | NASA FIRMS | Global | 2,000,000; to 8,000,000 the 5,000 newest by detection time | `FIRMS_MAP_KEY` (required) | Near real time (hours) |
| `forest-loss` | Tree cover loss | Where tree cover was lost, by year | UMD / Global Forest Watch | Global | Any | None | Yearly |
| `forest-alerts` | Forest disturbance alerts | Recent forest clearing in the tropics | Global Forest Watch (GLAD, RADD) | Tropics (30°S to 30°N) | Any | None | Weekly |
| `snowpack` | Snowpack (SNOTEL, live) | Snow depth, water equivalent, density and snow type at mountain weather stations | USDA NRCS SNOTEL | Western US | 400,000; to 50,000,000 the 1,000 largest by snow depth in inches | None | Live (hourly readings) |
| `forest-roads` | Forest Service roads open to motor vehicles | Forest Service roads open to motor vehicles | USDA Forest Service MVUM | US | 25,000 | None | Yearly |
| `campsites` | Campsites and parking lots | Campsites and parking lots | OpenStreetMap | Global | 25,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `streamflow` | Stream flow (USGS gauges, live) | River flow, gauge height and flow against the usual for the day at stream gauges | USGS Water Data | Global | 400,000; to 1,600,000 the 1,000 largest by current flow or gage height | `USGS_API_KEY` (optional), `OVERPASS_URL` (optional) | Live (15 minutes), provisional |
| `species` | Species sightings | Wildlife and plant sightings | iNaturalist | Global | 50,000; to 200,000 the 2,000 most recent by date observed | None | Daily |
| `population` | Population density | Where people live | NASA GIBS (GPW v4) | Global | Any | None | Fixed at 2020 |
| `night-lights` | Night lights | Satellite picture of the Earth at night | NASA GIBS (VIIRS) | Global | Any | None | Daily (date in the note) |
| `wilderness` | Wilderness areas | Designated wilderness boundaries | Wilderness.net / USGS | US | 400,000 | None | Updated occasionally |
| `photos` | Photo density | Where geotagged photos were taken | Wikimedia Commons, Mapillary | Global | 2,500; to 10,000 the 500 named by number of Wikipedia languages | `MAPILLARY_TOKEN` (optional) | Live |
| `physical-regions` | Named physical regions | Named mountain ranges, deserts and plateaus | Natural Earth | Global | 30,000,000 | None | Static |
| `public-lands` | Public land ownership | Who owns and manages the land | USGS PAD-US 4.1 | US | Any | `PADUS_TILES_URL` (optional) | Static (release 4.1) |
| `popularity` | Trail popularity estimate | Estimated popularity score (0 to 100) per trail | Computed from OSM, Commons, Mapillary | Global | 2,500 | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `popularity-campsites` | Campsite popularity estimate | Estimated popularity score (0 to 100) per campsite | Computed from OSM, Commons, Mapillary | Global | 2,500 | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `remoteness` | Remoteness score | Remoteness score (0 to 100) per hexagon | Computed from OSM and wilderness boundaries | Global | 60,000 | `OVERPASS_URL` (optional) | Computed per query |
| `mtb-trails` | Mountain bike trails | Mountain bike trails rated 0 to 6 on the Singletrack Scale | OpenStreetMap | Global | 2,500; to 10,000 the 1,000 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `earthquakes` | Earthquakes | Recent earthquakes with magnitude, depth and time | USGS Earthquake Catalog | Global | 5,000,000; to 20,000,000 the 2,000 strongest by magnitude | None | Live (minutes) |
| `ski-routes` | Ski runs, nordic trails and ski touring routes | Downhill runs, nordic trails and ski touring routes | OpenStreetMap | Global | 2,500; to 10,000 the 1,000 named by length in km | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `recreation-sites` | Recreation sites | Developed recreation sites: campgrounds, trailheads, boat ramps, day use | USDA Forest Service, BLM | US | 10,000; to 1,500,000 the 2,000 named | None | Nightly feeds |
| `glaciers` | Glaciers | Glacier and ice cap outlines with area | GLIMS (NSIDC) | Global | 8,000; to 32,000 the 1,500 largest by area in km² | None | Static (survey dates per glacier) |
| `geology` | Geology | Geologic map units as map tiles | Macrostrat | Global | Any | None | Static |
| `climbing` | Climbing crags, boulders and areas | Climbing crags, boulders and areas with route counts | OpenStreetMap, OpenBeta | Global | 10,000; to 40,000 the 1,000 largest by route count | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `critical-habitat` | Critical habitat | Designated critical habitat for threatened and endangered species | US Fish and Wildlife Service | US | 300,000; to 1,200,000 the 1,000 largest by area | None | Updated as designated |
| `grazing-allotments` | Grazing allotments and wild horse areas | Livestock grazing allotments and wild horse and burro areas | Bureau of Land Management | US | 150,000; to 600,000 the 1,000 largest by acres | None | Updated occasionally |
| `paddling` | Whitewater rapids, put-ins and canoe routes | Rapids, river sections, put-ins and canoe routes | OpenStreetMap | Global | 2,500; to 10,000 the 1,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `gbif-occurrences` | GBIF occurrence records | Species records by scientific name, or a world density map | GBIF | Global | 50,000; to any size a density map | None | Daily |
| `surf` | Surf and waves (NOAA buoys, live) | Wave height, period and direction at buoys; forecast and typical months | NOAA NDBC, Open-Meteo Marine | Global | 500,000; to 50,000,000 the 1,000 largest by wave height in metres | None | Live (under an hour) |
| `peaks` | Peaks | Named peaks with elevation and prominence | Wikidata | Global | 40,000; to 160,000 the 1,000 most prominent by prominence | None | Live (community edits) |
| `greenness` | Vegetation greenness | How green the vegetation is (NDVI or EVI) | NASA GIBS (MODIS Terra) | Global | Any | None | Every 16 days, back to 2000 |
| `protected-areas-world` | Protected areas of the world | Protected areas worldwide as map tiles | WDPA (UNEP-WCMC, IUCN) | Global | Any | None | Monthly |
| `fire-hazard` | Wildfire hazard potential | Long-run wildfire hazard potential in five classes | USDA Forest Service (WHP 2023) | US | Any | None | Static (2023) |
| `flood-zones` | FEMA flood zones | FEMA flood hazard zones (zoom 14 and closer) | FEMA National Flood Hazard Layer | US | Any | None | Updated as maps change |
| `snow-cover` | Snow cover | Where the ground is snow-covered; US snow depth | NASA GIBS (MODIS Terra), NOAA NOHRSC | Global | Any | None | Daily, back to 2000 |
| `outdoor-features` | Huts, springs, peaks and other backcountry features | Huts, shelters, springs, viewpoints, caves, hot springs, waterfalls, passes | OpenStreetMap | Global | 10,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `tides` | Tides (NOAA, next high and low) | Next high and low tides at tide stations | NOAA CO-OPS | US | 50,000; to 50,000,000 the 1,000 largest by next tide height in feet | None | Live predictions and gauges |
| `land-cover` | Land cover | What covers the ground: trees, crops, built-up, water | ESA WorldCover, USGS NLCD | Global | Any | None | Static (2021; NLCD map years) |
| `wikipedia-nearby` | Wikipedia nearby | Wikipedia articles about places in view | Wikipedia | Global | 1,000; to 4,000 the 500 named by number of Wikipedia languages | None | Live |
| `surface-water` | Surface water history | Where surface water has been seen, 1984 to 2021 | EC JRC Global Surface Water | Global | Any | None | Static (1984 to 2021) |
| `flood-extent` | Flood and surface water extent | Open water and floods from satellite | NASA GIBS (OPERA, MODIS) | Global | Any | None | Daily, a few days behind |
| `disturbance` | Vegetation disturbance alerts | Where vegetation was just lost or damaged | NASA GIBS (OPERA) | Global | Any | None | Daily, about 3 days behind |
| `sea-ice` | Sea ice | Sea ice concentration and extent | NASA GIBS (GHRSST MUR, MODIS) | Global | Any | None | Daily, back to 2000 |
| `fire-weather` | Fire weather (fire danger) | Fire danger forecast (Fire Weather Index) | EC JRC GWIS / EFFIS | Global | Any | None | Daily, up to 9 days ahead |
| `lakes` | Lakes and reservoirs | Named lakes and reservoirs with maximum depth | Wikidata | Global | 20,000; to 80,000 the 1,000 largest by area | None | Live (community edits) |
| `drought` | Drought | Weekly drought categories D0 to D4 | U.S. Drought Monitor (NDMC) | US | 16,000,000 | None | Weekly |
| `phenology` | Spring arrival (leaf-out and bloom) | Whether spring leaf-out and bloom came early or late | USA National Phenology Network | Lower 48 states | Any | None | Daily this year; yearly back to 1981 |
| `burn-severity` | Burned areas of large fires (MTBS) | Burned areas of large fires, by year | MTBS (USGS, USFS) | US | Any | None | Yearly, about 18 months behind |
| `smoke` | Wildfire smoke | Wildfire smoke plumes by density | NOAA Hazard Mapping System | North and Central America | Any | None | Daily |
| `geologic-unit` | Geologic unit at a point | The rock unit, age and rock type under one point | Macrostrat | Global | Any | None | Static |
| `fishing` | Fishing (access, boat ramps, recent catches, water temperature) | Fishing access, boat ramps, piers, recent fish sightings, water temperature | OpenStreetMap, USFS, iNaturalist, USGS | Global | 50,000; to 1,500,000 the 2,000 named | `OVERPASS_URL` (optional) | Live |
| `weather-alerts` | Weather alerts (NWS, live) and current weather | Active weather warnings and the weather right now | NOAA National Weather Service, Open-Meteo | Global | 400,000; to 1,600,000 the 1,000 most severe by severity | None | Live (minutes) |
| `sequoia-groves` | Giant sequoia groves | The 96 giant sequoia groves | NPS Sequoia and Kings Canyon, USFS | Sierra Nevada, California | 120,000; to 480,000 the 1,000 largest by acres | None | Static (2024) |
| `sea-level-trends` | Sea level trends (NOAA tide gauges) | Measured long-term sea level trend at tide gauges (mm/yr) | NOAA CO-OPS | Global | 30,000,000; to 120,000,000 the 1,000 fastest-rising by trend in mm/yr | None | Yearly |
| `sequoia-mortality` | Giant sequoia fire survival | Giant sequoias alive or dead after the 2020 and 2021 fires | USGS | Sequoia and Kings Canyon NPs | 400,000; to 1,600,000 the 3,000 largest by trunk diameter in cm | None | Static (post-fire surveys) |
| `reservoir-levels` | Reservoir levels | Storage, level, percent full and history of major reservoirs | US Bureau of Reclamation, California CDEC | Western US | 3,000,000; to 12,000,000 the 1,000 largest by storage in acre-feet | None | Daily, 1 to 2 days behind; provisional |
| `sea-level-rise` | Sea level rise flooding (NOAA scenarios) | Coastal land under water at high tide for 0 to 10 feet of rise | NOAA Sea Level Rise Viewer | US | Any | None | Static scenarios |
| `old-growth` | Old-growth and mature forest | Old-growth and mature forest acres per fireshed | US Forest Service | US | 300,000; to 1,200,000 the 1,000 largest by old-growth acres | None | Static (2023 inventory) |
| `carbon-flux` | Forest carbon flux | Forest carbon sink or source per hectare per year | Global Forest Watch (Harris et al.) | Global | Any | None | Static (2001 to 2025 average) |
| `condor-range` | California condor range | California condor range today and in the early 1800s | NPS Sequoia and Kings Canyon | Western North America | 20,000,000; to 80,000,000 the 1,000 largest by area | None | Static |
| `dams` | Dams | Dams with storage, height, purpose, hazard and year built | USACE National Inventory of Dams | US | 250,000; to 50,000,000 the 2,000 largest by storage in acre-feet | None | Updated yearly |
| `wolf-packs` | Wolf packs (Washington) | Gray wolf pack ranges by year | Washington Dept. of Fish and Wildlife | Washington state | 300,000; to 1,200,000 the 1,000 newest by year | None | Yearly (2014 to 2025) |
| `methane-plumes` | Methane plumes (Carbon Mapper) | Methane plumes and emission sources with rates | Carbon Mapper (non-commercial) | Global | 500,000; to 2,000,000 the 1,000 largest by emission rate in kg/h | None | Days to weeks after each pass |
| `ports` | Principal US ports | The 150 principal US ports by 2023 cargo tonnage | USACE via BTS | US | Any | None | Yearly (2023) |
| `river-basins` | River basins and watersheds | Watersheds at a level that follows the zoom (HUC2 to HUC10) | USGS Watershed Boundary Dataset | US | 20,000,000; to 80,000,000 the 1,000 largest by area in km² | None | Updated occasionally |
| `hardiness-zones` | Plant hardiness zones | Plant hardiness zones as map tiles | USDA-ARS, Oregon State PRISM | Lower 48 states | Any | None | Static (2023) |
| `temperature-anomaly` | Temperature anomaly by county (NOAA) | County temperature against the 1901-2000 normal (°F) | NOAA NCEI Climate at a Glance | Lower 48 states | 16,000,000 | None | Monthly, about the 8th |
| `pipelines-lines` | Pipelines and power lines | Gas, oil and products pipelines and high-voltage power lines | EIA, HIFLD | US | 150,000; to 600,000 the 3,000 largest by length, power lines by voltage | None | Updated occasionally |
| `aquifers` | Principal aquifers | Principal aquifer outlines by rock type | USGS Principal Aquifers | US | 6,000,000; to 24,000,000 the 1,000 largest by area | None | Static (2003) |
| `groundwater` | Groundwater levels | Depth to water at monitoring wells (newest reading) | USGS Water Data | US | 40,000; to 160,000 the 2,000 first | `USGS_API_KEY` (optional) | As wells are measured |
| `power-plants` | Power plants, wind and solar | Power plants by fuel, wind turbines and large solar, in MW | EIA, USGS wind and solar databases | US | 250,000; to 50,000,000 the 2,000 largest by capacity in MW | None | Quarterly to yearly |
| `disasters` | Disasters (GDACS alerts and FEMA declarations) | Disaster alerts worldwide and FEMA declarations per US county | GDACS, OpenFEMA | Global | Any | None | Live (hourly) |
| `monuments` | National monuments and conservation areas | BLM national monuments now and Utah's 2021 boundaries | BLM, Utah AGRC | US | 20,000,000; to 80,000,000 the 1,000 largest by area | None | Current (July 2026 changes) |
| `tree-mortality` | Tree death (beetles, drought, disease) | Where trees died each year (beetles, drought, disease) | USFS aerial survey, California DFW | US | 20,000; to 80,000 the 2,000 worst by trees killed, or percent dead from 2021 | None | Yearly (California to 2019, US 2021 to 2025) |
| `permafrost` | Permafrost zones | Permafrost zones from continuous to isolated | IPA Circum-Arctic map, NRCan | Northern Hemisphere | 5,000,000 | None | Static |
| `mining-claims` | Mining claims | Active and closed mining claims on public land | BLM MLRS | US | 2,500; to 10,000 the 2,000 named | None | Daily |
| `imagery-by-date` | Satellite image by date (Landsat and Sentinel-2) | True-colour 30 m satellite picture on a chosen day | NASA HLS (Landsat, Sentinel-2) via GIBS | Global | 1,000,000 | None | Every few days, about 2 days behind |
| `mines` | Mines and mineral deposits | Mines, prospects and mineral deposits by commodity | USGS MRDS, USMIN | US | 15,000; to 60,000 the 2,000 named | None | Static (about 2011) |
| `uranium` | Uranium legacy sites | Navajo Nation abandoned uranium mines and DOE mill-tailings sites | Navajo Nation AUM program, DOE Legacy Management | Western US | 20,000,000; to 80,000,000 the 2,000 named | None | Static (2007 hazard scores) |
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

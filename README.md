# WallyMap

WallyMap is an open-source research tool for the outdoors: a chat agent that puts outdoor data on a Mapbox map, with every answer drawn, cited, and exportable. Ask a question in plain language, and the agent picks the right data layers and shows them on the map: trails, fire, forest loss, snow, water, campsites, wildlife, photos, public lands, and computed popularity and remoteness scores. It runs on Next.js, and you bring your own model: OpenRouter, Anthropic directly, or any OpenAI-compatible server.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/kseylerp/mapagent)

## Quickstart

```bash
git clone https://github.com/kseylerp/mapagent
cd mapagent
cp .env.example .env.local
pnpm i
pnpm dev
```

Then open http://localhost:3000. Fill in `.env.local` first; each variable in `.env.example` has a comment explaining what it unlocks.

## What you can do

- **Ask, and get a drawn, cited answer.** Type a question in plain language. The agent finds the place, queries the right layers, draws them on the map, and writes a short note that ends with a Sources line.
- **Click any feature for details.** An inspect card shows its properties, the citation, and buttons to ask the agent about it, copy it as GeoJSON, or preview it when it is a route. Clicking never moves the camera.
- **Run the layer console.** The right-hand pane is a legend table: one row per layer with its symbol, source, and count. Each row has visibility, an opacity slider, a draw mode (points, lines, polygons, heat, columns, hexagons), removal, and drag to reorder. A Filters disclosure on each row lists the layer's own attributes (category chips and numeric ranges); filters change the map, the counts, and the export at once, and the agent can set them through `render`.
- **Scrub through time.** When a loaded layer has dated features, a time scrubber at the top of the console shows a histogram, a draggable window, play and pause (one step every 0.6 seconds), and slide or cumulative mode. Ask "show wildfires near Yosemite year by year since 2016" and the agent sets the window and plays it with its `set_time` tool. Night lights and tree cover loss also change their imagery with the window.
- **Plan and preview routes.** Ask for a walking, cycling, or driving route between two places and the `route` tool draws it as a purple-to-coral line with direction arrows, mile markers, and a start pin. Route preview flies the camera along the line while an elevation profile tracks your position, with play, speed, and scrub controls. A trail you click, or a route you build, can be previewed the same way.
- **See it in 3D.** Terrain, buildings, and a sky are on by default and the camera tilts as you zoom in. The 3D button in the bottom-right corner flattens the map and brings it back.
- **Switch the basemap.** Choose Topographical + Satellite (the default), Topographical, or Satellite from the pills in the top-left corner.
- **Export the view.** Export in the top-left pills opens a confirm step that lists the files and their size; nothing downloads until you confirm. You get one GeoJSON file per visible layer (with its time window and filters applied) and a `citations.md` covering every visible layer, the viewport, and the export time. Four or more files come down as a single zip.
- **Share a link.** The page address (the part after `#`) records the camera, basemap, layers with their draw modes, and time window. Open it and WallyMap fetches the layers again, so a link carries layer ids, not data. Route results and anything not in the layer catalog are not part of a link.

**Research-tool guarantees.** Every answer ends with a Sources line that names only the layers the agent actually queried. Computed layers say they are estimates and list their signals. Empty or capped results say so in a note instead of failing quietly. Nothing is downloaded without an explicit click on a confirmed Export.

## Layers

WallyMap ships 81 data layers. The agent gets one `query_<id>` tool per layer and picks them from your question. This table is generated from the layer registry by `pnpm exec tsx scripts/layer-table.mts --write`.

<!-- layers:start -->
| Id | Title | What it shows | Source | Coverage | Key needed | Freshness |
| --- | --- | --- | --- | --- | --- | --- |
| `osm-trails` | OpenStreetMap trails | Hiking paths and tracks with difficulty and surface | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `fire-perimeters` | Wildfire perimeters | Current and past US wildfire outlines | NIFC (WFIGS) | US | None | Updated through the fire season |
| `fire-detections` | Active fire detections | Satellite hotspots from the last 1 to 10 days | NASA FIRMS | Global | `FIRMS_MAP_KEY` (required) | Near real time (hours) |
| `forest-loss` | Tree cover loss | Where tree cover was lost, by year | UMD / Global Forest Watch | Global | None | Yearly |
| `forest-alerts` | Forest disturbance alerts | Recent forest clearing in the tropics | Global Forest Watch (GLAD, RADD) | Tropics (30°S to 30°N) | None | Weekly |
| `snowpack` | Snowpack (SNOTEL, live) | Snow depth, water equivalent, density and snow type at mountain weather stations | USDA NRCS SNOTEL | Western US | None | Live (hourly readings) |
| `forest-roads` | Forest Service roads open to motor vehicles | Forest Service roads open to motor vehicles | USDA Forest Service MVUM | US | None | Yearly |
| `campsites` | Campsites and parking lots | Campsites and parking lots | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `streamflow` | Stream flow (USGS gauges, live) | River flow, gauge height and flow against the usual for the day at stream gauges | USGS Water Data | Global | `USGS_API_KEY` (optional), `OVERPASS_URL` (optional) | Live (15 minutes), provisional |
| `species` | Species sightings | Wildlife and plant sightings | iNaturalist | Global | None | Daily |
| `population` | Population density | Where people live | NASA GIBS (GPW v4) | Global | None | Fixed at 2020 |
| `night-lights` | Night lights | Satellite picture of the Earth at night | NASA GIBS (VIIRS) | Global | None | Daily (date in the note) |
| `wilderness` | Wilderness areas | Designated wilderness boundaries | Wilderness.net / USGS | US | None | Updated occasionally |
| `photos` | Photo density | Where geotagged photos were taken | Wikimedia Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional) | Live |
| `physical-regions` | Named physical regions | Named mountain ranges, deserts and plateaus | Natural Earth | Global | None | Static |
| `public-lands` | Public land ownership | Who owns and manages the land | USGS PAD-US 4.1 | US | `PADUS_TILES_URL` (optional) | Static (release 4.1) |
| `popularity` | Trail popularity estimate | Estimated popularity score (0 to 100) per trail | Computed from OSM, Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `popularity-campsites` | Campsite popularity estimate | Estimated popularity score (0 to 100) per campsite | Computed from OSM, Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `remoteness` | Remoteness score | Remoteness score (0 to 100) per hexagon | Computed from OSM and wilderness boundaries | Global | `OVERPASS_URL` (optional) | Computed per query |
| `mtb-trails` | Mountain bike trails | Mountain bike trails rated 0 to 6 on the Singletrack Scale | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `earthquakes` | Earthquakes | Recent earthquakes with magnitude, depth and time | USGS Earthquake Catalog | Global | None | Live (minutes) |
| `ski-routes` | Ski runs, nordic trails and ski touring routes | Downhill runs, nordic trails and ski touring routes | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `recreation-sites` | Recreation sites | Developed recreation sites: campgrounds, trailheads, boat ramps, day use | USDA Forest Service, BLM | US | None | Nightly feeds |
| `glaciers` | Glaciers | Glacier and ice cap outlines with area | GLIMS (NSIDC) | Global | None | Static (survey dates per glacier) |
| `geology` | Geology | Geologic map units as map tiles | Macrostrat | Global | None | Static |
| `climbing` | Climbing crags, boulders and areas | Climbing crags, boulders and areas with route counts | OpenStreetMap, OpenBeta | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `critical-habitat` | Critical habitat | Designated critical habitat for threatened and endangered species | US Fish and Wildlife Service | US | None | Updated as designated |
| `grazing-allotments` | Grazing allotments and wild horse areas | Livestock grazing allotments and wild horse and burro areas | Bureau of Land Management | US | None | Updated occasionally |
| `paddling` | Whitewater rapids, put-ins and canoe routes | Rapids, river sections, put-ins and canoe routes | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `gbif-occurrences` | GBIF occurrence records | Species records by scientific name, or a world density map | GBIF | Global | None | Daily |
| `surf` | Surf and waves (NOAA buoys, live) | Wave height, period and direction at buoys; forecast and typical months | NOAA NDBC, Open-Meteo Marine | Global | None | Live (under an hour) |
| `peaks` | Peaks | Named peaks with elevation and prominence | Wikidata | Global | None | Live (community edits) |
| `greenness` | Vegetation greenness | How green the vegetation is (NDVI or EVI) | NASA GIBS (MODIS Terra) | Global | None | Every 16 days, back to 2000 |
| `protected-areas-world` | Protected areas of the world | Protected areas worldwide as map tiles | WDPA (UNEP-WCMC, IUCN) | Global | None | Monthly |
| `fire-hazard` | Wildfire hazard potential | Long-run wildfire hazard potential in five classes | USDA Forest Service (WHP 2023) | US | None | Static (2023) |
| `flood-zones` | FEMA flood zones | FEMA flood hazard zones (zoom 14 and closer) | FEMA National Flood Hazard Layer | US | None | Updated as maps change |
| `snow-cover` | Snow cover | Where the ground is snow-covered; US snow depth | NASA GIBS (MODIS Terra), NOAA NOHRSC | Global | None | Daily, back to 2000 |
| `outdoor-features` | Huts, springs, peaks and other backcountry features | Huts, shelters, springs, viewpoints, caves, hot springs, waterfalls, passes | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `tides` | Tides (NOAA, next high and low) | Next high and low tides at tide stations | NOAA CO-OPS | US | None | Live predictions and gauges |
| `land-cover` | Land cover | What covers the ground: trees, crops, built-up, water | ESA WorldCover, USGS NLCD | Global | None | Static (2021; NLCD map years) |
| `wikipedia-nearby` | Wikipedia nearby | Wikipedia articles about places in view | Wikipedia | Global | None | Live |
| `surface-water` | Surface water history | Where surface water has been seen, 1984 to 2021 | EC JRC Global Surface Water | Global | None | Static (1984 to 2021) |
| `flood-extent` | Flood and surface water extent | Open water and floods from satellite | NASA GIBS (OPERA, MODIS) | Global | None | Daily, a few days behind |
| `disturbance` | Vegetation disturbance alerts | Where vegetation was just lost or damaged | NASA GIBS (OPERA) | Global | None | Daily, about 3 days behind |
| `sea-ice` | Sea ice | Sea ice concentration and extent | NASA GIBS (GHRSST MUR, MODIS) | Global | None | Daily, back to 2000 |
| `fire-weather` | Fire weather (fire danger) | Fire danger forecast (Fire Weather Index) | EC JRC GWIS / EFFIS | Global | None | Daily, up to 9 days ahead |
| `lakes` | Lakes and reservoirs | Named lakes and reservoirs with maximum depth | Wikidata | Global | None | Live (community edits) |
| `drought` | Drought | Weekly drought categories D0 to D4 | U.S. Drought Monitor (NDMC) | US | None | Weekly |
| `phenology` | Spring arrival (leaf-out and bloom) | Whether spring leaf-out and bloom came early or late | USA National Phenology Network | Lower 48 states | None | Daily this year; yearly back to 1981 |
| `burn-severity` | Burned areas of large fires (MTBS) | Burned areas of large fires, by year | MTBS (USGS, USFS) | US | None | Yearly, about 18 months behind |
| `smoke` | Wildfire smoke | Wildfire smoke plumes by density | NOAA Hazard Mapping System | North and Central America | None | Daily |
| `geologic-unit` | Geologic unit at a point | The rock unit, age and rock type under one point | Macrostrat | Global | None | Static |
| `fishing` | Fishing (access, boat ramps, recent catches, water temperature) | Fishing access, boat ramps, piers, recent fish sightings, water temperature | OpenStreetMap, USFS, iNaturalist, USGS | Global | `OVERPASS_URL` (optional) | Live |
| `weather-alerts` | Weather alerts (NWS, live) and current weather | Active weather warnings and the weather right now | NOAA National Weather Service, Open-Meteo | Global | None | Live (minutes) |
| `sequoia-groves` | Giant sequoia groves | The 96 giant sequoia groves | NPS Sequoia and Kings Canyon, USFS | Sierra Nevada, California | None | Static (2024) |
| `sea-level-trends` | Sea level trends (NOAA tide gauges) | Measured long-term sea level trend at tide gauges (mm/yr) | NOAA CO-OPS | Global | None | Yearly |
| `sequoia-mortality` | Giant sequoia fire survival | Giant sequoias alive or dead after the 2020 and 2021 fires | USGS | Sequoia and Kings Canyon NPs | None | Static (post-fire surveys) |
| `reservoir-levels` | Reservoir levels | Storage, level, percent full and history of major reservoirs | US Bureau of Reclamation, California CDEC | Western US | None | Daily, 1 to 2 days behind; provisional |
| `sea-level-rise` | Sea level rise flooding (NOAA scenarios) | Coastal land under water at high tide for 0 to 10 feet of rise | NOAA Sea Level Rise Viewer | US | None | Static scenarios |
| `old-growth` | Old-growth and mature forest | Old-growth and mature forest acres per fireshed | US Forest Service | US | None | Static (2023 inventory) |
| `carbon-flux` | Forest carbon flux | Forest carbon sink or source per hectare per year | Global Forest Watch (Harris et al.) | Global | None | Static (2001 to 2025 average) |
| `condor-range` | California condor range | California condor range today and in the early 1800s | NPS Sequoia and Kings Canyon | Western North America | None | Static |
| `dams` | Dams | Dams with storage, height, purpose, hazard and year built | USACE National Inventory of Dams | US | None | Updated yearly |
| `wolf-packs` | Wolf packs (Washington) | Gray wolf pack ranges by year | Washington Dept. of Fish and Wildlife | Washington state | None | Yearly (2014 to 2025) |
| `methane-plumes` | Methane plumes (Carbon Mapper) | Methane plumes and emission sources with rates | Carbon Mapper (non-commercial) | Global | None | Days to weeks after each pass |
| `ports` | Principal US ports | The 150 principal US ports by 2023 cargo tonnage | USACE via BTS | US | None | Yearly (2023) |
| `river-basins` | River basins and watersheds | Watersheds at a level that follows the zoom (HUC2 to HUC10) | USGS Watershed Boundary Dataset | US | None | Updated occasionally |
| `hardiness-zones` | Plant hardiness zones | Plant hardiness zones as map tiles | USDA-ARS, Oregon State PRISM | Lower 48 states | None | Static (2023) |
| `temperature-anomaly` | Temperature anomaly by county (NOAA) | County temperature against the 1901-2000 normal (°F) | NOAA NCEI Climate at a Glance | Lower 48 states | None | Monthly, about the 8th |
| `pipelines-lines` | Pipelines and power lines | Gas, oil and products pipelines and high-voltage power lines | EIA, HIFLD | US | None | Updated occasionally |
| `aquifers` | Principal aquifers | Principal aquifer outlines by rock type | USGS Principal Aquifers | US | None | Static (2003) |
| `groundwater` | Groundwater levels | Depth to water at monitoring wells (newest reading) | USGS Water Data | US | `USGS_API_KEY` (optional) | As wells are measured |
| `power-plants` | Power plants, wind and solar | Power plants by fuel, wind turbines and large solar, in MW | EIA, USGS wind and solar databases | US | None | Quarterly to yearly |
| `disasters` | Disasters (GDACS alerts and FEMA declarations) | Disaster alerts worldwide and FEMA declarations per US county | GDACS, OpenFEMA | Global | None | Live (hourly) |
| `monuments` | National monuments and conservation areas | BLM national monuments now and Utah's 2021 boundaries | BLM, Utah AGRC | US | None | Current (July 2026 changes) |
| `tree-mortality` | Tree death (beetles, drought, disease) | Where trees died each year (beetles, drought, disease) | USFS aerial survey, California DFW | US | None | Yearly (California to 2019, US 2021 to 2025) |
| `permafrost` | Permafrost zones | Permafrost zones from continuous to isolated | IPA Circum-Arctic map, NRCan | Northern Hemisphere | None | Static |
| `mining-claims` | Mining claims | Active and closed mining claims on public land | BLM MLRS | US | None | Daily |
| `imagery-by-date` | Satellite image by date (Landsat and Sentinel-2) | True-colour 30 m satellite picture on a chosen day | NASA HLS (Landsat, Sentinel-2) via GIBS | Global | None | Every few days, about 2 days behind |
| `mines` | Mines and mineral deposits | Mines, prospects and mineral deposits by commodity | USGS MRDS, USMIN | US | None | Static (about 2011) |
| `uranium` | Uranium legacy sites | Navajo Nation abandoned uranium mines and DOE mill-tailings sites | Navajo Nation AUM program, DOE Legacy Management | Western US | None | Static (2007 hazard scores) |
<!-- layers:end -->

**Keys per layer.** The Key needed column says which keys each layer requires and which it only uses when set. Only `fire-detections` requires a key (`FIRMS_MAP_KEY`); without it that layer reports itself unavailable and every other layer still works.

**Public lands tiles are hosted by the maintainer.** `public-lands` draws vector tiles from a Google Cloud Storage bucket the maintainer pays for (`storage.googleapis.com/wally-tiles`). Every deployment that uses the default sends its map traffic to that bucket, and the layer stops drawing if the bucket ever moves. If you deploy publicly, host your own copy and set `PADUS_TILES_URL` to its `{z}/{x}/{y}.pbf` template.

**Computed layers.** `popularity`, `popularity-campsites`, and `remoteness` are estimates, not measurements. They call other layers and combine what those return. Popularity scores each trail or campsite from 0 to 100 using geotagged photos nearby (Wikimedia Commons, plus Mapillary when configured), parking capacity, a Wikipedia or Wikidata link, informal trails, and whether the feature is named; the score ranks features against each other in the current view, so it is not a visitor count. Remoteness scores each hexagon from 0 to 100 using distance to roads, wilderness boundaries, and nearby campsites. Each result lists the signals behind the score and says which ones were left out when a source failed.

## Environment variables

Copy `.env.example` to `.env.local` and fill in what you need.

| Name | Required? | What it unlocks | Where to get it |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Yes | The map itself | [mapbox.com](https://account.mapbox.com/access-tokens/) |
| `MAPBOX_TOKEN` | No | Server-side place search (falls back to the public token) | [mapbox.com](https://account.mapbox.com/access-tokens/) |
| `MODEL_NAME` | Yes | Picks the model the agent uses | Your provider's model list |
| `MODEL_PROVIDER` | No | `openrouter` (default), `anthropic`, or `openai-compatible` | n/a |
| `OPENROUTER_API_KEY` | For the default provider | The chat agent via OpenRouter | [openrouter.ai](https://openrouter.ai/keys) |
| `ANTHROPIC_API_KEY` | When `MODEL_PROVIDER=anthropic` | The chat agent via Anthropic | [console.anthropic.com](https://console.anthropic.com/) |
| `OPENAI_COMPATIBLE_BASE_URL` | When `MODEL_PROVIDER=openai-compatible` | A local or third-party model server | Your server (for example `http://localhost:11434/v1`) |
| `OPENAI_COMPATIBLE_API_KEY` | No | Authenticated third-party endpoints | Your provider |
| `OVERPASS_URL` | Recommended (needed on Vercel in practice) | The Overpass endpoint for trails, campsites, popularity, and remoteness. The public `overpass-api.de` refused geometry queries from Vercel (HTTP 406), so a hosted deployment needs your own server or a keyed endpoint whose URL carries your key; keep a keyed URL secret. The public endpoint stays as the fallback | [wiki.openstreetmap.org](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| `FIRMS_MAP_KEY` | For `fire-detections` | Active fire hotspots (the layer reports itself unavailable without it) | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/) |
| `MAPILLARY_TOKEN` | No | Adds Mapillary street-level images to `photos` and popularity scores for views about 15 km across or smaller | [mapillary.com/developer](https://www.mapillary.com/developer) |
| `USGS_API_KEY` | No | A higher rate limit for `streamflow` (it works without one at a low limit) | [api.waterdata.usgs.gov/signup](https://api.waterdata.usgs.gov/signup/) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | No | Stores two things so every serverless instance shares them: the cache of upstream answers (kept up to a day, so a repeated query does not call the data source again) and the rate-limit counters. KV does not limit anything by itself. Without it, each instance keeps its own cache (up to 64 MB, least recently used out first) and counters in memory. Even with KV, a value over about 900 KB (the NOAA tide station list is about 2 MB) stays in the instance's memory, because Upstash refuses larger requests; the log says so once per key | Vercel KV |
| `RATE_LIMIT_CHAT` | No | Chat requests one caller (by IP address) may send per 10 minutes. Default 20; 0 turns it off | n/a |
| `RATE_LIMIT_LAYER` | No | `/api/layer/<id>` requests one caller may send per 10 minutes (opening a shared link makes one per layer). Default 120; 0 turns it off | n/a |
| `RATE_LIMIT_CHAT_DAILY` | No | Chat requests all callers together may send per day (UTC). Default 500; 0 turns it off | n/a |
| `PADUS_TILES_URL` | No | Your own copy of the `public-lands` vector tiles, as a `{z}/{x}/{y}.pbf` template. Default: the maintainer's bucket | Your storage |
| `NEXT_PUBLIC_NATURAL_EARTH_STYLE` | No | Natural Earth 2 basemap, which the agent can switch to | Mapbox Studio |

**Open-Meteo usage.** `surf` (with `forecast`), `weather-alerts` (the current-weather point) and `streamflow` outside the United States use Open-Meteo, which needs no key but is free for non-commercial use only and counts each location in a request toward a daily allowance of about 10,000. A non-US `streamflow` view samples 12 rivers at 9 model cells each, 108 locations (cached for an hour), and a `surf` forecast sends 16, so roughly 90 distinct non-US river views a day use up the free allowance. A commercial or busy deployment needs an Open-Meteo API plan.

## Bring your own key and model

WallyMap never picks a model for you. Set `MODEL_NAME` and the key for your provider.

**OpenRouter (default).** Set `OPENROUTER_API_KEY` and any OpenRouter model slug:

```bash
MODEL_NAME=anthropic/claude-haiku-5.5
# or
MODEL_NAME=qwen/qwen3-235b-a22b-2507
```

**Anthropic directly.**

```bash
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
MODEL_NAME=<an Anthropic model id>
```

**Any OpenAI-compatible server (Ollama, vLLM, and others).**

```bash
MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
MODEL_NAME=<the model name your server serves>
```

The model must support tool calling.

## Before you deploy publicly

Anyone who can reach your deployment can chat with the agent, and every message spends your model credits. The layer endpoint (`/api/layer/<id>`) also spends your third-party quotas (FIRMS, Mapillary, USGS, a keyed Overpass endpoint) for whoever calls it. Turn on [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (a password, or Vercel Authentication) before you share the URL; it covers every route, including the layer endpoint.

**Rate limits.** Both endpoints limit each caller by IP address: by default 20 chat requests and 120 layer requests per 10 minutes, plus 500 chat requests per day across everyone. A caller over a limit gets HTTP 429 with a `Retry-After` header, and the chat shows how many minutes to wait (or, when the shared daily cap is reached, says to try again tomorrow). The counters live in KV when it is configured; without KV they live in each serverless instance's memory, so every instance counts separately and forgets on restart, which makes the limits much looser. That includes the daily cap: without KV it is 500 per instance, not 500 in total. If KV is configured but fails, the limiter lets requests through rather than blocking everyone, so a KV outage also turns the limits off until it recovers. IPv6 callers are counted by their first 64 bits, since one household or server usually holds that whole block. The chat endpoint also rejects (HTTP 413) a request with more than 40 messages, more than 60,000 characters of text, or a body over 256 KB; the chat then says the conversation is too long and offers a New chat button.

## Tests

- `pnpm test` runs the unit tests. It needs no keys and no network.
- `pnpm exec tsx scripts/eval-model.mts "<question>"` runs one question through the real agent and prints one JSON line; add `--set` to run the eval set in [docs/questions.md](docs/questions.md). It needs your model key and spends credits.
- `pnpm e2e` runs the browser tests with Playwright. The page-load test always runs; the test that asks the agent a question is skipped unless `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` is set.

## Add a layer

See [docs/layers.md](docs/layers.md) for how to add your own data layer. The six starter questions and the tool calls expected for each are in [docs/questions.md](docs/questions.md).

## What is in the box and what is next

**Built:** 54 data layers (the table above), including live conditions (surf, river flow, tides, snowpack, weather alerts), dated satellite layers on the time scrubber, and computed popularity and remoteness scores; a vocabulary table that routes everyday words to the right layer; the layer console with legend, filters, and opacity; point render modes (symbols, clusters, heat, 3D columns) and extruded areas; the approved palette with hatching; the time scrubber and compare (swipe, toggle, and delta views of two moments, from the console or the agent); routes with preview and elevation profile; 3D terrain, export, and permalinks.

**Next:** see the open plans under `docs/superpowers/`.

## License

MIT

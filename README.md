# WildMap

WildMap (becoming WallyMap) is an open-source chat agent that draws outdoor data on a Mapbox map. Ask a question in plain language, and the agent picks the right data layers and shows them on the map: trails, fire, forest loss, snow, water, campsites, wildlife, photos, public lands, and computed popularity and remoteness scores. It runs on Next.js, and you bring your own model: OpenRouter, Anthropic directly, or any OpenAI-compatible server.

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

## Layers

WallyMap ships 19 data layers. The agent gets one `query_<id>` tool per layer and picks them from your question. This table is generated from the layer registry by `pnpm exec tsx scripts/layer-table.mts --write`.

<!-- layers:start -->
| Id | Title | What it shows | Source | Coverage | Key needed | Freshness |
| --- | --- | --- | --- | --- | --- | --- |
| `osm-trails` | OpenStreetMap trails | Hiking paths and tracks with difficulty and surface | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `fire-perimeters` | Wildfire perimeters | Current and past US wildfire outlines | NIFC (WFIGS) | US | None | Updated through the fire season |
| `fire-detections` | Active fire detections | Satellite hotspots from the last 1 to 10 days | NASA FIRMS | Global | `FIRMS_MAP_KEY` (required) | Near real time (hours) |
| `forest-loss` | Tree cover loss | Where tree cover was lost, by year | UMD / Global Forest Watch | Global | None | Yearly |
| `forest-alerts` | Forest disturbance alerts | Recent forest clearing in the tropics | Global Forest Watch (GLAD, RADD) | Tropics (30°S to 30°N) | None | Weekly |
| `snowpack` | Snowpack (SNOTEL) | Snow water equivalent at mountain weather stations | USDA NRCS SNOTEL | Western US | None | Latest reading (daily) |
| `forest-roads` | Forest Service roads open to motor vehicles | Forest Service roads open to motor vehicles | USDA Forest Service MVUM | US | None | Yearly |
| `campsites` | Campsites and parking lots | Campsites and parking lots | OpenStreetMap | Global | `OVERPASS_URL` (optional) | Live (cached up to a day) |
| `streamflow` | Stream flow (USGS gauges) | River flow and gauge height at stream gauges | USGS Water Data | US | `USGS_API_KEY` (optional) | Latest reading (15 minutes), provisional |
| `species` | Species sightings | Wildlife and plant sightings | iNaturalist | Global | None | Daily |
| `population` | Population density | Where people live | NASA GIBS (GPW v4) | Global | None | Fixed at 2020 |
| `night-lights` | Night lights | Satellite picture of the Earth at night | NASA GIBS (VIIRS) | Global | None | Daily (date in the note) |
| `wilderness` | Wilderness areas | Designated wilderness boundaries | Wilderness.net / USGS | US | None | Updated occasionally |
| `photos` | Photo density | Where geotagged photos were taken | Wikimedia Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional) | Live |
| `physical-regions` | Named physical regions | Named mountain ranges, deserts and plateaus | Natural Earth | Global | None | Static |
| `public-lands` | Public land ownership | Who owns and manages the land | USGS PAD-US 4.1 | US | None | Static (release 4.1) |
| `popularity` | Trail popularity estimate | Estimated popularity score (0 to 100) per trail | Computed from OSM, Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `popularity-campsites` | Campsite popularity estimate | Estimated popularity score (0 to 100) per campsite | Computed from OSM, Commons, Mapillary | Global | `MAPILLARY_TOKEN` (optional), `OVERPASS_URL` (optional) | Computed per query |
| `remoteness` | Remoteness score | Remoteness score (0 to 100) per hexagon | Computed from OSM and wilderness boundaries | Global | `OVERPASS_URL` (optional) | Computed per query |
<!-- layers:end -->

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
| `OVERPASS_URL` | Recommended | Your own Overpass server for trails, campsites, popularity, and remoteness. The public endpoint is the fallback, but it returns HTTP 406 for geometry queries from some networks | [wiki.openstreetmap.org](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| `FIRMS_MAP_KEY` | For `fire-detections` | Active fire hotspots (the layer reports itself unavailable without it) | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/) |
| `MAPILLARY_TOKEN` | No | Adds Mapillary street-level images to `photos` and popularity scores for views about 15 km across or smaller | [mapillary.com/developer](https://www.mapillary.com/developer) |
| `USGS_API_KEY` | No | A higher rate limit for `streamflow` (it works without one at a low limit) | [api.waterdata.usgs.gov/signup](https://api.waterdata.usgs.gov/signup/) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | No | Response caching and rate limiting | Vercel KV |
| `NEXT_PUBLIC_NATURAL_EARTH_STYLE` | No | Natural Earth basemap (Milestone 3) | Mapbox Studio |

## Bring your own key and model

WildMap never picks a model for you. Set `MODEL_NAME` and the key for your provider.

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

Anyone who can reach your deployment can chat with the agent, and every message spends your model credits. Turn on [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (a password, or Vercel Authentication) before you share the URL. The chat endpoint also rejects requests with more than 40 messages or a body over 256 KB, but that only limits the size of each request, not how many are sent.

## Tests

- `pnpm test` runs the unit tests. It needs no keys and no network.
- `pnpm exec tsx scripts/eval-model.mts "<question>"` runs one question through the real agent and prints one JSON line; add `--set` to run the 12-question eval set in [docs/questions.md](docs/questions.md). It needs your model key and spends credits.
- `pnpm e2e` runs the browser tests with Playwright. The page-load test always runs; the test that asks the agent a question is skipped unless `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` is set.

## Add a layer

See [docs/layers.md](docs/layers.md) for how to add your own data layer. The six starter questions and the tool calls expected for each are in [docs/questions.md](docs/questions.md).

## What is in Milestone 2 and what is next

**In Milestone 2:** 19 data layers (trails, fire perimeters and detections, forest loss and alerts, snowpack, forest roads, campsites, stream flow, species, population, night lights, wilderness, photos, physical regions, public lands), computed popularity and remoteness scores, vector tiles for public lands, and a vocabulary table that routes everyday words to the right layer.

**Next (Milestone 3):** the WallyMap design, 3D columns, a time scrubber, route preview, and compare.

## License

MIT

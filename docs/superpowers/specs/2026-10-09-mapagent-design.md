# MapAgent design

Date: 2026-10-09. Status: draft for review. Project name is a placeholder.

## What it is

An open-source web app that answers questions about the outdoors by drawing
on a map. A chat rail on one side, a full-bleed map canvas on the other. The
user asks "where has forest loss accelerated in the last five years near
Tahoe?" and the agent calls typed tools against free, live data sources, then
renders the answer as layers on the map with a short written summary and a
citation per layer.

The product model is Claude's design/visualize harness, applied to maps:
the canvas is the artifact, the chat edits it, every turn produces a new
version you can step back through, and the agent suggests the next question.

Goals, in priority order:

1. Productized from the first commit: deploy to Vercel in minutes, nothing
   heavy stored, two API keys to start.
2. Open-source friendly: adding a data layer is one file; contributors never
   touch the agent.
3. Global from day one. Coverage limits belong to individual layers, not the
   app.
4. Visualization that makes data legible: 3D columns, time scrubbing, and
   along-route charts, not just pins.

Non-goals for v1: user accounts, saved maps beyond a share link, trip
planning, routing optimization, offline use, mobile-native apps, any
scraping of sites that forbid it (AllTrails, Strava, iOverlander,
freecampsites, Campendium).

## Architecture

```
Browser                              Vercel
┌────────────────────────┐           ┌──────────────────────────────┐
│ Chat rail  │ Map canvas│  stream   │ /api/chat  (Vercel AI SDK)   │
│ (AI SDK UI)│ Mapbox GL │◄─────────►│   model: Claude | OpenAI-    │
│            │ + deck.gl │           │   compatible open model      │
│ Layer stack│ Scrubber  │           │   tools: generated from      │
│ Versions   │ Route chart│          │   layer registry             │
└────────────────────────┘           │ /api/layer/[id] (data fetch) │
                                     │ Vercel KV cache (24h TTL)    │
                                     └───────────┬──────────────────┘
                                                 │ live HTTPS
                     Global Forest Watch · Overpass (OSM) · USFS ArcGIS ·
                     recreation.gov RIDB · NASA FIRMS · NIFC · SNOTEL ·
                     USGS Water · Wikimedia Commons · Mapillary · PAD-US tiles
```

### Stack

- Next.js (App Router) on Vercel. TypeScript throughout, strict.
- Mapbox GL JS for the base map, globe projection at world scale, optional
  3D terrain when zoomed in. deck.gl's MapboxOverlay for data layers.
- Vercel AI SDK for the agent loop and streaming. Tools are zod schemas.
- Model: Claude by default. `MODEL_PROVIDER=openai-compatible` plus a base
  URL switches to any open model served by vLLM or Ollama (Qwen3.6, Gemma 4,
  gpt-oss). Same tool schemas either way.
- Vercel KV (Upstash) as a cache for layer results, keyed by layer id plus
  a rounded bounding box plus filters, 24-hour TTL. Share links store a map
  state JSON in KV with a 30-day TTL. Nothing else is persisted.
- Licensing: MIT for the code. Each layer declares the license of the data
  it returns and the UI shows it.

### Why these choices

- Vercel plus live APIs means zero storage cost and nothing to reconfigure
  between local and public. The trade is latency on first query, which the
  cache absorbs.
- deck.gl handles millions of points in the browser and has hexagon and
  column layers built in, which is the 3D requirement.
- Vercel AI SDK with zod gives typed tools that work identically with
  Claude and open models, and its UI hooks give streaming for free.
- BigQuery is deliberately out of v1. If a dataset is too big for live
  queries, it becomes a layer with a BigQuery adapter later; the registry
  does not care where data lives.

## The layer registry

Every data source is one file in `layers/`. This is the contract that makes
the project contributable and lets the agent's tools be generated instead
of hand-written.

```ts
export interface Layer {
  id: string;                 // "forest-loss"
  title: string;              // "Tree cover loss"
  description: string;        // one paragraph the agent reads
  coverage: "global" | "us" | { bbox: BBox };
  license: string;            // "CC-BY 4.0 (Global Forest Watch)"
  input: z.ZodObject<...>;    // filters: years, minHa, activity...
  query(ctx: QueryContext, input): Promise<LayerResult>;
  style: StyleHints;          // default geometry, color ramp, units
}

interface QueryContext {
  bbox: BBox;                 // [west, south, east, north]
  zoom: number;
  route?: LineString;         // present for along-route questions
  env: Record<string, string>;// API keys this layer declared it needs
  fetch: typeof fetch;        // cached, rate-limited
}

interface LayerResult {
  kind: "geojson" | "tiles";
  data: FeatureCollection | { url: string; minzoom: number; maxzoom: number };
  citation: { source: string; url: string; retrieved: string };
  coverageNote?: string;      // "No data outside the US"
}
```

Features carry two optional, conventional properties the renderer
understands: `t` (ISO date) and `v` (number). `t` feeds the time scrubber,
`v` feeds column height, color ramps, and route charts. A layer that returns
neither still renders as plain points, lines, or polygons.

At build time, `layers/index.ts` collects all layers and exports:

- One agent tool per layer, named `query_<id>`, whose schema is the layer's
  `input` plus the shared `bbox` and optional `route`.
- A `list_layers` tool that returns titles, descriptions, and coverage so
  the model can plan.
- A `/api/layer/[id]` route so the browser can refetch a layer on pan or
  zoom without going back through the model.

### Launch layers

| Layer | Source | Coverage | Key needed | Notes |
|---|---|---|---|---|
| Tree cover loss (yearly) | Global Forest Watch Data API, Hansen GFC | Global | GFW (free) | Polygon stats by year plus tile URL for the loss raster |
| Forest disturbance alerts | GFW integrated alerts (GLAD, RADD, DIST) | Tropics plus Europe, expanding | GFW | Weekly; `t` populated |
| Popularity estimate | Computed; see below | Global, richer in US | RIDB (free) | Always labeled as an estimate |
| Trails and paths | OSM via Overpass | Global | none (keyed endpoint optional) | Carries sac_scale, trail_visibility, informal, surface |
| Campsites and parking | OSM via Overpass | Global | none | tourism=camp_site with backcountry, tents, caravans; amenity=parking with capacity |
| Dispersed camping roads | USFS MVUM via ArcGIS MapServer | US | none | Road segments where roadside camping is allowed |
| Public land ownership | PAD-US 4.1 vector tiles (Wally bucket) | US | none | Tiles only; served from existing GCS bucket |
| Active fire detections | NASA FIRMS | Global | FIRMS (free) | `t` and `v` (fire radiative power) |
| Fire perimeters | NIFC WFIGS FeatureServer | US | none | Current plus historical perimeters with dates |
| Burn severity | MTBS map service | US | none | Tiles |
| Snowpack | NRCS SNOTEL AWDB REST | US West | none | Station points with `v` = snow water equivalent |
| Stream flow | USGS Water Data API v1 | US | none | Use the new API; legacy one dies Q1 2027 |
| Photo density | Wikimedia Commons geosearch, Mapillary | Global | Mapillary (free) | Points with `t`; input to popularity |
| Species sightings | iNaturalist, GBIF | Global | none | Points with `t`; fun for 3D columns |
| Cell coverage | FCC BDC H3 hexes | US | none | Hosted as PMTiles if the bulk file is too slow live; decision deferred |
| Physical regions | Natural Earth (public domain) via GitHub/CDN GeoJSON | Global | none | Mountain ranges, deserts, rivers, lakes, glaciers, parks; also the geocode fallback for named regions |
| Population density | NASA SEDAC GPW v4 map service | Global | none | ~1 km raster tiles; baseline signal for popularity |

Two keys unlock the headline features: Mapbox (map) and one model
provider. GFW and FIRMS keys are free and add the forest and fire layers.
Layers whose key is missing are listed to the agent as unavailable, not
hidden.

### Popularity estimate

No free source measures foot traffic. The layer computes a 0 to 100 score
per trail, trailhead, or campground in the bounding box from signals that
are free and allowed:

- recreation.gov: share of nights booked over the next 60 days and over the
  same window last year (campgrounds only).
- OSM: parking capacity near trailheads, presence of informal (social)
  trails, trail visibility, Wikipedia or Wikidata link present.
- Photo density: Wikimedia Commons and Mapillary counts within 500 m, with
  dates so the scrubber can show seasonality.
- National Park Service monthly visitation where a feature falls inside a
  park unit (bundled CSV, 2 MB, the one static file the repo ships).
- Population within a two-hour drive, from the GPW density raster, as the
  baseline: the same trail draws more people near a city than in the
  desert.

Weights live in one config file and the UI shows the contributing signals
when a feature is clicked. The agent's system prompt forbids the words
"live" or "real-time" for this layer.

## The agent

A single Vercel AI SDK `streamText` loop with tool calling, max 8 steps.

System prompt covers: you draw on a map, prefer tools over prose, every
claim cites a layer, state coverage gaps plainly, choose a visualization
mode and say why, and end with two or three follow-up questions.

Tools:

- `list_layers()`
- `query_<layer>(bbox, route?, ...input)` generated per layer
- `geocode(place)` via Mapbox Geocoding v6, returns bbox and center. Falls
  back to Natural Earth physical-region polygons for named ranges, deserts,
  rivers, and lakes ("the Andes") where Mapbox returns only a point.
- `route(from, to, profile)` via Mapbox Directions, returns a LineString
- `set_view({ bbox | center+zoom, pitch?, bearing?, globe? })`
- `render({ layerId, mode, encode, timeField?, valueField? })` where
  `mode` is one of `points | lines | polygons | heat | columns | hexbin`
  and `encode` maps `v` to height and/or color
- `chart({ kind: "timeseries" | "route-profile", layerIds })`
- `note(markdown)` for the written summary, streamed into the chat

The model never emits coordinates it invented; every geometry comes from a
tool result. The server validates every tool output against the layer's
zod schema before it reaches the browser.

Open models: structured output is enforced at decode time (vLLM
`structured_outputs` or llama.cpp grammar) when `MODEL_PROVIDER` is
`openai-compatible`, so a 27B model does not break on tool JSON.

## Visualization

The renderer is a pure function of map state: `(layers, renderOps,
viewport, time) -> deck.gl layers`. The agent sets state; the browser draws.

Modes:

- Points, lines, polygons: plain geometry with the layer's default style.
- Heat: deck.gl HeatmapLayer colored by `v` or density.
- Columns and hexbin: deck.gl HexagonLayer or H3HexagonLayer, column height
  from `v` sum or count, color from a second channel (recency by default).
  Cell size scales with zoom so the globe shows continental spikes and a
  valley shows trail-level cells.
- Time: when any visible layer has `t`, a scrubber appears below the map
  with play, step, and a histogram of counts per step. Dragging filters
  all time-aware layers together. A small line chart of totals per step
  accompanies it.
- Route profile: when a route is present, a strip chart below the map plots
  each selected layer's `v` by distance along the route (elevation from
  Mapbox terrain, forest loss, popularity, fire history, cell coverage).
  Hovering the chart moves a cursor on the map and vice versa.
- Terrain: a toggle, on by default under zoom 11 when pitch is nonzero.
- Globe context: Natural Earth countries, rivers, lakes, and urban areas
  drawn lightly at world zoom so columns have geography to sit on.

Considered and rejected for v1: video crowd counting (no feeds), pedestrian
simulators such as JuPedSim and Vadere (need capacity and arrival data we
lack; a possible later experiment on top of the popularity layer), and
TILE2NET (urban sidewalks, not trails).

## UI and UX

Modeled on Claude's design/visualize harness.

- Layout: chat rail on the left, roughly a third of the width, collapsible
  to a strip. Map canvas fills the rest. On phones the map is full screen
  and the chat is a bottom sheet.
- Canvas is the artifact. Each agent turn that changes the map creates a
  version. A version strip at the top of the canvas lets the user step
  back and forward; the chat shows which version each message produced.
- Layer stack: a panel over the map's right edge lists active layers as
  cards with title, color swatch, feature count, coverage note, license,
  and a source link. Cards toggle visibility, reorder, and open a style
  popover (mode, color ramp, height scale). Changes made here are also
  recorded as versions.
- Inspect: clicking any feature opens a detail card with its properties,
  the layer citation, and for popularity the contributing signals. A
  "ask about this" button sends the feature into the chat.
- Follow-ups: the agent ends each answer with two or three tappable chips.
- Streaming: the map updates as tool results arrive, not at the end. The
  chat shows a compact tool trace (layer, bbox, feature count, elapsed) that
  expands on click.
- Empty state: a globe, an input box, and six example questions spanning
  continents.
- Share: a button writes the current map state to KV and returns a link;
  the link opens read-only with the chat transcript attached.
- Keys: a settings sheet lists each optional key, what it unlocks, and a
  link to get it. Keys are stored in env vars on the server; the browser
  never sees them.

## Error handling

- A failed upstream API yields a layer card in an error state with the
  message and a retry, and the agent is told the layer failed so it can
  answer with what it has.
- Rate limits: a per-layer token bucket in the server fetch wrapper; Overpass
  gets the strictest one and falls back from the keyed endpoint to the
  public one.
- Bounding boxes above a per-layer area limit are rejected with a message
  telling the agent to zoom in or aggregate, which steers it to hexbin at
  world scale.
- Model output that fails schema validation is retried once with the
  validation error, then surfaced in the chat.

## Testing

- Each layer has a fixture test: a recorded upstream response (committed,
  small) and an assertion on the normalized LayerResult. Contributors can
  run the whole suite with no keys.
- Registry test: every layer has a unique id, a valid zod input, a coverage
  value, a license, and generates a tool without error.
- Renderer test: map state fixtures render to the expected deck.gl layer
  set (unit test, no browser).
- Agent eval: a dozen questions with expected tool call sequences, run
  against Claude in CI nightly, against an open model manually.
- Playwright smoke: load the app, ask one question, assert a layer card
  appears.

## Repository layout

```
app/              Next.js routes, including /api/chat and /api/layer/[id]
components/       chat rail, map canvas, layer stack, scrubber, charts
lib/agent/        system prompt, tool generation, provider switch
lib/render/       map state, deck.gl layer factory
layers/           one file per data source, plus index.ts
layers/__fixtures__/
data/             nps-visitation.csv (the only shipped data)
docs/             this spec, layer authoring guide, example questions
```

## Open questions, resolved

- Region: none. Global from the start; coverage is per layer.
- Storage: none beyond KV cache and share links. BigQuery, DuckDB, and
  Postgres are future layer adapters, not v1.
- Hosting: Vercel. Local dev is `vercel dev` or `next dev` with the same
  env vars; no separate configuration.
- Model: Claude default, open models as a switch, no GIS-specific models.

## Milestones

1. Skeleton: Next.js, Mapbox, chat rail, one layer (OSM trails), `set_view`
   and `render` tools, deploy button. Open-sourced at this point.
2. Headline layers: forest loss, alerts, popularity, dispersed camping,
   fire. Layer stack UI and inspect card.
3. Visualization: columns and hexbin, time scrubber, route profile, globe.
4. Versions, share links, follow-up chips, open-model switch, evals.

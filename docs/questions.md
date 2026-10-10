# Example questions

These are the six WallyMap starter questions in `components/EmptyState.tsx`. Together they show a first set of the data layers: trails, fire, forest loss, snow, campsites, and wildlife. The eval set at the bottom covers every layer family. Each question should end with the matching layer drawn on the map and a short note.

The usual tool order is: find the place, move the map, query the layer, draw it, explain it.

## 1. Show hiking trails around Lake Tahoe

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map flies to Lake Tahoe and tilts over 3D terrain, with the trail network drawn as white lines over a thin dark casing. The Filters disclosure on the trails layer offers difficulty (`sac_scale`) and surface chips.

## 2. Which wildfires burned near Yosemite in the last 10 years?

Tools: `geocode` → `set_view` → `query_fire-perimeters` → `render` → `note`

The map shows fire perimeters around Yosemite, and the note lists the largest recent fires by year. Fire perimeters carry dates, so the time scrubber appears in the layer console; the acres filter narrows the list to the large fires.

## 3. Where has the Amazon lost the most forest since 2015?

Tools: `geocode` → `set_view` → `query_forest-loss` → `render` → `note`

The map shows tree cover loss across the Amazon from 2015 onward; the note names the areas with the heaviest loss.

## 4. How much snow is on the ground around Mount Hood?

Tools: `geocode` → `set_view` → `query_snowpack` → `render` → `note`

The map shows snow depth around Mount Hood, and the note gives the current depth and how recent the reading is.

## 5. Find campsites and forest roads open to vehicles near Moab

Tools: `geocode` → `set_view` → `query_campsites` + `query_forest-roads` → `render` (each layer) → `note`

The map shows campsites together with forest roads open to motor vehicles near Moab, and the note says which is which and that dispersed-camping rules come from the ranger district.

## 6. What wildlife has been spotted around Banff this year?

Tools: `geocode` → `set_view` → `query_species` → `render` → `note`

The map shows recent wildlife sightings around Banff, and the note summarizes the most commonly seen species.

## More layers: activities, live conditions, hazards, earth and water

The layers added in M4 answer questions like these. Each line gives the question, then the usual tools.

**Activities**
- "Mountain bike trails near Moab": `geocode` → `set_view` → `query_mtb-trails` → `render` → `note`. Trails carry a 0 to 6 difficulty in `v`.
- "Ski touring routes around Chamonix": `query_ski-routes` (filter `kind: skitour`).
- "Climbing crags near Red River Gorge": `query_climbing`; `v` is the route count where OpenBeta knows it.
- "Where can I put in to raft the South Fork American?": `query_paddling` with `query_streamflow` for today's flow.
- "Huts and springs along the Haute Route": `query_outdoor-features` (filter `kind`).
- "Trailheads and picnic areas in the Coconino National Forest": `query_recreation-sites`.
- "Where can I fish and launch a boat on Lake Powell?": `query_fishing`.

**Live conditions ("now", "today", "currently")**
- "Surf at Half Moon Bay today": `query_surf` (buoys; `forecast: true` for the days ahead, `season` for typical months).
- "When is low tide at Point Reyes?": `query_tides`.
- "Is the Carson River running high?": `query_streamflow`; the note gives flow against the usual for the day.
- "Is there fresh powder at Mount Baker?": `query_snowpack` (depth, new snow and snow type).
- "Any weather warnings around Lake Tahoe?": `query_weather-alerts` (NWS warnings plus the weather now).

**Hazards**
- "Recent earthquakes near Mammoth Lakes": `query_earthquakes`; the scrubber plays them over time.
- "Where is the wildfire smoke today?": `query_smoke`.
- "What is the fire danger in Southern California this week?": `query_fire-weather` with a `date` up to 9 days ahead.
- "Which large fires burned in Oregon in 2020?": `query_burn-severity` with `year: 2020`.
- "Is this house in a flood zone?" (zoomed in): `query_flood-zones`; `query_fire-hazard` for long-run fire risk; `query_drought` for this week's drought.

**Earth, water and ice**
- "What rock is Half Dome made of?": `geocode` → `query_geologic-unit` with the lon and lat of the center → `note`. `query_geology` draws the map.
- "How deep is Lake Tahoe?": `query_lakes` with `name: "Lake Tahoe"`; `v` is the maximum depth in metres.
- "Glaciers in the Wind River Range": `query_glaciers` (areas in km²).
- "Tallest peaks in the Sierra Nevada": `query_peaks` (elevation and prominence).
- "Did Lake Mead shrink?": `query_surface-water` with `product: change`.
- "Was the Sacramento Valley flooded last week?": `query_flood-extent` with a `date`.
- "How much sea ice is in the Arctic this September compared to 2012?": `query_sea-ice` → `compare`.

**Over time (satellite tiles)**
- "How green was the Sierra Nevada this month compared to last year?": `query_greenness` → `render` → `compare` with two windows a year apart.
- "Show snow cover in the Alps over the last month": `query_snow-cover` → `render` → `set_time` with `play`; the scrubber steps one image per day.
- "Did spring come early in Virginia this year?": `query_phenology`.
- "Where has vegetation just been disturbed in British Columbia?": `query_disturbance`.
- "What covers the ground around Fresno?": `query_land-cover`.

**Wildlife and places**
- "Where are the most iNaturalist or GBIF records of mountain lions in Colorado?": `query_gbif-occurrences` with `Puma concolor` (or `query_species`) → `render` with mode `heat`.
- "Critical habitat for the desert tortoise near St. George": `query_critical-habitat`.
- "Wild horse areas in Nevada": `query_grazing-allotments`.
- "Protected areas in Patagonia": `query_protected-areas-world`.
- "Tell me about the history of Bodie": `query_wikipedia-nearby`.

## Time, routes, compare

Beyond the six starters, these tools shape follow-up questions. They appear in the trace next to the `query_<layer>` and `render` calls.

- `set_time({ start, end, play?, mode? })` sets the time window the scrubber shows, for example "show wildfires near Yosemite year by year since 2016" (`geocode` → `set_view` → `query_fire-perimeters` → `render` → `set_time` with `play` → `note`). Layers without dates are not affected.
- `render({ layerId, mode, filters? })` takes `filters` when the user names an attribute value, such as "only alpine-grade trails" (`{ sac_scale: { include: ["alpine_hiking"] } }`) or "fires over 1,000 acres" (`{ acres: { range: [1000, 1000000] } }`). The agent should pass the filter rather than query again.
- `route({ from, to, profile })` draws a walking, cycling, or driving route from Mapbox Directions with place names as the user said them (`route` → `note`, no geocode needed). The Preview route button then flies along it with an elevation profile.
- `compare({ layerId, a, b, mode })` compares one layer across two windows as `delta`, `swipe`, or `toggle`, for questions like "compare forest loss in Rondônia between 2015 and 2025" (`geocode` → `set_view` → `query_forest-loss` for both windows → `compare` → `note`). It is new and its on-map controls are still being polished.

## Notes

- The tool sequences above are typical, not required. The runner only checks that a place was geocoded, a layer was queried and drawn (or a layer error was handled), and a note was written.
- If a query returns the hint `zoom_in`, expect an extra query call on a smaller area.
- `list_layers` may appear first in the trace; it does not change the result.
- Public data servers can be slow, so a query can take 10 to 30 seconds.

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, a physical-region outline, two "here" questions that carry a map view (`@view=[w,s,e,n]`, the bbox the browser would send) and pass without a geocode, and twelve M4 questions, one per theme: mountain biking, ski touring, climbing, lake depth, surf today, river level, weather warnings, earthquakes, rock type at a point, glaciers, greenness compared over a year, and species records drawn as a heatmap.

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set
```

<!-- eval:start -->
- Show hiking trails around Lake Tahoe
- Which wildfires burned near Yosemite in the last 10 years?
- Are there any active fires burning near Missoula right now?
- Where has the Amazon lost the most forest since 2015?
- How much snow is on the ground around Mount Hood?
- Which rivers near Jackson Hole are running high right now?
- Find campsites and forest roads open to vehicles near Moab
- What wildlife has been spotted around Banff this year?
- Which trails and viewpoints around Zion National Park look the most popular?
- Who owns the land around Bryce Canyon, and is any of it designated wilderness?
- Where is the night sky darkest around Great Basin National Park, and how many people live nearby?
- How remote is the Wind River Range?
- Show me a walking route from Tahoe City to Emerald Bay
- Show wildfires near Yosemite year by year since 2016
- Show only alpine-grade trails near Chamonix
- Compare forest loss in Rondônia between 2015 and 2025
- Which sources did you use for snow near Mount Hood?
- Which campsites around Moab look the most popular?
- Outline the Sierra Nevada
- What fires are here? @view=[-120.2,38.9,-119.8,39.3]
- Any surf here? @view=[-117.35,32.6,-117.1,32.85]
- Mountain bike trails near Moab
- Ski touring routes around Chamonix
- Climbing crags near Red River Gorge
- How deep is Lake Tahoe?
- Surf at Half Moon Bay today
- Is the Carson River running high?
- Any weather warnings around Lake Tahoe?
- Recent earthquakes near Mammoth Lakes
- What rock is Half Dome made of?
- Glaciers in the Wind River Range
- How green was the Sierra Nevada this month compared to last year?
- Where are the most iNaturalist or GBIF records of mountain lions in Colorado?
<!-- eval:end -->

## Last run

Run on 2026-10-09 (M4 integration, commit fb8ef88, with the renderer-modes work still uncommitted in the tree) with model `openai/gpt-oss-120b` and a 12-step cap: **ok 32/33**. A question passes when the agent located the place (geocode or a physical-regions query), queried a layer, drew whatever came back (render or compare), and wrote a note; a route question passes when the route tool ran and a note followed.

| Question | ok | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | list_layers, geocode, osm-trails, render, popularity, render | 19.4 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | geocode, fire-perimeters, render, note | 8.3 |
| Are there any active fires burning near Missoula right now? | yes | geocode, fire-detections, fire-detections, render | 7 |
| Where has the Amazon lost the most forest since 2015? | yes | geocode, geocode, forest-loss, render, physical-regions, render, set_view, note | 14.1 |
| How much snow is on the ground around Mount Hood? | yes | list_layers, geocode, snowpack, snowpack, render, note | 12.2 |
| Which rivers near Jackson Hole are running high right now? | yes | geocode, geocode, streamflow, render | 19.7 |
| Find campsites and forest roads open to vehicles near Moab | yes | geocode, campsites, forest-roads, render, render, note | 25.9 |
| What wildlife has been spotted around Banff this year? | yes | geocode, geocode, species, render, note | 30.4 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes | geocode, set_view, osm-trails, outdoor-features, outdoor-features, popularity, render, render | 31.3 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | geocode, set_view, public-lands, wilderness, render, render | 17.3 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | geocode, night-lights, population, render, render | 13.6 |
| How remote is the Wind River Range? | yes | geocode, geocode, geocode, remoteness, remoteness, render, note | 33.3 |
| Show me a walking route from Tahoe City to Emerald Bay | yes | route | 5.4 |
| Show wildfires near Yosemite year by year since 2016 | yes | geocode, set_view, fire-perimeters, render, set_time, note | 17.6 |
| Show only alpine-grade trails near Chamonix | yes | geocode, osm-trails, render, note | 11.8 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes | geocode, geocode, set_view, forest-loss, render, compare, note | 14.1 |
| Which sources did you use for snow near Mount Hood? | yes | geocode, snowpack, snow-cover, render, note | 10.6 |
| Which campsites around Moab look the most popular? | yes | list_layers, geocode, popularity-campsites, popularity-campsites, popularity-campsites, popularity-campsites, render, note | 28.4 |
| Outline the Sierra Nevada | yes | geocode, set_view, physical-regions, physical-regions, render | 9.4 |
| What fires are here? | yes | fire-perimeters, render, fire-detections | 15.9 |
| Any surf here? | yes | surf, surf, render | 17.8 |
| Mountain bike trails near Moab | yes | geocode, mtb-trails, mtb-trails, mtb-trails, render | 19.7 |
| Ski touring routes around Chamonix | yes | geocode, set_view, ski-routes, render | 11.8 |
| Climbing crags near Red River Gorge | yes | geocode, geocode, climbing, climbing, render | 15.4 |
| How deep is Lake Tahoe? | yes | geocode, lakes, render | 7.9 |
| Surf at Half Moon Bay today | yes | geocode, surf, surf, render | 12.6 |
| Is the Carson River running high? | yes | geocode, geocode, geocode, streamflow, render, note | 17.6 |
| Any weather warnings around Lake Tahoe? | yes | geocode, weather-alerts, render, note | 9.5 |
| Recent earthquakes near Mammoth Lakes | yes | geocode, earthquakes, earthquakes, render, note | 21.1 |
| What rock is Half Dome made of? | no | geocode, geocode, geocode, geologic-unit, geologic-unit, note | 13.4 |
| Glaciers in the Wind River Range | yes | list_layers, geocode, geocode, geocode, geocode, glaciers, render, note | 16.3 |
| How green was the Sierra Nevada this month compared to last year? | yes | geocode, greenness, greenness, compare, note | 15.5 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | yes | geocode, species, species, species, gbif-occurrences, render | 20.8 |

Questions that needed a zoom-in retry after an area-limit error: How remote is the Wind River Range?, Which campsites around Moab look the most popular?, Mountain bike trails near Moab, Where are the most iNaturalist or GBIF records of mountain lions in Colorado?.

The one failure, "What rock is Half Dome made of?", answers correctly (Half Dome Granodiorite, from `geologic-unit`) but never calls `render` on the one-point result, so the pass rule counts it as not drawn. A targeted re-run failed the same way. The fix is a prompt change (render the `geologic-unit` point before the note) or a pass rule that lets a single-point lookup end in a note.

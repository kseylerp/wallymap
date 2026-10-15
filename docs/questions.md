# Example questions

These are the six WallyMap starter questions in `components/EmptyState.tsx`. Together they show a first set of the data layers: trails, fire, forest loss, snow, campsites, and wildlife. The eval set at the bottom covers every layer family. Each question should end with the matching layer drawn on the map and a short note.

The usual tool order is: find the place, move the map, query the layer, draw it, explain it.

## 1. Show hiking trails around Lake Tahoe

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map flies to Lake Tahoe and tilts over 3D terrain, with the trail network drawn as white lines over a thin dark casing. The Filters disclosure on the trails layer offers difficulty (`sac_scale`) and surface chips.

Over a region wider than 2,500 km² (up to 400,000 km², a small country) the trails layer returns named hiking routes instead of individual paths, longest first with their length in km, and the coverage note says so. "Good hiking in French Guiana" should end with those routes (Piste de Bélizon, about 205 km, first), the named parks from `query_protected-areas-world`, and a note that names three to six of them with a reason each.

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
- "Protected areas in Patagonia": `query_protected-areas-world` (named parks with designation and area under 500,000 km², map tiles over that).
- "Tell me about the history of Bodie": `query_wikipedia-nearby`.

## Batch F layers: water, land, climate, forests, wildlife and energy

The layers added in Batch F answer questions like these.

**Water and dams**
- "How full is Lake Powell right now?": `geocode` → `set_view` → `query_reservoir-levels` with `name: "powell"` → `render` → `note`. The note gives percent full, the elevation in feet and the trend from the series. "How deep is Lake Tahoe?" still goes to `lakes`.
- "Show dams on the Colorado River by the decade they were built": `query_dams` → `render` → `set_time` with `play` and a ten-year window; `t` is the year built.
- "What watershed is Denver in?": `query_river-basins`; the basin level follows the zoom.
- "Where is the Ogallala aquifer, and is the water table dropping?": `query_aquifers` for the outline, `query_groundwater` for depth to water at wells (one reading per well, no trend).

**Land, mines and monuments**
- "How has Bears Ears National Monument changed since 2021?": `query_monuments` with `version: both` → `render` → `render` with `filters` on `kind` (`2021` or `current`); the note gives both areas.
- "Where are abandoned uranium mines near the Navajo Nation?": `query_uranium`; other mines are in `query_mines`.
- "Where are the active mining claims near Moab?": `query_mining-claims`.
- "Show Lahaina before and after the 2023 fire": `query_imagery-by-date` once per date with the same `sensor` → `compare` with the two pass days.

**Climate**
- "How fast is sea level rising at San Francisco?": `query_sea-level-trends`; `v` is millimetres per year.
- "Show Miami with 3 feet of sea level rise": `query_sea-level-rise` with `feet: 3`. Each scenario is its own query; `compare` and `set_time` do not switch between feet.
- "How much warmer than normal was Fresno County last month?": `query_temperature-anomaly` (US counties, lower 48); `v` is °F against 1901-2000.
- "Which counties here had the most disaster declarations?": `query_disasters` (FEMA counties in the US, GDACS alerts worldwide).
- "Where are methane plumes in the Permian Basin?": `query_methane-plumes`; `v` is kilograms per hour.
- "Is this forest a carbon sink?": `query_carbon-flux`. "Where is the permafrost in Alaska?": `query_permafrost`.

**Forests, wildlife and energy**
- "Which sequoia groves burned in the 2020 and 2021 fires?": `query_sequoia-groves` + `query_sequoia-mortality`.
- "Show the Lyell Glacier's retreat": `query_glaciers` → `render` → `set_time` with `play` across the survey years; the note compares `v` (km²) at each date.
- "Where is the old-growth forest in Oregon?": `query_old-growth`. "Where did beetles kill trees in Colorado?": `query_tree-mortality`.
- "Where do California condors live?": `query_condor-range`. "Wolf packs in Washington in 2020": `query_wolf-packs` with `year`.
- "Wind farms and power lines in West Texas": `query_power-plants` + `query_pipelines-lines`. "Busiest ports on the Gulf Coast": `query_ports`. "Show plant hardiness zones in Oregon": `query_hardiness-zones` (map tiles; the zone at one spot is not readable).

## Time, routes, compare

Beyond the six starters, these tools shape follow-up questions. They appear in the trace next to the `query_<layer>` and `render` calls.

- `set_time({ start, end, play?, mode? })` sets the time window the scrubber shows, for example "show wildfires near Yosemite year by year since 2016" (`geocode` → `set_view` → `query_fire-perimeters` → `render` → `set_time` with `play` → `note`). Layers without dates are not affected.
- `render({ layerId, mode, filters? })` takes `filters` when the user names an attribute value, such as "only alpine-grade trails" (`{ sac_scale: { include: ["alpine_hiking"] } }`) or "fires over 1,000 acres" (`{ acres: { range: [1000, 1000000] } }`). The agent should pass the filter rather than query again.
- `route({ from, to, profile })` draws a walking, cycling, or driving route from Mapbox Directions with place names as the user said them (`route` → `note`, no geocode needed). The Preview route button then flies along it with an elevation profile.
- `compare({ layerId, a, b, mode })` compares one layer across two windows as `delta`, `swipe`, or `toggle`, for questions like "compare forest loss in Rondônia between 2015 and 2025" (`geocode` → `set_view` → `query_forest-loss` for both windows → `compare` → `note`). It is new and its on-map controls are still being polished.

## Notes

- The tool sequences above are typical, not required. The runner only checks that a place was geocoded, a layer was queried and drawn (or a layer error was handled), and a note was written.
- A box wider than a layer's usual area no longer errors: up to the layer's hard cap it answers with its largest (or named) features, ranked by one field, and a coverage note such as "Showing the 2,000 largest of 4,512 (ranked by capacity in MW); zoom in under 250,000 km² for all". The note should say so in one clause, and the agent should not shrink the box. The layer table in docs/layers.md lists both caps.
- If a query returns the hint `zoom_in` (now only past a layer's hard cap) for a named place, expect one extra query call on a smaller area. For the current view with no place named, expect queries of the layers in the error's `widerScale` list (for trails, which only error over 400,000 km²: peaks, huts, viewpoints and waterfalls, recreation sites, protected areas; never population or night lights), drawn at that scale, and one sentence saying trails appear when zoomed in.
- The note is the answer: at most about 120 words, with no Sources, Next steps or Coverage notes sections. The text after it is only the follow-up questions; the chat strips anything else that repeats the note.
- `list_layers` may appear first in the trace; it does not change the result.
- Public data servers can be slow, so a query can take 10 to 30 seconds.

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, a physical-region outline, two "here" questions that carry a map view (`@view=[w,s,e,n]`, the bbox the browser would send) and pass without a geocode, one question on a view far wider than the trails layer allows (the whole Baltic, no place named), which passes only when the agent answers at that scale (at least one query succeeds and is drawn) without calling set_view or retrying a layer more than once, and twelve M4 questions, one per theme: mountain biking, ski touring, climbing, lake depth, surf today, river level, weather warnings, earthquakes, rock type at a point, glaciers, greenness compared over a year, and species records drawn as a heatmap, and ten Batch F questions: reservoir level, dams by decade, a monument then and now, uranium mines, a sea level trend, a sea level rise scenario, methane plumes, a county temperature anomaly, sequoia fire deaths, and a glacier's retreat, and the owner's two Tierra del Fuego questions on a wide view with no place named (great hikes, which must draw wider-scale layers instead of refusing; deforestation or water rise), and the owner's "good hiking in French Guiana", which passes only when a query that holds hiking candidates succeeds (trails with named routes, peaks, outdoor features or protected areas), population and night lights are not queried, and the note, within 150 words, names at least three places from the returned features, and the owner's "wind farms in West Texas" on a 392,000 km² view, which passes only when power-plants answers with at least 100 features, no power-plants query uses a box under 90% of the view (no shrinking) or errors, and the note names the largest site by MW, and "dams in the Colorado River basin", which passes when a dams query over the basin answers with features and no zoom_in error. Every question also fails when a note runs over 150 words or a heading appears twice across the notes and the closing text.

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
- best hiking trails for elevation @view=[20,54,30,60]
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
- How full is Lake Powell right now?
- Show dams on the Colorado River by the decade they were built
- How has Bears Ears National Monument changed since 2021?
- Where are abandoned uranium mines near the Navajo Nation?
- How fast is sea level rising at San Francisco?
- Show Miami with 3 feet of sea level rise
- Where are methane plumes in the Permian Basin?
- How much warmer than normal was Fresno County last month?
- Which sequoia groves burned in the 2020 and 2021 fires?
- Show the Lyell Glacier's retreat
- great hikes around here @view=[-75,-55.5,-66,-51]
- deforestation or water rise in this area @view=[-75,-55.5,-66,-51]
- good hiking in French Guiana
- wind farms in West Texas @view=[-104,29,-96,35]
- dams in the Colorado River basin
- How has Bears Ears changed since 2021?
- Show only hard mountain bike trails near Moab
- Which uranium mines near the Navajo Nation score highest?
- Where are most of the wind farms by capacity in West Texas?
- Show only sport crags at Red River Gorge
<!-- eval:end -->

## Last run

Full set run on 2026-10-14 at commit 0039aa2 (native data lines, T1 trails, region geocoding, soft caps; 49 questions) with model `openai/gpt-oss-120b` and a 12-step cap: **ok 46/49**. A question passes when the agent located the place (geocode, a physical-regions query, or an `@view` map view), the camera reached it (a successful geocode or `set_view`; `@view` questions are exempt), it queried a layer, drew whatever came back (render or compare), and wrote a note of at most 150 words. Some questions add their own rule (French Guiana, Wind River glaciers, West Texas wind farms, Colorado basin dams, and the three standard-view questions below).

| Question | ok | Tools (query_ prefix dropped) | Layer errors | Seconds |
| --- | --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | geocode, osm-trails, render |  | 46.5 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | geocode, fire-perimeters, render |  | 27.5 |
| Are there any active fires burning near Missoula right now? | yes | geocode, fire-detections, fire-perimeters, render, render |  | 26.2 |
| Where has the Amazon lost the most forest since 2015? | yes | geocode, geocode, forest-loss, render |  | 43.9 |
| How much snow is on the ground around Mount Hood? | yes | geocode, snowpack, snow-cover, render, note |  | 65.1 |
| Which rivers near Jackson Hole are running high right now? | yes | geocode, geocode, streamflow, render |  | 58.7 |
| Find campsites and forest roads open to vehicles near Moab | yes | geocode, campsites, forest-roads, render, render |  | 58.4 |
| What wildlife has been spotted around Banff this year? | yes | geocode, species, render |  | 67.1 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes | geocode, osm-trails, popularity, outdoor-features, outdoor-features, wikipedia-nearby, photos, render, render, render |  | 113.4 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | geocode, public-lands, wilderness, render, render |  | 14.4 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | geocode, night-lights, population, render, render |  | 12.1 |
| How remote is the Wind River Range? | yes | geocode, remoteness, render |  | 28.2 |
| Show me a walking route from Tahoe City to Emerald Bay | yes | geocode, geocode, geocode, route, render, note |  | 42.4 |
| Show wildfires near Yosemite year by year since 2016 | yes | geocode, fire-perimeters, render, set_time |  | 34.3 |
| Show only alpine-grade trails near Chamonix | yes | geocode, osm-trails, render |  | 16.6 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes | geocode, forest-loss, render |  | 29.9 |
| Which sources did you use for snow near Mount Hood? | no | geocode, snowpack, snow-cover |  | 22.5 |
| Which campsites around Moab look the most popular? | yes | geocode, popularity-campsites, popularity-campsites, campsites, render | Area is 13446 km²; zoom in to under 2500 km²; Area is 3373 km²; zoom in to under | 51 |
| Outline the Sierra Nevada | yes | geocode, physical-regions, render |  | 37.7 |
| What fires are here? @view | yes | fire-perimeters, fire-detections, render |  | 21.2 |
| Any surf here? @view | yes | surf, render |  | 29.4 |
| best hiking trails for elevation @view | yes | osm-trails, outdoor-features, protected-areas-world, render, render | Area is 402226 km²; zoom in to under 400000 km² | 59.1 |
| Mountain bike trails near Moab | yes | geocode, mtb-trails, mtb-trails, render | Area is 13446 km²; zoom in to under 10000 km² | 41.5 |
| Ski touring routes around Chamonix | yes | geocode, ski-routes, render |  | 29.5 |
| Climbing crags near Red River Gorge | yes | geocode, geocode, climbing, climbing, render |  | 47.5 |
| How deep is Lake Tahoe? | yes | geocode, lakes, render |  | 43.1 |
| Surf at Half Moon Bay today | yes | geocode, surf, surf, render |  | 50.7 |
| Is the Carson River running high? | yes | geocode, geocode, streamflow, render |  | 43.5 |
| Any weather warnings around Lake Tahoe? | yes | geocode, weather-alerts, render |  | 39.8 |
| Recent earthquakes near Mammoth Lakes | yes | geocode, earthquakes, earthquakes, render |  | 62.1 |
| What rock is Half Dome made of? | yes | geocode, geocode, geocode, geocode, peaks, outdoor_features, outdoor-features, outdoor-features, wikipedia-nearby, wikipedia-nearby, render | Area is 8547 km²; zoom in to under 4000 km² | 108.3 |
| Glaciers in the Wind River Range | yes | geocode, glaciers, render |  | 34.3 |
| How green was the Sierra Nevada this month compared to last year? | yes | geocode, greenness, compare, render |  | 34.3 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | yes | geocode, species, gbif-occurrences, render | Area is 269282 km²; zoom in to under 200000 km² | 63.5 |
| How full is Lake Powell right now? | yes | geocode, geocode, reservoir-levels, reservoir-levels, render |  | 35.6 |
| Show dams on the Colorado River by the decade they were built | yes | geocode, geocode, geocode, geocode, dams, render |  | 33.3 |
| How has Bears Ears National Monument changed since 2021? | yes | monuments, geocode, monuments, render | Area is 797600676 km²; zoom in to under 80000000 km² | 22.3 |
| Where are abandoned uranium mines near the Navajo Nation? | yes | geocode, uranium, uranium, render |  | 14.2 |
| How fast is sea level rising at San Francisco? | yes | geocode, sea-level-trends, render |  | 12.3 |
| Show Miami with 3 feet of sea level rise | yes | geocode, sea-level-rise, render, note |  | 11 |
| Where are methane plumes in the Permian Basin? | yes | geocode, methane-plumes, render |  | 41.3 |
| How much warmer than normal was Fresno County last month? | yes | geocode, temperature-anomaly, temperature-anomaly, render |  | 15.8 |
| Which sequoia groves burned in the 2020 and 2021 fires? | no | sequoia-mortality, sequoia-groves, burn-severity, burn-severity, render, render, render |  | 25.6 |
| Show the Lyell Glacier's retreat | yes | geocode, glaciers, render, set_time |  | 15.1 |
| great hikes around here @view | yes | osm-trails, peaks, outdoor-features, render, render | Area is 298265 km²; zoom in to under 160000 km² | 24.8 |
| deforestation or water rise in this area @view | yes | forest-loss, surface-water, render, render |  | 15.9 |
| good hiking in French Guiana | yes | geocode, osm-trails, peaks, outdoor-features, outdoor-features, protected-areas-world, render, render, render, render |  | 35.6 |
| wind farms in West Texas @view | no | geocode, geocode, power-plants, render |  | 14.6 |
| dams in the Colorado River basin | yes | geocode, dams, render |  | 10.4 |

Why the three failures failed:

- **Which sources did you use for snow near Mount Hood?** Queried `snowpack` (no stations) and the `snow-cover` tiles but never rendered them, so nothing was on the map. A prompt sentence now says to render every successful query, tile layers included.
- **Which sequoia groves burned in the 2020 and 2021 fires?** Queried with a box it made up and never geocoded, so the place was never located even though it rendered. A prompt sentence now says to geocode the place the features live in (the Sierra Nevada) and never make up a box.
- **wind farms in West Texas @view** Geocoded "West Texas" (twice) and queried power-plants with that region's box, which the rule read as shrinking the view. The rule now measures the box against the region the user named when the model geocodes it, and still requires a single power-plants query with no shrink and no zoom_in error.

The three standard-view questions (spec §12), run live on the code of commits 58c255c and 651bc3d with the same model (Bears Ears and uranium passed on their first run; the Moab question passed on its third, after two fixes to its own rule: the eval read the layer registry through a second module copy, and a hand-written range from 3 up now counts like the chips' include list):

| Question | ok | Tools (query_ prefix dropped) | Layer errors | Seconds |
| --- | --- | --- | --- | --- |
| How has Bears Ears changed since 2021? | yes | geocode, monuments, render |  | 11.5 |
| Show only hard mountain bike trails near Moab | yes | geocode, mtb-trails, mtb-trails, render | Area is 13446 km²; zoom in to under 10000 km² | 96.9 |
| Which uranium mines near the Navajo Nation score highest? | yes | geocode, uranium, render |  | 11.7 |

Each replays the tool results through the browser's mapping and reducer: Bears Ears must end in the change view (a compare by version on `kind`, 2021 lost and current gained, the camera on the union of both); the Moab question must filter mtb-trails on its difficulty facet so hard trails show and nothing easier, drawn on the facet ramp; the uranium question must end in the ranked view, with the hazard score's help text in the query summary and the highest-scoring site named in the note.

The two attribute and hex questions (spec §12c, §12d), run live on 2026-10-15 with the same model. Both failed on their first run and passed on the second, after two fixes: the geocoder now takes Mapbox's candidate of exactly the asked name (it had answered "West Texas" with the town of West, Texas, and the model gave up), and the sport-crags rule no longer counts a first climbing query that came back empty from a wrong box as a re-query (the chips were already right):

| Question | ok | Tools (query_ prefix dropped) | Layer errors | Seconds |
| --- | --- | --- | --- | --- |
| Where are most of the wind farms by capacity in West Texas? | yes | geocode, power-plants, render |  | 48 |
| Show only sport crags at Red River Gorge | yes | geocode, geocode, climbing, climbing, render |  | 59.9 |

The wind question must end with power-plants in the density view, drawn as hex cells colored by the sum of capacity (`render.hexBasis: sum`), every drawn plant wind, and Texas named in the note. The sport question must filter climbing through `render.filters` on its discipline attribute to sport alone (the Sport chip pressed, every drawn crag lists sport), with at most one climbing query that drew crags.


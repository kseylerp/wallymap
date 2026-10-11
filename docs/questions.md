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
- If a query returns the hint `zoom_in` for a named place, expect one extra query call on a smaller area. For the current view with no place named, expect queries of the layers in the error's `widerScale` list (for trails: peaks, huts and viewpoints, protected areas), drawn at that scale, and one sentence saying trails appear when zoomed in.
- The note is the answer: at most about 120 words, with no Sources, Next steps or Coverage notes sections. The text after it is only the follow-up questions; the chat strips anything else that repeats the note.
- `list_layers` may appear first in the trace; it does not change the result.
- Public data servers can be slow, so a query can take 10 to 30 seconds.

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, a physical-region outline, two "here" questions that carry a map view (`@view=[w,s,e,n]`, the bbox the browser would send) and pass without a geocode, one question on a view far wider than the trails layer allows (the whole Baltic, no place named), which passes only when the agent answers at that scale (at least one query succeeds and is drawn) without calling set_view or retrying a layer more than once, and twelve M4 questions, one per theme: mountain biking, ski touring, climbing, lake depth, surf today, river level, weather warnings, earthquakes, rock type at a point, glaciers, greenness compared over a year, and species records drawn as a heatmap, and ten Batch F questions: reservoir level, dams by decade, a monument then and now, uranium mines, a sea level trend, a sea level rise scenario, methane plumes, a county temperature anomaly, sequoia fire deaths, and a glacier's retreat, and the owner's two Tierra del Fuego questions on a wide view with no place named (great hikes, which must draw wider-scale layers instead of refusing; deforestation or water rise). Every question also fails when a note runs over 150 words or a heading appears twice across the notes and the closing text.

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
<!-- eval:end -->

## Last run

Run on 2026-10-10 at commit 94ee6e1 (Batch F integration: list_layers rows without synonyms, trimmed vocabulary, Batch F prompt sentences, 43 questions) with model `openai/gpt-oss-120b` and a 12-step cap: **ok 36/43**. A question passes when the agent located the place (geocode, a physical-regions query, or an `@view` map view), moved the camera with `set_view` after geocoding a named place (`@view` questions are exempt), queried a layer, drew whatever came back (render or compare), and wrote a note. When nothing was drawn, the note counts only if some layer answered with zero features; a question whose every layer query errored fails however much text was written. A route question passes when the route tool ran and a note followed. The eval builds the tools with the `@view` map view, as the chat route does.

The ten Batch F questions scored 7/10. Six of the seven failures are the pass rule (no place located, no `set_view` after a geocode, or nothing drawn); only the sequoia question picked a weaker layer.

| Question | ok | Tools (query_ prefix dropped) | Layer errors | Seconds |
| --- | --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | geocode, set_view, osm-trails, render, note |  | 30.1 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | geocode, set_view, fire-perimeters, render |  | 29.9 |
| Are there any active fires burning near Missoula right now? | yes | geocode, set_view, fire-detections, fire-perimeters, render |  | 28 |
| Where has the Amazon lost the most forest since 2015? | no | forest-loss, render |  | 15.5 |
| How much snow is on the ground around Mount Hood? | yes | geocode, set_view, snowpack, set_view, snowpack, render |  | 44.7 |
| Which rivers near Jackson Hole are running high right now? | yes | geocode, set_view, streamflow, render, note |  | 70.2 |
| Find campsites and forest roads open to vehicles near Moab | yes | geocode, set_view, campsites, forest-roads, render, render |  | 39.8 |
| What wildlife has been spotted around Banff this year? | no | geocode, species, render |  | 38 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes | geocode, set_view, osm-trails, outdoor-features, outdoor-features, popularity, render, render, render, set_view, popularity |  | 105.4 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | geocode, set_view, public-lands, wilderness, render, render |  | 40.9 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | geocode, set_view, night-lights, population, render, render |  | 46.4 |
| How remote is the Wind River Range? | yes | geocode, geocode, geocode, geocode, geocode, remoteness, remoteness, render, set_view, note | Area is 252706 km²; zoom in to under 60000 km² | 68.2 |
| Show me a walking route from Tahoe City to Emerald Bay | yes | geocode, geocode, set_view, route, render, note |  | 31.8 |
| Show wildfires near Yosemite year by year since 2016 | yes | geocode, set_view, fire-perimeters, render, set_time, note |  | 38.6 |
| Show only alpine-grade trails near Chamonix | yes | geocode, set_view, osm-trails, render |  | 17.1 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes | list_layers, geocode, set_view, forest-loss, render, forest-loss, render, note |  | 35 |
| Which sources did you use for snow near Mount Hood? | no | geocode, set_view, snowpack, snow-cover, snow-cover | Snow depth (depth: true) is only the latest analysis, so it takes no date; omit  | 24.9 |
| Which campsites around Moab look the most popular? | yes | geocode, set_view, campsites, popularity-campsites, popularity-campsites, popularity-campsites, render, render, note | Area is 13446 km²; zoom in to under 2500 km²; Area is 3373 km²; zoom in to under 2500 km² | 53.4 |
| Outline the Sierra Nevada | yes | geocode, set_view, physical-regions, render, note |  | 22.3 |
| What fires are here? | yes | fire-perimeters, render |  | 27.3 |
| Any surf here? | yes | surf, surf, render |  | 23.8 |
| Mountain bike trails near Moab | yes | geocode, set_view, mtb-trails, mtb-trails, mtb-trails, render | Area is 13446 km²; zoom in to under 2500 km²; Area is 3360 km²; zoom in to under 2500 km² | 30.4 |
| Ski touring routes around Chamonix | yes | geocode, set_view, ski-routes, render |  | 27.4 |
| Climbing crags near Red River Gorge | yes | geocode, geocode, set_view, climbing, climbing, render, note |  | 49.7 |
| How deep is Lake Tahoe? | yes | geocode, set_view, lakes, render |  | 25.7 |
| Surf at Half Moon Bay today | yes | geocode, set_view, surf, surf, render |  | 25.6 |
| Is the Carson River running high? | no | geocode, geocode, geocode, geocode, streamflow, streamflow, render |  | 40.1 |
| Any weather warnings around Lake Tahoe? | yes | geocode, set_view, weather-alerts, render, note |  | 24.9 |
| Recent earthquakes near Mammoth Lakes | yes | geocode, set_view, earthquakes, earthquakes, earthquakes, render |  | 50.4 |
| What rock is Half Dome made of? | yes | geocode, geocode, geocode, geocode, peaks, set_view, geologic-unit, render |  | 46.9 |
| Glaciers in the Wind River Range | yes | geocode, geocode, geocode, geocode, set_view, glaciers, set_view, glaciers, set_view, glaciers, render, note | Area is 53570 km²; zoom in to under 8000 km²; Area is 8928 km²; zoom in to under 8000 km² | 38.5 |
| How green was the Sierra Nevada this month compared to last year? | yes | geocode, set_view, greenness, greenness, render, render, note |  | 54.8 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | yes | geocode, set_view, species, gbif-occurrences, render, species, render | Area is 269282 km²; zoom in to under 50000 km² | 41.4 |
| How full is Lake Powell right now? | yes | geocode, geocode, set_view, reservoir-levels, set_view, reservoir-levels, render, note |  | 29.8 |
| Show dams on the Colorado River by the decade they were built | no | dams, dams, dams, render | Area is 1008732 km²; zoom in to under 250000 km²; Area is 252183 km²; zoom in to under 250000 km² | 25.2 |
| How has Bears Ears National Monument changed since 2021? | no | monuments, geocode, geocode, monuments, render, render |  | 28.8 |
| Where are abandoned uranium mines near the Navajo Nation? | yes | geocode, geocode, set_view, uranium, render, note |  | 24.4 |
| How fast is sea level rising at San Francisco? | yes | geocode, set_view, sea-level-trends, render |  | 25 |
| Show Miami with 3 feet of sea level rise | yes | geocode, set_view, sea-level-rise, render |  | 22.7 |
| Where are methane plumes in the Permian Basin? | yes | geocode, set_view, methane-plumes, render, note |  | 35.5 |
| How much warmer than normal was Fresno County last month? | yes | geocode, temperature-anomaly, render, set_view |  | 21.6 |
| Which sequoia groves burned in the 2020 and 2021 fires? | no | sequoia-groves, fire-perimeters, fire-perimeters, render, render, render, fire-perimeters, render | Area is 118733 km²; zoom in to under 60000 km² | 78.6 |
| Show the Lyell Glacier's retreat | yes | geocode, set_view, glaciers, glaciers, geocode, geocode, set_view, glaciers, render, set_time | Area is 10556 km²; zoom in to under 8000 km² | 43.2 |

Layer errors above are mostly area-limit (`zoom_in`) errors; each of those questions retried a smaller box and drew a result.

Why the seven failures failed:

- **Where has the Amazon lost the most forest since 2015?** Queried `forest-loss` with a bbox it guessed and never geocoded, so the place was never located.
- **What wildlife has been spotted around Banff this year?** Right layer and answer, but no `set_view` after the geocode.
- **Which sources did you use for snow near Mount Hood?** `snow-cover` failed (it passed a date with `depth: true`) and nothing was rendered.
- **Is the Carson River running high?** Correct gauge readings, but no `set_view` after four geocodes.
- **Show dams on the Colorado River by the decade they were built** Queried `dams` with a guessed bbox (two `zoom_in` retries), never geocoded, and filtered by river instead of playing the decades with `set_time`.
- **How has Bears Ears National Monument changed since 2021?** Drew both boundaries and described the change, but geocoded without `set_view`.
- **Which sequoia groves burned in the 2020 and 2021 fires?** Never geocoded, and answered from `fire-perimeters` instead of `sequoia-mortality`.

One targeted re-run of each failure (same commit):

| Question | ok | Tools (query_ prefix dropped) | Layer errors | Seconds |
| --- | --- | --- | --- | --- |
| Where has the Amazon lost the most forest since 2015? | yes | geocode, geocode, geocode, set_view, forest-loss, render |  | 32.7 |
| What wildlife has been spotted around Banff this year? | yes | geocode, set_view, species, render, note |  | 28.7 |
| Which sources did you use for snow near Mount Hood? | yes | geocode, set_view, snowpack, set_view, snowpack, snow-cover, render, render |  | 35.8 |
| Is the Carson River running high? | yes | geocode, geocode, streamflow, set_view, render, note |  | 19.9 |
| Show dams on the Colorado River by the decade they were built | no | dams, dams, render, render, render, render | Area is 535675 km²; zoom in to under 250000 km² | 45.8 |
| How has Bears Ears National Monument changed since 2021? | no | monuments, monuments, monuments, geocode |  | 39 |
| Which sequoia groves burned in the 2020 and 2021 fires? | yes | sequoia-groves, burn-severity, burn-severity, set_view, render, render, wikipedia-nearby, geocode, fire-perimeters, geocode | Area is 84371 km²; zoom in to under 1000 km²; Area is 84371 km²; zoom in to under 60000 km² | 95.6 |

Five passed on re-run. The dams question again guessed its bbox without geocoding and filtered by river and year instead of using `set_time`. The Bears Ears question queried `monuments` three times, then the model stopped with no answer (finish reason "other").

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
- "Which large fires burned in Oregon in 2020?": `query_fire-perimeters` (named outlines with acres), filtered to 2020.
- "How badly did the 2020 fires burn in Oregon?": `query_burn-severity` with `year: 2020` (the burn-severity map of every large fire that year).
- "Is this house in a flood zone?" (zoomed in): `query_flood-zones`; `query_fire-hazard` for long-run fire risk; `query_drought` for this week's drought.

**Earth, water and ice**
- "What rock is Half Dome made of?": `geocode` → `query_geologic-unit` with the lon and lat of the center → `note`. `query_geology` draws the map.
- "How deep is Lake Tahoe?": `query_lakes` with `name: "Lake Tahoe"`; `v` is the maximum depth in metres.
- "Glaciers in the Wind River Range": `query_glaciers` (areas in km²).
- "Tallest peaks in the Sierra Nevada": `query_peaks` (elevation and prominence).
- "Did Lake Mead shrink?": `query_surface-water` with `product: change`, or `query_reservoir-levels` for its storage record.
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

## Coverage questions

The 60 questions after "Show only sport crags at Red River Gorge" in the eval set make sure every layer and every standard view is asked about, so the map checks see each layer before the owner does. With the older questions, every registered layer appears in at least one question, and each view (change, timeline, ranked, density, detail, scenario, route) is expected at least twice. They mix regions (US West and East, Alaska, Hawaii, Canada, the Alps, Patagonia, New Zealand, Japan, Africa) and kinds: where is, which is biggest or highest, show only, what changed since, here (`@view`), plan a route, is it safe or open now, and compare two places.

Each coverage question also has a pass expectation in `COVERAGE_QUESTIONS` (scripts/eval-model.mts): the layers it must query, get an answer from and draw (either of two, written `a|b`), the view the drawn layer must end in where it matters, and for two questions the Show as mode (heat, columns). A route view passes when a route is on the map; a change view also passes when the layer is open in a compare. `--tag coverage` runs only these questions:

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set --tag coverage --save /tmp/coverage
```

- **Change**: Grand Staircase-Escalante since 2021 (`monuments`), Arctic sea ice against 2012 (`sea-ice`), Lahaina before and after the fire (`imagery-by-date`); Lake Mead since the 1980s (`surface-water` or `reservoir-levels`, no view expected).
- **Timeline**: Washington wolf packs since 2014 (`wolf-packs`), Colorado beetle kill (`tree-mortality`), Japan earthquakes this month (`earthquakes`).
- **Ranked**: Gulf Coast ports (`ports`), New Zealand's highest peaks (`peaks`), Patagonia's biggest glaciers (`glaciers`), Florida disaster declarations (`disasters`).
- **Density**: Nevada mines (`mines`), Phoenix groundwater wells (`groundwater`), Alaska brown bears as a heatmap (`gbif-occurrences` or `species`, Show as Heat); Arizona power plants as columns (Show as Columns).
- **Detail**: Table Mountain's rock (`geologic-unit`), Kilimanjaro (`peaks` or `wikipedia-nearby`), Crater Lake's depth (`lakes`).
- **Scenario**: Charleston at 6 feet and Honolulu at 2 feet of sea level rise (`sea-level-rise`).
- **Route**: Banff to Lake Louise by bike, Zermatt to the Hörnli Hut on foot, Happy Isles to Half Dome (the `route` tool alone).
- **One question per layer no older question asks about**: aquifers, burn-severity, carbon-flux, condor-range, critical-habitat, disasters (Mozambique), disturbance, drought, fire-hazard, fire-weather, fishing, flood-extent, flood-zones, forest-alerts, geology, grazing-allotments, hardiness-zones, land-cover, mining-claims, old-growth, paddling (twice), permafrost, phenology, photos, pipelines-lines, recreation-sites, river-basins, smoke, tides, wikipedia-nearby.
- **Data stories** (spec §13, §13a): the Mississippi's flow over three months (`river-pulse`, timeline), Cook Inlet's currents this week (`ocean-currents`, timeline, the tide plotted under the scrubber), the Sierra's strongest wind tomorrow (`wind-flow`). Each also holds its answer to the data's shape: a low and a peak with numbers, a ratio for the river, and what size or brightness and color mean.
- **Safe or open now, here, compare**: weather at Paradise (`weather-alerts`), forest roads near Flagstaff (`forest-roads`), huts around Zermatt on a map view (`outdoor-features`), fishing on the Kenai on a map view (`fishing`), the Gila against the Bob Marshall (`remoteness`), snow at Mount Baker against Mount Hood (`snowpack`).

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, a physical-region outline, two "here" questions that carry a map view (`@view=[w,s,e,n]`, the bbox the browser would send) and pass without a geocode, one question on a view far wider than the trails layer allows (the whole Baltic, no place named), which passes only when the agent answers at that scale (at least one query succeeds and is drawn) without calling set_view or retrying a layer more than once, and twelve M4 questions, one per theme: mountain biking, ski touring, climbing, lake depth, surf today, river level, weather warnings, earthquakes, rock type at a point, glaciers, greenness compared over a year, and species records drawn as a heatmap, and ten Batch F questions: reservoir level, dams by decade, a monument then and now, uranium mines, a sea level trend, a sea level rise scenario, methane plumes, a county temperature anomaly, sequoia fire deaths, and a glacier's retreat, and the owner's two Tierra del Fuego questions on a wide view with no place named (great hikes, which must draw wider-scale layers instead of refusing; deforestation or water rise), and the owner's "good hiking in French Guiana", which passes only when a query that holds hiking candidates succeeds (trails with named routes, peaks, outdoor features or protected areas), population and night lights are not queried, and the note, within 150 words, names at least three places from the returned features, and the owner's "wind farms in West Texas" on a 392,000 km² view, which passes only when power-plants answers with at least 100 features, no power-plants query uses a box under 90% of the view (no shrinking) or errors, and the note names the largest site by MW, and "dams in the Colorado River basin", which passes when a dams query over the basin answers with features and no zoom_in error. Every question also fails when a note runs over 150 words or a heading appears twice across the notes and the closing text.

Every question also runs the map checks (`lib/checks/mapChecks.ts`) on the map its tool results end on, replayed through the browser's reducer: features on land, at sea or at the coast as their layer says (a 1:50m land mask, 2 km tolerance, a quarter of the layer out of place), no point layer on a regular grid, no place drawn twice within 1 km or listed twice in Rank by's top 10, inspect card rows in words (no raw keys, "Value", bare URLs, mostly "n/a", or scores without help), only registered layer ids, and for a question about a place, 80% of each layer's features in or near it. The JSON line lists them under `checks`, each failure as a sentence; a question passes only when its rules and every check pass. With `--screens`, thirteen of the questions (`SCREEN_QUESTIONS` in the script) also open by permalink in Chromium at 1440×900 and 375×812 from a worktree copy of HEAD, and the page is checked: panels and their contents inside the panel and the screen, no text cut without an ellipsis, the chat placeholder whole and uncovered, hex and symbol labels not clipped, and each line layer visible on Topo and Topo + Satellite. Screenshots and a contact sheet go to `.superpowers/m3/checks/`.

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set --screens --save /tmp/runs
node --env-file=.env.local --import tsx scripts/eval-model.mts --set --replay /tmp/runs   # checks again, no model calls
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
- Has Grand Staircase-Escalante gotten smaller since 2021?
- How much less sea ice is in the Arctic this September than in 2012?
- Show Lahaina before and after the 2023 fire
- Did Lake Mead shrink since the 1980s?
- Wolf packs in Washington since 2014
- Where did beetles kill trees in Colorado over the last ten years?
- Earthquakes in Japan this month
- Busiest ports on the Gulf Coast
- Highest peaks in the Southern Alps of New Zealand
- Biggest glaciers in Patagonia
- Which counties in Florida had the most disaster declarations?
- Where are most of the old mines in Nevada?
- Where are the most groundwater wells around Phoenix?
- Heatmap of brown bear sightings in Alaska
- Show power plants in Arizona as 3D columns by megawatts
- What rock is Table Mountain made of?
- Tell me about Mount Kilimanjaro
- How deep is Crater Lake?
- Show Charleston with 6 feet of sea level rise
- What would 2 feet of sea level rise do to Honolulu?
- Plan a bike ride from Banff to Lake Louise
- Walking route from Zermatt to the Hörnli Hut
- Plan a hike from Happy Isles to the top of Half Dome
- Where is the Ogallala aquifer?
- How badly did the 2020 fires burn in Oregon?
- Is the Tongass a carbon sink?
- Can I see condors near Big Sur?
- Critical habitat for the desert tortoise near St. George
- Any floods or cyclones in Mozambique right now?
- Where has forest just been cleared in British Columbia?
- How dry is Colorado this week?
- Wildfire risk around Bend
- Fire danger in Southern California this week
- Where can I fish for trout near Bozeman?
- Is there flooding along the Zambezi right now?
- Is downtown Asheville in a flood zone?
- New deforestation alerts in the Congo this month
- Show the geology of the Grand Canyon
- Where are the wild horses in Nevada?
- Show plant hardiness zones in Vermont
- What's the land cover around Torres del Paine?
- Active mining claims near Moab
- Where is the old-growth forest in Oregon?
- Rapids on the Middle Fork Salmon
- Kayaking rivers near Queenstown
- Where is the permafrost in Alaska?
- Did spring come early in Virginia this year?
- Where do people take photos around Mount Fuji?
- Pipelines and power lines near Midland, Texas
- Trailheads and picnic areas in the Coconino National Forest
- What watershed is Denver in?
- Is there wildfire smoke over Seattle today?
- When is low tide at Acadia?
- Tell me about the history of Bodie
- Is it safe to hike at Paradise on Mount Rainier today?
- Are the forest roads open for camping near Flagstaff?
- Huts near here @view=[7.6,45.85,7.95,46.1]
- Where can I fish here @view=[-151.2,60.4,-150,60.6]
- Which is more remote, the Gila or the Bob Marshall?
- Compare snow depth at Mount Baker and Mount Hood
- How has the Mississippi's flow changed over the last three months?
- Show the currents in Cook Inlet this week
- Where is the wind strongest over the Sierra tomorrow?
<!-- eval:end -->

## Last run

Full set (114 questions) run on 2026-10-17 with model `openai/gpt-oss-120b`, a 12-step cap, the Tier 1 map checks and the Tier 2 screen checks: **ok 107/113 at commit 8027e1d**, with one question skipped (Active mining claims near Moab: BLM's claim service has been offline since 2026-10-14, a documented outage). Each of the 6 failures was a real bug, fixed, and run again once at 744c0eb: **6/6 passed, so 113/113 stand on the current code**. Screens: **13/14** at 8027e1d; the one failure was fixed in 13afeb1 and passes on replay. An earlier full run the same night, at 38ee103 before most of these fixes, scored 94/113.

The checks:

- **Pass rules.** The place was located and the camera moved there, a layer answered, what came back was drawn, a note (or closing text) under 150 words with no heading twice, plus each question's own rule. A coverage question also needs its expected layer answered and drawn in its expected view and Show as; one whose layer is under a documented outage is skipped, not passed.
- **Tier 1, the data on the final map.** Features on land or at sea as the layer says (against Natural Earth 1:10m land, which has small islands); no point grid; no place drawn or ranked twice, and no two top-10 entries with one measure under one name stem (a reservoir's dam and its dikes); card rows in words, no card or Rank by title in capitals unless it is an acronym, and no "Jan 1, 1963" for a date known only to the year; only registered layers; the features in or near the place (for "near <town>", within the radius the layer searches), and every entry of Rank by's top 10 in or near it. The card check also runs in `pnpm test` over a recorded sample of every layer (`lib/checks/__fixtures__/card-samples.json`), not only the layers a question draws.
- **Tier 2, the screen** (14 questions at 1440×900 and 375×812). Panels inside the screen, no text cut without an ellipsis, the chat placeholder whole, labels inside the map, zero console errors, and every line, symbol and area layer visible on Topo and Topo + Satellite: the pixels along lines, under symbols, along area outlines and inside areas must change when the layer's opacity goes to 0. Areas are measured flat, on 3D terrain, and again with a card open (the other areas of the layer fade, but their outlines must not vanish).

What failed on the first run, one sentence each, and the fix:

- **best hiking trails for elevation (@view)** The model drew layers named "query_peaks" and "query_outdoor-features", which do not exist; render now reads a tool's name as its layer (e11839a).
- **Is the Carson River running high?** "Carson River" was found as a street in Wyoming and then a 10 km box at Fallon, the model asked for the same gauges three more times, and the server's note wrongly said the gauges had not answered; rivers now resolve to their basin and the note lists only layers that never answered (3237eba, ffecae7).
- **How green was the Sierra Nevada this month compared to last year?** The model compared greenness without ever querying it; the server now queries both dates first (1eb487f).
- **Where are the most iNaturalist or GBIF records of mountain lions in Colorado?** The model drew a layer named "query_gbif-occurrences", which does not exist (e11839a).
- **Show dams on the Colorado River by the decade they were built** "Colorado River" was found on the Colorado River of Texas; it now resolves to the Colorado River basin (3237eba).
- **dams in the Colorado River basin** The model searched dams far past the basin, and Fort Randall Dam in South Dakota ranked third; a query well past a named region now runs on the region's own box (744c0eb).

Remaining failures: none. Active mining claims near Moab is skipped until BLM restores its service.

Screens, reviewed by eye: the one failing check was a ranked label ("Left Flank") pushed past the map's edge on tilted terrain at Red River Gorge (13afeb1). The review also fixed every sighting card titled "Feature" (019252e), a hex cell listing one wind farm's turbines five times (857b8ff), card labels cut with an ellipsis (fd29e37), and glacier outlines that vanished on satellite ice beside an open card (6a2829b). The contact sheet is `.superpowers/m3/checks/index.html`.

| Question | First run | Re-run | Failed checks (first run) | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes |  |  | geocode, osm-trails, render | 25.2 |
| Which wildfires burned near Yosemite in the last 10 years? | yes |  |  | geocode, fire-perimeters, render | 26.4 |
| Are there any active fires burning near Missoula right now? | yes |  |  | geocode, fire-detections, render | 28.7 |
| Where has the Amazon lost the most forest since 2015? | yes |  |  | geocode, geocode, forest-loss, render | 29.4 |
| How much snow is on the ground around Mount Hood? | yes |  |  | geocode, snowpack, snow-cover, render | 34.1 |
| Which rivers near Jackson Hole are running high right now? | yes |  |  | geocode, geocode, streamflow, render | 48.9 |
| Find campsites and forest roads open to vehicles near Moab | yes |  |  | geocode, campsites, forest-roads, render, render | 32 |
| What wildlife has been spotted around Banff this year? | yes |  |  | geocode, species, render | 34 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes |  |  | geocode, osm-trails, outdoor-features, outdoor-features, popularity, render, render, render | 70.9 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes |  |  | geocode, public-lands, wilderness, render, render | 25.7 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes |  |  | geocode, night-lights, population, render, render | 58.4 |
| How remote is the Wind River Range? | yes |  |  | geocode, remoteness, render | 23.3 |
| Show me a walking route from Tahoe City to Emerald Bay | yes |  |  | route, render | 17.2 |
| Show wildfires near Yosemite year by year since 2016 | yes |  |  | geocode, fire-perimeters, geocode, fire-perimeters, render | 42.1 |
| Show only alpine-grade trails near Chamonix | yes |  |  | geocode, osm-trails, render | 38 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes |  |  | geocode, forest-loss, forest-loss, render, render | 62.7 |
| Which sources did you use for snow near Mount Hood? | yes |  |  | geocode, snowpack, snow-cover, render, render, render | 43.2 |
| Which campsites around Moab look the most popular? | yes |  |  | geocode, campsites, popularity-campsites, render | 27.9 |
| Outline the Sierra Nevada | yes |  |  | geocode, physical-regions, render, render | 30 |
| What fires are here? @view | yes |  |  | fire-perimeters, fire-detections, render | 25.7 |
| Any surf here? @view | yes |  |  | surf, surf, render | 29.1 |
| best hiking trails for elevation @view | no | yes | layerIds | osm-trails, peaks, outdoor-features, render, render, render, render | 71.2 |
| Mountain bike trails near Moab | yes |  |  | geocode, mtb-trails, render | 25 |
| Ski touring routes around Chamonix | yes |  |  | geocode, geocode, ski-routes, render | 26 |
| Climbing crags near Red River Gorge | yes |  |  | geocode, climbing, render | 21.6 |
| How deep is Lake Tahoe? | yes |  |  | geocode, lakes, render | 15 |
| Surf at Half Moon Bay today | yes |  |  | geocode, surf, surf, render | 20.8 |
| Is the Carson River running high? | no | yes | place | geocode, streamflow, streamflow, render, note | 70.4 |
| Any weather warnings around Lake Tahoe? | yes |  |  | geocode, weather-alerts, render | 32.2 |
| Recent earthquakes near Mammoth Lakes | yes |  |  | geocode, earthquakes, render | 26.5 |
| What rock is Half Dome made of? | yes |  |  | geocode, geologic-unit, render | 20.8 |
| Glaciers in the Wind River Range | yes |  |  | geocode, glaciers, render | 28.8 |
| How green was the Sierra Nevada this month compared to last year? | no | yes | rules | geocode, compare, render | 27.2 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | no | yes | layerIds | geocode, species, gbif-occurrences, render, render | 63.6 |
| How full is Lake Powell right now? | yes |  |  | geocode, reservoir-levels, geocode, reservoir-levels, reservoir-levels, geocode | 43.2 |
| Show dams on the Colorado River by the decade they were built | no | yes | place | geocode, dams, dams, render | 66.2 |
| How has Bears Ears National Monument changed since 2021? | yes |  |  | geocode, monuments, render | 33.3 |
| Where are abandoned uranium mines near the Navajo Nation? | yes |  |  | geocode, uranium, render | 24.5 |
| How fast is sea level rising at San Francisco? | yes |  |  | geocode, sea-level-trends, render | 18.6 |
| Show Miami with 3 feet of sea level rise | yes |  |  | geocode, sea-level-rise, render | 19.7 |
| Where are methane plumes in the Permian Basin? | yes |  |  | geocode, methane-plumes, render | 29.9 |
| How much warmer than normal was Fresno County last month? | yes |  |  | geocode, temperature-anomaly, render | 23.1 |
| Which sequoia groves burned in the 2020 and 2021 fires? | yes |  |  | geocode, sequoia-groves, sequoia-mortality, geocode, sequoia-mortality, render, render | 71.4 |
| Show the Lyell Glacier's retreat | yes |  |  | geocode, glaciers, render | 22.4 |
| great hikes around here @view | yes |  |  | osm-trails, render | 31 |
| deforestation or water rise in this area @view | yes |  |  | forest-loss, sea-level-rise, render | 32.7 |
| good hiking in French Guiana | yes |  |  | geocode, osm-trails, peaks, outdoor-features, protected-areas-world, render, render, render, render | 66.4 |
| wind farms in West Texas @view | yes |  |  | geocode, power-plants, render | 30.5 |
| dams in the Colorado River basin | no | yes | place | geocode, river-basins, river-basins, dams, render, render | 49 |
| How has Bears Ears changed since 2021? | yes |  |  | geocode, monuments, render | 29.3 |
| Show only hard mountain bike trails near Moab | yes |  |  | geocode, mtb-trails, render, render, note | 32.6 |
| Which uranium mines near the Navajo Nation score highest? | yes |  |  | geocode, uranium, render | 36.6 |
| Where are most of the wind farms by capacity in West Texas? | yes |  |  | geocode, power-plants, render, render, render | 44.5 |
| Show only sport crags at Red River Gorge | yes |  |  | geocode, climbing, render | 30 |
| Has Grand Staircase-Escalante gotten smaller since 2021? | yes |  |  | geocode, monuments, render | 21.8 |
| How much less sea ice is in the Arctic this September than in 2012? | yes |  |  | geocode, sea-ice, sea-ice, compare, render | 52.2 |
| Show Lahaina before and after the 2023 fire | yes |  |  | geocode, geocode, imagery-by-date, imagery-by-date, compare, render | 68.2 |
| Did Lake Mead shrink since the 1980s? | yes |  |  | geocode, reservoir-levels, geocode, geocode, geocode, reservoir-levels, render | 65.8 |
| Wolf packs in Washington since 2014 | yes |  |  | geocode, geocode, wolf-packs, render | 24.3 |
| Where did beetles kill trees in Colorado over the last ten years? | yes |  |  | geocode, tree-mortality, render | 75.4 |
| Earthquakes in Japan this month | yes |  |  | geocode, earthquakes, render | 22.1 |
| Busiest ports on the Gulf Coast | yes |  |  | geocode, ports, render | 25.3 |
| Highest peaks in the Southern Alps of New Zealand | yes |  |  | geocode, geocode, geocode, peaks, render | 28.1 |
| Biggest glaciers in Patagonia | yes |  |  | geocode, glaciers, render | 32.3 |
| Which counties in Florida had the most disaster declarations? | yes |  |  | geocode, disasters, render | 23.3 |
| Where are most of the old mines in Nevada? | yes |  |  | geocode, mines, render | 63.4 |
| Where are the most groundwater wells around Phoenix? | yes |  |  | geocode, groundwater, render | 31.7 |
| Heatmap of brown bear sightings in Alaska | yes |  |  | geocode, species, gbif-occurrences, render | 29.8 |
| Show power plants in Arizona as 3D columns by megawatts | yes |  |  | geocode, power-plants, render | 22.3 |
| What rock is Table Mountain made of? | yes |  |  | geocode, geocode, geologic-unit, render | 20.4 |
| Tell me about Mount Kilimanjaro | yes |  |  | geocode, peaks, render, wikipedia-nearby, render | 46.6 |
| How deep is Crater Lake? | yes |  |  | geocode, lakes, render | 20.5 |
| Show Charleston with 6 feet of sea level rise | yes |  |  | geocode, sea-level-rise, render | 25.2 |
| What would 2 feet of sea level rise do to Honolulu? | yes |  |  | geocode, sea-level-rise, render | 23.1 |
| Plan a bike ride from Banff to Lake Louise | yes |  |  | geocode, geocode, route, render | 26.8 |
| Walking route from Zermatt to the Hörnli Hut | yes |  |  | route, render | 19.9 |
| Plan a hike from Happy Isles to the top of Half Dome | yes |  |  | geocode, geocode, route, render | 50.1 |
| Where is the Ogallala aquifer? | yes |  |  | geocode, aquifers, render | 22.4 |
| How badly did the 2020 fires burn in Oregon? | yes |  |  | geocode, burn-severity, fire-perimeters, fire-perimeters, render, render, render | 65.7 |
| Is the Tongass a carbon sink? | yes |  |  | geocode, carbon-flux, render | 22.5 |
| Can I see condors near Big Sur? | yes |  |  | geocode, condor-range, render | 36.9 |
| Critical habitat for the desert tortoise near St. George | yes |  |  | geocode, critical-habitat, render | 32.3 |
| Any floods or cyclones in Mozambique right now? | yes |  |  | geocode, disasters, render | 36.2 |
| Where has forest just been cleared in British Columbia? | yes |  |  | geocode, forest-alerts, disturbance, render, render | 28.7 |
| How dry is Colorado this week? | yes |  |  | geocode, drought, render | 33.9 |
| Wildfire risk around Bend | yes |  |  | geocode, fire-hazard, render | 31.8 |
| Fire danger in Southern California this week | yes |  |  | geocode, fire-weather, render | 28.1 |
| Where can I fish for trout near Bozeman? | yes |  |  | geocode, fishing, species, render, render | 48.5 |
| Is there flooding along the Zambezi right now? | yes |  |  | geocode, geocode, flood-extent, render | 34.7 |
| Is downtown Asheville in a flood zone? | yes |  |  | geocode, flood-zones, render | 84.9 |
| New deforestation alerts in the Congo this month | yes |  |  | geocode, forest-alerts, render | 23.3 |
| Show the geology of the Grand Canyon | yes |  |  | geocode, geology, render | 17 |
| Where are the wild horses in Nevada? | yes |  |  | geocode, grazing-allotments, render | 21.6 |
| Show plant hardiness zones in Vermont | yes |  |  | geocode, hardiness-zones, render | 17.3 |
| What's the land cover around Torres del Paine? | yes |  |  | geocode, land-cover, render | 15.3 |
| Active mining claims near Moab | skipped |  |  | list_layers | 10.1 |
| Where is the old-growth forest in Oregon? | yes |  |  | geocode, old-growth, render | 31.3 |
| Rapids on the Middle Fork Salmon | yes |  |  | geocode, geocode, geocode, paddling | 26.9 |
| Kayaking rivers near Queenstown | yes |  |  | geocode, paddling, render | 25.7 |
| Where is the permafrost in Alaska? | yes |  |  | geocode, permafrost, render | 22.5 |
| Did spring come early in Virginia this year? | yes |  |  | geocode, phenology, render | 29.7 |
| Where do people take photos around Mount Fuji? | yes |  |  | geocode, photos, render | 51.1 |
| Pipelines and power lines near Midland, Texas | yes |  |  | geocode, pipelines-lines, pipelines-lines, render, render | 46.5 |
| Trailheads and picnic areas in the Coconino National Forest | yes |  |  | geocode, recreation-sites, render | 53.3 |
| What watershed is Denver in? | yes |  |  | geocode, river-basins, render | 36.4 |
| Is there wildfire smoke over Seattle today? | yes |  |  | geocode, smoke, render | 25.7 |
| When is low tide at Acadia? | yes |  |  | geocode, tides, render | 51.3 |
| Tell me about the history of Bodie | yes |  |  | geocode, wikipedia-nearby, render | 21.4 |
| Is it safe to hike at Paradise on Mount Rainier today? | yes |  |  | geocode, geocode, geocode, weather-alerts, snowpack, streamflow, render | 50 |
| Are the forest roads open for camping near Flagstaff? | yes |  |  | geocode, forest-roads, campsites, render, render | 32.1 |
| Huts near here @view | yes |  |  | outdoor-features, render | 18.8 |
| Where can I fish here @view | yes |  |  | fishing, render | 26.4 |
| Which is more remote, the Gila or the Bob Marshall? | yes |  |  | geocode, geocode, remoteness, remoteness, render, render | 46.2 |
| Compare snow depth at Mount Baker and Mount Hood | yes |  |  | geocode, geocode, snowpack, render, note | 52.1 |

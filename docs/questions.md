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

The 61 questions after "Show only sport crags at Red River Gorge" in the eval set make sure every layer and every standard view is asked about, so the map checks see each layer before the owner does. With the older questions, every registered layer appears in at least one question, and each view (change, timeline, ranked, density, detail, scenario, route) is expected at least twice. They mix regions (US West and East, Alaska, Hawaii, Canada, the Alps, Patagonia, New Zealand, Japan, Africa) and kinds: where is, which is biggest or highest, show only, what changed since, here (`@view`), plan a route, is it safe or open now, and compare two places.

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
- **One question per layer no older question asks about**: aquifers, burn-severity, carbon-flux, condor-range, critical-habitat, disasters (Mozambique), disturbance, drought, fire-hazard, fire-weather, fishing, flood-extent, flood-zones, forest-alerts, geology, grazing-allotments, hardiness-zones, land-cover, mining-claims, old-growth, forest-types (twice: a map view in Sabah, and Borneo's natural forest converted since 2017), paddling (twice), permafrost, phenology, photos, pipelines-lines, recreation-sites, river-basins, smoke, tides, wikipedia-nearby.
- **Data stories** (spec §13, §13a): the Mississippi's flow over three months (`river-pulse`, timeline), Cook Inlet's currents this week (`ocean-currents`, timeline, the tide plotted under the scrubber), the Sierra's strongest wind tomorrow (`wind-flow`). Each also holds its answer to the data's shape: a low and a peak with numbers, a ratio for the river, and what size or brightness and color mean.
- **Safe or open now, here, compare**: weather at Paradise (`weather-alerts`), forest roads near Flagstaff (`forest-roads`), huts around Zermatt on a map view (`outdoor-features`), fishing on the Kenai on a map view (`fishing`), the Gila against the Bob Marshall (`remoteness`), snow at Mount Baker against Mount Hood (`snowpack`).

## Use-case questions

The 57 questions after "Where is the wind strongest over the Sierra tomorrow?" in the eval set are the `usecase` tag: two or three questions for each of the 25 use cases in `docs/use-cases.md` (a hiker, backpacker, trail runner, mountain biker, climber, paddler, kayaker, ski tourer, angler, surfer, camper, overlander, wildlife watcher, birder, photographer, smoke and flood watchers, ranger, range manager, researcher, journalist and educator), each a real decision in the owner's voice. Each has an expectation in `USECASE_QUESTIONS` (scripts/eval-model.mts): the layers it must query, get an answer from and draw (`a|b` for either), the view where it matters, and for some the `render.filters` key the decision needs (difficulty, discipline, road level, water temperature); `needs` lists what the app still lacks for the full answer (a forecast, a cross-layer join, slope or aspect, whitewater class), which the rule does not check. The full acceptance checks per use case (counts, values, the note's deciding facts, the phone screen) are in `docs/use-cases.md` and are judged by hand; the first audit (2026-10-23: 1 use case works, 11 weak, 13 fail, while the pass rule above passed 47 of 57) is `.superpowers/m3/usecases/AUDIT.md`.

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set --tag usecase --save /tmp/usecases
```

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, a physical-region outline, two "here" questions that carry a map view (`@view=[w,s,e,n]`, the bbox the browser would send) and pass without a geocode, one question on a view far wider than the trails layer allows (the whole Baltic, no place named), which passes only when the agent answers at that scale (at least one query succeeds and is drawn) without calling set_view or retrying a layer more than once, and twelve M4 questions, one per theme: mountain biking, ski touring, climbing, lake depth, surf today, river level, weather warnings, earthquakes, rock type at a point, glaciers, greenness compared over a year, and species records drawn as a heatmap, and ten Batch F questions: reservoir level, dams by decade, a monument then and now, uranium mines, a sea level trend, a sea level rise scenario, methane plumes, a county temperature anomaly, sequoia fire deaths, and a glacier's retreat, and the owner's two Tierra del Fuego questions on a wide view with no place named (great hikes, which must draw wider-scale layers instead of refusing; deforestation or water rise), and the owner's "good hiking in French Guiana", which passes only when a query that holds hiking candidates succeeds (trails with named routes, peaks, outdoor features or protected areas), population and night lights are not queried, and the note, within 150 words, names at least three places from the returned features, and the owner's "wind farms in West Texas" on a 392,000 km² view, which passes only when power-plants answers with at least 100 features, no power-plants query uses a box under 90% of the view (no shrinking) or errors, and the note names the largest site by MW, and "dams in the Colorado River basin", which passes when a dams query over the basin answers with features and no zoom_in error. Every question also fails when a note runs over 150 words or a heading appears twice across the notes and the closing text.

Every question also runs the map checks (`lib/checks/mapChecks.ts`) on the map its tool results end on, replayed through the browser's reducer: features on land, at sea or at the coast as their layer says (a 1:50m land mask, 2 km tolerance, a quarter of the layer out of place), no point layer on a regular grid, no place drawn twice within 1 km or listed twice in Rank by's top 10, inspect card rows in words (no raw keys, "Value", bare URLs, mostly "n/a", or scores without help), only registered layer ids, and for a question about a place, 80% of each layer's features in or near it. The JSON line lists them under `checks`, each failure as a sentence; a question passes only when its rules and every check pass. With `--screens`, twenty-two of the questions (`SCREEN_QUESTIONS` in the script) also open by permalink in Chromium at 1440×900 and 375×812 from a worktree copy of HEAD, and the page is checked: panels and their contents inside the panel and the screen, no text cut without an ellipsis, the chat placeholder whole and uncovered, hex and symbol labels not clipped, and each line layer visible on Topo and Topo + Satellite (a line layer colored by levels, such as forest roads by maintenance level, level by level and on Satellite too). Screenshots and a contact sheet go to `.superpowers/m3/checks/`.

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
- Are there active faults near Salt Lake City?
- What kind of soil is around Fort Collins?
- Where are the wild horses in Nevada?
- Show plant hardiness zones in Vermont
- What's the land cover around Torres del Paine?
- Active mining claims near Moab
- Where is the old-growth forest in Oregon?
- Is this primary forest or plantation? @view=[117.6,4.8,118,5.1]
- Where has natural forest been converted to plantations in Borneo since 2017?
- What vegetation types grow around Sedona?
- Which ecoregions does Yellowstone span?
- How tall are the trees in Redwood National Park?
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
- Where is the avalanche terrain near Teton Pass?
- Will it rain in Yosemite Valley this weekend?
- What's the avalanche danger in Little Cottonwood Canyon today?
- Elevation profile from Glacier Point to Half Dome
- Where is the wind strongest over the Sierra tomorrow?
- Good day hikes near Boulder under 5 miles
- Easy hikes with a waterfall near Asheville
- Which trails at Mount Rainier are snow free right now?
- Is there still snow on the trails around Lake Tahoe?
- Backpacking in the Wind Rivers: where are the water sources and campsites?
- Where can I camp along the Wonderland Trail?
- Long trail runs with big climbs near Chamonix
- Flat trail runs over 10 miles near Portland
- Intermediate mountain bike trails near Bentonville
- Flowy blue trails in Sedona
- Which crags near Moab are sport and shaded in the afternoon?
- Beginner sport climbing at Red Rock near Las Vegas
- Bouldering near Bishop this weekend, will it be too hot?
- Is it too windy to climb at Joshua Tree tomorrow?
- Where can I paddle class III near Asheville this weekend?
- Is the Gauley running right now?
- Class IV runs in Colorado with enough water right now
- Best time to kayak Tomales Bay tomorrow, tide and wind
- Where can I launch a kayak on Lake Tahoe?
- Avalanche danger near Stevens Pass today
- Where's the deepest fresh snow in Utah right now?
- Low-angle ski tours near Teton Pass
- Is the Madison fishing well right now?
- Where can I fly fish with public access near Asheville?
- Trout streams near Denver that aren't too warm
- Will Santa Cruz have good surf this weekend?
- Where is the swell biggest on the Oregon coast right now?
- Free dispersed camping near Sedona
- Where can I park my van overnight on BLM land near Moab?
- Camping and water along the Mojave Road
- Forest roads a Subaru can drive near Leadville
- Where can I see moose near Jackson Hole?
- Where are whales being seen off Monterey this week?
- Best place to see sandhill cranes in Nebraska in March
- Where have bald eagles been seen near Seattle lately?
- Where should I shoot sunset near Sedona?
- Darkest skies for Milky Way photos near Moab
- Is there fall color near Asheville right now?
- Is it smoky in Bend tomorrow?
- Are the fires near Missoula contained?
- Is the French Broad going to flood in Asheville?
- Any flash flood warnings in Utah canyons today?
- Will it rain in Zion this weekend?
- How much of the Deschutes National Forest burned in the last 10 years and how badly?
- Where did beetles kill trees in the Medicine Bow since 2020?
- Grazing allotments overlapping desert tortoise critical habitat near St. George
- Wild horse areas in Nevada that are in drought right now
- How much forest did Pará lose since 2017 and to what?
- Which protected areas in Borneo lost the most forest?
- Jaguar records in Costa Rica outside protected areas
- Old-growth forest in Oregon that isn't in wilderness
- How much has Lake Powell dropped since 2000?
- Which California counties got the most disaster declarations since 2020?
- Biggest methane leaks in the Permian this year
- Show my class how the glaciers in Glacier National Park have shrunk
- What rock is under Denver?
- How has Arctic sea ice changed since 2012?
<!-- eval:end -->

## Last run

Use-case questions (57, `--tag usecase`) run live on 2026-10-23 with model `openai/gpt-oss-120b`, a 12-step cap and the
Tier 1 map checks, after the three use-case branches (routing and geocoding, combine and terrain, layer data) were
merged: **ok 41/57** on the first run. The 16 failures, and 4 questions that had hit bugs fixed during the run, were run
again once on the fixed code: **10/20 passed, so 47/57 stand.** The full set (179 questions) then ran once:
**ok 155/177** (2 skipped: documented outages), on code loaded before the screen fixes; its 22 failures were run again
once: 11 passed, so **166/177 stand**. Per use case, judged by hand: **10 work, 13 weak, 2 fail**
(audit before: 1, 11, 13); see `.superpowers/m3/usecases/AFTER.md`.

The checks:

- **Pass rules.** The place was located and the camera moved there, a layer answered, what came back was drawn, a note (or closing text) under 150 words with no heading twice, plus each question's own rule. A coverage question also needs its expected layer answered and drawn in its expected view and Show as; one whose layer is under a documented outage is skipped, not passed.
- **Tier 1, the data on the final map.** Features on land or at sea as the layer says (against Natural Earth 1:10m land, which has small islands); no point grid; no place drawn or ranked twice, and no two top-10 entries with one measure under one name stem (a reservoir's dam and its dikes); card rows in words, no card or Rank by title in capitals unless it is an acronym, and no "Jan 1, 1963" for a date known only to the year; only registered layers; the features in or near the place (for "near <town>", within the radius the layer searches), and every entry of Rank by's top 10 in or near it. The card check also runs in `pnpm test` over a recorded sample of every layer (`lib/checks/__fixtures__/card-samples.json`), not only the layers a question draws.
- **Tier 2, the screen** (17 questions at 1440×900 and 375×812). Panels inside the screen, no text cut without an ellipsis, the chat placeholder whole, labels inside the map, zero console errors, and every line, symbol and area layer visible on Topo and Topo + Satellite: the pixels along lines, under symbols, along area outlines and inside areas must change when the layer's opacity goes to 0. Areas are measured flat, on 3D terrain, and again with a card open (the other areas of the layer fade, but their outlines must not vanish).

A use-case question is also held to its expected layers, view and filter, and a question whose words relate two layers
("outside protected areas", "in drought", "along the Wonderland Trail") passes only when combine ran with that operation.

What failed and was fixed, one sentence each:

- **Bouldering near Bishop, Lake Tahoe kayak launch, wild horses in drought, free camping near Sedona.** The model stopped with an empty step and the person got no answer; an empty step before the answer is now asked again once (dac41a7).
- **Is it too windy at Joshua Tree, rain in Zion, Santa Cruz surf.** The closing text quoted one hour of the forecast as both low and peak ("65 °F to 65 °F"); a forecast with nothing observed now tells the asked place's low and high over the hours ahead (8e30eef).
- **Class IV runs in Colorado.** Lake Granby's storage was read as 261,000 cfs from the NWS river service; a reservoir reported by its pool elevation is no longer a river gauge (e7b2876).
- **Deepest fresh snow in Utah.** Grounding cut "Spirit Lake" because SNOTEL writes "Spirit Lk", leaving no station named; station short forms now match (8ba50b4).
- **Sandhill cranes in Nebraska in March.** "In March" asked only last March (one record); it now asks every March in the layer's ten-year window (fbc8085).
- **Wild horses in drought.** The join counted D0, abnormally dry, as drought (227 of 227); "in drought" is D1 to D4 and combine keeps to the question's filters (eabd168).
- **Flowy blue trails in Sedona.** A trail color would have filtered a raw property and dropped trails rated on the Singletrack Scale; it now sets the Difficulty chip (c75c88a).
- **Easy hikes with a waterfall.** Now read as a join (b940e21), and its "Top 10 by distance" lists the nearest first (17a3ec8).
- **Fly fishing near Asheville.** The note reached the person as raw JSON; that text is now the note (95aa1b9).
- **Wild horses in drought (full-set re-run).** The model answered in plain text without the join; a text ending is now held back until combine runs, like a note (e353141).
- **Lyell Glacier, beetles in Colorado.** "Unnamed glacier" rows and beetle-kill polygons kilometres apart were failed as one place listed twice (957012c).
- **Backpacking in the Wind Rivers, fly fishing near Asheville.** Lake groups ("Knob Lakes") and two ramps sharing a gauge's temperature were flagged as places drawn twice; the duplicate check now tells them apart (f39b71e, d9c0a72, 8891bf4).

Remaining failures: whitewater class (no free source), the Mojave Road's line (not found), jaguar points (hidden by
iNaturalist), rank or view choices the model makes differently from the expectation (Jackson moose, California counties,
Nebraska cranes), the campsite layer drawing Pineknot Campground twice 17 m apart, tree-mortality rows that share one
name, and Monterey whales seen across the bay outside the city's box.

| Question | First run | Re-run | Why it failed (latest run) | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- | --- | --- |
| Good day hikes near Boulder under 5 miles | yes |  |  | geocode, osm-trails, render | 33.2 |
| Easy hikes with a waterfall near Asheville | yes |  |  | geocode, osm-trails, outdoor-features, combine, render, render | 36.3 |
| Which trails at Mount Rainier are snow free right now? | yes |  |  | geocode, osm-trails, snow-cover, combine, render, render, render | 37.5 |
| Is there still snow on the trails around Lake Tahoe? | yes |  |  | geocode, snow-cover, snowpack, render, render | 26.9 |
| Backpacking in the Wind Rivers: where are the water sources and campsites? | no | no | Lakes and reservoirs (lakes): 4 places are drawn twice within 1 km, e.g. "Knob Lakes" twice 258 m apart (42.83, -109.44 | geocode, outdoor-features, lakes, campsites, render, render, render | 100.7 |
| Where can I camp along the Wonderland Trail? | yes |  |  | geocode, osm-trails, campsites, combine, render, render, render | 43.5 |
| Long trail runs with big climbs near Chamonix | yes |  |  | geocode, osm-trails, render | 36.5 |
| Flat trail runs over 10 miles near Portland | yes |  |  | geocode, osm-trails, render | 45.2 |
| Intermediate mountain bike trails near Bentonville | yes |  |  | geocode, mtb-trails, render | 20.6 |
| Flowy blue trails in Sedona | yes |  |  | geocode, mtb-trails, render, render | 25.1 |
| Which crags near Moab are sport and shaded in the afternoon? | no | yes |  | geocode, climbing, render, terrain | 107.9 |
| Beginner sport climbing at Red Rock near Las Vegas | yes |  |  | geocode, climbing, render | 54.5 |
| Bouldering near Bishop this weekend, will it be too hot? | no | yes |  | geocode, climbing, weather-forecast, render, render | 59.9 |
| Is it too windy to climb at Joshua Tree tomorrow? | yes | yes |  | geocode, wind-flow, weather-forecast, render, render | 49.5 |
| Where can I paddle class III near Asheville this weekend? | yes |  |  | geocode, paddling, streamflow, render, render | 57.1 |
| Is the Gauley running right now? | yes |  |  | geocode, streamflow, render | 37 |
| Class IV runs in Colorado with enough water right now | no | no | paddling not answered; no v filter | geocode, paddling, streamflow, surface-water, render, render | 96.1 |
| Best time to kayak Tomales Bay tomorrow, tide and wind | yes |  |  | geocode, tides, wind-flow, set_basemap, render, render | 108.9 |
| Where can I launch a kayak on Lake Tahoe? | no | yes |  | geocode, paddling, recreation-sites, render, render | 47.7 |
| Avalanche danger near Stevens Pass today | yes |  |  | geocode, avalanche, render, note | 38.2 |
| Where's the deepest fresh snow in Utah right now? | yes | yes |  | geocode, snowpack, render | 37.2 |
| Low-angle ski tours near Teton Pass | yes |  |  | geocode, ski-routes, terrain, render, render, note | 69.2 |
| Is the Madison fishing well right now? | yes |  |  | geocode, streamflow, fishing, render, render | 91.8 |
| Where can I fly fish with public access near Asheville? | no | yes |  | geocode, public-lands, fishing, streamflow, combine, render, render, render | 61.5 |
| Trout streams near Denver that aren't too warm | yes |  |  | geocode, fishing, streamflow, render, render | 68.4 |
| Will Santa Cruz have good surf this weekend? | yes | yes |  | geocode, surf, render | 30.3 |
| Where is the swell biggest on the Oregon coast right now? | yes |  |  | geocode, surf, render | 44.9 |
| Free dispersed camping near Sedona | no | yes |  | geocode, public-lands, forest-roads, campsites, render, render, render | 44.3 |
| Where can I park my van overnight on BLM land near Moab? | no | no | campsites not answered | geocode, public-lands, forest-roads, render, render, note | 55.6 |
| Camping and water along the Mojave Road | no | no | no combine along; Campsites and parking lots (campsites): 1 place is drawn twice within 1 km, e.g. "Pineknot Campground" twice 17 m apart (34.24, - | geocode, campsites, outdoor-features, lakes, render, render, render | 39.3 |
| Forest roads a Subaru can drive near Leadville | yes |  |  | geocode, forest-roads, render, note | 42.6 |
| Where can I see moose near Jackson Hole? | no | no | view ['timeline'] not density | geocode, species, render | 42.1 |
| Where are whales being seen off Monterey this week? | no | no | Species sightings (species): only 2 of 4 features are in or near Monterey, California, United States (its box grown by | geocode, species, render | 39.9 |
| Best place to see sandhill cranes in Nebraska in March | no | no | view [None] not density | geocode, species, gbif-occurrences, render, render | 70.5 |
| Where have bald eagles been seen near Seattle lately? | yes |  |  | geocode, species, render | 41.5 |
| Where should I shoot sunset near Sedona? | yes |  |  | geocode, outdoor-features, photos, render, render | 92.7 |
| Darkest skies for Milky Way photos near Moab | yes |  |  | geocode, night-lights, osm-trails, render, render, photos, peaks, outdoor-features, protected-areas-world, render, render, render, render, note | 158.4 |
| Is there fall color near Asheville right now? | yes |  |  | geocode, imagery-by-date, imagery-by-date, imagery-by-date, render | 90.1 |
| Is it smoky in Bend tomorrow? | yes |  |  | geocode, smoke, render | 29 |
| Are the fires near Missoula contained? | yes |  |  | geocode, fire-perimeters, render | 61.1 |
| Is the French Broad going to flood in Asheville? | yes |  |  | geocode, streamflow, render | 69.8 |
| Any flash flood warnings in Utah canyons today? | yes |  |  | geocode, weather-alerts, render | 38 |
| Will it rain in Zion this weekend? | yes | yes |  | geocode, weather-forecast, render | 41.9 |
| How much of the Deschutes National Forest burned in the last 10 years and how badly? | yes |  |  | geocode, fire-perimeters, protected-areas-world, burn-severity, render, render, render | 82.1 |
| Where did beetles kill trees in the Medicine Bow since 2020? | no | no | Tree death (beetles, drought, disease) (tree-mortality): the Rank by top 10 (by value) repeats one value under one name, parts of one place listed | geocode, geocode, tree-mortality, render | 39.6 |
| Grazing allotments overlapping desert tortoise critical habitat near St. George | yes |  |  | geocode, grazing-allotments, critical-habitat, combine, render, render, render | 74.1 |
| Wild horse areas in Nevada that are in drought right now | no | yes |  | geocode, grazing-allotments, drought, combine, render, render, render, render | 62.9 |
| How much forest did Pará lose since 2017 and to what? | yes |  |  | geocode, forest-loss, render, forest-types, render, render | 84.8 |
| Which protected areas in Borneo lost the most forest? | yes |  |  | geocode, protected-areas-world, forest-loss, render, render | 36.6 |
| Jaguar records in Costa Rica outside protected areas | no | no | no combine outside | geocode, gbif-occurrences, species, protected-areas-world, render, render | 65.5 |
| Old-growth forest in Oregon that isn't in wilderness | yes |  |  | geocode, old-growth, wilderness, combine, render, render | 93 |
| How much has Lake Powell dropped since 2000? | yes |  |  | geocode, reservoir-levels, render | 88.6 |
| Which California counties got the most disaster declarations since 2020? | no | no | view ['timeline'] not ranked | geocode, disasters, render, note, note | 83.8 |
| Biggest methane leaks in the Permian this year | yes |  |  | geocode, methane-plumes, render | 71.3 |
| Show my class how the glaciers in Glacier National Park have shrunk | yes |  |  | geocode, glaciers, render, note | 75.6 |
| What rock is under Denver? | yes |  |  | geocode, geologic-unit, render, note | 30.5 |
| How has Arctic sea ice changed since 2012? | yes |  |  | geocode, sea-ice, sea-ice, compare, render | 93.8 |

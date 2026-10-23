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
- Is this primary forest or plantation? @view=[117.6,4.8,118,5.1]
- Where has natural forest been converted to plantations in Borneo since 2017?
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

Full set (117 questions) run on 2026-10-18 with model `openai/gpt-oss-120b`, a 12-step cap and the Tier 1 map checks, after the five layer groups were merged and the shared fixes landed: **ok 110/117 at commit 0c1d9ec**. The 7 failures were run again once at 386b4fb: 3 passed, 1 was skipped (Active mining claims near Moab: the answer says BLM's map is offline there, so it counts neither way), and 3 failed again on real bugs, which were fixed in 017f1be and then passed 3/3. So **116/116 stand on the current code, with 1 skipped**. Screens (Tier 2, replayed from the first run's answers against the current app): **14/17**; two of the three failures were a card's layer name cut with an ellipsis (fixed in dc36a19) and GLIMS answering 503 on the Patagonia replay (the source, not the app); the third, glacier outlines too faint in 3D over the Wind River snow, still stands.

The checks:

- **Pass rules.** The place was located and the camera moved there, a layer answered, what came back was drawn, a note (or closing text) under 150 words with no heading twice, plus each question's own rule. A coverage question also needs its expected layer answered and drawn in its expected view and Show as; one whose layer is under a documented outage is skipped, not passed.
- **Tier 1, the data on the final map.** Features on land or at sea as the layer says (against Natural Earth 1:10m land, which has small islands); no point grid; no place drawn or ranked twice, and no two top-10 entries with one measure under one name stem (a reservoir's dam and its dikes); card rows in words, no card or Rank by title in capitals unless it is an acronym, and no "Jan 1, 1963" for a date known only to the year; only registered layers; the features in or near the place (for "near <town>", within the radius the layer searches), and every entry of Rank by's top 10 in or near it. The card check also runs in `pnpm test` over a recorded sample of every layer (`lib/checks/__fixtures__/card-samples.json`), not only the layers a question draws.
- **Tier 2, the screen** (17 questions at 1440×900 and 375×812). Panels inside the screen, no text cut without an ellipsis, the chat placeholder whole, labels inside the map, zero console errors, and every line, symbol and area layer visible on Topo and Topo + Satellite: the pixels along lines, under symbols, along area outlines and inside areas must change when the layer's opacity goes to 0. Areas are measured flat, on 3D terrain, and again with a card open (the other areas of the layer fade, but their outlines must not vanish).

What failed on the first run, one sentence each, and the fix:

- **How has Bears Ears National Monument changed since 2021?** A compared monument's card showed the compare's bookkeeping as "Dv −5,455", "Before" and "After"; cards now leave those out (df24637).
- **How has Bears Ears changed since 2021?** The same card rows, and a monument's two outlines (which share its name as id) never produced the 2021 edge; the edge is now found by shape (b463c53) and the eval rule follows the boundary compare (017f1be).
- **Has Grand Staircase-Escalante gotten smaller since 2021?** The model asked the same layer three times and opened the detail view; it passed on the re-run.
- **Where are most of the old mines in Nevada?** "Wonder No. 1 Claim" was drawn twice 998 m apart (two USGS records); one name within a kilometre is now one site (ca8bf4a, 017f1be).
- **Active mining claims near Moab** The "near Moab" box (13,000 km²) was over the layer's limit, so the query was dropped; mining claims now answer a town-sized box (386b4fb), and the answer says BLM's map is offline there (skipped).
- **Pipelines and power lines near Midland, Texas** The top 10 by voltage listed one Oncor 345 kV line six times (its segments); lines are now named by owner, voltage and substations, and segments of one name and voltage join (386b4fb, 017f1be).
- **Where can I fish here @view** Four "Boat ramp" rows at one gauge's temperature; unnamed spots are now named by the nearest place and a single gauge is not ranked (ec03628); passed on the re-run.

Remaining failures: none on the current code; one question skipped while BLM's national claim map is offline.

Screens, reviewed by eye: the per-layer after-shots and grades are in `.superpowers/m3/after/REPORT.md`; the contact sheet is `.superpowers/m3/checks/index.html`.

| Question | First run | Re-run | Failed checks (first run) | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes |  |  | geocode, osm-trails, render | 30.9 |
| Which wildfires burned near Yosemite in the last 10 years? | yes |  |  | geocode, fire-perimeters, render, note | 27 |
| Are there any active fires burning near Missoula right now? | yes |  |  | geocode, fire-detections, fire-perimeters, render, render, note | 42.5 |
| Where has the Amazon lost the most forest since 2015? | yes |  |  | geocode, forest-loss, render, note | 46.8 |
| How much snow is on the ground around Mount Hood? | yes |  |  | geocode, snowpack, snow-cover, render, render | 35.8 |
| Which rivers near Jackson Hole are running high right now? | yes |  |  | geocode, streamflow, render | 39.4 |
| Find campsites and forest roads open to vehicles near Moab | yes |  |  | geocode, campsites, forest-roads, render, render | 31.7 |
| What wildlife has been spotted around Banff this year? | yes |  |  | geocode, species, render | 40.9 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes |  |  | geocode, popularity, outdoor-features, render, render | 71.1 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes |  |  | geocode, public-lands, wilderness, render, render | 25.4 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes |  |  | geocode, night-lights, population, render, render | 29.9 |
| How remote is the Wind River Range? | yes |  |  | geocode, remoteness, render | 18.1 |
| Show me a walking route from Tahoe City to Emerald Bay | yes |  |  | route, render | 12.6 |
| Show wildfires near Yosemite year by year since 2016 | yes |  |  | geocode, fire-perimeters, render, set_time | 32.6 |
| Show only alpine-grade trails near Chamonix | yes |  |  | geocode, geocode, osm-trails, render | 35 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes |  |  | geocode, forest-loss, forest-loss, compare, render | 41.5 |
| Which sources did you use for snow near Mount Hood? | yes |  |  | geocode, snow-cover, snow-cover, snowpack, render, render | 33.6 |
| Which campsites around Moab look the most popular? | yes |  |  | geocode, campsites, popularity-campsites, render | 73.9 |
| Outline the Sierra Nevada | yes |  |  | geocode, physical-regions, render | 34.6 |
| What fires are here? @view | yes |  |  | fire-perimeters, render | 26.6 |
| Any surf here? @view | yes |  |  | surf, render | 18.3 |
| best hiking trails for elevation @view | yes |  |  | osm-trails, peaks, outdoor-features, protected-areas-world, render, render, render | 63 |
| Mountain bike trails near Moab | yes |  |  | geocode, mtb-trails, render | 28.5 |
| Ski touring routes around Chamonix | yes |  |  | geocode, geocode, ski-routes, render | 31.8 |
| Climbing crags near Red River Gorge | yes |  |  | geocode, climbing, render | 27.1 |
| How deep is Lake Tahoe? | yes |  |  | geocode, lakes, render, note | 23.2 |
| Surf at Half Moon Bay today | yes |  |  | geocode, surf, surf, render | 21.4 |
| Is the Carson River running high? | yes |  |  | geocode, streamflow, render | 27.5 |
| Any weather warnings around Lake Tahoe? | yes |  |  | geocode, weather-alerts, render, note | 26.1 |
| Recent earthquakes near Mammoth Lakes | yes |  |  | geocode, earthquakes, earthquakes, render, note | 69.4 |
| What rock is Half Dome made of? | yes |  |  | geocode, geologic-unit, render | 30.8 |
| Glaciers in the Wind River Range | yes |  |  | geocode, glaciers, render | 20 |
| How green was the Sierra Nevada this month compared to last year? | yes |  |  | geocode, greenness, greenness, compare, render | 44.6 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | yes |  |  | geocode, gbif-occurrences, render | 25.3 |
| How full is Lake Powell right now? | yes |  |  | geocode, geocode, reservoir-levels, reservoir-levels, reservoir-levels, render | 42.6 |
| Show dams on the Colorado River by the decade they were built | yes |  |  | geocode, dams, render | 58.1 |
| How has Bears Ears National Monument changed since 2021? | no | yes | card | geocode, monuments, render | 45.3 |
| Where are abandoned uranium mines near the Navajo Nation? | yes |  |  | geocode, uranium, render | 25.6 |
| How fast is sea level rising at San Francisco? | yes |  |  | geocode, sea-level-trends, render | 38.5 |
| Show Miami with 3 feet of sea level rise | yes |  |  | geocode, sea-level-rise, render | 22.2 |
| Where are methane plumes in the Permian Basin? | yes |  |  | geocode, methane-plumes, render | 41 |
| How much warmer than normal was Fresno County last month? | yes |  |  | geocode, temperature-anomaly, render | 37.5 |
| Which sequoia groves burned in the 2020 and 2021 fires? | yes |  |  | geocode, geocode, sequoia-mortality, fire-perimeters, render, render, render, note | 85.2 |
| Show the Lyell Glacier's retreat | yes |  |  | geocode, glaciers, geocode, glaciers, geocode, glaciers, geocode, render, set_time | 88 |
| great hikes around here @view | yes |  |  | osm-trails, render | 24.2 |
| deforestation or water rise in this area @view | yes |  |  | forest-loss, render, sea-level-rise | 16.8 |
| good hiking in French Guiana | yes |  |  | geocode, osm-trails, protected-areas-world, outdoor-features, render, render, render | 50.4 |
| wind farms in West Texas @view | yes |  |  | power-plants, render | 22 |
| dams in the Colorado River basin | yes |  |  | geocode, dams, render, render, render, render, render | 45.4 |
| How has Bears Ears changed since 2021? | no | no; yes after fix | card, rules | geocode, monuments, render | 22.6 |
| Show only hard mountain bike trails near Moab | yes |  |  | geocode, mtb-trails, render | 24.5 |
| Which uranium mines near the Navajo Nation score highest? | yes |  |  | geocode, uranium, render | 15.1 |
| Where are most of the wind farms by capacity in West Texas? | yes |  |  | geocode, power-plants, render, render | 28.4 |
| Show only sport crags at Red River Gorge | yes |  |  | geocode, climbing, render | 34.2 |
| Has Grand Staircase-Escalante gotten smaller since 2021? | no | yes | rules, coverage | geocode, monuments, monuments, monuments, render, note | 69 |
| How much less sea ice is in the Arctic this September than in 2012? | yes |  |  | geocode, sea-ice, sea-ice, compare, render | 33 |
| Show Lahaina before and after the 2023 fire | yes |  |  | geocode, imagery-by-date, imagery-by-date, compare, render | 39.7 |
| Did Lake Mead shrink since the 1980s? | yes |  |  | geocode, geocode, surface-water, reservoir-levels, reservoir-levels, reservoir-levels, render, lakes, render, note | 59.1 |
| Wolf packs in Washington since 2014 | yes |  |  | geocode, wolf-packs, geocode, wolf-packs, render | 42.4 |
| Where did beetles kill trees in Colorado over the last ten years? | yes |  |  | geocode, tree-mortality, render | 44.8 |
| Earthquakes in Japan this month | yes |  |  | geocode, earthquakes, render | 23.3 |
| Busiest ports on the Gulf Coast | yes |  |  | geocode, ports, render | 25.4 |
| Highest peaks in the Southern Alps of New Zealand | yes |  |  | geocode, peaks, render | 31 |
| Biggest glaciers in Patagonia | yes |  |  | geocode, glaciers, render | 33.9 |
| Which counties in Florida had the most disaster declarations? | yes |  |  | list_layers, geocode, disasters, render | 29.1 |
| Where are most of the old mines in Nevada? | no | no; yes after fix | duplicates | geocode, mines, render | 37 |
| Where are the most groundwater wells around Phoenix? | yes |  |  | geocode, groundwater, render | 46.3 |
| Heatmap of brown bear sightings in Alaska | yes |  |  | geocode, species, gbif-occurrences, render | 34.8 |
| Show power plants in Arizona as 3D columns by megawatts | yes |  |  | geocode, power-plants, render | 19.1 |
| What rock is Table Mountain made of? | yes |  |  | geocode, geologic-unit, render | 16.3 |
| Tell me about Mount Kilimanjaro | yes |  |  | geocode, peaks, wikipedia-nearby, render, render | 30.1 |
| How deep is Crater Lake? | yes |  |  | geocode, lakes, render | 12.4 |
| Show Charleston with 6 feet of sea level rise | yes |  |  | geocode, sea-level-rise, render | 14.4 |
| What would 2 feet of sea level rise do to Honolulu? | yes |  |  | geocode, sea-level-rise, render | 17.3 |
| Plan a bike ride from Banff to Lake Louise | yes |  |  | route, geocode, mtb-trails, render, render | 21.8 |
| Walking route from Zermatt to the Hörnli Hut | yes |  |  | route, render | 30.7 |
| Plan a hike from Happy Isles to the top of Half Dome | yes |  |  | geocode, geocode, route, render | 32.6 |
| Where is the Ogallala aquifer? | yes |  |  | geocode, aquifers, render, note | 21.6 |
| How badly did the 2020 fires burn in Oregon? | yes |  |  | geocode, burn-severity, render | 17.5 |
| Is the Tongass a carbon sink? | yes |  |  | geocode, carbon-flux, render | 25.8 |
| Can I see condors near Big Sur? | yes |  |  | geocode, condor-range, render | 19.3 |
| Critical habitat for the desert tortoise near St. George | yes |  |  | geocode, critical-habitat, render | 30.7 |
| Any floods or cyclones in Mozambique right now? | yes |  |  | geocode, flood-extent, disasters, render, render | 43.7 |
| Where has forest just been cleared in British Columbia? | yes |  |  | geocode, forest-alerts, disturbance, render | 26.3 |
| How dry is Colorado this week? | yes |  |  | geocode, drought, render | 23.1 |
| Wildfire risk around Bend | yes |  |  | geocode, fire-hazard, render | 28.4 |
| Fire danger in Southern California this week | yes |  |  | geocode, fire-weather, render | 17 |
| Where can I fish for trout near Bozeman? | yes |  |  | geocode, fishing, species, species, render | 31.6 |
| Is there flooding along the Zambezi right now? | yes |  |  | geocode, flood-extent, river-pulse, render | 34 |
| Is downtown Asheville in a flood zone? | yes |  |  | geocode, flood-zones, render | 44.7 |
| New deforestation alerts in the Congo this month | yes |  |  | geocode, forest-alerts, render, note | 20.3 |
| Show the geology of the Grand Canyon | yes |  |  | geocode, geology, render | 18.1 |
| Where are the wild horses in Nevada? | yes |  |  | geocode, grazing-allotments, render | 17.3 |
| Show plant hardiness zones in Vermont | yes |  |  | geocode, hardiness-zones, render | 16.8 |
| What's the land cover around Torres del Paine? | yes |  |  | geocode, land-cover, render | 23.3 |
| Active mining claims near Moab | no | skipped | rules, coverage | geocode, mining-claims, public-lands, render | 38.3 |
| Where is the old-growth forest in Oregon? | yes |  |  | geocode, old-growth, render | 33.8 |
| Rapids on the Middle Fork Salmon | yes |  |  | geocode, paddling, paddling, render | 30.6 |
| Kayaking rivers near Queenstown | yes |  |  | geocode, paddling, render | 45.1 |
| Where is the permafrost in Alaska? | yes |  |  | geocode, permafrost, render | 18 |
| Did spring come early in Virginia this year? | yes |  |  | geocode, phenology, render | 28.8 |
| Where do people take photos around Mount Fuji? | yes |  |  | geocode, photos, render, note | 31.9 |
| Pipelines and power lines near Midland, Texas | no | no; yes after fix | duplicates | geocode, pipelines-lines, render | 26.8 |
| Trailheads and picnic areas in the Coconino National Forest | yes |  |  | geocode, recreation-sites, render | 27.1 |
| What watershed is Denver in? | yes |  |  | geocode, river-basins, render | 20 |
| Is there wildfire smoke over Seattle today? | yes |  |  | geocode, smoke, render | 15.9 |
| When is low tide at Acadia? | yes |  |  | geocode, tides, render | 24.1 |
| Tell me about the history of Bodie | yes |  |  | geocode, wikipedia-nearby, render, note | 16.6 |
| Is it safe to hike at Paradise on Mount Rainier today? | yes |  |  | geocode, geocode, geocode, geocode, weather-alerts, fire-hazard, fire-perimeters, set_basemap, render, render, render, note, render | 54.7 |
| Are the forest roads open for camping near Flagstaff? | yes |  |  | geocode, forest-roads, campsites, render, render, note | 41.9 |
| Huts near here @view | yes |  |  | outdoor-features, render | 23.3 |
| Where can I fish here @view | no | yes | duplicates | fishing, render | 18.8 |
| Which is more remote, the Gila or the Bob Marshall? | yes |  |  | geocode, geocode, geocode, remoteness, remoteness, render | 37.1 |
| Compare snow depth at Mount Baker and Mount Hood | yes |  |  | geocode, geocode, snowpack, snowpack, snowpack, render | 54.1 |
| How has the Mississippi's flow changed over the last three months? | yes |  |  | geocode, river-pulse, render | 30.1 |
| Show the currents in Cook Inlet this week | yes |  |  | geocode, ocean-currents, set_basemap, render | 29.9 |
| Where is the wind strongest over the Sierra tomorrow? | yes |  |  | geocode, wind-flow, set_time, render | 44.2 |

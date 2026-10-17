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

## Coverage questions

The 60 questions after "Show only sport crags at Red River Gorge" in the eval set make sure every layer and every standard view is asked about, so the map checks see each layer before the owner does. With the older questions, every registered layer appears in at least one question, and each view (change, timeline, ranked, density, detail, scenario, route) is expected at least twice. They mix regions (US West and East, Alaska, Hawaii, Canada, the Alps, Patagonia, New Zealand, Japan, Africa) and kinds: where is, which is biggest or highest, show only, what changed since, here (`@view`), plan a route, is it safe or open now, and compare two places.

Each coverage question also has a pass expectation in `COVERAGE_QUESTIONS` (scripts/eval-model.mts): the layers it must query, get an answer from and draw (either of two, written `a|b`), the view the drawn layer must end in where it matters, and for two questions the Show as mode (heat, columns). A route view passes when a route is on the map; a change view also passes when the layer is open in a compare. `--tag coverage` runs only these questions:

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set --tag coverage --save /tmp/coverage
```

- **Change**: Grand Staircase-Escalante since 2021 (`monuments`), Arctic sea ice against 2012 (`sea-ice`), Lahaina before and after the fire (`imagery-by-date`); Lake Mead since the 1980s (`surface-water`, no view expected).
- **Timeline**: Washington wolf packs since 2014 (`wolf-packs`), Colorado beetle kill (`tree-mortality`), Japan earthquakes this month (`earthquakes`).
- **Ranked**: Gulf Coast ports (`ports`), New Zealand's highest peaks (`peaks`), Patagonia's biggest glaciers (`glaciers`), Florida disaster declarations (`disasters`).
- **Density**: Nevada mines (`mines`), Phoenix groundwater wells (`groundwater`), Alaska brown bears as a heatmap (`gbif-occurrences` or `species`, Show as Heat); Arizona power plants as columns (Show as Columns).
- **Detail**: Table Mountain's rock (`geologic-unit`), Kilimanjaro (`peaks` or `wikipedia-nearby`), Crater Lake's depth (`lakes`).
- **Scenario**: Charleston at 6 feet and Honolulu at 2 feet of sea level rise (`sea-level-rise`).
- **Route**: Banff to Lake Louise by bike, Zermatt to the Hörnli Hut on foot, Happy Isles to Half Dome (the `route` tool alone).
- **One question per layer no older question asks about**: aquifers, burn-severity, carbon-flux, condor-range, critical-habitat, disasters (Mozambique), disturbance, drought, fire-hazard, fire-weather, fishing, flood-extent, flood-zones, forest-alerts, geology, grazing-allotments, hardiness-zones, land-cover, mining-claims, old-growth, paddling (twice), permafrost, phenology, photos, pipelines-lines, recreation-sites, river-basins, smoke, tides, wikipedia-nearby.
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
- Which large fires burned in Oregon in 2020?
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
<!-- eval:end -->

## Last run

Full set run on 2026-10-16 with model `openai/gpt-oss-120b`, a 12-step cap and the map checks: **ok 38/54** at commit ff5345d, after the product fixes below. The same checks on the runs made before those fixes (2026-10-16, at a21721b's product code) gave **ok 30/54**; the pass rules alone passed 48 of them, so the checks caught 18 questions the old eval called good. Five questions were run again after the last fixes (b24a902): the weather warnings and the West Texas wind farms then passed, so **40/54** stand on the current code.

What the checks caught on the first run, and what was fixed:

- **Duplicates** (12 questions). Rank by's top 10 listed one place again and again: Rubicon Trail 7 times around Tahoe (trail segments), Gannett Glacier twice (older outlines), La Trapette twice, Ranchland Wind Project 4 times (its turbines). The list now shows one row per place (9a73dd3, b24a902). One fire filed by two agencies drew twice (Empire and EMPIRE, Ferguson; ed48751). One waterfall mapped twice in OpenStreetMap drew twice (Chutes Voltaire; e286a22). EU sites under two designations drew as two areas (52 around the Baltic; fc33d38, af6df10, a265146). Two uranium mine portals shared one name (Taylor Reid No. 1; now (A) and (B), ff5345d). Climbing walls left twice after joining OpenStreetMap and OpenBeta (North 40, Courtesy Wall; 6d3e939).
- **Card text** (7 questions). Wikipedia, weather alerts and the geologic unit printed raw URLs; surf read "Swell period s", gauges "Temp c", weather "Snowfall cm", sequoias "Diameter cm"; methane plumes read "Uncertainty 177.6" and "Persistence 0.22"; county anomalies read "Fips 06019" and an unexplained "Warmest rank 60". All fixed (d8ceb7c, f123850, 474c27d).
- **Inside the place** (2 questions). "Navajo Nation" geocoded to Navajo Nation Drive in Flagstaff, 150 km from the mines; it now resolves to the reservation (a2f03ad).
- **On land or at sea, lattice, layer ids.** No failures on this set. Their fixtures hold the owner's past cases: the 4×4 surf forecast grid off Monterey and the phantom layer "climbing<|channel|>commentary".

The 16 questions that failed the full run:

- **What fires are here? (@view)** The model queried fire perimeters and detections and never drew them.
- **Mountain bike trails near Moab** Both queries hit the 10,000 km² limit and the model gave up instead of drawing a smaller area.
- **How deep is Lake Tahoe?** The model queried without geocoding the lake, so the place was never located.
- **How full is Lake Powell right now?** The model queried without geocoding, so the place was never located.
- **How much warmer than normal was Fresno County last month?** The model queried the anomaly and never drew it.
- **Which sequoia groves burned in the 2020 and 2021 fires?** The model never geocoded, and its note ran 162 words.
- **wind farms in West Texas @view** The model queried power plants twice, the second time on a smaller box (its rule forbids both).
- **Show only hard mountain bike trails near Moab** The model filtered on the chip labels ("Hard", "Expert") instead of their values, so nothing was drawn.
- **Which uranium mines near the Navajo Nation score highest?** The note did not name the highest-scoring site (NA-0420).
- **Where are most of the wind farms by capacity in West Texas?** The model drew ranked points instead of hex cells by summed capacity.
- **Show only sport crags at Red River Gorge** The climbing sources returned nothing that minute, so no crag could be drawn.
- **Climbing crags near Red River Gorge** The same wall appeared twice (North 40, Courtesy Wall); fixed in 6d3e939, and on the re-run only Board Wall, two walls of one name 680 m apart, remained.
- **best hiking trails for elevation @view** Two OpenStreetMap viewpoints share a name a few hundred metres apart (Urbo kalnas, Türisalu pank); these look like real separate viewpoints, so the check is strict here.
- **good hiking in French Guiana** Two waterfalls of one name 680 m apart (Saut Grand Continent), likely upper and lower falls; same judgement as above.
- **Any weather warnings around Lake Tahoe?** "Precipitation mm" on the current-conditions card; fixed in 474c27d and passed on the re-run.
- **Recent earthquakes near Mammoth Lakes** 21 of 27 quakes (78%) fell within the town's box grown by 25%; the model searched a wider area than "near".

| Question | ok | Rules | Failed checks | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | yes |  | geocode, osm-trails, render | 55.2 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | yes |  | geocode, geocode, fire-perimeters, render | 39.2 |
| Are there any active fires burning near Missoula right now? | yes | yes |  | geocode, fire-detections, fire-perimeters, render, render | 45.2 |
| Where has the Amazon lost the most forest since 2015? | yes | yes |  | geocode, geocode, forest-loss, render | 41.2 |
| How much snow is on the ground around Mount Hood? | yes | yes |  | geocode, snowpack, snow-cover, render | 55.6 |
| Which rivers near Jackson Hole are running high right now? | yes | yes |  | geocode, streamflow, render | 34.4 |
| Find campsites and forest roads open to vehicles near Moab | yes | yes |  | geocode, campsites, forest-roads, render, render | 23.7 |
| What wildlife has been spotted around Banff this year? | yes | yes |  | species, geocode, species, render | 42.9 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes | yes |  | geocode, osm-trails, outdoor-features, popularity, render, render, render | 83.1 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | yes |  | geocode, public-lands, wilderness, render, render | 34.5 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | yes |  | geocode, night-lights, population, render, render | 34.6 |
| How remote is the Wind River Range? | yes | yes |  | geocode, remoteness, render | 24.8 |
| Show me a walking route from Tahoe City to Emerald Bay | yes | yes |  | route, render | 26.7 |
| Show wildfires near Yosemite year by year since 2016 | yes | yes |  | geocode, geocode, fire-perimeters, render | 26.3 |
| Show only alpine-grade trails near Chamonix | yes | yes |  | geocode, geocode, osm-trails, render | 33.2 |
| Compare forest loss in Rondônia between 2015 and 2025 | yes | yes |  | geocode, forest-loss, compare, render | 51.1 |
| Which sources did you use for snow near Mount Hood? | yes | yes |  | geocode, snowpack, snow-cover, render, render | 25.4 |
| Which campsites around Moab look the most popular? | yes | yes |  | geocode, popularity-campsites, popularity-campsites, campsites, render | 52.7 |
| Outline the Sierra Nevada | yes | yes |  | geocode, physical-regions, render | 37.4 |
| What fires are here? @view | no | no |  | fire-perimeters, fire-detections | 22.6 |
| Any surf here? @view | yes | yes |  | surf, surf | 50.3 |
| best hiking trails for elevation @view | no | yes | duplicates | osm-trails, peaks, outdoor-features, protected-areas-world, render, render | 59.7 |
| Mountain bike trails near Moab | no | no |  | geocode, mtb-trails, mtb-trails | 44.1 |
| Ski touring routes around Chamonix | yes | yes |  | geocode, geocode, ski-routes, render | 27.2 |
| Climbing crags near Red River Gorge | no | yes | duplicates | geocode, geocode, climbing, climbing, render | 29.1 |
| How deep is Lake Tahoe? | no | no |  | lakes, lakes, render | 46.2 |
| Surf at Half Moon Bay today | yes | yes |  | geocode, surf, surf, render, note | 62.6 |
| Is the Carson River running high? | yes | yes |  | geocode, geocode, geocode, streamflow, render | 36.8 |
| Any weather warnings around Lake Tahoe? | no | yes | card | geocode, weather-alerts, render | 38.1 |
| Recent earthquakes near Mammoth Lakes | no | yes | place | geocode, earthquakes, earthquakes, render | 56.4 |
| What rock is Half Dome made of? | yes | yes |  | geocode, geocode, geocode, geocode, geologic-unit, geologic-unit, render | 44.8 |
| Glaciers in the Wind River Range | yes | yes |  | geocode, glaciers, render | 36.1 |
| How green was the Sierra Nevada this month compared to last year? | yes | yes |  | geocode, geocode, greenness, compare, render, render | 89.1 |
| Where are the most iNaturalist or GBIF records of mountain lions in Colorado? | yes | yes |  | geocode, species, species, gbif-occurrences, render, render | 54.2 |
| How full is Lake Powell right now? | no | no |  | reservoir-levels, reservoir-levels, render, note | 31.8 |
| Show dams on the Colorado River by the decade they were built | yes | yes |  | geocode, geocode, geocode, dams, render, dams, render | 73.5 |
| How has Bears Ears National Monument changed since 2021? | yes | yes |  | geocode, monuments, render | 25.2 |
| Where are abandoned uranium mines near the Navajo Nation? | yes | yes |  | geocode, uranium, render | 26.4 |
| How fast is sea level rising at San Francisco? | yes | yes |  | geocode, sea-level-trends, render | 29.9 |
| Show Miami with 3 feet of sea level rise | yes | yes |  | geocode, sea-level-rise, render | 25.5 |
| Where are methane plumes in the Permian Basin? | yes | yes |  | geocode, methane-plumes, render | 47.9 |
| How much warmer than normal was Fresno County last month? | no | no |  | geocode, temperature-anomaly | 20.8 |
| Which sequoia groves burned in the 2020 and 2021 fires? | no | no |  | sequoia-groves, sequoia-mortality, render, render, render | 95.8 |
| Show the Lyell Glacier's retreat | yes | yes |  | geocode, geocode, geocode, glaciers, glaciers, render, set_time | 88.6 |
| great hikes around here @view | yes | yes |  | osm-trails, render | 29.1 |
| deforestation or water rise in this area @view | yes | yes |  | forest-loss, sea-level-rise, render, render | 63.8 |
| good hiking in French Guiana | no | yes | duplicates | geocode, osm-trails, peaks, outdoor-features, protected-areas-world, render, render, render, render | 72 |
| wind farms in West Texas @view | no | no | duplicates | power-plants, render, power-plants, render | 80.5 |
| dams in the Colorado River basin | yes | yes |  | geocode, dams, render | 25.2 |
| How has Bears Ears changed since 2021? | yes | yes |  | geocode, geocode, monuments, render | 21.9 |
| Show only hard mountain bike trails near Moab | no | no |  | geocode, mtb-trails, mtb-trails, render, note | 36.3 |
| Which uranium mines near the Navajo Nation score highest? | no | no |  | geocode, uranium, render | 29.3 |
| Where are most of the wind farms by capacity in West Texas? | no | no |  | geocode, power-plants, render | 23.8 |
| Show only sport crags at Red River Gorge | no | no |  | geocode, geocode, climbing | 31.1 |

Screen checks (`--screens`, 13 questions at 1440×900 and 375×812, replayed at 4bbefa8): **10/13**. The contact sheet is `.superpowers/m3/checks/index.html`.

- **Find campsites and forest roads open to vehicles near Moab** Forest roads (sage dashes) read 28 of 255 along their lines on Topo, under the 32 the check needs; on Topo + Satellite they read 88.
- **Which uranium mines near the Navajo Nation score highest? (phone)** One ranked label ("Section 16 deposit") is cut by the edge of the map.
- **Where are most of the wind farms by capacity in West Texas? (phone)** One ranked label ("Graham") is cut by the edge of the map.

The screen checks found and verified two line fixes: easy and ungraded trails under the difficulty chips had gone back to plain sage (Tahoe read 27 on Topo; 68 with the T1 dashes, 6dc8017), and named hiking routes drew sage instead of the route gradient (14, then 57; 4bbefa8). Calibrated at commit 331355b, the checks also catch the owner's earlier cases: the dev tools badge over the chat placeholder and a layer row 24 px past its panel. A permalink reloads each layer with its default input, so a question that needed a non-default input (surf with `forecast: true`) reopens differently; surf reopened with no buoys in view and no card to open.

Follow-up on 2026-10-16 (review of the contact sheet): the card check also fails a part larger than its whole, the screen checks fail any console error, failed request or Next dev issue, and symbols get the line visibility check. Fixed: trail route cards read like names ("Western American Discovery Trail (California segment 1)", "National trail") and a route wholly in view takes its drawn length as its full length (50.1 km against a 48.1 km tag); picking over 3D terrain no longer logs "Picked non-existent layer"; a shared link asks each layer for no more than it answers (no 422); forest roads draw thin dark grey short dashes (68 of 255 on Topo, 74 on satellite); the campsite card says Campsite or Parking with its facts and website. Re-run live: Lake Tahoe trails and Moab campsites both pass, screens 2/2 with zero console errors.

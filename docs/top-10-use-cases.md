# Top 10 use cases

The ten things WallyMap must do well, locked down so each one can be tested. The owner's mix (2026-10-23): one third
travel, one third environmentalism, one third seeing the physical place ("visuals about rock types, vegetation, water
depth, ecosystems, seasonality, elevations, geology"). This file replaces nothing: `docs/use-cases.md` keeps the 25
broader use cases and their audit; these ten are the ones every release is judged on.

| # | Use case | Third |
|---|---|---|
| T01 | Pick a day hike | Travel |
| T02 | Trip conditions now and this weekend | Travel |
| T03 | Find an activity at my level (bike, climb, paddle, ski) | Travel |
| T04 | Where to camp | Travel |
| T05 | What changed here since a year | Environmentalism |
| T06 | What protects this place and what threatens it | Environmentalism |
| T07 | Wildlife and habitat | Environmentalism |
| T08 | What the ground is made of here | Place |
| T09 | What grows and lives here | Place |
| T10 | How this place changes through the year, and what is under the water | Place |

**Changes from the first list.** The first draft (hike, conditions, mountain biking, climbing, paddling, camping,
backcountry skiing, fire and smoke, wildlife, land change) was replaced by the owner's mix above. Mountain biking,
climbing, paddling and skiing became one use case (T03) with four variants, because they share one decision ("at my
level") and one mechanic (an ordinal chip). Fire and smoke folded into conditions (T02) and change (T05). The audit
(`.superpowers/m3/usecases/AUDIT.md`, `AFTER.md`) gave no reason to drop any of the ten: every one has at least one
free source live today, and the gaps it found (whitewater class, raster totals, invented facts in notes) are now
explicit acceptance tests rather than reasons to cut.

**How it is tested.** Each use case has 5 questions, precise to vague, the fifth asked from a phone with the map on
the place ("here"). The 50 questions and what each must hold are in `scripts/top10.expectations.ts`; the checker is
`scripts/top10Check.ts`; `node --env-file=.env.local --import tsx scripts/eval-model.mts --set --tag top10` runs them
live (`--save <dir>` keeps the runs, `--replay <dir>` re-checks them without calling the model). A question passes
only when the old eval rule passes (place found, layers answered and drawn, note under 150 words, map checks) **and**
every assertion of its expectation passes. The baseline is `.superpowers/m3/top10/BASELINE.md`.

---

## Rules that hold in every use case

These are written once here and asserted for every question.

**Place resolution.** A named place is geocoded once; a natural feature (river, lake, trail, range, pass, forest) is
never answered with a street or a namesake in another state. "Near X" means the radius the layer searches around X
(`lib/agent/places.ts`, about 25 to 50 km). A "here" question uses the view the phone sent and never geocodes.

**Camera.** After the answer, the camera frames the top three features of the main layer (spec §12: the returned
features, not the geocoded region), with room for the panels. A "here" question keeps the person's view. A single
point (a forecast spot, a gauge, a dam) never shrinks the camera to a 1 km box; the place stays in frame.
*Asserted as `camera`.*

**Answer structure (the chat answer, called the note).**
1. The first sentence answers the decision with the deciding numbers ("Three loop hikes under 6 miles reach a
   waterfall near Asheville; the best is Catawba Falls at 3.0 mi round trip with 800 ft of climb."). Never "The map
   shows…". *Asserted as `answerFirst` (a number in the first sentence).*
2. Then the top 3 named options, each with the facts that decide it (length and climb, class and flow, danger and
   aspect). *Asserted as `names` (features that exist in the results) and `facts` (patterns per question).*
3. Then caveats, only when they change the decision (a closure, a source offline, a forecast more than 3 days out).
4. Every number and name comes from this turn's results. *Asserted as `grounded` (the same check the server runs,
   `lib/agent/grounding.ts`).*
5. After the note, exactly 3 follow-up questions, at least 2 naming a feature or the place from this answer ("Is
   Catawba Falls busy on Saturdays?", not "Any other details you need?"). *Asserted as `followUps`.*

**What a follow-up must reuse.** The current place (no new geocode unless a new place is named), the layers on the
map, and the filters and Rank by the person sees; it changes only what it asks about ("only the black ones" changes
the difficulty chip and keeps the place and the other chips). Held in code (`lib/agent/context.ts`: a question that names no place after an answer re-asks its layers on the same place and keeps the filters it does not change; `lib/agent/context.test.ts`); not in the live eval yet (it runs one turn).

**Card actions** (every card): *Ask about this* (asks about the feature with the current layers and filters),
*Preview route* (lines and routes only: trails, roads, rivers), *Copy GeoJSON*, and the map's *Export* (with its
confirm step; nothing downloads without a click). The card never moves the camera.

**Phone first screen** (390 × 844, the chat sheet folded at 34% of the screen, no panel opened): the first sentence of
the answer is readable without scrolling (at most 40 words), the top three features are labelled by name on the
map, and they are in frame. *Asserted as `phone`: first sentence ≤ 40 words with a number, at least 3 labels drawn (or
all of them when fewer, or as many as the layer labels when it labels fewer: a forecast names only the asked place),
top features in frame.* The pixel check (labels legible, lines visible on each basemap) is
`--screens` (`scripts/evalScreens.ts`).

**Basemaps.** Topo + Satellite by default. Topographical (relief and names) for forecasts, paddling, snow, slope and
anything about mountains. Satellite imagery (Topo + Satellite or Satellite) for change, burn scars and crags. Topo or
Data only for colored maps of the ground (geology, land cover, ecoregions, water depth) so the colors read.

**Palette.** Spec §10 and §11 hold: the five approved colors, ramps derived from them, hatching for polygons; raster
tiles may keep their source colors when they are a published standard (avalanche danger scale, drought categories).

---

## Sources verified live today

One call each on 2026-10-23 (no keys printed). "App" means the call went through the app's own layer
(`runLayer`); "direct" means one request to the source.

| Source | Used by | Result |
|---|---|---|
| OpenStreetMap via Overpass | `osm-trails`, `popularity`, `outdoor-features`, `mtb-trails`, `climbing`, `paddling`, `campsites`, `ski-routes`, `peaks`, `lakes` | Live (app: 1,720 Boulder trail ways in 3.7 s; direct 20.7 s) |
| AWS Terrain Tiles (Mapzen terrarium) | `terrain`, climb on trails | Live (direct tile 200) |
| Wikidata, Wikimedia Commons, Wikipedia pageviews | `popularity`, `peaks`, `lakes`, `photos` | Live (direct 200 each) |
| Mapillary (free token) | `popularity` signal | Live (direct 200 with the project token) |
| NWS api.weather.gov (forecast, alerts) | `weather-forecast`, `weather-alerts` | Live (direct 200) |
| Open-Meteo forecast | `weather-forecast` fallback, `wind-flow` | Live |
| NOAA HMS smoke and NDGD smoke forecast | `smoke` | Live (direct; forecast service holds 5,460 polygons) |
| NIFC WFIGS perimeters | `fire-perimeters` | Live (105 current perimeters) |
| NASA FIRMS (free key) | `fire-detections` | Live (app: 84 detections in California, 2 days) |
| EFFIS / GWIS fire weather | `fire-weather` | Live (tile 200) |
| USFS Wildfire Hazard Potential | `fire-hazard` | Live (tile 200 from imagery.geoplatform.gov) |
| USDA NRCS SNOTEL | `snowpack` | Live (app: 9 Utah stations) |
| NASA GIBS (MODIS snow, VIIRS night, HLS imagery, MODIS greenness) | `snow-cover`, `imagery-by-date`, `greenness` | Live (tiles 200) |
| NOAA NOHRSC snow analysis | `snow-cover` depth | Live |
| avalanche.org public map layer | `avalanche` | Live (zones answer; most off season) |
| OpenBeta GraphQL | `climbing` | Live (Red River Gorge areas) |
| USGS Water Data (OGC API, NWIS) | `streamflow` | Live |
| NOAA NWPS river gauges | `streamflow` flood stage and forecast | Live (AVLN7 French Broad) |
| USACE CWMS | `streamflow` dam releases | Live |
| Open-Meteo Flood (GloFAS) | `river-pulse`, `streamflow` outside the US | Live |
| USFS recreation sites (EDW) and BLM recreation sites | `recreation-sites` | Live (52,482 and 1,263 sites) |
| USFS Motor Vehicle Use Map roads | `forest-roads` | Live (150,789 segments) |
| PAD-US 4.1 tiles (project bucket) | `public-lands` | Live (tile 200) |
| Wilderness.net | `wilderness` | Live (app) |
| iNaturalist API | `species` | Live (88,625 research-grade moose) |
| GBIF API (occurrences, maps) | `gbif-occurrences` | Live (269,384 sandhill crane records in March) |
| USFWS critical habitat | `critical-habitat` | Live (803 units) |
| NPS condor range | `condor-range` | Live (app) |
| Global Forest Watch loss tiles | `forest-loss` | Live (tile 200) |
| Earth Engine (project wally-14e22) | `forest-types` today | Live (app made a map); assets listed below |
| GLIMS | `glaciers` | Live |
| BLM national monuments | `monuments` | Live |
| MTBS burn severity | `burn-severity` | Live |
| ESA WorldCover, USGS NLCD | `land-cover` | Live |
| Macrostrat (API and tiles) | `geology`, `geologic-unit` | Live |
| USGS Watershed Boundary Dataset | `river-basins` | Flaky: app call 502, direct call 200 a minute later |
| NOAA Climate at a Glance | `temperature-anomaly` | Live (app) |
| US Drought Monitor (Esri copy) | `drought` | Live |
| USBR RISE, California CDEC | `reservoir-levels` | Live |
| NOAA CO-OPS sea level trends | `sea-level-trends` | The CSV the layer reads first is offline (app: "NOAA could not be reached"); the JSON API answers (direct 200) |
| USGS MRDS and USMIN | `mines` | Live (83 sites near the Grand Canyon, 22.8 s) |
| Navajo AUM and DOE legacy sites | `uranium` | Live (226 sites around the Navajo Nation; none in the Grand Canyon box) |
| EIA / HIFLD pipelines and power lines | `pipelines-lines` | Live |
| Carbon Mapper | `methane-plumes` | Live (175 plumes around the San Juan Basin) |
| WDPA | `protected-areas-world` | Live |
| **BLM mining claims** | `mining-claims` | **The app's host is wrong, not offline.** BLM moved the national claims service to `nlsdbpubgis.blm.gov`; the old `gis.blm.gov/nlsdb` address redirects and the app gets a 400. The new host answers (685 claim cases around Moab). The layer's "offline since 14 October" note is out of date. |

New free sources the curation calls for, each checked once:

| New source | For | How to get it | Result |
|---|---|---|---|
| BLM oil and gas leases (production status) | T06 | `nlsdbpubgis.blm.gov/arcgis/rest/services/Fluid_Minerals/Oil_Gas_Leases_Production_Status/MapServer/0`, keyless ArcGIS | Live (39 leases around Chaco Canyon) |
| USGS Quaternary Fault and Fold Database | T08 faults | `earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer`, keyless | Live |
| USDA soils (SSURGO via Soil Data Access) | T08 soils | `SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest` (SQL over REST), keyless, US | Live |
| ISRIC SoilGrids | T08 soils outside the US | `rest.isric.org/soilgrids/v2.0` | **Not usable today:** timed out after 30 s; OpenLandMap soil texture in Earth Engine is the fallback (asset live) |
| USGS 3DEP elevation (ImageServer, point service) | T08 elevation, profiles | `elevation.nationalmap.gov/.../3DEPElevation/ImageServer`, `epqs.nationalmap.gov/v1/json` | Live |
| EPA ecoregions Level III and IV | T09 | Earth Engine `EPA/Ecoregions/2013/L3` and `L4`, or `geodata.epa.gov/.../USEPA_Ecoregions_Level_III_and_IV/MapServer` | Live (both) |
| RESOLVE ecoregions 2017 (global) | T09 outside the US | Earth Engine `RESOLVE/ECOREGIONS/2017` | Live |
| LANDFIRE existing vegetation type | T09 | Earth Engine `LANDFIRE/Vegetation/EVT/v1_4_0` (the USGS image service guessed first was not found) | Live |
| Meta and WRI canopy height (1 m) | T09 | Earth Engine `projects/meta-forest-monitoring-okw37/assets/CanopyHeight` | Live |
| Dynamic World (10 m, near real time) | T05, T09 | Earth Engine `GOOGLE/DYNAMICWORLD/V1` | Live |
| Hansen forest change v1.13 (numbers, not just tiles) | T05 | Earth Engine `UMD/hansen/global_forest_change_2025_v1_13` | Live |
| Drivers of forest loss v1.3 | T05 | Earth Engine `projects/landandcarbon/assets/wri_gdm_drivers_forest_loss_1km/v1_3_2001_2025` | Live |
| MODIS land surface phenology (green-up dates) | T10 | Earth Engine `MODIS/061/MCD12Q2` | Live |
| ERA5-Land monthly, TerraClimate | T10 climate strip | Earth Engine `ECMWF/ERA5_LAND/MONTHLY_AGGR`, `IDAHO_EPSCOR/TERRACLIMATE` | Live |
| NOAA 1991–2020 monthly normals (stations) | T10 climate strip, US | `ncei.noaa.gov/access/services/data/v1?dataset=normals-monthly-1991-2020` | Live |
| Open-Meteo historical weather | T10 climate strip anywhere | `archive-api.open-meteo.com/v1/archive` (CC BY 4.0, non-commercial) | Live |
| Open-Meteo air quality (PM2.5 forecast) | T02 smoke at a place | `air-quality-api.open-meteo.com/v1/air-quality`, keyless | Live |
| USA National Phenology Network | T10 | already the `phenology` layer's host | Live |
| JRC monthly water history | T10 lake levels by month | Earth Engine `JRC/GSW1_4/MonthlyHistory` | Live |
| NOAA NCEI DEM global mosaic (bathymetry) | T10 depth | `gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer` | Live |
| GEBCO grid (ocean depth) | T10 depth offshore | `wms.gebco.net` WMS (not in Earth Engine's community catalog under the paths tried; ETOPO1 is, `NOAA/NGDC/ETOPO1`) | Live (WMS) |
| Recreation.gov RIDB | T04 season dates, facilities | `ridb.recreation.gov/api/v1`, free key | Live (401 without a key, as expected); needs the owner to register a free key |
| American Whitewater | T03 class and runnable range | — | **Do not use** until its terms allow it (no open licence); site answers |

Earth Engine use stays on the free noncommercial tier (150 compute-hours a month, spec §14 and the Google Earth
research note); yearly products should be precomputed to tiles when traffic grows.

---

## T01. Pick a day hike

**Person and decision.** A visitor or local with a free morning picks one trail: right length and climb, right
difficulty, a payoff (waterfall, viewpoint, summit), a loop or out-and-back, near where they are.

**Questions.**
1. Loop hikes under 6 miles with a waterfall near Asheville, under 1,500 ft of climb
2. Out-and-back hikes to a viewpoint near Boulder, 3 to 6 miles round trip
3. Good day hikes near Bend
4. An easy hike with a view near Lake Tahoe
5. *(phone, map on the Columbia River Gorge)* Any good hikes around here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Whole hikes with round trip, shape (loop, out-and-back) and climb | `osm-trails` named hikes (ways merged by name, `layers/_shared/hikes.ts`; climb from AWS Terrain Tiles) | `popularity` (merged named trails with `leadsTo`) | Months / live, cached a day | Global; OpenStreetMap quality; 92% of US ways have no difficulty (`sac_scale`) |
| Payoff: waterfall, viewpoint, summit | `outdoor-features` (kinds waterfall, viewpoint), joined with `combine` near (within 0.5 km of the trail) | `peaks` for summits | Years / live | Global |
| Busy or quiet | `popularity` (Wikipedia views, Commons photos, Mapillary, parking) | none | Weeks / computed per query | Estimate, not a count; say so |
| Difficulty | `sac_scale` (T1 to T6) where mapped, else climb per km | — | — | Mostly unrated in the US: the note says how many are unrated |

Licence line: "Trails, waterfalls and viewpoints © OpenStreetMap contributors (ODbL); climb from AWS Terrain Tiles
(USGS 3DEP, SRTM); popularity is an estimate from Wikipedia, Wikimedia Commons and Mapillary."

**Do not use:** raw OpenStreetMap ways as hikes (a 30-mile trail split into ten pieces; the audit's Boulder failure);
way length (`lengthKm` of a segment) as the hike's length; `photos` file titles as place names; `sac_scale` "not
rated" read as easy.

**Map operations.**
- Place: the town or park; "near" uses the hiking radius (about 25 km).
- Camera: the top 3 ranked hikes.
- Basemap: Topo + Satellite (Topographical acceptable).
- Layers, bottom to top: hikes (ranked), the joined hikes (when a payoff is asked), waterfalls or viewpoints as
  symbols on top.
- Combine: `near` (outdoor-features within 0.5 km of a hike) when the question names a payoff.
- Hidden by default: tracks and footways under 0.5 km, unnamed ways, roads.

**Filters.**
- Default chips: Shape (Loop, Out and back); Rank by: Round trip for "short"/"under", Climb for "big climb",
  Popularity for "good" or "best".
- Row: Shape chips, Round trip presets (Short under 5 km, Half day 5 to 12 km, Long over 12 km), Difficulty chips.
  More: climb per km, surface, kind.
- Values that must exist: `roundTripKm`, `gainM` (climb, round trip for loops), `shape` (loop, out-and-back), `name`.
- Remove from this decision: Surface, Kind (path, footway, track), Visibility.
- "under 6 miles" sets `roundTripKm` ≤ 9.66; "under 1,500 ft" sets climb ≤ 457 m; "loop" sets Shape = Loop.

**Visualization.**
- Hikes: lines on the difficulty ramp (sage → pink → purple), unrated sage, the selected hike purple; line width by
  the Rank by measure in the ranked view.
- Payoff: waterfall and viewpoint symbols (monochrome shapes), labelled by name.
- Legend: "Difficulty (SAC hiking scale)" with its classes and "Not rated", and "Wider = longer round trip" (or
  "busier" when ranked by popularity).
- Labels: the top 5 hikes by Rank by, as "Name · 3.0 mi" ; up to 8 feature names.
- View: ranked; no time mechanic.
- Desktop: the layer row lists the top 10 with round trip and climb; the card opens on click.
- Phone first screen: the answer sentence, the top 3 hike names on the map, the waterfall symbols.

**Dialog box.**
- Answer: "Three loops under 6 miles reach a waterfall near Asheville: Catawba Falls (3.0 mi, 800 ft), … ." Then a
  list of the top 3 with round trip, climb, shape and the payoff; a caveat only if most are unrated or a trail is
  closed.
- Card (`osm-trails`): Length, Shape, Round trip, Climb (round trip), Highest point, Difficulty, Kind; for
  `popularity`: Popularity score, Leads to, Length in view, Climb.
- Follow-ups reuse the place and the hike layer: "Is Catawba Falls busy on Saturdays?", "Show only loops under 4
  miles", "Any of these with a summit view?".

**Acceptance tests.** (`scripts/top10.expectations.ts`, T01.1 to T01.5)
- T01.1: `osm-trails` or `popularity`, `outdoor-features` (input kinds includes waterfall) and a `near` join answered
  and drawn; filters Round trip ≤ 9.66 km, Shape = Loop, Climb ≤ 457 m; view ranked; Topo or Topo + Satellite; ≥ 3
  labels; card Length, Shape, Round trip, Climb round trip, Difficulty in that order; note gives miles, feet and
  the waterfall; names ≥ 3 returned hikes.
- T01.2: as T01.1 with viewpoint, Round trip 4.8 to 9.66 km, Shape = Out and back.
- T01.3: hikes answered; Round trip between 3 and 25 km; view ranked; legend "Difficulty"; note gives miles and
  feet; names ≥ 3.
- T01.4: hikes and `outdoor-features`; an easy filter (round trip, climb or difficulty); miles and the view; names ≥ 2.
- T01.5: hikes in the view without a geocode; ranked; miles and feet; names ≥ 3.

---

## T02. Trip conditions now and this weekend

**Person and decision.** Someone with a trip planned decides whether to go, when, and what to pack: forecast,
warnings, snow on the ground, smoke, fire nearby, closures, avalanche danger in season.

**Questions.**
1. Forecast for Paradise on Mount Rainier this Saturday and Sunday: high, low, chance of rain and wind
2. Any weather alerts, smoke or fires near Yosemite Valley right now?
3. Is there snow on the ground at Lake Tahoe right now, and any avalanche danger?
4. What's Moab going to be like this weekend?
5. *(phone, map on Bishop and the Eastern Sierra)* Conditions here this weekend?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Forecast by day and hour (high, low, rain chance, wind, gusts) | `weather-forecast` from NWS gridpoints | Open-Meteo (same layer, outside the US) | Hours / issued every 1 to 6 hours | US (NWS), global (Open-Meteo) |
| Warnings and watches | `weather-alerts` (NWS) | — | Minutes / live | US only for alerts |
| Smoke now and tomorrow | `smoke` (HMS observed; NDGD near-surface forecast) | **New:** Open-Meteo air quality PM2.5 forecast at the point | Hours / daily | North America |
| Fire nearby | `fire-perimeters` (status, containment), `fire-detections` (last 1 to 3 days) | — | Hours / live | US perimeters; global detections |
| Snow on the ground | `snowpack` (SNOTEL depth, hourly), `snow-cover` (MODIS newest clear day) | NOHRSC depth (same layer) | Days / hourly and daily | SNOTEL western US |
| Avalanche danger (in season) | `avalanche` (avalanche.org, each center's rating) | none; never inferred from weather | Daily / daily in season | US centers; "No rating" off season |
| Closures | `recreation-sites` status (open or closed) | the agency page, linked | Days / nightly | USFS and BLM sites only; NPS road status not in the app |

Licence line: "Forecast and alerts: NOAA National Weather Service (public domain); Open-Meteo (CC BY 4.0); smoke:
NOAA HMS and NDGD; fires: NIFC WFIGS and NASA FIRMS; snow: USDA NRCS SNOTEL, NASA MODIS; avalanche ratings by
each US avalanche center via avalanche.org."

**Do not use:** `wind-flow` particles for "how windy at the place" (it reads the windiest node in view, the audit's
Joshua Tree failure); `weather-alerts` alone as a forecast ("no alerts" is not "no rain"); `fire-weather` (European
index) as fire nearby; `snow-cover` on a cloudy day presented as snow-free; `greenness` for anything about now.

**Map operations.**
- Place: the named spot (Paradise, not Mount Rainier's summit); the forecast point is the place found, not the box's
  middle.
- Camera: the place with its surroundings (at least ~20 km); a forecast point never frames a 1 km box.
- Basemap: Topographical (relief and names).
- Layers, bottom to top: alerts polygons, smoke, fire perimeters, detections, snow, the forecast point on top.
- Hidden by default: alerts that are marine or expired; detections older than 3 days.

**Filters.**
- Default chips: none on the forecast; alerts by Severity; fires by Status (Still burning first).
- Row: the forecast's day chips (Today, Tomorrow, Saturday, Sunday); More: hourly measures.
- Values that must exist: the forecast's `tempF`, `precipChance`, `windMph`, `gustMph` and per-day lines; alerts'
  `severity`, `event`, end time; perimeters' `status`, `acres`, containment.
- Remove from this decision: satellite and pass of detections, alert urgency and certainty.

**Visualization.**
- Forecast: the point colored by temperature at the hour shown; a linked hourly curve (temperature line, rain chance
  bars, wind) under the scrubber, playhead on the asked day.
- Alerts: polygons by severity (dark grey outline, pink tint for severe and extreme); smoke by density (off-white to
  dark grey hatch, "Very heavy" darkest); fires pink with pink hatch; detections pink symbols.
- Legend wording: "Temperature at the hour shown", "Alert severity", "Smoke near the ground", "Fire status".
- Labels: the forecast point by the place's name; fires by name and acres (top 5); alerts by event (top 5).
- View: timeline on the forecast's days (hourly); the time panel opens for this weekend's questions.
- Phone first screen: the answer sentence ("Saturday 48 °F, 60% rain; Sunday 52 °F, dry"), the place labelled, any
  alert outline visible.

**Dialog box.**
- Answer: "Saturday at Paradise: high 41 °F, low 33 °F, 80% chance of rain and snow, wind 12 mph gusting 25; Sunday
  drier, …". Then alerts, smoke and fires each in one line or "none"; a caveat only if an alert is up or the
  forecast is more than 3 days out.
- Cards: forecast (Temperature, Chance of rain or snow, Wind, Gusts, Today, Tomorrow, Saturday, Sunday, Forecast
  issued); alert (Severity, Until in local time, What to do); fire (Acres burned, Status, Contained, Perimeter last
  mapped); SNOTEL (Snow depth, Snow water equivalent, Percent of normal, New in 24 h, Reading); avalanche (Danger,
  Above, Near and Below treeline, Avalanche problems, Issued, Avalanche center).
- Follow-ups reuse the place and the days: "Hourly wind at Paradise on Saturday?", "Is Sunrise drier on Sunday?",
  "Any trail closures at Paradise?".

**Acceptance tests.**
- T02.1: `weather-forecast` answered and drawn; Topographical; 1 label; card Temperature, Chance of rain or snow,
  Wind, Saturday, Sunday in order; note says Saturday and Sunday with °F, a percent and mph.
- T02.2: `weather-alerts`, `smoke`, and `fire-perimeters` or `fire-detections` answered; time panel open when anything
  dated is drawn (with no fire or alert there is nothing to open it on); note
  speaks to alerts, smoke and fire (each a fact or "none").
- T02.3: snow (`snowpack` or `snow-cover`), `snowpack` and `avalanche` answered; ≥ 3 labels; card Snow depth, Snow
  water equivalent, Percent of normal, Reading; legend "Compared with normal"; note gives inches, the reading date and
  the avalanche rating or "no rating"; names ≥ 2 stations.
- T02.4: forecast; Saturday, Sunday and °F. Needs closures beside the forecast.
- T02.5: forecast and alerts in the view; Saturday, Sunday, °F and alerts.

---

## T03. Find an activity at my level

**Person and decision.** Someone picks where to ride, climb, paddle or ski at their skill, with the condition that
makes it go (dry, shaded, enough water, safe snow). One use case with four variants that share one control: an
ordinal chip set for the level.

**Questions.**
1. Intermediate blue mountain bike trails near Bentonville *(bike)*
2. Sport crags near Red River Gorge with 5.10 to 5.11 routes that are shaded in the afternoon *(climb)*
3. Class III whitewater near Asheville with enough water this weekend *(paddle)*
4. Low-angle ski terrain under 30 degrees near Teton Pass, and today's avalanche danger *(ski)*
5. *(phone, map on Sedona)* Easy bike trails here

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Bike trail difficulty | `mtb-trails` (IMBA color, Singletrack Scale) | — | Months / live | OpenStreetMap; grade coverage varies by town |
| Crags: style, grade band, route count | `climbing` (OpenBeta routes merged with OpenStreetMap) | OSM only when OpenBeta fails (the layer says so) | Months / live | OpenBeta US-heavy |
| Shade and aspect | `climbing` aspect and afternoon shade (from terrain), `terrain` shade mode | — | Static | 10 m US, 30 m elsewhere; short cliffs can be wrong |
| Whitewater class and sections | `paddling` (OpenStreetMap `whitewater:section_grade`) | none free | Years | **US sections rarely carry a class** (0 of 149 near Asheville in the audit) |
| Flow now, flood stage, forecast | `streamflow` (USGS live, NWS NWPS stage and forecast, USACE releases) | `river-pulse` (GloFAS model) | Hours / 15 minutes | US gauges; runnable ranges not in any free source |
| Slope angle and aspect | `terrain` slope mode (AWS Terrain Tiles) | Earth Engine 3DEP 10 m | Static | — |
| Avalanche danger | `avalanche` | none | Daily in season | US centers |
| Ski routes | `ski-routes` (OSM ski touring) | — | Years | Sparse in the US |

Licence line: per variant, e.g. "Trails © OpenStreetMap contributors (ODbL)"; "Crags: OpenStreetMap and OpenBeta";
"Flow: USGS (public domain), NOAA NWPS"; "Slope from AWS Terrain Tiles (USGS 3DEP, SRTM); avalanche ratings by
the Bridger-Teton Avalanche Center via avalanche.org."

**Do not use:** flow "normal for the date" as "runnable" (the audit's Gauley and Colorado failures); American
Whitewater data (no open licence); `wind-flow` for "too windy at the crag"; OSM `sac_scale` for bike difficulty;
weather to infer avalanche danger.

**Map operations.**
- Place: the town or area; rivers geocode as "<name> River".
- Camera: the top 3 by Rank by (crags, sections) or the filtered trails.
- Basemap: Topo + Satellite for bike trails and crags (rock and forest visible); Topographical for rivers and ski
  terrain.
- Layers, bottom to top: slope or shade tiles (ski, climbing shade), sections or trails, gauges, crags, avalanche
  zones' outline on top (fill under the terrain).
- Terrain operations: slope classes for ski terrain (under 25° clear, 25 to 30, 30 to 35 and 35 to 45 in the
  avalanche band, over 45); shade in the afternoon for crags; a join of ski routes kept where slope stays under 30°
  (not available yet: a raster join).
- Hidden by default: unrated trails when a level is asked (counted in the note); gyms; paddling hazards and portages
  unless asked.

**Filters.**
- Default chips: Difficulty (IMBA color: Green, Blue, Black, Double black); Discipline (Sport, Trad, Boulder) and
  Grade band per style (Beginner 5.0–5.9, Intermediate 5.10–5.11, Advanced 5.12–5.13, Elite); Whitewater class (I to
  VI); slope class.
- Rank by: route count (crags), flow (gauges), length (trails).
- Row: the level chips and one flag (Afternoon shade, Runnable now). More: source, kind, fee, lit.
- Values that must exist: `mtb-trails.v` (IMBA level), `climbing.sportBands`, `afternoonShade`, `aspect`,
  `paddling.v` (class), `streamflow.v` (cfs), `avalanche.danger`.
- Remove: OSM kind (path, footway), Singletrack S-numbers as chips (they stay on the card), source.

**Visualization.**
- Bike: lines on the IMBA difficulty ramp; the picked level at full strength, others at 35%.
- Climb: crag symbols sized by route count, shaded crags marked by a filled symbol, sunny hollow; slope or shade
  tiles under them.
- Paddle: sections on the class ramp; gauges as symbols colored by flow against normal and labelled with cfs.
- Ski: slope classes (pink band for 30 to 45°), avalanche zones in the North American danger scale colors with its
  legend.
- Legend wording: "Difficulty (IMBA color)", "Routes", "Whitewater class", "Avalanche danger today (North American
  scale)", "Slope angle".
- Labels: top 5 to 8 names with the deciding number ("Slaughter Pen · 3.2 mi", "Military Wall · 41 sport").
- View: ranked for crags and gauges; detail for one zone; the time panel only for "this weekend" (the forecast days).
- Phone first screen: answer sentence, top 3 named, the chips row closed but the level visible in the legend key.

**Dialog box.**
- Answer: "212 blue trails near Bentonville; the longest are Slaughter Pen (3.2 mi), …" / "4 sport crags with 5.10
  to 5.11 routes get afternoon shade: …" / "No Class III section near Asheville has a mapped class; the French Broad at
  … runs 1,250 cfs …".
- Cards: `mtb-trails` IMBA color, Singletrack Scale, Length, Bikes; `climbing` Routes, Grades, Sport, Grade bands,
  Faces, Afternoon shade; `paddling` Whitewater class, Kind, River; `streamflow` Flow, Running, Flow vs the date's
  median, Flood stage; `avalanche` Danger, by elevation band, Issued, Avalanche center.
- Follow-ups reuse the place and the level chip: "Only the black ones near Bentonville?", "Which of these crags get
  morning sun?", "Is the Nantahala running on Sunday?".

**Acceptance tests.**
- T03.1: `mtb-trails`; filter Difficulty = Blue (or Intermediate); ≥ 3 labels; legend "Difficulty"; card IMBA color,
  Length; note gives miles and how many blue trails; names ≥ 3.
- T03.2: `climbing`; filters Sport, Intermediate band, afternoon shade (or aspect); view ranked; Topo + Satellite or
  Satellite; card Routes, Grades, Sport, Afternoon shade; note gives route counts, 5.10/5.11 and shade; names ≥ 3.
- T03.3: `paddling` and `streamflow`; filter Class III; legend "Class"; note gives cfs, the class, a
  runnable verdict against a range, and the weekend; names ≥ 2. Needs class on US sections, runnable ranges, a
  weekend flow forecast.
- T03.4: `terrain` (mode slope) and `avalanche`; legend "Avalanche danger"; card Danger, Avalanche center (in season
  also Above, Near and Below treeline and Issued); note gives the slope angle and the rating or "no rating".
- T03.5: `mtb-trails` in the view; filter Green (or Beginner); miles; names ≥ 3.

---

## T04. Where to camp

**Person and decision.** A camper picks a legal place to sleep tonight or this weekend: a campground that is open,
free dispersed camping reachable in their vehicle, or a backcountry camp near water along a route.

**Questions.**
1. Free dispersed camping on national forest land near Flagstaff that a passenger car can reach
2. Which campgrounds near Lake Tahoe are open now?
3. Campsites near water along the Wonderland Trail
4. Camping near Moab
5. *(phone, map on Leadville)* Where can I camp around here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Developed campgrounds, open or closed | `recreation-sites` (USFS EDW, BLM) | **New:** Recreation.gov RIDB (season dates, sites, reservable; free key) | Days / nightly | USFS and BLM; NPS campgrounds missing |
| Camps from OpenStreetMap (incl. backcountry, free) | `campsites` with `includeParking: false` | — | Months / live | Global |
| Legal dispersed camping | `forest-roads` (MVUM: open roads, camping rule on the card) and `public-lands` (who manages) | — | Season / yearly | US national forests and BLM; closure orders only where bundled |
| Reachable by car | `forest-roads` maintenance level (3 to 5 passenger car; 2 high clearance) | — | Yearly | — |
| Along a route, near water | `combine` along (camps within 1 km of the trail), then near water (`lakes`, `outdoor-features` springs) | — | — | The second join (water) not done today |

Licence line: "Campgrounds: USDA Forest Service and BLM (public domain); camps © OpenStreetMap contributors (ODbL);
roads: USFS Motor Vehicle Use Map; land: USGS PAD-US 4.1."

**Do not use:** parking lots as campsites (`includeParking: true`, the audit's Wind Rivers failure); `passengerCar`
as "a car can drive it" (it is legal access, not suitability; level 3+ is the suitability); OSM `fee` missing read as
free.

**Map operations.**
- Place: the town, lake or trail (a trail geocodes to its OSM route).
- Camera: the top camps; for "along", the whole route.
- Basemap: Topo + Satellite.
- Layers, bottom to top: public land (tint by manager), roads (by level), the route, camps on top.
- Combine: `along` for a named route; `within` public land for dispersed.
- Hidden by default: parking lots, RV parks unless asked, closed sites when "open now" is asked (counted).

**Filters.**
- Default chips: Kind (Campgrounds), Status (Open), Fee (Free) when asked, Maintenance level (Passenger car).
- Rank by: capacity, or distance along the route.
- Row: Status and Kind chips; More: reservable, tents, RVs, district.
- Values that must exist: `recreation-sites.status`, `kind`; `campsites.feeStatus`, `backcountry`; `forest-roads.level`
  and the camping rule.
- Remove: capacity as a chip, operator, parking lots.

**Visualization.**
- Public land: sage tint by manager (hatching for wilderness); roads: sage dashes, passenger-car levels darker; the
  route: the purple → pink gradient; camps: triangle symbols (filled when open, hollow when closed).
- Legend wording: "Kind", "Open now", "Maintenance level: Passenger car / High clearance", "Managed by".
- Labels: top 6 camps by name; roads by number for dispersed questions.
- View: detail or ranked; no time.
- Phone first screen: answer sentence ("7 campgrounds near Lake Tahoe are open: …"), camps labelled.

**Dialog box.**
- Answer: "Dispersed camping is allowed on the Coconino National Forest off passenger-car roads FR 245 and FR 535, …".
  Then the top 3 with access, fee and status; a caveat when a closure order applies.
- Cards: `recreation-sites` Type, Managed by, Status, Reservable; `campsites` Type, Fee, Tents allowed, Backcountry;
  `forest-roads` Maintenance level, Camping rule here, Open to passenger cars by law, Ranger district.
- Follow-ups reuse the place and chips: "Which of these take reservations?", "Any free ones within 10 miles?",
  "Is FR 245 paved?".

**Acceptance tests.**
- T04.1: `forest-roads` and `public-lands`; filter level Passenger car; ≥ 3 labels; legend "Maintenance level"; card
  Maintenance level, Camping rule here, Open to passenger cars by law; note says where dispersed camping is legal
  and names roads; names ≥ 2.
- T04.2: `recreation-sites`; filters Campgrounds and Open; legend "Kind"; card Type, Managed by, Status, Reservable;
  note gives how many are open; names ≥ 3.
- T04.3: `osm-trails`, `campsites` (`includeParking` false) and an `along` join; card Type, Fee; note gives how
  many camps, the permit rule and water; names ≥ 3. Needs the water join.
- T04.4: camps and `public-lands`; count and the BLM designated-sites rule; names ≥ 3.
- T04.5: camps and roads or public land in the view; count and the manager.

---

## T05. What changed here since a year

**Person and decision.** A researcher, reporter or resident finds out how much a place changed and why: forest lost
and to what, forest converted to plantations, glaciers shrunk, burn scars, a monument cut.

**Questions.**
1. How much forest did Pará lose since 2017 and what drove it?
2. How much have the glaciers in Glacier National Park shrunk since the 1960s?
3. How has Bears Ears changed since 2021?
4. Burn scars around Paradise, California since 2018
5. *(phone, map on the Santiam Canyon, Oregon)* What changed here since 2015?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Forest loss by year, with hectares | **New:** Hansen v1.13 through Earth Engine (sums in a polygon) | `forest-loss` GFW tiles (picture only) | Yearly / 2025 loss | Global 30 m |
| What drove it | **New:** Drivers of forest loss v1.3 (Earth Engine, 1 km, 7 classes) | `forest-types` converted since a year | Yearly | Global; dominant driver per cell, not per year |
| Forest type and conversion | `forest-types` (ForTy via Earth Engine) | — | 2020 baseline, beta yearly 2017–2025 | Global |
| Glaciers then and now | `glaciers` (GLIMS surveys) | — | Survey dates | Global; survey years vary |
| Burn scars | `fire-perimeters` (10+ years), `burn-severity` (MTBS) | `imagery-by-date` before/after | Yearly, MTBS ~18 months behind | US |
| Monument boundaries | `monuments` (2021 and current) | — | Current | US BLM |
| Land cover now vs then | **New:** Dynamic World (Earth Engine) | `land-cover` (WorldCover 2021, NLCD years) | Days | Global |

Licence line: "Tree cover loss: Hansen/UMD/Google/USGS/NASA (CC BY 4.0); drivers: WRI and Google DeepMind (CC BY
4.0); forest types: ForTy (CC BY 4.0); glaciers: GLIMS (NSIDC); fires: NIFC, MTBS (public domain)."

**Do not use:** a picture tile described as a number ("lots of loss"); the model's own knowledge of drivers ("cattle
ranching" with no driver source, the audit's Pará failure); `greenness` as fall color or as change; a glacier
"top five" mixing survey years.

**Map operations.**
- Place: the state, park, monument or town; a region uses its outline.
- Camera: the union of both sides of the change (both outlines, both surveys).
- Basemap: Topo + Satellite or Satellite (the change is seen on the ground).
- Layers: the change layer alone, or loss over forest types; perimeters by year over burn severity.
- Operations: the change view (compare by version or date); a total inside a polygon (hectares, km²) from Earth
  Engine for raster layers.
- Hidden by default: unchanged features faded; loss before the asked year.

**Filters.**
- Default chips: the two dates (A and B) in the compare strip; Driver chips for forest loss; Status for fires.
- Rank by: area lost (glaciers, monuments), acres (fires).
- Row: the compare strip (delta, swipe, toggle); More: canopy threshold, survey.
- Values that must exist: loss year; glacier `areaKm2` per survey and `lostPct`; monument `boundary`; fire `year`,
  `acres`.
- Remove: GLIMS ids, map scale codes.

**Visualization.**
- Change view (spec §12): lost pink hatch, gained purple, unchanged dark grey; tiles swipe between dates.
- Forest loss: pink by year (lighter older) with drivers as hatch patterns; burn severity low/moderate/high on the
  sage → pink ramp.
- Legend wording: "Ice lost since the 1960s", "Lost since 2021", "Tree cover lost 2017–2025, by driver".
- Labels: the 5 largest losses by name with the number.
- Time: the compare strip open with both dates; a timeline (loss per year bars) for "since a year".
- Phone first screen: answer sentence with both values and the difference; the change visible.

**Dialog box.**
- Answer: "Glacier National Park's glaciers covered 32.7 km² in 1966 and 19 km² in 2015, 42% less; Grinnell lost
  …". Then the top 3 with then and now; caveat when survey years differ.
- Cards: `glaciers` Area, Survey, Ice lost since the first survey, Area in the first survey; `monuments` Area,
  Boundary, Designation; `fire-perimeters` Acres burned, Status, Year; forest loss (Earth Engine point): loss year,
  driver, forest type before.
- Follow-ups reuse the place and the dates: "Which glacier lost the most?", "Show Grinnell Glacier's surveys", "What
  replaced the forest near Novo Progresso?".

**Acceptance tests.**
- T05.1: `forest-loss` answered with startYear 2017; time panel open; legend "Tree cover loss"; note gives hectares
  or km², the driver or that the app cannot say, and 2017. Needs Earth Engine totals and drivers.
- T05.2: `glaciers` in the change view with a compare open; Topo + Satellite or Satellite; ≥ 3 labels; card Area,
  Survey, Ice lost, Area in the first survey; note gives km², the percent and both survey years; names ≥ 1.
- T05.3: `monuments` in the change view with a compare; card Area, Boundary, Designation; legend about the boundary;
  note gives areas, the difference and 2021.
- T05.4: `fire-perimeters` and `burn-severity`; timeline or ranked; legend "Status"; card Acres burned, Status, Year;
  note gives acres, the Camp Fire or 2018, and severity; names ≥ 2.
- T05.5: a change layer in the view; note gives an area and a year. Needs one change summary across layers.

---

## T06. What protects this place and what threatens it

**Person and decision.** A conservationist, reporter or visitor learns who manages a place and how strongly it is
protected, and what pressures it faces nearby: mining claims and mines, uranium, oil and gas, pipelines, fire hazard,
development.

**Questions.**
1. What protects Grand Staircase-Escalante, and are there mining claims, mines or pipelines inside or near it?
2. Uranium mines near the Grand Canyon
3. Is Chaco Canyon threatened by oil and gas?
4. What threatens the Boundary Waters?
5. *(phone, map on the Owyhee Canyonlands)* Who manages this land and is it protected?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Who manages, how protected | `public-lands` (PAD-US manager, access), `wilderness`, `monuments`, `protected-areas-world` (IUCN) | — | Yearly / static 4.1 | US; WDPA global (non-commercial terms) |
| Mining claims | `mining-claims` (BLM MLRS) | Nevada and Alaska state copies (in the layer) | Weeks / daily | Read from BLM's new host `nlsdbpubgis.blm.gov` since 2026-10-23 |
| Mines and prospects | `mines` (USGS MRDS, USMIN; commodity chips) | — | Static (~2011) | US |
| Uranium legacy sites | `uranium` (Navajo AUM, DOE) | `mines` with commodity Uranium | Static | Navajo Nation and DOE sites; **not the Grand Canyon's mines** |
| Oil and gas | `mineral-leases` (BLM oil and gas leases with production status; coal and other mineral leases too) | `methane-plumes`, `pipelines-lines` | Weeks | Federal minerals only; wells need state records |
| Pipelines and power lines | `pipelines-lines` (EIA, HIFLD) | — | Yearly | US |
| Fire hazard | `fire-hazard` (USFS WHP 2023) | `fire-weather` for this week | Static | US |
| Development | `land-cover` NLCD developed classes | Dynamic World built class | Years | US (NLCD) |

Licence line: "Land status: USGS PAD-US (public domain); claims and leases: BLM (public domain); mines: USGS MRDS;
uranium: Navajo Nation EPA and US EPA screening, DOE; pipelines: EIA/HIFLD; methane: Data by Carbon Mapper
(non-commercial)."

**Do not use:** `mining-claims` "offline since 14 October" as a final answer (the source moved, see above); uranium
hazard scores outside the Navajo Nation (they do not exist there); WDPA for US management (PAD-US is the source of
record); methane plumes as proof of a lease.

**Map operations.**
- Place: the monument, park or wilderness outline (not its town).
- Camera: the protected outline plus a buffer (10 miles for Chaco's withdrawal).
- Basemap: Topo + Satellite.
- Layers, bottom to top: land manager tint, protected outlines (hatched), threats as symbols and lines on top.
- Combine: `within` and `near` (threats inside the outline, and within N miles of it), with counts.
- Hidden by default: closed claims, plugged leases, power lines under 100 kV.

**Filters.**
- Default chips: threat Kind (Claims, Mines, Leases, Pipelines); Status (Active); Commodity for mines.
- Rank by: claims per area, production status, hazard score.
- Row: Kind and Status chips; More: commodity, claim type, operator.
- Values that must exist: PAD-US `agency`, `designation`, `access`; claim status; mine `commodity` and `status`.
- Remove: case numbers as chips, survey squares.

**Visualization.**
- Protection: sage tint by manager, hatch density by protection level (wilderness densest).
- Threats: monochrome symbols by kind (claims dark grey squares sized by count, mines diamonds, leases pink outline,
  pipelines dark grey lines dashed by kind), inside the outline at full strength, outside faded.
- Legend wording: "Managed by", "Inside the monument / within 10 miles", "Active mining claims".
- Labels: the protected area's name; top 5 threats by size.
- View: detail of the place; ranked threats.
- Phone first screen: the answer sentence with the counts inside and near; the outline labelled.

**Dialog box.**
- Answer: "Grand Staircase-Escalante is a BLM national monument (1.87 million acres); 12 mine sites and 3 pipelines
  lie within 10 miles, none inside." Then the top 3 threats with distance; caveat when a source is down.
- Cards: `monuments` Area, Boundary, Designation; `mines` Status when last recorded, Commodities; `uranium` Hazard score,
  Kind, EPA cleanup step; `public-lands` Managed by, Designation, Public access; lease: status, operator, acres.
- Follow-ups reuse the place and the threat chips: "Which of these mines produced uranium?", "Any active leases
  within 5 miles?", "Show the 2021 boundary too".

**Acceptance tests.**
- T06.1: `monuments`, `mines` or `mining-claims`, `pipelines-lines`; card Area, Boundary, Designation; note names the
  protection, counts mines or claims, and says pipelines. Claims everywhere (host moved, 2026-10-23) and
  `mineral-leases` are in; the near join is the `combine` tool against the monument.
- T06.2: `mines` or `uranium`; filter commodity Uranium; ≥ 3 labels; card Status, Commodities; note counts uranium
  sites with their status; names ≥ 2.
- T06.3: `mineral-leases`, `pipelines-lines` or `methane-plumes`; ≥ 3 labels; note gives a lease, pipeline or plume
  count (or a rate) and a distance; names ≥ 2. Leases are the direct answer to "oil and gas" since 2026-10-23 (BLM
  leases with production status, 40 in force around Chaco, 36 producing); wells still need state records.
- T06.4: a threat layer (`mineral-leases` holds Minnesota's federal hardrock leases); numbers and the named threat.
  Needs a near join (`combine`) against the wilderness.
- T06.5: `public-lands` and `wilderness` or `protected-areas-world` in the view; legend "Managed by"; note names BLM
  and protected areas with size; names ≥ 2.

---

## T07. Wildlife and habitat

**Person and decision.** A visitor, birder or researcher picks where and when to see an animal, or checks where its
habitat is and how sightings changed.

**Questions.**
1. Research-grade moose sightings near Jackson Hole in the last year, by month
2. Where have bald eagles been seen near Seattle in the last 30 days?
3. Desert tortoise critical habitat near St. George and where tortoises have been seen
4. Condors near Big Sur
5. *(phone, map on Lamar Valley, Yellowstone)* What wildlife has been seen around here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Recent sightings | `species` (iNaturalist; taxon, days, research grade, month) | `gbif-occurrences` (all publishers incl. eBird) | Days / daily | Global; **sensitive species are obscured** (tortoise, jaguar) |
| Long record, by month across years | `gbif-occurrences` (month, season, year range; density tiles) | — | Years / daily | Global |
| Designated habitat | `critical-habitat` (USFWS) | — | As designated | US |
| Range | `condor-range`; **new:** iNaturalist Open Range Maps (Earth Engine) | `wolf-packs` (Washington) | Monthly | Range maps for thousands of species |

Licence line: "Sightings: iNaturalist observers (CC BY-NC / CC0 per observation); GBIF (per record); habitat: US
Fish and Wildlife Service (public domain)."

**Do not use:** an all-species GBIF density as one species (the audit's jaguar failure); "trout" or common names
without the taxon resolved (fawn lilies); obscured points as exact locations; casual-grade records for "research
grade".

**Map operations.**
- Place: the area; a sea question grows the box seaward.
- Camera: the densest cells.
- Basemap: Topo + Satellite.
- Layers: habitat polygons under sightings; sightings as density hex cells when many (> 500), symbols when few.
- Combine: `within` / `outside` habitat or protected areas (counts inside and out).
- Hidden by default: records older than the asked window; casual grade.

**Filters.**
- Default chips: Species (one taxon); Month chips (Jan–Dec) for "by month" and seasons; Research grade flag.
- Rank by: count per cell.
- Row: Month chips and the time scrubber (last 30 days, this year, since a year); More: publisher, basis of record.
- Values that must exist: `species`, `t`, `month`; habitat `species`, `listingStatus`.
- Remove: licence and observer as chips.

**Visualization.**
- Density view: hex cells on the off-white → dark grey ramp, count labels in the densest; a month bar strip (12 bars,
  sightings per month) linked to the Month chips; habitat sage hatch; range today vs historic as sage vs off-white
  hatch.
- Legend wording: "Sightings per cell (each ≈ N km²)", "Critical habitat: Threatened", "Condor range today".
- Labels: the 3 densest places by nearest name; the habitat unit name.
- Time: the scrubber with the window stated; play by month.
- Phone first screen: answer sentence with the count and the best months; the densest cells labelled.

**Dialog box.**
- Answer: "214 research-grade moose sightings near Jackson Hole in the last year, most in June and September, densest
  along the Gros Ventre River and Moose-Wilson Road." Then top 3 places; caveat when locations are obscured.
- Cards: `species` Scientific name, Identified as, Seen on, Licence; hex cell: count, rank, date span, top species;
  `critical-habitat` Species, Listed as, Designation, Rule published.
- Follow-ups reuse taxon, window and place: "Moose sightings near Wilson in June only?", "Where were bald eagles seen
  this week?", "How many tortoise records fall inside the habitat?".

**Acceptance tests.**
- T07.1: `species` (taxon moose) or GBIF; density or timeline view; time panel open (no Month filter: "by month" asks
  for every month, so a filter would hide sightings or filter nothing); legend per
  cell or sighting; card Scientific name, Seen on; note gives the count, months and where.
- T07.2: sightings with days ≤ 31; card Scientific name, Seen on; note gives a count and dates.
- T07.3: `critical-habitat` and sightings; card Species, Listed as, Designation; legend "Listed as"; note
  gives the unit's area, a count (or that locations are hidden) and Threatened; names ≥ 1. Needs the inside/outside
  join.
- T07.4: `condor-range` and sightings; legend "Today" (range today vs early 1800s); note gives range then and now and a count.
- T07.5: sightings in the view, density view; note names animals with counts. Needs species ranked by count.

---

## T08. What the ground is made of here

**Person and decision.** A curious visitor, student or hiker wants to see the physical ground: what rock it is, how
old, where the faults are, what soil, how high and steep, and the shape of the land along a line.

**Questions.**
1. What rock types and ages make up Zion Canyon, and are there faults?
2. Elevation cross-section from Yosemite Valley to the top of Half Dome
3. Highest and lowest points around Death Valley
4. What's the soil like around Boulder?
5. *(phone, map on Arches National Park)* What's under my feet here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Rock units, names, ages, lithology | `geology` (Macrostrat tiles), `geologic-unit` (one point) | — | Static | Global, map detail varies |
| Faults | **New:** USGS Quaternary Fault and Fold Database (keyless ArcGIS) | Macrostrat lines (faults in its tiles) | Static (2020 release) | US |
| Soils | **New:** USDA SSURGO via Soil Data Access (texture, drainage, depth) | OpenLandMap soil texture (Earth Engine) outside the US | Static | US detailed; SoilGrids timed out today |
| Elevation, relief, hillshade | `terrain` (AWS Terrain Tiles), Mapbox terrain in 3D | Earth Engine 3DEP 10 m / SRTM 30 m; USGS point elevation service | Static | Global |
| Highest and lowest points | `peaks` (summits with elevation, prominence) | terrain minimum from 3DEP (not available yet) | Static | Lowest points not in any layer |
| Cross-section along a line | route preview's elevation profile | 3DEP samples along a drawn line | — | A profile without a route does not exist yet |

Licence line: "Geology: Macrostrat (CC BY 4.0) from USGS and state geological surveys; faults: USGS (public domain);
soils: USDA NRCS SSURGO (public domain); elevation: USGS 3DEP, SRTM via AWS Terrain Tiles."

**Do not use:** `land-cover` as soil; Commons photo titles as formation names; a single `geologic-unit` point as the
whole canyon's geology; peak elevations from OSM `ele` without units checked (the audit's 5,200 m waterfall).

**Map operations.**
- Place: the canyon, range or valley; a "from A to B" question draws the line between the two geocoded points.
- Camera: the place; for a profile, the line with its ends.
- Basemap: Topographical or Data only (geology colors read on neither satellite imagery nor shaded green).
- Layers, bottom to top: hillshade (from the basemap's terrain), hypsometric tints, geology units at 70%, faults,
  peaks and the profile line on top.
- Terrain operations: slope classes, elevation bands, a profile along the line (distance, elevation, steepest
  segment), highest and lowest point in view.
- Hidden by default: units smaller than a few pixels (merged), faults older than Quaternary unless asked.

**Filters.**
- Default chips: Rock family (Sedimentary, Volcanic, Plutonic, Metamorphic, Unconsolidated); Age band (Quaternary,
  Tertiary, Mesozoic, Paleozoic, Precambrian).
- Rank by: elevation (peaks), area (units).
- Row: Rock family and Age chips; More: fault age and slip rate, soil drainage.
- Values that must exist: unit name, lithology, age top and bottom (million years), fault age class; peak
  `elevation`, `prominence`.
- Remove: map source ids, scale codes.

**Visualization.**
- **Geology (categorical by rock type, in geologic-map colors; owner's review of Zion, 2026-10-24):** each unit filled
  by its rock type as geologic maps color lithology: sandstone yellow, siltstone and mudstone orange-brown, shale
  grey-green, limestone and dolomite blue, conglomerate ochre, gypsum lilac, coal dark grey, volcanic red, plutonic
  pink, metamorphic purple, loose (Quaternary) sediment pale cream; no hatch or stipple; dark grey contacts; formation
  names labelled on the map. Legend: "Rock type" with the types in view and their share. Rock family and age stay as
  filters. A tap gives the unit's name ("Navajo Sandstone"), rock type, age (period and million years) and description.
  (Was: rock family in the five palette colors, darker with age; it read as muddy green hatching with two families.)
- **Faults:** dark grey lines, solid where well located, dashed where approximate; younger faults thicker.
- **Elevation:** hypsometric tints derived from the palette (off-white low → sage → purple → dark grey high) over
  the hillshade, contour bands every 1,000 ft (300 m) labelled; legend "Elevation" with the band edges in feet first
  in the US.
- **Cross-section chart** (under the map, the route preview panel): distance on x (mi), elevation on y (ft), the
  vertical exaggeration stated ("×3"), the steepest segment in pink with its grade, start and top labelled with
  their elevations; hover on the chart moves a dot on the line; the geology band under the line as a strip of rock
  type colors.
- **Soils:** texture classes on an ordinal ramp (sand to clay: off-white → sage → purple), drainage as hatch density.
- Labels: the 5 largest units by name; the highest and lowest points with elevation.
- View: detail (one place) or ranked (peaks); no time.
- Phone first screen: answer sentence ("Zion Canyon's walls are Navajo Sandstone, about 190 million years old, over
  …"), the main units labelled, the legend key collapsed to the rock types in view.

**Dialog box.**
- Answer: rock names with ages first, then the 3 largest units in view with their share, then faults; caveat when the
  map detail is coarse.
- Cards: `geologic-unit` Rock, Description, Map detail, Source map; `peaks` Elevation, Prominence; fault: name, age,
  slip rate; soil: texture, drainage, depth to bedrock.
- Follow-ups reuse the place: "Where does the Navajo Sandstone end in Zion?", "Profile from Angels Landing to the
  river?", "How old is the Kayenta?".

**Acceptance tests.**
- T08.1: `geology` and `geologic-unit` (`faults` for the faults); Topo or Data only; legend "Rock type", rock age or unit; card Rock, Description;
  note names Navajo Sandstone (or Kayenta, Moenave, Chinle), an age, and faults (or "no mapped Quaternary faults here" and the nearest).
- T08.2: `terrain`, `peaks` or `elevation-profile`; Topographical; note gives start and top elevations, the climb, and the steepest part.
  Needs a cross-section chart along a line.
- T08.3: `peaks` ranked by elevation; ≥ 3 labels; card Elevation; legend "Elevation"; note gives the
  highest (Telescope Peak) and the lowest below sea level (Badwater); names ≥ 2. Needs lowest points.
- T08.4: `soils` (or another ground layer); note gives soil texture and a share or depth. Needs soils outside the US.
- T08.5: `geologic-unit` or `geology` in the view; card Rock, Description; note names the rock (or the surface deposit
  under the point, such as alluvial gravel) and its age (in years, or its geologic period or epoch).

---

## T09. What grows and lives here

**Person and decision.** A visitor, student or land manager sees the living cover of a place: which ecosystems,
which forest types (natural or planted), how tall the trees, how green, and how two places compare.

**Questions.**
1. What ecosystems cover the Great Smoky Mountains, with the share of each?
2. Is the forest around Mount Hood natural or planted, and how tall are the trees?
3. How do the vegetation types of the Sierra Nevada compare with the Colorado Rockies? *(compare variant)*
4. What grows around Bend?
5. *(phone, map on the Hoh Rainforest)* What's growing here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Land cover classes and shares | `land-cover` (WorldCover 2021; NLCD years in the US) with shares in view | **New:** Dynamic World (recent) | Years | Global 10 m |
| Ecosystems / ecoregions | **New:** EPA ecoregions Level III and IV (US), RESOLVE 2017 (global), both in Earth Engine | — | Static | — |
| Vegetation types | **New:** LANDFIRE existing vegetation type (Earth Engine) | `land-cover` | Release years | US 30 m |
| Forest type, natural vs planted | `forest-types` (ForTy) | `old-growth` (US firesheds) | 2020 baseline | Global |
| Tree height | **New:** Meta and WRI canopy height 1 m (Earth Engine) | — | Imagery 2018–2020 | Global |
| Greenness | `greenness` (MODIS NDVI) | Dynamic World | 16 days | Global |

Licence line: "Land cover: ESA WorldCover (CC BY 4.0), USGS NLCD; ecoregions: US EPA, RESOLVE (CC BY 4.0);
vegetation: LANDFIRE (public domain); forest types: ForTy (CC BY 4.0); canopy height: Meta and WRI (CC BY 4.0)."

**Do not use:** `greenness` as a vegetation type; WorldCover's single "Tree cover" class as "old growth"; ForTy's
beta yearly series as final; `old-growth` firesheds as stand outlines.

**Map operations.**
- Place: the park, range or town; a compare question geocodes both places.
- Camera: the place; a compare fits both or splits the screen.
- Basemap: Topographical or Data only.
- Layers: one categorical cover layer at a time (ecoregions, vegetation type or forest type), canopy height as a
  ramp when asked; ecoregion outlines over the cover.
- Operations: shares of the view per class (from the source, `shares`), a compare of two places' shares.
- Hidden by default: classes under 1% of the view (grouped as Other).

**Filters.**
- Default chips: the cover classes present (top 8 by share, the rest under Other); Confidence for forest types.
- Rank by: share of the view.
- Row: class chips with their share; More: confidence threshold, map year.
- Values that must exist: class per pixel with a share of the view; ecoregion names.
- Remove: raw class codes.

**Visualization.**
- **Ecosystem colors** (palette-derived categorical, at most 8): forest classes in sage tints darkest for closed
  conifer, shrubland in light sage with sparse hatch, grassland off-white with sage stipple, wetland purple tint,
  water purple, developed dark grey, bare off-white, snow and ice white hatch; ForTy's six classes keep their
  declared colors. Ecoregion boundaries as dark grey hairlines labelled by name.
- **Canopy height:** off-white (under 5 m) → sage → purple (over 50 m), legend in m and ft.
- **Summary panel:** a bar of shares for the classes in view ("Mixed hardwood 46%, spruce-fir 12%, …") that keys the
  map and toggles the chips.
- **Compare (two places side by side):** desktop shows two synced maps (same zoom, same legend, same classes) with one
  table under them: class, share in A, share in B, difference; the phone shows one place at a time with an A/B
  toggle and the same table under it.
- Labels: ecoregion names (up to 6); the largest patches' class names.
- View: detail; compare for two places; no time.
- Phone first screen: answer sentence with the top two classes and their shares; the share bar visible under it.

**Dialog box.**
- Answer: "The Smokies are 88% forest: mixed hardwoods 46%, oak 22%, spruce-fir 4% at the highest ridges, …". Then
  the top 3 classes with shares; caveat on map year.
- Cards: forest types (Reading, the class probabilities, Map); land cover (Land cover, Map year); ecoregion: name,
  level, area; canopy height at the point.
- Follow-ups reuse the place and classes: "Where is the spruce-fir in the Smokies?", "How tall are the trees on
  Mount Le Conte?", "Compare with the Blue Ridge".

**Acceptance tests.**
- T09.1: `vegetation-types`, `ecoregions`, `land-cover` or `forest-types`; Topo or Data only; legend names the
  cover; note gives shares and named ecosystems. Needs ecoregions, LANDFIRE, shares from the source.
- T09.2: `forest-types` and `canopy-height`; Topo or Data only; legend "Forest type" (or "Canopy height"); note says
  natural vs planted and gives tree height. Needs canopy height.
- T09.3: cover layer (`vegetation-types`, `land-cover` or `forest-types`), each place's own box queried; both places
  named with numbers; shares and named vegetation. Needs the side-by-side view.
- T09.4: a cover layer (`vegetation-types` first); named vegetation with a share or area.
- T09.5: a cover layer in the view (`vegetation-types`, or `canopy-height` for height); the ecosystem named with a share
  or height.

---

## T10. How this place changes through the year, and what is under the water

**Person and decision.** Someone planning a visit or teaching about a place wants its year: when it is warm, wet,
snowy, green, when the river peaks; and what is under the water: lake and coastal depth, and how two lakes compare.

**Questions.**
1. Typical temperature and precipitation by month at Lake Tahoe, and when the snow usually arrives
2. When in the year is the Merced River highest in Yosemite Valley?
3. How does Lake Tahoe's depth compare to Crater Lake's? *(compare variant)*
4. When does spring green up around Asheville?
5. *(phone, map on Elliott Bay, Seattle)* How deep is the water here?

**Data set curation.**

| Fact | Primary | Fallback | Freshness needed / actual | Coverage and gaps |
|---|---|---|---|---|
| Monthly temperature and precipitation normals | **New:** NOAA 1991–2020 station normals (US) | **New:** ERA5-Land monthly or TerraClimate (Earth Engine), Open-Meteo history (global) | Static normals | Not in the app today |
| When snow arrives and leaves | `snowpack` normals on the card (Snow normally arrives, Normal peak) | MODIS snow days (Earth Engine) | Static | SNOTEL western US |
| River flow by month | `streamflow` + USGS daily statistics (median by month) | `river-pulse` (GloFAS 3 months) | Static medians | Not a monthly strip yet |
| Lake levels by month | `reservoir-levels` series | **New:** JRC monthly water history (Earth Engine) | Daily | Western US reservoirs |
| Green-up timing | `phenology` (USA-NPN), `greenness` | **New:** MODIS phenology MCD12Q2 (Earth Engine) | Yearly | Lower 48 (NPN); global (MODIS) |
| Lake depth | `lakes` (maximum and mean depth from Wikidata) | `water-depth` where NOAA surveyed the lake (Great Lakes, Lake Washington); USGS lake surveys | Static | One number per lake; no bathymetry for Tahoe or Crater |
| Coastal and ocean depth | `water-depth`: NOAA NCEI DEM mosaic (CUDEM coasts, Great Lakes; ETOPO 2022 with GEBCO offshore) | — | Static | US coasts 3–10 m, Great Lakes, oceans about 450 m; lakes above sea level mostly unsurveyed (not Tahoe or Crater) |

Licence line: "Normals: NOAA NCEI (public domain); ERA5-Land (Copernicus, attribution); flow: USGS; phenology: USA
National Phenology Network, NASA MODIS; depth: NOAA NCEI, GEBCO Compilation Group (public domain), Wikidata (CC0)."

**Do not use:** this week's forecast as "typical"; one year's flow as the usual year; `tides` heights as depth;
`greenness` composites weeks old as "now".

**Map operations.**
- Place: the lake, river reach or town; a compare geocodes both lakes.
- Camera: the place; bathymetry fits the water body.
- Basemap: Topographical or Data only (depth and seasonal colors read best without imagery).
- Layers: the seasonal layer for the month shown (snow cover, greenness) under the gauge or station; bathymetry with
  contours; lake outlines.
- Operations: monthly aggregation (12 values per variable at the place), depth sampled along a line (a depth profile
  from shore to shore).
- Hidden by default: land under the depth ramp; months outside the asked season.

**Filters.**
- Default chips: Month (Jan–Dec) as the time control; depth bands for bathymetry.
- Rank by: depth (lakes), peak month (rivers).
- Row: the monthly strip doubles as the time control; More: the years averaged.
- Values that must exist: 12 monthly values per variable; lake `depthM`; depth grid values.
- Remove: daily noise in a seasonal view.

**Visualization.**
- **Monthly climate strip** (under the map, the linked chart's slot): 12 columns Jan–Dec; rows for temperature (high
  and low as a band, °F first in the US), precipitation (bars, inches), snow (share of the view snow-covered or
  normal snow depth), greenness, river flow (median by month); the current month marked by the pink playhead; tapping
  a month sets the map to that month (snow cover, greenness tiles). Legend in words ("Bars: median monthly
  precipitation 1991–2020").
- **Bathymetric depth ramp:** off-white (shallow) → purple → dark grey (deepest), contours every 10 m (or 50 ft in
  the US) with depth labels, the deepest point marked and labelled; land masked to the basemap.
- **Compare two lakes:** the same depth ramp and contour interval on both, side by side (desktop) or toggled (phone),
  with a table: maximum depth, mean depth, area, volume, surface elevation.
- Labels: the deepest point with its depth; the station or gauge by name; up to 5 lakes by depth.
- View: timeline by month (the strip); detail for one lake; compare for two.
- Phone first screen: answer sentence ("The Merced peaks in late May to June at about 2,500 cfs; lowest in
  September."), the strip's peak month visible under it.

**Dialog box.**
- Answer: the peak and low months with numbers first, then the 3 seasonal facts that decide a visit; caveat on the
  years averaged.
- Cards: `lakes` Maximum depth, Kind, Area, Surface elevation, Volume; `snowpack` normals (Snow normally arrives,
  Normal peak); `streamflow` Flow, Median flow for the date; month cell: values and years averaged; depth point:
  depth and source.
- Follow-ups reuse the place and the month: "What is Lake Tahoe like in July?", "When is Yosemite Falls biggest?",
  "Show Crater Lake's depth profile".

**Acceptance tests.**
- T10.1: `climate-normals`, `snowpack` or `weather-forecast`; Topographical; note gives monthly °F, precipitation in inches or mm, and
  when snow arrives. Needs normals and the monthly strip.
- T10.2: `flow-by-month`, `streamflow` or `river-pulse`; note gives the peak month and cfs. Needs flow by month.
- T10.3: `lakes`; detail or ranked; both lakes named with numbers; card Maximum depth, Kind, Area (and Mean depth,
  Surface elevation, Volume where Wikidata has them); note gives both depths; names ≥ 2. Bathymetry for both still
  needed: NOAA's mosaic holds only their flat surfaces (Tahoe 1,897 m, Crater 1,883 m), so `water-depth` cannot draw
  them; USGS lake surveys are the next source.
- T10.4: `phenology` (its `greenup` view: MODIS green-up dates) or `greenness`; Topo or Data only; note gives the green-up month and early or late.
- T10.5: `lakes`, `tides` or `water-depth` in the view; note gives a depth. Bathymetry: `water-depth` (NOAA NCEI
  mosaic: CUDEM on US coasts, Great Lakes, ETOPO 2022 with GEBCO offshore) with a depth ramp, contours and the deepest
  point in the note.

---

## What the app must add for all ten to pass

From the curation above, in the order it unblocks questions (the baseline in `.superpowers/m3/top10/BASELINE.md`
shows which questions each fixes):

1. Earth Engine totals for raster layers (hectares lost, shares of the view per class), the Hansen numbers and the
   drivers of loss (T05, T09).
2. Point the `mining-claims` layer at BLM's new host, `nlsdbpubgis.blm.gov` (T06; product code, a one-line fix).
3. New layers: oil and gas leases (T06), faults and soils (T08), ecoregions, LANDFIRE vegetation and canopy height
   (T09), climate normals and bathymetry (T10).
4. New views: the monthly strip (T10), the cross-section chart along a line (T08), two places side by side (T09,
   T10), the summary share bar (T09).
5. Answer shape in the prompt and note check: the first sentence carries the deciding number, and the follow-ups
   name the result's features.

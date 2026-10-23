# Use cases

What a real person asks WallyMap, what they are deciding, and what the app must do for them to decide. The layer audit
(`.superpowers/m3/after/REPORT.md`) judged each layer alone; this file judges whole use cases: a question, the data the
agent picks, the filters the person would reach for, what the map and card show, and whether they can decide from it.

Each use case lists:

- **Person and decision**: who asks and what they will do with the answer (go or not, where, when, how much).
- **Questions**: two or three in the owner's voice, short and sometimes vague. They are in the eval set under the
  `usecase` tag (`docs/questions.md`, `USECASE_QUESTIONS` in `scripts/eval-model.mts`).
- **Data**: the layers that answer it, how fresh they must be, and where they must cover.
- **Filters**: the ones that matter for the decision, and the ones that do not (and should stay under More).
- **Visualization**: the standard view (spec §12), what color, size and labels encode, the legend, and the time mechanic.
- **Card**: the facts a tap must show for the decision.
- **Acceptance**: concrete checks a run must pass. The general ones apply to every use case and are not repeated:
  the place is located and the camera ends on it; every query answers or says honestly why not; the Tier 1 map checks
  pass (surface, lattice, duplicates, card, layer ids, place); the note is under 150 words.

The audit of these questions against the current app is `.superpowers/m3/usecases/AUDIT.md`.

Distances: "near X" means the radius the layer searches around X (`lib/agent/places.ts`), about 25 to 50 km. Phone
means 390×844 with the chat sheet at peek.

---

## Outdoor recreation

### UC01. Day hiker picks a trail for Saturday

**Person and decision.** A visitor or local with a free morning picks one trail: right length, right difficulty, a
payoff (view, waterfall), not mobbed.

**Questions.**
- Good day hikes near Boulder under 5 miles
- Easy hikes with a waterfall near Asheville

**Data.** Named trails with their whole length, not OpenStreetMap segments (`osm-trails` named routes, or `popularity`,
which merges ways by name); `outdoor-features` waterfalls and viewpoints; `popularity` for busy or quiet. Freshness:
months. Coverage: global, OpenStreetMap quality.

**Filters that matter.** Trail length (a range, in miles in the US), difficulty (`sac_scale`: T1 to T2 for "easy"),
"ends at" a feature (waterfall, viewpoint, summit). **Do not matter:** surface, OSM kind (path, footway, track),
visibility.

**Visualization.** Ranked view: named trails drawn whole, colored by difficulty, the top 5 labelled with name and miles;
waterfalls as symbols on top. No time mechanic.

**Card.** Trail name, length in miles and km, difficulty in words, elevation gain, what it leads to (waterfall, summit),
popularity band, trailhead or parking.

**Acceptance.**
- `osm-trails` or `popularity` answered with at least 10 named trails within 30 km of the place.
- Every drawn trail carries a whole-trail length; a length filter (under 8 km) is set through `render.filters`, not a
  re-query, and every drawn trail passes it.
- For the waterfall question, `outdoor-features` with `kind` waterfall answered, and the note names at least 2 trails
  that reach a waterfall (within 300 m of its end or its line).
- The note names at least 3 trails with length in miles.
- Phone: the top 5 trail names are on the map without opening a panel.

### UC02. Hiker checks whether the trail is snow-free

**Person and decision.** A hiker in the shoulder season decides whether to go now or wait, and whether to bring
traction.

**Questions.**
- Which trails at Mount Rainier are snow free right now?
- Is there still snow on the trails around Lake Tahoe?

**Data.** `snow-cover` (MODIS, newest clear day, within 3 days), `snowpack` (SNOTEL depth, hourly), trails
(`osm-trails`). Coverage: snow-cover global, SNOTEL western US.

**Filters that matter.** Snow on or off along each trail; elevation band. **Do not matter:** trail surface,
`sac_scale`.

**Visualization.** Detail or ranked: trails colored snow-covered or clear (sampled from snow-cover), snow raster under
them, the day of the image in the legend. A single time (latest clear day), no scrubber.

**Card.** Trail name, share of its length under snow on the image date, the highest point, nearest SNOTEL depth with
its time.

**Acceptance.**
- `snow-cover` answered with a date within the last 5 days and the note says that date.
- `snowpack` answered with at least 1 station inside the area and the note gives its depth in inches and its time.
- Trails drawn, and the note names at least 2 trails as snow-covered or clear (a cross-layer answer, not two separate
  maps).

### UC03. Backpacker plans water and camps

**Person and decision.** A backpacker planning 2 to 4 nights picks a route where water and legal camps fall at day
intervals.

**Questions.**
- Backpacking in the Wind Rivers: where are the water sources and campsites?
- Where can I camp along the Wonderland Trail?

**Data.** `outdoor-features` (springs, drinking water, huts, shelters), `campsites` (backcountry sites),
`osm-trails` (the route), `wilderness` (permit and camping rules). Freshness: years. Coverage: OpenStreetMap; US
wilderness.

**Filters that matter.** Feature kind (spring, drinking water, campsite), along a named route (within 500 m of it),
backcountry only. **Do not matter:** RV parks, parking lots, fees.

**Visualization.** Route view or detail: the named route drawn, campsites and water as distinct symbols along it, with
distance along the route on hover. No time.

**Card.** Name, kind, potable or not, distance along the route, permit rule (wilderness card).

**Acceptance.**
- `outdoor-features` answered with springs or drinking water, and `campsites` answered with `backcountryOnly`.
- No RV or caravan sites and no parking lots drawn.
- For the Wonderland Trail, the route is drawn and at least 10 of its 18 wilderness camps are within 500 m of it; the
  note says camps need a Mount Rainier wilderness permit.

### UC04. Trail runner picks a long run with the right climbing

**Person and decision.** A runner picks a route by distance and total climb.

**Questions.**
- Long trail runs with big climbs near Chamonix
- Flat trail runs over 10 miles near Portland

**Data.** Named trails or routes with length and elevation gain (gain needs a terrain model sampled along the line),
`peaks`. Coverage: global.

**Filters that matter.** Length (over 16 km), elevation gain (over 1,000 m, or under 100 m for flat). **Do not
matter:** `sac_scale` beyond excluding alpine grades, surface.

**Visualization.** Ranked by gain (or length): routes colored by gain per km, the top 5 labelled with km and m of
gain; an elevation profile on the card.

**Card.** Length, elevation gain and loss, highest point, steepest km.

**Acceptance.**
- Trails answered with at least 5 named routes over 16 km.
- Every ranked route carries an elevation gain; the note gives gain in metres (Chamonix) or feet (Portland) for at
  least 3 routes.
- For "flat", every drawn route has under 30 m of gain per 10 km.

### UC05. Mountain biker picks an intermediate ride

**Person and decision.** A rider picks trails at their skill level and the trail system to drive to.

**Questions.**
- Intermediate mountain bike trails near Bentonville
- Flowy blue trails in Sedona

**Data.** `mtb-trails` (Singletrack Scale and IMBA color), `popularity`. Coverage: OpenStreetMap; grade coverage varies.

**Filters that matter.** Difficulty (IMBA blue, Singletrack 1 to 2), trail system. **Do not matter:** surface,
OSM kind.

**Visualization.** Lines colored on the difficulty ramp, the filter chip for intermediate pressed, the top 5 named
trails labelled.

**Card.** Name, IMBA color and Singletrack grade in words, length, direction (one-way, downhill), bike access.

**Acceptance.**
- `mtb-trails` answered with at least 30 trail segments; at least 50% carry a grade.
- `render.filters` keeps only intermediate (IMBA blue or Singletrack 1 to 2); every drawn trail passes it.
- The note names at least 3 trails and says how many unrated trails were left out.

### UC06. Sport climber picks a crag by style and sun

**Person and decision.** A climber picks a crag for the afternoon: sport routes at their grade, in the shade.

**Questions.**
- Which crags near Moab are sport and shaded in the afternoon?
- Beginner sport climbing at Red Rock near Las Vegas

**Data.** `climbing` (disciplines, grade bands, route counts from OpenBeta), aspect of the wall (from a terrain model
or OpenBeta's own aspect field, not in the data today). Coverage: OpenBeta US; OSM global.

**Filters that matter.** Discipline (sport), grade band (beginner, 5.6 to 5.9), aspect (north or east faces are shaded
in the afternoon). **Do not matter:** source (OSM or OpenBeta), fee, gym.

**Visualization.** Ranked by route count, sport chip pressed, symbols colored by aspect (shaded vs sunny at the asked
hour), the top 5 labelled.

**Card.** Crag name, sport route count, grade spread, aspect and when it gets sun, approach.

**Acceptance.**
- `climbing` answered with at least 10 crags and route counts on at least half.
- `render.filters` sets `disciplines` to sport (and `gradeBands` to beginner for the second question); every drawn crag
  passes.
- For "shaded in the afternoon", every drawn crag carries an aspect and the note names at least 2 north- or east-facing
  crags; an answer that ignores the shade clause fails.

### UC07. Boulderer checks the weekend conditions

**Person and decision.** A boulderer decides whether this weekend is climbable (temperature, wind, rain).

**Questions.**
- Bouldering near Bishop this weekend, will it be too hot?
- Is it too windy to climb at Joshua Tree tomorrow?

**Data.** `climbing` (bouldering areas), an hourly forecast of temperature, wind and precipitation for the asked days
(`wind-flow` carries wind and air temperature for the next days; no precipitation layer today).

**Filters that matter.** Day and hour (Saturday afternoon), discipline (boulder). **Do not matter:** grade, route count.

**Visualization.** The boulder areas with the forecast for the asked day: a linked hourly curve of temperature and
wind at the area, the scrubber on the asked day.

**Card.** Forecast high and low, wind and gusts, chance of rain for the asked day, at the area.

**Acceptance.**
- A forecast layer answered for the asked dates (Saturday and Sunday, or tomorrow), and the note gives the high
  temperature in °F and the wind in mph for that day.
- `climbing` answered with at least 3 bouldering areas.
- The time ends on the asked day, not today.

### UC08. Whitewater kayaker picks a run with water

**Person and decision.** A paddler picks a river section at their class that has runnable flow on the day they can go.

**Questions.**
- Where can I paddle class III near Asheville this weekend?
- Is the Gauley running right now?
- Class IV runs in Colorado with enough water right now

**Data.** River sections with class and their reference gauge and runnable range (`paddling` from OpenStreetMap, which
rarely carries class in the US; American Whitewater holds this), `streamflow` (live, hourly), a flow forecast for
"this weekend" (`river-pulse` GloFAS 7-day; NOAA NWPS river forecasts). Coverage: US.

**Filters that matter.** Class (III, IV), runnable now or on the asked day (flow inside the section's range).
**Do not matter:** flow against the median for the date (that is not whether it runs), water temperature (secondary).

**Visualization.** Sections colored by runnable (too low, runnable, high, too high) at the asked day; gauges as
symbols; the scrubber on the forecast days.

**Card.** Section name, class, current flow and the runnable range, trend, forecast for the asked day, put-in and
take-out.

**Acceptance.**
- `paddling` answered with sections carrying a class, and a class filter set through `render.filters`.
- `streamflow` answered with the gauge that names the asked river; for the Gauley, the gauge below Summersville Dam.
- The note gives flow in cfs and says runnable or not against a stated range; "normal for the date" alone fails.
- "This weekend" questions draw a forecast for Saturday or Sunday.

### UC09. Sea or flatwater kayaker times the tide and wind

**Person and decision.** A kayaker picks the hour to launch and where to put in.

**Questions.**
- Best time to kayak Tomales Bay tomorrow, tide and wind
- Where can I launch a kayak on Lake Tahoe?

**Data.** `tides` (NOAA predictions), `wind-flow` (hourly, next days), `ocean-currents`; launches from `fishing`
ramps, `recreation-sites` water access, OpenStreetMap slipways and beaches.

**Filters that matter.** Hour of the day (tomorrow), launch kind (ramp, beach, hand launch), public. **Do not matter:**
fish species, water temperature.

**Visualization.** Timeline on tomorrow, hourly: the tide curve linked to the scrubber, wind particles; launches as
symbols labelled by name.

**Card.** Launch name, kind, parking, fee; tide station's next highs and lows in local time.

**Acceptance.**
- `tides` answered with a station inside or at the mouth of the bay; the note gives tomorrow's high and low in local
  time with feet.
- `wind-flow` answered and the note names a calm window (hours with wind under 10 mph).
- For Lake Tahoe, at least 5 launches answered and drawn, labelled, and the note names 3.

### UC10. Backcountry skier checks avalanche danger and snow

**Person and decision.** A ski tourer decides whether to go and which slope angle and aspect is reasonable today.

**Questions.**
- Avalanche danger near Stevens Pass today
- Where's the deepest fresh snow in Utah right now?
- Low-angle ski tours near Teton Pass

**Data.** The avalanche center forecast (danger rating by zone, daily; avalanche.org public map layer), `snowpack`
(SNOTEL new snow and depth), `ski-routes` (ski tours), slope angle from a terrain model. Coverage: US mountains.

**Filters that matter.** Danger level, new snow in 24 to 72 hours, slope angle (under 30°). **Do not matter:** ski run
kind for resort runs, lit trails.

**Visualization.** Forecast zones filled by danger in the North American danger scale colors with its legend; SNOTEL
ranked by new snow with the top 5 labelled; for slope angle, a slope shading over 30°.

**Card.** Zone name, danger by elevation band, the problem types, issued and expires times, a link to the center's
forecast. SNOTEL: depth, 24 h and 72 h new snow, time.

**Acceptance.**
- An avalanche forecast answered for the zone containing Stevens Pass, and the note states the danger level and issue
  date; `weather-alerts` alone (warnings only) fails when no warning is up.
- `snowpack` answered with at least 10 Utah stations, ranked by new snow, and the note names the top 3 with inches.
- For "low-angle", the note or map separates terrain under 30° from steeper terrain; a list of routes without slope
  angle fails.

### UC11. Angler picks a river by flow and water temperature

**Person and decision.** A trout angler picks a river and a stretch with public access that is fishable today.

**Questions.**
- Is the Madison fishing well right now?
- Where can I fly fish with public access near Asheville?
- Trout streams near Denver that aren't too warm

**Data.** `streamflow` (flow and water temperature, live), `fishing` (access sites, recent catches, temperature band),
public access (state fishing access, `public-lands`). Coverage: US.

**Filters that matter.** Water temperature band (under 65 °F for trout), flow against normal (blown out or not),
public access. **Do not matter:** boat ramp vs pier for wading anglers.

**Visualization.** Gauges colored by temperature band (cold, good, warm, too warm) and labelled with °F and cfs;
access points as symbols.

**Card.** Gauge name, water temperature with the trout verdict, flow and against normal, time; access site name,
owner, rules.

**Acceptance.**
- `streamflow` or `fishing` answered with at least 1 gauge on the named river (Madison) carrying a water temperature;
  the note gives °F and cfs.
- Distinct temperatures: not more than half of the drawn spots share one gauge reading.
- For "public access", every drawn access point is on public land or an official access site.

### UC12. Surfer picks a session

**Person and decision.** A surfer picks the day and break.

**Questions.**
- Will Santa Cruz have good surf this weekend?
- Where is the swell biggest on the Oregon coast right now?

**Data.** `surf` (buoys now, forecast days ahead, named spot forecasts), `tides`, `wind-flow` (offshore or onshore).

**Filters that matter.** Day (Saturday, Sunday), wave height, period. **Do not matter:** buoy vs station source,
climatology.

**Visualization.** Ranked by wave height at the asked time; spots labelled with feet and period; the scrubber on the
forecast days.

**Card.** Wave height in feet, period, swell direction, wind and its direction relative to the coast, tide at dawn.

**Acceptance.**
- `surf` answered with `forecast` for Santa Cruz, and the note gives wave height in feet and period for Saturday and
  Sunday.
- For Oregon, at least 3 buoys or spots answered and the note names the biggest with its height.

### UC13. Car camper finds free dispersed camping

**Person and decision.** A camper finds legal free camping reachable in their vehicle.

**Questions.**
- Free dispersed camping near Sedona
- Where can I park my van overnight on BLM land near Moab?

**Data.** `forest-roads` (Motor Vehicle Use Map, open to vehicles), `public-lands` (who manages the land),
`campsites` (OpenStreetMap, including dispersed), `recreation-sites` (developed). Freshness: a season.

**Filters that matter.** Manager (USFS, BLM), road open to the vehicle (maintenance level, season), free.
**Do not matter:** RV park capacity, parking lots in town.

**Visualization.** Public land tinted by manager; roads open to vehicles colored by level; free campsites as symbols
labelled by name.

**Card.** Road number and name, maintenance level in words, season dates, ranger district; land manager and its
dispersed-camping rule.

**Acceptance.**
- `public-lands` and (for Sedona) `forest-roads` answered and drawn.
- No paid campgrounds or town parking lots in the drawn camp symbols when the question says free.
- The note says where dispersed camping is legal (which forest or BLM field office) and names at least 2 roads or
  areas.

### UC14. Overlander plans a route with water and camps

**Person and decision.** An overlander plans a multi-day dirt route: which roads their vehicle can drive and where to
camp and find water.

**Questions.**
- Camping and water along the Mojave Road
- Forest roads a Subaru can drive near Leadville

**Data.** `route` (or the named route from OpenStreetMap), `campsites`, `outdoor-features` (springs), `forest-roads`
(maintenance level 3 and up for a passenger car, 2 for high clearance).

**Filters that matter.** Maintenance level (a car vs high clearance), season, along the route. **Do not matter:**
road surface alone, district.

**Visualization.** The route drawn, camps and water along it; roads colored by level with the passable levels chosen
by chip.

**Card.** Road level in words ("passenger car", "high clearance"), season dates, surface.

**Acceptance.**
- For the Mojave Road, the route (or a named OSM route) is drawn and camps or water within 2 km of it are listed.
- For Leadville, `forest-roads` filtered through `render.filters` to levels 3 to 5 (or the passenger-car flag); every
  drawn road passes.

### UC15. Wildlife watcher finds an animal

**Person and decision.** A visitor picks where and when to look for one species.

**Questions.**
- Where can I see moose near Jackson Hole?
- Where are whales being seen off Monterey this week?

**Data.** `species` (iNaturalist, recent, research grade), `gbif-occurrences` (longer record). Freshness: days for
"this week", a year otherwise.

**Filters that matter.** Species (one taxon, not a genus mix), time window (this week, this season), research grade.
**Do not matter:** licence, observer.

**Visualization.** Density view (hex count or heat) for many records, symbols for few; the time window stated; the
densest spots named.

**Card.** Species, date seen, place, photo; for a hex: count, date span, top places.

**Acceptance.**
- `species` or `gbif-occurrences` answered with the asked taxon only (moose: Alces alces; whales: Cetacea), at least 10
  records.
- "This week" answers draw only records from the last 7 days.
- The note names the 2 to 3 densest places.

### UC16. Birder plans a migration trip

**Person and decision.** A birder picks where and when to go for a seasonal spectacle.

**Questions.**
- Best place to see sandhill cranes in Nebraska in March
- Where have bald eagles been seen near Seattle lately?

**Data.** `gbif-occurrences` (eBird via GBIF, years of March records), `species` (recent iNaturalist).

**Filters that matter.** Month (March, across years), species, recency ("lately" means weeks). **Do not matter:**
basis of record beyond excluding specimens.

**Visualization.** Density (hex count) for the month across years; the Platte River reach should stand out.

**Card.** Hex: count, years covered, top places.

**Acceptance.**
- The crane question queries records filtered to March (any year), Antigone canadensis only; at least 100 records;
  the note names the Platte River (Kearney to Grand Island).
- The eagle question answers with the last 30 days or says the window it used.

### UC17. Photographer picks a sunset or night spot

**Person and decision.** A photographer picks a viewpoint facing the sunset, or a dark place for the Milky Way, or a
place with peak color.

**Questions.**
- Where should I shoot sunset near Sedona?
- Darkest skies for Milky Way photos near Moab
- Is there fall color near Asheville right now?

**Data.** `photos` and viewpoints, `outdoor-features` viewpoints, the sun's azimuth and time (computed), terrain for the
view direction; `night-lights` (VIIRS Black Marble); a fall color source (not in the app).

**Filters that matter.** View direction (west for sunset), darkness class, color stage. **Do not matter:** photo
licence, Mapillary images.

**Visualization.** Viewpoints labelled and ranked by photos; night-lights raster with a darkness legend and the darkest
reachable spots named; fall color as a stage map.

**Card.** Viewpoint name, photos nearby, direction of view, sunset time and azimuth.

**Acceptance.**
- Sunset: at least 3 named viewpoints answered; the note gives tonight's sunset time and names at least 2 west-facing
  spots.
- Milky Way: `night-lights` answered and the note names at least 2 dark places reachable by road.
- Fall color: the answer says what the app can and cannot show (a greenness change or no source), never a spring map
  presented as fall.

## Hazards and conditions

### UC18. Resident watches smoke and fire

**Person and decision.** A resident decides whether to run outside, close windows, or prepare to leave.

**Questions.**
- Is it smoky in Bend tomorrow?
- Are the fires near Missoula contained?

**Data.** `smoke` (HMS observed and forecast near-surface smoke), `fire-perimeters` (status, percent contained, date
mapped), `fire-detections` (last 24 to 72 h), `weather-alerts` (air quality alerts). Freshness: hours.

**Filters that matter.** Day (tomorrow), status (active), containment. **Do not matter:** satellite, agency.

**Visualization.** Smoke forecast for the asked day colored by density with the PM2.5 level in words; fires colored by
status, labelled with name and percent contained.

**Card.** Fire: name, acres, percent contained, status, date of the last perimeter. Smoke: density, PM2.5, valid time
in local time.

**Acceptance.**
- Bend: `smoke` answered with `source: forecast` and a date of tomorrow; the note says smoky or clear for tomorrow.
- Missoula: `fire-perimeters` answered; the note gives percent contained for each fire it names, or says no fire is
  active within the radius.
- Times in the note are local.

### UC19. Flood and weather watcher

**Person and decision.** A resident or visitor decides whether to move the car, cancel the canyon hike, or change
plans for the weekend.

**Questions.**
- Is the French Broad going to flood in Asheville?
- Any flash flood warnings in Utah canyons today?
- Will it rain in Zion this weekend?

**Data.** `streamflow` (now), a river forecast against flood stage (NOAA NWPS), `weather-alerts` (warnings), a
precipitation forecast (NWS or Open-Meteo), `flood-zones`.

**Filters that matter.** Event (flash flood warning), day. **Do not matter:** marine alerts.

**Visualization.** The gauge with its stage against action and flood stage, a linked forecast curve; warning polygons
by severity; rain forecast per day.

**Card.** Gauge stage in feet, flood stage, forecast crest and time; warning event, until when; rain chance and
amount for Saturday and Sunday.

**Acceptance.**
- French Broad: the gauge at Asheville answered; the note compares stage or flow to flood stage (not only to the median
  for the date) and gives the forecast if one exists.
- Utah: `weather-alerts` answered over the canyon country; the note names active flash flood warnings or says none.
- Zion: a precipitation forecast for Saturday and Sunday answered; the note gives chance and amount.

## Land, forests and conservation

### UC20. Ranger reviews fire history and burn severity

**Person and decision.** A district ranger or planner decides where to focus reforestation or fuel work.

**Questions.**
- How much of the Deschutes National Forest burned in the last 10 years and how badly?
- Where did beetles kill trees in the Medicine Bow since 2020?

**Data.** `fire-perimeters` (10 years, acres), `burn-severity` (MTBS per year), `public-lands` or the forest boundary,
`tree-mortality` (aerial survey, yearly). Coverage: US.

**Filters that matter.** Year range, inside the forest boundary, severity class, cause (agent). **Do not matter:**
agency of the fire record.

**Visualization.** Timeline: perimeters by year, the summed acres inside the forest stated; burn severity for the
worst year; die-off as hex cells or patches by year.

**Card.** Fire name, year, acres, acres high severity; die-off patch: agent, year, trees killed.

**Acceptance.**
- `fire-perimeters` answered for 10 years with at least 10 fires; the note gives total acres burned inside the forest
  and the share of the forest (needs the forest boundary).
- `burn-severity` answered for at least one year and the note gives high-severity acres or share.
- Medicine Bow: `tree-mortality` answered for 2020 onward; the note names the main agent and the peak year.

### UC21. Range manager checks grazing against habitat and drought

**Person and decision.** A BLM range specialist decides where to adjust grazing or gather horses.

**Questions.**
- Grazing allotments overlapping desert tortoise critical habitat near St. George
- Wild horse areas in Nevada that are in drought right now

**Data.** `grazing-allotments`, `critical-habitat`, `drought` (this week). Coverage: US West.

**Filters that matter.** Overlap (allotment intersects habitat; HMA intersects D2 or worse), species, drought
category. **Do not matter:** allotment acres alone.

**Visualization.** The overlapping allotments or HMAs highlighted, the rest faded; overlap area stated.

**Card.** Allotment or HMA name, acres, overlap acres and share, drought category.

**Acceptance.**
- Both layers answered and the note names at least 2 overlapping allotments (or HMAs) with overlap in acres or a share.
  Drawing both layers without saying which overlap fails.

### UC22. Conservation researcher measures deforestation and its drivers

**Person and decision.** A researcher quantifies loss in a region and what replaced it, for a report or grant.

**Questions.**
- How much forest did Pará lose since 2017 and to what?
- Which protected areas in Borneo lost the most forest?

**Data.** `forest-loss` (Hansen yearly), `forest-types` (ForTy 2017 to 2025, in progress) or a driver dataset (WRI
drivers of tree cover loss), `land-cover`, `protected-areas-world`. Totals need zonal statistics (Global Forest Watch
API or Earth Engine).

**Filters that matter.** Year range, canopy threshold, replacing class (pasture, plantation, crops), inside a protected
area. **Do not matter:** single-pixel visuals at state scale.

**Visualization.** Change view: loss colored by year or by what replaced it; a total in hectares and share; protected
areas ranked by loss with the top 5 labelled.

**Card.** Area: hectares lost per year, share of 2000 or 2017 forest, main driver.

**Acceptance.**
- `forest-loss` answered for 2017 onward over Pará; the note gives total hectares lost (a number, not "lots").
- The note says what replaced the forest from a driver or land-cover source, or says the app cannot yet.
- Borneo: protected areas answered and ranked by loss inside them; the note names the top 3 with hectares.

### UC23. Conservation researcher finds species outside protection

**Person and decision.** A researcher finds where a species or habitat lies outside protected land.

**Questions.**
- Jaguar records in Costa Rica outside protected areas
- Old-growth forest in Oregon that isn't in wilderness

**Data.** `gbif-occurrences` (Panthera onca), `protected-areas-world`; `old-growth`, `wilderness`.

**Filters that matter.** Inside or outside a protected area (a spatial join), species. **Do not matter:** basis of
record beyond excluding fossils.

**Visualization.** Records outside protection drawn solid, those inside faded; count of each stated.

**Card.** Record date, place, nearest protected area and distance.

**Acceptance.**
- Both layers answered; the note gives counts inside and outside (or acres for old growth); only records or areas
  outside are emphasised.

## Public interest

### UC24. Journalist checks a water, disaster or emissions story

**Person and decision.** A reporter verifies a number and gets a map for a story.

**Questions.**
- How much has Lake Powell dropped since 2000?
- Which California counties got the most disaster declarations since 2020?
- Biggest methane leaks in the Permian this year

**Data.** `reservoir-levels` (series since 2000), `surface-water` (to 2021); `disasters` (FEMA by county);
`methane-plumes` (Carbon Mapper).

**Filters that matter.** Date range (since 2000, since 2020, this year), sector. **Do not matter:** source system.

**Visualization.** Reservoir: the elevation series as a linked curve with the 2000 and latest values; disasters: ranked
counties with counts labelled; methane: ranked symbols by kg/h, top 5 labelled.

**Card.** Elevation then and now, drop in feet, percent full; county: declaration count and the list; plume: rate,
sector, date, operator where known.

**Acceptance.**
- Lake Powell: `reservoir-levels` answered with a series reaching back to 2000; the note gives the drop in feet and
  percent full now.
- California: `disasters` answered with declarations since 2020 only; the note names the top 3 counties with counts.
- Permian: `methane-plumes` answered for this year; the note names the 3 largest by kg/h with dates.

### UC25. Educator shows a change to a class

**Person and decision.** A teacher shows students a change over time or a fact about their place.

**Questions.**
- Show my class how the glaciers in Glacier National Park have shrunk
- What rock is under Denver?
- How has Arctic sea ice changed since 2012?

**Data.** `glaciers` (GLIMS surveys), `geologic-unit`, `sea-ice`.

**Filters that matter.** Survey dates, the two dates to compare. **Do not matter:** glacier ids, map scale codes.

**Visualization.** Change view: ice lost pink with the total stated; detail card for the rock; sea ice compare of the
same date in two years.

**Card.** Glacier name, area then and now, percent lost; rock name, age in plain words.

**Acceptance.**
- Glacier National Park: `glaciers` answered in the change view and the note gives total km² lost and the percent,
  naming the largest glacier.
- Denver: `geologic-unit` answered at the city center; the note names the rock and its age.
- Sea ice: `sea-ice` compared on the same calendar date in 2012 and this year; the note gives both extents or says
  what the picture shows.

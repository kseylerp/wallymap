/**
 * Routes the words people use to the data layers that answer them. The synonyms and notes are rendered into the
 * system prompt, so keep them short: only words people say, one spelling each (the model matches "dams" to "dam").
 * The gist (6 to 10 words) is list_layers' one-line description of the layer; it is not in the prompt.
 * When a question matches several layers, the model queries them in table order.
 */
export type VocabularyEntry = {
  layerId: string;
  synonyms: string[];
  notes: string;
  gist: string;
};

export const VOCABULARY: VocabularyEntry[] = [
  { layerId: "osm-trails", synonyms: ["trail", "hike", "path", "day hike", "trail run"], notes: "whole hikes with lengthKm, gainM, shape under 2,500 km²; named routes up to 400,000 km²", gist: "hiking paths, or named hiking routes over wide areas" },
  { layerId: "fire-perimeters", synonyms: ["wildfire", "fire", "burn", "burned area"], notes: "fire outlines; also query fire-detections", gist: "current and past wildfire outlines with acres and year" },
  { layerId: "fire-detections", synonyms: ["active fire", "hotspot"], notes: "satellite heat sources from recent days, not smoke", gist: "satellite fire hotspots from the last few days" },
  { layerId: "forest-loss", synonyms: ["deforestation", "logging", "clearcut", "tree loss"], notes: "yearly loss; also query forest-alerts", gist: "where tree cover was lost, year by year" },
  { layerId: "forest-types", synonyms: ["primary forest", "plantation", "oil palm", "natural forest", "forest type"], notes: "ForTy classes 2020; convertedSince for natural forest converted since 2017", gist: "primary or regenerating forest, plantations and tree crops" },
  { layerId: "forest-alerts", synonyms: ["recent clearing", "new deforestation"], notes: "recent weekly alerts", gist: "weekly alerts of new forest clearing in the tropics" },
  { layerId: "snowpack", synonyms: ["snow", "snowpack", "SWE", "powder"], notes: "station snow depth v, SWE, density and type; not avalanche danger", gist: "live snow depth and new snow at mountain stations" },
  { layerId: "river-pulse", synonyms: ["river pulse", "flow changed", "discharge over", "river network"], notes: "a whole network's daily modelled flow, past 3 months and the forecast; for live gauge readings use streamflow", gist: "daily flow of a whole river network, played" },
  { layerId: "streamflow", synonyms: ["river flow", "cfs", "runoff", "gauge", "flood", "high water"], notes: "stream gauges; a river name itself is a geocode", gist: "live river flow against the usual at gauges" },
  { layerId: "forest-roads", synonyms: ["dispersed", "boondocking", "free camping", "forest road", "off-road", "4x4"], notes: "roads open to motor vehicles; also query campsites; dispersed-camping rules come from the ranger district", gist: "Forest Service roads legally open to motor vehicles" },
  { layerId: "campsites", synonyms: ["campground", "campsite", "camping"], notes: "established sites", gist: "campsites and parking lots from OpenStreetMap" },
  { layerId: "species", synonyms: ["wildlife", "species", "bird", "bears", "animals"], notes: "sighting records", gist: "recent wildlife and plant sightings from iNaturalist" },
  { layerId: "photos", synonyms: ["photos", "instagrammable", "geotag", "scenic photo spots"], notes: "geotagged pictures; density shows scenic spots", gist: "where geotagged photos were taken, as a density" },
  { layerId: "public-lands", synonyms: ["public land", "BLM", "national forest", "who owns", "boondock", "overnight parking", "public access"], notes: "land ownership", gist: "who owns and manages the land" },
  { layerId: "wilderness", synonyms: ["wilderness"], notes: "protected wilderness areas", gist: "boundaries of designated US wilderness areas" },
  { layerId: "physical-regions", synonyms: ["region", "the Andes", "the Rockies", "mountain range", "plateau"], notes: "named landform regions", gist: "outlines of named mountain ranges, deserts and plateaus" },
  { layerId: "night-lights", synonyms: ["night sky", "light pollution", "dark sky", "stargazing", "darkest skies", "milky way"], notes: "satellite night brightness", gist: "satellite picture of artificial light at night" },
  { layerId: "population", synonyms: ["population", "how many people", "density"], notes: "residents per area", gist: "where people live, as a 2020 density map" },
  { layerId: "popularity-campsites", synonyms: ["busiest campgrounds", "crowded campsites"], notes: "camp site scores", gist: "estimated popularity score for each campsite in view" },
  { layerId: "popularity", synonyms: ["crowded", "busy", "popular", "congestion", "foot traffic"], notes: "trails; see popularity-campsites", gist: "estimated popularity score for each trail in view" },
  { layerId: "remoteness", synonyms: ["remote", "untouched", "off the grid", "solitude"], notes: "estimate computed from other layers", gist: "how far each hexagon is from roads and camps" },
  { layerId: "mtb-trails", synonyms: ["mountain biking", "mtb", "singletrack", "flow trail", "bike park", "blue trail", "green trail", "black diamond", "flowy", "jump line"], notes: "v = 0-6 difficulty, imba = trail color (2 blue)", gist: "mountain bike trails rated 0 to 6" },
  { layerId: "ski-routes", synonyms: ["skiing", "ski touring", "nordic", "piste"], notes: "ski runs and routes, v = 1-6 difficulty", gist: "downhill runs, nordic trails and ski touring routes" },
  { layerId: "climbing", synonyms: ["climbing", "bouldering", "crag"], notes: "crags and boulders, v = route count", gist: "climbing crags, boulders and areas with route counts" },
  { layerId: "paddling", synonyms: ["whitewater", "kayaking", "canoe", "rafting", "rapids", "put-in", "paddling"], notes: "rapids and canoe routes, v = class 1-6; always with streamflow", gist: "rapids, river sections, put-ins and canoe routes" },
  { layerId: "outdoor-features", synonyms: ["hut", "shelter", "water spring", "water source", "viewpoint", "cave", "hot spring", "waterfall", "summit", "saddle", "mountain pass"], notes: "backcountry points, filter by kind; peaks have v = elevation; for water sources also query lakes", gist: "huts, springs, viewpoints, caves, waterfalls and passes" },
  { layerId: "lakes", synonyms: ["lake", "how deep is the lake", "tarn"], notes: "named lakes and reservoirs, v = max depth in metres (null if unknown); name finds one lake; how full a reservoir is goes to reservoir-levels", gist: "named lakes and reservoirs with maximum depth" },
  { layerId: "gbif-occurrences", synonyms: ["occurrence records", "range map", "specimens", "museum records"], notes: "worldwide species records by Latin name; density true for a world map; see species", gist: "species records by scientific name, or world density" },
  { layerId: "critical-habitat", synonyms: ["critical habitat", "threatened species", "endangered"], notes: "USFWS designated habitat; name a species to filter", gist: "designated habitat for threatened and endangered species" },
  { layerId: "grazing-allotments", synonyms: ["cattle", "grazing", "ranching", "wild horses", "burros", "allotment"], notes: "BLM grazing areas and wild horse and burro herds", gist: "BLM grazing allotments and wild horse and burro areas" },
  { layerId: "protected-areas-world", synonyms: ["protected area", "nature reserve", "marine reserve", "national park boundary"], notes: "named parks and reserves at every size up to a continent; non-commercial licence", gist: "named parks and reserves worldwide, with designation and area" },
  { layerId: "terrain", synonyms: ["slope angle", "avalanche terrain", "steepness", "aspect", "north-facing", "shade"], notes: "mode slope (minSlope), aspect or shade (date, period); not an avalanche forecast; crags and trails already carry aspect and climb", gist: "slope angle, aspect and afternoon shade from elevation" },
  { layerId: "fire-hazard", synonyms: ["fire risk", "fire hazard", "fire-prone"], notes: "US long-run hazard ranking, not a forecast; see fire-perimeters", gist: "long-run wildfire hazard potential in five classes" },
  { layerId: "flood-zones", synonyms: ["floodplain", "flood zone", "flood risk", "FEMA"], notes: "FEMA zones, drawn only at zoom 14 or closer; streamflow is live", gist: "FEMA flood hazard zones, drawn when zoomed in" },
  { layerId: "drought", synonyms: ["drought", "dry spell", "water shortage"], notes: "weekly US categories D0-D4, weeks input", gist: "weekly US drought categories D0 to D4" },
  { layerId: "glaciers", synonyms: ["glacier", "ice field", "ice cap", "glacier retreat"], notes: "dated outlines, v = area km2; scrubber plays retreat", gist: "glacier outlines with area, one per survey date" },
  { layerId: "peaks", synonyms: ["peaks", "highest peak", "tallest mountain", "prominence", "volcano", "elevation"], notes: "named peaks, v = elevation m; prominence property", gist: "named peaks and volcanoes with elevation and prominence" },
  { layerId: "recreation-sites", synonyms: ["trailhead", "recreation area", "picnic area", "day use", "visitor center", "OHV"], notes: "USFS and BLM developed sites, filter by kind", gist: "developed federal sites: trailheads, campgrounds, ramps, day use" },
  { layerId: "wikipedia-nearby", synonyms: ["history of this place", "tell me about", "what is that", "landmark", "points of interest", "Wikipedia"], notes: "articles in view; quote extract, link url", gist: "Wikipedia articles about places in the view" },
  { layerId: "geology", synonyms: ["geology", "geologic map", "rock types", "bedrock"], notes: "map tiles only; for one spot use geologic-unit", gist: "geologic map of rock units, drawn as tiles" },
  { layerId: "geologic-unit", synonyms: ["what rock", "made of", "rock age", "how old is the rock"], notes: "the unit under one point; pass lon and lat", gist: "the rock unit, age and type at one point" },
  { layerId: "surf", synonyms: ["surf", "swell", "waves", "wave height", "buoy"], notes: "live NOAA buoys, v = wave height m; forecast true for days ahead, season for typical months", gist: "live wave height and period at ocean buoys" },
  { layerId: "tides", synonyms: ["tide", "high tide", "low tide", "tide chart", "tide pools"], notes: "live next highs and lows at US NOAA stations", gist: "next high and low tides at US stations" },
  { layerId: "fishing", synonyms: ["fishing", "fish", "boat ramp", "boat launch", "what's biting", "trout", "fly fishing"], notes: "access, ramps, piers, recent fish sightings, water temperature", gist: "fishing access, boat ramps, recent catches, water temperature" },
  { layerId: "weather-alerts", synonyms: ["warnings", "alerts", "red flag", "winter storm", "avalanche warning", "current weather"], notes: "live NWS alerts plus current weather, US only", gist: "active US weather warnings and the weather now" },
  { layerId: "earthquakes", synonyms: ["earthquake", "quake", "seismic", "tremor", "shaking"], notes: "USGS events, v = magnitude M; days input", gist: "recent earthquakes with magnitude, depth and time" },
  { layerId: "smoke", synonyms: ["smoke", "smoky", "wildfire smoke", "haze"], notes: "daily NOAA plume outlines, v = density 1-3; date, days", gist: "daily wildfire smoke plume outlines by density" },
  { layerId: "fire-weather", synonyms: ["fire danger", "fire weather", "fire weather index"], notes: "forecast danger from weather, not fires; date up to about 9 days ahead", gist: "fire danger forecast from weather, up to 9 days" },
  { layerId: "burn-severity", synonyms: ["burn severity", "how badly burned", "how bad the burn", "burn scar", "MTBS"], notes: "US large-fire severity map, year input; named fires are fire-perimeters", gist: "how badly large US fires burned, by year" },
  { layerId: "greenness", synonyms: ["greenness", "how green", "vegetation", "NDVI", "green-up"], notes: "16-day satellite composite, date input", gist: "how green the vegetation is, every 16 days" },
  { layerId: "phenology", synonyms: ["spring arrival", "leaf-out", "bloom", "early spring"], notes: "US days early or late vs normal; stage, date, year", gist: "whether spring leaf-out and bloom came early or late" },
  { layerId: "snow-cover", synonyms: ["snow cover", "snow line", "snow depth", "is there snow", "snow free", "still snow"], notes: "daily satellite snow, date input; depth true for US depth", gist: "daily satellite map of snow-covered ground" },
  { layerId: "sea-ice", synonyms: ["sea ice", "arctic ice", "pack ice", "ice extent"], notes: "daily polar maps, date input", gist: "daily Arctic and Antarctic sea ice maps" },
  { layerId: "land-cover", synonyms: ["land cover", "land use", "cropland", "built-up", "tree cover"], notes: "WorldCover 2021; nlcd true with year for US", gist: "what covers the ground: trees, crops, towns, water" },
  { layerId: "surface-water", synonyms: ["surface water", "water rise", "water level", "lake shrink", "did the lake shrink", "water history", "reservoir change"], notes: "1984-2021 history, not dated; product change for rise or shrink; before flood-extent", gist: "where surface water was seen from 1984 to 2021" },
  { layerId: "flood-extent", synonyms: ["flooded now", "flooding", "inundation", "flood extent"], notes: "flood water only, observed over the last 12 days (Copernicus GFM); permanent water is not drawn", gist: "where flood water was seen in the last 12 days" },
  { layerId: "disturbance", synonyms: ["vegetation loss", "disturbance", "land clearing", "storm damage"], notes: "daily satellite alerts since 2023, date input", gist: "where vegetation was just lost or damaged" },
  { layerId: "sequoia-groves", synonyms: ["sequoia", "giant sequoia grove"], notes: "Sierra Nevada groves; also query sequoia-mortality", gist: "the 96 giant sequoia groves of the Sierra Nevada" },
  { layerId: "sea-level-trends", synonyms: ["sea level", "rising seas"], notes: "tide-gauge trend, v = mm/yr", gist: "measured sea level trend at tide gauges, mm/yr" },
  { layerId: "sequoia-mortality", synonyms: ["sequoia fire deaths", "sequoias killed"], notes: "trees alive or dead after the 2020 and 2021 Sierra fires", gist: "giant sequoias alive or dead after the 2020-2021 fires" },
  { layerId: "reservoir-levels", synonyms: ["reservoir", "Lake Powell", "Lake Mead", "lake level", "how full is the lake"], notes: "major western reservoirs, v = storage acre-feet; elevationFt is the quoted level, pctFull, series; provisional", gist: "live storage, level and percent full of western reservoirs" },
  { layerId: "sea-level-rise", synonyms: ["sea level rise", "flooding by 2050", "coastal flooding"], notes: "US flood map for feet 0-10 of rise; 1 ft is about 2050", gist: "US coast flooded by a chosen feet of rise" },
  { layerId: "old-growth", synonyms: ["old growth", "mature forest"], notes: "federal old-growth and mature forest per fireshed (about 250k acres), acres", gist: "federal old-growth and mature forest acres per fireshed" },
  { layerId: "carbon-flux", synonyms: ["carbon", "carbon sink", "forest carbon"], notes: "forest CO2 sink or source tiles; product net-flux, emissions, removals", gist: "whether forests take up or give off carbon" },
  { layerId: "condor-range", synonyms: ["condor"], notes: "current and early-1800s range outlines, not sightings", gist: "California condor range today and in the early 1800s" },
  { layerId: "dams", synonyms: ["dam", "hydropower"], notes: "US National Inventory of Dams, v = storage acre-feet, t = year built (scrubber plays by decade); hazard is consequence, not safety", gist: "US dams with storage, height, purpose and year built" },
  { layerId: "wolf-packs", synonyms: ["wolf", "wolves"], notes: "Washington state pack ranges 2014-2025 only; year input", gist: "Washington state wolf pack ranges by year, 2014-2025" },
  { layerId: "methane-plumes", synonyms: ["methane", "emissions", "super-emitter"], notes: "Carbon Mapper plumes and sources, v = kg/h; days input", gist: "methane leak plumes seen from aircraft and satellites" },
  { layerId: "ports", synonyms: ["port", "busiest port", "shipping", "cargo"], notes: "150 US principal ports, v = 2023 short tons", gist: "the 150 principal US ports by 2023 cargo" },
  { layerId: "river-basins", synonyms: ["river basin", "watershed", "drainage basin", "HUC"], notes: "US hydrologic units, level follows zoom (huc2 regions to huc10); v = area km2", gist: "US watersheds: the land draining to one river" },
  { layerId: "hardiness-zones", synonyms: ["hardiness zone", "growing zone", "planting zone"], notes: "USDA 2023 winter-cold bands, lower 48; tiles, zone not readable", gist: "USDA 2023 plant hardiness zones, drawn as tiles" },
  { layerId: "temperature-anomaly", synonyms: ["warming", "temperature anomaly", "hotter than normal"], notes: "lower-48 counties, v = °F vs 1901-2000; period, months", gist: "how much warmer than normal each US county was" },
  { layerId: "pipelines-lines", synonyms: ["pipeline", "transmission line", "power line"], notes: "gas, oil, products pipelines and 100 kV+ power lines; network, minKv inputs", gist: "gas and oil pipelines and high-voltage power lines" },
  { layerId: "aquifers", synonyms: ["aquifer", "Ogallala", "High Plains aquifer"], notes: "US aquifer outlines by rock type (regional, 2003); for well water levels use groundwater", gist: "outlines of the principal US aquifers by rock type" },
  { layerId: "groundwater", synonyms: ["groundwater", "water table", "depth to water", "well water level", "is the aquifer dropping"], notes: "USGS well measurements, v = depth to water in feet, one reading per well, no trend; see aquifers", gist: "depth to groundwater at USGS wells, newest reading" },
  { layerId: "power-plants", synonyms: ["power plant", "wind farm", "solar farm", "wind turbine"], notes: "EIA plants by fuel (source plants), USGS turbines and solar with year online; v = MW", gist: "US power plants, wind turbines and solar by megawatts" },
  { layerId: "disasters", synonyms: ["disasters", "hurricane", "disaster declaration"], notes: "GDACS alerts worldwide, FEMA county declarations; days, years", gist: "world disaster alerts and FEMA declarations by county" },
  { layerId: "monuments", synonyms: ["national monument", "Bears Ears", "Grand Staircase", "conservation area"], notes: "BLM monuments now vs 2021 (kind), v = area km2; compare the two for then vs now", gist: "BLM national monuments now and their 2021 boundaries" },
  { layerId: "tree-mortality", synonyms: ["tree mortality", "beetle kill", "dead trees", "die-off"], notes: "aerial survey tree death by year; California to 2019, US 2021-2025; years input", gist: "where trees died each year, from aerial surveys" },
  { layerId: "permafrost", synonyms: ["permafrost", "frozen ground", "thawing ground"], notes: "northern zones, kind = continuous to isolated; canada true for NRCan tiles", gist: "northern permafrost zones from continuous to isolated" },
  { layerId: "mining-claims", synonyms: ["mining claim", "claims", "lode claim", "placer claim"], notes: "BLM claims on public land, status active or closed, v = acres; shapes are survey-grid squares, not corners", gist: "active and closed BLM mining claims on public land" },
  { layerId: "imagery-by-date", synonyms: ["satellite image on a date", "before and after", "satellite photo", "fall color", "foliage", "leaves changing"], notes: "30 m true colour for date, nearest pass; compare two days", gist: "true-colour 30 m satellite picture on a chosen day" },
  { layerId: "mines", synonyms: ["mine", "abandoned mine", "mineral deposit", "prospect", "quarry"], notes: "USGS historic mine records (about 2011) and old-map mine symbols; kind = commodity or feature type; commodity input", gist: "US mines, prospects and mineral deposits by commodity" },
  { layerId: "uranium", synonyms: ["uranium", "mill tailings", "radioactive"], notes: "Navajo Nation abandoned mines (v = 2007 hazard score) and DOE mill-tailings sites; other uranium mines are in mines", gist: "Navajo Nation abandoned uranium mines and mill-tailings sites" },
  { layerId: "ocean-currents", synonyms: ["currents", "tidal current", "ocean current", "slack water"], notes: "hourly surface currents as moving particles, with the tide plotted", gist: "hourly ocean and tidal currents as moving particles" },
  { layerId: "wind-flow", synonyms: ["wind", "windiest", "windy", "gusty", "wind direction"], notes: "hourly 10 m wind forecast as moving particles, today and the next days", gist: "hourly wind forecast drawn as moving particles" },
  { layerId: "weather-forecast", synonyms: ["forecast", "will it rain", "too hot", "too cold", "temperature", "gusts", "tomorrow's weather"], notes: "7-day hourly forecast at the place: temperature, rain chance and amount, wind and gusts; saturday and sunday lines", gist: "seven-day hourly weather forecast at the asked place" },
  { layerId: "avalanche", synonyms: ["avalanche danger", "avalanche forecast", "avalanche risk", "avy"], notes: "US avalanche centers' daily danger by zone; quote the center and link it, never infer from weather", gist: "daily avalanche danger by US forecast zone" },
  { layerId: "vegetation-types", synonyms: ["vegetation type", "what grows", "ecosystems"], notes: "LANDFIRE named types with shares, lower 48", gist: "named vegetation types and their shares" },
  { layerId: "ecoregions", synonyms: ["ecoregion", "biome", "ecological region"], notes: "EPA Level III/IV, RESOLVE outside US; shares", gist: "named ecoregion outlines with their shares" },
  { layerId: "canopy-height", synonyms: ["tree height", "how tall", "canopy height"], notes: "1 m canopy height; median, p90, tallest in box", gist: "how tall the trees are, worldwide" },
];

/** One line per layer: id, its synonyms, then a short note. */
export function vocabularyForPrompt(): string {
  return VOCABULARY.map((e) => `- ${e.layerId}: ${e.synonyms.join(", ")} (${e.notes})`).join("\n");
}

/** list_layers' 6-to-10-word description of a layer; empty when the layer has no entry. */
export function gistFor(layerId: string): string {
  return VOCABULARY.find((e) => e.layerId === layerId)?.gist ?? "";
}

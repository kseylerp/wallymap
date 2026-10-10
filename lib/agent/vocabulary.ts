/**
 * Routes the words people use to the data layers that answer them. The table is
 * rendered into the system prompt and echoed by list_layers, so keep it short.
 * When a question matches several layers, the model queries them in table order.
 */
export type VocabularyEntry = {
  layerId: string;
  synonyms: string[];
  notes: string;
};

export const VOCABULARY: VocabularyEntry[] = [
  { layerId: "osm-trails", synonyms: ["trail", "hike", "path"], notes: "named footpaths and tracks" },
  { layerId: "fire-perimeters", synonyms: ["wildfire", "fire", "burn", "burned area"], notes: "fire outlines; also query fire-detections" },
  { layerId: "fire-detections", synonyms: ["active fire", "hotspot"], notes: "satellite heat sources from recent days, not smoke" },
  { layerId: "forest-loss", synonyms: ["deforestation", "logging", "clearcut", "tree loss"], notes: "yearly loss; also query forest-alerts" },
  { layerId: "forest-alerts", synonyms: ["recent clearing", "new deforestation"], notes: "recent weekly alerts" },
  { layerId: "snowpack", synonyms: ["snow", "snowpack", "SWE", "snow type", "powder", "new snow"], notes: "station snow depth v, with SWE, density and type (powder, settled, wet); not avalanche danger" },
  { layerId: "streamflow", synonyms: ["river flow", "cfs", "runoff", "gauge", "flood", "high water"], notes: "stream gauges; a river name itself is a geocode" },
  { layerId: "forest-roads", synonyms: ["dispersed", "boondocking", "free camping", "forest road", "off-road", "4x4"], notes: "roads open to motor vehicles; also query campsites; cannot say where dispersed camping is allowed, so tell the user to check the ranger district" },
  { layerId: "campsites", synonyms: ["campground", "campsite", "camping"], notes: "established sites" },
  { layerId: "species", synonyms: ["wildlife", "species", "birds", "bird", "birding", "bears", "animals"], notes: "sighting records" },
  { layerId: "photos", synonyms: ["photos", "instagrammable", "geotag", "scenic photo spots"], notes: "geotagged pictures; photo density shows scenic spots" },
  { layerId: "public-lands", synonyms: ["public land", "BLM", "national forest", "who owns"], notes: "land ownership" },
  { layerId: "wilderness", synonyms: ["wilderness", "designated wilderness"], notes: "protected wilderness areas" },
  { layerId: "physical-regions", synonyms: ["region", "the Andes", "the Rockies", "mountain range", "plateau"], notes: "named landform regions" },
  { layerId: "night-lights", synonyms: ["night sky", "light pollution", "dark sky", "stargazing"], notes: "satellite night brightness" },
  { layerId: "population", synonyms: ["population", "how many people", "density"], notes: "residents per area" },
  { layerId: "popularity-campsites", synonyms: ["busiest campgrounds", "crowded campsites"], notes: "camp site scores" },
  { layerId: "popularity", synonyms: ["crowded", "busy", "popular", "congestion", "foot traffic"], notes: "trails; see popularity-campsites" },
  { layerId: "remoteness", synonyms: ["remote", "untouched", "off the grid", "solitude"], notes: "estimate computed from other layers" },
  { layerId: "mtb-trails", synonyms: ["mountain biking", "mountain bike", "mtb", "singletrack", "flow trail", "bike park"], notes: "rated bike trails, v = 0-6 difficulty" },
  { layerId: "ski-routes", synonyms: ["skiing", "ski touring", "backcountry skiing", "nordic", "cross-country skiing", "piste"], notes: "ski runs and routes, v = 1-6 difficulty" },
  { layerId: "climbing", synonyms: ["climbing", "bouldering", "crag", "rock climbing", "sport climbing"], notes: "crags and boulders, v = route count" },
  { layerId: "paddling", synonyms: ["whitewater", "kayaking", "canoe", "rafting", "rapids", "put-in", "paddling"], notes: "rapids and canoe routes, v = class 1-6; check streamflow" },
  { layerId: "outdoor-features", synonyms: ["hut", "shelter", "water spring", "water source", "viewpoint", "cave", "hot spring", "waterfall", "summit", "saddle", "mountain pass"], notes: "backcountry points, filter by kind; peaks have v = elevation" },
  { layerId: "lakes", synonyms: ["lake", "lake depth", "how deep is the lake", "tarn"], notes: "named lakes and reservoirs, v = max depth in metres, null when not recorded; use name to find one lake" },
  { layerId: "gbif-occurrences", synonyms: ["occurrence records", "range map", "specimens", "museum records"], notes: "worldwide species records by Latin name; density true for a world map; see species" },
  { layerId: "critical-habitat", synonyms: ["endangered species habitat", "critical habitat", "threatened species", "endangered"], notes: "USFWS designated habitat; name a species to filter" },
  { layerId: "grazing-allotments", synonyms: ["cattle", "grazing", "ranching", "wild horses", "burros", "allotment"], notes: "BLM grazing areas and wild horse and burro herds" },
  { layerId: "protected-areas-world", synonyms: ["protected area", "nature reserve", "marine reserve", "national park boundary"], notes: "worldwide picture, not countable; non-commercial licence" },
  { layerId: "fire-hazard", synonyms: ["fire risk", "fire hazard", "fire-prone"], notes: "US long-run hazard ranking, not a forecast; see fire-perimeters" },
  { layerId: "flood-zones", synonyms: ["floodplain", "flood zone", "flood risk", "FEMA"], notes: "FEMA zones, drawn only at zoom 14 or closer; streamflow is live" },
  { layerId: "drought", synonyms: ["drought", "dry spell", "water shortage"], notes: "weekly US categories D0-D4, weeks input" },
  { layerId: "glaciers", synonyms: ["glacier", "ice field", "ice cap"], notes: "glacier outlines, v = area km2" },
  { layerId: "peaks", synonyms: ["peaks", "highest peak", "tallest mountain", "prominence", "volcano", "elevation"], notes: "named peaks, v = elevation m; prominence property" },
  { layerId: "recreation-sites", synonyms: ["trailhead", "recreation area", "picnic area", "day use", "visitor center", "OHV"], notes: "USFS and BLM developed sites, filter by kind" },
  { layerId: "wikipedia-nearby", synonyms: ["history of this place", "tell me about", "what is that", "landmark", "points of interest", "Wikipedia"], notes: "articles in view; quote extract, link url" },
  { layerId: "geology", synonyms: ["geology", "geologic map", "rock types", "bedrock"], notes: "map tiles only; for one spot use geologic-unit" },
  { layerId: "geologic-unit", synonyms: ["what rock", "made of", "rock age", "how old is the rock"], notes: "the unit under one point; pass lon and lat" },
  { layerId: "surf", synonyms: ["surf", "swell", "waves", "wave height", "buoy"], notes: "live NOAA buoys, v = wave height m; forecast true for days ahead, season for typical months" },
  { layerId: "tides", synonyms: ["tide", "high tide", "low tide", "tide chart", "tide pools"], notes: "live next highs and lows at US NOAA stations" },
  { layerId: "fishing", synonyms: ["fishing", "fish", "fishing access", "where to fish", "boat ramp", "boat launch", "what's biting"], notes: "access, ramps, piers, recent fish sightings, water temperature" },
  { layerId: "weather-alerts", synonyms: ["warnings", "alerts", "weather warning", "red flag", "winter storm", "avalanche warning", "current weather"], notes: "live NWS alerts plus current weather, US only" },
  { layerId: "earthquakes", synonyms: ["earthquake", "quake", "seismic", "tremor", "shaking"], notes: "USGS events, v = magnitude M; days input" },
  { layerId: "smoke", synonyms: ["smoke", "wildfire smoke", "smoke plume", "haze"], notes: "daily NOAA plume outlines, v = density 1-3; date, days" },
  { layerId: "fire-weather", synonyms: ["fire danger", "fire weather", "fire weather index"], notes: "forecast danger from weather, not fires; date up to about 9 days ahead" },
  { layerId: "burn-severity", synonyms: ["burn scar", "fire history", "past fires", "MTBS"], notes: "US large-fire footprints, year input" },
  { layerId: "greenness", synonyms: ["greenness", "how green", "vegetation", "NDVI", "green-up"], notes: "16-day satellite composite, date input" },
  { layerId: "phenology", synonyms: ["spring arrival", "leaf-out", "bloom", "early spring"], notes: "US days early or late vs normal; stage, date, year" },
  { layerId: "snow-cover", synonyms: ["snow cover", "snow line", "snow depth", "is there snow"], notes: "daily satellite snow, date input; depth true for US depth" },
  { layerId: "sea-ice", synonyms: ["sea ice", "arctic ice", "pack ice", "ice extent"], notes: "daily polar maps, date input" },
  { layerId: "land-cover", synonyms: ["land cover", "land use", "cropland", "built-up", "tree cover"], notes: "WorldCover 2021; nlcd true with year for US" },
  { layerId: "surface-water", synonyms: ["surface water", "did the lake shrink", "water history", "reservoir change"], notes: "1984-2021 history, product input; not dated" },
  { layerId: "flood-extent", synonyms: ["flooding", "flooded", "inundation", "flood extent"], notes: "daily satellite water maps, date input" },
  { layerId: "disturbance", synonyms: ["vegetation loss", "disturbance", "land clearing", "storm damage"], notes: "daily satellite alerts since 2023, date input" },
  { layerId: "sequoia-groves", synonyms: ["sequoia", "giant sequoia grove"], notes: "Sierra Nevada groves; also query sequoia-mortality" },
  { layerId: "sea-level-trends", synonyms: ["sea level", "rising seas"], notes: "tide-gauge trend, v = mm/yr" },
  { layerId: "sequoia-mortality", synonyms: ["sequoia fire deaths", "sequoias killed"], notes: "trees alive or dead after the 2020 and 2021 Sierra fires" },
  { layerId: "reservoir-levels", synonyms: ["reservoir", "reservoir level", "Lake Powell", "Lake Mead", "lake level", "how full is the lake"], notes: "major western reservoirs, v = storage acre-feet; elevationFt is the quoted level, pctFull, series; provisional" },
  { layerId: "sea-level-rise", synonyms: ["sea level rise", "flooding by 2050", "coastal flooding"], notes: "US flood map for feet 0-10 of rise; 1 ft is about 2050" },
  { layerId: "old-growth", synonyms: ["old growth", "mature forest"], notes: "federal old-growth and mature forest per fireshed (about 250k acres), acres" },
  { layerId: "carbon-flux", synonyms: ["carbon", "carbon sink", "forest carbon"], notes: "forest CO2 sink or source tiles; product net-flux, emissions, removals" },
  { layerId: "condor-range", synonyms: ["condor", "California condor"], notes: "current and early-1800s range outlines, not sightings" },
  { layerId: "dams", synonyms: ["dam", "dams", "hydropower", "dam safety"], notes: "US National Inventory of Dams, v = storage acre-feet, t = year built (scrubber plays by decade); hazard is consequence, not safety" },
];

/** One line per layer: id, its synonyms, then a short note. */
export function vocabularyForPrompt(): string {
  return VOCABULARY.map((e) => `- ${e.layerId}: ${e.synonyms.join(", ")} (${e.notes})`).join("\n");
}

/** Synonyms for one layer; empty when the layer has no entry. */
export function synonymsFor(layerId: string): string[] {
  return VOCABULARY.find((e) => e.layerId === layerId)?.synonyms ?? [];
}

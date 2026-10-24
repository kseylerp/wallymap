/**
 * Prints the README layer table (markdown) from the layer registry.
 *
 *   pnpm exec tsx scripts/layer-table.mts            # print to stdout
 *   pnpm exec tsx scripts/layer-table.mts --write    # replace the block between
 *                                                    # <!-- layers:start --> and <!-- layers:end --> in README.md
 *                                                    # and docs/layers.md (and the layer count before it)
 *
 * id, title, coverage, area and key columns come from the registry. "Area (km²)" gives the soft cap (maxAreaKm2: all
 * features up to it) and, for a layer with a wide strategy, the hard cap up to which it still answers with its largest
 * or named features ranked by one field; past the hard cap a query is a zoom_in error. "Shows", "Source" and
 * "Freshness" are not on the Layer type, so they are written here; the script throws
 * when a registered layer has no entry, so the table cannot silently go stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { listLayers, type Layer } from "@/layers";
import { hardMaxAreaKm2 } from "@/layers/types";

const META: Record<string, { shows: string; source: string; freshness: string; coverage?: string }> = {
  "osm-trails": { shows: "Hiking paths and tracks with difficulty and surface", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  "fire-perimeters": { shows: "Current and past US wildfire outlines", source: "NIFC (WFIGS)", freshness: "Updated through the fire season" },
  "fire-detections": { shows: "Satellite hotspots from the last 1 to 10 days", source: "NASA FIRMS", freshness: "Near real time (hours)" },
  "forest-loss": { shows: "Where tree cover was lost, by year", source: "UMD / Global Forest Watch", freshness: "Yearly" },
  "forest-types": { shows: "Primary, regenerating and planted forest, plantations, tree crops; natural forest converted since a year", source: "ForTy (Google DeepMind, WRI, IIASA) via Earth Engine", freshness: "2020 baseline; yearly beta 2017–2025" },
  "forest-alerts": { shows: "Recent forest clearing in the tropics", source: "Global Forest Watch (GLAD, RADD)", freshness: "Weekly", coverage: "Tropics (30°S to 30°N)" },
  snowpack: { shows: "Snow depth, water equivalent, density and snow type at mountain weather stations", source: "USDA NRCS SNOTEL", freshness: "Live (hourly readings)", coverage: "Western US" },
  "forest-roads": { shows: "Forest Service roads open to motor vehicles", source: "USDA Forest Service MVUM", freshness: "Yearly" },
  campsites: { shows: "Campsites and parking lots", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  streamflow: { shows: "River flow, gauge height and flow against the usual for the day at stream gauges", source: "USGS Water Data", freshness: "Live (15 minutes), provisional" },
  "river-pulse": { shows: "Named rivers' daily flow, past three months and the forecast, played day by day (width flow, color against the median); the total is the flow to the sea", source: "GloFAS via Open-Meteo; Natural Earth rivers", freshness: "Daily model, built once a day into one file" },
  "ocean-currents": { shows: "Surface and tidal currents hour by hour as moving particles, with the tide at the nearest station", source: "Open-Meteo Marine (Météo-France SMOC); NOAA CO-OPS", freshness: "Hourly forecast (cached 3 hours)" },
  "wind-flow": { shows: "Wind 10 m above the ground hour by hour as moving particles, colored by temperature", source: "Open-Meteo forecast", freshness: "Hourly forecast (cached 1 hour)" },
  species: { shows: "Wildlife and plant sightings", source: "iNaturalist", freshness: "Daily" },
  population: { shows: "Where people live", source: "NASA GIBS (GPW v4)", freshness: "Fixed at 2020" },
  "night-lights": { shows: "Satellite picture of the Earth at night", source: "NASA GIBS (VIIRS)", freshness: "Daily (date in the note)" },
  wilderness: { shows: "Designated wilderness boundaries", source: "Wilderness.net / USGS", freshness: "Updated occasionally" },
  photos: { shows: "Where geotagged photos were taken", source: "Wikimedia Commons, Mapillary", freshness: "Live" },
  "physical-regions": { shows: "Named mountain ranges, deserts and plateaus", source: "Natural Earth", freshness: "Static" },
  "public-lands": { shows: "Who owns and manages the land", source: "USGS PAD-US 4.1", freshness: "Static (release 4.1)" },
  popularity: { shows: "Estimated popularity score (0 to 100) per trail", source: "Computed from OSM, Commons, Mapillary", freshness: "Computed per query" },
  "popularity-campsites": { shows: "Estimated popularity score (0 to 100) per campsite", source: "Computed from OSM, Commons, Mapillary", freshness: "Computed per query" },
  remoteness: { shows: "Remoteness score (0 to 100) per hexagon", source: "Computed from OSM and wilderness boundaries", freshness: "Computed per query" },
  "mtb-trails": { shows: "Mountain bike trails rated 0 to 6 on the Singletrack Scale", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  earthquakes: { shows: "Recent earthquakes with magnitude, depth and time", source: "USGS Earthquake Catalog", freshness: "Live (minutes)" },
  "ski-routes": { shows: "Downhill runs, nordic trails and ski touring routes", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  "recreation-sites": { shows: "Developed recreation sites: campgrounds, trailheads, boat ramps, day use", source: "USDA Forest Service, BLM", freshness: "Nightly feeds" },
  glaciers: { shows: "Glacier and ice cap outlines with area", source: "GLIMS (NSIDC)", freshness: "Static (survey dates per glacier)" },
  geology: { shows: "Geologic map units by rock family, darker for older rock; the main units in the view by name, age and share", source: "Macrostrat", freshness: "Static" },
  climbing: { shows: "Climbing crags, boulders and areas with route counts", source: "OpenStreetMap, OpenBeta", freshness: "Live (cached up to a day)" },
  "critical-habitat": { shows: "Designated critical habitat for threatened and endangered species", source: "US Fish and Wildlife Service", freshness: "Updated as designated" },
  "grazing-allotments": { shows: "Livestock grazing allotments and wild horse and burro areas", source: "Bureau of Land Management", freshness: "Updated occasionally" },
  paddling: { shows: "Rapids, river sections, put-ins and canoe routes", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  "gbif-occurrences": { shows: "Species records by scientific name, or a world density map", source: "GBIF", freshness: "Daily" },
  surf: { shows: "Wave height, period and direction at buoys; forecast and typical months", source: "NOAA NDBC, Open-Meteo Marine", freshness: "Live (under an hour)" },
  peaks: { shows: "Named peaks with elevation and prominence; on request the lowest point in view", source: "OpenStreetMap, Wikidata; AWS Terrain Tiles for the lowest point", freshness: "Live (community edits)" },
  terrain: { shows: "Slope classes, the way slopes face, ground in its own shade, and elevation bands with contours", source: "Computed from AWS Terrain Tiles (USGS 3DEP, SRTM)", freshness: "Static elevation" },
  "weather-forecast": { shows: "Seven-day hourly weather forecast at the asked place and across the view", source: "NWS; Open-Meteo", freshness: "Hourly forecast" },
  avalanche: { shows: "Today's avalanche danger by forecast zone on the North American scale", source: "US avalanche centers via avalanche.org", freshness: "Daily in season", coverage: "US" },
  "elevation-profile": { shows: "Elevation cross-section along a straight line from A to B: climb, steepest 100 m, chart", source: "Computed from AWS Terrain Tiles (USGS 3DEP, SRTM)", freshness: "Static elevation" },
  greenness: { shows: "How green the vegetation is (NDVI or EVI)", source: "NASA GIBS (MODIS Terra)", freshness: "Every 16 days, back to 2000" },
  "protected-areas-world": { shows: "Protected areas worldwide as map tiles", source: "WDPA (UNEP-WCMC, IUCN)", freshness: "Monthly" },
  "fire-hazard": { shows: "Long-run wildfire hazard potential in five classes", source: "USDA Forest Service (WHP 2023)", freshness: "Static (2023)" },
  "flood-zones": { shows: "FEMA flood hazard zones (zoom 14 and closer)", source: "FEMA National Flood Hazard Layer", freshness: "Updated as maps change" },
  "snow-cover": { shows: "Where the ground is snow-covered; US snow depth", source: "NASA GIBS (MODIS Terra), NOAA NOHRSC", freshness: "Daily, back to 2000" },
  "outdoor-features": { shows: "Huts, shelters, springs, viewpoints, caves, hot springs, waterfalls, passes", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  tides: { shows: "Next high and low tides at tide stations", source: "NOAA CO-OPS", freshness: "Live predictions and gauges" },
  "land-cover": { shows: "What covers the ground: trees, crops, built-up, water", source: "ESA WorldCover, USGS NLCD", freshness: "Static (2021; NLCD map years)" },
  "wikipedia-nearby": { shows: "Wikipedia articles about places in view", source: "Wikipedia", freshness: "Live" },
  "surface-water": { shows: "Where surface water has been seen, 1984 to 2021", source: "EC JRC Global Surface Water", freshness: "Static (1984 to 2021)" },
  "flood-extent": { shows: "Open water and floods from satellite", source: "NASA GIBS (OPERA, MODIS)", freshness: "Daily, a few days behind" },
  disturbance: { shows: "Where vegetation was just lost or damaged", source: "NASA GIBS (OPERA)", freshness: "Daily, about 3 days behind" },
  "sea-ice": { shows: "Sea ice concentration and extent", source: "NASA GIBS (GHRSST MUR, MODIS)", freshness: "Daily, back to 2000" },
  "fire-weather": { shows: "Fire danger forecast (Fire Weather Index)", source: "EC JRC GWIS / EFFIS", freshness: "Daily, up to 9 days ahead" },
  lakes: { shows: "Named lakes and reservoirs with maximum depth", source: "Wikidata", freshness: "Live (community edits)" },
  drought: { shows: "Weekly drought categories D0 to D4", source: "U.S. Drought Monitor (NDMC)", freshness: "Weekly" },
  phenology: { shows: "Whether spring leaf-out and bloom came early or late", source: "USA National Phenology Network", freshness: "Daily this year; yearly back to 1981", coverage: "Lower 48 states" },
  "burn-severity": { shows: "Burned areas of large fires, by year", source: "MTBS (USGS, USFS)", freshness: "Yearly, about 18 months behind" },
  smoke: { shows: "Wildfire smoke plumes by density", source: "NOAA Hazard Mapping System", freshness: "Daily", coverage: "North and Central America" },
  "geologic-unit": { shows: "The rock unit, age and rock type under one point", source: "Macrostrat", freshness: "Static" },
  fishing: { shows: "Fishing access, boat ramps, piers, recent fish sightings, water temperature", source: "OpenStreetMap, USFS, iNaturalist, USGS", freshness: "Live" },
  "weather-alerts": { shows: "Active weather warnings and the weather right now", source: "NOAA National Weather Service, Open-Meteo", freshness: "Live (minutes)" },
  "sequoia-groves": { shows: "The 96 giant sequoia groves", source: "NPS Sequoia and Kings Canyon, USFS", freshness: "Static (2024)", coverage: "Sierra Nevada, California" },
  "sea-level-trends": { shows: "Measured long-term sea level trend at tide gauges (mm/yr)", source: "NOAA CO-OPS", freshness: "Yearly" },
  "sequoia-mortality": { shows: "Giant sequoias alive or dead after the 2020 and 2021 fires", source: "USGS", freshness: "Static (post-fire surveys)", coverage: "Sequoia and Kings Canyon NPs" },
  "reservoir-levels": { shows: "Storage, level, percent full and history of major reservoirs", source: "US Bureau of Reclamation, California CDEC", freshness: "Daily, 1 to 2 days behind; provisional", coverage: "Western US" },
  "sea-level-rise": { shows: "Coastal land under water at high tide for 0 to 10 feet of rise", source: "NOAA Sea Level Rise Viewer", freshness: "Static scenarios" },
  "old-growth": { shows: "Old-growth and mature forest acres per fireshed", source: "US Forest Service", freshness: "Static (2023 inventory)" },
  dams: { shows: "Dams with storage, height, purpose, hazard and year built", source: "USACE National Inventory of Dams", freshness: "Updated yearly" },
  "carbon-flux": { shows: "Forest carbon sink or source per hectare per year", source: "Global Forest Watch (Harris et al.)", freshness: "Static (2001 to 2025 average)" },
  "condor-range": { shows: "California condor range today and in the early 1800s", source: "NPS Sequoia and Kings Canyon", freshness: "Static", coverage: "Western North America" },
  "wolf-packs": { shows: "Gray wolf pack ranges by year", source: "Washington Dept. of Fish and Wildlife", freshness: "Yearly (2014 to 2025)", coverage: "Washington state" },
  "methane-plumes": { shows: "Methane plumes and emission sources with rates", source: "Carbon Mapper (non-commercial)", freshness: "Days to weeks after each pass" },
  "river-basins": { shows: "Watersheds at a level that follows the zoom (HUC2 to HUC10)", source: "USGS Watershed Boundary Dataset", freshness: "Updated occasionally" },
  ports: { shows: "The 150 principal US ports by 2023 cargo tonnage", source: "USACE via BTS", freshness: "Yearly (2023)" },
  "hardiness-zones": { shows: "Plant hardiness zones as map tiles", source: "USDA-ARS, Oregon State PRISM", freshness: "Static (2023)", coverage: "Lower 48 states" },
  "temperature-anomaly": { shows: "County temperature against the 1901-2000 normal (°F)", source: "NOAA NCEI Climate at a Glance", freshness: "Monthly, about the 8th", coverage: "Lower 48 states" },
  aquifers: { shows: "Principal aquifer outlines by rock type", source: "USGS Principal Aquifers", freshness: "Static (2003)" },
  "pipelines-lines": { shows: "Gas, oil and products pipelines and high-voltage power lines", source: "EIA, HIFLD", freshness: "Updated occasionally" },
  groundwater: { shows: "Depth to water at monitoring wells (newest reading)", source: "USGS Water Data", freshness: "As wells are measured" },
  "power-plants": { shows: "Power plants by fuel, wind turbines and large solar, in MW", source: "EIA, USGS wind and solar databases", freshness: "Quarterly to yearly" },
  disasters: { shows: "Disaster alerts worldwide and FEMA declarations per US county", source: "GDACS, OpenFEMA", freshness: "Live (hourly)" },
  monuments: { shows: "BLM national monuments now and Utah's 2021 boundaries", source: "BLM, Utah AGRC", freshness: "Current (July 2026 changes)" },
  "tree-mortality": { shows: "Where trees died each year (beetles, drought, disease)", source: "USFS aerial survey, California DFW", freshness: "Yearly (California to 2019, US 2021 to 2025)" },
  permafrost: { shows: "Permafrost zones from continuous to isolated", source: "IPA Circum-Arctic map, NRCan", freshness: "Static", coverage: "Northern Hemisphere" },
  "mining-claims": { shows: "Active and closed mining claims on public land", source: "BLM MLRS", freshness: "Daily" },
  "imagery-by-date": { shows: "True-colour 30 m satellite picture on a chosen day", source: "NASA HLS (Landsat, Sentinel-2) via GIBS", freshness: "Every few days, about 2 days behind" },
  mines: { shows: "Mines, prospects and mineral deposits by commodity", source: "USGS MRDS, USMIN", freshness: "Static (about 2011)" },
  uranium: { shows: "Navajo Nation abandoned uranium mines and DOE mill-tailings sites", source: "Navajo Nation AUM program, DOE Legacy Management", freshness: "Static (2007 hazard scores)", coverage: "Western US" },
  faults: { shows: "Faults that moved in the last 1.6 million years, by age, slip rate and how well located", source: "USGS Quaternary Fault and Fold Database", freshness: "Static (2020 release)" },
  soils: { shows: "Soil map units by surface texture, with drainage, depth to bedrock and hydrologic group", source: "USDA NRCS SSURGO (Soil Data Access)", freshness: "Static (yearly survey updates)" },
};

function coverageText(l: Layer): string {
  const override = META[l.id]?.coverage;
  if (override) return override;
  if (l.coverage === "global") return "Global";
  if (l.coverage === "us") return "US";
  return `Box ${l.coverage.bbox.join(", ")}`;
}

function keyText(l: Layer): string {
  const parts = [
    ...l.requiredEnv.map((n) => `\`${n}\` (required)`),
    ...(l.optionalEnv ?? []).map((n) => `\`${n}\` (optional)`),
  ];
  return parts.length > 0 ? parts.join(", ") : "None";
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/**
 * The layer's attributes (spec §12c) as the layer row offers them, by type: chips list their labels (an ordinal names
 * its source scale), measures their unit, "" without any.
 */
function attributeCell(l: Layer): string {
  return (l.attributes ?? [])
    .map((a) => {
      const labels = [...new Set((a.levels ?? []).map((v) => v.label))];
      if (a.type === "measure") return `${a.label} (measure${a.unit ? `, ${a.unit}` : ""}${a.presets?.length ? `, ${a.presets.length} presets` : ""})`;
      if (a.type === "ordinal") return `${a.label} (ordinal, ${a.scale}): ${labels.join(", ")}`;
      if (a.type === "category") return labels.length === 0 ? `${a.label} (category, from the data)` : labels.length <= 6 ? `${a.label} (category): ${labels.join(", ")}` : `${a.label} (category, ${labels.length} values)`;
      return `${a.label} (${a.type})`;
    })
    .join("; ");
}

const km2 = (n: number) => Math.round(n).toLocaleString("en-US");

/** "Any", "2,500", or "250,000; to 50,000,000 the 2,000 largest by capacity in MW". */
export function areaText(l: Layer): string {
  if (!Number.isFinite(l.maxAreaKm2)) return "Any";
  const hard = hardMaxAreaKm2(l);
  if (l.wide === undefined || hard <= l.maxAreaKm2) return km2(l.maxAreaKm2);
  const w = l.wide;
  const by = w.orderBy ? ` by ${w.orderBy}` : "";
  const kept =
    w.mode === "tiles" ? "a density map" : w.mode === "named" ? `the ${km2(w.limit)} named${by}` : `the ${km2(w.limit)} ${w.rank ?? "largest"}${by}`;
  return `${km2(l.maxAreaKm2)}; to ${Number.isFinite(hard) ? km2(hard) : "any size"} ${kept}`;
}

export function layerTable(): string {
  const rows = listLayers().map((l) => {
    const m = META[l.id];
    if (!m) throw new Error(`scripts/layer-table.mts has no entry for layer "${l.id}"`);
    return `| \`${l.id}\` | ${cell(l.title)} | ${cell(m.shows)} | ${cell(m.source)} | ${coverageText(l)} | ${cell(areaText(l))} | ${keyText(l)} | ${cell(m.freshness)} | ${cell(attributeCell(l))} |`;
  });
  return [
    "| Id | Title | What it shows | Source | Coverage | Area (km²) | Key needed | Freshness | Attributes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const table = layerTable();
if (process.argv.includes("--write")) {
  const re = /(<!-- layers:start -->)[\s\S]*?(<!-- layers:end -->)/;
  for (const path of ["README.md", "docs/layers.md"]) {
    const text = readFileSync(path, "utf8");
    if (!re.test(text)) throw new Error(`${path} is missing the layers:start / layers:end markers`);
    const count = listLayers().length;
    writeFileSync(path, text.replace(re, `$1\n${table}\n$2`).replace(/ships \d+ data layers/, `ships ${count} data layers`));
    console.log(`Updated ${path}`);
  }
} else {
  console.log(table);
}

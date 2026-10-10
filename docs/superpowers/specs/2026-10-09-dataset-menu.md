# WallyMap dataset menu

Date: 2026-10-09. Status: research menu, nothing built. Trigger: the owner asked the
app about avalanches and the agent said no layer covers it.

This is a menu of free datasets reachable by API or tiles that could become WallyMap
layers. Avalanche comes first. Everything else is grouped by theme, global first, with
US, Canada or Europe sources where nothing global exists. The 19 layers we already ship
are excluded except as "extend" notes.

## How to read this

- **Fit** says which kind of layer it would be under the contract in `layers/types.ts`:
  - **feature**: `query()` returns GeoJSON for a bbox, capped, with `t` and `v` where they exist.
  - **tile**: `query()` returns a raster or vector `{z}/{x}/{y}` template.
  - **computed**: built from other layers or from tiles we already load (see `layers/_shared/compose.ts`).
- **Effort**:
  - **S** is one layer file using an existing helper, about a day.
  - **M** needs a new adapter, a join, or a new shared helper, a few days.
  - **L** needs hosting or preprocessing (PMTiles, a COG tiler, Earth Engine) or per-region work.
- **Auth**: "none", "free key" (a new optional or required env var), or "account".
- **Cost risk** is what could make it cost money or get us blocked: a non-commercial
  licence, a quota, or a paid tier.
- "Verified" means the docs page or the endpoint answered on 2026-10-09. Data files were
  not downloaded.
- "(owner's find)" marks sources Kyle pasted earlier in the build session or listed in
  `2026-10-09-mapagent-design.md`.

## Three enablers that make most of this cheap

1. **Raster export as tiles.** `components/mapTiles.ts` hands the tile URL straight to
   Mapbox GL, and Mapbox fills `{bbox-epsg-3857}` as well as `{z}/{x}/{y}`. So any ArcGIS
   MapServer or ImageServer `export`/`exportImage`, and any WMS `GetMap`, works as a
   raster tile layer with no server code:
   `.../MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`.
   A shared `exportTileUrl(service)` / `wmsTileUrl(service, layer)` helper next to
   `gibsTileUrl` turns about fifteen items below into S effort. The docs should note that
   the URL may hold `{bbox-epsg-3857}`.
2. **One OSM outdoor-features layer.** `overpassQuery` already exists. A single
   `osm-features` layer with a `kind` input can cover peaks, saddles, huts, shelters,
   springs, drinking water, viewpoints, caves, hot springs, waterfalls, climbing crags
   and ski-touring routes. That is about ten menu items for one S file, and `kind`
   becomes a filter chip for free.
3. **Slope from the DEM we already load.** `lib/render/wally/deckTerrain.ts` already
   fetches `mapbox-terrain-dem-v1` Terrain-RGB tiles. Slope and aspect can be computed
   from the same tiles in the browser, so slope shading, aspect, "steeper than 30°" and
   avalanche-terrain masks need no new data source.

## Recommended first 10

Ranked by value divided by effort, with avalanche at the top.

| # | Name | Question it answers | Auth | Effort |
|---|---|---|---|---|
| 1 | Avalanche forecasts, US and Canada (avalanche.org map layer + Avalanche Canada areas) | "What's the avalanche danger in the Wasatch / Rogers Pass today?" | none | S |
| 2 | Avalanche terrain: slope-angle shading with aspect (computed from Mapbox terrain) | "Which slopes on this tour are 30–45°, and which face north?" | none (Mapbox token we already have) | M |
| 3 | Avalanche forecasts, Europe (EAWS daily ratings joined to EAWS micro-regions) | "Avalanche danger around Chamonix / Tyrol / Lyngen?" | none | M |
| 4 | NWS weather alerts, which include avalanche, winter storm and red flag warnings | "Any warnings out for this range this weekend?" | none | S |
| 5 | Snow cover by date (NASA GIBS MODIS/VIIRS NDSI) plus US snow depth (NOHRSC) | "Where is there snow right now, and how deep?" | none | S |
| 6 | OSM outdoor features (huts, shelters, peaks, springs, water, viewpoints, caves, hot springs, crags, ski-touring routes) | "Huts and water sources along this route?" | none | S |
| 7 | Mountain weather and snow forecast (Open-Meteo: snowfall, freezing level, wind, temperature, history) | "How much snow fell this week, and where is the freezing level?" | none (non-commercial; paid plan if commercial) | M |
| 8 | Satellite picture by date (GIBS VIIRS/MODIS true colour) | "What did this valley look like on 3 September: smoke, snow, burn scar?" | none | S |
| 9 | Global protected areas (WDPA via UNEP-WCMC map service) | "Is this land protected, outside the US?" | none (non-commercial terms) | S |
| 10 | GBIF occurrence density tiles | "Where has this species ever been recorded, worldwide?" | none | S |

Close runners-up, all S: Macrostrat geology tiles, JRC surface water, ESA WorldCover,
USGS earthquakes, USFS wildfire hazard, Wikipedia nearby articles.

## Avalanche: the recommended approach

**Forecasts are a feature layer of polygons.** Each forecast zone has `v` set to danger
level 1–5, `t` set to the issue time, and a link to the official forecast. Use one
`avalanche-forecast` layer with three regional adapters:

- avalanche.org for the US.
- Avalanche Canada for Canada.
- EAWS for 16 European countries.

All three are keyless GeoJSON or JSON today. Together they cover nearly every forecast
zone in North America and Europe.

**Terrain is a computed slope layer.** It uses 30–45° bands (peak hazard about 35–40°)
with an optional aspect filter, built from the Mapbox DEM we already draw. It is global,
works for any tour, and needs no new source. Where an official map exists, add it as an
overlay:

- ATES ratings in New Zealand (DOC feature service).
- Slope maps from swisstopo, IGN France and NVE Norway.

**Safety rules.** The agent must never restate danger as its own judgement. Every
forecast feature carries its expiry time and a link to the full bulletin, and an
off-season zone shows "no rating". The system prompt should say that slope shading shows
where avalanches can start, not whether they will.

---

## 1. Avalanche

| Dataset | User question | Access (verified 2026-10-09) | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **avalanche.org forecast map layer** (National Avalanche Center + A3) | "Avalanche danger near Stevens Pass?" | `https://api.avalanche.org/v2/public/products/map-layer` (all centres) and `/map-layer/{CENTER_ID}`. Returns a GeoJSON FeatureCollection of 84 zones across 29 centres with `danger_level` (-1 to 5), `danger`, `color`, `start_date`, `end_date`, `link`, `off_season` and `travel_advice`. Detail per zone via `/v2/public/product?type=forecast&center_id=&zone_id=`. | none | US (CAIC appears as one statewide polygon) · daily in season | Undocumented public API with no published terms. Ask NAC/A3 before launch and always link to the centre's forecast. | feature · **S** | Core avalanche answer for the US; polygons are already styled. |
| **Avalanche Canada forecasts** | "Danger at Rogers Pass today?" | Docs: `https://avalanche.ca/api-docs`. Base `https://api.avalanche.ca` (also `avcan-services-api.prod.avalanche.ca`). `GET /forecasts/{en|fr}/areas` returns GeoJSON polygons; `/metadata` returns highest danger per area plus icons; `/products/point?lat=&long=` returns the full forecast. | none | Canada · daily in season | Has Terms of Use and a Data Sharing Policy; read them before shipping. Low cost risk. | feature · **S** | Same layer, second adapter; covers BC, Alberta and Newfoundland. |
| **EAWS European bulletins** (16 countries: AD AT CH CZ DE ES FI FR GB IT NO PL RO SE SI SK) | "Danger around Chamonix / Tyrol / Lyngen?" | Daily max danger per micro-region, split by elevation and am/pm: `https://static.avalanche.report/eaws_bulletins/{date}/{date}.ratings.json` (549 regions). Region geometry: `https://regions.avalanches.org/micro-regions.geojson` (16 MB, so cache it or use the vector tiles `https://regions.avalanches.org/pbf/{z}/{x}/{y}.pbf`), source `gitlab.com/eaws/eaws-regions`. Full text for Euregio: `https://static.avalanche.report/bulletins/latest/EUREGIO_en_CAAMLv6.json`. | none | Europe · daily in season | Region geometry is CC0. Bulletin reuse licence is not stated (Swiss SLF is CC BY 4.0). Confirm with ALBINA/EAWS. | feature (join ratings to simplified polygons) or vector tile coloured by a match expression · **M** | One source for almost every European forecast. |
| **SLF Switzerland bulletin** | "Swiss danger map?" | `https://aws.slf.ch/api/bulletin/caaml/en/geojson` (empty FeatureCollection off-season) and `/caaml/en/json`. Data service page: `https://www.wsl.ch/en/services-produkte/slf-data-service/` | none | Switzerland · twice daily | CC BY 4.0 with attribution to SLF | feature · S | Only if we want Swiss detail beyond EAWS. EAWS already includes CH. |
| **Varsom (NVE Norway) forecast API** | "Avalanche danger in Lyngen?" | `https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/AvalancheWarningByRegion/Simple/{region}/{lang}/{from}/{to}`. Docs: `https://api.nve.no/doc/snoeskredvarsel/` | none | Norway · daily | NLOD (Norwegian open licence) | feature · S | Richer Norwegian detail. EAWS already includes NO. |
| **Slope-angle shading + aspect (computed)** | "Which slopes on this route are avalanche terrain (30–45°)?", "North-facing steep slopes?" | Compute from `mapbox-terrain-dem-v1` Terrain-RGB tiles (`https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}@2x.pngraw`), which `deckTerrain.ts` already loads. A keyless alternative is AWS Terrain Tiles (Terrarium): `https://registry.opendata.aws/terrain-tiles/`. Bands as CalTopo uses them: under 27°, 27–30°, 30–35°, 35–45°, over 45°. | none (existing Mapbox token) | Global · static. Resolution is about 10 m in the US/Alps and about 30 m elsewhere, which can hide short steep rolls. | Mapbox counts raster tile requests (free tier covers normal use); Terrarium is free. | computed raster (client-side decode, or a `/api/tiles/slope` route) · **M** | Answers the terrain half of every avalanche question, everywhere. It also unlocks "aspect" and "steepness along route". |
| **ATES ratings, New Zealand** (Department of Conservation) | "Is this NZ route simple, challenging or complex terrain?" | `https://services1.arcgis.com/3JjYDyG3oajxU6HO/ArcGIS/rest/services/ATES_Avalanche_Classification/FeatureServer/0` with fields `ATES_CLASSIFICATION`, `SITE_NAME`, `NOTES` | none | New Zealand · static | DOC copyright; check reuse terms | feature (`arcgisQuery`) · S | The only ATES layer reachable by API. |
| **ATES ratings, Canada** | same | KMZ downloads from Avalanche Canada's Trip Planner (`https://avalanche.ca/news/maps-of-ates-rated-regions-available-for-download`). No API. | — | Canada (rated zones) | Ask Avalanche Canada | L (convert and host as PMTiles) | Not worth it until they publish a service. |
| **Official slope maps (Europe)** | "Slope map for this Swiss/French/Norwegian tour?" | swisstopo slope over 30°: `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hangneigung-ueber_30/default/current/3857/{z}/{x}/{y}.png`. IGN France: `ELEVATION.SLOPES` on `https://data.geopf.fr/wmts`. NVE Norway: `https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_2024/MapServer` (cached tiles, also `Bratthet_med_utlop_2024` with runout). | none | CH, FR, NO · static | Open government licences (swisstopo OGD, Etalab, NLOD) | tile · S each | Better resolution than our computed slope where they exist. |
| **Ski-touring routes** | "Classic ski tours here?" | swisstopo `ch.swisstopo-karto.skitouren` (WMTS + identify API at `api3.geo.admin.ch`). OSM `route=piste` + `piste:type=skitour` through Overpass. OpenSkiMap resort runs and lifts as vector tiles: `https://tiles.openskimap.org/openskimap/{z}/{x}/{y}.pbf` (TileJSON at `/openskimap.json`). | none | CH; global (OSM) | swisstopo OGD; ODbL | tile / feature (inside `osm-features`) · S | Lets the agent put a forecast and slope next to real tours. |
| **US snow depth and SWE (NOHRSC / SNODAS model)** | "How deep is the snow across the Sierra today?" | `https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer` (layer 0 snow depth, layer 1 SWE). Use as export tiles. Archive: NSIDC G02158. | none | CONUS · daily | Public domain | tile (export) · S | Fills the gaps between SNOTEL stations. |
| **Snow cover from satellite (GIBS)** | "Where is there snow on 1 Nov?" | GIBS layers `MODIS_Terra_NDSI_Snow_Cover`, `VIIRS_SNPP_NDSI_Snow_Cover`, `VIIRS_NOAA20_NDSI_Snow_Cover`, `MODIS_Aqua_L3_Snow_Extent_8Day`, `AMSRU2_Snow_Water_Equivalent_Daily`. Use the existing `gibsTileUrl`. | none | Global · daily | NASA open | tile · **S**, scrubber-aware like night lights | Global snowline by date; works with the time scrubber. |
| **Avalanche accidents** | "Past avalanche accidents here?" | `https://avalanche.org/avalanche-accidents/` (web page; no API found). CAIC has its own pages. | — | US | — | not available as API | Skip until there is an API; worth asking NAC for it alongside the forecast question. |
| **Weather-station snow beyond SNOTEL** | "Recent snowfall at nearby stations?" | Avalanche Canada weather API `https://weather.prod.avalanche.ca/stations`. Synoptic (MesoWest) Weather API: the free tier is non-commercial and unclear for API use in 2026. Open-Meteo modelled snow depth (see Weather). | none / account | Canada; US+ | Synoptic non-commercial | feature · S (Avalanche Canada) / M | Extends `snowpack` north of the border. |

Extend: `snowpack` (SNOTEL) could add 24/72-hour new-snow deltas as `v` options, which
is a useful avalanche signal.

## 2. Weather and sky

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **Open-Meteo forecast / historical / air quality / marine / flood** | "Freezing level and wind on the ridge Saturday?", "Rainfall last month?" | Docs: `https://open-meteo.com/en/docs`, `/en/docs/historical-weather-api`, `/en/docs/air-quality-api`, `/en/docs/flood-api`. Takes many coordinates per call. | none | Global · hourly; history to 1940 | Data CC BY 4.0. The free API is **non-commercial**, under 10k calls a day. Commercial use needs a paid plan or self-hosting (AGPL). | computed feature (sample a grid of points in the bbox, `v` = chosen variable, `t` = hour) · M | The single most useful global weather source; includes snowfall, snow depth, freezing level, gusts and UV. |
| **NWS alerts** | "Any avalanche, winter storm or red flag warnings here?" | `https://api.weather.gov/alerts/active?area=CO` or `?point=lat,lon`. GeoJSON polygons. Docs: `https://www.weather.gov/documentation/services-web-api` | none (send a User-Agent) | US · minutes | Public domain | feature · **S** | Official warnings, including NWS-issued Avalanche Warnings. |
| **NWS point forecast / gridpoints** | "Forecast for this trailhead?" | `api.weather.gov/points/{lat},{lon}` then the forecast URLs | none | US · hourly | Public domain | feature · S | Official US forecast; Open-Meteo covers everywhere else. |
| **Radar (US)** | "Is it raining on the route now?" | Iowa Environmental Mesonet NEXRAD composite tiles: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png` (index at `/ogc/`) | none | CONUS · 5 min | Free; be polite | tile · S | Live precipitation. RainViewer cut its free tier in Jan 2026 (zoom 7 max, personal use), so avoid it. |
| **Global precipitation (GIBS IMERG)** | "Where did it rain yesterday worldwide?" | GIBS `IMERG_Precipitation_Rate`, `IMERG_Precipitation_Rate_30min` | none | Global · 30 min | NASA open | tile · S | Global rain picture with no key. |
| **Cloud cover** | "Clear skies for stargazing tonight?" | Open-Meteo `cloud_cover` (forecast). GIBS `MODIS_Terra_Cloud_Top_Height_Day` and `GOES-East_ABI_GeoColor` (observed). | none | Global | as above | computed / tile · S | Pairs with dark sky. |
| **Wind field** | "Wind on the ridgeline?" | Open-Meteo `wind_speed_10m`, `wind_gusts_10m`, and pressure-level winds (GFS/ICON/ECMWF) | none | Global | as above | computed feature (arrows by grid point) · M | Wind loading drives avalanche problems; also matters for paragliding and sailing. No free global wind tile service found (OpenWeatherMap tiles need a key). |
| **Lightning** | "Lightning nearby today?" | No open real-time API with redistribution rights found. Blitzortung is non-commercial with no official API. GIBS has only a climatology (`LIS_..._Mean_Flash_Rate`). | — | — | — | not recommended | Use the climatology for "where storms are common". |
| **Aurora forecast** | "Will I see the aurora from here tonight?" | NOAA SWPC OVATION: `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` (global grid, about 1 MB) and Kp: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | none | Global (high latitudes) · 5 min | Public domain | feature (grid cells with `v` = probability) · S | A popular "wild night" question, and global. |
| **Artificial sky brightness (Falchi World Atlas 2015)** | "Darkest sky within 2 hours?" | GeoTIFF on request from GFZ (DOI 10.5880/GFZ.1.4.2016.001); viewer at `https://www.lightpollutionmap.info/` (its tile API needs a key) | request | Global · static | **CC BY-NC 4.0** | tile (host as PMTiles/COG) · L | Better than raw VIIRS radiance for stargazing, but non-commercial. Our `night-lights` layer covers about 80% of this question already. |
| **Sun and moon (computed)** | "When does the sun hit this face?", "Moon phase on the trip?" | `suncalc`-style computation, no source | none | Global | — | computed · S | Combined with aspect from the slope layer, it gives sun exposure, which matters for spring snow and heat. |

## 3. Smoke, air and fire risk

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **NOAA HMS smoke polygons** | "Was there smoke over this route yesterday?" | Daily files: `https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/` (Shapefile, KML; `.../Shapefile/YYYY/MM/hms_smokeYYYYMMDD.zip`). Product page: `https://www.ospo.noaa.gov/products/land/hms.html` | none | North America · daily (final the next morning) | Public domain | feature (parse KML, `v` = density Light/Medium/Heavy, `t` = date) · M | Observed smoke that works with the scrubber. No GeoJSON or ArcGIS service exists. |
| **Smoke forecast** | "Smoke tomorrow?" | NWS 48-hour smoke forecast (published via state/NWS ArcGIS mirrors). Open-Meteo air quality `pm2_5` (CAMS, global). | none | US / global | public / CC BY | tile / computed · S–M | Forecast to pair with HMS. |
| **AirNow** | "Air quality at the trailhead now?" | `https://docs.airnowapi.org/` | free key | US/CA/MX monitors · hourly | Public; preliminary data | feature · S | Official AQI. |
| **OpenAQ v3** | "Air quality near this park, worldwide?" | `https://docs.openaq.org/` (v3 returns 401 without a key) | free key | Global · hourly | CC BY 4.0 for most sources | feature · S | Global monitor network. |
| **PurpleAir** (owner's find) | "Hyper-local smoke?" | `https://develop.purpleair.com/pricing` | paid points | Global (dense in the US) | **Paid** | skip | Paid since 2024; use AirNow/OpenAQ instead. |
| **USFS Wildfire Hazard Potential / Wildfire Risk to Communities** | "How fire-prone is this forest?" | `https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer` and `.../USFS_EDW_RMRS_WRC_ExposureType/ImageServer` (verified, Web Mercator) | none | US · every few years | Public domain | tile (exportImage) · **S** | Long-term fire risk next to live detections. |
| **MTBS burn severity** (owner's find; in the original spec, never built) | "How badly did the 2020 fire burn here?" | `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer`. Downloads: `https://www.mtbs.gov/direct-download` | none | US · yearly (lags about 1 year) | Public domain | tile (export) + feature (fire boundaries with `t`) · S | Extends `fire-perimeters` with severity. |
| **USFS BAER (burned area emergency response)** | "Post-fire debris-flow risk?" | `EDW/EDW_BurnedAreaEmergencyResponse_01` on the same EDW server | none | US (USFS) | Public domain | tile · S | Post-fire hazards for hikers. |
| **EFFIS / GWIS fire danger** | "Fire danger forecast in Portugal / Australia?" | WMS: `https://maps.effis.emergency.copernicus.eu/effis?service=WMS&request=GetCapabilities` (Fire Weather Index forecast, burnt areas) | none | Global (FWI), Europe (detail) · daily | Copernicus, free with attribution | tile (WMS) · S | Global daily fire danger. |
| **Fuel moisture** | "How dry are the fuels?" | WFAS (wfas.net) offers map images only; the National Fuel Moisture Database is per-site and not a clean API | — | US | — | not recommended now | EFFIS FWI and USFS hazard cover the question. |

Extend: `fire-detections` could add the GIBS `VIIRS_*_Thermal_Anomalies_375m_*` tiles
as a keyless fallback when `FIRMS_MAP_KEY` is missing.

## 4. Terrain and geology

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **Slope / aspect / elevation bands (computed)** | "Steepest part of this trail?", "South-facing slopes above 3,000 m?" | Same as the avalanche slope layer | none | Global | — | computed · M (shared with avalanche) | One build serves avalanche, sun, hiking difficulty and campsite flatness. |
| **USGS 3DEP elevation ImageServer** | "Lidar-quality slope in the US?" | `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer` (server-side rendering rules include slope and aspect). Point query: `https://epqs.nationalmap.gov/v1/docs` | none | US · static | Public domain | tile (exportImage with renderingRule) · S | Server-rendered 10 m (often 1 m) slope for the US with no client maths. |
| **OpenTopography global DEM API** | "Download a DEM for analysis?" | `https://portal.opentopography.org/apidocs/` (Copernicus 30 m, SRTM, ALOS) | free key | Global | Per dataset; quota | computed backend · L | Only needed for server-side analysis such as viewsheds. |
| **Geology (Macrostrat)** | "What rock is this ridge made of?" | API `https://macrostrat.org/api/v2`; vector tiles `https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt` | none | Global, multi-scale | CC BY 4.0 | tile (vector) + feature (point identify) · **S** | Global geology map; a fun and scientific "why does it look like this". |
| **Earthquakes (USGS)** | "Recent quakes near this volcano?" | Feeds: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php`. Query: `https://earthquake.usgs.gov/fdsnws/event/1/` (bbox, time, minmagnitude) | none | Global · minutes | Public domain | feature (`t` = time, `v` = magnitude) · **S** | Trivial to build, and well suited to columns and the scrubber. |
| **Volcanoes (Smithsonian GVP)** | "Active volcanoes in this range?" | WFS: `https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&request=GetCapabilities`. US alert levels: `https://volcanoes.usgs.gov/hans-public/api/volcano/` | none | Global · weekly | GVP: cite; USGS public domain | feature · S | Holocene volcanoes plus current US alert levels. |
| **Landslides: NASA COOLR / Global Landslide Catalog** | "Landslides reported along this road?" | Viewer and download: `https://landslides.nasa.gov/viewer` (terms gate). The ArcGIS REST endpoints (`gis.earthdata.nasa.gov/gis05/.../Landslides/COOLR_*`) returned 404 today. | none | Global · ongoing | NASA open; cite inventories | feature · M (status unclear; re-check endpoints) | Global landslide events with dates. |
| **Landslides: USGS US Landslide Inventory** | "Mapped landslides on this slope?" | Inventory v3 is published on ScienceBase. An unofficial ArcGIS mirror exists; no official USGS service URL was confirmed. | none | US | Public domain | tile/feature · M | Steep-ground hazard for the US. |
| **Glaciers (GLIMS / RGI 7.0)** | "Glaciers in this range and how big?" | GLIMS GeoServer WMS/WFS: `https://www.glims.org/geoserver/ows`. RGI 7.0: `https://nsidc.org/data/nsidc-0770/versions/7` | none | Global · static (RGI) / ongoing (GLIMS) | Open, cite | tile (WMS) + feature (WFS) · S | Glacier outlines worldwide, with change over time from GLIMS. |
| **Permafrost** | "Is this terrain permafrost?" | ESA CCI Permafrost and the Global Permafrost Zonation Index exist only as file downloads | none | Arctic/alpine | Open | tile (host COG/PMTiles) · L | Niche. Do it after the hosting pipeline exists. |
| **Caves, hot springs, springs, waterfalls** | "Hot springs within reach?" | OSM `natural=cave_entrance`, `natural=hot_spring`, `natural=spring`, `waterway=waterfall` | none | Global | ODbL | feature (inside `osm-features`) · S | Highly asked outdoor questions. NOAA's thermal springs list is a static file. |

## 5. Water

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **JRC Global Surface Water** | "Where is water permanent versus seasonal?", "Has this lake shrunk?" | Tiles: `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png` (also `change`, `seasonality`, `recurrence`, `transitions`). Info: `https://global-surface-water.appspot.com/download` | none | Global · 1984–2021 | Copernicus / EC JRC, free with attribution | tile · **S** | 38 years of surface water change; a strong scientific story. |
| **OPERA Dynamic Surface Water (GIBS)** | "Is this river flooded now?" | GIBS `OPERA_L3_Dynamic_Surface_Water_Extent-HLS` and `-Sentinel-1`; `MODIS_Combined_Flood_1-Day` | none | Global (OPERA is North America-first) · days | NASA open | tile · S | Near-real-time water and flooding. |
| **HydroRIVERS / HydroLAKES** | "Stream order and lake depth?" | `https://www.hydrosheds.org/products/hydrorivers`, `/hydrolakes` (file downloads) | none | Global · static | Free, non-restrictive with citation | tile (host PMTiles) · L | Global river network with flow attributes; OSM covers the basics. |
| **River discharge forecast (GloFAS via Open-Meteo)** | "Is this river running high?" | `https://open-meteo.com/en/docs/flood-api` | none | Global · daily | CC BY 4.0; non-commercial free tier | computed feature · S | Global `streamflow` stand-in outside the US. |
| **USGS water temperature and more** | "Is the river warm enough to swim?" | Same USGS Water Data API the `streamflow` layer uses (parameter `00010`) | optional key | US | Public domain | **extend `streamflow`** · S | Adds a parameter input to an existing layer. |
| **NOAA tides (CO-OPS)** | "When is low tide at this beach?" | Data: `https://api.tidesandcurrents.noaa.gov/api/prod/`. Stations: `https://api.tidesandcurrents.noaa.gov/mdapi/prod/` | none | US coasts · predictions | Public domain | feature (stations with next low and high) · S | Coastal hikes and tidepools. No free global tide API (WorldTides is paid). |
| **FEMA flood hazard (NFHL)** | "Is this campsite in a floodplain?" | `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer` | none | US · ongoing | Public domain | tile (export) · S | Floodplain context for camping. |
| **US Drought Monitor** | "How dry is this region?" | `https://droughtmonitor.unl.edu/DmData/GISData.aspx` (weekly GeoJSON/shapefile). Stats API: `https://usdmdataservices.unl.edu/api/...` | none | US · weekly | Public, credit NDMC | feature (polygons, `v` = D0–D4, `t` = week) · S (cache the weekly file, about 24 MB, in KV) | Context for fire, water and campsites. |
| **Springs and drinking water** | "Water sources along the route?" | OSM `natural=spring`, `amenity=drinking_water`, `amenity=water_point`, `man_made=water_tap` | none | Global | ODbL | inside `osm-features` · S | One of the most important backcountry questions. |
| **Water quality (EPA Water Quality Portal)** | "Any water quality samples on this lake?" | `https://www.waterqualitydata.us/webservices_documentation/` | none | US | Public domain | feature · M | Algal blooms and swim safety; niche. |

## 6. Vegetation and land

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **ESA WorldCover 10 m** (owner's find via AWS registry) | "Forest, grassland or bare rock here?" | WMTS: `https://wmts.terrascope.be/?service=WMTS&request=GetCapabilities`, layers `esa-worldcover-map-10m-2021-v2_map` (+2020), EPSG:3857. AWS: `https://registry.opendata.aws/esa-worldcover-vito/` | none | Global · 2020, 2021 | CC BY 4.0 | tile · **S** | Global land cover at 10 m; lets the agent say "above treeline". |
| **Dynamic World** (owner's find) | "Land cover this month?" | Earth Engine only: `GOOGLE/DYNAMICWORLD/V1` | Earth Engine account | Global · near-real-time | CC BY 4.0; Earth Engine terms (commercial use needs a paid plan) | tile via Earth Engine · L | Timely, but the Earth Engine dependency is heavy. |
| **NLCD Annual** (owner's find) | "How has US land cover changed since 1985?" | WMS: `https://www.mrlc.gov/geoserver/mrlc_display/wms`. Services page: `https://www.mrlc.gov/data-services-page` | none | US · annual 1985– | Public domain | tile (WMS) · S | Year-by-year land cover that works with the scrubber. |
| **Canopy height (Meta / WRI, 1 m)** | "How tall is this forest?" | `https://registry.opendata.aws/dataforgood-fb-forests/` (COGs on S3) | none | Global · ~2020 | CC BY 4.0 | tile (needs a COG tiler such as TiTiler) · L | Old-growth and shade questions. |
| **NDVI / EVI greenness (GIBS)** | "How green is this valley this month?" | GIBS `MODIS_Terra_L3_NDVI_16Day`, `MODIS_Aqua_L3_NDVI_Monthly`, `MODIS_Terra_EVI_8Day`, `Landsat_WELD_NDVI_Global_Monthly` | none | Global · 8–16 days | NASA open | tile · **S** | Green-up, drought and burn recovery over time. |
| **Phenology: leaf-out, bloom, spring index (USA-NPN)** | "Has spring arrived here?", "Peak bloom timing?" | WMS: `https://geoserver.usanpn.org/geoserver/wms` (Spring Index anomalies, Pheno Forecasts). Info: `https://www.usanpn.org/data/maps` | none | US · daily | Public, cite USA-NPN | tile (WMS) · S | The best free proxy for fall foliage and wildflowers in the US. |
| **Wildflowers in bloom (iNaturalist annotations)** | "Where are wildflowers flowering now?" | iNaturalist API with phenology annotation filters (`term_id=12&term_value_id=13`, plus `iconic_taxa=Plantae`) | none | Global | Per-observation CC licences | **extend `species`** · S | A real "bloom map" from observations. |
| **Fall foliage** | "Peak colour this week?" | No free API. SmokyMountains.com and similar maps are proprietary. Use USA-NPN and MODIS NDVI change. | — | — | — | not available | Say so plainly. |
| **Invasive species (EDDMapS)** | "Invasive plants reported here?" | `https://www.eddmaps.org/`. No documented public API; downloads need an account; embedded maps are non-commercial. | account | US/CA | Non-commercial | skip; use GBIF with `establishmentMeans=INTRODUCED` instead | GBIF covers the question with no key. |

## 7. Wildlife

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **GBIF occurrence density tiles** | "Where has this species been recorded, ever?" | `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey=...` (style and year params) | none | Global · daily | CC0 / CC BY per dataset | tile · **S** | 2.5+ billion records in one tile URL; filter by taxon and year. |
| **GBIF occurrence search** | "List the records in this valley?" | `https://api.gbif.org/v1/occurrence/search` (bbox via `geometry`, `hasCoordinate`) | none | Global | as above | feature (`t` = eventDate) · S | Museum and survey records beyond iNaturalist. |
| **eBird API 2.0** | "What birds were seen here this week?", "Birding hotspots nearby?" | `https://documenter.getpostman.com/view/664302/S1ENwy59` (`/v2/data/obs/geo/recent`, `/v2/ref/hotspot/geo`; returns 403 without a key) | free key | Global · real time | eBird terms (non-commercial; attribution) | feature · S | The largest bird dataset; hotspots are great map pins. |
| **Movebank animal tracks** | "Elk migration through this pass?" | `https://www.movebank.org/cms/movebank-content/access-data` (REST, login; per-study licences) | account | Global, per study | Per study, often restrictive | feature · L | Compelling but licensing is case by case. |
| **USFWS critical habitat** | "Is this critical habitat for an endangered species?" | `https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer` | none | US · ongoing | Public domain | feature (`arcgisQuery`) · S | Legal and ethical context for trips. |
| **BLM grazing allotments; wild horse and burro herd areas** | "Will there be cattle here?", "Where are the wild horses?" | `https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer`; `range/BLM_Natl_WHB/MapServer` | none | US (BLM) | Public domain | tile (export) / feature · S | Practical (cattle, water) and fun (wild horses). |
| **Hunting units and seasons** | "Is it hunting season here?" | State by state (e.g. Colorado CPW GMUs on ArcGIS); no national source; onX is closed | none | per state | Public | feature · L (per state) | High value in autumn; do the 3–5 biggest western states first. |
| **Protected areas incl. marine (WDPA)** | "Is this a marine reserve / national park abroad?" | Map service: `https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer`. API (key): `https://api.protectedplanet.net/documentation`. Terms: `https://www.protectedplanet.net/en/legal` | none (map service) / free key (API) | Global · monthly | **Non-commercial**; commercial use needs IBAT | tile (export) · **S** | Gives `public-lands` and `wilderness` a global counterpart. |

## 8. Human use and access

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **OSM outdoor features** (enabler #2) | "Huts, shelters, peaks, viewpoints, climbing crags, ski runs here?" | Overpass via `overpassQuery`: `tourism=alpine_hut|wilderness_hut`, `amenity=shelter`, `natural=peak|saddle`, `tourism=viewpoint`, `sport=climbing`, `piste:type=*` | none | Global | ODbL | feature · **S** | Covers about ten user questions with one file. |
| **Wikipedia nearby articles** | "What's the story of this place?" | `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gsbbox=...` (docs: `https://www.mediawiki.org/wiki/API:Geosearch`), the same API family `photos` uses | none | Global | CC BY-SA | feature · **S** | Adds history and natural-history context to any view. |
| **Wikidata peaks, huts, lakes** | "Tallest peaks in this range with prominence?" | SPARQL: `https://query.wikidata.org/` (`wdt:P625` within a box; peaks via `P2044` elevation and `P2660` prominence) | none | Global | CC0 | feature · S–M | Structured facts (elevation, prominence, first ascent) that OSM lacks. |
| **OpenBeta climbing areas** | "Climbing areas and route counts here?" | GraphQL `https://api.openbeta.io/` (POST; verified with a query) | none | Global, US-heavy | Content CC0 | feature · S | Open alternative to Mountain Project, which is closed. |
| **Recreation.gov RIDB** (owner's find) | "Campgrounds and permits here?" | `https://ridb.recreation.gov/docs` | free key | US federal | Public | feature · S | Already a popularity input; can also be its own facilities layer. Availability endpoints are undocumented, so don't use them. |
| **NPS API: alerts, closures, places** | "Any closures in this park?" | `https://www.nps.gov/subjects/developer/api-documentation.htm` (`developer.nps.gov/api/v1/alerts`, key required) | free key | US national parks · daily | Public domain | feature · S | Official closures and hazards; the nearest thing to "trail conditions". |
| **USFS recreation sites, trails, MVUM trails** (owner's finds) | "Forest Service trailheads and official trails?" | `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationAreaActivities_01/MapServer`, `EDW_TrailNFSPublish_01`, `EDW_MVUM_02` (trails layer); dataset page `catalog.data.gov/dataset/motor-vehicle-use-map-trails-feature-layer` | none | US (USFS) | Public domain | feature · S; **extend `forest-roads`** with MVUM trails | Official trail data alongside OSM. |
| **BLM recreation, NLCS, wild and scenic rivers, landlocked public land** | "BLM campgrounds?", "Public land I can't reach by public road?" | `https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer`; `lands/BLM_Natl_NLCS_WSR`; `lands/BLM_Natl_SMA_PriUnk_Only_NoAccess` | none | US (BLM) | Public domain | tile/feature · S each | The landlocked-land layer is a high-value access question (onX's corner-crossing). |
| **USFS / BLM closures and fire restrictions** | "Is this area closed?" | No national API for forest orders; NPS alerts and NWS red flag warnings are the closest | — | — | — | not available | Say so; link the unit page. |
| **Inventoried Roadless Areas** | "Roadless areas near here?" | `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InventoriedRoadlessAreas2001_01/MapServer` | none | US (USFS) | Public domain | tile/feature · S | Natural partner for `remoteness`. |
| **BLM mining claims (MLRS)** | "Active mining claims in this canyon?" | `https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer` | none | US | Public domain | tile (export) · S | Explains surprise roads and diggings in the backcountry. |
| **Oil and gas wells** | "Drilling near this trail?" | No national free API; state agencies and FracTracker datasets | — | per state | varies | L | Skip for now. |
| **Cell coverage: OpenCellID** (owner's find) | "Will I have signal here?" | PMTiles on Source Cooperative: `https://source.coop/smartmaps/opencellid` (`data.source.coop/smartmaps/opencellid/cellid.pmtiles`, about 560 MB, read by range requests) | none | Global (crowdsourced towers) | CC BY-SA 4.0 | tile (vector via PMTiles protocol) · M (add pmtiles support to `mapTiles.ts`) | Global "will I have bars" proxy. It also proves out PMTiles, which unlocks every L item here. |
| **Cell coverage: FCC BDC mobile** (owner's find, in spec) | "Which carriers cover this valley?" | `https://broadbandmap.fcc.gov/data-download` (bulk H3 hex files) | none | US · twice yearly | Public | tile (host PMTiles) · L | Carrier-reported coverage; heavier than OpenCellID. |
| **Noise** | "How quiet is it here?" | NPS Natural Sounds model (`https://www.nps.gov/subjects/sound/soundmap.htm`, rasters); US DOT National Transportation Noise Map (`https://maps.dot.gov/BTS/NationalTransportationNoiseMap/`) | none | US | Public domain | tile (host or export) · M | Good input for a "quiet places" remoteness signal. |
| **Foursquare OS Places / Overture places** (owner's finds) | "Gear shops, gas, food near the trailhead?" | `https://source.coop/fused/fsq-os-places` (Apache 2.0 Parquet); Overture: `https://docs.overturemaps.org/` | none | Global | Apache 2.0 / CDLA | feature (needs a Parquet query backend or PMTiles) · L | Trip logistics; outside the "wild" core. |
| **Strava heatmap** | "Where do people actually go?" | **Not an API.** Hi-res tiles need a logged-in session. Strava's 2024 API rules bar third-party heatmaps. Strava Metro is application-only for researchers (owner's find). | — | — | Closed | not possible | Keep using the `popularity` estimate. |
| **AllTrails, Gaia GPS, onX, Mountain Project, iOverlander** | "AllTrails rating for this trail?" | Closed. No public APIs, and the terms forbid scraping (iOverlander terms were the owner's find). | — | — | Closed | not possible | Say so plainly when asked. |
| **Mapbox Movement** (owner's find) | "Foot-traffic counts?" | `https://docs.mapbox.com/data/movement` | enterprise contract | Global | **Paid** | skip | Paid. |
| **Flickr photos** (owner's find) | "Photos taken here?" | Flickr API, key required, non-commercial terms (`flickr.com/help/terms/api`) | free key | Global | Non-commercial | **extend `photos`** · S | More photo signal for popularity. |

## 9. Imagery and change

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **GIBS true colour by date** | "What did it look like on this day: smoke, snow, burn scar?" | GIBS `VIIRS_SNPP_CorrectedReflectance_TrueColor`, `VIIRS_NOAA20_...`, `MODIS_Terra_CorrectedReflectance_TrueColor` via `gibsTileUrl`; `GOES-East_ABI_GeoColor` for every 10 minutes | none | Global · daily (250–375 m) | NASA open | tile · **S** (copy `night-lights`, scrubber-aware) | Shows change over time with the scrubber, and works with the existing compare view. |
| **HLS 30 m reflectance (GIBS)** | "Sharper picture from last week?" | GIBS `HLS_S30_Nadir_BRDF_Adjusted_Reflectance`, `HLS_L30_...` | none | Global · 2–3 days | NASA open | tile · S | Landsat and Sentinel-2 quality without a key. |
| **Sentinel-2 cloudless mosaics (EOX)** | "Clean satellite basemap for 2024?" | WMTS: `https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml` (`s2cloudless-2024_3857`, etc.); `https://s2maps.eu/` | none | Global · yearly | 2016 is CC BY 4.0; **2018+ is CC BY-NC-SA** | tile · S | Pretty yearly mosaics; licence limits commercial use. |
| **Disturbance alerts (OPERA DIST, GIBS)** | "Recent vegetation loss here (any cause)?" | GIBS `OPERA_L3_DIST-ALERT-HLS_Color_Index`, `OPERA_L3_DIST-ANN-HLS_Color_Index` | none | Global · days | NASA open | tile · S | Complements `forest-alerts` outside the tropics. |
| **Sentinel-2 / Landsat scenes on demand** | "True-colour or NDVI image from a specific clear day?" | Planetary Computer data API (`https://planetarycomputer.microsoft.com/api/data/v1/`, mosaic tiles); Element84 Earth Search STAC `https://earth-search.aws.element84.com/v1` (owner's find, needs a tiler); Copernicus Data Space Sentinel Hub (`https://dataspace.copernicus.eu/analyse/apis`, free account, OAuth) | none / account | Global · 5 days | Copernicus free and open | tile · M (PC mosaic) to L (own tiler) | Scene-level, 10 m. GIBS HLS covers most needs first. |
| **Change detection (computed)** | "What changed between 2015 and 2025?" | Two-date GIBS/HLS/WorldCover/JRC tiles in the existing `lib/render/compareView.ts` | none | Global | — | computed · S (mostly agent prompting) | Already half-built. |
| **Natural Earth II raster** (owner's find) | "Show the natural world, not roads" | Already a basemap (`natural-earth-2` in `lib/render/basemaps.ts`) | — | Global | Public domain | already have | No action needed. |
| **Foundation-model embeddings: AlphaEarth, Clay, Prithvi, TerraMind, SatCLIP** (owner's finds) | "Find places that look like this one" | AlphaEarth satellite embeddings as COGs on GCS (`https://developers.google.com/earth-engine/guides/aef_on_gcs_readme`); models on GitHub/Hugging Face | none / account | Global · annual | CC BY 4.0 (AlphaEarth); model licences vary | computed · L | A "similar terrain" search is a standout feature, but it is a project, not a layer. |

## 10. Global human footprint

| Dataset | User question | Access | Auth | Coverage · cadence | License · cost risk | Fit · effort | Why it matters |
|---|---|---|---|---|---|---|---|
| **GPW population** (owner's find) | "How many people live near here?" | Already served as `population` through GIBS. Project: `https://www.earthdata.nasa.gov/data/projects/gpw` | none | Global | — | already have | — |
| **WorldPop / GlobPOP** (owner's finds) | "Population at 100 m, by year?" | `https://www.worldpop.org/sdi/introapi/` (per-country files); GlobPOP on `gee-community-catalog.org/projects/globpop/` | none | Global · annual | CC BY 4.0 | tile (host COG/PMTiles) · L | Finer than GPW; only worth it after the hosting pipeline exists. |
| **Human Footprint Index** (in spec, not built) | "How touched by people is this place?" | Annual 1 km dataset 2000–2018 (Mu et al., figshare 16571064); older SEDAC Last of the Wild v3 (SEDAC unreachable today; moved into Earthdata) | none | Global · annual to 2018 | CC BY 4.0 | tile (host) · L | The heaviest planned `remoteness` signal. Needs the PMTiles/COG pipeline. |
| **OSM road density (computed)** | "How far from any road?" | Already inside `remoteness` (distance to road via Overpass) | none | Global | ODbL | **extend `remoteness`** to expose a distance-to-road layer · S | Cheap and directly answers "how remote". |
| **GRIP global roads** | "Road density in this region?" | `https://www.globio.info/download-grip-dataset` (files) | none | Global · 2018 | Open with citation | tile (host) · L | Consistent global roads; OSM is fresher. |

---

## Extend notes for existing layers

- **`snowpack`**: add 24/72-hour new-snow and density deltas as `v` options. Add Avalanche Canada weather stations for Canada.
- **`streamflow`**: add a `parameter` input for water temperature (`00010`) and gage height.
- **`fire-perimeters`**: add MTBS severity (export tiles) and fire year boundaries.
- **`fire-detections`**: add a keyless GIBS thermal-anomaly fallback.
- **`species`**: add a flowering filter (iNaturalist phenology annotations), and add GBIF as a second source.
- **`forest-roads`**: add MVUM trails (layer in `EDW_MVUM_02`).
- **`public-lands`**: add WDPA for outside the US, plus BLM's "no public access" parcels.
- **`photos`**: Flickr (key, non-commercial) as another signal.
- **`remoteness`**: expose distance-to-road. Add roadless areas, Human Footprint (once hosted) and noise.
- **`popularity`**: NPS visitation (owner's find: `catalog.data.gov/dataset/nps-visitor-use-statistics-data-package-2025`) is already the plan; RIDB availability stays out.

## Infrastructure the L items share

- **PMTiles support in `components/mapTiles.ts`** using the `pmtiles` protocol. This unlocks OpenCellID now, and any file-only dataset (HydroRIVERS, Human Footprint, Falchi, FCC, ATES KMZ) once converted and put on a bucket, as was done for PAD-US.
- **A COG tiler** (TiTiler on Vercel or a small container) for canopy height, WorldPop and Planetary Computer scenes. Only worth it after the S and M items ship.

## Licence watch list

Free but restricted. Fine for an open-source demo; a problem if WallyMap charges.

- Open-Meteo free API (non-commercial).
- WDPA (non-commercial; IBAT for commercial use).
- eBird (non-commercial).
- EOX Sentinel-2 cloudless 2018+ (NC-SA).
- Falchi World Atlas (NC).
- Flickr (non-commercial).
- avalanche.org and EAWS bulletins (terms unstated: ask before launch).
- Earth Engine (commercial needs a paid plan).

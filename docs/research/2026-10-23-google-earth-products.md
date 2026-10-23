# Google Earth products for WallyMap (research, 2026-10-23)

The owner set up Google Earth Engine on his Google Cloud project (noncommercial, free) and asked: "we should see if there are any other google earth products we want to use." This note surveys what Google offers for free to a noncommercial, open-source app, plus the strongest non-Google datasets in the Earth Engine catalog that would replace a weaker source we use today. Forest Typology (ForTy) is already planned in spec §14 and is not repeated here except where another product folds into it.

Everything below was checked on the web on 2026-10-23 (catalog pages, Google developer docs, announcements). Nothing here needs a paid key or plan; the one decision that touches billing is called out in "Budget" below.

## The biggest win is numbers, not new pictures

Most of our raster layers (forest loss, surface water, land cover, night lights, greenness) are picture tiles from other servers, so the agent is told to "describe what you see only in general terms." Earth Engine returns the numbers behind the picture as well as the tiles. With one server-side Earth Engine client, a tile layer can also answer "how many hectares", "what share of this view", and "what is the value at this point" for the inspect card (spec §12b). That turns several existing layers from pictures into answers.

How it works from our server (Vercel functions), using the Earth Engine REST API:

- **Map tiles:** `projects.maps.create` (POST `/v1/projects/{project}/maps`) takes an image expression and returns a map ID that is valid for a few hours. Tiles are then fetched from `projects.maps.tiles.get`, and that fetch needs an OAuth token with the `earthengine.readonly` scope. The browser must not hold the service-account token, so tiles go through a small server proxy route with edge caching, and the server refreshes map IDs every couple of hours.
- **Values:** `projects.image.computePixels` returns a pixel grid (for a card at a tapped point or a small chart), and `projects.value.compute` runs a reduction (area by class, sum, mean) over the view. Both work with a service account.
- **Terms:** Earth Engine's noncommercial terms rule out selling a product or service or charging for apps or data built with it. A free, open-source public app fits. Each dataset carries its own attribution line, which goes into the layer's `citation` and `license`.

## Budget

- **Community tier (default):** 150 Earth Engine compute-hours a month, free, no billing account. When it runs out, Earth Engine does not stop; it runs requests more slowly until the 1st of the next month.
- **Contributor tier:** 1,000 compute-hours a month, still free for noncommercial use, but it requires an active billing account on the project (other Google Cloud services on that account would be charged). **Decision for the owner: attach a billing account for the bigger free tier, or stay on 150 hours.**
- **Partner tier:** 100,000 compute-hours a month by application (weeks of review) for climate, adaptation and nature-protection projects. WallyMap's conservation and research users may qualify.
- **Keep it cheap:** cache tiles at the edge for a day or more (most products below change yearly), precompute yearly products on a schedule into our own tiles when traffic grows (per the free-data rule), and keep `value.compute` reductions at a coarse scale for wide views.

## Ranked recommendations

Effort assumes the shared Earth Engine client from spec §14 exists (S = a day or less, M = a few days, L = a week or more).

| # | Product | Question it answers for our users | Replaces or adds | Resolution / cadence | Licence | Effort |
|---|---|---|---|---|---|---|
| 1 | Hansen Global Forest Change v1.13 (UMD, in Earth Engine) | "How much forest was lost here, and in which years?" with hectares | Replaces the GFW tile cache behind `forest-loss` (same data, now with numbers and 2025 loss) | 30 m, yearly, 2000 to 2025 | CC BY 4.0 | S |
| 2 | Drivers of Forest Loss v1.3 (WRI and Google DeepMind) | "Was that loss fire, logging, farming or mining?" | Adds a driver breakdown to `forest-loss` | 1 km, 2001 to 2025 | CC BY 4.0 | S |
| 3 | Slope angle from USGS 3DEP 10 m (US) and Copernicus DEM GLO-30 (global) | "Which slopes here are steep enough to avalanche?" | Adds a new `slope-angle` layer (none today) | 10 m US, 30 m global, static | Public domain (3DEP); Copernicus free licence with attribution | S to M |
| 4 | Dynamic World (Google and WRI) | "What covers this ground right now, and what changed since spring?" | Replaces `land-cover` (WorldCover 2021, static) for recent dates; keeps WorldCover for a clean yearly map | 10 m, every 2 to 5 days, 2015 to now | CC BY 4.0 | M |
| 5 | gridMET fire danger (University of Idaho) | "How dry are the fuels around this trailhead today?" | Adds US energy release component, burning index and dead fuel moisture to `fire-weather` (global FWI stays) | 4 km, daily, lower 48, a few days provisional | Public domain | S |
| 6 | GPM IMERG precipitation (NASA, in Earth Engine) | "How much rain fell on this burn scar in the last three days?" | Adds a `rainfall` layer of observed (satellite) rain; Open-Meteo stays for forecasts | about 11 km, every 30 minutes, global, near real time then final | NASA open data | S |
| 7 | Google Flood Forecasting API (Flood Hub) | "Is this river forecast to flood this week?" | Adds forecast flood status, gauge forecasts and flood polygons beside `river-pulse` and `streamflow` | Gauges and river reaches in 150 countries incl. US; daily, 7 days ahead | CC BY 4.0, no charge, waitlist | M |
| 8 | AlphaEarth Foundations Satellite Embeddings (Google DeepMind) | "Find places that look like this meadow" and "what changed here since 2017?" | Adds similarity search and a change detector no other layer can do | 10 m, yearly, 2017 to 2024 | CC BY 4.0 | M to L |
| 9 | VIIRS Nighttime Lights annual V22 (Colorado School of Mines, in Earth Engine) | "Where is the darkest sky within two hours of Denver?" | Replaces the daily GIBS picture in `night-lights` for dark-sky questions, with radiance numbers | 464 m, yearly, 2012 to 2024 | Public domain | S |
| 10 | Meta and WRI canopy height (1 m, Earth Engine community catalog) | "Where are the tallest trees in this forest?" | Adds global tree height beside `old-growth` (US firesheds only) | 1 m, mostly 2018 to 2020, static | CC BY 4.0 | S |
| 11 | ERA5-Land daily (ECMWF, in Earth Engine) | "How cold does it usually get here in early October?" | Adds global climate normals and past-weather values; `temperature-anomaly` stays US-county | 11 km, daily, 1950 to about 3 months ago | Copernicus licence, attribution | M |
| 12 | iNaturalist Open Range Maps (in Earth Engine via BigQuery) | "Could I see a pika on this route?" | Adds modelled species ranges beside `species` sightings | Range polygons, thousands of species, monthly | CC BY 4.0 | M |

## What each recommendation enables

### 1. Hansen Global Forest Change v1.13, through Earth Engine

**Layer change:** `forest-loss` keeps its look but draws from `UMD/hansen/global_forest_change_2025_v1_13` instead of the GFW tile cache. The GFW tiles only show pixels; through Earth Engine the layer can sum loss area by year inside the view (`value.compute` with a pixel-area reduction), so the note can say "about 41,000 ha lost since 2015, peak in 2019," the timeline view can chart hectares per year, and the inspect card can give the loss year at a tapped point. The tree-cover-2000 band lets the canopy threshold apply exactly as GFW does.

**Example question:** "How much forest did the Klamath lose to fire and logging since 2015, year by year?"

### 2. Drivers of Forest Loss v1.3

**Layer change:** a `drivers` option on `forest-loss` (or a sibling `forest-loss-drivers` layer) from `projects/landandcarbon/assets/wri_gdm_drivers_forest_loss_1km/v1_3_2001_2025`. Seven classes: permanent agriculture, hard commodities (mining and energy), shifting cultivation, logging, wildfire, settlements and infrastructure, and other natural disturbance. It is a category attribute (spec §12c) with chips, and the note can split the hectares from item 1 by driver. Caveat for the card: it gives the dominant driver per 1 km cell over the whole period, not per year, and it does not separate natural forest from plantations (ForTy does that).

**Example question:** "Is the forest loss around Bend mostly wildfire or logging?"

### 3. Slope angle for avalanche terrain

**Layer change:** a new `slope-angle` layer computed with `ee.Terrain.slope` on `USGS/3DEP/10m` in the US and `COPERNICUS/DEM/GLO30` elsewhere, drawn in the standard avalanche bands (under 25°, 25–30°, 30–35°, 35–40°, 40–45°, over 45°) with aspect available on the card. This is the most-asked missing layer for backcountry skiers, and also serves climbers (approach steepness) and hikers (off-trail travel). The layer's caveat must say it shows terrain steepness, not avalanche danger, and point to the local avalanche center.

**Example question:** "Show me which slopes above Alta are in the 30 to 45 degree avalanche range."

### 4. Dynamic World

**Layer change:** `land-cover` gains a `date` (and date window) using `GOOGLE/DYNAMICWORLD/V1`: nine classes (water, trees, grass, flooded vegetation, crops, shrub and scrub, built, bare, snow and ice) with a probability per class, from each Sentinel-2 pass. The layer takes the most likely class over a two-to-four-week window to hide clouds, and the change view (spec §12) compares two windows ("trees to bare since June"). Today `land-cover` is WorldCover 2021 or NLCD epoch maps, and the annual NLCD is not on the service we use, so Dynamic World is the only "now" land cover. Cost note: compositing many scenes uses more compute than the yearly products, so cache by window.

**Example question:** "What did the Dixie Fire scar look like this summer compared with 2020: bare ground, grass or shrubs coming back?"

### 5. gridMET fire danger

**Layer change:** `fire-weather` adds a US source from `IDAHO_EPSCOR/GRIDMET`: energy release component, burning index, and 100-hour and 1,000-hour dead fuel moisture, daily at 4 km, with the date in the note. These are the US fire-danger indices that fire managers quote (from the US National Fire Danger Rating System); today we only have the European Fire Weather Index. The newest days are "early" and then "provisional" for a few days, which the coverage note should say.

**Example question:** "How dry are the big logs around Sisters right now compared with last week?"

### 6. GPM IMERG rainfall

**Layer change:** a new `rainfall` layer summing `NASA/GPM_L3/IMERG_V07` half-hourly rain over a chosen window (last 24 h, 3 days, 7 days), global, with the total at a tapped point on the card. Pairs with `burn-severity` and `fire-perimeters` for debris-flow questions, with `streamflow` for paddlers, and with `flood-extent` for flood watchers. Recent steps are provisional and are replaced by final values months later.

**Example question:** "How much rain fell on the Park Fire burn scar in the last three days?"

### 7. Google Flood Forecasting API (Flood Hub)

**Layer change:** a `flood-forecast` layer from the Flood Forecasting API (a separate free Google Cloud API, not Earth Engine): gauges in view with their latest flood status and 7-day forecast (`gauges.searchGaugesByArea`, `gauges.queryGaugeForecasts`, `floodStatus.searchLatestFloodStatusByArea`), significant flood events, and flood-area polygons where Google publishes them. It covers the US and Canada since 2023 and about 150 countries in all; "virtual gauges" in unverified places should carry a "not verified against measurements" flag on the card. Access is a waitlist form, then the owner replies with the Cloud project ID. The newer urban flash-flood forecasts also have an API endpoint (`flashFloods.search`), but US coverage is not documented.

**Example question:** "Is the Skagit forecast to go over flood stage this week, and where would it spill?"

### 8. AlphaEarth Foundations Satellite Embeddings

**Layer change:** two computed layers on `GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL` (64 numbers per 10 m pixel per year that summarize what the place looks like across seasons, from many satellites):

- **Places like this:** the user taps a spot; the server takes its 64 numbers and draws how similar every pixel in view is (a dot product), so "find meadows like this one" or "find more slabs like this crag" becomes a heat map with the top matches listed.
- **What changed:** the similarity of the same pixel between two years highlights change (new clearings, burns, building, river channel moves) without choosing a band or index.

Nothing else we have can do either. It needs care in the note (it finds look-alikes, not a labelled class) and is the heaviest compute here, so cap the area.

**Example question:** "I loved camping in this meadow; find me places within 50 miles that look like it."

### 9. VIIRS annual night lights for dark skies

**Layer change:** `night-lights` gains a `darkSky` mode from `NOAA/VIIRS/DNB/ANNUAL_V22` (cloud-free yearly average, moonlight removed) so the agent can rank darkest places by radiance and give a number on the card, instead of describing a daily picture. A dark-sky ramp from off-white (dark) to dark grey (bright) fits the approved palette.

**Example question:** "Where's the darkest sky within a two-hour drive of Denver for the Perseids?"

### 10. Meta and WRI canopy height

**Layer change:** a `canopy-height` layer from the 1 m map in the Earth Engine community catalog (`projects/meta-forest-monitoring-okw37/assets/CanopyHeight`), with height at a tapped point and the tallest stands ranked in view. A newer global version (v2, March 2026) exists but was not found in Earth Engine yet; switch when it appears. The imagery behind it is mostly 2018 to 2020, which the note must say.

**Example question:** "Where are the tallest trees in the Hoh Rainforest?"

### 11. ERA5-Land climate normals

**Layer change:** a `climate` layer from `ECMWF/ERA5_LAND/DAILY_AGGR` that answers "usually" questions: typical daily low and high, snow depth and precipitation for a place and week of the year, averaged over 30 years, globally. It runs about three months behind, so it is for normals and history, not today's weather (Open-Meteo stays for that).

**Example question:** "How cold does it usually get at night at Gokyo in late October?"

### 12. iNaturalist Open Range Maps

**Layer change:** a `species-range` layer that draws the modelled range of a named species (from iNaturalist's geomodel, updated monthly) behind the existing `species` sightings. Earth Engine reads it from a public BigQuery table; confirm before building that reading it is free under our quota and does not bill BigQuery.

**Example question:** "Am I inside pika range on this route, and where were they last seen?"

## Same data we already use, through Earth Engine

These are worth moving only when the shared client exists, because the picture does not change but the layer gains numbers:

- **JRC Global Surface Water** (`JRC/GSW1_4`, 1984 to 2021): same release our `surface-water` tiles use (no newer version exists), but Earth Engine adds "water was here 63% of months" at a point and area of water lost or gained in view.
- **ESA WorldCover** (`ESA/WorldCover/v200`): same 2021 map as `land-cover`; gains class areas in view.
- **MODIS snow and vegetation** (`MODIS/061/MOD10A1`, `MODIS/061/MOD13Q1`): same products as `snow-cover` and `greenness` via GIBS; gains "days of snow this winter" and greenness values over time at a point.

## Considered and rejected

- **ForestCast deforestation risk (Google DeepMind, 2025):** published as a research benchmark for the tropics, not as a map in Earth Engine.
- **Natural Forests of the World 2020:** a single natural-forest probability band; ForTy (spec §14) contains it with five more classes, so it folds into `forest-types`.
- **Species distribution models (Nature Trace):** Australia only, 25 mammal species, experimental preview.
- **Open Buildings v3 and Open Buildings 2.5D Temporal:** Africa, South and Southeast Asia and Latin America only; no US or Europe, and buildings are not an outdoor question for our users.
- **WeatherNext 2:** free only after a request form; the last 48 hours of forecasts (the useful part) are under experimental terms, and Open-Meteo already gives us forecasts. Revisit if the terms open up. WeatherNext Gen and Graph are deprecated.
- **Google Earth AI models (Imagery, Population, Environment) and Gemini in Google Earth:** trusted-tester access for enterprises and governments only.
- **Google Maps Platform Air Quality, Pollen, Weather and Solar APIs:** need a billing account and charge beyond a monthly allowance, which breaks the free-data rule.
- **FireSat (Earth Fire Alliance, backed by Google):** first operational satellites launched July 2026, data only to early-adopter fire agencies from late 2026, global access expected by 2028. Revisit then; it would sharpen `fire-detections`.
- **Google Runoff Reanalysis and Reforecast (GRRR) and Flood Hub Inundation History:** downloads outside Earth Engine; GRRR ends in 2023 and Inundation History (128 m, 1999 to 2020) is coarser and older than JRC Global Surface Water, which we already use.
- **ETH Global Canopy Height 2020 (10 m):** coarser than the 1 m Meta map for the same question.
- **NASA Black Marble yearly (VNP46A4):** not in Earth Engine; the NOAA yearly composite (item 9) answers the same question.

## Suggested order

Build the shared Earth Engine client once (service account, tile proxy with caching, `value.compute` helper) with ForTy from spec §14, then add items 1 and 2 (forest loss with hectares and drivers) and item 3 (slope angle) in the same pass, since each is a day or less. Items 5, 6 and 9 are small and serve fire, rain and dark-sky questions. Items 4, 7 and 8 need more design (date windows, a waitlist, a tap-to-search interaction). Watch the compute meter after each; move yearly products to precomputed tiles if the month's 150 hours run short.

## Sources

- Earth Engine noncommercial tiers: https://developers.google.com/earth-engine/guides/noncommercial_tiers
- Earth Engine terms: https://earthengine.google.com/terms and https://earthengine.google.com/noncommercial
- REST `projects.maps.create`: https://developers.google.com/earth-engine/reference/rest/v1/projects.maps/create
- Hansen v1.13: https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2025_v1_13
- Drivers of forest loss v1.3: https://developers.google.com/earth-engine/datasets/catalog/projects_landandcarbon_assets_wri_gdm_drivers_forest_loss_1km_v1_3_2001_2025
- Dynamic World: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
- gridMET: https://developers.google.com/earth-engine/datasets/catalog/IDAHO_EPSCOR_GRIDMET
- IMERG: https://developers.google.com/earth-engine/datasets/catalog/NASA_GPM_L3_IMERG_V07
- Flood Forecasting API: https://developers.google.com/flood-forecasting and https://developers.google.com/flood-forecasting/rest
- Satellite Embeddings: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL
- VIIRS annual V22: https://developers.google.com/earth-engine/datasets/catalog/NOAA_VIIRS_DNB_ANNUAL_V22
- Meta canopy height: https://gee-community-catalog.org/projects/meta_trees/
- ERA5-Land daily: https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR
- iNaturalist range maps: https://developers.google.com/earth-engine/datasets/catalog/iNaturalist_MULTI_SPECIES_LATEST
- Nature Trace publisher (ForTy, natural forests, species models): https://developers.google.com/earth-engine/datasets/publisher/nature-trace
- WeatherNext access: https://developers.google.com/weathernext/guides/access-forecast
- ForestCast: https://research.google/blog/forecasting-the-future-of-forests-with-ai-from-counting-losses-to-predicting-risk/
- FireSat status: https://www.heliopsmag.com/airattack/news/first-efa-operational-firesats-reach-orbit/

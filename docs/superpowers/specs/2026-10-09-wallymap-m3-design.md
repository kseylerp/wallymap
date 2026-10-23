# WallyMap: Wally design system, 3D, time, and inspection (Milestone 3)

Date: 2026-10-09. Supersedes the visual sections of `2026-10-09-wildmap-restyle.md` where they conflict. The app is renamed **WallyMap**, framed as a research tool: every view is inspectable, exportable, and cited.

Source of truth for the design system is the Wally iOS code (`/Users/kyleseyler/Projects/Wally/claudedev`), not its DESIGN.md (which that file itself says to distrust). Exact values below come from `Wally/DesignTokens.swift`, `LiquidGlass.swift`, `LiquidComponents.swift`, `MapboxRouteMap.swift`, `RouteGeometryHelpers.swift`, `MapboxTrailStyle.swift`, `LandPolygon.swift`, `MapboxTerrain.swift`, and `wally-pay/components/RouteMap.tsx`.

## 1. Name and logo

- Name: WallyMap. Title, wordmark, package name `wallymap`, README, docs, prompt first line ("You are WallyMap, a research tool for the outdoors").
- Logo: copy `Wally/Assets.xcassets/logo_dark.imageset/Frame 2610430 (2).png` to `public/brand/wally-logo.png` and the app icon `AppIcon.appiconset/Frame 2610403 (5).png` to `public/brand/wally-icon.png` (favicon derived at 32/180/512). Because no vector exists, draw `public/brand/wally-mark.svg`: a rounded triangle (mountain) with a heavy "W" cut through it, outline `#4A4A4A`, fill white; it must read at 20px. The wordmark is the SVG mark plus "WallyMap" in the title font.
- Vercel project and alias stay as they are for now (`wildmap-ai.vercel.app`); a new alias `wallymap.vercel.app` is added if free.

## 2. Tokens (CSS variables; Tailwind `@theme` maps them)

Light only (owner decision 2026-10-09: no dark mode). Wally light surfaces are off-white; the light logo variant (`public/brand/wally-logo-light.png`) is used. Fonts stay Geist (UI) and Source Serif 4 (headings), and primary buttons are black (`--button-primary: var(--ink)`); purple is for links and the route gradient only.

- Scaffold: light `#FAF9F5`, dark `#151515`. Surface: light `#ECEAE7`, dark `#1A1A1A`; deeper surfaces `#292929`, `#1F1F1F` (dark).
- Text: primary light `#1F1F1F` / dark `#F5F5F5`; secondary light `#6B6B6B` / dark `#A0A0A0`.
- Accent `#6E5BFF` (purple): primary buttons, active states, links. Coral `#F57272`: route start, active map pills, progress end color. Sage `#9FB693`: selection rims, chip tint at 0.5. Semantic: warning `#E8884A`, error `#DC5046`, info `#5B9BD5`, caution system orange `#FF9500`.
- Gradient `--route-gradient`: `#6E5BFF` → `#F57272` (routes, progress bars 7px tall, elevation line).
- Type: SF-equivalent on the web: `-apple-system, "SF Pro Text", Inter, system-ui` for text; stats in a rounded tabular face (`"SF Pro Rounded", Inter` with `font-variant-numeric: tabular-nums`). Sizes: display 24/700, title 20/700, subtitle 18/600, label 17/500, body 16/400, bodyLarge 16/500, headlineSmall 16/700, segmented 13, caption 12. Chat answers 18/400. (Geist and Source Serif 4 are removed.)
- Spacing 4/8/12/16/24/32. Radii: 8 (small), 12 (card), 24 (large), 28 (sheets); controls 44 tall (pill radius 22); map pills 36 tall (radius 18).
- Shadows: card `0 6px 12px rgba(0,0,0,.10)`; drawer `0 -10px 30px rgba(0,0,0,.25)`.
- Glass: `backdrop-filter: blur(20px)`; fill = surface at 0.75 plus a 0.12 tint of the accent; 1px gradient border white .18 → .045; shadow `.12` light / `.25` dark, blur 10, y 6. Map pills: black tint 0.35 with a 0.6 white rim. Primary buttons get the "silver sheen" border gradient white .60 → .15.
- Motion: press scale 0.98 ease-out 150ms; spring-like transitions 350ms; camera moves 300–500ms ease-in-out; progress bar 300ms.
- Icons: Lucide (closest web match to SF Symbols), sizes 10/12/14/16/20/24.

## 3. Map styling (ported from Wally)

- Basemaps: Outdoors+Sat (default, current hybrid), Outdoors, Satellite. Contours as Wally: `#FAF9F5` at 0.85 opacity, 0.6px, from zoom 9 (added to the hybrid).
- Routes and route-like lines (agent `route` tool results, GPX, trail selections): white casing 7px under a 4.5px line colored by position along the line from purple to coral (24 slices, as `RouteMap.tsx` does with `line-gradient`), round caps and joins. Direction darts: 16px white darts every ~500 m, max 12, none under 400 m, aligned to bearing over ±40 m, opposing darts dropped on out-and-backs. Mile markers: 12px white dot, `#3A3A3C` 45% ring, 10pt label; every 1 mi under 15 mi, then 2/5/10.
- Data lines (OSM trails and other line layers) keep the satellite-safe palette from `wildmap-restyle.md` with white casings; on plain Outdoors the trails layer switches to Wally's basemap-trail look: `#16A34A` dashes `[2, 1.6]` over a white casing, widths by zoom 11/14/18 → casing 1.8/2.6/4.6, core 1.1/1.7/3.2.
- Public lands (vector tiles): Wally's palette by manager: NPS `#357647`, USFS `#7E9A54`, BLM `#C9A254`, FWS `#488C89`, State `#4A7DB5`, Wilderness `#24543A`; fill opacity by zoom 0.18/0.15/0.08/0.03; 1px white outline at 0.6.
- Pins (point layers and route waypoints): one teardrop 34×44, circle head r15, white 2px ring, shadow `.35` blur 2.5, white glyph, anchored at the tip. Color `#3A3A3C`; the route start pin is coral. Glyphs by type as SVG: start (play), camp (tent), put_in/take_out (arrows), rapid (waves), hazard (triangle), trailhead (hiker), spring (drop), viewpoint (binoculars), species (paw), photo (camera), gauge (wave), snow (snowflake), fire (flame), default (dot). Point layers over ~300 features in view fall back to Wally-style small dots (white 7px, slate ring) and switch to pins when zoomed in; no clustering (Wally has none) except the existing H3 columns mode for counts.
- Selection: clicking a pin or feature fades sibling features of that layer to 35% and eases the camera to it in 350 ms.
- Layer order: land → route casing → route gradient → darts → mile dots → data lines → points → pins → labels.
- 3D (prominent, like Wally): terrain `mapbox-terrain-dem-v1` (tileSize 514, maxzoom 14) is ON by default with exaggeration 1.2; buildings from zoom 13.5 `#D9D9D9` fading to 0.6 opacity; sky layer with a warm horizon and light fog. Pitch presets: Explore 45, Detail 72, Follow 65. Behavior: the world view stays a flat globe; any `set_view`/fit that lands at zoom ≥ 10 eases to pitch 45 with terrain; selecting a feature or starting a route preview eases to pitch 72 (Detail); a "3D" map button flattens to pitch 0 and remembers the choice for the session; the agent can pass `pitch`/`terrain` explicitly. Fits account for pitch (fit first, then pitch, keeping the target in view).
- Camera: fit padding top 60 / right 40 / bottom 200 / left 40 plus the chat panel and sheet footprint (existing `visibleMapPadding`); searched places fit at zoom 8–13.

## 4. Layout and components

- Keep the full-bleed map with the floating "Ask the map" panel, restyled with Wally tokens: light surface glass, radius 28, drag handle 36×5 on mobile (sheet snaps to 46vh and 90vh), Wally's chat presentation (no bubbles: assistant answers left-aligned 18px markdown with 20px side padding; user messages prefixed with an accent `›`; one source link per answer with a 4/3 dashed underline; follow-up pills as Wally multiple-choice rows).
- Map pills (36px glass, black tint on imagery): basemap switch, 3D toggle, layers toggle, time toggle, compare toggle, export.
- Layer panel (replaces chips): a right-side glass drawer, Wally "rail chips" header (30px, radius 15, sage tint when selected). Each loaded layer is a card: title, color swatch, count or "tiles", coverage note, license, source link, visibility, opacity slider, color, render mode (`points | lines | polygons | heat | columns | hexbin`), remove, drag to reorder; for time-aware layers a mini histogram of `t`. Panel header has the dark-mode toggle and "Export view" (downloads each visible GeoJSON layer as `.geojson` and a `citations.md`).
- Inspect card: click any feature (deck.gl pick or vector tile `queryRenderedFeatures`) to open a floating card near the click (Wally card radius 12, card shadow, pointer): friendly property list (`t` as a date, `v` with the layer unit, `signals` for scores), the citation with the source link, "Ask about this" (sends `Tell me about <layer title> "<name>" ...` with a property summary), "Copy GeoJSON", and for routes/trails "Preview route". Escape or click-away closes it.
- Loading: Wally's 3×3 dot spinner in tool-trace rows; the topo heartbeat (port of `wally-guides/src/components/TopoHeartbeat.tsx`) in the panel while the first answer streams.
- Empty state: Wally logo, WallyMap wordmark, research-tool subtitle ("Ask the map. Every answer is drawn, cited, and exportable."), six example prompts (unchanged).

## 5. Time

- Scrubber: when any visible layer has `t`, a bar docks above the composer (desktop) or above the sheet (mobile): play/pause, step, a histogram of counts per bucket, and a draggable window. Buckets follow the data span: years for fire perimeters/forest loss, days for detections/night lights/photos, months for species. The scrubber filters all time-aware GeoJSON layers at once; for tile layers with a date parameter (night lights, forest loss `end_year`) it rewrites the tile URL per step (debounced 150 ms).
- Play: advances one bucket per 600 ms; the layer panel histogram and the inspect card follow the current window.
- Agent control: `set_time({ start, end, play? })` tool so questions like "show fires year by year since 2016" animate.

## 6. Route preview (playback)

- Any route-like LineString (agent `route` tool, a clicked trail, a pasted GPX via the composer's attach button) gets a "Preview" action: the camera follows the line in Follow pitch (65), heading-up, zoom 15–17, at a speed slider (default 60 s per 10 km), with the traversed part of the route drawn in the purple→coral gradient and the rest in white casing only; mile markers tick; an elevation profile (Wally `ElevationProfileChart`: 2px gradient line, 180px tall, white 0.15 grid) shows a moving cursor; the strip chart also plots any visible layer's `v` sampled along the route (fire history, popularity, snow at nearest station). Pause, scrub, and exit.
- `route(from, to, profile)` tool (Mapbox Directions) is added; results render as routes with waypoint pins (start coral).

## 7. Differences over time (compare)

- Compare mode: pick a layer with time or a tile layer with a date/year parameter and two moments (A, B). Three views: swipe (split handle across the canvas), toggle (A/B flip at 1 Hz with a key), and delta (for GeoJSON: features only in A in coral, only in B in purple, both in white; for H3 columns: height = B − A). Presets the agent can call via `compare({ layerId, a, b, mode })`: "forest loss 2015 vs 2025", "night lights 2020 vs today", "fire perimeters before/after a year".
- The inspect card in compare mode shows both values.

## 8. Research-tool guarantees

- Every answer ends with a sources line listing each layer's citation and retrieval time.
- Export view (GeoJSON + citations), copy a feature as GeoJSON, permalink of the map state (Milestone 4 share links move here as a stub: URL hash with viewport + layer ids + time window).
- The eval set (`docs/questions.md`) gains time and compare questions; `scripts/eval-model.mts --set` runs them.

## 9. Out of scope

Dark map style, route recording/live tracking, offline, accounts, clustering, custom Mapbox Studio styles (Natural Earth 2 upload remains deferred).

## 10. Owner revisions (2026-10-09, late)

- **Research look, not consumer.** Hairline borders, minimal rounding on data UI, small-caps section labels, tabular figures, a legend table in the layer panel, no gloss. Frosted panels stay but quiet; off-white surfaces; black primary buttons; the light Wally logo only in the corner; no dark mode.
- **No colors, no icons on data.** Markers are a monochrome cartographic symbol set (triangle, square, hollow/filled circle, diamond, circle-with-dot) with a 1.5px ink stroke and white fill; lines are ink over a white casing with a dash pattern per layer; polygons are ink outlines with ≤12% tints; scores use a grayscale ramp; dense points become light-gray hexagon tiles with ink count labels. Selection is a solid ink fill. Routes keep the purple→coral gradient (approved); everything else is monochrome. The satellite palette in `wildmap-restyle.md` is superseded for markers and lines; it may remain for raster tile layers only.
- **Camera never moves on click.** Selecting a feature opens the card only. Camera moves happen on arrival (`set_view`), route preview, and "Ask about this".
- **No downloads without a click.** Exports happen only from an explicit Export action with a confirm step listing files and size; nothing downloads on load, restore, or as a fallback.
- **Basemap labels:** "Topographical + Satellite" (default), "Topographical", "Satellite". No icons on the basemap pills.

- **Data console (right pane):** the time scrubber docks at the top of the right pane (not under the composer); each layer card carries attribute filters derived from its data (category chips, numeric ranges) that apply instantly to the map, the counts, and exports. Data lines are white over a thin ink casing (no grey lines); routes keep the purple→coral gradient.

## 11. Approved palette (owner, 2026-10-09 late) — supersedes "no colors" where it conflicts

Approved colors only: wally pink `#F57272`, purple `#6E5BFF`, sage `#9FB693`, off-white `#FAF9F5`/`#ECEAE7`, dark grey `#3A3A3C` (ink `#1F1F1F` for text). No other hues. Symbols stay shape-coded with no icons.

- **Dark grey:** symbol strokes, trail/data lines over a white casing, polygon outlines, text, hex count labels.
- **Purple:** selection (symbol fill, selected line), the active trail, the time-window highlight, compare side A.
- **Wally pink:** route start, the scrubber playhead, compare side B, hazard tints (fire perimeters at 12% fill).
- **Sage:** natural/protected areas (wilderness, public lands, physical regions) at 10–15% fill; "available/open" states.
- **Off-white:** surfaces and the low end of area, hex-tile and heat ramps; never the low end of a line ramp (owner 2026-10-10: an off-white line reads as plain white on satellite).
- **Routes:** purple → pink gradient (unchanged).
- **Ramps (heatmaps and hex tiles may use more colors, derived from the five, lightness monotonic):** density/heat/hex: off-white → sage → purple → dark grey; popularity: off-white → pink → purple; remoteness: off-white → sage → dark grey; score and density lines start at sage instead (popularity lines sage → pink → purple, density lines sage → purple → dark grey, remoteness lines sage → dark grey); compare: diverging purple ← off-white → pink, unchanged = dark grey; 3D columns: sage → purple by height with dark grey edges. Interpolate in OKLCH; validate contrast against both basemaps.
- **Hatching (owner: "sparse to dense diagonals is the most professional"):** diagonal 45° hatching is the primary density and category encoding. Polygons: category tint at 10–15% plus a hatch in the category's color (sage for protected land, pink for fire, dark grey otherwise) whose line spacing encodes value where a value exists; hex/density tiles: 5 hatch densities (spacing 12 → 3 px) in dark grey (or the ramp color at high density) instead of solid fills; heatmaps: smooth gray/palette ramp only when hatching is impossible. Implement with deck.gl's `FillStyleExtension` (pattern atlas) for GeoJSON/hex layers and Mapbox `fill-pattern` for vector tiles.
- **3D ("yes but with transparency"):** extruded hex columns and buildings are translucent (fill alpha ≈ 0.55), height-ramped sage → purple with dark grey edges; terrain stays opaque.

### 11a. Owner ruling on white (2026-10-09, after a fire test)

"White tends to look like everything else." White is reserved for three uses only: hatch (diagonal) lines, some outlines (casings and selected edges), and 3D edges/highlights. Fills and data symbols carry a palette color; nothing data-bearing is drawn white-on-imagery alone. Fire must look like fire: perimeters get the pink tint plus pink hatch and a pink outline, detections are pink symbols, so a fire query visibly changes the map on both basemaps.

### 11b. Owner picks from the style board (2026-10-09, later)

Points = board A (monochrome shapes, off-white fill, white halo; selection purple). Density hex tiles = board A (gray ramp off-white → dark grey, 0.55 → 0.80, log scale, white edges, counts), not hatching; hatching stays for polygons and public-lands tiles. Extruded hex columns = board C (translucent white volumes with dark-grey caps; only the tallest cell takes purple). Lines (owner, 2026-10-14: no dark-grey line cores) draw as native Mapbox line layers, crisp at constant pixel widths on 3D terrain: 2.5 px on a white casing 2 px wider at 0.9: maintained trails board T1 (8 px dark-grey dashes alternating with sage, the only dark grey on a line; ruled 2026-10-14 after pure sage vanished on green Topo), other polylines solid sage, forest roads sage dashed, use trails sage dots, score and facet lines on the sage → pink → purple ramp, named routes the purple → pink gradient, selected purple 3.5 px; dark grey stays for area outlines and symbol strokes. Also requested: point clusters (blobs with counts) and heatmaps as render modes for dense point layers (follow-up task).

## 12. Standard views (owner, 2026-10-14: "we need standardized views to show a wide range of data/change/details")

Every answer is rendered as one of seven views. The agent names the view on the render op (`render.view`), the reducer defaults it from the data when the agent does not, and the client renders each view the same way every time.

| view | when | camera | encoding | console | note |
|---|---|---|---|---|---|
| change | two sets or two dates/amounts of the same layer ("then vs now", "what changed") | fit to the union of both | lost (A-only) pink hatch, gained (B-only) purple, unchanged dark grey; tiles: swipe | compare strip prefilled (delta default; swipe, toggle) with both areas/counts and the difference | states both values and the difference |
| timeline | dated features or time tiles ("over time", "year by year", "since") | fit to the features | the layer's normal encoding | scrubber open; cumulative for growth questions, slide for "when"; play ready | states the span and the peak period |
| ranked | features with a magnitude ("largest", "most", "deepest", "how full") | fit to the top-N | proportional symbols or 3D columns by `v`; top-N labelled | the facet slider at the top-N threshold | lists the top 3–6 with numbers and units |
| density | many points ("where are the most", "hotspots", > 500 points) | fit to the data | clusters (default) or heat (when asked) | mode control on clusters/heat | states the densest places |
| detail | one thing ("tell me about", "how deep is", a click) | fit to the feature, lower third | the feature selected (purple) | inspect card open | the card's facts |
| scenario | a parameter layer (sea-level rise amount) | fit to the tiles' coast | the calmed tiles | scenario scrubber at the asked amount | states the amount and the conversion |
| route | a route request | overview → preview | Wally gradient line, mile markers | preview dock, profile | distance, gain, time |

Rules: after a query for a named place the camera fits the returned features (padding for the panels), never the geocoded region; "here" questions never move the camera; the legend always names the encoding in words (what pink means in this view); a view's console controls are open when the answer arrives, so the next question is one click, not a sentence.

### 12a. Filtering in every view (owner: "and filtering")

Each layer declares its facets (`style.facets`): one or two attributes people actually filter by, with labels in the layer's own words and the encoding they drive: mountain-bike and ski difficulty (easy · moderate · hard · expert), hiking trail class (sac_scale), rapid grade, fire acres, power-plant fuel and megawatts, glacier area, monument kind (current · 2021), route length, species group. Facets render inline in the layer row as labelled chips (categories) and a labelled slider (ranges), always visible, never behind a "Filters" button; the free-form filter panel stays for the rest. A small opacity control stays beside them. Facets apply inside every view: the change view filters both sides, ranked re-ranks the filtered set, timeline counts the filtered features per bucket, density clusters only what passes. Counts in the row, the legend, the export and the share link all follow the facets, and the map encodes the primary facet (difficulty as the sage → pink → purple line ramp, with the legend naming the classes). The agent sets facets through `render.filters` when the user names a value and never re-queries to filter.

### 12b. Explain every number on the card (owner, 2026-10-14: "like uranium mines; if you list a score on the detail card it needs an i-icon to explain anything that's not clear")

Each layer declares `fieldHelp`: for every property it shows (and always for `v`, scores, indices, classes, codes), a one-sentence plain explanation, the unit and scale, how it was computed and by whom, and the source link. The inspect card shows the same small serif "i" ring used in the top nav next to any field that has help; tapping it opens a hairline popover with the text and the link. Facet chips and legend keys reuse the same text on hover. Nothing with help text is shown as a bare label: "Score 42" becomes "Hazard score 42 ⓘ" with the explanation one tap away. Layers whose source documents the field (EPA/Navajo AUM priority scores, popularity, remoteness, IUCN categories, NID hazard potential, sac_scale, mtb:scale, piste difficulty, GBIF basis of record, drought categories) get the official wording.

### 12c. Typed attributes pick the control (owner, 2026-10-15: "go"; replaces the slider-per-number facets of §12a)

Every layer declares `attributes`: one entry per field a person can slice by, with `type` (category | ordinal | measure | time | flag | name | place), label, unit, help (§12b) and, for ordinal, the ordered levels with plain labels and the source scale they normalise from. The row builds itself from the list; no numeric field becomes a slider by default.

- **Category:** chips with counts; clicking a legend key toggles the same chip. Map: colour or shape.
- **Ordinal (difficulty, grade, class, severity):** ordered chips, one shared band set per activity (climbing grades from YDS, UIAA, French and V-scale map to Beginner, Intermediate, Advanced, Elite, keeping the original grade on the card). Map: the sage → pink → purple ramp.
- **Measure (size, capacity, count, length, area):** ranked, not filtered. "Rank by" picks the measure; the row lists the top 10 synced with the map (hover highlights, click flies and opens the card); symbol size or 3D height encodes it. Size presets ("Large fires: over 10,000 acres") come from the source's own classes where they exist; a clickable mini histogram is the only free range control, under More.
- **Time:** the scrubber with presets (last 7 days, this year, since a named year). The only place a scrubber appears.
- **Flag:** toggle chips ("Open now", "Research grade").
- **Name:** search within the layer.
- **Place:** "within" (my route, a protected area, a radius of a point), usually from chat.

Each row shows by default one category or ordinal chip set and one "Rank by"; everything else sits under More. Chat and controls share one state: "only sport crags" sets the chips.

### 12d. Hex cells carry information (owner, 2026-10-15: "the hexes need better information and use cases")

A hex cell is a summary of the features inside it, never a bare count:
- **Card:** the cell's area (km²) and density per km²; count and its rank among visible cells ("3rd busiest of 120"); the breakdown by the layer's primary category (bar of shares); the layer's measure summed or summarised (total MW, total acres burned, median routes); the time span of features (first and latest date); the top 5 named features in the cell, each opening its own card; "Zoom to this cell" and "Ask about this cell".
- **What the colour means:** chosen per layer from its attributes: count (default), sum of the measure (power capacity per cell), share of one category (share of sport routes), or recency (newest detection). The legend says it in words with the cell size ("Each cell ≈ 36 km²; darker = more wind capacity").
- **When hexes are the right view:** many points where density is the question: fire detections, wildlife sightings, crags in a region, earthquakes, mines, photos. The agent's density view picks the colour basis from the question ("where are the most…" → count; "where is most of the capacity…" → sum; "where is it newest…" → recency).

### 13. Borrow the example's mechanics and visualization, not its style (owner, 2026-10-17: mapped.earth "North America's River Pulse"; "the mechanics and viz not style")

The example draws every river in North America from its own data, one frame per day for two years. WallyMap keeps its own look (spec §10–§11); what it borrows is how the data is encoded and played:
- **Two variables on one mark.** Line width (or point size, or 3D height) is one measure and color is a second ("height is that day's flow, color is water temperature"). Any layer with two measures can map them this way; the legend names both with units and range.
- **The whole network, every day.** Values cover every segment, not only gauges: model or interpolated values (GloFAS discharge per river reach) so the continent fills in, and the frames step daily with smooth transitions between days.
- **The data draws the geography.** When a dense network is the answer, the basemap steps back (hidden roads, labels and hillshade; WallyMap's own colors) so rivers, trails or fire lines outline the land by themselves.
- **A live aggregate per frame.** While time plays, the layer's measure is totalled for the current frame ("discharge to the sea, every outlet combined: 92,407 m³/s") with a bar against the period's low and high, and the date is prominent. Seasonal data gets a year dial showing where in the year the frame is.
- **The caption follows the data's shape.** The note gives the low and the peak with numbers, the ratio between them ("more than quadruples"), whether it repeats each year, named features that drive it, and the named event that explains an anomaly ("swollen in April 2025 by the Ohio Valley flood"), then says what width and color mean.
- **Playback exports.** A timeline view can be saved as a short video and a still, with the legend, date and running total included, in WallyMap's style.
- **A river pulse layer.** River lines (HydroRIVERS or equivalent geometry) with width from daily discharge (Open-Meteo Flood API, GloFAS, global) and color from water temperature where a source exists, for a basin or region, played daily.

#### 13a. Second example: mapped.earth "Cook Inlet, a Week of Currents" (owner, 2026-10-17)

Surface currents hour by hour for a week, drawn as moving particles: color is water temperature, brightness is speed. Mechanics to borrow:
- **Flow fields as moving particles.** Any vector field (ocean and tidal currents, wind, river velocity) animates as particles advected along the field, with color for a second variable and brightness or trail length for speed. Sources: NOAA Operational Forecast Systems (CIOFS, SFBOFS and the other OFS models, hourly), Open-Meteo Marine ocean currents (global), Open-Meteo wind (global, hourly).
- **Hourly frames over days.** The time scrubber steps hourly for forecast and model fields.
- **A linked curve.** A small time-series chart beside the map (Anchorage tide height) with the playhead synced, so reversals line up with high and low tide; reused for river discharge, wind speed at a point, snow depth.
- **Use cases from the comments:** where the current helps a sailboat race or a paddle trip at a given hour; where warm and cold water masses meet (salmon, fishing); a named superlative in the caption ("the water at Anchorage dropped 32 feet in seven hours").

### 14. Forest types (owner, 2026-10-23: Google DeepMind / WRI / IIASA "Forest Typology (ForTy)")

ForTy classifies every 10 m of land into primary forest, naturally regenerating forest, planted forest, plantation forest, tree crops and agroforestry, or other land (FAO definitions, 90% class accuracy on 9,000 validation sites), with per-class probabilities, a 2020 baseline and an early yearly series 2017–2025 that shows what replaced lost forest. Licence CC BY 4.0. Access: Earth Engine (`projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection`, free for noncommercial use after registering a Google Cloud project) or 613 Cloud-Optimized GeoTIFF zips on figshare (0.33 TB, too large to host). Plan: a `forest-types` layer served through Earth Engine map tiles from a server-side service account (tile URLs refreshed server-side), six categorical colors with a legend of classes in view, a confidence threshold control (strict for regulatory use, loose for extent), a card from Earth Engine's pixel value at the tapped point (class and probabilities), and a change view 2017–2025 ("natural forest converted to plantation or tree crops") using the compare grammar (lost area pink with area stated). Blocked on the owner registering Earth Engine (noncommercial) and creating a service account key.

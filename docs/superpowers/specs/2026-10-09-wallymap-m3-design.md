# WallyMap: Wally design system, 3D, time, and inspection (Milestone 3)

Date: 2026-10-09. Supersedes the visual sections of `2026-10-09-wildmap-restyle.md` where they conflict. The app is renamed **WallyMap**, framed as a research tool: every view is inspectable, exportable, and cited.

Source of truth for the design system is the Wally iOS code (`/Users/kyleseyler/Projects/Wally/claudedev`), not its DESIGN.md (which that file itself says to distrust). Exact values below come from `Wally/DesignTokens.swift`, `LiquidGlass.swift`, `LiquidComponents.swift`, `MapboxRouteMap.swift`, `RouteGeometryHelpers.swift`, `MapboxTrailStyle.swift`, `LandPolygon.swift`, `MapboxTerrain.swift`, and `wally-pay/components/RouteMap.tsx`.

## 1. Name and logo

- Name: WallyMap. Title, wordmark, package name `wallymap`, README, docs, prompt first line ("You are WallyMap, a research tool for the outdoors").
- Logo: copy `Wally/Assets.xcassets/logo_dark.imageset/Frame 2610430 (2).png` to `public/brand/wally-logo.png` and the app icon `AppIcon.appiconset/Frame 2610403 (5).png` to `public/brand/wally-icon.png` (favicon derived at 32/180/512). Because no vector exists, draw `public/brand/wally-mark.svg`: a rounded triangle (mountain) with a heavy "W" cut through it, outline `#4A4A4A`, fill white; it must read at 20px. The wordmark is the SVG mark plus "WallyMap" in the title font.
- Vercel project and alias stay as they are for now (`wildmap-ai.vercel.app`); a new alias `wallymap.vercel.app` is added if free.

## 2. Tokens (CSS variables; Tailwind `@theme` maps them)

Light is the default (Wally light surfaces are off-white, which matches the owner's "barely off-white" direction); dark follows Wally's dark tokens and is a toggle in the layer panel header.

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
- 3D: terrain `mapbox-terrain-dem-v1` (tileSize 514, maxzoom 14), exaggeration 1.2 in 3D, 1.0 flat; buildings from zoom 13.5 `#D9D9D9` fading to 0.6 opacity; pitch presets: Explore 45, Detail 72, Follow 65. A "3D" map pill toggles terrain and pitch (45 default); sky and fog are added (Mapbox `sky` layer, warm horizon) because imagery under pitch needs them.
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

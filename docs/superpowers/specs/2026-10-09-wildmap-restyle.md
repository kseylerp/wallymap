# WildMap rename and restyle

Date: 2026-10-09. Scope: rename MapAgent to WildMap and restyle the Milestone 1 UI. No behavior changes to the agent, layers, or renderer beyond colors and the default basemap.

## Name

"WildMap" everywhere a user or contributor sees it: `package.json` name `wildmap`, `<title>` and metadata, the wordmark, EmptyState copy, README, `docs/layers.md`, `docs/questions.md`, `.env.example` comments, the e2e test. The design spec and M1 plan under `docs/superpowers/` are historical and keep their text. The agent system prompt may say "You are WildMap" in its first line.

## Visual language

Reference: a full-bleed satellite map with frosted-glass controls floating over it; one warm accent; large corner radii; round pins with count badges; a white detail card with a pointer.

Tokens (CSS variables on `:root`, used everywhere; no raw hex in components). Revised 2026-10-09 after review: "not orange, barely off-white". The map imagery is the color; the UI is white.

- `--paper: #FFFFFF` cards and pills; `--cream: #F5F5F3` panel base (barely off-white); `--ink: #1A1A1A` text; `--ink-muted: #7A7A76`; `--line: rgba(0,0,0,0.07)`
- `--accent: #E0893F` (warm amber) used ONLY for count badges, the send button, an active segmented-control dot, and a highlighted result; never as a surface tint. No `--accent-soft` tints on bubbles or pills. `--accent-deep: #C9772F` hover.
- `--slate: #2F3A44` default data stroke on imagery (trails, perimeters) with a 1px white casing; `--moss: #5E7D5A` success/available; `--mist: #EDEDEA` user bubbles and hover states
- `--glass: rgba(255,255,255,0.82)` with `backdrop-filter: blur(18px) saturate(1.1)` and a 1px `rgba(255,255,255,0.6)` inner border; `--glass-dark: rgba(26,26,26,0.72)` for dark chips/cards on bright imagery (version/journey cards later)
- Data lines: `osm-trails` style color `#2F3A44` at 2.5px with a white casing (deck: two GeoJsonLayers or `getLineColor` white 4px beneath); the `render` tool's `color` overrides only when the user asked for a color. Points: white 7px circle, 2px `--slate` stroke; a count badge in `--accent` when clustered.
- Radii: `--r-pill: 999px`, `--r-card: 24px`, `--r-panel: 28px`. Shadows: soft, low (`0 10px 30px rgba(31,30,27,0.12)`).

Fonts via `next/font/google`, self-hosted at build: **Geist** for UI and body (weights 400, 500, 600), **Source Serif 4** for the wordmark, section headings, and answer headings (weights 500, 600). Body 15px/1.5; headings tight (-0.01em).

Chat bubbles: user messages on `--mist`, assistant answers on `--paper` cards with a hairline border; follow-up pills white with a hairline border and `--ink` text; the Empty-state card is `--glass` with white question pills.

Basemap default becomes a new hybrid `outdoors-satellite`: the Mapbox Outdoors style (contours, hillshade, trails, paths, roads, labels, water) with the Mapbox satellite raster (`mapbox://mapbox.satellite`) inserted beneath its vector detail. On `style.load`, add the raster source and a raster layer placed just above the style's background/land layer, then hide the Outdoors fill layers that would occlude the imagery (landcover, landuse, national-park, land-structure, wetland, and similar area fills; keep water, hillshade, contours, roads, paths, and labels). Tune `raster-opacity` (about 0.9) and keep hillshade at reduced opacity so terrain reads. `outdoors`, `satellite` (satellite-streets), and `natural-earth-2` remain selectable; the segmented control shows Outdoors+Sat / Outdoors / Satellite. Trail line color becomes `--accent`; the OSM layer style color updates to `#D97757`. Point layers render as a white 7px circle with a 2px accent stroke. Polygon fill uses accent at low alpha.

## Layout (desktop ≥ 768px)

- Map fills the viewport; no side rail.
- Top-left: WildMap wordmark (serif) in a glass pill, then a glass segmented control for the basemap (Outdoors+Sat / Outdoors / Satellite).
- Top-right: active layer chips (glass pill per loaded layer: color dot, title, feature count, eye toggle). This is the minimal layer stack; the full panel is Milestone 2.
- Bottom-right: glass round buttons for zoom in, zoom out, and "globe" (reset to world view, pitch 0).
- Bottom-left: the chat panel, a glass panel 420px wide, max-height 72vh, radius `--r-panel`. Header row: "Ask the map" (serif) and a collapse button. Body: the conversation (user bubbles in `--accent-soft`; assistant answers on `--paper` cards with serif headings; tool trace rows as small muted chips with the tool name and feature count, collapsed by default). Footer: the input as a pill with a terracotta send button. Collapsed state: only the input pill plus a small "WildMap" tag.
- Empty state: centered glass card over the globe: wordmark, one line ("Ask about trails, terrain, and the wild, anywhere on Earth."), and the six example questions as pills in two columns. Clicking one sends it and the card gives way to the panel.
- Error cards: `--paper` with a terracotta left bar, `role="alert"`.
- Follow-up questions: the final bulleted list in an answer renders as tappable pills (parse the trailing list of 2–3 bullets; clicking sends the text). Falls back to a plain list when no trailing list exists.

## Mobile (< 768px)

Map full-screen. The chat panel is a bottom sheet (glass, radius on top corners, 46vh, scrollable) with a grab handle that toggles to a collapsed input pill. Top controls shrink to icons.

## Preserve

`data-testid="map-canvas"`, `data-testid="empty-state"`, `data-testid="tool-trace"`, the six exact example-question strings, the MapSetupNotice text (restyled), all existing tests (update the one that asserts the default basemap and any that assert the old trail color). `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm e2e` (the always-run test) all pass.

## Out of scope

Dark mode, the Natural Earth 2 style upload, the versions strip, share links, 3D modes, pins with per-feature detail cards (needs click-to-inspect, Milestone 2).

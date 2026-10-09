# WildMap rename and restyle

Date: 2026-10-09. Scope: rename MapAgent to WildMap and restyle the Milestone 1 UI. No behavior changes to the agent, layers, or renderer beyond colors and the default basemap.

## Name

"WildMap" everywhere a user or contributor sees it: `package.json` name `wildmap`, `<title>` and metadata, the wordmark, EmptyState copy, README, `docs/layers.md`, `docs/questions.md`, `.env.example` comments, the e2e test. The design spec and M1 plan under `docs/superpowers/` are historical and keep their text. The agent system prompt may say "You are WildMap" in its first line.

## Visual language

Reference: a full-bleed satellite map with frosted-glass controls floating over it; one warm accent; large corner radii; round pins with count badges; a white detail card with a pointer.

Tokens (CSS variables on `:root`, used everywhere; no raw hex in components):

- `--cream: #F4F1EA` page/panel base; `--paper: #FAF8F3` cards; `--ink: #1F1E1B` text; `--ink-muted: #6B675F`; `--line: rgba(31,30,27,0.08)`
- `--accent: #D97757` (terracotta) for pins, badges, active trail lines, primary buttons; `--accent-deep: #C4633F` hover; `--accent-soft: #F3DDD3` tints
- `--slate: #5B6B7A` secondary data color; `--moss: #5E7D5A` success/available
- `--glass: rgba(250,248,243,0.72)` with `backdrop-filter: blur(18px) saturate(1.2)` and a 1px `rgba(255,255,255,0.5)` inner border; `--glass-dark: rgba(31,30,27,0.72)` for dark chips on bright imagery
- Radii: `--r-pill: 999px`, `--r-card: 24px`, `--r-panel: 28px`. Shadows: soft, low (`0 10px 30px rgba(31,30,27,0.12)`).

Fonts via `next/font/google`, self-hosted at build: **Geist** for UI and body (weights 400, 500, 600), **Source Serif 4** for the wordmark, section headings, and answer headings (weights 500, 600). Body 15px/1.5; headings tight (-0.01em).

Basemap default becomes `satellite` (Mapbox satellite-streets); `outdoors` and `natural-earth-2` remain selectable. Trail line color becomes `--accent`; the OSM layer style color updates to `#D97757`. Point layers render as a white 7px circle with a 2px accent stroke. Polygon fill uses accent at low alpha.

## Layout (desktop ≥ 768px)

- Map fills the viewport; no side rail.
- Top-left: WildMap wordmark (serif) in a glass pill, then a glass segmented control for the basemap (Satellite / Outdoors).
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

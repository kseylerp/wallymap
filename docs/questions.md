# Example questions

These are the six WildMap starter questions in `components/EmptyState.tsx`. Each one should end with a trail layer drawn on the map and a short note. In Milestone 1 the only data layer is `osm-trails`.

The usual tool order is: find the place, move the map, query the layer, draw it, explain it.

## 1. Show hiking trails around Lake Tahoe

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map flies to Lake Tahoe and shows a network of terracotta trail lines.

## 2. Which trails near Chamonix are alpine grade?

Tools: `geocode` → `set_view` → `query_osm-trails` (with `sacScaleMax` set to an alpine grade) → `render` → `note`

The map shows trails around Chamonix, and the note explains which difficulty grades were included.

## 3. Find footpaths in the Lake District

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map shows footpaths across the English Lake District. If the area is too large, the agent re-queries a smaller box.

## 4. Show tracks and paths around Torres del Paine

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map shows tracks and paths in the Torres del Paine park in Chile; coverage may be sparse.

## 5. What trails run through the Blue Mountains near Sydney?

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map shows trails in the Blue Mountains west of Sydney, and the note summarizes what was found.

## 6. Trails near Yosemite Valley with a name

Tools: `geocode` → `set_view` → `query_osm-trails` (with `namedOnly` true) → `render` → `note`

The map shows only named trails around Yosemite Valley.

## Notes

- If a query returns the hint `zoom_in`, expect an extra `query_osm-trails` call on a smaller area.
- `list_layers` may appear first in the trace; it does not change the result.
- Public Overpass servers can be slow, so a trail query can take 10 to 30 seconds.

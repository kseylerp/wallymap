# Example questions

These are the six WildMap starter questions in `components/EmptyState.tsx`. Together they show a first set of the data layers: trails, fire, forest loss, snow, campsites, and wildlife. The eval set at the bottom covers every layer family. Each question should end with the matching layer drawn on the map and a short note.

The usual tool order is: find the place, move the map, query the layer, draw it, explain it.

## 1. Show hiking trails around Lake Tahoe

Tools: `geocode` → `set_view` → `query_osm-trails` → `render` → `note`

The map flies to Lake Tahoe and shows a network of terracotta trail lines.

## 2. Which wildfires burned near Yosemite in the last 10 years?

Tools: `geocode` → `set_view` → `query_fire-perimeters` → `render` → `note`

The map shows fire perimeters around Yosemite, and the note lists the largest recent fires by year.

## 3. Where has the Amazon lost the most forest since 2015?

Tools: `geocode` → `set_view` → `query_forest-loss` → `render` → `note`

The map shows tree cover loss across the Amazon from 2015 onward; the note names the areas with the heaviest loss.

## 4. How much snow is on the ground around Mount Hood?

Tools: `geocode` → `set_view` → `query_snowpack` → `render` → `note`

The map shows snow depth around Mount Hood, and the note gives the current depth and how recent the reading is.

## 5. Find campsites and forest roads open to vehicles near Moab

Tools: `geocode` → `set_view` → `query_campsites` + `query_forest-roads` → `render` (each layer) → `note`

The map shows campsites together with forest roads open to motor vehicles near Moab, and the note says which is which and that dispersed-camping rules come from the ranger district.

## 6. What wildlife has been spotted around Banff this year?

Tools: `geocode` → `set_view` → `query_species` → `render` → `note`

The map shows recent wildlife sightings around Banff, and the note summarizes the most commonly seen species.

## Notes

- The tool sequences above are typical, not required. The runner only checks that a place was geocoded, a layer was queried and drawn (or a layer error was handled), and a note was written.
- If a query returns the hint `zoom_in`, expect an extra query call on a smaller area.
- `list_layers` may appear first in the trace; it does not change the result.
- Public data servers can be slow, so a query can take 10 to 30 seconds.

## Eval set

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, remoteness (which also looks up a named physical region), a walking route, fire year by year, a compare over time, a sources check, popular campsites, and a physical-region outline.

```bash
node --env-file=.env.local --import tsx scripts/eval-model.mts --set
```

<!-- eval:start -->
- Show hiking trails around Lake Tahoe
- Which wildfires burned near Yosemite in the last 10 years?
- Are there any active fires burning near Missoula right now?
- Where has the Amazon lost the most forest since 2015?
- How much snow is on the ground around Mount Hood?
- Which rivers near Jackson Hole are running high right now?
- Find campsites and forest roads open to vehicles near Moab
- What wildlife has been spotted around Banff this year?
- Which trails and viewpoints around Zion National Park look the most popular?
- Who owns the land around Bryce Canyon, and is any of it designated wilderness?
- Where is the night sky darkest around Great Basin National Park, and how many people live nearby?
- How remote is the Wind River Range?
- Show me a walking route from Tahoe City to Emerald Bay
- Show wildfires near Yosemite year by year since 2016
- Compare forest loss in Rondônia 2015 vs 2025
- Which sources did you use for snow near Mount Hood?
- Which campsites around Moab look the most popular?
- Outline the Sierra Nevada
<!-- eval:end -->

## Last run

Run on 2026-10-09 with model `openai/gpt-oss-120b` and a 12-step cap: **ok 12/12**. A question passes when the agent geocoded a place, queried a layer, drew the result (or handled a layer error), and wrote a note.

| Question | ok | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | geocode, set_view, osm-trails, render, note | 24.7 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | geocode, set_view, fire-perimeters, render | 18.2 |
| Are there any active fires burning near Missoula right now? | yes | geocode, set_view, fire-detections, fire-perimeters, render, render, note | 35.9 |
| Where has the Amazon lost the most forest since 2015? | yes | geocode, set_view, forest-loss, render, note | 34.7 |
| How much snow is on the ground around Mount Hood? | yes | geocode, set_view, snowpack, snowpack, render, note | 36.9 |
| Which rivers near Jackson Hole are running high right now? | yes | list_layers, geocode, geocode, set_view, streamflow, render | 31.7 |
| Find campsites and forest roads open to vehicles near Moab | yes | geocode, set_view, forest-roads, campsites, render, render, note | 35.1 |
| What wildlife has been spotted around Banff this year? | yes | geocode, set_view, species, render, note | 34.1 |
| Which trails and viewpoints around Zion National Park look the most popular? | yes | list_layers, geocode, set_view, osm-trails, popularity, photos, render, render, render, osm-trails, note | 116.6 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | geocode, set_view, public-lands, wilderness, render, render, note | 29.4 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | list_layers, geocode, set_view, night-lights, population, render, render, note | 56.4 |
| How remote is the Wind River Range? | yes | geocode, geocode, geocode, set_view, physical-regions, remoteness, remoteness, set_view, remoteness, render, note | 77.4 |

Things still worth watching: on the Zion question the model queried `osm-trails` a second time even though the prompt says popularity already includes trails (it still finished with a note), and on Wind River it had one malformed tool name (`query_remoteness<|channel|>commentary`, a model glitch) and one zoom-in retry after the view was 89,653 km², over the 60,000 km² remoteness limit.

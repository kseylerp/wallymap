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

`scripts/eval-model.mts --set` reads the questions below (the lines starting with `- ` between the markers), runs each one through the real agent with the model in `MODEL_NAME`, and prints one JSON line per question and a final `ok N/M`. It spends model credits and calls live data servers. The set covers trails, both fire layers, forest loss, snow, stream flow, campsites and roads, species, photos with popularity, public lands with wilderness, night lights with population, and remoteness (which also looks up a named physical region).

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
<!-- eval:end -->

## Last run

Run on 2026-10-09 with model `openai/gpt-oss-120b`: **ok 8/12**. A question passes when the agent geocoded a place, queried a layer, drew the result (or handled a layer error), and wrote a note.

| Question | ok | Tools (query_ prefix dropped) | Seconds |
| --- | --- | --- | --- |
| Show hiking trails around Lake Tahoe | yes | geocode, set_view, osm-trails, render, note | 27.8 |
| Which wildfires burned near Yosemite in the last 10 years? | yes | geocode, set_view, fire-perimeters, render, note | 29.3 |
| Are there any active fires burning near Missoula right now? | no | list_layers, geocode, set_view, fire-detections, fire-detections, fire-perimeters, render, render | 40.2 |
| Where has the Amazon lost the most forest since 2015? | yes | geocode, geocode, set_view, forest-loss, render, note | 25 |
| How much snow is on the ground around Mount Hood? | yes | geocode, set_view, snowpack, set_view, snowpack, render | 40.6 |
| Which rivers near Jackson Hole are running high right now? | yes | geocode, geocode, set_view, streamflow, render, note | 45.5 |
| Find campsites and forest roads open to vehicles near Moab | no | geocode, set_view, campsites, set_view, campsites, forest-roads, render, render | 29.5 |
| What wildlife has been spotted around Banff this year? | yes | geocode, set_view, species, render, note | 34.2 |
| Which trails and viewpoints around Zion National Park look the most popular? | no | geocode, set_view, osm-trails, popularity, photos, render, render, render | 48.7 |
| Who owns the land around Bryce Canyon, and is any of it designated wilderness? | yes | geocode, set_view, public-lands, wilderness, render, render, note | 29 |
| Where is the night sky darkest around Great Basin National Park, and how many people live nearby? | yes | geocode, set_view, night-lights, population, render, render | 37 |
| How remote is the Wind River Range? | no | geocode, geocode, physical-regions, physical-regions, remoteness, remoteness, remoteness, osm-trails | 43.4 |

Why the four failures happened (the run stops after 8 steps, the same cap as the chat endpoint):

- **Active fires near Missoula.** NASA FIRMS now rejects a day range over 5 (`Invalid day range. Expects [1..5]`), but `fire-detections` defaults to 7 days and allows up to 10, so the first query fails and the model retries. This is a bug in `layers/fire-detections.ts`, not in the model.
- **Campsites and roads near Moab.** The model's view was 13,446 km², over the 10,000 km² campsites limit; it zoomed in and re-queried but ran out of steps before writing the note.
- **Popular trails and viewpoints near Zion.** The model queried `osm-trails` as well as `popularity` (which already includes trails), used its steps, and never reached the note.
- **How remote is the Wind River Range.** The region outline was larger than the 20,000 km² remoteness limit, and the model needed several zoom-in retries.

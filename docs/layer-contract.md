# Layer contract: time, legend, labels, display, source status, card title

Six additions to `Layer` (`layers/types.ts`) and its answers. Each one is optional on the layer: the helpers in
`layers/contract.ts` read the declaration first and infer the rest from what the layer already says. Declare a field
only when the inference is wrong for your layer. `registerLayer` checks all of them (`contractProblems`), so a bad
declaration fails the tests, never the map.

## `time?: TimeSpec` and `timeShapeOf(layer, data?)`

`{ shape: "none" | "single" | "snapshots" | "continuous"; dates?: string[]; span?: { start; end }; step?: "hour" | "day" | "month" | "year" }`

- **none**: time is not the question (dams, peaks). No time panel.
- **single**: one reading, or one latest reading per site (groundwater wells, snow stations). Say the date; no scrubber.
- **snapshots**: a few dates (glacier surveys, land cover epochs). Step between `dates` or compare two; no "Since 19xx".
- **continuous**: events or frames over a span (quakes, fire detections, river flow). A scrubber stepping by `step`.

`timeShapeOf` returns the declared shape (filling `dates`, `span`, `step` from the data when left out). Without a
declaration it reads the answer: a series or a dated tile layer is continuous; features dated by `style.timeField`
(default `t`) are `none` with no dates, `single` with one, `snapshots` with 2 to 6 dates holding two or more features
each on average, else `continuous`. Data cannot tell one-reading-per-site from events, so site layers must declare
`time: { shape: "single" }`. Dates are ISO: `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or a timestamp, oldest first.

## `legend?: LegendSpec` and `legendOf(layer, data?)`

`{ kind: "categories" | "ramp" | "size" | "symbol" | "image"; title?; field?; unit?; items?: { label; value?; color?; symbol?; help? }[]; stops?: { label; value?; color? }[]; imageUrl?; note? }`

Every layer resolves to a legend; a test asserts none is empty. Without a declaration it is derived, in order: the
attribute `style.encode.color` reads (levels as categories, a measure as a ramp); a score layer's 0 to 100 ramp; the
primary (or first) category or ordinal with levels; the measure that sizes symbols (stops from its presets, else
"Lower" and "Higher"); an open category's most common values in `data`; and last one swatch in the layer's color
(raster layers add the description's first sentence as `note`). Declare one when the derived key is not what the
map draws: tile layers with a published key (`kind: "image"`, `imageUrl` https), raster color maps (`categories` with
the real drawn colors), and any description that names colors. Validation: categories and symbol need items, ramp and
size two or more stops in ascending `value`, image an `imageUrl`, every entry a label.

## `labels?: LabelSpec` and `labelsOf(layer)`

`{ field: string; max: number; minZoom?: number; rankBy?: string }`

Which features get a name on the map: the top `max` by `rankBy` (source order without it), printing `field`, from
`minZoom` up. Inferred as `{ field: "name", max: 5, rankBy: card.measure.key }` when the card has a measure;
otherwise no labels. Area layers whose answer is a name (basins, regions, wilderness) should declare
`{ field: "name", max: 10 }`.

## `display?: DisplaySpec` and `displayOf(layer)`

`{ units?: "us" | "metric"; timeZone?: "local" | "utc" }`

Defaults: US units first with metric second for US-centred data (`coverage: "us"` or a box centred in the US),
metric first with US second elsewhere; times in local time with the zone abbreviation ("2:15 PM PDT"). Declare `utc`
only where the source's day is a UTC day and a local time would mislead.

## `sourceStatus` on answers and `sourceStatusOf(body)`

`{ ok: true } | { ok: false; reason: "server-error" | "offline" | "rate-limited" | "no-data-for-date"; message; since? }`

On `LayerResult` and `LayerError`; absent means ok. The fetch wrapper (`lib/fetch`, `onSourceFailure`) reports a
5xx or a body that fails `validate` as `server-error`, a 429 as `rate-limited`, and a timeout or unreachable host as
`offline`; `runLayer` copies the first one onto the answer, and on an error from a layer with `outage` it says
`offline` since the outage date. A layer that knows better sets its own: `no-data-for-date` when the source has
nothing for the asked day, or `{ ok: true }` when a fallback host answered after the first failed. The summary and
the layer row show it, so a failed source never leaves a silent blank map.

## `cardTitle(layer, feature, rank?)`

The inspect card's title, never "Feature": the feature's `heading`, `name`, `title` or `species`; else its kind
(through the layer's levels for that key) and nearest place (`place`, `nearest`, `near`, `town`, `location`,
`county`), as "Earthquake 10 km WSW of South Lake Tahoe, CA" or "Rapid near Fayetteville"; else the kind or the
layer's short title with its rank ("Wolf packs #3"). Give features a `place` or `kind` when they have no name.

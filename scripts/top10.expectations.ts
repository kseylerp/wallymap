/**
 * The top 10 use cases' golden questions (docs/top-10-use-cases.md): 5 per use case, precise to vague, the last of each a
 * phone "here" question that carries the map view. Each question names what the finished answer must hold; the checker
 * (scripts/top10Check.ts) turns each field into one machine-checked assertion, and `eval-model.mts --set --tag top10`
 * runs them live. Facts the app cannot hold yet are still asserted (the baseline shows the gap); `needs` says what is
 * missing in words.
 */
import type { Basemap, ViewKind } from "@/lib/render/state";

export type UseCaseId = "T01" | "T02" | "T03" | "T04" | "T05" | "T06" | "T07" | "T08" | "T09" | "T10";

/**
 * A filter the decision needs on a layer ("a|b" either layer, "combine" the joined layer), on key ("a|b" either key):
 * `labels` the chip labels that must be picked (the attribute's level labels; all of them, others allowed), `max` and
 * `min` the range bounds a measure filter must keep inside (5% slack), `on` a flag that must be on.
 */
export type FilterExpect = { layer: string; key: string; labels?: string[]; max?: number; min?: number; on?: boolean; /** Another filter that answers as well ("easy": a short range or the easiest difficulty chip). */ or?: FilterExpect };

/** A query input the question needs: some successful query of `layer` had `key` equal, matching, or within min..max. */
export type InputExpect = { layer: string; key: string; equals?: string | number | boolean; match?: string; min?: number; max?: number };

/** A deciding fact the note must state, in any wording the pattern allows. */
export type FactExpect = { what: string; re: RegExp };

export type Top10Expect = {
  /** "T01.1" to "T10.5": use case and phrasing, 1 most precise, 5 the phone "here" question. */
  id: string;
  useCase: UseCaseId;
  /** The question as asked; a trailing `@view=[w,s,e,n]` is the map view the phone sends. */
  question: string;
  /** Layers that must answer, and be drawn when they return features or tiles ("a|b" either; "combine:<op>" a join). */
  layers: string[];
  /** At least `min` of these layers answered and drawn (a place profile reads several of a set). */
  anyOf?: { min: number; layers: string[] };
  /** Layers that must not be drawn: stale or misleading for this decision. */
  forbid?: string[];
  /** The layer the decision is read from ("a|b"; "combine" the joined layer): view, labels, legend, card, camera. */
  main: string;
  /** Standard views (spec §12) the main layer may end in. */
  view?: ViewKind[];
  /** Basemaps the map may end on. */
  basemap?: Basemap[];
  filters?: FilterExpect[];
  inputs?: InputExpect[];
  /** Measures the main layer may be ranked by (the row's Rank by, op.rankBy or the layer's default). */
  rankBy?: string[];
  /** A compare (two dates or versions of the main layer) is open. */
  compare?: boolean;
  /** Two places side by side: each named in the note in a sentence with a number. */
  places?: string[];
  /** The time panel is open when the answer arrives (the question is about time). */
  timePanel?: boolean;
  /** At least this many of the main layer's drawn features carry an on-map label (capped by what is drawn). */
  labels?: number;
  /** Words the main layer's legend must show (titles and keys, case ignored). */
  legend?: string[];
  /** The top feature's card rows, in this order (others may sit between). */
  card?: string[];
  /** Deciding facts the note states. */
  facts: FactExpect[];
  /** At least this many features from the results named in the note. */
  names?: number;
  /** What the app lacks today for the full answer, in words; checked by the assertions above, listed for the baseline. */
  needs?: string[];
};

// Deciding-number patterns, any clear wording.
const MI = /\b\d+(?:\.\d+)?\s*(?:mi|miles?)\b/i;
const FT = /\b\d[\d,]*\s*(?:ft|feet)\b/i;
const DEG_F = /-?\d+\s*°\s*F|\b-?\d+\s*(?:degrees|deg)\s*F?\b/i;
const MPH = /\b\d+\s*mph\b/i;
const PCT = /\d+(?:\.\d+)?\s*(?:%|percent)/i;
const CFS = /\b\d[\d,]*\s*cfs\b/i;
const AREA = /\d[\d,.]*\s*(?:acres|ha\b|hectares|km²|km2|square (?:kilomet|mile)|sq\.? ?(?:km|mi)|mi²)/i;
const ELEV = /\b\d[\d,]*\s*(?:ft|feet|m|metres|meters)\b/i;
const SAT = /\bsat(?:urday)?\b/i;
const SUN = /\bsun(?:day)?\b/i;
const COUNT = /\b\d[\d,]*\s+(?:\w+\s+){0,2}(?:sightings|records|observations|sites|claims|mines|campsites|campgrounds|sites|crags|trails|fires|plumes|stations|gauges)\b/i;
const MONTH = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const YEAR = /\b(?:19|20)\d\d\b/;
/** A rock's age: in years, or any named period or epoch of the geologic time scale. */
const GEO_AGE = /million years|thousand years|\bma\b|\b(?:holocene|pleistocene|pliocene|miocene|oligocene|eocene|paleocene|quaternary|tertiary|neogene|paleogene|cretaceous|jurassic|triassic|permian|pennsylvanian|mississippian|carboniferous|devonian|silurian|ordovician|cambrian|precambrian|proterozoic|archean)\b/i;

const TRAIL_CARD = ["Length", "Shape", "Round trip", "Climb, round trip", "Difficulty"];
const OUTDOOR = ["outdoors-satellite", "outdoors"] as Basemap[];
const TOPO = ["outdoors", "outdoors-satellite"] as Basemap[];
const DATA_GROUND = ["outdoors", "data-only", "outdoors-satellite"] as Basemap[];
const IMAGERY = ["outdoors-satellite", "satellite"] as Basemap[];

export const TOP10: Top10Expect[] = [
  // ── TRAVEL ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // T01. Pick a day hike.
  {
    id: "T01.1", useCase: "T01",
    question: "Loop hikes under 6 miles with a waterfall near Asheville, under 1,500 ft of climb",
    layers: ["osm-trails|popularity", "outdoor-features", "combine:near"], main: "combine|osm-trails|popularity",
    view: ["ranked"], basemap: OUTDOOR,
    filters: [
      { layer: "osm-trails|popularity|combine", key: "roundTripKm|lengthKm", max: 9.66 },
      { layer: "osm-trails|popularity|combine", key: "shape", labels: ["Loop"] },
      { layer: "osm-trails|popularity|combine", key: "gainM|roundTripGainM", max: 457 },
    ],
    inputs: [{ layer: "outdoor-features", key: "kinds", match: "waterfall" }],
    labels: 3, card: TRAIL_CARD,
    facts: [{ what: "round trip in miles", re: MI }, { what: "climb in feet", re: FT }, { what: "the waterfall", re: /falls|waterfall/i }],
    names: 3,
  },
  {
    id: "T01.2", useCase: "T01",
    question: "Out-and-back hikes to a viewpoint near Boulder, 3 to 6 miles round trip",
    layers: ["osm-trails|popularity", "outdoor-features", "combine:near"], main: "combine|osm-trails|popularity",
    view: ["ranked"], basemap: OUTDOOR,
    filters: [
      { layer: "osm-trails|popularity|combine", key: "roundTripKm|lengthKm", min: 4.8, max: 9.66 },
      { layer: "osm-trails|popularity|combine", key: "shape", labels: ["Out and back"] },
    ],
    inputs: [{ layer: "outdoor-features", key: "kinds", match: "viewpoint" }],
    labels: 3, card: TRAIL_CARD,
    facts: [{ what: "round trip in miles", re: MI }, { what: "climb in feet", re: FT }, { what: "the viewpoint", re: /view|overlook|vista/i }],
    names: 3,
  },
  {
    id: "T01.3", useCase: "T01",
    question: "Good day hikes near Bend",
    layers: ["osm-trails|popularity"], main: "osm-trails|popularity", view: ["ranked"], basemap: OUTDOOR,
    filters: [{ layer: "osm-trails|popularity", key: "roundTripKm|lengthKm", min: 3, max: 25 }],
    labels: 3, card: TRAIL_CARD, legend: ["Difficulty"],
    facts: [{ what: "round trip in miles", re: MI }, { what: "climb in feet", re: FT }],
    names: 3,
  },
  {
    id: "T01.4", useCase: "T01",
    question: "An easy hike with a view near Lake Tahoe",
    layers: ["osm-trails|popularity", "outdoor-features"], main: "combine|osm-trails|popularity", view: ["ranked"], basemap: OUTDOOR,
    filters: [{ layer: "osm-trails|popularity|combine", key: "roundTripKm|lengthKm|gainM", max: 12, or: { layer: "osm-trails|popularity|combine", key: "sac_scale", labels: ["Hiking (T1)"] } }],
    labels: 3, card: TRAIL_CARD,
    facts: [{ what: "round trip in miles", re: MI }, { what: "the view", re: /view|overlook|vista|lake/i }],
    names: 2,
  },
  {
    id: "T01.5", useCase: "T01",
    question: "Any good hikes around here? @view=[-122.15,45.53,-121.85,45.68]",
    layers: ["osm-trails|popularity"], main: "osm-trails|popularity", view: ["ranked"], basemap: OUTDOOR,
    labels: 3, card: TRAIL_CARD,
    facts: [{ what: "round trip in miles", re: MI }, { what: "climb in feet", re: FT }],
    names: 3,
  },

  // T02. Trip conditions now and this weekend.
  {
    id: "T02.1", useCase: "T02",
    question: "Forecast for Paradise on Mount Rainier this Saturday and Sunday: high, low, chance of rain and wind",
    layers: ["weather-forecast"], main: "weather-forecast", basemap: TOPO,
    labels: 1, card: ["Temperature", "Chance of rain or snow", "Wind", "Saturday", "Sunday"],
    facts: [{ what: "Saturday", re: SAT }, { what: "Sunday", re: SUN }, { what: "temperature in °F", re: DEG_F }, { what: "chance of rain", re: PCT }, { what: "wind in mph", re: MPH }],
  },
  {
    id: "T02.2", useCase: "T02",
    question: "Any weather alerts, smoke or fires near Yosemite Valley right now?",
    layers: ["weather-alerts", "smoke", "fire-perimeters|fire-detections"], main: "fire-perimeters|fire-detections|weather-alerts|smoke", basemap: OUTDOOR,
    timePanel: true,
    facts: [{ what: "alerts said (or none)", re: /alert|warning|advisory/i }, { what: "smoke said (or none)", re: /smoke/i }, { what: "fire distance or acres (or none)", re: /\b(?:no|none)\b[^.]*fire|\d[\d,]*\s*(?:acres|mi|miles)/i }],
  },
  {
    id: "T02.3", useCase: "T02",
    question: "Is there snow on the ground at Lake Tahoe right now, and any avalanche danger?",
    layers: ["snow-cover|snowpack", "snowpack", "avalanche"], main: "snowpack", basemap: OUTDOOR,
    labels: 3, card: ["Snow depth", "Snow water equivalent", "Percent of normal", "Reading"], legend: ["Compared with normal"],
    facts: [{ what: "snow depth in inches", re: /\b\d+(?:\.\d+)?\s*(?:in\b|inch|")/i }, { what: "avalanche rating or none", re: /avalanche|no rating|not (?:yet )?(?:issu|rat)/i }, { what: "date of the reading", re: MONTH }],
    names: 2,
  },
  {
    id: "T02.4", useCase: "T02",
    question: "What's Moab going to be like this weekend?",
    layers: ["weather-forecast"], main: "weather-forecast", basemap: TOPO,
    labels: 1, card: ["Temperature", "Chance of rain or snow", "Wind", "Saturday", "Sunday"],
    facts: [{ what: "Saturday", re: SAT }, { what: "Sunday", re: SUN }, { what: "temperature in °F", re: DEG_F }],
    needs: ["closures (park and road status) beside the forecast"],
  },
  {
    id: "T02.5", useCase: "T02",
    question: "Conditions here this weekend? @view=[-118.65,37.25,-118.25,37.5]",
    layers: ["weather-forecast", "weather-alerts"], main: "weather-forecast", basemap: TOPO,
    labels: 1, card: ["Temperature", "Chance of rain or snow", "Wind", "Saturday", "Sunday"],
    facts: [{ what: "Saturday", re: SAT }, { what: "Sunday", re: SUN }, { what: "temperature in °F", re: DEG_F }, { what: "alerts said (or none)", re: /alert|warning|advisory/i }],
  },

  // T03. Find an activity at my level.
  {
    id: "T03.1", useCase: "T03",
    question: "Intermediate blue mountain bike trails near Bentonville",
    layers: ["mtb-trails"], main: "mtb-trails", basemap: OUTDOOR,
    filters: [{ layer: "mtb-trails", key: "v|level", labels: ["Blue|Intermediate"] }],
    labels: 3, legend: ["Difficulty"], card: ["IMBA color", "Length"],
    facts: [{ what: "trail length in miles", re: MI }, { what: "how many blue trails", re: /\b\d+\b[^.]*\b(?:blue|intermediate)/i }],
    names: 3,
  },
  {
    id: "T03.2", useCase: "T03",
    question: "Sport crags near Red River Gorge with 5.10 to 5.11 routes that are shaded in the afternoon",
    layers: ["climbing"], main: "climbing", view: ["ranked"], basemap: IMAGERY,
    filters: [
      { layer: "climbing", key: "disciplines", labels: ["Sport"] },
      { layer: "climbing", key: "sportBands|gradeBands", labels: ["Intermediate"] },
      { layer: "climbing", key: "afternoonShade|aspect", on: true },
    ],
    labels: 3, legend: ["Routes"], card: ["Routes", "Grades", "Sport", "Afternoon shade"],
    facts: [{ what: "route counts", re: /\b\d+\s+(?:sport\s+)?routes?\b/i }, { what: "grade band", re: /5\.1[01]/ }, { what: "shade or aspect", re: /shade|faces?|north|east/i }],
    names: 3,
  },
  {
    id: "T03.3", useCase: "T03",
    question: "Class III whitewater near Asheville with enough water this weekend",
    // A documented data gap (docs/top-10-use-cases.md T03.3): no free source rates US sections by class or gives a
    // runnable range, so the answer says so plainly and gives what exists, the gauges' flow against normal.
    layers: ["paddling", "streamflow"], main: "streamflow|paddling", basemap: TOPO,
    filters: [{ layer: "paddling", key: "v", labels: ["Class III"] }],
    labels: 2,
    facts: [
      { what: "flow in cfs", re: CFS },
      { what: "flow against normal for the date", re: /normal|median|percentile/i },
      { what: "no free source for class or a runnable range, said plainly", re: /no free source|not openly licen[cs]ed/i },
      { what: "the weekend", re: /weekend|\bsat(?:urday)?\b/i },
    ],
    names: 2,
    needs: ["whitewater class on US sections (no free source)", "runnable range per section (no free source)", "flow forecast for the weekend at the section's gauge"],
  },
  {
    id: "T03.4", useCase: "T03",
    question: "Low-angle ski terrain under 30 degrees near Teton Pass, and today's avalanche danger",
    layers: ["terrain", "avalanche"], main: "avalanche|terrain", basemap: TOPO,
    inputs: [{ layer: "terrain", key: "mode", equals: "slope" }],
    // Off season a zone has no rating and no elevation bands; in season its card adds Above, Near and Below treeline and Issued.
    legend: ["Avalanche danger"], card: ["Danger", "Avalanche center"],
    facts: [{ what: "slope angle", re: /\b(?:25|30)\s*°|\b30\s*degrees/i }, { what: "danger level or no rating", re: /low|moderate|considerable|high|extreme|no rating|not (?:yet )?(?:issu|rat)/i }],
    needs: ["ski-route candidates kept only where slope stays under 30° (a raster join)"],
  },
  {
    id: "T03.5", useCase: "T03",
    question: "Easy bike trails here @view=[-111.85,34.8,-111.7,34.92]",
    layers: ["mtb-trails"], main: "mtb-trails", basemap: OUTDOOR,
    filters: [{ layer: "mtb-trails", key: "v|level", labels: ["Green|Beginner"] }],
    labels: 3, legend: ["Difficulty"], card: ["IMBA color", "Length"],
    facts: [{ what: "trail length in miles", re: MI }],
    names: 3,
  },

  // T04. Where to camp.
  {
    id: "T04.1", useCase: "T04",
    question: "Free dispersed camping on national forest land near Flagstaff that a passenger car can reach",
    layers: ["forest-roads", "public-lands"], main: "forest-roads", basemap: OUTDOOR,
    filters: [{ layer: "forest-roads", key: "level", labels: ["Passenger car"] }],
    labels: 3, legend: ["Maintenance level"], card: ["Maintenance level", "Camping rule here", "Open to passenger cars by law"],
    facts: [{ what: "where dispersed camping is legal", re: /dispersed|coconino|kaibab|national forest/i }, { what: "road numbers or miles", re: /\b(?:FR|NFSR|road)\s*\d+|\d+(?:\.\d+)?\s*mi/i }],
    names: 2,
    needs: ["closure orders by ranger district (only a few are bundled)"],
  },
  {
    id: "T04.2", useCase: "T04",
    question: "Which campgrounds near Lake Tahoe are open now?",
    layers: ["recreation-sites"], main: "recreation-sites", basemap: OUTDOOR,
    filters: [{ layer: "recreation-sites", key: "kind", labels: ["Campgrounds"] }, { layer: "recreation-sites", key: "status", labels: ["Open"] }],
    labels: 3, legend: ["Kind"], card: ["Type", "Managed by", "Status", "Reservable"],
    facts: [{ what: "how many open", re: /\b\d+\b[^.]*\bopen\b|\bopen\b[^.]*\b\d+\b/i }],
    names: 3,
    needs: ["season dates per campground (Recreation.gov RIDB)"],
  },
  {
    id: "T04.3", useCase: "T04",
    question: "Campsites near water along the Wonderland Trail",
    layers: ["osm-trails", "campsites", "combine:along"], main: "combine|campsites", basemap: OUTDOOR,
    inputs: [{ layer: "campsites", key: "includeParking", equals: false }],
    labels: 3, card: ["Type", "Fee"],
    facts: [{ what: "how many camps along the trail", re: /\b\d+\b[^.]*\b(?:camps?|campsites?|sites?)\b/i }, { what: "permit rule", re: /permit/i }, { what: "water", re: /water|lake|creek|river|spring/i }],
    names: 3,
    needs: ["water sources joined to each camp (a second join: lakes, streams, springs within 200 m)"],
  },
  {
    id: "T04.4", useCase: "T04",
    question: "Camping near Moab",
    layers: ["campsites|recreation-sites", "public-lands"], main: "campsites|recreation-sites", basemap: OUTDOOR,
    labels: 3, card: ["Type", "Fee"],
    facts: [{ what: "how many sites", re: COUNT }, { what: "BLM designated-sites rule", re: /designated|BLM/i }],
    names: 3,
  },
  {
    id: "T04.5", useCase: "T04",
    question: "Where can I camp around here? @view=[-106.45,39.15,-106.2,39.3]",
    layers: ["campsites|recreation-sites", "forest-roads|public-lands"], main: "campsites|recreation-sites", basemap: OUTDOOR,
    labels: 3, card: ["Type"],
    facts: [{ what: "how many sites", re: COUNT }, { what: "who manages the land", re: /national forest|BLM|San Isabel|public land/i }],
    names: 2,
  },

  // ── ENVIRONMENTALISM ──────────────────────────────────────────────────────────────────────────────────────────────
  // T05. What changed here since a year.
  {
    id: "T05.1", useCase: "T05",
    question: "How much forest did Pará lose since 2017 and what drove it?",
    layers: ["forest-loss"], main: "forest-loss", basemap: IMAGERY,
    inputs: [{ layer: "forest-loss", key: "startYear", equals: 2017 }],
    timePanel: true, legend: ["Tree cover loss"],
    facts: [{ what: "hectares or km² lost", re: AREA }, { what: "the driver (or that the app cannot say)", re: /driver|agricultur|pasture|cattle|logging|fire|cannot|can't|not (?:in|available)/i }, { what: "since 2017", re: /2017/ }],
  },
  {
    id: "T05.2", useCase: "T05",
    question: "How much have the glaciers in Glacier National Park shrunk since the 1960s?",
    layers: ["glaciers"], main: "glaciers", view: ["change"], basemap: IMAGERY, compare: true,
    labels: 3, card: ["Area", "Survey", "Ice lost since the first survey", "Area in the first survey"],
    facts: [{ what: "km² then and now", re: /km²|km2|square kilomet/i }, { what: "percent lost", re: PCT }, { what: "the two survey years", re: /19[67]\d[^.]*20[01]\d|20[01]\d[^.]*19[67]\d/ }],
    names: 1,
  },
  {
    id: "T05.3", useCase: "T05",
    question: "How has Bears Ears changed since 2021?",
    layers: ["monuments"], main: "monuments", view: ["change"], basemap: OUTDOOR, compare: true,
    card: ["Area", "Boundary", "Designation"], legend: ["Boundary|2021|lost"],
    facts: [{ what: "area then and now", re: /km²|km2|acres|square/i }, { what: "the difference", re: /\b(?:lost|los(?:e|es|ing)|smaller|cut|reduc\w*|shr[iau]nk\w*|difference|less)\b/i }, { what: "2021", re: /2021/ }],
    names: 1,
  },
  {
    id: "T05.4", useCase: "T05",
    question: "Burn scars around Paradise, California since 2018",
    layers: ["fire-perimeters", "burn-severity"], main: "fire-perimeters", view: ["timeline", "ranked"], basemap: IMAGERY,
    labels: 3, legend: ["Status"], card: ["Acres burned", "Status", "Year"],
    facts: [{ what: "acres burned", re: /\d[\d,]*\s*acres/i }, { what: "the Camp Fire 2018", re: /camp fire|2018/i }, { what: "severity", re: /severity|high|moderate/i }],
    names: 2,
    needs: ["acres by severity class inside each perimeter (a raster total)"],
  },
  {
    id: "T05.5", useCase: "T05",
    question: "What changed here since 2015? @view=[-122.5,44.6,-122.0,44.9]",
    layers: ["forest-loss|fire-perimeters|imagery-by-date|forest-types"], main: "fire-perimeters|forest-loss|imagery-by-date|forest-types", basemap: IMAGERY,
    facts: [{ what: "what changed with a size", re: AREA }, { what: "when", re: YEAR }],
    needs: ["one change summary across layers (forest loss, fires, land cover) with areas"],
  },

  // T06. What protects this place and what threatens it.
  {
    id: "T06.1", useCase: "T06",
    question: "What protects Grand Staircase-Escalante, and are there mining claims, mines or pipelines inside or near it?",
    layers: ["monuments", "mines|mining-claims", "pipelines-lines"], main: "monuments", basemap: OUTDOOR,
    card: ["Area", "Boundary", "Designation"],
    facts: [{ what: "the protection (monument, managed by BLM)", re: /monument|BLM/i }, { what: "how many mines or claims", re: /\b\d[\d,]*\b[^.]*\b(?:mines?|claims?|prospects?)\b/i }, { what: "pipelines (or none)", re: /pipeline/i }],
    needs: ["a within/near join of threats against the protected outline"],
  },
  {
    id: "T06.2", useCase: "T06",
    question: "Uranium mines near the Grand Canyon",
    layers: ["mines|uranium"], main: "mines|uranium", basemap: OUTDOOR,
    filters: [{ layer: "mines", key: "commodity", labels: ["Uranium"] }],
    labels: 3, card: ["Status when last recorded", "Commodities"],
    facts: [{ what: "how many uranium sites", re: /\b\d[\d,]*\b[^.]*uranium|uranium[^.]*\b\d[\d,]*\b/i }, { what: "status (producer, past producer)", re: /producer|prospect|active|closed/i }],
    names: 2,
    needs: ["the 2023 Baaj Nwaavjo I'tah Kukveni monument outline and the 2012 mineral withdrawal beside the mines"],
  },
  {
    id: "T06.3", useCase: "T06",
    question: "Is Chaco Canyon threatened by oil and gas?",
    layers: ["mineral-leases|pipelines-lines|methane-plumes"], main: "mineral-leases|methane-plumes|pipelines-lines", basemap: OUTDOOR,
    labels: 3,
    facts: [{ what: "lease, pipeline or plume count, or methane rate", re: /kg\/h|\b\d[\d,]*\b[^.]*(?:leases?|pipelines?|plumes?|sources?)/i }, { what: "distance to the park", re: /\b\d+(?:\.\d+)?\s*(?:mi|miles|km)\b/i }],
    names: 2,
    needs: ["oil and gas wells (state well records)", "the 10-mile withdrawal buffer around Chaco"],
  },
  {
    id: "T06.4", useCase: "T06",
    question: "What threatens the Boundary Waters?",
    layers: ["mines|mining-claims|mineral-leases|fire-hazard|pipelines-lines"], main: "mines|mining-claims|mineral-leases|fire-hazard|pipelines-lines", basemap: OUTDOOR,
    facts: [{ what: "named threats with numbers", re: /\b\d[\d,]*\b/ }, { what: "copper-nickel mining or fire", re: /copper|nickel|mining|mine|fire/i }],
    needs: ["a within/near join against the wilderness outline"],
  },
  {
    id: "T06.5", useCase: "T06",
    question: "Who manages this land and is it protected? @view=[-117.5,42.5,-116.8,43.0]",
    layers: ["public-lands", "wilderness|protected-areas-world"], main: "public-lands", basemap: OUTDOOR,
    legend: ["Managed by"],
    facts: [{ what: "the manager", re: /BLM|Bureau of Land Management/i }, { what: "protected areas named with size", re: AREA }],
    names: 2,
    needs: ["shares of the view by manager and protection (vector tile totals)"],
  },

  // T07. Wildlife and habitat.
  {
    id: "T07.1", useCase: "T07",
    question: "Research-grade moose sightings near Jackson Hole in the last year, by month",
    layers: ["species|gbif-occurrences"], main: "species|gbif-occurrences", view: ["density", "timeline"], basemap: OUTDOOR,
    inputs: [{ layer: "species", key: "taxon", match: "moose|alces" }],
    // "By month" is the sightings over the months (timeline view, time panel), not a filter: keeping some months would
    // hide sightings the question asks for, and keeping all twelve filters nothing.
    timePanel: true, legend: ["per cell|sighting"], card: ["Scientific name", "Seen on"],
    facts: [{ what: "how many sightings", re: /\b\d[\d,]*\s+(?:research[- ]grade\s+)?(?:moose\s+)?(?:sightings|observations|records)/i }, { what: "busiest months", re: MONTH }, { what: "where most were seen", re: /near|around|valley|river|park|creek/i }],
    needs: ["a month chart (sightings per month) beside the map"],
  },
  {
    id: "T07.2", useCase: "T07",
    question: "Where have bald eagles been seen near Seattle in the last 30 days?",
    layers: ["species|gbif-occurrences"], main: "species|gbif-occurrences", basemap: OUTDOOR,
    inputs: [{ layer: "species", key: "days", max: 31 }],
    card: ["Scientific name", "Seen on"],
    facts: [{ what: "how many sightings", re: /\b\d[\d,]*\s+(?:[\w-]+\s+){0,3}(?:sightings|observations|records)/i }, { what: "dates", re: MONTH }],
    names: 0,
  },
  {
    id: "T07.3", useCase: "T07",
    question: "Desert tortoise critical habitat near St. George and where tortoises have been seen",
    layers: ["critical-habitat", "species|gbif-occurrences"], main: "critical-habitat", basemap: OUTDOOR,
    card: ["Species", "Listed as", "Designation"], legend: ["Listed as"],
    facts: [{ what: "habitat unit with area", re: AREA }, { what: "sightings count (or hidden)", re: /\b\d[\d,]*\s+(?:[\w-]+\s+){0,3}(?:sightings|observations|records)|obscured|hidden/i }, { what: "threatened status", re: /threatened/i }],
    names: 1,
    needs: ["sightings inside vs outside the habitat (a join; iNaturalist obscures tortoise locations)"],
  },
  {
    id: "T07.4", useCase: "T07",
    question: "Condors near Big Sur",
    layers: ["condor-range", "species|gbif-occurrences"], main: "condor-range|species|gbif-occurrences", basemap: OUTDOOR,
    legend: ["Today"],
    facts: [{ what: "range today vs early 1800s", re: /range|1800s|historic/i }, { what: "sightings count", re: /\b\d[\d,]*\s+(?:[\w-]+\s+){0,3}(?:sightings|observations|records)/i }],
    needs: ["modelled range maps for any species (iNaturalist Open Range Maps)"],
  },
  {
    id: "T07.5", useCase: "T07",
    question: "What wildlife has been seen around here? @view=[-110.35,44.8,-110.0,44.97]",
    layers: ["species|gbif-occurrences"], main: "species|gbif-occurrences", view: ["density"], basemap: OUTDOOR,
    legend: ["per cell|sighting"],
    facts: [{ what: "top species with counts", re: /\b\d[\d,]*\b/ }, { what: "a named animal", re: /bison|elk|wolf|wolves|pronghorn|bear|coyote|eagle/i }],
    needs: ["species ranked by sightings in the view (a breakdown, not points)"],
  },

  // ── PLACE DATA VIZ ────────────────────────────────────────────────────────────────────────────────────────────────
  // T08. What's the ground made of here.
  {
    id: "T08.1", useCase: "T08",
    question: "What rock types and ages make up Zion Canyon, and are there faults?",
    layers: ["geology", "geologic-unit"], main: "geologic-unit|geology", basemap: DATA_GROUND,
    legend: ["Rock type|Rock family|Age of the youngest rock|Geologic unit"], card: ["Rock", "Description"],
    facts: [{ what: "rock names (Navajo Sandstone, Kayenta)", re: /sandstone|navajo|kayenta|moenave|chinle/i }, { what: "age in million years or period", re: /million years|jurassic|triassic|\bma\b/i }, { what: "faults (or that the app has none)", re: /fault/i }],
  },
  {
    id: "T08.2", useCase: "T08",
    question: "Elevation cross-section from Yosemite Valley to the top of Half Dome",
    layers: ["terrain|peaks|elevation-profile"], main: "terrain|peaks|elevation-profile", basemap: TOPO,
    facts: [{ what: "start and top elevation", re: ELEV }, { what: "total climb", re: /climb|gain|rises?|relief/i }, { what: "steepest part", re: /steep|\d+\s*°|cliff/i }],
    needs: ["a cross-section chart along a drawn line (elevation profile without a route)"],
  },
  {
    id: "T08.3", useCase: "T08",
    question: "Highest and lowest points around Death Valley",
    layers: ["peaks"], main: "peaks", view: ["ranked"], basemap: TOPO,
    rankBy: ["elevation"], labels: 3, card: ["Elevation"], legend: ["Elevation"],
    facts: [{ what: "highest point with elevation", re: /telescope|\d[\d,]*\s*(?:ft|feet|m)\b/i }, { what: "lowest point below sea level", re: /badwater|below sea level|-\s*\d+\s*(?:ft|m)|−\d+/i }],
    names: 2,
    needs: ["lowest points (peaks hold summits only; a terrain minimum)", "hypsometric elevation bands"],
  },
  {
    id: "T08.4", useCase: "T08",
    question: "What's the soil like around Boulder?",
    layers: ["soils|geology|land-cover|geologic-unit"], main: "soils|geology|land-cover|geologic-unit", basemap: DATA_GROUND,
    facts: [{ what: "soil texture or type", re: /loam|clay|sand|silt|soil/i }, { what: "a share or depth", re: /\d+\s*(?:%|percent|in|inches|cm)\b/i }],
    needs: ["soils outside the US (SoilGrids or OpenLandMap)"],
  },
  {
    id: "T08.5", useCase: "T08",
    question: "What's under my feet here? @view=[-109.65,38.68,-109.5,38.78]",
    layers: ["geologic-unit|geology"], main: "geologic-unit|geology", basemap: DATA_GROUND,
    card: ["Rock", "Description"],
    // The point under the view's centre can be a surface deposit (alluvial gravel near Arches): its name and its epoch
    // (Pleistocene, Holocene) answer the question as well as a bedrock formation and a period do.
    facts: [{ what: "rock or deposit name", re: /sandstone|entrada|navajo|shale|limestone|rock|gravel|alluvi|sediment/i }, { what: "age", re: GEO_AGE }],
  },

  // T09. What grows and lives here.
  {
    id: "T09.1", useCase: "T09",
    question: "What ecosystems cover the Great Smoky Mountains, with the share of each?",
    layers: ["vegetation-types|ecoregions|land-cover|forest-types"], main: "vegetation-types|land-cover|forest-types|ecoregions", basemap: DATA_GROUND,
    legend: ["Vegetation type|Land cover|Forest type|Ecoregions"],
    facts: [{ what: "shares", re: PCT }, { what: "named ecosystem", re: /forest|hardwood|spruce|fir|oak|cove|heath/i }],
    needs: ["ecoregions (EPA Level III/IV, RESOLVE)", "vegetation types (LANDFIRE EVT)", "shares of the view per class from the source"],
  },
  {
    id: "T09.2", useCase: "T09",
    question: "Is the forest around Mount Hood natural or planted, and how tall are the trees?",
    layers: ["forest-types", "canopy-height"], main: "forest-types|old-growth|canopy-height", basemap: DATA_GROUND,
    legend: ["Forest type|Canopy height"],
    facts: [{ what: "natural vs planted share", re: /natural|planted|plantation|primary|regenerating/i }, { what: "tree height", re: /\b\d+\s*(?:m|ft|feet|metres)\b[^.]*(?:tall|height)|(?:tall|height)[^.]*\b\d+\s*(?:m|ft|feet)/i }],
    needs: ["canopy height (Meta and WRI 1 m through Earth Engine)"],
  },
  {
    id: "T09.3", useCase: "T09",
    question: "How do the vegetation types of the Sierra Nevada compare with the Colorado Rockies?",
    layers: ["vegetation-types|land-cover|forest-types"], main: "vegetation-types|land-cover|forest-types", basemap: DATA_GROUND,
    places: ["Sierra", "Rockies"],
    facts: [{ what: "shares on both sides", re: PCT }, { what: "named vegetation", re: /conifer|pine|fir|spruce|aspen|shrub|grass|forest/i }],
    needs: ["two places side by side (one map per place, one table of shares)", "vegetation types (LANDFIRE EVT)"],
  },
  {
    id: "T09.4", useCase: "T09",
    question: "What grows around Bend?",
    layers: ["vegetation-types|land-cover|forest-types|old-growth"], main: "vegetation-types|land-cover|forest-types|old-growth", basemap: DATA_GROUND,
    facts: [{ what: "named vegetation", re: /ponderosa|juniper|sagebrush|pine|shrub|forest|grass/i }, { what: "a share or area", re: new RegExp(`${PCT.source}|${AREA.source}`, "i") }],
    needs: ["vegetation types (LANDFIRE EVT)", "shares of the view per class"],
  },
  {
    id: "T09.5", useCase: "T09",
    question: "What's growing here? @view=[-124.0,47.8,-123.8,47.9]",
    layers: ["vegetation-types|canopy-height|land-cover|forest-types|old-growth"], main: "vegetation-types|land-cover|forest-types|old-growth|canopy-height", basemap: DATA_GROUND,
    facts: [{ what: "named ecosystem", re: /rain ?forest|spruce|hemlock|cedar|fir|forest/i }, { what: "a share or height", re: new RegExp(`${PCT.source}|\\b\\d+\\s*(?:m|ft)\\b`, "i") }],
    needs: ["canopy height", "ecoregion name"],
  },

  // T10. How this place changes through the year and what's under the water.
  {
    id: "T10.1", useCase: "T10",
    question: "Typical temperature and precipitation by month at Lake Tahoe, and when the snow usually arrives",
    layers: ["climate-normals|snowpack|weather-forecast"], main: "climate-normals|snowpack|weather-forecast", basemap: TOPO,
    facts: [{ what: "monthly temperatures in °F", re: DEG_F }, { what: "precipitation by month", re: /\b\d+(?:\.\d+)?\s*(?:in|inches|mm)\b/i }, { what: "when snow arrives", re: /snow[^.]*(?:oct|nov|dec)|(?:oct|nov|dec)[^.]*snow/i }],
    needs: ["climate normals by month (Open-Meteo history or ERA5-Land through Earth Engine, or NOAA 1991-2020 station normals)", "a monthly climate strip"],
  },
  {
    id: "T10.2", useCase: "T10",
    question: "When in the year is the Merced River highest in Yosemite Valley?",
    layers: ["flow-by-month|streamflow|river-pulse"], main: "flow-by-month|streamflow|river-pulse", basemap: TOPO,
    facts: [{ what: "peak month", re: /\b(?:may|june|apr(?:il)?)\b/i }, { what: "flow in cfs", re: CFS }],
    needs: ["flow by month of the year (USGS daily statistics) as a monthly strip"],
  },
  {
    id: "T10.3", useCase: "T10",
    question: "How does Lake Tahoe's depth compare to Crater Lake's?",
    layers: ["lakes"], main: "lakes", view: ["detail", "ranked"], basemap: TOPO,
    places: ["Tahoe", "Crater"],
    card: ["Maximum depth", "Kind", "Area"],
    facts: [{ what: "both depths", re: /\b\d[\d,]*\s*(?:ft|feet|m)\b[^.]*\b\d[\d,]*\s*(?:ft|feet|m)\b|deeper/i }],
    names: 2,
    needs: ["bathymetry under both lakes (USGS lake surveys) drawn on one depth ramp"],
  },
  {
    id: "T10.4", useCase: "T10",
    question: "When does spring green up around Asheville?",
    layers: ["phenology|greenness"], main: "phenology|greenness", basemap: DATA_GROUND,
    facts: [{ what: "green-up month", re: /\b(?:mar(?:ch)?|apr(?:il)?|may)\b/i }, { what: "early or late vs normal", re: /early|late|days?/i }],
    needs: ["green-up and peak greenness by month (MODIS phenology through Earth Engine) as a monthly strip"],
  },
  {
    id: "T10.5", useCase: "T10",
    question: "How deep is the water here? @view=[-122.55,47.55,-122.35,47.7]",
    layers: ["lakes|tides|water-depth"], main: "lakes|tides|water-depth", basemap: DATA_GROUND,
    facts: [{ what: "a depth", re: /\b\d[\d,]*\s*(?:ft|feet|m|fathoms)\b[^.]*deep|depth[^.]*\b\d[\d,]*\s*(?:ft|feet|m)\b/i }],
    needs: ["bathymetry (NOAA NCEI DEM mosaic and GEBCO) with a depth ramp and contours"],
  },
];

/** The expectation for a question as written (with or without its @view), if it is one of the 50. */
export function top10For(raw: string): Top10Expect | undefined {
  const key = (q: string) => q.replace(/\s*@view=.*$/, "").trim().toLowerCase();
  return TOP10.find((e) => key(e.question) === key(raw));
}

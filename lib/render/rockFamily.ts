import type { ExpressionSpecification } from "mapbox-gl";
import type { LegendSpec } from "@/layers/types";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, ROCK_TYPE_COLORS, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

/**
 * Rock families for the geologic map (spec T08 "categorical by rock family, lightness by age"). Macrostrat's map units
 * carry no family: the tiles have `lith` (often empty on detailed maps), `name` and `descrip`, so a unit is classed by
 * the rock words in them. One table drives both the Mapbox expression the map fills with and `rockFamilyOf`, which the
 * layer's coverage note and the legend's in-view shares use, so the map, the note and the key always agree.
 *
 * How a unit is classed: the first text among lith, name and description that holds any family's word decides, and in
 * it the family whose word comes FIRST (a description leads with its main rock: the Kayenta's Tenney Canyon Tongue is
 * "red-brown siltstone, mudstone and sandstone" and only names "basalt lava flows" in a last aside, which made it
 * volcanic when families were checked in a fixed order). Two nudges keep compound names right: a metamorphic word counts
 * as if it came FAMILY_BIAS characters earlier ("granite gneiss" is metamorphic) and a loose-sediment word as if later
 * ("gravelly sandstone" is rock); ties go to the family listed first. No word anywhere: a unit whose oldest rock is
 * Quaternary is loose sediment, anything older sedimentary (most of the mapped surface is). Texts are lowercased and a
 * space put in front, so " till" matches a word start only.
 */

export type RockFamily = "sedimentary" | "volcanic" | "plutonic" | "metamorphic" | "unconsolidated";

/** The property the legend and the in-view shares key on; the tiles do not carry it, the expression derives it. */
export const ROCK_FAMILY_FIELD = "rock_family";

/** Lower bounds (million years) of the five age steps, youngest first: Quaternary, Tertiary, Mesozoic, Paleozoic, Precambrian. */
export const AGE_STEPS = [0, 2.58, 66, 252, 541] as const;
export const AGE_STEP_LABELS = [
  "Quaternary (under 2.6 million years)",
  "Tertiary (2.6 to 66 million years)",
  "Mesozoic (66 to 252 million years)",
  "Paleozoic (252 to 541 million years)",
  "Precambrian (over 541 million years)",
] as const;

/** The families in the order they are checked, with the words that mark them (lowercase; a leading space is a word start). */
export const FAMILY_WORDS: { id: RockFamily; words: string[] }[] = [
  {
    id: "metamorphic",
    words: [
      "gneiss", "schist", "quartzite", "marble", "slate", "phyllite", "metamorphic", "metased", "metavolc", "metaig", "metabas",
      "metagab", "metagran", "metacong", "metasand", "metasilt", "amphibolite", "migmatite", "hornfels", "serpentin", "greenstone",
      "mylonite", "granulite", "eclogite", "skarn",
    ],
  },
  {
    id: "plutonic",
    words: [
      "granit", "granodiorite", "diorite", "gabbro", "monzonite", "tonalite", "syenite", "pluton", "intrusive", "batholith", "pegmatite",
      "peridotite", "anorthosite", " norite", "dunite", "aplite", "diabase", "dolerite",
    ],
  },
  {
    id: "volcanic",
    words: [
      "basalt", "andesite", "rhyolite", "dacite", " tuff", "volcanic", " lava", "ignimbrite", "pyroclastic", "trachyte", " latite",
      "obsidian", "cinder", "scoria", "tephra", "ash-flow", "ash flow", "basanite", "phonolite", "agglomerate", "vitrophyre", "pumice",
    ],
  },
  {
    id: "sedimentary",
    words: [
      "sandstone", "shale", "limestone", "dolomite", "dolostone", "mudstone", "siltstone", "conglomerate", "claystone", "sedimentary",
      "chert", "evaporite", "gypsum", " coal", "arenite", " marl", "carbonate", " chalk", "argillite", "graywacke", "greywacke",
      "arkose", "breccia", "red bed", "redbed", "travertine", "anhydrite", " halite", "rock salt", "lignite",
    ],
  },
  {
    id: "unconsolidated",
    words: [
      "alluvi", "colluvi", "talus", "landslide", " till", "moraine", "glacial", "outwash", "eolian", "aeolian", " dune", "loess",
      "lacustrine", "playa", "unconsolidated", "terrace", " fan ", "fan deposit", "surficial", "deposits", "gravel", "mass-wasting",
      "debris", " sand", " silt", " clay", "beach", "marsh", "swamp", " peat", "water", " ice",
    ],
  },
];

/** The text sources checked in turn. */
export const FAMILY_SOURCES = ["lith", "name", "descrip"] as const;

/** Characters a family's first word is moved by when the families' first words are compared (see the header). */
export const FAMILY_BIAS: Record<RockFamily, number> = { metamorphic: -24, plutonic: 0, volcanic: 0, sedimentary: 0, unconsolidated: 24 };

/** The family whose word comes first in `t` (with FAMILY_BIAS; ties to the family listed first), or undefined. */
function familyInText(t: string): RockFamily | undefined {
  let best: RockFamily | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const fam of FAMILY_WORDS) {
    let first = Number.POSITIVE_INFINITY;
    for (const w of fam.words) {
      const i = t.indexOf(w);
      if (i >= 0 && i < first) first = i;
    }
    if (first === Number.POSITIVE_INFINITY) continue;
    const score = first + FAMILY_BIAS[fam.id];
    if (score < bestScore) {
      best = fam.id;
      bestScore = score;
    }
  }
  return best;
}

/** Quaternary: the oldest rock is younger than this (million years), so a unit with no rock word is loose sediment. */
const QUATERNARY_MA = 2.6;

export type RockProps = { lith?: unknown; name?: unknown; descrip?: unknown; best_age_top?: unknown; best_age_bottom?: unknown };

function text(v: unknown): string {
  return ` ${typeof v === "string" ? v.toLowerCase() : v === undefined || v === null ? "" : String(v).toLowerCase()}`;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A unit's rock family from its lith, name and description (the same rule the map's expression applies). */
export function rockFamilyOf(p: RockProps | null | undefined): RockFamily {
  for (const source of FAMILY_SOURCES) {
    const found = familyInText(text(p?.[source]));
    if (found) return found;
  }
  const oldest = num(p?.best_age_bottom) ?? num(p?.best_age_top);
  return oldest !== undefined && oldest <= QUATERNARY_MA ? "unconsolidated" : "sedimentary";
}

/** The age step (0 youngest to 4 oldest) of a unit's youngest rock. */
export function ageStepOf(ageTopMa: unknown): number {
  const a = num(ageTopMa);
  if (a === undefined) return 0;
  let step = 0;
  while (step < AGE_STEPS.length - 1 && a >= AGE_STEPS[step + 1]) step++;
  return step;
}

/**
 * Family colors: the lightest (youngest) to the darkest (oldest) along each family's ramp, spaced so neighbouring age
 * steps and neighbouring families differ visibly over every basemap at the tile fill (lib/render/classContrast.test.ts).
 * Loose sediments are young (almost all Quaternary) and keep one pale shade under their stipple: five steps that pale
 * could not be told apart.
 */
const FAMILY_RAMPS: Record<RockFamily, { stops: string[]; at: number[] }> = {
  sedimentary: { stops: [OFF_WHITE, SAGE, DARK_GREY], at: [0.26, 0.4, 0.54, 0.68, 0.82] },
  volcanic: { stops: [OFF_WHITE, PINK, DARK_GREY], at: [0.26, 0.4, 0.54, 0.68, 0.82] },
  plutonic: { stops: [OFF_WHITE, PURPLE, DARK_GREY], at: [0.26, 0.4, 0.54, 0.68, 0.82] },
  metamorphic: { stops: [OFF_WHITE, DARK_GREY], at: [0.24, 0.36, 0.48, 0.6, 0.72] },
  unconsolidated: { stops: [OFF_WHITE, DARK_GREY], at: [0.05, 0.05, 0.05, 0.05, 0.05] },
};

/** Each family's five fills, youngest (lightest) first. */
export const FAMILY_COLORS: Record<RockFamily, string[]> = Object.fromEntries(
  (Object.keys(FAMILY_RAMPS) as RockFamily[]).map((f) => [f, FAMILY_RAMPS[f].at.map((t) => rgbToHex(interpolateStops(FAMILY_RAMPS[f].stops, t)))]),
) as Record<RockFamily, string[]>;

/** A unit's fill: its family's color at the age step of its youngest rock. */
export function rockFamilyColor(family: RockFamily, ageTopMa: unknown): string {
  return FAMILY_COLORS[family][ageStepOf(ageTopMa)];
}

/** The families as the legend lists them, with a plain line on what each holds. */
export const FAMILY_LABELS: { id: RockFamily; label: string; help: string }[] = [
  { id: "sedimentary", label: "Sedimentary", help: "Sandstone, shale, limestone and other rock laid down as sediment (sage)." },
  { id: "volcanic", label: "Volcanic", help: "Lava, ash and tuff: rock erupted at the surface (pink)." },
  { id: "plutonic", label: "Plutonic", help: "Granite and other rock that cooled from magma deep underground (purple)." },
  { id: "metamorphic", label: "Metamorphic", help: "Gneiss, schist, quartzite and other rock changed by heat and pressure (grey, hatched)." },
  { id: "unconsolidated", label: "Loose sediment", help: "Young, loose alluvium, sand, gravel, glacial till and landslide debris (off-white, stippled)." },
];

/** The geology legend: the five families (each at its middle age) and how lightness reads. */
export const ROCK_FAMILY_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Rock family",
  field: ROCK_FAMILY_FIELD,
  items: FAMILY_LABELS.map((f) => ({ label: f.label, value: f.id, color: FAMILY_COLORS[f.id][2], symbol: "polygon" as const, help: f.help })),
  note: `Darker = older: within each rock family the shade steps darker with the age of the unit's youngest rock, in five bands: ${AGE_STEP_LABELS.join(", ")}. Loose sediment is young and keeps one shade.`,
};

// ---- The Mapbox expressions (vector tiles: Macrostrat's `units`) ----

function sourceText(key: string): unknown[] {
  return ["concat", " ", ["downcase", ["to-string", ["coalesce", ["get", key], ""]]]];
}

/** A score no word reaches: the family has no word in the text. */
const ABSENT = 1_000_000;

/**
 * One family's score in the text bound to `t`: where its first word starts, moved by FAMILY_BIAS, or ABSENT. Each word
 * is looked for in the text followed by "|" and the word itself, so it is always found and a word missing from the text
 * lands past the text's end (no "-1" to filter out of the minimum).
 */
function familyScore(fam: { id: RockFamily; words: string[] }): unknown[] {
  const t = ["var", "t"];
  const first = ["min", ...fam.words.map((w) => ["index-of", w, ["concat", t, "|", w]])];
  return ["let", "first", first, ["case", [">", ["var", "first"], ["length", t]], ABSENT, ["+", ["var", "first"], FAMILY_BIAS[fam.id]]]];
}

/** The family whose word comes first in one source's text (familyInText as an expression), or "none". */
function familyInSource(source: string): unknown[] {
  const names = FAMILY_WORDS.map((f) => `s_${f.id}`);
  const decide: unknown[] = ["case"];
  FAMILY_WORDS.forEach((fam, i) => {
    const mine = ["var", names[i]];
    decide.push(["all", ["<", mine, ABSENT], ...names.filter((_, j) => j !== i).map((other) => ["<=", mine, ["var", other]])], fam.id);
  });
  decide.push("none");
  const bindings = FAMILY_WORDS.flatMap((fam, i) => [names[i], familyScore(fam)]);
  return ["let", "t", sourceText(source), ["let", ...bindings, decide]];
}

/** The family of a tile feature, as a Mapbox expression returning one of the RockFamily ids (rockFamilyOf's rule). */
export function rockFamilyExpression(): ExpressionSpecification {
  const oldest = ["to-number", ["coalesce", ["get", "best_age_bottom"], ["get", "best_age_top"], 999]];
  let expr: unknown[] = ["case", ["<=", oldest, QUATERNARY_MA], "unconsolidated", "sedimentary"];
  for (const source of [...FAMILY_SOURCES].reverse()) {
    const v = `f_${source}`;
    expr = ["let", v, familyInSource(source), ["case", ["!=", ["var", v], "none"], ["var", v], expr]];
  }
  return expr as unknown as ExpressionSpecification;
}

/** The fill color of a tile feature: its family's step by the age of its youngest rock. */
export function rockFamilyFillExpression(): ExpressionSpecification {
  const age = ["to-number", ["coalesce", ["get", "best_age_top"], 0]];
  const stepFor = (colors: string[]) => ["step", age, colors[0], ...AGE_STEPS.slice(1).flatMap((v, i) => [v, colors[i + 1]])];
  return [
    "let",
    "family",
    rockFamilyExpression(),
    ["match", ["var", "family"], ...FAMILY_LABELS.flatMap((f) => [f.id, stepFor(FAMILY_COLORS[f.id])]), stepFor(FAMILY_COLORS.sedimentary)],
  ] as unknown as ExpressionSpecification;
}

/** The pattern id of the stipple over loose sediments (an image lib/render/hatch.ts draws). */
export function stipplePatternId(color: string): string {
  return `stipple-${color.slice(1).toUpperCase()}`;
}

/** Families drawn with a pattern over the fill: metamorphic hatched, loose sediments stippled, both in dark grey. */
export const FAMILY_PATTERNS: Partial<Record<RockFamily, "hatch" | "stipple">> = { metamorphic: "hatch", unconsolidated: "stipple" };

/**
 * A vector tile feature's value for a legend field, as the in-view shares sample it: the rock family is derived (the
 * tiles do not carry it), every other field read as served.
 */
export function tileFieldValue(field: string, properties: Record<string, unknown> | null | undefined): unknown {
  if (field === ROCK_FAMILY_FIELD) return properties ? rockFamilyOf(properties) : undefined;
  if (field === ROCK_TYPE_FIELD) return properties ? rockTypeOf(properties) : undefined;
  return properties?.[field];
}

// ---- Rock types in USGS-style lithology colors (owner, 2026-10-24) ----

/**
 * The geologic map's fill (owner's review of Zion, 2026-10-24: "muddy green hatching with only two rock families in
 * view"; the question is about rock types and ages). Each unit is filled by its ROCK TYPE in the colors geologic maps
 * use for lithology (USGS and state survey style): sandstone yellow, siltstone and mudstone orange-brown, shale grey-green,
 * limestone and dolomite blue, conglomerate ochre, evaporite lilac, coal dark grey, volcanic red, plutonic pink,
 * metamorphic purple, young loose sediment pale. Macrostrat's own unit colors are its time-scale colors (the Navajo
 * Sandstone and the Kayenta Formation are both Jurassic, one blue), which cannot tell two rocks of one age apart. No hatch:
 * formation names are labelled on the map, and the age is on the card. The type is classed like the family (the first
 * text among lith, name and description with any type's word decides, the type whose word comes first wins, with the
 * family nudges), so a type always sits in the family the rock family filter keeps.
 */
export type RockType =
  | "sandstone"
  | "siltstone"
  | "shale"
  | "limestone"
  | "conglomerate"
  | "evaporite"
  | "coal"
  | "sedimentary"
  | "volcanic"
  | "plutonic"
  | "metamorphic"
  | "unconsolidated";

/** The derived property the rock type legend and its in-view shares key on (the tiles do not carry it). */
export const ROCK_TYPE_FIELD = "rock_type";

export const ROCK_TYPES: { id: RockType; label: string; family: RockFamily; color: string; help: string; words: string[] }[] = [
  {
    id: "metamorphic",
    label: "Metamorphic",
    family: "metamorphic",
    color: ROCK_TYPE_COLORS.metamorphic,
    help: "Gneiss, schist, quartzite, marble and other rock changed by heat and pressure (purple).",
    words: FAMILY_WORDS.find((f) => f.id === "metamorphic")!.words,
  },
  {
    id: "plutonic",
    label: "Granite and other plutonic rock",
    family: "plutonic",
    color: ROCK_TYPE_COLORS.plutonic,
    help: "Granite, diorite, gabbro: rock that cooled from magma deep underground (pink).",
    words: FAMILY_WORDS.find((f) => f.id === "plutonic")!.words,
  },
  {
    id: "volcanic",
    label: "Volcanic",
    family: "volcanic",
    color: ROCK_TYPE_COLORS.volcanic,
    help: "Basalt, andesite, rhyolite, tuff: lava and ash erupted at the surface (red).",
    words: FAMILY_WORDS.find((f) => f.id === "volcanic")!.words,
  },
  {
    id: "limestone",
    label: "Limestone and dolomite",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.limestone,
    help: "Limestone, dolomite, chalk and marl: rock of shells and lime mud, laid down in seas (blue).",
    words: ["limestone", "dolomite", "dolostone", "carbonate", " chalk", " marl", "travertine"],
  },
  {
    id: "shale",
    label: "Shale and claystone",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.shale,
    help: "Shale, claystone and argillite: hardened mud that splits in thin layers (grey-green).",
    words: ["shale", "claystone", "argillite"],
  },
  {
    id: "siltstone",
    label: "Siltstone and mudstone",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.siltstone,
    help: "Siltstone, mudstone and red beds: fine sediment, often red-brown (orange-brown).",
    words: ["siltstone", "mudstone", "red bed", "redbed"],
  },
  {
    id: "conglomerate",
    label: "Conglomerate and breccia",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.conglomerate,
    help: "Conglomerate and breccia: rounded or broken pebbles cemented together (ochre).",
    words: ["conglomerate", "breccia"],
  },
  {
    id: "sandstone",
    label: "Sandstone",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.sandstone,
    help: "Sandstone, arkose and graywacke: cemented sand, often old dunes or river beds (yellow).",
    words: ["sandstone", "arenite", "arkose", "graywacke", "greywacke"],
  },
  {
    id: "evaporite",
    label: "Gypsum and salt",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.evaporite,
    help: "Gypsum, anhydrite and rock salt left where seawater dried (lilac).",
    words: ["evaporite", "gypsum", "anhydrite", " halite", "rock salt"],
  },
  {
    id: "coal",
    label: "Coal",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.coal,
    help: "Coal and lignite (dark grey).",
    words: [" coal", "lignite"],
  },
  {
    id: "sedimentary",
    label: "Other sedimentary rock",
    family: "sedimentary",
    color: ROCK_TYPE_COLORS.sedimentary,
    help: "Sedimentary rock the map does not name more closely, chert included (tan).",
    // "Cherty limestone" is limestone: chert counts only as a word of its own.
    words: ["sedimentary", " chert ", " chert,", " chert;", " chert."],
  },
  {
    id: "unconsolidated",
    label: "Loose sediment",
    family: "unconsolidated",
    color: ROCK_TYPE_COLORS.unconsolidated,
    help: "Young, loose alluvium, sand, gravel, glacial till and landslide debris (pale cream).",
    words: FAMILY_WORDS.find((f) => f.id === "unconsolidated")!.words,
  },
];

const TYPE_BIAS = (t: { family: RockFamily }) => FAMILY_BIAS[t.family];

/** The type whose word comes first in `t` (with the family nudges; ties to the type listed first), or undefined. */
function typeInText(t: string): RockType | undefined {
  let best: RockType | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const type of ROCK_TYPES) {
    let first = Number.POSITIVE_INFINITY;
    for (const w of type.words) {
      const i = t.indexOf(w);
      if (i >= 0 && i < first) first = i;
    }
    if (first === Number.POSITIVE_INFINITY) continue;
    const score = first + TYPE_BIAS(type);
    if (score < bestScore) {
      best = type.id;
      bestScore = score;
    }
  }
  return best;
}

/** A unit's rock type from its lith, name and description (the same rule the map's expression applies). */
export function rockTypeOf(p: RockProps | null | undefined): RockType {
  for (const source of FAMILY_SOURCES) {
    const found = typeInText(text(p?.[source]));
    if (found) return found;
  }
  const oldest = num(p?.best_age_bottom) ?? num(p?.best_age_top);
  return oldest !== undefined && oldest <= QUATERNARY_MA ? "unconsolidated" : "sedimentary";
}

function typeScore(type: (typeof ROCK_TYPES)[number]): unknown[] {
  const t = ["var", "t"];
  const first = ["min", ...type.words.map((w) => ["index-of", w, ["concat", t, "|", w]])];
  return ["let", "first", first, ["case", [">", ["var", "first"], ["length", t]], ABSENT, ["+", ["var", "first"], TYPE_BIAS(type)]]];
}

function typeInSource(source: string): unknown[] {
  const names = ROCK_TYPES.map((r) => `r_${r.id}`);
  const decide: unknown[] = ["case"];
  ROCK_TYPES.forEach((type, i) => {
    const mine = ["var", names[i]];
    // Ties go to the type listed first: strictly less than the earlier types, at most the later ones.
    decide.push(["all", ["<", mine, ABSENT], ...names.slice(0, i).map((other) => ["<", mine, ["var", other]]), ...names.slice(i + 1).map((other) => ["<=", mine, ["var", other]])], type.id);
  });
  decide.push("none");
  const bindings = ROCK_TYPES.flatMap((type, i) => [names[i], typeScore(type)]);
  return ["let", "t", sourceText(source), ["let", ...bindings, decide]];
}

/** The rock type of a tile feature, as a Mapbox expression returning a RockType id (rockTypeOf's rule). */
export function rockTypeExpression(): ExpressionSpecification {
  const oldest = ["to-number", ["coalesce", ["get", "best_age_bottom"], ["get", "best_age_top"], 999]];
  let expr: unknown[] = ["case", ["<=", oldest, QUATERNARY_MA], "unconsolidated", "sedimentary"];
  for (const source of [...FAMILY_SOURCES].reverse()) {
    const v = `y_${source}`;
    expr = ["let", v, typeInSource(source), ["case", ["!=", ["var", v], "none"], ["var", v], expr]];
  }
  return expr as unknown as ExpressionSpecification;
}

/** The fill color of a tile feature: its rock type's color. */
export function rockTypeFillExpression(): ExpressionSpecification {
  return ["match", rockTypeExpression(), ...ROCK_TYPES.flatMap((r) => [r.id, r.color]), ROCK_TYPES.find((r) => r.id === "sedimentary")!.color] as unknown as ExpressionSpecification;
}

/** The family of a tile feature through its type, so the family filter keeps exactly the units of the types it names. */
export function rockFamilyOfTypeExpression(): ExpressionSpecification {
  return ["match", rockTypeExpression(), ...ROCK_TYPES.flatMap((r) => [r.id, r.family]), "sedimentary"] as unknown as ExpressionSpecification;
}

/** The geology legend: the rock types (the legend keeps those in view with their share) and how to read the map. */
export const ROCK_TYPE_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Rock type",
  field: ROCK_TYPE_FIELD,
  items: ROCK_TYPES.map((r) => ({ label: r.label, value: r.id, color: r.color, symbol: "polygon" as const, help: r.help })),
  note: "Colored by rock type, as geologic maps do. Formation names are on the map; tap a unit for its age in million years. Filter by rock family or by age in the layer row.",
};

/** A unit's age span in words: "174 to 201 million years old" (youngest to oldest rock), or undefined. */
export function ageSpanWords(top: unknown, bottom: unknown): string | undefined {
  const t = num(top);
  const b = num(bottom);
  const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(0) : n >= 0.1 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, "");
  if (t === undefined && b === undefined) return undefined;
  if (t !== undefined && b !== undefined && b > t) return t < 0.01 ? `up to ${fmt(b)} million years old` : `${fmt(t)} to ${fmt(b)} million years old`;
  const one = (b ?? t)!;
  return one < 0.01 ? "under 10,000 years old" : `about ${fmt(one)} million years old`;
}

/**
 * Properties a tapped geologic unit's card reads beside the served ones: its rock type in words and its age span in
 * million years (the served ages are numbers the card hides).
 */
export function geologyCardProperties(p: Record<string, unknown>): Record<string, unknown> {
  const type = ROCK_TYPES.find((r) => r.id === rockTypeOf(p));
  const span = ageSpanWords(p.best_age_top, p.best_age_bottom);
  return { ...(type && { rock_type_label: type.label }), ...(span && { age_span: span }) };
}

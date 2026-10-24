import type { ExpressionSpecification } from "mapbox-gl";
import type { LegendSpec } from "@/layers/types";
import { DARK_GREY, OFF_WHITE, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

/**
 * Rock families for the geologic map (spec T08 "categorical by rock family, lightness by age"). Macrostrat's map units
 * carry no family: the tiles have `lith` (often empty on detailed maps), `name` and `descrip`, so a unit is classed by
 * the rock words in them. One table drives both the Mapbox expression the map fills with and `rockFamilyOf`, which the
 * layer's coverage note and the legend's in-view shares use, so the map, the note and the key always agree.
 *
 * How a unit is classed: the first text among lith, name and description that holds any family's word decides, the
 * families checked in FAMILY_ORDER (metamorphic before plutonic, since "granite gneiss" is metamorphic; volcanic before
 * sedimentary, so a Quaternary lava flow is volcanic; sedimentary before loose sediments, so "gravelly sandstone" is
 * rock). No word anywhere: a unit whose oldest rock is Quaternary is loose sediment, anything older sedimentary (most
 * of the mapped surface is). Texts are lowercased and a space put in front, so " till" matches a word start only.
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
      "arkose", "breccia", "red bed", "redbed",
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
    const t = text(p?.[source]);
    for (const fam of FAMILY_WORDS) if (fam.words.some((w) => t.includes(w))) return fam.id;
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

/** The family of a tile feature, as a Mapbox expression returning one of the RockFamily ids. */
export function rockFamilyExpression(): ExpressionSpecification {
  const branches: unknown[] = [];
  for (const source of FAMILY_SOURCES) {
    const t = sourceText(source);
    for (const fam of FAMILY_WORDS) branches.push(["any", ...fam.words.map((w) => ["in", w, t])], fam.id);
  }
  const oldest = ["to-number", ["coalesce", ["get", "best_age_bottom"], ["get", "best_age_top"], 999]];
  return ["case", ...branches, ["<=", oldest, QUATERNARY_MA], "unconsolidated", "sedimentary"] as unknown as ExpressionSpecification;
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
  return field === ROCK_FAMILY_FIELD ? (properties ? rockFamilyOf(properties) : undefined) : properties?.[field];
}

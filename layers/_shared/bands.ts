import type { Attribute, AttributeLevel, FieldHelp, MeasurePreset } from "../types";

/**
 * Shared ordinal band sets and measure presets (spec §12c): one set per activity or source scale, so every layer that
 * grades the same thing shows the same chips in the same order, and the agent's words ("easy", "class IV", "D3",
 * "large fires") land on the same values everywhere.
 */

// ---- Climbing grades: YDS, UIAA, French and V-scale → Beginner, Intermediate, Advanced, Elite ----

export const CLIMBING_BANDS = ["beginner", "intermediate", "advanced", "elite"] as const;
export type ClimbingBand = (typeof CLIMBING_BANDS)[number];

const CLIMBING_BAND_TEXT: Record<ClimbingBand, { label: string; help: string }> = {
  beginner: { label: "Beginner", help: "Up to 5.7 YDS, UIAA V+, French 5b, or V0 to V2 bouldering." },
  intermediate: { label: "Intermediate", help: "5.8 to 5.10d YDS, UIAA VI- to VII+, French 5c to 6b+, or V3 to V5." },
  advanced: { label: "Advanced", help: "5.11a to 5.12d YDS, UIAA VIII- to IX+, French 6c to 7c, or V6 to V9." },
  elite: { label: "Elite", help: "5.13a and harder YDS, UIAA X- and up, French 7c+ and up, or V10 and up." },
};

export const CLIMBING_LEVELS: AttributeLevel[] = CLIMBING_BANDS.map((value) => ({ value, ...CLIMBING_BAND_TEXT[value] }));

/** YDS: 5.x with an optional letter or sign; 5.10a is 10.1, 5.10d 10.4, 5.9+ 9.5. */
function ydsNumber(grade: string): number | undefined {
  const m = /^5\.(\d{1,2})([abcd])?([+-])?/.exec(grade);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n >= 10) return n + (m[2] ? ("abcd".indexOf(m[2]) + 1) / 10 : 0.1);
  return n + (m[3] === "+" ? 0.5 : m[3] === "-" ? -0.3 : 0);
}

function ydsBand(n: number): ClimbingBand {
  if (n < 8) return "beginner";
  if (n < 11) return "intermediate";
  if (n < 13) return "advanced";
  return "elite";
}

/** V-scale bouldering: V0 to V17 (VB counts as V0). */
function vBand(grade: string): ClimbingBand | undefined {
  const m = /^V(B|\d{1,2})/i.exec(grade);
  if (!m) return undefined;
  const n = m[1].toUpperCase() === "B" ? 0 : Number(m[1]);
  if (n <= 2) return "beginner";
  if (n <= 5) return "intermediate";
  if (n <= 9) return "advanced";
  return "elite";
}

/** French sport grades: 4a to 9c, with optional + (5b, 6b+, 7c+). */
function frenchBand(grade: string): ClimbingBand | undefined {
  const m = /^([3-9])([abc])?(\+)?$/i.exec(grade.trim());
  if (!m) return undefined;
  // Rank: 6a = 60, 6a+ = 61, 6b = 63 ... so 6c is 66 and 7c+ is 77.
  const rank = Number(m[1]) * 10 + (m[2] ? "abc".indexOf(m[2].toLowerCase()) * 3 : 0) + (m[3] ? 1 : 0);
  if (rank <= 53) return "beginner"; // to 5b
  if (rank <= 64) return "intermediate"; // 5c to 6b+
  if (rank <= 76) return "advanced"; // 6c to 7c
  return "elite"; // 7c+ and up
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };

/** UIAA: roman (VI+) or arabic (6+) numerals with an optional sign. */
function uiaaBand(grade: string): ClimbingBand | undefined {
  const m = /^(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I|\d{1,2})([+-])?$/i.exec(grade.trim());
  if (!m) return undefined;
  const base = /^\d/.test(m[1]) ? Number(m[1]) : ROMAN[m[1].toUpperCase()];
  if (base === undefined) return undefined;
  const n = base + (m[2] === "+" ? 0.3 : m[2] === "-" ? -0.3 : 0);
  if (n < 5.5) return "beginner"; // to V+
  if (n < 7.5) return "intermediate"; // VI- to VII+
  if (n < 9.5) return "advanced"; // VIII- to IX+
  return "elite";
}

/**
 * The band of one climbing grade, from its system when known (OpenStreetMap's climbing:grade:<system>, "yds_class",
 * "french", "uiaa", "saxon" and so on) or from its look (5.10a is YDS, V4 is the V-scale, 6b+ is French); undefined
 * when it cannot be read. The original grade stays on the card; the band is for chips and filters.
 */
export function climbingBand(grade: string, system?: string): ClimbingBand | undefined {
  const g = grade.trim();
  if (system === "uiaa") return uiaaBand(g);
  if (system === "french") return frenchBand(g);
  const yds = ydsNumber(g);
  if (yds !== undefined) return ydsBand(yds);
  const v = vBand(g);
  if (v !== undefined) return v;
  if (system === undefined || system === "yds_class" || system === "yds") return frenchBand(g) ?? uiaaBand(g);
  return undefined;
}

/** Every band from `lo` to `hi` (a grade range spans the bands between its ends). */
export function bandsBetween(lo: ClimbingBand, hi: ClimbingBand): ClimbingBand[] {
  const a = CLIMBING_BANDS.indexOf(lo);
  const b = CLIMBING_BANDS.indexOf(hi);
  return CLIMBING_BANDS.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The bands in band order, without repeats. */
export function orderedBands(bands: Iterable<ClimbingBand>): ClimbingBand[] {
  const set = new Set(bands);
  return CLIMBING_BANDS.filter((b) => set.has(b));
}

export const CLIMBING_GRADE_HELP: FieldHelp = {
  text:
    "Which difficulty bands the place's routes fall in, from their grades: Yosemite Decimal System, UIAA, French and V-scale grades are " +
    "each mapped to Beginner, Intermediate, Advanced or Elite. A place with routes from 5.6 to 5.12 is in three bands. The card keeps the " +
    "original grades.",
  scale: "Beginner (to 5.7, V0-V2) · Intermediate (5.8-5.10, V3-V5) · Advanced (5.11-5.12, V6-V9) · Elite (5.13 and up, V10 and up)",
  source: "This app, from OpenBeta grade counts and OpenStreetMap climbing:grade tags",
  url: "https://wiki.openstreetmap.org/wiki/Key:climbing",
};

export const CLIMBING_GRADE_SCALE = "YDS, UIAA, French and V-scale";

// ---- Mountain biking: mtb:scale (Singletrack Scale 0 to 6) ----

export const MTB_LEVELS: AttributeLevel[] = [
  { value: 0, label: "Easy", help: "S0: no obstacles, gentle gradient." },
  { value: 1, label: "Easy", help: "S1: small roots and stones, loose surface in places." },
  { value: 2, label: "Moderate", help: "S2: bigger roots and steps, tighter turns." },
  { value: 3, label: "Hard", help: "S3: blocks, high steps, switchbacks, slippery sections." },
  { value: 4, label: "Expert", help: "S4: very steep with big obstacles; trial skills needed." },
  { value: 5, label: "Expert", help: "S5: blocked, very steep; few riders manage it." },
  { value: 6, label: "Expert", help: "S6: not usually ridable." },
];
export const MTB_SCALE = "mtb:scale (Singletrack Scale S0 to S6)";

// ---- Hiking: sac_scale (SAC T1 to T6) ----

export const SAC_LEVELS: AttributeLevel[] = [
  { value: "hiking", label: "Hiking (T1)", help: "T1: well-made path, flat or gently sloping." },
  { value: "mountain_hiking", label: "Mountain hiking (T2)", help: "T2: continuous path, steep in places; sure-footedness helps." },
  { value: "demanding_mountain_hiking", label: "Demanding mountain hiking (T3)", help: "T3: exposed sections, possibly with hands." },
  { value: "alpine_hiking", label: "Alpine hiking (T4)", help: "T4: path not always visible, some easy scrambling." },
  { value: "demanding_alpine_hiking", label: "Demanding alpine (T5)", help: "T5: often pathless, simple climbing, glacier possible." },
  { value: "difficult_alpine_hiking", label: "Difficult alpine (T6)", help: "T6: pathless, climbing up to II, exposed." },
];
export const SAC_SCALE = "sac_scale (SAC hiking scale T1 to T6)";

// ---- Skiing: piste:difficulty, read per region ----

/**
 * OpenStreetMap ranks piste:difficulty the same everywhere (novice 1 ... freeride 6); the colors on the ground differ by
 * region, so each level names both.
 */
export const PISTE_LEVELS: AttributeLevel[] = [
  { value: 1, label: "Easy", help: "Novice: green circle (North America), green (Europe), beginner area.", sign: "green-circle" },
  { value: 2, label: "Easy", help: "Easy: green circle (North America), blue (Europe).", sign: "green-circle" },
  { value: 3, label: "Moderate", help: "Intermediate: blue square (North America), red (Europe).", sign: "blue-square" },
  { value: 4, label: "Hard", help: "Advanced: black diamond (North America), black (Europe).", sign: "black-diamond" },
  { value: 5, label: "Expert", help: "Expert: double black diamond (North America), black or orange (Europe).", sign: "double-black-diamond" },
  { value: 6, label: "Expert", help: "Freeride or extreme: off-piste or ungroomed, in any region.", sign: "double-black-diamond" },
];
export const PISTE_SCALE = "piste:difficulty (green · blue · black in North America; green · blue · red · black in Europe)";

// ---- Paddling: whitewater class I to VI ----

/** Class numbers the paddling layer's gradeNumber can emit, each under its class (a + or - half step stays in it). */
export const WHITEWATER_LEVELS: AttributeLevel[] = [
  [0.5, "Class I"],
  [1, "Class I"],
  [1.5, "Class I"],
  [2, "Class II"],
  [2.5, "Class II"],
  [3, "Class III"],
  [3.5, "Class III"],
  [4, "Class IV"],
  [4.5, "Class IV"],
  [5, "Class V"],
  [5.5, "Class V"],
  [6, "Class VI"],
  [6.5, "Class VI"],
].map(([value, label]) => ({ value: value as number, label: label as string }));
export const WHITEWATER_SCALE = "International Scale of River Difficulty (class I to VI; a half step is a plus)";

// ---- Drought: US Drought Monitor D0 to D4 ----

export const DROUGHT_LEVELS: AttributeLevel[] = [
  { value: "D0", label: "D0 Abnormally Dry", help: "Going into or coming out of drought: short-term dryness." },
  { value: "D1", label: "D1 Moderate Drought", help: "Some damage to crops and pastures; water shortages developing." },
  { value: "D2", label: "D2 Severe Drought", help: "Crop or pasture losses likely; water restrictions imposed." },
  { value: "D3", label: "D3 Extreme Drought", help: "Major crop and pasture losses; widespread water shortages." },
  { value: "D4", label: "D4 Exceptional Drought", help: "Exceptional and widespread losses; water emergencies." },
];
export const DROUGHT_SCALE = "US Drought Monitor categories D0 to D4";

// ---- Measure presets from the sources' own classes ----

/** NWCG fire size classes (acres): A under 0.25 to G 5,000 and up. */
export const NWCG_FIRE_SIZE: MeasurePreset[] = [
  { label: "Class A–C: under 100 acres", max: 99.9 },
  { label: "Class D–E: 100 to 999 acres", min: 100, max: 999.9 },
  { label: "Class F: 1,000 to 4,999 acres", min: 1_000, max: 4_999.9 },
  { label: "Class G: 5,000 acres and up", min: 5_000 },
  { label: "Large fires: over 10,000 acres", min: 10_000 },
];

/** USGS magnitude classes: minor under 4, light 4, moderate 5, strong 6, major 7, great 8 and up. */
export const QUAKE_MAGNITUDE: MeasurePreset[] = [
  { label: "Minor: under 4", max: 3.99 },
  { label: "Light: 4 to 4.9", min: 4, max: 4.99 },
  { label: "Moderate: 5 to 5.9", min: 5, max: 5.99 },
  { label: "Strong: 6 to 6.9", min: 6, max: 6.99 },
  { label: "Major and great: 7 and up", min: 7 },
];

/** EIA plant sizes: utility scale starts at 1 MW; 100 MW and 1,000 MW are the usual "large" and "very large" lines. */
export const PLANT_CAPACITY: MeasurePreset[] = [
  { label: "Under 10 MW", max: 9.99 },
  { label: "10 to 99 MW", min: 10, max: 99.99 },
  { label: "Large: 100 MW and up", min: 100 },
  { label: "Very large: 1,000 MW and up", min: 1_000 },
];

// ---- Shorthands ----

/** A name search attribute on `key` (default `name`). */
export function nameAttribute(label = "Name", key = "name"): Attribute {
  return { key, type: "name", label };
}

/** A time attribute on `key` (default `t`, the scrubber's field). */
export function timeAttribute(label = "Date", key = "t"): Attribute {
  return { key, type: "time", label };
}

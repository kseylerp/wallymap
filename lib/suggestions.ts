/** The example questions on the suggestions card. The first visit shows FIRST_VISIT; later opens draw from SUGGESTION_POOL. */

export const THEMES = [
  "trails",
  "fire",
  "water",
  "wildlife",
  "places",
  "live",
  "climate",
  "land",
] as const;
export type SuggestionTheme = (typeof THEMES)[number];

export type Suggestion = {
  q: string;
  theme: SuggestionTheme;
  /** True when the question names a place, so it works from the globe with no map view. Every pool question does. */
  needsPlace: boolean;
};

/** What a first-time visitor sees, unchanged: the six starters. */
export const FIRST_VISIT = [
  "Show hiking trails around Lake Tahoe",
  "Which wildfires burned near Yosemite in the last 10 years?",
  "Where has the Amazon lost the most forest since 2015?",
  "How much snow is on the ground around Mount Hood?",
  "Find campsites and forest roads open to vehicles near Moab",
  "What wildlife has been spotted around Banff this year?",
] as const;

const p = (theme: SuggestionTheme, q: string): Suggestion => ({ q, theme, needsPlace: true });

/** Five per theme, so every theme has questions for both halves of the rotation (see suggestionSet). */
export const SUGGESTION_POOL: readonly Suggestion[] = [
  p("trails", "Mountain bike trails near Moab"),
  p("trails", "Ski touring routes around Chamonix"),
  p("trails", "Climbing crags near Red River Gorge"),
  p("trails", "Show me a walking route from Tahoe City to Emerald Bay"),
  p("trails", "Trailheads and picnic areas in the Coconino National Forest"),

  p("fire", "Are there any active fires burning near Missoula right now?"),
  p("fire", "Where is the wildfire smoke today around Los Angeles?"),
  p("fire", "What is the fire danger in Southern California this week?"),
  p("fire", "Which large fires burned in Oregon in 2020?"),
  p("fire", "Which sequoia groves burned in the 2020 and 2021 fires?"),

  p("water", "How deep is Lake Tahoe?"),
  p("water", "Show snow cover in the Alps over the last month"),
  p("water", "Glaciers in the Wind River Range"),
  p("water", "Did Lake Mead shrink?"),
  p("water", "Where are the dams on the Colorado River?"),

  p("wildlife", "Where do California condors live?"),
  p("wildlife", "Wolf packs in Washington in 2020"),
  p("wildlife", "Critical habitat for the desert tortoise near St. George"),
  p("wildlife", "Where are the most records of mountain lions in Colorado?"),
  p("wildlife", "Where is the old-growth forest in Oregon?"),

  p("places", "What rock is Half Dome made of?"),
  p("places", "Tallest peaks in the Sierra Nevada"),
  p("places", "Outline the Sierra Nevada"),
  p("places", "Tell me about the history of Bodie"),
  p("places", "Protected areas in Patagonia"),

  p("live", "Which rivers near Jackson Hole are running high right now?"),
  p("live", "Surf at Half Moon Bay today"),
  p("live", "Any weather warnings around Lake Tahoe?"),
  p("live", "Recent earthquakes near Mammoth Lakes"),
  p("live", "How full is Lake Powell right now?"),

  p("climate", "How fast is sea level rising at San Francisco?"),
  p("climate", "Show Miami with 3 feet of sea level rise"),
  p("climate", "How much warmer than normal was Fresno County last month?"),
  p("climate", "How green was the Sierra Nevada this month compared to last year?"),
  p("climate", "Where are methane plumes in the Permian Basin?"),

  p("land", "Who owns the land around Bryce Canyon, and is any of it designated wilderness?"),
  p("land", "How has Bears Ears National Monument changed since 2021?"),
  p("land", "Where are abandoned uranium mines near the Navajo Nation?"),
  p("land", "Where is the night sky darkest around Great Basin National Park?"),
  p("land", "Wind farms and power lines in West Texas"),
];

/** A small seeded random generator, so a set index always gives the same questions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const SET_SIZE = 6;

/**
 * The questions for set number `index`. Set 0 is FIRST_VISIT. Every later set takes six different themes in a
 * seeded order and one question from each. Within a theme the questions are split by position into two halves, and
 * odd sets draw from one half and even sets from the other, so two sets in a row never share a question.
 */
export function suggestionSet(index: number): string[] {
  if (index <= 0) return [...FIRST_VISIT];
  const random = mulberry32(index * 2654435761 + 0x9e3779b9);
  const half = index % 2;
  const picked: string[] = [];
  for (const theme of shuffled(THEMES, random).slice(0, SET_SIZE)) {
    const inTheme = SUGGESTION_POOL.filter((s) => s.theme === theme);
    const eligible = inTheme.filter((_, i) => i % 2 === half);
    picked.push(eligible[Math.floor(random() * eligible.length)].q);
  }
  return picked;
}

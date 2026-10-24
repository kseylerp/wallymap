import { anchorsOf, answerTemplate, chooseFollowUps, type AnswerTemplate } from "./answer";
import { composeNote } from "./compose";
import { followsUp } from "./context";
import type { Turn } from "./turn";
import { getLayer } from "@/layers";

/**
 * The answer template for a turn (lib/agent/answer.ts) from what the turn recorded: its tool calls, the results the
 * model read, the places it found (or, for a follow-up that names none, the last answer's place), and the question's
 * own reading (the layers it names lead the choice of main layer; its time window picks a forecast's days).
 */
export function answerForTurn(turn: Turn): AnswerTemplate | null {
  const places = turn.places.length > 0 ? turn.places : followsUp(turn.question, turn.context) && turn.context.place ? [turn.context.place] : [];
  try {
    return answerTemplate({
      calls: turn.calls,
      question: turn.question,
      outputs: turn.outputs,
      places,
      view: turn.view,
      prefer: turn.reading.layers.map((l) => l.layerId),
      window: turn.reading.time,
      taxon: turn.reading.taxon,
      change: turn.reading.change,
      viewPlace: turn.viewPlace,
    });
  } catch (err) {
    // The answer still shows as the model wrote it.
    turn.note(`answer template failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The note in the answer's shape, and the follow-ups it ends with kept on the turn. */
export function composeForTurn(markdown: string, turn: Turn): string {
  const template = answerForTurn(turn);
  turn.followUps = template?.followUps ?? [];
  const composed = withDataGaps(withLandManagers(withAskedPictures(withEmptyLayers(composeNote(markdown, template), turn), turn), turn), turn);
  if (composed !== markdown) turn.note(template?.lead ? "answer built on the template: lead, top options, then the model's caveats" : "answer put first: the note's first sentence now answers with a number");
  return composed;
}

/**
 * Layers asked this turn that answered with nothing (Zion's faults: 0) have no row in the layer panel, so the note says
 * so in one sentence, unless it already names them: "Quaternary faults: none mapped in the area asked."
 */
export function withEmptyLayers(markdown: string, turn: Pick<Turn, "queries"> & Partial<Pick<Turn, "calls">>): string {
  const lines: string[] = [];
  const text = markdown.toLowerCase();
  const said = new Set<string>();
  for (const q of turn.queries) {
    const key = `${q.layerId} ${q.inputKey}`;
    if (!q.ok || q.drawable || said.has(key)) continue;
    // The same ask drew something after all (a retry): nothing to say.
    if (turn.queries.some((o) => o.layerId === q.layerId && o.inputKey === q.inputKey && o.drawable)) continue;
    said.add(key);
    // What the source said of the empty answer: "All 67 sightings of California Condor … have hidden (obscured) locations".
    const note = emptyNoteOf(turn.calls ?? [], q.layerId);
    if (note) {
      const count = note.match(/\d[\d,]*/)?.[0];
      // Already said: the note holds its count (the first number).
      if (count !== undefined && new RegExp(`\\b${count.replace(/,/g, ",?")}\\b`).test(text)) continue;
      if (count === undefined && mentionsNone(text, q.layerId)) continue;
      // Each layer once.
      if (lines.some((l) => l.startsWith(note.slice(0, 20)))) continue;
      lines.push(`${note}.`);
      continue;
    }
    if (q.wide || mentionsNone(text, q.layerId) || turn.queries.some((o) => o.layerId === q.layerId && o.drawable)) continue;
    const title = getLayer(q.layerId)?.title.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (title && !lines.some((l) => l.startsWith(title))) lines.push(`${title}: none mapped in the area asked.`);
  }
  return lines.length === 0 ? markdown : `${markdown.trimEnd()}\n\n${lines.join(" ")}`;
}

/** True when the note already says a layer found none: its main word ("faults") next to a none, no or zero. */
function mentionsNone(text: string, layerId: string): boolean {
  const title = getLayer(layerId)?.title.replace(/\s*\([^)]*\)\s*/g, " ").trim().toLowerCase();
  if (!title) return false;
  const word = title.split(/\s+/).filter((w) => w.length > 3).pop() ?? title;
  const stem = word.replace(/s$/, "");
  return new RegExp(`\\b(?:no|none|zero|0|not any|without)\\b[^.]{0,60}\\b${stem}|\\b${stem}\\w*\\b[^.]{0,40}\\b(?:none|no|zero|0)\\b`).test(text);
}

/** The first clause of the coverage note of a query of `layerId` that came back with no features, or null. */
function emptyNoteOf(calls: Pick<Turn, "calls">["calls"], layerId: string): string | null {
  for (const c of calls) {
    if (c.toolName !== `query_${layerId}`) continue;
    const out = c.output as { kind?: unknown; data?: { features?: unknown[] }; coverageNote?: unknown } | undefined;
    if (out?.kind !== "geojson" || (out.data?.features?.length ?? 0) > 0 || typeof out.coverageNote !== "string") continue;
    const clause = out.coverageNote.split(/;\s+|\.\s+/)[0].split(/,\s+(?:as|so|which)\s+/)[0].trim().replace(/[.:,]$/, "");
    if (clause && clause.split(/\s+/).length <= 30) return clause;
  }
  return null;
}

/** Exactly three follow-ups, at least two naming a feature or place from this answer: the model's that do, then the template's. */
export function followUpsForTurn(turn: Turn, model: readonly string[]): string[] {
  const places = turn.places.length > 0 ? turn.places : turn.context?.place ? [turn.context.place] : turn.viewPlace ? [{ name: turn.viewPlace }] : [];
  const built = turn.followUps.length > 0 ? turn.followUps : (answerForTurn(turn)?.followUps ?? []);
  return chooseFollowUps(model, built, anchorsOf(turn.calls, places));
}

/** Waits for the tool calls still running (the renders sent beside a note), so the answer reads the finished map. */
export async function settle(turn: Turn): Promise<void> {
  // Every call of a step is started in the same task; one tick later all of them are in flight.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.allSettled([...turn.inflight, turn.viewPlaceReady]);
}

/**
 * Where to camp depends on who manages the land: when public-lands answered a camping or land question and the note
 * names no manager, it ends with the two largest units ("Land here: San Isabel National Forest (US Forest Service) and
 * Royal Gorge Field Office (Bureau of Land Management).").
 */
export function withLandManagers(markdown: string, turn: Pick<Turn, "question" | "calls">): string {
  if (!/\bcamp\w*|\bdispersed\b|\bwho\s+(?:manages|owns)\b|\bpublic\s+land|\bwhose\s+land/i.test(turn.question)) return markdown;
  if (/national\s+forest|\bBLM\b|bureau\s+of\s+land|forest\s+service|state\s+trust|national\s+park|tribal|reservation|wilderness/i.test(markdown)) return markdown;
  const out = turn.calls.findLast((c) => c.toolName === "query_public-lands")?.output as { coverageNote?: unknown } | undefined;
  const note = typeof out?.coverageNote === "string" ? out.coverageNote : "";
  const m = /^Land here, largest units first:\s*([^;]+)/.exec(note);
  if (!m) return markdown;
  const units = m[1].split(/\),\s+/).map((u) => (u.endsWith(")") ? u : `${u})`)).slice(0, 2);
  return `${markdown.trimEnd()}\n\nLand here: ${units.join(" and ")}.`;
}

/**
 * A picture layer the question asks for by its words (burn severity in "burn scars", the satellite snow map in "snow on
 * the ground") that the note never mentions gets one clause from its coverage note: Paradise's answer drew the burn
 * severity and said nothing of it. So does a layer of features the question names whose note opens with its count
 * ("No pipelines and 9 power lines here": Grand Staircase's answer asked about pipelines and never said). Two at most.
 */
export function withAskedPictures(markdown: string, turn: Pick<Turn, "reading" | "calls">): string {
  const text = markdown.toLowerCase();
  const lines: string[] = [];
  for (const hint of turn.reading.layers.filter((l) => l.strong)) {
    const out = turn.calls.findLast((c) => c.toolName === `query_${hint.layerId}`)?.output as { kind?: unknown; coverageNote?: unknown } | undefined;
    if (typeof out?.coverageNote !== "string" || out.coverageNote.trim() === "") continue;
    const counted = out.kind === "geojson" && /^(?:no|none|\d[\d,]*)\b/i.test(out.coverageNote.trim());
    if (out.kind !== "tiles" && !counted) continue;
    const title = getLayer(hint.layerId)?.title.replace(/\s*\([^)]*\)\s*/g, " ").trim() ?? hint.layerId;
    // Mentioned already: the title's longest word ("severity", "cover") is in the note.
    const word = title.toLowerCase().split(/[\s:,]+/).sort((x, y) => y.length - x.length)[0] ?? "";
    if (word && text.includes(word.replace(/s$/, ""))) continue;
    const clause = out.coverageNote.split(/;\s+|\.\s+/)[0].trim().replace(/[.:]$/, "");
    if (clause.split(/\s+/).length > 30) continue;
    lines.push(`${clause}.`);
    if (lines.length >= 2) break;
  }
  return lines.length === 0 ? markdown : `${markdown.trimEnd()}\n\n${lines.join(" ")}`;
}

/**
 * What a question asks that no free source holds, said plainly with what the map shows instead (documented data gaps,
 * docs/top-10-use-cases.md: T03.3). Each gap names the words that ask for it, the layer whose answer it qualifies, the
 * words that show the note already says it, and the sentence.
 */
const DATA_GAPS: { asks: RegExp; layer: string; said: RegExp; sentence: string }[] = [
  {
    // T03.3: American Whitewater rates US sections and their runnable flows, under no open licence; OpenStreetMap grades
    // only some rapids, and no free source gives a runnable range.
    asks: /\bclass\s+(?:[1-6]|i{1,3}|iv|vi?)\+?(?=[\s?.,!]|$)|\bwhitewater\b|\benough\s+water\b/i,
    layer: "paddling",
    said: /\bno\s+free\s+source\b|\bopenly\s+licen[cs]ed\b|\brunnable\s+(?:flow\s+)?range\b/i,
    sentence:
      "No free source rates US river sections by whitewater class or gives a runnable flow range, so whether this weekend's flow is enough cannot be said; the map shows the rapids OpenStreetMap volunteers graded by class and each gauge's flow against normal for the date.",
  },
];

export function withDataGaps(markdown: string, turn: Pick<Turn, "question" | "queries">): string {
  const lines: string[] = [];
  for (const gap of DATA_GAPS) {
    if (!gap.asks.test(turn.question) || !turn.queries.some((q) => q.layerId === gap.layer) || gap.said.test(markdown)) continue;
    lines.push(gap.sentence);
  }
  return lines.length === 0 ? markdown : `${markdown.trimEnd()}\n\n${lines.join(" ")}`;
}

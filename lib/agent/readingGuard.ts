import type { JSONValue } from "ai";
import type { FeatureCollection } from "geojson";
import { timeShapeOf } from "@/layers/contract";
import { applyFilters, type LayerFilters } from "@/lib/render/filters";
import { getLayer } from "@/layers/registry";
import { bboxAreaKm2, hardMaxAreaKm2, type BBox } from "@/layers/types";
import { readingFilters, timeInputs, type Reading } from "./reading";
import type { Turn } from "./turn";

/**
 * The step guard's part that holds a step to the question's reading (lib/agent/reading.ts), where the mapping is
 * mechanical and the model was seen to miss it (audit R1, 2026-10-23):
 *  - a geocode of "Madison fishing well" when the question says "the Madison" asks for the Madison River;
 *  - a query's time inputs follow the question's time phrase ("since 2000" is 27 years of reservoir levels, "this year"
 *    is the days since January 1), and the inputs a phrase decides ("backpacking": no parking lots) are set;
 *  - a query of a layer the words rule out ("flowy blue trails" is not river flow) is dropped, and the layers the words
 *    name ("blue trails" is mtb-trails) are queried on the same box when the step queries something else;
 *  - a render of a layer never queried this turn becomes its query (the render follows once it answered).
 * Every change is logged on the turn.
 */

export type GuardCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };

const QUERY = "query_";
const isQuery = (name: string) => name.startsWith(QUERY);
const layerOf = (name: string) => name.slice(QUERY.length);

let idCounter = 0;
function readingId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `call_reading_${Date.now().toString(36)}_${idCounter}`;
}

function isBBox(value: unknown): value is BBox {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Layers that answer for another when the model chose them: GBIF records for sightings, scored trails for trails. */
const ANSWERS_FOR: Record<string, string[]> = {
  species: ["gbif-occurrences"],
  "osm-trails": ["popularity"],
  "recreation-sites": ["paddling", "fishing"],
  paddling: ["recreation-sites"],
};

/** Words that already make a place a feature ("Madison River", "Lake Powell"), so a geocode is left as it is. */
const FEATURE_WORD = /\b(?:river|creek|fork|lake|reservoir|bay|trail|road|range|mountains?|mount|mt|peak|valley|canyon|basin|forest|park|wilderness|county|city)\b/i;

/** The inputs the reading sets on one query: the phrase's inputs, then the time window's. */
export function readingInputs(reading: Reading, layerId: string, now: Date): Record<string, unknown> {
  const layer = getLayer(layerId);
  if (!layer) return {};
  const out: Record<string, unknown> = {};
  for (const hint of reading.inputs) if (hint.layerId === layerId) Object.assign(out, hint.input);
  if (reading.time) Object.assign(out, timeInputs(layer, reading.time, now));
  // Only what the layer accepts.
  const parsed = layer.input.safeParse(out);
  return parsed.success ? out : {};
}

export function applyReading(calls: GuardCall[], turn: Turn, finalSteps: boolean): { calls: GuardCall[]; rejected: { call: GuardCall; reason: string }[]; changed: boolean } {
  const reading = turn.reading;
  const rejected: { call: GuardCall; reason: string }[] = [];
  let changed = false;
  let out = calls;

  // A short river name looked up with the words after it ("Madison fishing well"): the river.
  out = out.map((c) => {
    if (c.toolName !== "geocode" || typeof c.input.place !== "string") return c;
    const text = c.input.place;
    const river = reading.places.find((p) => text.toLowerCase().startsWith(p.place.replace(/\s+River$/, "").toLowerCase()) && !FEATURE_WORD.test(text));
    if (!river || text === river.place) return c;
    turn.note(`geocode "${text}" sent as "${river.place}": the question says ${river.written}`);
    changed = true;
    return { ...c, input: { ...c.input, place: river.place } };
  });

  // A render of a layer never queried this turn: query it on the place's box first (the render waits for the answer).
  const queriedHere = new Set(out.filter((c) => isQuery(c.toolName)).map((c) => layerOf(c.toolName)));
  const placeBox = turn.place?.bbox ?? turn.view?.bbox ?? out.find((c) => isQuery(c.toolName) && isBBox(c.input.bbox))?.input.bbox;
  out = out.flatMap((c) => {
    if (c.toolName !== "render" || typeof c.input.layerId !== "string") return [c];
    const layerId = c.input.layerId;
    if (!getLayer(layerId) || turn.queries.some((q) => q.layerId === layerId) || queriedHere.has(layerId)) return [c];
    changed = true;
    if (!isBBox(placeBox) || finalSteps) {
      rejected.push({ call: c, reason: `Not drawn: ${layerId} was not queried this turn, so there is nothing of it to draw. Query it first, or leave it out of the answer.` });
      turn.note(`render of ${layerId} dropped: never queried this turn`);
      return [];
    }
    queriedHere.add(layerId);
    turn.note(`render of ${layerId} became its query: never queried this turn`);
    return [{ toolCallId: readingId(), toolName: `${QUERY}${layerId}`, input: { ...readingInputs(reading, layerId, turn.now), bbox: placeBox } }];
  });

  // A species the question names: sightings asked for it in its words, and never an all-species GBIF density in its place
  // (sandhill cranes in Nebraska drew every record of every species, and the note read the cranes off it).
  if (reading.taxon) {
    out = out.filter((c) => {
      if (c.toolName !== `${QUERY}gbif-occurrences` || c.input.scientificName !== undefined || c.input.taxonKey !== undefined) return true;
      rejected.push({
        call: c,
        reason: `Not queried: the question asks about ${reading.taxon}, and gbif-occurrences without scientificName draws every species. Query it again with scientificName set to the Latin name of ${reading.taxon}.`,
      });
      turn.note(`gbif-occurrences: query dropped (no species, the question asks about ${reading.taxon})`);
      changed = true;
      return false;
    });
    out = out.map((c) => {
      if (c.toolName !== `${QUERY}species` || (typeof c.input.taxon === "string" && c.input.taxon.trim() !== "")) return c;
      turn.note(`species: taxon set to "${reading.taxon}" as the question names it`);
      changed = true;
      return { ...c, input: { ...c.input, taxon: reading.taxon } };
    });
  }

  // Layers the words rule out.
  out = out.filter((c) => {
    if (!isQuery(c.toolName)) return true;
    const avoid = reading.avoid.find((a) => a.layerId === layerOf(c.toolName));
    if (!avoid) return true;
    const instead = reading.layers.filter((l) => l.strong).map((l) => l.layerId);
    rejected.push({
      call: c,
      reason: `Not queried: ${avoid.because}, so ${avoid.layerId} does not answer this question${instead.length > 0 ? `; ${instead.join(" and ")} does` : ""}.`,
    });
    turn.note(`${avoid.layerId}: query dropped (${avoid.because})`);
    changed = true;
    return false;
  });

  // The layers the words name, on the same box as the step's other queries, once per turn.
  const queries = out.filter((c) => isQuery(c.toolName));
  const box = queries.find((c) => isBBox(c.input.bbox))?.input.bbox ?? (rejected.length > 0 ? placeBox : undefined);
  if (!finalSteps && isBBox(box) && (queries.length > 0 || rejected.some((r) => isQuery(r.call.toolName)))) {
    const added: GuardCall[] = [];
    for (const hint of reading.layers.filter((l) => l.strong)) {
      // Asked already, or a layer that answers for it (GBIF for sightings over a wide box), or a box past its limit.
      const answering = [hint.layerId, ...(ANSWERS_FOR[hint.layerId] ?? [])];
      if (turn.queries.some((q) => answering.includes(q.layerId)) || out.some((c) => answering.includes(layerOf(c.toolName)))) continue;
      const layer = getLayer(hint.layerId);
      if (!layer || bboxAreaKm2(box) > hardMaxAreaKm2(layer)) continue;
      if (turn.readingAdded.has(hint.layerId)) continue;
      turn.readingAdded.add(hint.layerId);
      added.push({ toolCallId: readingId(), toolName: `${QUERY}${hint.layerId}`, input: { ...readingInputs(reading, hint.layerId, turn.now), bbox: box } });
    }
    if (added.length > 0) {
      turn.note(`queried ${added.map((c) => c.toolName.slice(QUERY.length)).join(", ")} as the question's words ask (${reading.layers.filter((l) => l.strong).map((l) => l.because)[0]})`);
      out = [...out, ...added];
      changed = true;
    }
  }

  // Time and phrase inputs on every query.
  out = out.map((c) => {
    if (!isQuery(c.toolName)) return c;
    const layerId = layerOf(c.toolName);
    const want = readingInputs(reading, layerId, turn.now);
    const diff = Object.entries(want).filter(([k, v]) => !same(c.input[k], v));
    if (diff.length === 0) return c;
    changed = true;
    turn.note(`${layerId}: ${diff.map(([k, v]) => `${k} ${JSON.stringify(c.input[k] ?? null)} → ${JSON.stringify(v)}`).join(", ")} (${reading.time && diff.some(([k]) => !reading.inputs.some((i) => i.layerId === layerId && k in i.input)) ? `"${reading.time.phrase}"` : "the question's words"})`);
    return { ...c, input: { ...c.input, ...Object.fromEntries(diff) } };
  });

  return { calls: out, rejected, changed };
}

/** Facts worth listing for a candidate, when a feature has them: length, round trip, climb, shape. */
const CANDIDATE_KEYS = ["lengthKm", "roundTripKm", "gainM", "roundTripGainM", "shape", "sac_scale", "v", "imba", "disciplines", "gradeBands", "kind"];

/**
 * The features that match the question's own filters, as the model reads them in a query's summary: how many, and the
 * top few by the measure it asks to rank by (else the layer's card measure), each with its name and facts. Without
 * this the summary only covers every feature, and "good day hikes under 5 miles" came back as "the dataset does not
 * list individual trail names" while the map held 300 of them. Null when the question names no filter on the layer.
 */
export function matchingQuestion(body: unknown, layerId: string, turn: Pick<Turn, "reading" | "place" | "view">): JSONValue | null {
  const b = body as { kind?: string; data?: FeatureCollection };
  if (b?.kind !== "geojson" || !b.data) return null;
  const drawn = withReading({ layerId }, turn);
  const filters = drawn.filters as LayerFilters | undefined;
  if (!filters || Object.keys(filters).length === 0) return null;
  const layer = getLayer(layerId);
  const kept = applyFilters(b.data, filters).features;
  const key = typeof drawn.rankBy === "string" ? drawn.rankBy : (layer?.card?.measure?.key ?? "v");
  const named = kept.filter((f) => typeof f.properties?.name === "string" && typeof f.properties?.[key] === "number");
  named.sort((x, y) => Number(y.properties?.[key]) - Number(x.properties?.[key]));
  const seen = new Set<string>();
  const top: JSONValue[] = [];
  for (const f of named) {
    const p = f.properties ?? {};
    if (seen.has(String(p.name))) continue;
    seen.add(String(p.name));
    top.push(Object.fromEntries([["name", p.name], ...CANDIDATE_KEYS.filter((k) => p[k] !== undefined && p[k] !== null).map((k) => [k, p[k]])]) as JSONValue);
    if (top.length >= 6) break;
  }
  return { filters: filters as unknown as JSONValue, count: kept.length, rankedBy: key, top };
}

/**
 * A render's input with the reading's choices the model left out: filters the question names on this layer (a ski
 * run's color read for the place's region), a measure to rank by, and the change view for a snapshot layer when the
 * question asks what changed. A trail color governs a layer's difficulty: the model's filter on another difficulty
 * scale of the same layer gives way to it (IMBA blue is not Singletrack 2 on a third of Sedona's blue trails).
 */
export function withReading(input: Record<string, unknown>, turn: Pick<Turn, "reading" | "place" | "view">): Record<string, unknown> {
  const layerId = typeof input.layerId === "string" ? input.layerId : "";
  const layer = getLayer(layerId);
  if (!layer) return input;
  const reading = turn.reading;
  const out = { ...input };
  const center = turn.place?.center ?? turn.view?.center ?? null;
  const wanted = readingFilters(reading, layerId, center);
  if (wanted.length > 0) {
    const filters = { ...((typeof out.filters === "object" && out.filters !== null && !Array.isArray(out.filters) ? out.filters : {}) as Record<string, unknown>) };
    const colored = wanted.some((f) => f.color === true);
    if (colored) {
      for (const a of layer.attributes ?? []) if (a.type === "ordinal" && !wanted.some((f) => f.key === a.key)) delete filters[a.key];
    }
    for (const f of wanted) {
      if (filters[f.key] !== undefined && !colored) continue;
      filters[f.key] = f.include ? { include: f.include } : { range: f.range };
    }
    out.filters = filters;
  }
  const rank = reading.rankBy.find((r) => r.layerId === layerId);
  if (rank && out.rankBy === undefined) {
    out.rankBy = rank.key;
    if (out.view === undefined || out.view === "detail") out.view = "ranked";
  }
  if (reading.change && (out.view === undefined || out.view === "detail" || out.view === "ranked") && timeShapeOf(layer).shape === "snapshots") out.view = "change";
  return out;
}

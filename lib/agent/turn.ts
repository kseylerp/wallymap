import type { UIMessage } from "ai";
import { bboxAreaKm2, type BBox, type Layer } from "@/layers/types";
import { geocode as mapboxGeocode, type GeocodeError, type GeocodeResult } from "./geocode";
import { placeCandidates } from "./places";
import { readQuestion, type Reading } from "./reading";
import { lookupRegion } from "./regionNames";

/** Words that make a question about land and what grows on it, where a bare name may be a national forest. */
const LAND_WORDS = /\b(?:forests?|trees?|beetles?|timber|logging|burn\w*|fires?|wildfires?|wilderness|old[- ]growth|die-?off|mortality)\b/i;
import type { MapView } from "./view";

/**
 * What one chat turn has done so far, shared by the tools (which record it as they run) and the step guard
 * (lib/agent/stepGuard.ts, which reads it before each model step): the user's question and map view, every query and
 * whether it answered and was drawn, the place lookups, and what the server did on the model's behalf (`log`).
 * Tools are built per request, so a Turn lives for one question.
 */

/** Most model steps in one turn: room for geocode, several queries, renders and the note. */
export const MAX_STEPS = 12;

/** One query this turn: the layer, the box it ran on, its other inputs, and how it answered. */
export type QueryRecord = {
  layerId: string;
  bbox: BBox;
  /** The query's inputs other than bbox and zoom, as JSON, so two queries asking the same thing compare equal. */
  inputKey: string;
  ok: boolean;
  /** Something to draw came back: features, or map tiles. */
  drawable: boolean;
  /** Answered by the layer's wide strategy (a box over its usual area): the result already covers the whole box. */
  wide: boolean;
  /** The named feature highest by the layer's primary measure, when the result has one. */
  top?: { name: string; value: number; by: string; unit?: string };
  /** The box was over the layer's hard area limit (a zoom_in error): no part of it is worth asking again. */
  zoomIn?: boolean;
  /** A data story (a series layer): its caption in the data's shape, which the note must follow (lib/agent/noteCheck.ts). */
  caption?: string;
  /** A data story's encoding in words ("Line width is Flow (m³/s); color is ..."): the answer always says it. */
  meaning?: string;
};

export type Geocoder = (place: string, opts?: { proximity?: [number, number] }) => Promise<GeocodeResult | GeocodeError>;

export type Turn = {
  question: string;
  /** The app's own reading of the question (lib/agent/reading.ts): layers, filters, inputs and the time window its words name. */
  reading: Reading;
  /** When the turn started: "today" for the time window and the note's dates. */
  now: Date;
  /** Every tool result the model saw this turn (query summaries, geocodes, routes), for the note's grounding check. */
  outputs: unknown[];
  /** Layers the step guard queried because the question's words name them (each once per turn). */
  readingAdded: Set<string>;
  view: MapView | null;
  queries: QueryRecord[];
  /** Layers rendered or compared this turn. */
  drawn: Set<string>;
  /** Layers compared this turn (two dates or two amounts side by side). */
  compared: Set<string>;
  /** The standard view each layer was last rendered in this turn. */
  views: Map<string, string>;
  /** The place this turn's queries are about, once a geocode found it (the first one found). */
  place: GeocodeResult | null;
  /** Every place a geocode found this turn, in order (the model may look a place up again with a fuller name). */
  places: GeocodeResult[];
  /** True once a named region was outlined by physical-regions (the place is on the map without a geocode). */
  regionQueried: boolean;
  /** Notes the note tool sent back for a rewrite this turn, so it asks at most once per reason. */
  noteRewrites: Set<string>;
  /** What the server did for the model this turn, one line each (also logged to the server console). */
  log: string[];
  /** The model step about to run (0 first), set before each step (lib/agent/agent.ts prepareStep). */
  step: number;
  /** True once a note was shown (not sent back to be rewritten). */
  noted: boolean;
  /** Place lookups the model asked for this turn (the geocode tool's calls). */
  geocodes: number;
  /** A place lookup, shared by the geocode tool and the step guard so one text is looked up once. */
  lookup(place: string): Promise<GeocodeResult | GeocodeError>;
  /** Records a server action in `log` and the console. */
  note(line: string): void;
};

/** The text of a place as lookups compare it: case, punctuation and spacing ignored. */
export function placeKey(place: string): string {
  return place.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function createTurn({
  question = "",
  view = null,
  geocoder = mapboxGeocode,
  now = new Date(),
  regions = geocoder === mapboxGeocode ? lookupRegion : undefined,
}: { question?: string; view?: MapView | null; geocoder?: Geocoder; now?: Date; regions?: typeof lookupRegion } = {}): Turn {
  const lookups = new Map<string, Promise<GeocodeResult | GeocodeError>>();
  const context = new Map<string, Promise<GeocodeResult | GeocodeError>>();

  /** Where the question is about, besides `place`: the last place found this turn, else another place it names. */
  async function contextPoint(place: string): Promise<[number, number] | undefined> {
    // The turn itself (built below): the places it found so far bias the next lookup.
    const found = self.places;
    if (found.length > 0) return found[found.length - 1].center;
    const asked = place.toLowerCase();
    const others = placeCandidates(question).filter((p) => !asked.includes(p.toLowerCase()) && !p.toLowerCase().includes(asked.split(",")[0].trim()));
    for (const other of others.slice(0, 2)) {
      let answer = context.get(other.toLowerCase());
      if (!answer) {
        answer = geocoder(other, {});
        context.set(other.toLowerCase(), answer);
      }
      const r = await answer;
      if (!("error" in r)) return r.center;
    }
    return undefined;
  }

  /**
   * The public-land unit a bare name means when the question is about land (trees, fire, trails, camping): "beetle kill
   * in the Medicine Bow" is the Medicine Bow National Forest, not the town of Medicine Bow, Wyoming.
   */
  async function landUnit(place: string, result: GeocodeResult | GeocodeError): Promise<GeocodeResult | null> {
    if (!regions || "error" in result || result.source !== "mapbox" || !LAND_WORDS.test(question)) return null;
    const [w, s, e, n] = result.bbox;
    const name = place.split(",")[0].trim();
    if (e - w > 1.5 || n - s > 1.5 || /\b(?:national|forest|park|wilderness|county|city|town|lake|river|mountains?|range)\b/i.test(name)) return null;
    const unit = await regions(`${name} National Forest`, result.center, { naturalEarth: async () => null });
    // The forest of that name, close to the town that shares it.
    if (!unit || Math.hypot(unit.center[0] - result.center[0], unit.center[1] - result.center[1]) > 2) return null;
    return unit;
  }

  const self: Turn = {
    question,
    reading: readQuestion(question, now),
    now,
    outputs: [],
    readingAdded: new Set(),
    view,
    queries: [],
    drawn: new Set(),
    compared: new Set(),
    views: new Map(),
    place: null,
    places: [],
    regionQueried: false,
    noteRewrites: new Set(),
    log: [],
    step: 0,
    noted: false,
    geocodes: 0,
    lookup(place) {
      const key = placeKey(place);
      let found = lookups.get(key);
      if (!found) {
        found = (async () => {
          // Bias toward what the user is looking at, when they are looking at somewhere (not the whole globe); else
          // toward the places this turn already found or the question's other places ("Red Rock near Las Vegas").
          const proximity = view?.bbox ? view.center : await contextPoint(place);
          const result = await geocoder(place, proximity ? { proximity } : {});
          return (await landUnit(place, result)) ?? result;
        })();
        lookups.set(key, found);
      }
      return found;
    },
    note(line) {
      this.log.push(line);
      console.info(`[turn] ${line}`);
    },
  };
  return self;
}

/** The text of the last user message: the question this turn answers. */
export function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
  }
  return "";
}

/** The inputs of a query other than bbox and zoom, as stable JSON. */
export function inputKeyOf(input: Record<string, unknown>): string {
  const rest = Object.entries(input)
    .filter(([k, v]) => k !== "bbox" && k !== "zoom" && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(rest);
}

/** True when the query's box is over the layer's usual area and the layer answers it with its wide strategy. */
export function isWideQuery(layer: Pick<Layer, "maxAreaKm2" | "wide">, bbox: BBox): boolean {
  return layer.wide !== undefined && Number.isFinite(layer.maxAreaKm2) && bboxAreaKm2(bbox) > layer.maxAreaKm2;
}

/** Successful queries with something to draw whose layer was not rendered or compared yet, one per layer, in order. */
export function undrawn(turn: Pick<Turn, "queries" | "drawn">): string[] {
  const out: string[] = [];
  for (const q of turn.queries) {
    if (q.ok && q.drawable && !turn.drawn.has(q.layerId) && !out.includes(q.layerId)) out.push(q.layerId);
  }
  return out;
}

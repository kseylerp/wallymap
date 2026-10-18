/**
 * Named mountain peaks with elevation from OpenStreetMap and Wikidata merged, and prominence and links from Wikidata, keyless.
 *
 * OpenStreetMap (through layers/_shared/overpass.ts, one Overpass query per call): named `natural=peak` and `natural=volcano`
 * nodes in the box with their `ele` (metres, or feet when the tag says so) and sometimes `prominence` and a `wikidata` tag. In a
 * Leadville box (-106.6,38.9,-106.2,39.3) OSM had 71 named peaks, every one with an elevation, where Wikidata had 73 items with an
 * elevation on 22 (audit 2026-10-17), so OSM carries the elevations.
 *
 * Wikidata: POST https://query.wikidata.org/sparql (form body `query=...`, Accept: application/sparql-results+json). The query
 * finds items with coordinates (P625, via the `wikibase:box` service) inside the bbox whose instance of (P31, with subclasses) is
 * mountain (Q8502), summit (Q207326) or volcano (Q8072), then reads elevation (P2044) and topographic prominence (P2660) through the
 * normalised-value path `p:P2044/psn:P2044/wikibase:quantityAmount`, which converts every source unit (feet included) to metres;
 * the plain `wdt:P2044` value is NOT normalised (Jobs Peak read 10638, which is feet). Items carry several prominence values with
 * different reference points, so the largest is kept. The label service asks for English then "mul"; an item with neither falls
 * back to its native label (P1705) and is dropped when it has no name at all. Requests go through layers/_shared/wikimedia.ts
 * (one User-Agent, one retry on 429 or 503). WDQS kills queries after 60 s.
 *
 * The two run in parallel and are joined (mergePeaks): an OSM peak whose `wikidata` tag names a Wikidata item is that item; else a
 * Wikidata item and an OSM peak of the same name (Mt./Mount spelled alike) within 1 km are one summit. A joined peak takes the OSM
 * position and elevation and the Wikidata English name, prominence and link; OSM-only and Wikidata-only peaks are kept. When one
 * source fails the other's peaks are returned with a note (and sourceStatus says which failed); when both fail it is an error.
 * Live 2026-10-18 (through runLayer): Leadville box returned 76 peaks in 1.6 s (68 joined, 3 OSM-only, 5 Wikidata-only), 75 with an
 *   elevation where Wikidata alone had 22, Mount Elbert first at 14,440 ft; a Zermatt box (7.6,45.9,7.9,46.1) 184 peaks in 4.7 s, 4 with none.
 *
 * Wide mode (over 40,000 km², up to 600,000 km²) runs widePeaksQuery on Wikidata alone: the 1,000 most prominent peaks, ranked by
 * prominence, with no count (a second WDQS query would risk 429s, and OSM has no prominence to rank by).
 * Smoke wide 2026-10-14: Colorado -108.5,37,-104.5,41 returned all 176 peaks with a prominence in 2.8 s, Mount Elbert first.
 */
import { z } from "zod";
import type { Feature, Point, Position } from "geojson";
import {
  defineLayer,
  type BBox,
  type LayerError,
  type LayerResult,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type SourceStatus,
  type QueryContext,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { rankedSparql, wikimediaFetch } from "./_shared/wikimedia";
import { haversineKm } from "./_shared/geo";
import { overpassQuery, overpassCounts } from "./_shared/overpass";
import { bboxClause, metres as osmMetres } from "./_shared/osm-features";
import { FT_PER_M, heightText, matchName, usUnitsFirst } from "./peaks-units";
import { layerColor } from "@/lib/render/palette";

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const LIMIT = 1_000;
/** Most OSM peaks one Overpass answer carries (a 40,000 km² Colorado box held 993 named peaks, 2026-10-18). */
export const OSM_LIMIT = 3_000;
/** Most peaks a result carries, highest first. */
export const MAX_FEATURES = 2_000;
/**
 * Extra rows a wide query asks for past its limit, so items dropped for having no name do not leave the result short of the
 * limit (which run.ts would read as "all of them").
 */
const WIDE_SLACK = 50;
/** Peaks do not move; Wikidata edits are slow-moving too. */
const TTL_SECONDS = 7 * 86_400;
/** Overpass's own time limit for the peak query, under the client's 25 s. */
const OVERPASS_TIMEOUT_S = 20;

/* ---------- Wikidata ---------- */

/** The SPARQL text for a bbox; `Point(lon lat)` corners are south-west then north-east. */
export function peaksQuery(bbox: BBox): string {
  const [west, south, east, north] = bbox;
  return `SELECT ?item ?itemLabel ?coord (MAX(?elevM) AS ?elev) (MAX(?promM) AS ?prom) (SAMPLE(?nativeName) AS ?native) WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  VALUES ?cls { wd:Q8502 wd:Q207326 wd:Q8072 }
  ?item wdt:P31/wdt:P279* ?cls .
  OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?elevM . }
  OPTIONAL { ?item p:P2660/psn:P2660/wikibase:quantityAmount ?promM . }
  OPTIONAL { ?item wdt:P1705 ?nativeName . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
GROUP BY ?item ?itemLabel ?coord
ORDER BY DESC(?elev) DESC(?prom)
LIMIT ${LIMIT}`;
}

const valueSchema = z.object({ value: z.string() });
const responseSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: valueSchema,
        itemLabel: valueSchema.optional(),
        coord: valueSchema,
        elev: valueSchema.optional(),
        prom: valueSchema.optional(),
        native: valueSchema.optional(),
      }),
    ),
  }),
});

type Binding = z.infer<typeof responseSchema>["results"]["bindings"][number];

/**
 * The wide-mode query (over 40,000 km²): the most prominent peaks in the box. The box query above times out cold past about
 * 100,000 km² in dense ranges (a 128,000 km² Alps box ran over 60 s), so this one starts from the items that have a
 * prominence, keeps those whose coordinate falls in the box and that are peaks, ranks them and only then reads elevations and
 * labels for the kept rows. Peaks with no prominence recorded are left out, which the result says.
 */
export function widePeaksQuery(bbox: BBox, limit: number): string {
  const [west, south, east, north] = bbox;
  const n = limit + WIDE_SLACK;
  return rankedSparql(
    `SELECT ?item ?itemLabel ?coord ?prom (MAX(?elevM) AS ?elev) (SAMPLE(?nativeName) AS ?native) WHERE {
  {
    SELECT ?item (SAMPLE(?c) AS ?coord) (MAX(?promM) AS ?prom) WHERE {
      ?item p:P2660/psn:P2660/wikibase:quantityAmount ?promM .
      ?item wdt:P625 ?c .
      FILTER(geof:longitude(?c) >= ${west} && geof:longitude(?c) <= ${east} && geof:latitude(?c) >= ${south} && geof:latitude(?c) <= ${north})
      VALUES ?cls { wd:Q8502 wd:Q207326 wd:Q8072 }
      ?item wdt:P31/wdt:P279* ?cls .
    }
    GROUP BY ?item
    ORDER BY DESC(?prom)
    LIMIT ${n}
  }
  OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?elevM . }
  OPTIONAL { ?item wdt:P1705 ?nativeName . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
GROUP BY ?item ?itemLabel ?coord ?prom`,
    n,
    "prom",
  );
}

/** "Point(-119.9 38.8575)" -> [-119.9, 38.8575]. */
function parseWkt(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function positiveMetres(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
}

/** Highest summit on Earth with a margin: an `ele` above this is feet entered without a unit, not metres. */
const MAX_ELEVATION_M = 8_900;

/** Two items of one name closer than this are one summit listed twice. */
const TWIN_KM = 0.2;

/** Peaks as points: v is the elevation in metres, prominence is its own property. Items with no name in any form are dropped. */
export function normalizePeaks(bindings: Binding[]): Feature<Point>[] {
  const features: Feature<Point>[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const id = b.item.value.split("/").pop() ?? b.item.value;
    // With no English or "mul" label the label service answers with the Q-number, which is not a name; the native label is next best.
    const label = b.itemLabel?.value.trim();
    const raw = label && label !== id ? label : b.native?.value.trim();
    // "Ice Mountain (Colorado)": the bracket tells Wikidata items apart, it is not part of the name.
    const name = raw?.replace(/\s*\([^)]*\)$/, "") || raw;
    if (!name || name === id || seen.has(id)) continue;
    const coords = parseWkt(b.coord.value);
    if (coords === null) continue;
    seen.add(id);
    // Wikidata sometimes holds one summit twice (Mount Watkins as Q3322181 and Q131056543, same point): the first, which
    // sorts higher because it has the elevation, stands for both.
    if (features.some((f) => f.properties?.name === name && haversineKm(f.geometry.coordinates, coords) < TWIN_KM)) continue;

    const elevation = positiveMetres(b.elev?.value);
    const prominence = positiveMetres(b.prom?.value);
    const properties: Record<string, string | number> = { name };
    if (elevation !== undefined && elevation <= MAX_ELEVATION_M) properties.elevation = elevation;
    if (prominence !== undefined && prominence <= MAX_ELEVATION_M) properties.prominence = prominence;
    if (properties.elevation !== undefined) properties.v = properties.elevation;
    properties.wikidata = id;
    properties.url = `https://www.wikidata.org/wiki/${id}`;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties });
  }
  return features;
}

/* ---------- OpenStreetMap ---------- */

/** Overpass QL for the named peaks and volcanoes in a box: their count, then up to OSM_LIMIT of them with tags. */
export function osmPeaksQuery(bbox: BBox): string {
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];node["natural"~"^(peak|volcano)$"]["name"]${bboxClause(bbox)}->.p;.p out count;.p out ${OSM_LIMIT};`;
}

const osmNodeSchema = z.object({
  type: z.literal("node"),
  id: z.number(),
  lat: z.number(),
  lon: z.number(),
  tags: z.record(z.string(), z.string()).optional(),
});

/** An OSM peak before the join. */
export type OsmPeak = {
  id: number;
  coords: [number, number];
  name: string;
  kind: "peak" | "volcano";
  elevation?: number;
  prominence?: number;
  wikidata?: string;
};

/** A height tag in metres to a tenth ("4401.2", "14440 ft", "4,401"); undefined when unreadable or not a plausible summit height. */
function tagMetres(value: string | undefined): number | undefined {
  // "4401;4399" lists alternatives; the first is the one mapped.
  const m = osmMetres(value?.split(";")[0]);
  return m !== undefined && m > 0 && m <= MAX_ELEVATION_M ? Math.round(m * 10) / 10 : undefined;
}

/** The named peaks in an Overpass body, English name first when tagged. */
export function parseOsmPeaks(json: unknown): OsmPeak[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const peaks: OsmPeak[] = [];
  for (const raw of elements) {
    const node = osmNodeSchema.safeParse(raw);
    if (!node.success) continue;
    const tags = node.data.tags ?? {};
    const name = (tags["name:en"] ?? tags.name)?.trim();
    if (!name) continue;
    const elevation = tagMetres(tags.ele);
    const prominence = tagMetres(tags.prominence);
    const wikidata = /^Q\d+$/.test(tags.wikidata ?? "") ? tags.wikidata : undefined;
    peaks.push({
      id: node.data.id,
      coords: [node.data.lon, node.data.lat],
      name,
      kind: tags.natural === "volcano" ? "volcano" : "peak",
      ...(elevation !== undefined && { elevation }),
      ...(prominence !== undefined && { prominence }),
      ...(wikidata !== undefined && { wikidata }),
    });
  }
  return peaks;
}

/* ---------- Join ---------- */

/** One summit listed in Wikidata and OSM under one name lies within this distance in both. */
export const JOIN_KM = 1;


type Units = { usFirst: boolean };

/** The plain-word fields every peak carries: elevation and prominence as text in the view's units, and where they came from. */
function finish(properties: Record<string, string | number>, units: Units): Record<string, string | number> {
  const elevation = properties.elevation;
  if (typeof elevation === "number") {
    properties.v = elevation;
    properties.elevationFt = Math.round(elevation * FT_PER_M);
    properties.elevationText = heightText(elevation, units.usFirst);
  } else {
    properties.elevationText = "Not recorded";
  }
  if (typeof properties.prominence === "number") {
    properties.prominenceFt = Math.round(properties.prominence * FT_PER_M);
    properties.prominenceText = heightText(properties.prominence, units.usFirst);
  }
  return properties;
}

/**
 * Wikidata peaks and OSM peaks as one list, highest first (peaks with no elevation last). A pair is one summit when the OSM
 * `wikidata` tag names the item, else when the names match and the points are within JOIN_KM. The joined peak sits at the OSM
 * point and takes the OSM elevation (Wikidata's when OSM has none), the Wikidata name, prominence (OSM's when Wikidata has none)
 * and link. Every peak has elevationText ("Not recorded" when neither source has one) and `sources`.
 */
export function mergePeaks(wikidata: Feature<Point>[], osm: OsmPeak[], units: Units): Feature<Point>[] {
  const byQ = new Map<string, OsmPeak>();
  for (const p of osm) if (p.wikidata && !byQ.has(p.wikidata)) byQ.set(p.wikidata, p);
  const used = new Set<number>();
  const out: Feature<Point>[] = [];

  for (const w of wikidata) {
    const wp = (w.properties ?? {}) as Record<string, string | number>;
    const q = String(wp.wikidata);
    let match = byQ.get(q);
    if (match && used.has(match.id)) match = undefined;
    if (!match) {
      const key = matchName(String(wp.name));
      let best: { p: OsmPeak; d: number } | undefined;
      for (const p of osm) {
        if (used.has(p.id) || (p.wikidata && p.wikidata !== q) || matchName(p.name) !== key) continue;
        const d = haversineKm(p.coords, w.geometry.coordinates);
        if (d <= JOIN_KM && (!best || d < best.d)) best = { p, d };
      }
      match = best?.p;
    }
    const properties: Record<string, string | number> = { name: String(wp.name) };
    let coords: Position = w.geometry.coordinates;
    if (match) {
      used.add(match.id);
      coords = match.coords;
      properties.kind = match.kind;
      const elevation = match.elevation ?? (typeof wp.elevation === "number" ? wp.elevation : undefined);
      if (elevation !== undefined) {
        properties.elevation = elevation;
        properties.elevationSource = match.elevation !== undefined ? "osm" : "wikidata";
      }
      const prominence = typeof wp.prominence === "number" ? wp.prominence : match.prominence;
      if (prominence !== undefined) properties.prominence = prominence;
      properties.sources = "both";
      properties.osmId = match.id;
      properties.osmUrl = `https://www.openstreetmap.org/node/${match.id}`;
    } else {
      properties.kind = "peak";
      if (typeof wp.elevation === "number") {
        properties.elevation = wp.elevation;
        properties.elevationSource = "wikidata";
      }
      if (typeof wp.prominence === "number") properties.prominence = wp.prominence;
      properties.sources = "wikidata";
    }
    properties.wikidata = q;
    properties.url = String(wp.url);
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: finish(properties, units) });
  }

  for (const p of osm) {
    if (used.has(p.id)) continue;
    const properties: Record<string, string | number> = { name: p.name, kind: p.kind };
    if (p.elevation !== undefined) {
      properties.elevation = p.elevation;
      properties.elevationSource = "osm";
    }
    if (p.prominence !== undefined) properties.prominence = p.prominence;
    properties.sources = "osm";
    properties.osmId = p.id;
    properties.osmUrl = `https://www.openstreetmap.org/node/${p.id}`;
    if (p.wikidata) {
      properties.wikidata = p.wikidata;
      properties.url = `https://www.wikidata.org/wiki/${p.wikidata}`;
    }
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: p.coords }, properties: finish(properties, units) });
  }

  const height = (f: Feature) => (typeof f.properties?.elevation === "number" ? f.properties.elevation : -Infinity);
  const prom = (f: Feature) => (typeof f.properties?.prominence === "number" ? f.properties.prominence : -Infinity);
  return out.sort((a, b) => height(b) - height(a) || prom(b) - prom(a));
}

/* ---------- Layer ---------- */

const KIND_LEVELS = [
  { value: "peak", label: "Peak", help: "A summit: the highest point of a mountain or hill." },
  { value: "volcano", label: "Volcano", help: "A summit that is a volcano, active or not." },
];

const ATTRIBUTES: Attribute[] = [
  { key: "elevation", type: "measure", label: "Elevation", unit: "m", encode: "size" },
  { key: "prominence", type: "measure", label: "Prominence", unit: "m" },
  { key: "kind", type: "category", label: "Kind", levels: KIND_LEVELS },
  nameAttribute(),
];

const ELEVATION: FieldHelp = {
  text:
    "Height of the summit above sea level, from the OpenStreetMap `ele` tag where mappers recorded one (most US figures come from " +
    "USGS maps), else from Wikidata (P2044). Mappers' and editors' figures, not survey-checked.",
  unit: "m",
  source: "OpenStreetMap, Wikidata",
  url: "https://wiki.openstreetmap.org/wiki/Key:ele",
};

const PROMINENCE: FieldHelp = {
  text:
    "How far the peak rises above the lowest saddle that links it to a higher peak, the standard measure of how independent a summit is, " +
    "from Wikidata (P2660), else the OpenStreetMap `prominence` tag.",
  unit: "m",
  source: "Wikidata, OpenStreetMap",
  url: "https://www.wikidata.org/wiki/Property:P2660",
};

const HELP: Record<string, FieldHelp> = {
  elevation: ELEVATION,
  elevationText: ELEVATION,
  v: ELEVATION,
  prominence: PROMINENCE,
  prominenceText: PROMINENCE,
};

const SOURCES: Record<string, string> = { both: "OpenStreetMap and Wikidata", osm: "OpenStreetMap", wikidata: "Wikidata" };

const CARD: CardSpec = {
  measure: { key: "elevationText", label: "Elevation" },
  facts: [
    { key: "prominenceText", label: "Prominence" },
    { key: "kind", label: "Kind", values: { peak: "Peak", volcano: "Volcano" } },
    { key: "elevationSource", label: "Elevation from", values: { osm: "OpenStreetMap", wikidata: "Wikidata" } },
    { key: "sources", label: "Listed in", values: SOURCES },
  ],
  links: [
    { key: "url", label: "Wikidata" },
    { key: "osmUrl", label: "OpenStreetMap" },
  ],
  hidden: ["elevation", "elevationFt", "prominence", "prominenceFt", "v", "wikidata", "osmId"],
};

/** One source's failure as a SourceStatus, so the row says which source did not answer and what the map holds instead. */
function sourceFailure(error: string, message: string, status?: number): SourceStatus {
  return {
    ok: false,
    reason: status === 429 || /rate-limiting/i.test(error) ? "rate-limited" : /timed out|no response/i.test(error) ? "offline" : "server-error",
    message,
  };
}

const peaks = defineLayer({
  id: "peaks",
  title: "Peaks",
  description:
    "Named mountain peaks, summits and volcanoes from OpenStreetMap and Wikidata merged, with elevation and prominence. " +
    "Each point has name, kind ('peak' or 'volcano'), elevation (metres above sea level, from the OpenStreetMap ele tag, else Wikidata), elevationFt, " +
    "elevationText (the elevation in words with both units, feet first in the United States, or 'Not recorded'), prominence and prominenceFt (how far the peak " +
    "rises above the saddle that links it to a higher peak, the standard measure of how independent a summit is; mostly from Wikidata) with prominenceText, " +
    "v (the elevation in metres, so the value filter and 3D columns follow height), sources ('both', 'osm' or 'wikidata'), and links: url (Wikidata) and osmUrl. " +
    "Peaks with no elevation recorded have no v and sort last. Symbols are sized by elevation and the five highest are named on the map. " +
    "Use it for 'tallest peaks here', 'highest mountains in this range', 'peaks with the most prominence' (sort on prominence yourself), 'what is that mountain called', " +
    "or 'peak bagging' lists; with 3D on, columns rise with elevation. " +
    "Caveats: elevations are mappers' and editors' figures, not survey-checked; for exact figures use USGS or the summit register. Prominence is missing for most minor summits. " +
    "Names are English when tagged, otherwise the peak's own-language name. At most 2,000 peaks, highest first. " +
    "Works worldwide. Over 40,000 km² (about a 200 km square) it returns only Wikidata peaks with a recorded prominence, the 1,000 most prominent.",
  coverage: "global",
  surface: "land",
  license: "ODbL (OpenStreetMap contributors); CC0 (Wikidata)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 40_000,
  // A whole range ("the Southern Alps of New Zealand", 268,000 km²) answers with its most prominent peaks.
  hardMaxAreaKm2: 600_000,
  wide: { orderBy: "prominence", rank: "most prominent", limit: LIMIT },
  input: z.object({}),
  style: { geometry: "point", color: layerColor("peaks"), unit: "m", extrude: "v", encode: { size: "elevation" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: {
    kind: "size",
    title: "Elevation",
    field: "elevation",
    unit: "m",
    stops: [{ label: "Lower summit" }, { label: "Higher summit" }],
    note: "Symbols grow with summit elevation; the five highest are named. A peak with no elevation recorded is not sized and says so on its card.",
  },
  labels: { field: "name", max: 5, rankBy: "elevation" },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Wide (over 40,000 km², up to the hard cap): the most prominent peaks from Wikidata alone, capped at the strategy's limit.
    const wideLimit = ctx.wide ? Math.min(LIMIT, ctx.wideStrategy?.limit ?? LIMIT) : undefined;
    const query = wideLimit === undefined ? peaksQuery(ctx.bbox) : widePeaksQuery(ctx.bbox, wideLimit);
    const units = { usFirst: usUnitsFirst(ctx.bbox) };

    const [wd, osm] = await Promise.all([
      fetchWikidata(ctx, query),
      wideLimit === undefined ? overpassQuery(ctx, osmPeaksQuery(ctx.bbox)) : Promise.resolve(null),
    ]);
    const osmOk = osm?.ok === true;
    if ("error" in wd && !osmOk) return wd;

    const notes: string[] = [];
    let wikidataPeaks: Feature<Point>[] = [];
    let wikidataRows = 0;
    if ("bindings" in wd) {
      wikidataRows = wd.bindings.length;
      const all = normalizePeaks(wd.bindings);
      wikidataPeaks = wideLimit === undefined ? all : all.slice(0, wideLimit);
    } else {
      notes.push(`Wikidata did not answer (${wd.error}); peaks are from OpenStreetMap only, without prominence or Wikidata links`);
    }

    let osmPeaks: OsmPeak[] = [];
    let sourceStatus: SourceStatus | undefined;
    if (osm?.ok) {
      osmPeaks = parseOsmPeaks(osm.json);
      const [total] = overpassCounts(osm.json);
      if (total !== undefined && total > osmPeaks.length) {
        notes.push(`OpenStreetMap sent ${osmPeaks.length.toLocaleString("en-US")} of its ${total.toLocaleString("en-US")} named peaks here; zoom in for the rest`);
      }
      // Both answered (Overpass perhaps from its fallback host): say so over any failure the first host left behind.
      sourceStatus =
        "error" in wd
          ? sourceFailure(wd.error, `Wikidata did not answer (${wd.error}); peaks are from OpenStreetMap only, without prominence.`)
          : { ok: true };
    } else if (osm && !osm.ok) {
      notes.push(`OpenStreetMap did not answer (${osm.error}), so these are Wikidata peaks only and most have no elevation`);
      sourceStatus = sourceFailure(osm.error, `OpenStreetMap (Overpass) did not answer (${osm.error}); peaks are from Wikidata only, most without an elevation.`, osm.status);
    }

    const merged = mergePeaks(wikidataPeaks, osmPeaks, units);
    const features = merged.slice(0, wideLimit ?? MAX_FEATURES);
    // In wide mode run.ts writes the "showing the N most prominent" note.
    if (wideLimit === undefined && merged.length > MAX_FEATURES) {
      notes.push(`Showing the ${MAX_FEATURES.toLocaleString("en-US")} highest peaks; zoom in for the rest`);
    } else if (wideLimit === undefined && wikidataRows >= LIMIT) {
      notes.push(`Wikidata sent its ${LIMIT.toLocaleString("en-US")} highest peaks here; zoom in for the rest`);
    }
    if (wideLimit !== undefined) notes.push("only Wikidata peaks with a recorded prominence are listed at this scale");
    if (features.length === 0) notes.push("No named peaks in OpenStreetMap or Wikidata for this area");
    else {
      const missing = features.filter((f) => typeof f.properties?.elevation !== "number").length;
      if (missing > 0) notes.push(`${missing} of ${features.length} peaks have no elevation recorded`);
    }

    const cited = [
      ...(osm?.ok ? ["OpenStreetMap contributors (ODbL), named natural=peak and natural=volcano nodes with ele"] : []),
      ...("bindings" in wd ? ["Wikidata (CC0), peaks with elevation (P2044) and topographic prominence (P2660)"] : []),
    ];
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: cited.join("; "),
        url: osm?.ok ? "https://www.openstreetmap.org/copyright" : "https://www.wikidata.org/",
        retrieved: new Date().toISOString(),
      },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      ...(sourceStatus ? { sourceStatus } : {}),
    };
  },
});

/** The Wikidata half: its rows, or an error in the layer's words. */
async function fetchWikidata(
  ctx: QueryContext,
  query: string,
): Promise<{ bindings: Binding[] } | LayerError> {
  let res: Response;
  try {
    res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query }).toString(),
      cacheKey: ctx.cacheKey,
      ttlSeconds: TTL_SECONDS,
    });
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      error: timedOut ? `Wikidata timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again` : "Wikidata returned no response",
      hint: "upstream",
    };
  }
  if (res.status === 429 || res.status === 503) return { error: "Wikidata is rate-limiting requests; try again in a minute", hint: "upstream" };
  if (!res.ok) return { error: `Wikidata returned ${res.status}`, hint: "upstream" };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { error: "Wikidata returned a response that is not JSON", hint: "upstream" };
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { error: "Wikidata returned an unexpected response", hint: "upstream" };
  return { bindings: parsed.data.results.bindings };
}

registerLayer(peaks);

export default peaks;

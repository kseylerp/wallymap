/**
 * Named lakes and reservoirs with maximum depth from Wikidata, keyless.
 *   POST https://query.wikidata.org/sparql   (form body `query=...`, Accept: application/sparql-results+json)
 * The query finds items with coordinates (P625, via the `wikibase:box` service) inside the bbox whose instance of (P31, with subclasses)
 * is lake (Q23397; reservoirs sit under it), flags the ones that are also reservoirs (Q131681), and reads maximum depth (P4511, vertical depth),
 * area (P2046), elevation (P2044) and volume (P2234) through the normalised path `p:Pxxx/psn:Pxxx/wikibase:quantityAmount`, which converts
 * every source unit to metres, square metres and cubic metres. The English label comes from `rdfs:label` (so items with no English name drop out
 * and a `name` input can filter by it) and the English Wikipedia article from its sitelink. Results are ordered by area then depth and capped at 500.
 * Wikimedia requires a descriptive User-Agent and returns 429 (or 503 from the query service) to bursts; the request goes through
 * `wikimediaFetch` (shared User-Agent, one retry after the advised wait). WDQS kills queries after 60 s.
 * Smoke check 2026-10-09 (live, keyless, through runLayer): Lake Tahoe box (-120.2,38.8,-119.8,39.2) returned 27 named lakes (28 rows; Spooner
 *   Lake has two coordinate statements) in 0.5 s, only Lake Tahoe with depth: 501 m, area 502 km2, elevation 1,899.5 m, volume 150 km3. With
 *   name "Tahoe" over a 2 x 1.3 degree box it returned just Lake Tahoe in 0.7 s. A Swiss box (7,46,9.5,47.5, about 21,000 km2) returned 311
 *   lakes (69 with depth; Maggiore 372 m, Como 410 m) in 13.5 s and a Finnish lake-district box (25,61,28,63) hit the 500-row cap in 13.5 s,
 *   which is why the area cap is 20,000 km2 (the 25 s client timeout is the limit).
 * Wide mode (over 20,000 km², up to the default hard cap of 80,000 km²) runs wideLakesQuery: the 1,000 largest by area, no count.
 * Smoke wide 2026-10-14 (through runLayer): Minnesota -94.4,45.4,-91,48 (about 70,000 km²) returned 1,000 lakes in 4.5 s (7 with depth);
 *   with name "mille" the same box returned 3 in 2.7 s, Mille Lacs Lake first. Raw WDQS timings for the ranked query that day, cold: Minnesota
 *   -94.5,45.5,-91,48 (about 73,000 km²) 1,000 rows in 2.0 s; northern California 1.1 s; the Alps 6,45,10,47.5 21.6 s; Finnish lakes
 *   24,61,29,63.8 (about 78,000 km², the densest lake country) between 13 and 29 s, so that one can time out on a cold cache.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { rankedSparql, wikimediaFetch } from "./_shared/wikimedia";
import { layerColor } from "@/lib/render/palette";

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
export const LIMIT = 500;
/** Most lakes a wide result (over 20,000 km²) carries, the largest by area. */
export const WIDE_LIMIT = 1_000;
/** Extra rows a wide query asks for, so items repeated under two coordinates do not leave the result short of its limit. */
const WIDE_SLACK = 50;
/** Lakes do not move and Wikidata edits are slow-moving. */
const TTL_SECONDS = 7 * 86_400;

/** A SPARQL string literal body: backslashes and quotes escaped, control characters dropped. */
function sparqlString(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/** The SPARQL text for a bbox and an optional case-insensitive name filter; `Point(lon lat)` corners are south-west then north-east. */
export function lakesQuery(bbox: BBox, name?: string): string {
  const [west, south, east, north] = bbox;
  const needle = name?.trim().toLowerCase();
  const nameFilter = needle ? `\n  FILTER(CONTAINS(LCASE(STR(?label)), "${sparqlString(needle)}"))` : "";
  return `SELECT ?item ?label ?coord (MAX(?depthM) AS ?depth) (MAX(?areaM2) AS ?area) (MAX(?elevM) AS ?elev) (MAX(?volM3) AS ?vol) (SAMPLE(?article) AS ?wp) (MAX(?res) AS ?isRes) WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  ?item wdt:P31/wdt:P279* wd:Q23397 .
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")${nameFilter}
  BIND(IF(EXISTS { ?item wdt:P31/wdt:P279* wd:Q131681 }, 1, 0) AS ?res)
  OPTIONAL { ?item p:P4511/psn:P4511/wikibase:quantityAmount ?depthM . }
  OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?areaM2 . }
  OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?elevM . }
  OPTIONAL { ?item p:P2234/psn:P2234/wikibase:quantityAmount ?volM3 . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
}
GROUP BY ?item ?label ?coord
ORDER BY DESC(?area) DESC(?depth)
LIMIT ${LIMIT}`;
}

/**
 * The wide-mode query (over 20,000 km²): the same lakes, name filter included, ranked by area alone with rows that have no
 * area last. The box query is kept because most lakes outside Europe have no area in Wikidata (14 of about 1,400 in a
 * Minnesota box), so starting from the items that have one would drop nearly all of them.
 */
export function wideLakesQuery(bbox: BBox, limit: number, name?: string): string {
  return rankedSparql(lakesQuery(bbox, name), limit + WIDE_SLACK, "area");
}

const valueSchema = z.object({ value: z.string() });
const responseSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: valueSchema,
        label: valueSchema.optional(),
        coord: valueSchema,
        depth: valueSchema.optional(),
        area: valueSchema.optional(),
        elev: valueSchema.optional(),
        vol: valueSchema.optional(),
        wp: valueSchema.optional(),
        isRes: valueSchema.optional(),
      }),
    ),
  }),
});

export type Binding = z.infer<typeof responseSchema>["results"]["bindings"][number];

/** "Point(-119.9 38.8575)" -> [-119.9, 38.8575]. */
function parseWkt(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/** A positive number rounded to `places` decimals, or undefined. */
function positive(value: string | undefined, scale: number, places: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value) / scale;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return r > 0 ? r : undefined;
}

/** Lakes and reservoirs as points; v is the maximum depth in metres, or null when Wikidata has none. Unnamed items and repeats are dropped. */
export function normalizeLakes(bindings: Binding[]): Feature<Point>[] {
  const features: Feature<Point>[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const id = b.item.value.split("/").pop() ?? b.item.value;
    const name = b.label?.value.trim();
    if (!name || name === id || seen.has(id)) continue;
    const coords = parseWkt(b.coord.value);
    if (coords === null) continue;
    seen.add(id);

    const depthM = positive(b.depth?.value, 1, 1);
    const properties: Record<string, string | number | null> = {
      name,
      v: depthM ?? null,
      depthM: depthM ?? null,
      kind: b.isRes?.value === "1" || b.isRes?.value === "true" ? "reservoir" : "lake",
    };
    const area = positive(b.area?.value, 1_000_000, 2);
    const elevation = positive(b.elev?.value, 1, 1);
    const volume = positive(b.vol?.value, 1_000_000_000, 3);
    if (area !== undefined) properties.areaKm2 = area;
    if (elevation !== undefined) properties.elevationM = elevation;
    if (volume !== undefined) properties.volumeKm3 = volume;
    if (b.wp) properties.wikipedia = b.wp.value;
    properties.wikidata = id;
    properties.url = `https://www.wikidata.org/wiki/${id}`;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties });
  }
  return features;
}

const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "category",
    label: "Kind",
    levels: [
      { value: "lake", label: "Lake" },
      { value: "reservoir", label: "Reservoir" },
    ],
  },
  { key: "depthM", type: "measure", label: "Depth", unit: "m", encode: "size" },
  nameAttribute(),
];

const DEPTH: FieldHelp = {
  text: "The lake's maximum depth as entered in Wikidata (property P4511); not survey-checked, and empty means not recorded, not shallow.",
  unit: "m",
  source: "Wikidata",
  url: "https://www.wikidata.org/wiki/Property:P4511",
};

const HELP: Record<string, FieldHelp> = {
  depthM: DEPTH,
  v: DEPTH,
  areaKm2: { text: "Surface area from Wikidata (P2046).", unit: "km²", url: "https://www.wikidata.org/wiki/Property:P2046" },
  elevationM: {
    text: "Height of the water surface above sea level, from Wikidata (P2044).",
    unit: "m",
    url: "https://www.wikidata.org/wiki/Property:P2044",
  },
  volumeKm3: { text: "Volume of water from Wikidata (P2234).", unit: "km³", url: "https://www.wikidata.org/wiki/Property:P2234" },
  kind: { text: "reservoir when Wikidata says the lake is a reservoir, otherwise lake." },
};

const CARD: CardSpec = {
  measure: { key: "depthM", label: "Maximum depth", unit: "m" },
  facts: [
    { key: "kind", label: "Kind", values: { lake: "Lake", reservoir: "Reservoir" } },
    { key: "areaKm2", label: "Area", unit: "km²" },
    { key: "elevationM", label: "Surface elevation", format: "m" },
    { key: "volumeKm3", label: "Volume", unit: "km³" },
  ],
  links: [
    { key: "wikipedia", label: "Wikipedia" },
    { key: "url", label: "Wikidata" },
  ],
};

const lakes = defineLayer({
  id: "lakes",
  title: "Lakes and reservoirs",
  description:
    "Named lakes, tarns and reservoirs from Wikidata, with maximum depth. Each point has name, kind ('lake' or 'reservoir'), v and depthM (the maximum depth in metres, or null when unknown), " +
    "areaKm2 (surface area in square kilometres), elevationM (surface height above sea level in metres), volumeKm3 (cubic kilometres), and wikipedia (English article link) plus wikidata and url where they exist. " +
    "Use it for 'how deep is this lake', 'how deep is Lake Tahoe', 'deepest lakes here', 'biggest lake in this area', 'what is that lake called', 'is this a reservoir', or 'highest alpine lakes'. " +
    "Set the name input (case-insensitive, matches part of the name) to find one lake in a big view, for example name 'tahoe'. " +
    "Caveats: depth is missing for most small lakes, tarns and reservoirs, so a null depth means 'not recorded', not 'shallow'; check the nulls before ranking, and say so when the lake asked about has none. " +
    "Depth is the maximum, not the average, as entered by Wikidata editors and not survey-checked; area, elevation and volume are also often missing. " +
    "Many small lakes have no Wikidata entry, and unnamed items are left out. At most 500 lakes are returned, largest by area first. " +
    "Works worldwide. Over 20,000 km² (about a 140 km square) it returns the 1,000 largest by area.",
  coverage: "global",
  surface: "any",
  license: "CC0 (Wikidata)",
  requiredEnv: [],
  maxAreaKm2: 20_000,
  wide: { orderBy: "area", limit: WIDE_LIMIT },
  input: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Only lakes whose English name contains this text, case-insensitive (for example 'tahoe')."),
  }),
  style: { geometry: "point", color: layerColor("lakes"), unit: "m", cluster: true },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    // Wide (over 20,000 km², up to the hard cap): the largest lakes by area, capped at the strategy's limit.
    const wideLimit = ctx.wide ? Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined;
    const query = wideLimit === undefined ? lakesQuery(ctx.bbox, input.name) : wideLakesQuery(ctx.bbox, wideLimit, input.name);

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
        error: timedOut
          ? `Wikidata timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again`
          : "Wikidata returned no response",
        hint: "upstream",
      };
    }
    if (res.status === 429) return { error: "Wikidata is rate-limiting requests; try again in a minute", hint: "upstream" };
    if (!res.ok) return { error: `Wikidata returned ${res.status}`, hint: "upstream" };

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { error: "Wikidata returned a response that is not JSON", hint: "upstream" };
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) return { error: "Wikidata returned an unexpected response", hint: "upstream" };

    const all = normalizeLakes(parsed.data.results.bindings);
    const features = wideLimit === undefined ? all : all.slice(0, wideLimit);
    const notes: string[] = [];
    // In wide mode run.ts writes the "showing the N largest" note.
    if (wideLimit === undefined && parsed.data.results.bindings.length >= LIMIT) {
      notes.push(`Showing the ${LIMIT} largest lakes by area; zoom in or ask for a lake by name for the rest`);
    }
    if (features.length === 0) {
      notes.push(input.name ? `No lake named like “${input.name}” in Wikidata for this area` : "No named lakes in Wikidata for this area");
    } else {
      const withDepth = features.filter((f) => typeof f.properties?.depthM === "number").length;
      notes.push(`${withDepth} of ${features.length} lakes have a recorded maximum depth`);
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: "Wikidata (CC0), lakes and reservoirs with coordinates, maximum depth (P4511), area (P2046), elevation (P2044) and volume (P2234)",
        url: "https://www.wikidata.org/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: notes.join("; "),
    };
  },
});

registerLayer(lakes);

export default lakes;

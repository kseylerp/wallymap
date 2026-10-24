/**
 * Named lakes, ponds and reservoirs from OpenStreetMap (where they are and how big) joined to Wikidata (depth, volume, elevation),
 * keyless.
 *
 * OpenStreetMap (through layers/_shared/overpass.ts, one Overpass query per call): named `natural=water` areas whose `water` tag
 * is lake, reservoir, pond, oxbow or lagoon, or absent (older lakes carry none); rivers, canals and basins are left out. Each
 * comes back with its tags and centre (`out tags center`). In views up to GEOMETRY_MAX_KM2 the same query also sends the shoreline
 * (`out ids geom` for ways, `out skel geom` for multipolygon relations), and the surface area is measured from it: rings are
 * assembled from the member ways, outer rings added and islands taken away, on a local flat projection (good to well under 1%
 * for a lake). Shorelines are heavy (a 9,000 km² Tahoe box was 3.1 MB in 6.6 s, a 16,000 km² Minnesota box 16 MB, 2026-10-18),
 * so wider views (up to the 20,000 km² wide threshold) ask for them in a second Overpass query of their own, alongside the
 * first: when it fails or times out the lakes are still listed, unmeasured, with a note. Before this (audit 2026-10-18) a
 * z9.5 Tahoe view listed 332 lakes with 2 areas (Wikidata's), so "Rank by Area" listed two and the rest drew faint.
 *
 * Wikidata: POST https://query.wikidata.org/sparql. The query finds items with coordinates (P625, `wikibase:box`) whose instance
 * of (P31, with subclasses) is lake (Q23397; reservoirs sit under it), flags reservoirs (Q131681), and reads maximum depth (P4511,
 * statements not qualified as an average, median or minimum), mean depth (P4511 qualified as an average: Crater Lake holds 594 m
 * and 350 m), area (P2046), elevation (P2044) and volume (P2234) through the normalised path `p:Pxxx/psn:Pxxx/wikibase:quantityAmount`
 * (metres, square metres, cubic metres), the English label and the English Wikipedia article. Ordered by area then depth, at most
 * 500. Requests go through `wikimediaFetch` (shared User-Agent, one retry after the advised wait). In the Tahoe box
 * (-120.25,38.93,-119.95,39.23) Wikidata held 5 lakes, 1 with a depth, where OSM held 51 named water bodies (audit 2026-10-17).
 *
 * The join (mergeLakes): an OSM lake whose `wikidata` tag names the item is that item; else the same name (case and a trailing
 * bracket ignored) within max(2 km, the lake's width) is. A joined lake sits at the OSM centre with the OSM area (Wikidata's when
 * none was measured), the Wikidata name, depth, volume, elevation (OSM `ele` when Wikidata has none) and links. Unjoined lakes from
 * either side are kept. When one source fails the other's lakes come back with a note and sourceStatus; when both fail, an error.
 * Live 2026-10-18 (through runLayer): Tahoe box 51 lakes in 2.0 s, all 5 Wikidata lakes joined, Lake Tahoe first at 191 mi² (495 km²),
 *   depth 1,644 ft; the audit's z9.5 view (-120.6,38.6,-119.6,39.5) 368 lakes in 2.5 s, unmeasured, 2 with a depth.
 *
 * A name asked in a box where Wikidata knows no lake of that name may be a namesake: the layer then asks Wikidata for lakes
 * of that exact label anywhere (lakesByNameQuery) and, when a larger one with a depth exists, its note says where it is. In
 * the 2026-10-23 eval "Lake Tahoe" geocoded to a 2-acre pond in Tillamook County, Oregon, and the answer said Tahoe had no
 * recorded depth; the layer was right about the pond, the box was wrong.
 *
 * Wide mode (over 20,000 km², up to 80,000 km²) runs wideLakesQuery on Wikidata alone: the 1,000 largest by area, no count.
 * Smoke wide 2026-10-14: Minnesota -94.4,45.4,-91,48 (about 70,000 km²) returned 1,000 lakes in 4.5 s (7 with depth).
 */
import { z } from "zod";
import type { Feature, Point, Position } from "geojson";
import {
  bboxAreaKm2,
  defineLayer,
  type Attribute,
  type BBox,
  type CardSpec,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type QueryContext,
  type SourceStatus,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { rankedSparql, wikimediaFetch } from "./_shared/wikimedia";
import { haversineKm } from "./_shared/geo";
import { overpassCounts, overpassQuery } from "./_shared/overpass";
import { bboxClause, metres as osmMetres } from "./_shared/osm-features";
import { heightText, matchName, usUnitsFirst } from "./peaks-units";
import { layerColor } from "@/lib/render/palette";

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
export const LIMIT = 500;
/** Most lakes a wide result (over 20,000 km²) carries, the largest by area. */
export const WIDE_LIMIT = 1_000;
/** Most named water bodies one Overpass answer carries (a 16,000 km² Minnesota box held 2,696, 2026-10-18). */
export const OSM_LIMIT = 2_000;
/** Views up to this size fetch shorelines in the lake query itself; wider views fetch them in a second query (osmLakeShapesQuery). */
export const GEOMETRY_MAX_KM2 = 4_000;
/** Extra rows a wide query asks for, so items repeated under two coordinates do not leave the result short of its limit. */
const WIDE_SLACK = 50;
/** Lakes do not move and Wikidata edits are slow-moving. */
const TTL_SECONDS = 7 * 86_400;
/** Overpass's own time limit for the lake query, under the client's 25 s. */
const OVERPASS_TIMEOUT_S = 20;

/* ---------- Wikidata ---------- */

/** A SPARQL string literal body: backslashes and quotes escaped, control characters dropped. */
function sparqlString(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Wikidata's qualifiers (P1013, criterion used) that make a depth statement (P4511) an average rather than the maximum:
 * "average" (Q202785, about 1,260 statements in 2026-10), "mean" (Q2796622), the other "average" (Q54835811) and
 * "arithmetic mean" (Q19033). Crater Lake carries both 594 m (maximum) and 350 m (average).
 */
export const MEAN_DEPTH_CRITERIA = ["wd:Q202785", "wd:Q2796622", "wd:Q54835811", "wd:Q19033"] as const;
/** Criteria that make a depth statement neither the maximum nor the mean: median and minimum. */
const OTHER_DEPTH_CRITERIA = ["wd:Q226995", "wd:Q10585806"] as const;

/** The measures every lake query reads: maximum and mean depth, area, elevation, volume, the article; deprecated depths left out. */
const MEASURES = `  BIND(IF(EXISTS { ?item wdt:P31/wdt:P279* wd:Q131681 }, 1, 0) AS ?res)
  OPTIONAL { ?item p:P4511 ?ds . ?ds psn:P4511/wikibase:quantityAmount ?depthM ; wikibase:rank ?dr . FILTER(?dr != wikibase:DeprecatedRank)
    FILTER NOT EXISTS { ?ds pq:P1013 ?dc . FILTER(?dc IN (${[...MEAN_DEPTH_CRITERIA, ...OTHER_DEPTH_CRITERIA].join(", ")})) } }
  OPTIONAL { ?item p:P4511 ?ms . ?ms pq:P1013 ?mc ; psn:P4511/wikibase:quantityAmount ?meanM . FILTER(?mc IN (${MEAN_DEPTH_CRITERIA.join(", ")})) }
  OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?areaM2 . }
  OPTIONAL { ?item p:P2044/psn:P2044/wikibase:quantityAmount ?elevM . }
  OPTIONAL { ?item p:P2234/psn:P2234/wikibase:quantityAmount ?volM3 . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }`;

const SELECT =
  "SELECT ?item ?label ?coord (MAX(?depthM) AS ?depth) (MAX(?meanM) AS ?mean) (MAX(?areaM2) AS ?area) (MAX(?elevM) AS ?elev) (MAX(?volM3) AS ?vol) (SAMPLE(?article) AS ?wp) (MAX(?res) AS ?isRes)";

/** The SPARQL text for a bbox and an optional case-insensitive name filter; `Point(lon lat)` corners are south-west then north-east. */
export function lakesQuery(bbox: BBox, name?: string): string {
  const [west, south, east, north] = bbox;
  const needle = name?.trim().toLowerCase();
  const nameFilter = needle ? `\n  FILTER(CONTAINS(LCASE(STR(?label)), "${sparqlString(needle)}"))` : "";
  return `${SELECT} WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  ?item wdt:P31/wdt:P279* wd:Q23397 .
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")${nameFilter}
${MEASURES}
}
GROUP BY ?item ?label ?coord
ORDER BY DESC(?area) DESC(?depth)
LIMIT ${LIMIT}`;
}

/** The ways a lake's name may be written as a Wikidata label: as typed, in title case, and with or without "Lake". */
export function nameVariants(name: string): string[] {
  const typed = name.trim().replace(/\s+/g, " ");
  if (!typed) return [];
  const title = typed.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  const bare = title.replace(/^lake\s+|\s+lake$/i, "");
  const more = bare === title ? [`Lake ${title}`, `${title} Lake`] : [bare];
  return [...new Set([typed, title, ...more])];
}

/**
 * Lakes anywhere whose English label is the asked name (nameVariants), largest first. When a named box holds no
 * Wikidata lake of that name, the one meant may be elsewhere: a geocoder sent "Lake Tahoe" to a 2-acre pond of that
 * name in Tillamook County, Oregon (2026-10-23), and the answer said Tahoe had no recorded depth.
 */
export function lakesByNameQuery(name: string): string {
  const labels = nameVariants(name)
    .map((n) => `"${sparqlString(n)}"@en`)
    .join(" ");
  return `${SELECT} WHERE {
  VALUES ?label { ${labels} }
  ?item rdfs:label ?label .
  ?item wdt:P31/wdt:P279* wd:Q23397 .
  ?item wdt:P625 ?coord .
${MEASURES}
}
GROUP BY ?item ?label ?coord
ORDER BY DESC(?area) DESC(?depth)
LIMIT 5`;
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
        mean: valueSchema.optional(),
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

/** "Eagle Lake (Desolation Wilderness)" -> "Eagle Lake": the bracket tells Wikidata items apart, it is not part of the name. */
function plainName(name: string): string {
  return name.replace(/\s*\([^)]*\)$/, "") || name;
}

/**
 * Wikidata lakes and reservoirs as points with their raw measures (depthM, areaKm2, elevationM, volumeKm3), kind and links.
 * Unnamed items and repeats are dropped. mergeLakes adds the plain-word fields.
 */
export function normalizeLakes(bindings: Binding[]): Feature<Point>[] {
  const features: Feature<Point>[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const id = b.item.value.split("/").pop() ?? b.item.value;
    const label = b.label?.value.trim();
    if (!label || label === id || seen.has(id)) continue;
    const coords = parseWkt(b.coord.value);
    if (coords === null) continue;
    seen.add(id);

    const properties: Record<string, string | number> = {
      name: plainName(label),
      kind: b.isRes?.value === "1" || b.isRes?.value === "true" ? "reservoir" : "lake",
    };
    const depth = positive(b.depth?.value, 1, 1);
    const mean = positive(b.mean?.value, 1, 1);
    const area = positive(b.area?.value, 1_000_000, 3);
    const elevation = positive(b.elev?.value, 1, 1);
    const volume = positive(b.vol?.value, 1_000_000_000, 6);
    if (depth !== undefined) properties.depthM = depth;
    // A mean as deep as the maximum is a data-entry slip; it is left out rather than printed.
    if (mean !== undefined && (depth === undefined || mean < depth)) properties.meanDepthM = mean;
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

/* ---------- OpenStreetMap ---------- */

/** The `water` values kept: standing water. Rivers, canals, basins and the like are not lakes. */
export const LAKE_WATER = ["lake", "reservoir", "pond", "oxbow", "lagoon"] as const;

/** A name filter for Overpass: regex characters read as "any character", so the text matches as typed, case-insensitive. */
function overpassNameFilter(name: string | undefined): string {
  const needle = name?.trim();
  if (!needle) return "";
  return `["name"~"${needle.replace(/[\\"^$.*+?()[\]{}|]/g, ".")}",i]`;
}

/**
 * Overpass QL for the named lakes in a box: how many there are, their tags and centres, and with `geometry` their shorelines
 * (ways as rings, relations as member ways with roles) for measuring area.
 */
export function osmLakesQuery(bbox: BBox, opts: { name?: string; geometry: boolean }): string {
  const box = bboxClause(bbox);
  const named = `["name"]${overpassNameFilter(opts.name)}`;
  const find =
    `(nwr["natural"="water"]${named}[!"water"]${box};` +
    `nwr["natural"="water"]${named}["water"~"^(${LAKE_WATER.join("|")})$"]${box};)->.l;`;
  const shapes = opts.geometry ? `way.l->.w;.w out ids geom ${OSM_LIMIT};rel.l->.r;.r out skel geom ${OSM_LIMIT};` : "";
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];${find}.l out count;.l out tags center ${OSM_LIMIT};${shapes}`;
}

/**
 * Overpass QL for the shorelines alone (no tags, no count) of the same named lakes, for views over GEOMETRY_MAX_KM2: a
 * separate query, so a slow or failed shoreline download never costs the lake list.
 */
export function osmLakeShapesQuery(bbox: BBox, name?: string): string {
  const full = osmLakesQuery(bbox, { name, geometry: true });
  const find = full.slice(full.indexOf("("), full.indexOf(".l out count;"));
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];${find}way.l->.w;.w out ids geom ${OSM_LIMIT};rel.l->.r;.r out skel geom ${OSM_LIMIT};`;
}

type LatLon = { lat: number; lon: number };

const latLon = z.object({ lat: z.number(), lon: z.number() });
const taggedSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: latLon.optional(),
  tags: z.record(z.string(), z.string()),
});
const wayShapeSchema = z.object({ type: z.literal("way"), id: z.number(), geometry: z.array(latLon) });
const relationShapeSchema = z.object({
  type: z.literal("relation"),
  id: z.number(),
  members: z.array(z.object({ type: z.string(), role: z.string().optional(), geometry: z.array(latLon).optional() })),
});

/** An OSM lake before the join. */
export type OsmLake = {
  type: "node" | "way" | "relation";
  id: number;
  name: string;
  kind: string;
  center: [number, number];
  /** Measured from the shoreline, when it was fetched. */
  areaKm2?: number;
  elevationM?: number;
  wikidata?: string;
};

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/** Closed rings from way pieces joined end to end (a lake's outline is often split over several ways); open leftovers are dropped. */
export function assembleRings(pieces: LatLon[][]): LatLon[][] {
  const open = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: LatLon[][] = [];
  while (open.length > 0) {
    let ring = open.pop() as LatLon[];
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        if (same(p[0], end)) ring = ring.concat(p.slice(1));
        else if (same(p[p.length - 1], end)) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

/** The area inside a closed ring in km², on a flat projection about the ring's mean latitude. */
export function ringAreaKm2(ring: LatLon[]): number {
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  const o = ring[0];
  let twice = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    twice += (a.lon - o.lon) * kx * ((b.lat - o.lat) * ky) - (b.lon - o.lon) * kx * ((a.lat - o.lat) * ky);
  }
  return Math.abs(twice) / 2;
}

/** A lake's area in km² from its shoreline: outer rings minus inner rings (islands); undefined when no outer ring closes. */
export function shapeAreaKm2(members: { role?: string; geometry?: LatLon[] }[]): number | undefined {
  const outer = assembleRings(members.filter((m) => m.role !== "inner").map((m) => m.geometry ?? []));
  if (outer.length === 0) return undefined;
  const inner = assembleRings(members.filter((m) => m.role === "inner").map((m) => m.geometry ?? []));
  const km2 = outer.reduce((s, r) => s + ringAreaKm2(r), 0) - inner.reduce((s, r) => s + ringAreaKm2(r), 0);
  return km2 > 0 ? km2 : undefined;
}

/** Rounds an area to three significant figures, at least 0.001 km² (a quarter acre). */
function roundArea(km2: number): number {
  const r = Number(km2.toPrecision(3));
  return Math.max(0.001, r);
}

/** The named lakes in an Overpass body, with areas measured from any shorelines it holds. */
export function parseOsmLakes(json: unknown): OsmLake[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) return [];
  const areas = new Map<string, number>();
  for (const raw of elements) {
    const way = wayShapeSchema.safeParse(raw);
    if (way.success) {
      const km2 = shapeAreaKm2([{ role: "outer", geometry: way.data.geometry }]);
      if (km2 !== undefined) areas.set(`way/${way.data.id}`, km2);
      continue;
    }
    const rel = relationShapeSchema.safeParse(raw);
    if (rel.success) {
      const km2 = shapeAreaKm2(rel.data.members.filter((m) => m.type === "way"));
      if (km2 !== undefined) areas.set(`relation/${rel.data.id}`, km2);
    }
  }
  const lakes: OsmLake[] = [];
  const seen = new Set<string>();
  for (const raw of elements) {
    const el = taggedSchema.safeParse(raw);
    if (!el.success) continue;
    const { type, id, tags } = el.data;
    const key = `${type}/${id}`;
    if (seen.has(key)) continue;
    const name = (tags["name:en"] ?? tags.name)?.trim();
    const pos = el.data.center ?? (el.data.lat !== undefined && el.data.lon !== undefined ? { lat: el.data.lat, lon: el.data.lon } : undefined);
    if (!name || !pos) continue;
    seen.add(key);
    const water = tags.water;
    const kind = water && (LAKE_WATER as readonly string[]).includes(water) ? water : "lake";
    const area = areas.get(key);
    const ele = osmMetres(tags.ele?.split(";")[0]);
    const wikidata = /^Q\d+$/.test(tags.wikidata ?? "") ? tags.wikidata : undefined;
    lakes.push({
      type,
      id,
      name,
      kind,
      center: [pos.lon, pos.lat],
      ...(area !== undefined && { areaKm2: roundArea(area) }),
      ...(ele !== undefined && ele > -500 && ele < 7_000 && { elevationM: Math.round(ele * 10) / 10 }),
      ...(wikidata !== undefined && { wikidata }),
    });
  }
  return lakes;
}

/* ---------- Units and words ---------- */

const ACRES_PER_KM2 = 247.105;
const KM2_PER_MI2 = 2.589988;
const ACRE_FEET_PER_KM3 = 810_713.19;

/** A number for reading: whole from 100 up, one decimal from 1, two significant figures below. */
function readable(n: number): string {
  if (n >= 100) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return (Math.round(n * 10) / 10).toLocaleString("en-US");
  return String(Number(n.toPrecision(2)));
}

/** "191 mi² (496 km²)" or "62 acres (0.25 km²)" in the US; "496 km² (191 mi²)" or "0.25 km² (62 acres)" elsewhere. */
export function areaText(km2: number, usFirst: boolean): string {
  const mi2 = km2 / KM2_PER_MI2;
  const acres = km2 * ACRES_PER_KM2;
  const us = mi2 >= 1 ? `${readable(mi2)} mi²` : `${readable(acres >= 10 ? Math.round(acres) : acres)} acres`;
  const metric = `${readable(km2)} km²`;
  return usFirst ? `${us} (${metric})` : `${metric} (${us})`;
}

/** "122 million acre-feet (150 km³)" in the US; "150 km³ (122 million acre-feet)" elsewhere; small ones in million m³. */
export function volumeText(km3: number, usFirst: boolean): string {
  const af = km3 * ACRE_FEET_PER_KM3;
  const us = af >= 1_000_000 ? `${readable(af / 1_000_000)} million acre-feet` : `${readable(af)} acre-feet`;
  const metric = km3 >= 1 ? `${readable(km3)} km³` : `${readable(km3 * 1_000)} million m³`;
  return usFirst ? `${us} (${metric})` : `${metric} (${us})`;
}

/* ---------- Join ---------- */

/** Two listings of one name closer than this (or than the lake's width, when that is more) are one lake. */
export const JOIN_KM = 2;

const lakeKey = (name: string) => matchName(plainName(name));

/** Added to a depth in `labelRank`, so lakes with a depth are named before any lake ranked only by area (no lake is 10 million km²). */
export const LABEL_DEPTH_FIRST = 10_000_000;

/** A depth for a map label: "1,644 ft" in the US, "501 m" elsewhere. */
function depthWords(m: number, usFirst: boolean): string {
  return usFirst ? `${Math.round(m * 3.28084).toLocaleString("en-US")} ft` : `${Math.round(m).toLocaleString("en-US")} m`;
}

/** The plain-word fields every lake carries, in the view's units. */
function finish(p: Record<string, string | number | null>, usFirst: boolean): Record<string, string | number | null> {
  const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
  const area = num("areaKm2");
  const depth = num("depthM");
  const elevation = num("elevationM");
  const volume = num("volumeKm3");
  const mean = num("meanDepthM");
  p.v = area ?? null;
  if (area !== undefined) p.areaText = areaText(area, usFirst);
  p.depthText = depth !== undefined ? heightText(depth, usFirst) : "Not recorded";
  if (mean !== undefined) p.meanDepthText = heightText(mean, usFirst);
  // The map names the deepest lakes with their depth first, then the largest (LABEL_DEPTH_FIRST keeps every depth above any area).
  const name = typeof p.name === "string" ? p.name : undefined;
  if (name) p.label = depth !== undefined ? `${name}, ${depthWords(depth, usFirst)} deep` : name;
  p.labelRank = depth !== undefined ? LABEL_DEPTH_FIRST + depth : (area ?? 0);
  if (elevation !== undefined) p.elevationText = heightText(elevation, usFirst);
  if (volume !== undefined) p.volumeText = volumeText(volume, usFirst);
  return p;
}

/**
 * Wikidata lakes and OSM lakes as one list, largest first (lakes with no area last). A pair is one lake when the OSM `wikidata`
 * tag names the item, else when the names match within max(JOIN_KM, the lake's width). The joined lake sits at the OSM centre
 * with the measured area (Wikidata's when none was measured), the Wikidata name, depth, volume and elevation (OSM `ele` when
 * Wikidata has none) and its links; it is a reservoir when either source says so.
 */
export function mergeLakes(wikidata: Feature<Point>[], osm: OsmLake[], usFirst: boolean): Feature<Point>[] {
  const byQ = new Map<string, OsmLake>();
  for (const l of osm) if (l.wikidata && !byQ.has(l.wikidata)) byQ.set(l.wikidata, l);
  const used = new Set<OsmLake>();
  const out: Feature<Point>[] = [];
  const osmUrl = (l: OsmLake) => `https://www.openstreetmap.org/${l.type}/${l.id}`;

  for (const w of wikidata) {
    const wp = (w.properties ?? {}) as Record<string, string | number>;
    const q = String(wp.wikidata);
    let match = byQ.get(q);
    if (match && used.has(match)) match = undefined;
    if (!match) {
      const key = lakeKey(String(wp.name));
      let best: { l: OsmLake; d: number } | undefined;
      for (const l of osm) {
        if (used.has(l) || (l.wikidata && l.wikidata !== q) || lakeKey(l.name) !== key) continue;
        const area = l.areaKm2 ?? (typeof wp.areaKm2 === "number" ? wp.areaKm2 : 0);
        const d = haversineKm(l.center, w.geometry.coordinates);
        if (d <= Math.max(JOIN_KM, Math.sqrt(area)) && (!best || d < best.d)) best = { l, d };
      }
      match = best?.l;
    }
    const p: Record<string, string | number | null> = { ...wp };
    let coords: Position = w.geometry.coordinates;
    if (match) {
      used.add(match);
      coords = match.center;
      if (wp.kind !== "reservoir") p.kind = match.kind;
      if (match.areaKm2 !== undefined) {
        p.areaKm2 = match.areaKm2;
        p.areaSource = "osm";
      } else if (typeof wp.areaKm2 === "number") p.areaSource = "wikidata";
      if (p.elevationM === undefined && match.elevationM !== undefined) p.elevationM = match.elevationM;
      p.sources = "both";
      p.osmUrl = osmUrl(match);
    } else {
      if (typeof wp.areaKm2 === "number") p.areaSource = "wikidata";
      p.sources = "wikidata";
    }
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: finish(p, usFirst) });
  }

  for (const l of osm) {
    if (used.has(l)) continue;
    const p: Record<string, string | number | null> = { name: l.name, kind: l.kind };
    if (l.areaKm2 !== undefined) {
      p.areaKm2 = l.areaKm2;
      p.areaSource = "osm";
    }
    if (l.elevationM !== undefined) p.elevationM = l.elevationM;
    p.sources = "osm";
    p.osmUrl = osmUrl(l);
    if (l.wikidata) {
      p.wikidata = l.wikidata;
      p.url = `https://www.wikidata.org/wiki/${l.wikidata}`;
    }
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: l.center }, properties: finish(p, usFirst) });
  }

  const area = (f: Feature) => (typeof f.properties?.areaKm2 === "number" ? f.properties.areaKm2 : -Infinity);
  const depth = (f: Feature) => (typeof f.properties?.depthM === "number" ? f.properties.depthM : -Infinity);
  return out.sort((a, b) => area(b) - area(a) || depth(b) - depth(a));
}

/* ---------- Layer ---------- */

const KIND_LEVELS = [
  { value: "lake", label: "Lake", help: "A natural body of standing water (OSM water=lake, or a water area with no water tag)." },
  { value: "reservoir", label: "Reservoir", help: "Water held back by a dam or embankment." },
  { value: "pond", label: "Pond", help: "A small body of standing water, natural or dug." },
  { value: "oxbow", label: "Oxbow lake", help: "A curved lake left where a river cut off one of its bends." },
  { value: "lagoon", label: "Lagoon", help: "Shallow water cut off from the sea or a larger lake by a bar, reef or spit." },
];

const KIND_WORDS: Record<string, string> = {
  lake: "Lake (natural standing water)",
  reservoir: "Reservoir (water held back by a dam)",
  pond: "Pond (small standing water)",
  oxbow: "Oxbow lake (a cut-off river bend)",
  lagoon: "Lagoon (cut off by a bar or reef)",
};

const ATTRIBUTES: Attribute[] = [
  { key: "areaKm2", type: "measure", label: "Area", unit: "km²", encode: "size" },
  { key: "depthM", type: "measure", label: "Maximum depth", unit: "m" },
  { key: "meanDepthM", type: "measure", label: "Mean depth", unit: "m" },
  { key: "kind", type: "category", label: "Kind", levels: KIND_LEVELS },
  nameAttribute(),
];

const DEPTH: FieldHelp = {
  text: "The lake's maximum depth as entered in Wikidata (property P4511); not survey-checked. Most lakes have none recorded, which means unknown, not shallow.",
  unit: "m",
  source: "Wikidata",
  url: "https://www.wikidata.org/wiki/Property:P4511",
};

const MEAN_DEPTH: FieldHelp = {
  text: "The lake's average depth as entered in Wikidata (property P4511 marked as an average); few lakes have one.",
  unit: "m",
  source: "Wikidata",
  url: "https://www.wikidata.org/wiki/Property:P4511",
};

const AREA: FieldHelp = {
  text:
    "Surface area, measured from the OpenStreetMap shoreline (islands taken out) in views up to 20,000 km², else from Wikidata (P2046) " +
    "where it has one. Reservoirs' shorelines are mapped at one water level.",
  unit: "km²",
  source: "OpenStreetMap, Wikidata",
  url: "https://wiki.openstreetmap.org/wiki/Tag:natural%3Dwater",
};

const ELEVATION: FieldHelp = {
  text: "Height of the water surface above sea level, from Wikidata (P2044), else the OpenStreetMap `ele` tag.",
  unit: "m",
  url: "https://www.wikidata.org/wiki/Property:P2044",
};

const VOLUME: FieldHelp = { text: "Volume of water from Wikidata (P2234).", unit: "km³", url: "https://www.wikidata.org/wiki/Property:P2234" };

const HELP: Record<string, FieldHelp> = {
  depthM: DEPTH,
  depthText: DEPTH,
  meanDepthM: MEAN_DEPTH,
  meanDepthText: MEAN_DEPTH,
  areaKm2: AREA,
  areaText: AREA,
  v: AREA,
  elevationM: ELEVATION,
  elevationText: ELEVATION,
  volumeKm3: VOLUME,
  volumeText: VOLUME,
  kind: { text: "What kind of water body it is, from the OpenStreetMap water tag, or reservoir when Wikidata says so." },
};

const SOURCES: Record<string, string> = { both: "OpenStreetMap and Wikidata", osm: "OpenStreetMap", wikidata: "Wikidata" };

const CARD: CardSpec = {
  measure: { key: "depthText", label: "Maximum depth" },
  facts: [
    { key: "kind", label: "Kind", values: KIND_WORDS },
    { key: "areaText", label: "Area" },
    { key: "meanDepthText", label: "Mean depth" },
    { key: "elevationText", label: "Surface elevation" },
    { key: "volumeText", label: "Volume" },
    { key: "areaSource", label: "Area from", values: { osm: "OpenStreetMap shoreline", wikidata: "Wikidata" } },
    { key: "sources", label: "Listed in", values: SOURCES },
  ],
  links: [
    { key: "wikipedia", label: "Wikipedia" },
    { key: "url", label: "Wikidata" },
    { key: "osmUrl", label: "OpenStreetMap" },
  ],
  hidden: ["areaKm2", "depthM", "meanDepthM", "elevationM", "volumeKm3", "v", "wikidata", "label", "labelRank"],
};

/** One source's failure as a SourceStatus, so the row says which source did not answer and what the map holds instead. */
function sourceFailure(error: string, message: string, status?: number): SourceStatus {
  return {
    ok: false,
    reason: status === 429 || /rate-limiting/i.test(error) ? "rate-limited" : /timed out|no response/i.test(error) ? "offline" : "server-error",
    message,
  };
}

const lakes = defineLayer({
  id: "lakes",
  title: "Lakes and reservoirs",
  description:
    "Named lakes, ponds and reservoirs from OpenStreetMap, joined to Wikidata for depth, volume and elevation. Each point has name, kind " +
    "('lake', 'reservoir', 'pond', 'oxbow' or 'lagoon'), areaKm2 (surface area in km², measured from the OpenStreetMap shoreline in views up to 20,000 km², " +
    "else Wikidata's figure, else null) with areaText in words, v (the same area, or null), depthM (maximum depth in metres, or absent when not recorded) with depthText " +
    "('Not recorded' when missing), meanDepthM (average depth, where Wikidata has one) with meanDepthText, elevationM (surface elevation) and volumeKm3 with text forms " +
    "(feet, acres, square miles and acre-feet first in the United States), sources ('both', 'osm' or 'wikidata'), and links wikipedia, url (Wikidata) and osmUrl. " +
    "Symbols are sized by area; up to five are named on the map, the deepest first with their depth. " +
    "Use it for 'how deep is Lake Tahoe', 'compare the depth of two lakes', 'biggest lakes here', 'deepest lakes here', 'what is that lake called', 'is this a reservoir', or 'highest alpine lakes'. " +
    "To compare two lakes, query each in its own geocoded box with the name input and quote both maximum depths. " +
    "Set the name input (case-insensitive, part of the name) to find one lake in a big view, for example name 'tahoe'. " +
    "If the coverageNote says Wikidata lists a larger lake of that name elsewhere, the box is the wrong place: geocode the lake again with its state or country (\"Lake Tahoe, California\") and query again; never report that lake's depth as not recorded. " +
    "For the shape of the lake bed (bathymetry, contours, the deepest point) use water-depth where it has coverage (US coasts, the Great Lakes, oceans). " +
    "Caveats: depth is missing for most lakes, so a missing depth means 'not recorded', not 'shallow'; say so when the lake asked about has none, and check before ranking by depth. " +
    "Depth is the maximum, not the average, as entered by Wikidata editors. Unnamed water is left out. " +
    "Works worldwide. Over 20,000 km² (about a 140 km square) it returns only Wikidata lakes, the 1,000 largest by area.",
  coverage: "global",
  surface: "any",
  license: "ODbL (OpenStreetMap contributors); CC0 (Wikidata)",
  requiredEnv: [],
  optionalEnv: ["OVERPASS_URL"],
  maxAreaKm2: 20_000,
  wide: { orderBy: "area", limit: WIDE_LIMIT },
  input: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Only lakes whose name contains this text, case-insensitive (for example 'tahoe')."),
  }),
  style: { geometry: "point", color: layerColor("lakes"), unit: "km²", cluster: true, encode: { size: "areaKm2" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  legend: {
    kind: "size",
    title: "Surface area",
    field: "areaKm2",
    unit: "km²",
    stops: [{ label: "Smaller lake" }, { label: "Larger lake" }],
    note: "Symbols grow with surface area. Up to five lakes are named: the deepest first, with their maximum depth, then the largest. Areas are measured from shorelines in views up to 20,000 km²; a lake with no area is not sized.",
  },
  labels: { field: "label", max: 5, rankBy: "labelRank" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    // Wide (over 20,000 km², up to the hard cap): the largest lakes from Wikidata alone, capped at the strategy's limit.
    const wideLimit = ctx.wide ? Math.min(WIDE_LIMIT, ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined;
    const query = wideLimit === undefined ? lakesQuery(ctx.bbox, input.name) : wideLakesQuery(ctx.bbox, wideLimit, input.name);
    const usFirst = usUnitsFirst(ctx.bbox);
    const measure = bboxAreaKm2(ctx.bbox) <= GEOMETRY_MAX_KM2;

    // Over GEOMETRY_MAX_KM2 the shorelines come in their own query, so every lake can still be measured and ranked by area.
    const [wd, osm, shapes] = await Promise.all([
      fetchWikidata(ctx, query),
      wideLimit === undefined ? overpassQuery(ctx, osmLakesQuery(ctx.bbox, { name: input.name, geometry: measure })) : Promise.resolve(null),
      wideLimit === undefined && !measure ? overpassQuery(ctx, osmLakeShapesQuery(ctx.bbox, input.name)) : Promise.resolve(null),
    ]);
    const osmOk = osm?.ok === true;
    if ("error" in wd && !osmOk) return wd;

    const notes: string[] = [];
    let wikidataLakes: Feature<Point>[] = [];
    let sourceStatus: SourceStatus | undefined;
    if ("bindings" in wd) {
      const all = normalizeLakes(wd.bindings);
      wikidataLakes = wideLimit === undefined ? all : all.slice(0, wideLimit);
      // In wide mode run.ts writes the "showing the N largest" note.
      if (wideLimit === undefined && wd.bindings.length >= LIMIT) notes.push(`Wikidata sent its ${LIMIT} largest lakes here; zoom in for the rest`);
    } else {
      notes.push(`Wikidata did not answer (${wd.error}), so no depths, volumes or Wikipedia links`);
      sourceStatus = sourceFailure(wd.error, `Wikidata did not answer (${wd.error}); lakes are from OpenStreetMap only, without depths.`);
    }

    let osmLakes: OsmLake[] = [];
    if (osm?.ok) {
      const shapeElements = shapes?.ok ? elementsOf(shapes.json) : [];
      osmLakes = parseOsmLakes(shapeElements.length > 0 ? { elements: [...elementsOf(osm.json), ...shapeElements] } : osm.json);
      const [total] = overpassCounts(osm.json);
      if (total !== undefined && total > OSM_LIMIT) notes.push(`OpenStreetMap sent ${OSM_LIMIT.toLocaleString("en-US")} of its ${total.toLocaleString("en-US")} named lakes here; zoom in for the rest`);
      if (shapes && !shapes.ok) notes.push(`the shorelines did not come back (${shapes.error}), so areas are Wikidata's only; zoom in under ${GEOMETRY_MAX_KM2.toLocaleString("en-US")} km² to size every lake`);
      sourceStatus ??= { ok: true };
    } else if (osm && !osm.ok) {
      notes.push(`OpenStreetMap did not answer (${osm.error}), so only lakes listed in Wikidata are shown`);
      sourceStatus = sourceFailure(osm.error, `OpenStreetMap (Overpass) did not answer (${osm.error}); lakes are from Wikidata only.`, osm.status);
    }
    if (wideLimit !== undefined) notes.push("only lakes listed in Wikidata are shown at this scale");

    const features = mergeLakes(wikidataLakes, osmLakes, usFirst);
    if (features.length === 0) {
      notes.push(input.name ? `No lake named like “${input.name}” in this area` : "No named lakes in this area");
    } else {
      const withDepth = features.filter((f) => typeof f.properties?.depthM === "number").length;
      notes.push(`${withDepth} of ${features.length} lakes have a recorded maximum depth`);
    }
    // A named lake Wikidata does not know here may be a namesake: say where the well-known one is.
    if (input.name && wideLimit === undefined && "bindings" in wd && wikidataLakes.length === 0) {
      const elsewhere = await lakeElsewhere(ctx, input.name, features);
      if (elsewhere) {
        const [lon, lat] = elsewhere.geometry.coordinates;
        notes.push(elsewhereNote(elsewhere, usUnitsFirst([lon, lat, lon, lat])));
      }
    }

    const cited = [
      ...(osm?.ok ? ["OpenStreetMap contributors (ODbL), named natural=water lakes, ponds and reservoirs"] : []),
      ...("bindings" in wd ? ["Wikidata (CC0), lakes with maximum depth (P4511), area (P2046), elevation (P2044) and volume (P2234)"] : []),
    ];
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: cited.join("; "),
        url: osm?.ok ? "https://www.openstreetmap.org/copyright" : "https://www.wikidata.org/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: notes.join("; "),
      ...(sourceStatus ? { sourceStatus } : {}),
    };
  },
});

/**
 * The largest Wikidata lake named `name` outside this box, when it is larger than every lake found here (or none here
 * has an area) and has a depth or an area worth pointing to; else null. A failed lookup is null: the answer stands.
 */
export async function lakeElsewhere(ctx: QueryContext, name: string, found: Feature<Point>[]): Promise<Feature<Point> | null> {
  // Its own cache entry: the box query's key would hand back the box's answer.
  const res = await fetchWikidata(ctx, lakesByNameQuery(name), ctx.cacheKey && `${ctx.cacheKey}:by-name`);
  if (!("bindings" in res)) return null;
  const [w, s, e, n] = ctx.bbox;
  const inBox = ([lon, lat]: Position) => lon >= w && lon <= e && lat >= s && lat <= n;
  const largestHere = Math.max(0, ...found.map((f) => (typeof f.properties?.areaKm2 === "number" ? f.properties.areaKm2 : 0)));
  const far = normalizeLakes(res.bindings).filter((f) => !inBox(f.geometry.coordinates));
  // Worth pointing to: a recorded depth or at least a square kilometre of water.
  const best = far.find((f) => typeof f.properties?.depthM === "number" || (typeof f.properties?.areaKm2 === "number" && f.properties.areaKm2 >= 1));
  if (!best) return null;
  const area = typeof best.properties?.areaKm2 === "number" ? best.properties.areaKm2 : undefined;
  if (area !== undefined && area <= largestHere) return null;
  return best;
}

/** "Wikidata lists a larger Lake Tahoe elsewhere, at 39.083, -120.033: maximum depth 1,644 ft (501 m), area ...". */
export function elsewhereNote(lake: Feature<Point>, usFirst: boolean): string {
  const p = (lake.properties ?? {}) as Record<string, string | number>;
  const [lon, lat] = lake.geometry.coordinates;
  const facts = [
    typeof p.depthM === "number" ? `maximum depth ${heightText(p.depthM, usFirst)}` : "no recorded depth",
    ...(typeof p.areaKm2 === "number" ? [`area ${areaText(p.areaKm2, usFirst)}`] : []),
  ];
  return (
    `Wikidata lists a larger ${p.name} elsewhere, at ${lat.toFixed(3)}, ${lon.toFixed(3)}: ${facts.join(", ")}. ` +
    `This box is not where that lake is: geocode ${p.name} again with its state or country and query it there`
  );
}

/** The elements array of an Overpass body, or none. */
function elementsOf(json: unknown): unknown[] {
  const elements = typeof json === "object" && json !== null ? (json as { elements?: unknown }).elements : undefined;
  return Array.isArray(elements) ? elements : [];
}

/** The Wikidata half: its rows, or an error in the layer's words. */
async function fetchWikidata(ctx: QueryContext, query: string, cacheKey = ctx.cacheKey): Promise<{ bindings: Binding[] } | LayerError> {
  let res: Response;
  try {
    res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ query }).toString(),
      cacheKey,
      ttlSeconds: TTL_SECONDS,
    });
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return {
      error: timedOut ? `Wikidata timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds; zoom in and try again` : "Wikidata returned no response",
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
  return { bindings: parsed.data.results.bindings };
}

registerLayer(lakes);

export default lakes;

/**
 * Named mountain peaks with elevation and prominence from Wikidata, keyless.
 *   POST https://query.wikidata.org/sparql   (form body `query=...`, Accept: application/sparql-results+json)
 * The query finds items with coordinates (P625, via the `wikibase:box` service) inside the bbox whose instance of (P31, with subclasses)
 * is mountain (Q8502), summit (Q207326) or volcano (Q8072), then reads elevation (P2044) and topographic prominence (P2660) through the
 * normalised-value path `p:P2044/psn:P2044/wikibase:quantityAmount`, which converts every source unit (feet included) to metres;
 * the plain `wdt:P2044` value is NOT normalised (Jobs Peak read 10638, which is feet). Items carry several prominence values with different
 * reference points, so the largest is kept (`MAX` with `GROUP BY`). `v` is the elevation; results are ordered by elevation, then prominence,
 * and capped at 1,000. The label service asks for English then the "mul" (any language) label; an item with neither falls back to its
 * native label (P1705) when it has one, and is dropped when it has no name at all.
 * Requests go through layers/_shared/wikimedia.ts (one User-Agent, one retry on 429 or 503). WDQS kills queries after 60 s.
 * Smoke check 2026-10-10 (live, keyless, through runLayer): Lake Tahoe box (-120.2,38.8,-119.8,39.2) returned 40 named peaks in 1.6 s,
 *   first Freel Peak (v = elevation 3,318 m, prominence 959 m). On 2026-10-09 a 1.8 degree Colorado box (about 33,000 km2) returned 821 peaks
 *   in 8.8 s, and Wikimedia answered 429 to queries made 10 s apart.
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { wikimediaFetch } from "./_shared/wikimedia";
import { layerColor } from "@/lib/render/palette";

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const LIMIT = 1_000;
/** Peaks do not move; Wikidata edits are slow-moving too. */
const TTL_SECONDS = 7 * 86_400;

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

/** "Point(-119.9 38.8575)" -> [-119.9, 38.8575]. */
function parseWkt(wkt: string): [number, number] | null {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function metres(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** Peaks as points: v is the elevation in metres, prominence is its own property. Items with no name in any form are dropped. */
export function normalizePeaks(bindings: Binding[]): Feature<Point>[] {
  const features: Feature<Point>[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const id = b.item.value.split("/").pop() ?? b.item.value;
    // With no English or "mul" label the label service answers with the Q-number, which is not a name; the native label is next best.
    const label = b.itemLabel?.value.trim();
    const name = label && label !== id ? label : b.native?.value.trim();
    if (!name || name === id || seen.has(id)) continue;
    const coords = parseWkt(b.coord.value);
    if (coords === null) continue;
    seen.add(id);

    const elevation = metres(b.elev?.value);
    const prominence = metres(b.prom?.value);
    const properties: Record<string, string | number> = { name };
    if (elevation !== undefined) properties.elevation = elevation;
    if (prominence !== undefined) properties.prominence = prominence;
    if (elevation !== undefined) properties.v = elevation;
    properties.wikidata = id;
    properties.url = `https://www.wikidata.org/wiki/${id}`;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties });
  }
  return features;
}

const peaks = defineLayer({
  id: "peaks",
  title: "Peaks",
  description:
    "Named mountain peaks, summits and volcanoes from Wikidata, with their elevation and prominence. Each point has name, elevation (metres above sea level), prominence (metres: how far the peak rises above the saddle that links it to a higher peak, the standard measure of how independent a summit is), " +
    "v (the elevation in metres, the same number as elevation, so the value filter and 3D columns follow height) and wikidata (the item id) with a url to its page. Peaks with no elevation recorded have no v. " +
    "Use it for 'tallest peaks here', 'highest mountains in this range', 'peaks with the most prominence' (read the prominence property and sort on it yourself), 'what is that mountain called', or 'peak bagging' lists; with 3D on, columns rise with elevation. " +
    "Caveats: Wikidata is a volunteer-edited catalogue, so well-known peaks are present with good numbers, but many minor summits are missing and many listed peaks have an elevation but no prominence, " +
    "and a few peaks appear twice under slightly different coordinates. Elevations are as entered by editors, not survey-checked; for exact figures use USGS or the summit register. " +
    "Names are English when Wikidata has one, otherwise the peak's own-language name; items with no name are left out. At most 1,000 peaks are returned, highest first, and the result says when that cap is hit. " +
    "Works worldwide. Zoom in to a region under 40,000 km² (about a 200 km square) first.",
  coverage: "global",
  license: "CC0 (Wikidata)",
  requiredEnv: [],
  maxAreaKm2: 40_000,
  input: z.object({}),
  style: { geometry: "point", color: layerColor("peaks"), unit: "m", extrude: "v" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const area = bboxAreaKm2(ctx.bbox);
    if (area > peaks.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${peaks.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    let res: Response;
    try {
      res = await wikimediaFetch(ctx.fetch, SPARQL_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/sparql-results+json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ query: peaksQuery(ctx.bbox) }).toString(),
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

    const features = normalizePeaks(parsed.data.results.bindings);
    const notes: string[] = [];
    if (parsed.data.results.bindings.length >= LIMIT) {
      notes.push(`Showing the ${LIMIT.toLocaleString("en-US")} highest peaks; zoom in for the rest`);
    }
    if (features.length === 0) notes.push("No named peaks in Wikidata for this area");

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: "Wikidata (CC0), peaks with coordinates, elevation (P2044) and topographic prominence (P2660)",
        url: "https://www.wikidata.org/",
        retrieved: new Date().toISOString(),
      },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(peaks);

export default peaks;

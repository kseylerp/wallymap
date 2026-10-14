/**
 * US Drought Monitor weekly drought categories (D0 abnormally dry to D4 exceptional drought).
 * Source: the U.S. Drought Monitor (National Drought Mitigation Center at the University of Nebraska-Lincoln, USDA, NOAA).
 * Why not the NDMC files: https://droughtmonitor.unl.edu/data/json/usdm_YYYYMMDD.json (and usdm_current.json), the weekly
 * GeoJSON listed on https://droughtmonitor.unl.edu/DmData/GISData.aspx, exist (verified 2026-10-09: usdm_20261006.json,
 * HTTP 200) but each is the whole country, 20 to 24 MB, with no bbox filter, and 12 weeks would be 280 MB per request.
 * Instead this layer reads Esri's public mirror of the same weekly shapefiles, which can be queried by bbox and date:
 *   https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/US_Drought_Intensity_v1/FeatureServer/2
 *   "US_Drought" (polygons, time-enabled on ddate, one row per week and category, 2000 to now; verified current to the
 *   2026-10-06 map). Keyless in practice, although the service description says organisation accounts.
 * The official NDMC GeoJSON is the fallback if the Esri copy goes away (nation-wide download, clip to the bbox here);
 * it is not wired in. Licensing: NDMC data, which NDMC asks users to credit; the Esri-hosted copy's service terms are for
 * organisational use, so verify them before any commercial use.
 * Fields used: dm (0 to 4, the category), ddate (valid Tuesday, epoch ms UTC). Each row is one MultiPolygon of the area in
 * exactly that category that week (categories do not overlap; a D1 row does not contain the D2 area).
 * Notes from live requests:
 *   - maxRecordCount is 52 and the service silently stops there without exceededTransferLimit, so at most 10 weeks
 *     (50 rows) are asked for per request; 12 weeks takes two.
 *   - The polygons are national and very detailed, so maxAllowableOffset scales with the view and the result is clipped to the
 *     view (plus a margin) here, rounded to 3 decimals. A week is 200 to 270 KB upstream; 12 weeks over Texas was 3.3 MB in 9 s.
 *   - The latest week is found with a max(ddate) statistics query (cached for 3 hours); the USDM publishes on Thursdays.
 * Smoke through runLayer (2026-10-09, newest map 2026-10-06): Tahoe -120.4,38.7,-119.8,39.3 returned 2 polygons (D0, D1) in 1.5 s;
 * Texas -106,26,-93,37 with weeks=12 returned 60 polygons (5 categories x 12 weeks, two requests) in 8.3 s, 182 KB after
 * clipping; the contiguous US -125,24,-66,50 returned 5 polygons in 0.9 s (108 KB) and 20 for weeks=4 in 3.3 s (450 KB);
 * a European bbox returns an empty result with the outside-the-US note.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Facet, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/US_Drought_Intensity_v1/FeatureServer/2";

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/** The service returns at most 52 rows a request and a week has up to 5 (D0 to D4). */
const WEEKS_PER_REQUEST = 10;
const MAX_WEEKS = 12;
/** The newest map is published on Thursdays and past maps do not change, so a few hours is plenty. */
const TTL_SECONDS = 6 * 3600;
const LATEST_TTL_SECONDS = 3 * 3600;
/** A latest map older than this means the mirror has stopped updating. */
const STALE_AFTER_DAYS = 21;
/** The result is clipped to the view enlarged by this fraction on each side, so clip edges stay off screen. */
const CLIP_MARGIN = 0.1;
const COORD_DECIMALS = 1000;

const CATEGORIES = [
  "Abnormally dry",
  "Moderate drought",
  "Severe drought",
  "Extreme drought",
  "Exceptional drought",
] as const;

const inputSchema = z.object({
  weeks: z.number().int().min(1).max(MAX_WEEKS).default(1),
});

const latestSchema = z.object({
  features: z.array(z.object({ attributes: z.object({ latest: z.number().nullable() }) })),
});

const iso = (ms: number) => new Date(ms).toISOString();
const dateOnly = (ms: number) => iso(ms).slice(0, 10);

/** `YYYY-MM-DD 00:00:00` literal for an ArcGIS timestamp comparison. */
function sqlTimestamp(ms: number): string {
  return `timestamp '${dateOnly(ms)} 00:00:00'`;
}

/** The weekly map dates to show, newest first: `weeks` Tuesdays ending at `latest`. */
export function weekDates(latest: number, weeks: number): number[] {
  return Array.from({ length: weeks }, (_, i) => latest - i * MS_PER_WEEK);
}

/** Splits week dates (newest first) into groups small enough for one request. */
export function weekChunks(dates: number[]): { from: number; to: number }[] {
  const chunks: { from: number; to: number }[] = [];
  for (let i = 0; i < dates.length; i += WEEKS_PER_REQUEST) {
    const group = dates.slice(i, i + WEEKS_PER_REQUEST);
    chunks.push({ from: group[group.length - 1], to: group[0] });
  }
  return chunks;
}

/** The view enlarged by CLIP_MARGIN each side, kept inside the world. */
export function paddedBbox(bbox: BBox): BBox {
  const [w, s, e, n] = bbox;
  const dx = (e - w) * CLIP_MARGIN;
  const dy = (n - s) * CLIP_MARGIN;
  return [Math.max(-180, w - dx), Math.max(-90, s - dy), Math.min(180, e + dx), Math.min(90, n + dy)];
}

/** Display simplification in degrees: the source polygons are national, so a view needs far less detail. */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.25, Math.max(0.02, span / 20));
}

/** One Sutherland-Hodgman pass: keeps the part of a closed point list on one side of an axis-aligned line. */
function clipAgainst(points: Position[], axis: 0 | 1, bound: number, keepAbove: boolean): Position[] {
  const other = axis === 0 ? 1 : 0;
  const inside = (p: Position) => (keepAbove ? p[axis] >= bound : p[axis] <= bound);
  const cross = (a: Position, b: Position): Position => {
    const t = (bound - a[axis]) / (b[axis] - a[axis]);
    const point: Position = [0, 0];
    point[axis] = bound;
    point[other] = a[other] + t * (b[other] - a[other]);
    return point;
  };
  const out: Position[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    if (inside(cur)) {
      if (!inside(prev)) out.push(cross(prev, cur));
      out.push(cur);
    } else if (inside(prev)) {
      out.push(cross(prev, cur));
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * COORD_DECIMALS) / COORD_DECIMALS;

/** A ring clipped to the bbox and rounded; null when nothing worth drawing is left. */
export function clipRing(ring: Position[], bbox: BBox): Position[] | null {
  const [w, s, e, n] = bbox;
  let points = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const allInside = points.every((p) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n);
  if (!allInside) {
    points = clipAgainst(points, 0, w, true);
    if (points.length > 0) points = clipAgainst(points, 0, e, false);
    if (points.length > 0) points = clipAgainst(points, 1, s, true);
    if (points.length > 0) points = clipAgainst(points, 1, n, false);
  }
  const rounded: Position[] = [];
  for (const p of points) {
    const q: Position = [round(p[0]), round(p[1])];
    const last = rounded[rounded.length - 1];
    if (last === undefined || last[0] !== q[0] || last[1] !== q[1]) rounded.push(q);
  }
  if (rounded.length >= 2 && rounded[0][0] === rounded[rounded.length - 1][0] && rounded[0][1] === rounded[rounded.length - 1][1]) rounded.pop();
  if (rounded.length < 3) return null;
  return [...rounded, rounded[0]];
}

function clipPolygon(rings: Position[][], bbox: BBox): Position[][] | null {
  const [outer, ...holes] = rings;
  const clippedOuter = outer ? clipRing(outer, bbox) : null;
  if (clippedOuter === null) return null;
  const clippedHoles = holes.map((h) => clipRing(h, bbox)).filter((h): h is Position[] => h !== null);
  return [clippedOuter, ...clippedHoles];
}

/** A Polygon or MultiPolygon clipped to the bbox; null when it does not reach it. */
export function clipGeometry(geometry: Geometry | null, bbox: BBox): Geometry | null {
  if (geometry === null) return null;
  if (geometry.type === "Polygon") {
    const rings = clipPolygon(geometry.coordinates, bbox);
    return rings === null ? null : { type: "Polygon", coordinates: rings };
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates.map((p) => clipPolygon(p, bbox)).filter((p): p is Position[][] => p !== null);
    return polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

/**
 * Converts service rows to category polygons clipped to the view: `v` is the category 0 to 4, `kind` is "D0" to "D4",
 * `t` and `week` are the map's valid date. Newest week first, then mildest category first so worse drought draws on top.
 */
export function normalizeDrought(fc: FeatureCollection, bbox: BBox): FeatureCollection {
  const rows: { ddate: number; dm: number; feature: Feature<Geometry> }[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const dm = typeof p.dm === "number" ? Math.round(p.dm) : Number.NaN;
    const ddate = typeof p.ddate === "number" ? p.ddate : Number.NaN;
    if (!(dm >= 0 && dm <= 4) || !Number.isFinite(ddate)) continue;
    const geometry = clipGeometry(f.geometry, bbox);
    if (geometry === null) continue;
    rows.push({
      ddate,
      dm,
      feature: {
        type: "Feature",
        geometry,
        properties: {
          kind: `D${dm}`,
          category: CATEGORIES[dm],
          v: dm,
          t: iso(ddate),
          week: dateOnly(ddate),
        },
      },
    });
  }
  rows.sort((a, b) => b.ddate - a.ddate || a.dm - b.dm);
  return { type: "FeatureCollection", features: rows.map((r) => r.feature) };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const DROUGHT_URL = "https://droughtmonitor.unl.edu/About/AbouttheData/DroughtClassification.aspx";

const FACETS: Facet[] = [
  {
    key: "kind",
    label: "Category",
    kind: "category",
    values: [
      { value: "D0", label: "D0 Abnormally Dry" },
      { value: "D1", label: "D1 Moderate Drought" },
      { value: "D2", label: "D2 Severe Drought" },
      { value: "D3", label: "D3 Extreme Drought" },
      { value: "D4", label: "D4 Exceptional Drought" },
    ],
  },
];

const CATEGORY: FieldHelp = {
  text:
    "The U.S. Drought Monitor category: D0 Abnormally Dry (going into or coming out of drought), D1 Moderate Drought, D2 Severe Drought, " +
    "D3 Extreme Drought, D4 Exceptional Drought; authors set it each week from many indicators plus local expert reports.",
  scale: "D0 (abnormally dry) to D4 (exceptional drought); 0 to 4 as a number",
  source: "U.S. Drought Monitor (NDMC, USDA, NOAA), Drought Classification",
  url: DROUGHT_URL,
};

const HELP: Record<string, FieldHelp> = {
  kind: CATEGORY,
  v: CATEGORY,
  category: CATEGORY,
  week: { text: "The Tuesday the weekly map is valid for." },
};

const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Category" },
    { key: "category", label: "Drought level" },
    { key: "week", label: "Week of", format: "date" },
  ],
};

const drought = defineLayer({
  id: "drought",
  title: "Drought",
  description:
    "How dry the United States is, from the weekly U.S. Drought Monitor, drawn as polygons: each polygon is one drought category in one week. " +
    "kind is D0 to D4 and v is the same as a number 0 to 4: D0 abnormally dry, D1 moderate drought, D2 severe drought, D3 extreme drought, D4 exceptional drought (areas not in drought are not drawn). category is that name; t and week are the Tuesday the map is valid for. " +
    "Use it for 'drought', 'how dry is it', 'is this area in a drought', or 'has the drought got worse' (set weeks above 1 and use the time scrubber). weeks (1 to 12, default 1) is how many weekly maps to return, newest first; 1 is the current week. " +
    "Caveats: this is a broad, regional picture drawn from rainfall, soil moisture, streamflow and local reports by expert authors, not a measurement at a point, and its edges are smoothed, so do not use it for a single field or a trailhead. " +
    "It describes dryness, not the fire danger and not the water level of a particular lake or river (streamflow and snowpack are better for those). " +
    "The map is updated every Thursday for the Tuesday before, so it lags by two days; the result says when the newest map is older than three weeks. " +
    "United States only (including Alaska, Hawaii and Puerto Rico); elsewhere it returns nothing. Polygons are clipped to the view and simplified for display. " +
    "The map view must be under 16 million km², which is a box about 5,000 km wide and 3,000 km tall, roughly the lower 48 states plus the ocean around them (that is the size of the box on screen, not the area of land); zoom in first, and with many weeks a smaller view is faster.",
  coverage: "us",
  license: "NDMC data via an Esri-hosted copy; NDMC asks for credit; the Esri service terms are for organisational use, verify before commercial use",
  requiredEnv: [],
  maxAreaKm2: 16_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("drought"), fillOpacity: 0.5, facets: FACETS },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = new Date();
    const citation = {
      source:
        "U.S. Drought Monitor (National Drought Mitigation Center at the University of Nebraska-Lincoln, USDA and NOAA), via Esri's public copy of the weekly maps",
      url: "https://droughtmonitor.unl.edu/",
      retrieved: now.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > drought.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${drought.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    // 1. Which week is the newest map?
    let latest: number;
    try {
      const params = new URLSearchParams({
        where: "1=1",
        outStatistics: JSON.stringify([{ statisticType: "max", onStatisticField: "ddate", outStatisticFieldName: "latest" }]),
        f: "json",
      });
      const res = await ctx.fetch(`${SERVICE}/query?${params.toString()}`, {
        // Not bbox-specific, so every view shares one entry.
        cacheKey: ctx.cacheKey === undefined ? undefined : "drought:usdm-latest",
        ttlSeconds: LATEST_TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `Drought service returned ${res.status}`, hint: "upstream" };
      const parsed = latestSchema.safeParse(await res.json());
      const value = parsed.success ? parsed.data.features[0]?.attributes.latest : null;
      if (typeof value !== "number") return { error: "Drought service returned an unexpected response", hint: "upstream" };
      latest = value;
    } catch (err) {
      return {
        error: isTimeout(err)
          ? `Drought service timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "Drought service returned no response",
        hint: "upstream",
      };
    }

    // 2. The weekly maps, in requests of at most 10 weeks.
    const padded = paddedBbox(ctx.bbox);
    const chunks = weekChunks(weekDates(latest, input.weeks));
    const results = await Promise.all(
      chunks.map((chunk) =>
        arcgisQuery(ctx, SERVICE, {
          where: `ddate >= ${sqlTimestamp(chunk.from)} AND ddate <= ${sqlTimestamp(chunk.to)}`,
          outFields: ["dm", "ddate"],
          bbox: padded,
          maxRecords: 500,
          maxAllowableOffset: simplifyOffset(ctx.bbox),
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: `usdm-${dateOnly(chunk.from)}-${dateOnly(chunk.to)}`,
        }),
      ),
    );

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    let failed = 0;
    for (const res of results) {
      if (!res.ok) {
        failed += 1;
        continue;
      }
      features.push(...normalizeDrought(res.fc, padded).features);
    }
    if (failed === results.length) {
      const first = results.find((r) => !r.ok);
      return { error: first && !first.ok ? first.error : "Drought service returned no response", hint: "upstream" };
    }
    if (failed > 0) notes.push("Some of the older weeks could not be loaded");
    features.sort((a, b) => String(b.properties?.t).localeCompare(String(a.properties?.t)) || Number(a.properties?.v) - Number(b.properties?.v));

    const ageDays = (now.getTime() - latest) / MS_PER_DAY;
    if (ageDays > STALE_AFTER_DAYS) notes.push(`The newest drought map available is from ${dateOnly(latest)}`);
    if (features.length === 0) notes.push("No part of this area is in drought (D0 or worse) in the weeks shown");

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
      citation,
    };
  },
});

registerLayer(drought);

export default drought;

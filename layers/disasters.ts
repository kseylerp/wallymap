/**
 * Recent disasters: GDACS alerts worldwide (floods, tropical cyclones, droughts, wildfires) as points, plus FEMA disaster
 * declarations for US counties over the last few years as county polygons.
 *
 * Verified live 2026-10-10 ~10:30 UTC:
 *   GDACS: https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&alertlevel=green;orange;red
 *     &fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&pagenumber=N
 *     -> GeoJSON FeatureCollection of centroid points, 100 per page (pagesize is ignored), HTTP 204 with no body after the
 *     last page. properties: eventtype (FL, TC, DR, WF, ...), eventid, episodeid, eventname, name, alertlevel (Green,
 *     Orange, Red), country, fromdate, todate (UTC, no zone), iscurrent, severitydata.severitytext, url.report,
 *     url.geometry (the footprint polygons). No bbox filter, so each kind is fetched for the whole world (cached an hour
 *     under a key shared by every view) and filtered here.
 *     Counts for the 90 days to 2026-10-10: FL 212, TC 44, DR 15, WF thousands at Green but 11 at Orange or Red, so
 *     wildfires are asked for at Orange and Red only. Each kind is read for at most 5 pages.
 *   OpenFEMA: https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=declarationDate ge '...' and
 *     (fipsStateCode eq '06' or ...)&$select=...&$top=10000&$orderby=declarationDate desc&$inlinecount=allpages
 *     -> { metadata: { count }, DisasterDeclarationsSummaries: [{ disasterNumber, femaDeclarationString, declarationType
 *        (DR major disaster, EM emergency, FM fire management), declarationDate, incidentType, declarationTitle,
 *        fipsStateCode, fipsCountyCode ("000" for tribal and statewide areas), designatedArea, incidentBeginDate }] }.
 *     One row per county and declaration. California and Nevada since 2021-10-10: 250 rows, 89 KB, 0.2 s.
 *     Rows are joined to county outlines (layers/_shared/counties.ts) by five-digit FIPS. Only views under 3,000,000 km²
 *     get the FEMA part (a national query would be several MB).
 *
 * Live smoke through runLayer 2026-10-10: Houston [-96,29,-94.5,30.5], defaults: 15 FEMA counties (Grimes County 3
 * declarations, latest the 2026-09-01 floods DR-4935-TX; Harris County Hurricane Beryl 2024-07-09), no GDACS event in view,
 * 3.4 s cold. Gulf and Mexico [-120,10,-80,35]: 25 GDACS points, top the red Hurricane SIMON-26 (Mexico, 250 km/h) and
 * the orange ISAIAS-26 over the US. Whole world, days=365: 654 points in 10.3 s, floods capped at 500.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon } from "geojson";
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
} from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { outsideUs } from "./_shared/coverage";
import { countiesInBbox } from "./_shared/counties";
import { jsonObjectBody } from "@/lib/fetch/validate";
import { layerColor } from "@/lib/render/palette";

const GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
const FEMA = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";
const DAY_MS = 86_400_000;
const GDACS_TTL_SECONDS = 3600;
const FEMA_TTL_SECONDS = 6 * 3600;
const PAGE_SIZE = 100;
export const MAX_PAGES = 5;
export const MAX_GDACS_EVENTS = MAX_PAGES * PAGE_SIZE;
export const FEMA_MAX_AREA_KM2 = 3_000_000;
const FEMA_TOP = 10_000;
const LISTED = 3;
/** Most GDACS events per view drawn at their affected area (each is one more request, cached an hour). */
export const MAX_FOOTPRINTS = 8;
/** Footprint simplification, about 1 km. */
const FOOTPRINT_TOLERANCE_DEG = 0.01;

/** GDACS event types asked for, with the alert levels and the plain kind each becomes. */
export const GDACS_KINDS = [
  { code: "FL", kind: "flood", levels: "green;orange;red" },
  { code: "TC", kind: "cyclone", levels: "green;orange;red" },
  { code: "DR", kind: "drought", levels: "green;orange;red" },
  { code: "WF", kind: "wildfire", levels: "orange;red" },
] as const;

const inputSchema = z.object({
  days: z.number().int().min(1).max(730).default(90),
  years: z.number().int().min(1).max(20).default(5),
});

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function gdacsUrl(code: string, levels: string, from: string, to: string, page: number): string {
  return `${GDACS}?eventlist=${code}&alertlevel=${levels}&fromDate=${from}&toDate=${to}&pagenumber=${page}`;
}

const gdacsSchema = z.object({
  geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]).rest(z.number()) }),
  properties: z.object({
    eventtype: z.string(),
    eventid: z.number(),
    episodeid: z.number().nullish(),
    eventname: z.string().nullish(),
    name: z.string().nullish(),
    alertlevel: z.string().nullish(),
    country: z.string().nullish(),
    fromdate: z.string().nullish(),
    todate: z.string().nullish(),
    iscurrent: z.string().nullish(),
    severitydata: z.object({ severity: z.number().nullish(), severitytext: z.string().nullish(), severityunit: z.string().nullish() }).nullish(),
    url: z.object({ report: z.string().nullish(), geometry: z.string().nullish() }).nullish(),
  }),
});

/** GDACS times are UTC without a zone: "2026-10-06T21:00:00". */
function gdacsTime(t: string | null | undefined): string | undefined {
  if (!t) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * GDACS's severity in plain fields, by kind. Cyclones: `peakWindKmh` (the strongest sustained wind over the storm's life)
 * and `stage` (the class in the latest advisory: a storm that peaked as a hurricane reads "Tropical depression" once it
 * weakens, which GDACS prints as "Tropical Depression (maximum wind speed of 250 km/h)"). Droughts: `affectedKm2`.
 * Wildfires: `burnedHa`. Floods carry "Magnitude 0" for every event, so nothing.
 */
export function severityOf(
  kind: string,
  s: { severity?: number | null; severitytext?: string | null; severityunit?: string | null } | null | undefined,
): Record<string, string | number> {
  const value = typeof s?.severity === "number" && Number.isFinite(s.severity) && s.severity > 0 ? s.severity : undefined;
  const text = s?.severitytext?.trim() ?? "";
  if (kind === "cyclone") {
    const out: Record<string, string | number> = {};
    if (value !== undefined && s?.severityunit === "km/h") out.peakWindKmh = Math.round(value);
    const stage = /^(hurricane|typhoon)/i.test(text) ? "Hurricane or typhoon" : /^tropical storm/i.test(text) ? "Tropical storm" : /^tropical depression/i.test(text) ? "Tropical depression" : undefined;
    if (stage) out.stage = stage;
    return out;
  }
  if (kind === "drought" && value !== undefined && s?.severityunit === "km2") {
    const impact = /^(\w+) impact/i.exec(text)?.[1];
    return { affectedKm2: Math.round(value), ...(impact && { impact: `${impact.charAt(0).toUpperCase()}${impact.slice(1).toLowerCase()} impact on crops` }) };
  }
  if (kind === "wildfire" && value !== undefined && s?.severityunit === "ha") return { burnedHa: Math.round(value) };
  return {};
}

/** GDACS points inside the bbox, newest first, one per event (the latest episode wins). */
export function gdacsFeatures(raw: unknown[], [w, s, e, n]: BBox): Feature<Point>[] {
  const byEvent = new Map<string, Feature<Point>>();
  for (const item of raw) {
    const parsed = gdacsSchema.safeParse(item);
    if (!parsed.success) continue;
    const [lng, lat] = parsed.data.geometry.coordinates;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const p = parsed.data.properties;
    const kind = GDACS_KINDS.find((k) => k.code === p.eventtype)?.kind ?? p.eventtype.toLowerCase();
    const props: Record<string, string | number> = {
      source: "GDACS",
      kind,
      name: p.name || p.eventname || `${kind} ${p.eventid}`,
      eventId: `${p.eventtype}-${p.eventid}`,
    };
    const t = gdacsTime(p.fromdate);
    const until = gdacsTime(p.todate);
    if (t) props.t = t;
    if (until) props.until = until;
    if (p.alertlevel) props.alertLevel = p.alertlevel.toLowerCase();
    if (p.country) props.country = p.country;
    if (p.iscurrent) props.current = p.iscurrent === "true" ? "yes" : "no";
    Object.assign(props, severityOf(kind, p.severitydata));
    if (p.url?.report) props.url = p.url.report;
    if (p.url?.geometry) props.footprintUrl = p.url.geometry;
    const key = String(props.eventId);
    const prev = byEvent.get(key);
    if (prev === undefined || String(prev.properties?.until ?? "") < String(props.until ?? "")) {
      byEvent.set(key, { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props });
    }
  }
  return [...byEvent.values()].sort((a, b) => String(b.properties?.t ?? "").localeCompare(String(a.properties?.t ?? "")));
}

type Position = number[];

/** Perpendicular distance from `p` to the segment a–b, in degrees (fine for simplifying a drawn outline). */
function segmentDistance(p: Position, a: Position, b: Position): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker on one ring, keeping its first and last points; coordinates rounded to 3 decimals (about 100 m). */
export function simplifyRing(ring: Position[], tolerance: number): Position[] {
  if (ring.length <= 4) return ring.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(ring[k], ring[i], ring[j]);
      if (d > worst) [worst, at] = [d, k];
    }
    if (at !== -1 && worst > tolerance) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return ring.filter((_, k) => keep[k] === 1).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}

/** A polygon or multipolygon simplified ring by ring; rings that collapse below a triangle are dropped. */
export function simplifyArea(g: Polygon | MultiPolygon, tolerance: number): Polygon | MultiPolygon | null {
  const polygon = (rings: Position[][]) => rings.map((r) => simplifyRing(r, tolerance)).filter((r) => r.length >= 4);
  if (g.type === "Polygon") {
    const rings = polygon(g.coordinates);
    return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
  }
  const polys = g.coordinates.map(polygon).filter((rings) => rings.length > 0);
  return polys.length > 0 ? { type: "MultiPolygon", coordinates: polys } : null;
}

/**
 * The area to draw for one GDACS event from its footprint file (url.geometry): a cyclone's swath of winds of 60 km/h or
 * more (the polygon labelled with the lowest wind speed, over the storm's whole track), a flood's affected area
 * (Poly_Affected, not the wider Poly_Global), a drought's or wildfire's affected area (Poly_area). Null when the file has
 * none. `extent` says in words what the drawn area is.
 */
export function footprintOf(kind: string, fc: unknown): { geometry: Polygon | MultiPolygon; extent: string } | null {
  if (typeof fc !== "object" || fc === null || !Array.isArray((fc as { features?: unknown }).features)) return null;
  const areas = ((fc as { features: unknown[] }).features as Feature[]).filter(
    (f) => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon",
  ) as Feature<Polygon | MultiPolygon>[];
  const label = (f: Feature) => String(f.properties?.polygonlabel ?? "");
  const cls = (f: Feature) => String(f.properties?.Class ?? "");
  let pick: Feature<Polygon | MultiPolygon> | undefined;
  let extent = "Affected area";
  if (kind === "cyclone") {
    const winds = areas
      .map((f) => ({ f, kmh: Number(/^(\d+) km\/h$/.exec(label(f).trim())?.[1]) }))
      .filter((w) => Number.isFinite(w.kmh))
      .sort((a, b) => a.kmh - b.kmh);
    if (winds.length > 0) {
      pick = winds[0].f;
      extent = `Winds of ${winds[0].kmh} km/h (${Math.round(winds[0].kmh / 1.609)} mph) or more along the track`;
    }
  } else if (kind === "flood") {
    pick = areas.find((f) => cls(f) === "Poly_Affected");
  } else {
    pick = areas.find((f) => cls(f) === "Poly_area");
  }
  if (!pick) return null;
  const geometry = simplifyArea(pick.geometry, FOOTPRINT_TOLERANCE_DEG);
  return geometry ? { geometry, extent } : null;
}

/** FEMA incident types in the same words as the GDACS kinds where they overlap. */
export function femaKind(incidentType: string): string {
  const t = incidentType.toLowerCase();
  if (t === "fire") return "wildfire";
  if (t === "flood") return "flood";
  if (t === "drought") return "drought";
  if (["hurricane", "typhoon", "tropical storm", "coastal storm", "tropical depression"].includes(t)) return "cyclone";
  return t;
}

const femaRowSchema = z.object({
  disasterNumber: z.number(),
  femaDeclarationString: z.string().nullish(),
  declarationType: z.string().nullish(),
  declarationDate: z.string(),
  incidentType: z.string(),
  declarationTitle: z.string().nullish(),
  fipsStateCode: z.string(),
  fipsCountyCode: z.string(),
});
type FemaRow = z.infer<typeof femaRowSchema>;

export function femaUrl(states: string[], since: string): string {
  const stateFilter = states.map((s) => `fipsStateCode eq '${s}'`).join(" or ");
  const params = new URLSearchParams({
    $filter: `declarationDate ge '${since}T00:00:00.000Z' and (${stateFilter})`,
    $select:
      "disasterNumber,femaDeclarationString,declarationType,declarationDate,incidentType,declarationTitle,fipsStateCode,fipsCountyCode,designatedArea",
    $top: String(FEMA_TOP),
    $orderby: "declarationDate desc",
    $inlinecount: "allpages",
  });
  return `${FEMA}?${params.toString()}`;
}

export function parseFema(body: unknown): FemaRow[] {
  if (typeof body !== "object" || body === null || !("DisasterDeclarationsSummaries" in body)) return [];
  const rows = (body as { DisasterDeclarationsSummaries: unknown }).DisasterDeclarationsSummaries;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const parsed = femaRowSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Short kind words for the per-kind counts ("cyclone 2, flood 1"). */
const KIND_SHORT: Record<string, string> = { cyclone: "hurricane or tropical storm", "mud/landslide": "landslide", "dam/levee break": "dam or levee break" };

const SMALL_WORDS = new Set(["and", "or", "of", "the", "in", "on", "at", "to", "for"]);

/** FEMA's upper-case titles in title case: "SEVERE STORMS AND FLOODING" → "Severe Storms and Flooding"; the incident type when there is none. */
export function titleOf(r: Pick<FemaRow, "declarationTitle" | "incidentType">): string {
  const raw = (r.declarationTitle ?? "").trim() || r.incidentType;
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/^(\p{L})/u, (c) => c.toUpperCase())))
    .join(" ")
    .replace(/\bCovid-19\b/i, "COVID-19");
}

/**
 * One county polygon per county with declarations: v = number of declarations, t = the latest declaration date,
 * kind = its incident kind, declarations = the latest few as text, kinds = a count per kind.
 */
export function femaCountyFeatures(rows: FemaRow[], counties: { fips: string; name: string; stateAbbr: string; geometry: Geometry }[]): Feature<Geometry>[] {
  const byFips = new Map<string, FemaRow[]>();
  for (const r of rows) {
    if (r.fipsCountyCode === "000") continue;
    const fips = `${r.fipsStateCode}${r.fipsCountyCode}`;
    const list = byFips.get(fips) ?? [];
    if (!list.some((x) => x.disasterNumber === r.disasterNumber)) list.push(r);
    byFips.set(fips, list);
  }
  const out: Feature<Geometry>[] = [];
  for (const county of counties) {
    const list = byFips.get(county.fips);
    if (list === undefined || list.length === 0) continue;
    list.sort((a, b) => b.declarationDate.localeCompare(a.declarationDate));
    const counts = new Map<string, number>();
    for (const r of list) counts.set(femaKind(r.incidentType), (counts.get(femaKind(r.incidentType)) ?? 0) + 1);
    const latest = list[0];
    out.push({
      type: "Feature",
      geometry: county.geometry,
      properties: {
        source: "FEMA",
        name: county.name,
        state: county.stateAbbr,
        fips: county.fips,
        v: list.length,
        t: new Date(latest.declarationDate).toISOString(),
        kind: femaKind(latest.incidentType),
        latest: `${titleOf(latest)} (${latest.femaDeclarationString ?? latest.disasterNumber})`,
        first: list[list.length - 1].declarationDate.slice(0, 10),
        kinds: [...counts.entries()].map(([k, n]) => `${KIND_SHORT[k] ?? k} ${n}`).join(", "),
        declarations:
          list
            .slice(0, LISTED)
            .map((r) => `${r.declarationDate.slice(0, 10)} ${titleOf(r)}`)
            .join("; ") + (list.length > LISTED ? `; and ${list.length - LISTED} earlier` : ""),
      },
    });
  }
  return out.sort((a, b) => Number(b.properties?.v) - Number(a.properties?.v));
}

function timedOut(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

/** Every page of one GDACS kind for the window, stopping at a short page, a 204 or MAX_PAGES. */
async function gdacsKind(ctx: QueryContext, k: (typeof GDACS_KINDS)[number], from: string, to: string): Promise<{ ok: boolean; features: unknown[]; capped: boolean }> {
  const features: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let text: string;
    try {
      const res = await ctx.fetch(gdacsUrl(k.code, k.levels, from, to, page), {
        cacheKey: `disasters:gdacs:${k.code}:${from}:${to}:${page}`,
        ttlSeconds: GDACS_TTL_SECONDS,
        validate: (body) => body === "" || jsonObjectBody({ listKey: "features", minLength: 0 })(body),
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      // GDACS ends the list with an HTTP 204, which the fetch wrapper passes back with an empty body.
      if (res.status === 204) return { ok: true, features, capped: false };
      if (!res.ok) return { ok: page > 1, features, capped: false };
      text = await res.text();
    } catch {
      return { ok: page > 1, features, capped: false };
    }
    if (text.trim() === "") return { ok: true, features, capped: false };
    let rows: unknown[] = [];
    try {
      const body = JSON.parse(text) as { features?: unknown };
      rows = Array.isArray(body.features) ? body.features : [];
    } catch {
      return { ok: page > 1, features, capped: false };
    }
    features.push(...rows);
    if (rows.length < PAGE_SIZE) return { ok: true, features, capped: false };
  }
  return { ok: true, features, capped: true };
}

const ALERT_RANK: Record<string, number> = { red: 3, orange: 2, green: 1 };

/**
 * Draws the most severe GDACS events in view at their affected area instead of a centre point: red, then orange, then
 * green, newest first within a level, at most MAX_FOOTPRINTS. Green floods are skipped (their footprint files run to
 * megabytes for a minor alert). An event whose footprint does not load keeps its point. Returns the events in order.
 */
export async function withFootprints(ctx: QueryContext, points: Feature<Point>[]): Promise<{ features: Feature[]; drawn: number }> {
  const ranked = points
    .filter((f) => typeof f.properties?.footprintUrl === "string" && String(f.properties.footprintUrl).startsWith("https://"))
    .filter((f) => !(f.properties?.kind === "flood" && f.properties?.alertLevel === "green"))
    .sort((a, b) => (ALERT_RANK[String(b.properties?.alertLevel)] ?? 0) - (ALERT_RANK[String(a.properties?.alertLevel)] ?? 0))
    .slice(0, MAX_FOOTPRINTS);
  const areas = new Map<Feature<Point>, { geometry: Polygon | MultiPolygon; extent: string }>();
  await Promise.all(
    ranked.map(async (f) => {
      const url = String(f.properties?.footprintUrl);
      try {
        const res = await ctx.fetch(url, {
          cacheKey: `disasters:gdacs:footprint:${new URL(url).search}`,
          ttlSeconds: GDACS_TTL_SECONDS,
          validate: jsonObjectBody({ listKey: "features", minLength: 0 }),
          timeoutMs: UPSTREAM_TIMEOUT_MS,
        });
        if (!res.ok) return;
        const area = footprintOf(String(f.properties?.kind), await res.json());
        if (area) areas.set(f, area);
      } catch {
        // The point stays.
      }
    }),
  );
  const features = points.map((f): Feature => {
    const area = areas.get(f);
    return area ? { type: "Feature", geometry: area.geometry, properties: { ...f.properties, extent: area.extent } } : f;
  });
  return { features, drawn: areas.size };
}

type FemaPart =
  | { ok: true; features: Feature<Geometry>[]; rowsTruncated: boolean; countiesTruncated: boolean; connecticut: boolean }
  | { ok: false; error: string };

async function femaPart(ctx: QueryContext, years: number, now: number): Promise<FemaPart> {
  const counties = await countiesInBbox(ctx, ctx.bbox);
  if (!counties.ok) return counties;
  if (counties.counties.length === 0) return { ok: true, features: [], rowsTruncated: false, countiesTruncated: false, connecticut: false };
  const states = [...new Set(counties.counties.map((c) => c.fips.slice(0, 2)))].sort();
  const since = isoDay(now - years * 365.25 * DAY_MS);
  try {
    const res = await ctx.fetch(femaUrl(states, since), {
      cacheKey: `disasters:fema:${states.join(",")}:${since}`,
      ttlSeconds: FEMA_TTL_SECONDS,
      validate: jsonObjectBody({ listKey: "DisasterDeclarationsSummaries", minLength: 0 }),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: `OpenFEMA returned ${res.status}` };
    const body = (await res.json()) as { metadata?: { count?: number } };
    const rows = parseFema(body);
    const total = typeof body.metadata?.count === "number" ? body.metadata.count : rows.length;
    return {
      ok: true,
      features: femaCountyFeatures(rows, counties.counties),
      rowsTruncated: total > rows.length,
      countiesTruncated: counties.truncated,
      // FEMA still files Connecticut under its 8 old counties; the outlines are the 2022 planning regions, so none match.
      connecticut: counties.counties.some((c) => c.stateAbbr === "CT"),
    };
  } catch (err) {
    return { ok: false, error: timedOut(err) ? `OpenFEMA timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "OpenFEMA returned no usable response" };
  }
}

const FEMA_URL = "https://www.fema.gov/disaster/declarations";

const DECLARATIONS: FieldHelp = {
  text:
    "How many FEMA disaster declarations named this county in the years asked for (default the last 5). A declaration means federal aid was " +
    "approved, not how bad the damage was.",
  source: "FEMA, Disaster Declarations Summaries",
  url: FEMA_URL,
};

const HELP: Record<string, FieldHelp> = {
  v: DECLARATIONS,
  alertLevel: {
    text: "The GDACS alert level for the event: green minor, orange moderate, red severe humanitarian impact.",
    scale: "green, orange, red",
    source: "GDACS (Global Disaster Alert and Coordination System)",
    url: "https://www.gdacs.org/",
  },
  fips: {
    text: "The county's five-digit FIPS code (two digits for the state, three for the county), the US Census identifier the FEMA declarations are joined to the county outline by.",
  },
  kinds: { text: "How many of the county's declarations were of each kind of disaster in the period." },
  peakWindKmh: {
    text: "The strongest sustained wind GDACS recorded over the storm's life, not the wind now. A storm that peaked as a hurricane keeps that figure after it weakens.",
    unit: "km/h",
    source: "GDACS tropical cyclone alerts (from NOAA and JTWC advisories)",
    url: "https://www.gdacs.org/",
  },
  stage: { text: "The storm's class in the latest advisory: tropical depression (under 63 km/h), tropical storm (63 to 118 km/h), or hurricane or typhoon (119 km/h and up)." },
  affectedKm2: { text: "The area where GDACS's drought index shows crops under stress.", unit: "km²", source: "GDACS drought alerts (European Drought Observatory)" },
  burnedHa: { text: "The burned area GDACS mapped for the fire from satellite detections.", unit: "ha", source: "GDACS wildfire alerts (GWIS)" },
  extent: { text: "What the drawn area shows. Orange and red alerts (and up to eight events per view) are drawn at the affected area GDACS publishes; the rest are a point at the event's centre." },
  first: { text: "The earliest declaration for this county in the years asked for." },
};

/** GDACS alert levels, as the source defines them. */
const ALERT_LEVELS = [
  { value: "green", label: "Green (minor)", help: "Minor impact expected; usually no international help needed." },
  { value: "orange", label: "Orange (moderate)", help: "Moderate impact; national response may need help." },
  { value: "red", label: "Red (severe)", help: "Severe humanitarian impact likely; international help may be needed." },
];

const ATTRIBUTES: Attribute[] = [
  {
    key: "source",
    type: "category",
    label: "Shown as",
    primary: true,
    levels: [
      { value: "FEMA", label: "FEMA county declarations", help: "US counties named in a FEMA disaster declaration in the years asked for." },
      { value: "GDACS", label: "GDACS alerts", help: "Floods, tropical cyclones, droughts and large wildfires worldwide in the days asked for." },
    ],
  },
  { key: "alertLevel", type: "ordinal", label: "GDACS alert level", scale: "GDACS alert level (green, orange, red)", levels: ALERT_LEVELS },
  {
    key: "kind",
    type: "category",
    label: "Disaster",
    levels: [
      { value: "cyclone", label: "Hurricane or tropical storm" },
      { value: "flood", label: "Flood" },
      { value: "severe storm", label: "Severe storm" },
      { value: "wildfire", label: "Wildfire" },
      { value: "drought", label: "Drought" },
      { value: "winter storm", label: "Winter storm" },
      { value: "tornado", label: "Tornado" },
      { value: "earthquake", label: "Earthquake" },
      { value: "biological", label: "Disease outbreak" },
    ],
  },
  {
    key: "v",
    type: "measure",
    label: "FEMA declarations",
    encode: "size",
    help: DECLARATIONS,
    presets: [
      { label: "1", min: 1 },
      { label: "2 or more", min: 2 },
      { label: "4 or more", min: 4 },
      { label: "8 or more", min: 8 },
    ],
  },
  { key: "peakWindKmh", type: "measure", label: "Peak wind", unit: "km/h" },
  { key: "name", type: "name", label: "Name" },
];

/** Kinds in words: GDACS's four and FEMA's incident types (lowercased by femaKind). */
const KIND_LABELS: Record<string, string> = {
  flood: "Flood",
  cyclone: "Tropical cyclone (hurricane, typhoon or tropical storm)",
  drought: "Drought",
  wildfire: "Wildfire",
  "severe storm": "Severe storm",
  "winter storm": "Winter storm",
  "severe ice storm": "Severe ice storm",
  snowstorm: "Snowstorm",
  tornado: "Tornado",
  earthquake: "Earthquake",
  tsunami: "Tsunami",
  "volcanic eruption": "Volcanic eruption",
  "mud/landslide": "Mudslide or landslide",
  "dam/levee break": "Dam or levee break",
  biological: "Biological (disease outbreak)",
  other: "Other",
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Disaster declarations" },
  facts: [
    { key: "kind", label: "Disaster", values: KIND_LABELS },
    { key: "source", label: "Source", values: { GDACS: "GDACS global disaster alerts", FEMA: "FEMA disaster declarations" } },
    { key: "alertLevel", label: "Alert level", values: { green: "Green (minor)", orange: "Orange (moderate)", red: "Red (severe)" } },
    { key: "stage", label: "Latest class" },
    { key: "peakWindKmh", label: "Peak wind", unit: "km/h", format: "int" },
    { key: "affectedKm2", label: "Crops under stress", unit: "km²", format: "int" },
    { key: "impact", label: "Impact" },
    { key: "burnedHa", label: "Burned area", unit: "ha", format: "int" },
    { key: "extent", label: "Drawn area" },
    { key: "country", label: "Country" },
    { key: "current", label: "Ongoing", values: { yes: "Yes", no: "No" } },
    { key: "t", label: "Began", format: "date" },
    { key: "until", label: "Last updated", format: "date" },
    { key: "latest", label: "Latest declaration" },
    { key: "first", label: "Earliest in period", format: "date" },
    { key: "kinds", label: "Declarations by kind", format: "list" },
    { key: "declarations", label: "Recent declarations" },
    { key: "state", label: "State" },
  ],
  links: [{ key: "url", label: "GDACS report" }],
  hidden: ["fips", "eventId", "footprintUrl"],
};

const disasters = defineLayer({
  id: "disasters",
  title: "Disasters (GDACS alerts and FEMA declarations)",
  description:
    "Recent disasters from two sources: GDACS alerts worldwide as points (floods, cyclones, droughts, and wildfires at orange or red alert only; small green wildfire alerts are left out) and, in the US, FEMA disaster declarations joined to county polygons by FIPS (v = declarations per county). " +
    "GDACS: GDACS alerts (the UN and European Commission disaster alert system) as points, one per event, for floods, tropical cyclones (hurricanes and typhoons), droughts and large wildfires, " +
    "with source 'GDACS', kind ('flood', 'cyclone', 'drought' or 'wildfire'), name, t (start, UTC), until (last update), alertLevel ('green' minor, 'orange' moderate, 'red' severe humanitarian impact), country, current ('yes' while ongoing), peakWindKmh and stage for cyclones (peak wind over the storm's life, and its class in the latest advisory), affectedKm2 for droughts, burnedHa for wildfires, url (the GDACS report). The most severe events in view (red, then orange, up to 8) are drawn at their affected area (a cyclone's swath of 60 km/h winds), with extent saying so; the rest are points at the centre. " +
    "FEMA: county polygons with source 'FEMA', v (how many declarations the county had in the period), t (the latest declaration date), kind (its incident: wildfire, flood, cyclone, severe storm, winter storm, tornado and so on), latest, kinds (a count per kind) and first (the earliest date), declarations (the latest three as text). " +
    "days (1 to 730, default 90) is how far back GDACS alerts go; years (1 to 20, default 5) is how far back FEMA declarations go. " +
    "Example questions: 'What disasters hit Florida in the last five years?', 'Is there a hurricane near Mexico right now?', 'Which counties here had the most disaster declarations?'. User words: disasters, hurricane, disaster declaration. " +
    "Caveats: GDACS points are an event's centre, not its extent; small wildfires (green alerts) are left out (use fire-perimeters or fire-detections); a FEMA declaration means federal aid was approved, not how bad the damage was; tribal and statewide declarations are not drawn. " +
    "FEMA counties are added only when the view is under 3,000,000 km²; GDACS works at any size, up to 500 events per kind.",
  coverage: "global",
  surface: "any",
  license: "GDACS (European Commission JRC and UN OCHA): free use with credit, no formal licence; FEMA data public domain; county outlines Esri / US Census Bureau",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("disasters"), fillOpacity: 0.2, timeField: "t", encode: { size: "v" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  // The windows are the inputs (days of GDACS alerts, years of FEMA declarations), and a county holds several dated
  // declarations, so a scrubber over one date per county would hide the earlier ones: no time panel; dates are on the card.
  time: { shape: "none" },
  legend: {
    kind: "size",
    title: "FEMA declarations per county",
    field: "v",
    stops: [
      { label: "1", value: 1 },
      { label: "2", value: 2 },
      { label: "4", value: 4 },
      { label: "8+", value: 8 },
    ],
    note: "Denser hatching means more declarations in the years asked for. GDACS alerts (green minor, orange moderate, red severe) are drawn at their affected area for the most severe events in view (a cyclone's swath of 60 km/h winds) and as points otherwise.",
  },
  labels: { field: "name", max: 5, rankBy: "v" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const from = isoDay(now - input.days * DAY_MS);
    const to = isoDay(now);
    const wantFema = !outsideUs(ctx.bbox) && bboxAreaKm2(ctx.bbox) <= FEMA_MAX_AREA_KM2;

    const [kinds, fema] = await Promise.all([
      Promise.all(GDACS_KINDS.map((k) => gdacsKind(ctx, k, from, to))),
      wantFema ? femaPart(ctx, input.years, now) : Promise.resolve(null),
    ]);

    const gdacsOk = kinds.some((k) => k.ok);
    if (!gdacsOk && (fema === null || !fema.ok)) {
      return { error: fema !== null && !fema.ok ? `GDACS returned no usable response; ${fema.error}` : "GDACS returned no usable response", hint: "upstream" };
    }

    const points = gdacsFeatures(kinds.flatMap((k) => k.features), ctx.bbox);
    const events = await withFootprints(ctx, points);
    const countyPolygons = fema !== null && fema.ok ? fema.features : [];
    // Counties first (drawn beneath), the alerts on top.
    const features: Feature[] = [...countyPolygons, ...events.features];

    const notes: string[] = [];
    if (kinds.some((k) => k.capped)) notes.push(`Some GDACS kinds hit the ${MAX_GDACS_EVENTS}-event limit; shorten days for the rest`);
    if (kinds.some((k) => !k.ok)) notes.push("Some GDACS event types could not be loaded");
    if (!outsideUs(ctx.bbox) && !wantFema) notes.push("Zoom in to under 3,000,000 km² to add FEMA county declarations");
    if (fema !== null && !fema.ok) notes.push(`FEMA declarations could not be loaded (${fema.error})`);
    if (fema !== null && fema.ok && fema.rowsTruncated) notes.push("Not every FEMA declaration fit (the query covers whole states); shorten years");
    if (fema !== null && fema.ok && fema.countiesTruncated) notes.push("Too many counties to show them all; zoom in");
    if (fema !== null && fema.ok && fema.connecticut) notes.push("Connecticut has no FEMA county polygons (FEMA uses its old counties)");
    if (points.length > events.drawn && events.drawn > 0) notes.push(`${events.drawn} of ${points.length} GDACS alerts are drawn at their affected area; the rest are points at the event's centre`);
    if (features.length === 0) notes.push(`No GDACS alerts in the last ${input.days} days${wantFema ? ` and no FEMA declarations in ${input.years} years` : ""} in this view`);

    const data: FeatureCollection = { type: "FeatureCollection", features };
    return {
      kind: "geojson",
      data,
      citation: {
        source: "GDACS, Global Disaster Alert and Coordination System (European Commission JRC, UN OCHA); OpenFEMA Disaster Declarations Summaries (FEMA)",
        url: "https://www.gdacs.org/",
        retrieved: new Date(now).toISOString(),
      },
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(disasters);

export default disasters;

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
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext } from "./types";
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
const LISTED = 5;

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
    severitydata: z.object({ severitytext: z.string().nullish() }).nullish(),
    url: z.object({ report: z.string().nullish(), geometry: z.string().nullish() }).nullish(),
  }),
});

/** GDACS times are UTC without a zone: "2026-10-06T21:00:00". */
function gdacsTime(t: string | null | undefined): string | undefined {
  if (!t) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
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
    if (p.severitydata?.severitytext) props.severity = p.severitydata.severitytext;
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
        latest: `${latest.declarationTitle ?? latest.incidentType} (${latest.femaDeclarationString ?? latest.disasterNumber})`,
        kinds: [...counts.entries()].map(([k, n]) => `${k} ${n}`).join(", "),
        declarations: list
          .slice(0, LISTED)
          .map((r) => `${r.declarationDate.slice(0, 10)} ${r.incidentType}: ${r.declarationTitle ?? ""} (${r.femaDeclarationString ?? r.disasterNumber})`)
          .join("; "),
      },
    });
  }
  return out.sort((a, b) => Number(b.properties?.v) - Number(a.properties?.v));
}

/** The error `new Response(body, { status: 204 })` throws. */
function isNoBodyStatus(err: unknown): boolean {
  return err instanceof TypeError && /status code 204/.test(err.message);
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
      if (res.status === 204) return { ok: true, features, capped: false };
      if (!res.ok) return { ok: page > 1, features, capped: false };
      text = await res.text();
    } catch (err) {
      // GDACS ends the list with a 204, which the fetch wrapper cannot rebuild into a Response (it throws); that is the end.
      return { ok: page > 1 || isNoBodyStatus(err), features, capped: false };
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

async function femaPart(ctx: QueryContext, years: number, now: number): Promise<{ ok: true; features: Feature<Geometry>[]; truncated: boolean } | { ok: false; error: string }> {
  const counties = await countiesInBbox(ctx, ctx.bbox);
  if (!counties.ok) return counties;
  if (counties.counties.length === 0) return { ok: true, features: [], truncated: false };
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
    return { ok: true, features: femaCountyFeatures(rows, counties.counties), truncated: total > rows.length || counties.truncated };
  } catch (err) {
    return { ok: false, error: timedOut(err) ? `OpenFEMA timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "OpenFEMA returned no usable response" };
  }
}

const disasters = defineLayer({
  id: "disasters",
  title: "Disasters (GDACS alerts and FEMA declarations)",
  description:
    "Recent natural disasters, from two sources. Worldwide: GDACS alerts (the UN and European Commission disaster alert system) as points, one per event, for floods, tropical cyclones (hurricanes and typhoons), droughts and large wildfires, " +
    "with source 'GDACS', kind ('flood', 'cyclone', 'drought' or 'wildfire'), name, t (start, UTC), until (last update), alertLevel ('green' minor, 'orange' moderate, 'red' severe humanitarian impact), country, current ('yes' while ongoing), severity (e.g. maximum wind speed), url (the GDACS report) and footprintUrl (GeoJSON of the affected area or storm track). " +
    "United States: FEMA disaster declarations as county polygons, with source 'FEMA', v (how many declarations the county had in the period), t (the latest declaration date), kind (its incident: wildfire, flood, cyclone, severe storm, winter storm, tornado and so on), latest, kinds (a count per kind) and declarations (the latest five as text). " +
    "days (1 to 730, default 90) is how far back GDACS alerts go; years (1 to 20, default 5) is how far back FEMA declarations go. " +
    "Example questions: 'What disasters hit Florida in the last five years?', 'Is there a hurricane near Mexico right now?', 'Which counties here had the most disaster declarations?'. User words: disasters, hurricane, disaster declaration. " +
    "Caveats: GDACS points are an event's centre, not its extent, and small wildfires (green alerts) are left out (use fire-perimeters or fire-detections); a FEMA declaration means federal aid was approved, not how bad the damage was; tribal and statewide declarations are not drawn. " +
    "FEMA counties are added only when the view is under 3,000,000 km²; GDACS works at any size, up to 500 events per kind.",
  coverage: "global",
  license: "GDACS (European Commission JRC and UN OCHA): free use with credit, no formal licence; FEMA data public domain; county outlines Esri / US Census Bureau",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("disasters"), fillOpacity: 0.35, timeField: "t" },

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
    const countyPolygons = fema !== null && fema.ok ? fema.features : [];
    const features: Feature[] = [...countyPolygons, ...points];

    const notes: string[] = [];
    if (kinds.some((k) => k.capped)) notes.push(`Some GDACS kinds hit the ${MAX_GDACS_EVENTS}-event limit; shorten days for the rest`);
    if (kinds.some((k) => !k.ok)) notes.push("Some GDACS event types could not be loaded");
    if (!outsideUs(ctx.bbox) && !wantFema) notes.push("Zoom in to under 3,000,000 km² to add FEMA county declarations");
    if (fema !== null && !fema.ok) notes.push(`FEMA declarations could not be loaded (${fema.error})`);
    if (fema !== null && fema.ok && fema.truncated) notes.push("Not every FEMA declaration fit; zoom in");
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

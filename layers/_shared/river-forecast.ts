/**
 * River stage against flood stage, NWS river forecasts and dam releases, joined onto the streamflow gauges (audit R9:
 * "is the French Broad going to flood" got 85% of median and no flood stage; "is the Gauley running" read a gauge above
 * the dam).
 *
 * NOAA National Water Prediction Service (NWPS) API, https://api.water.noaa.gov/nwps/v1 (keyless, US Government, public
 * domain). Verified 2026-10-23:
 *   - /gauges?bbox.xmin=..&bbox.ymin=..&bbox.xmax=..&bbox.ymax=..&srid=EPSG_4326: every NWS river gauge in the box with
 *     lid, name, latitude, longitude, pedts.forecast (empty when the gauge has no forecast) and status.observed /
 *     status.forecast { primary (stage ft), secondary (flow kcfs), floodCategory, validTime }; -999 and validTime
 *     0001-01-01 mean none. Asheville: 17 gauges, AVLN7 French Broad at Asheville 1.16 ft, 874 cfs; Gauley: 8, among them
 *     SUMW2 "Gauley River below Summersville Lake" (stage only); Colorado: 287 (111 with a current forecast) in 1.6 s.
 *   - /gauges/{lid} (about 40 KB): usgsId, timeZone ("EST5EDT"), flood.categories { action, minor, moderate, major } as
 *     { stage ft, flow cfs } (-9999 for none). AVLN7: action 6.5, minor 9.5, moderate 13, major 18 ft. Cached a day.
 *   - /gauges/{lid}/stageflow/forecast (about 2 KB): issuedTime and data [{ validTime, primary ft, secondary kcfs }]
 *     every 6 hours for about 5 days. Cached 30 minutes.
 * USACE Corps Water Management System (CWMS) Data API, https://cwms-data.usace.army.mil/cwms-data (keyless, public
 * domain) for dam releases the paddling world runs on: /timeseries?office=LRH&name=Summersville-Outflow.Flow.Inst.
 * 15Minutes.0.OBS answered 192 readings in cfs (4,142 cfs at 2026-10-23 03:45 UTC) and ...1Hour.0.CELRH-FCST-DAILY the
 * Corps' release forecast to 2026-10-31 (3,435 cfs Saturday, 1,400 Sunday). Only RELEASES below lists them.
 *
 * Runnable ranges are not given: American Whitewater's river database (class, gauge, range per section) publishes no
 * open data licence, and no other free source has ranges, so the layer says flows and flood stages, never "runnable".
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import type { BBox, QueryContext } from "../types";
import { UPSTREAM_TIMEOUT_MS } from "./constants";

const NWPS = "https://api.water.noaa.gov/nwps/v1";
const CWMS = "https://cwms-data.usace.army.mil/cwms-data";
/** Most gauges whose flood stages are looked up per answer (each about 40 KB, cached a day). */
export const DETAIL_CAP = 30;
/** Most gauges whose forecast series is read per answer. */
export const FORECAST_CAP = 20;
/** An NWS gauge this close to a USGS gauge (or with its USGS id) is the same gauge. */
const MATCH_M = 400;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > -999 ? v : undefined);

const StatusSchema = z
  .object({
    primary: z.number().optional(),
    primaryUnit: z.string().optional(),
    secondary: z.number().optional(),
    secondaryUnit: z.string().optional(),
    floodCategory: z.string().optional(),
    validTime: z.string().optional(),
  })
  .partial();

const GaugeSchema = z.object({
  lid: z.string(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  pedts: z.object({ forecast: z.string().optional() }).partial().optional(),
  status: z.object({ observed: StatusSchema.optional(), forecast: StatusSchema.optional() }).partial().optional(),
});

export type Reading = { stageFt?: number; flowCfs?: number; category?: string; time: string };
export type NwpsGauge = { lid: string; name: string; coordinates: [number, number]; observed?: Reading; forecastNow?: Reading; hasForecast: boolean };

function reading(s: z.infer<typeof StatusSchema> | undefined): Reading | undefined {
  if (!s?.validTime || s.validTime.startsWith("0001")) return undefined;
  const stage = s.primaryUnit === "ft" ? num(s.primary) : undefined;
  const sec = num(s.secondary);
  const flow = sec === undefined ? undefined : s.secondaryUnit === "kcfs" ? Math.round(sec * 1000) : s.secondaryUnit === "cfs" ? Math.round(sec) : undefined;
  if (stage === undefined && flow === undefined) return undefined;
  return { ...(stage !== undefined && { stageFt: stage }), ...(flow !== undefined && { flowCfs: flow }), ...(s.floodCategory && { category: s.floodCategory }), time: new Date(s.validTime).toISOString() };
}

/** The gauges of an NWPS /gauges body that report now. */
export function parseGauges(body: unknown): NwpsGauge[] {
  const list = typeof body === "object" && body !== null && "gauges" in body && Array.isArray(body.gauges) ? body.gauges : [];
  const out: NwpsGauge[] = [];
  for (const raw of list) {
    const g = GaugeSchema.safeParse(raw);
    if (!g.success) continue;
    const observed = reading(g.data.status?.observed);
    const forecastNow = reading(g.data.status?.forecast);
    out.push({
      lid: g.data.lid,
      name: g.data.name,
      coordinates: [g.data.longitude, g.data.latitude],
      ...(observed && { observed }),
      ...(forecastNow && { forecastNow }),
      hasForecast: forecastNow !== undefined,
    });
  }
  return out;
}

const Cat = z.object({ stage: z.number().optional(), flow: z.number().optional() }).partial();
const DetailSchema = z.object({
  lid: z.string(),
  usgsId: z.string().nullable().optional(),
  timeZone: z.string().nullable().optional(),
  flood: z
    .object({ categories: z.object({ action: Cat, minor: Cat, moderate: Cat, major: Cat }).partial().optional() })
    .partial()
    .optional(),
});

export type FloodStages = { action?: number; minor?: number; moderate?: number; major?: number };
export type GaugeDetail = { lid: string; usgsId?: string; timeZone?: string; stages: FloodStages };

export function parseDetail(body: unknown): GaugeDetail | null {
  const d = DetailSchema.safeParse(body);
  if (!d.success) return null;
  const c = d.data.flood?.categories ?? {};
  const stage = (x: z.infer<typeof Cat> | undefined) => {
    const s = num(x?.stage);
    return s !== undefined && s > -9999 && s !== 0 ? s : undefined;
  };
  const stages: FloodStages = {};
  for (const k of ["action", "minor", "moderate", "major"] as const) {
    const s = stage(c[k]);
    if (s !== undefined) stages[k] = s;
  }
  return { lid: d.data.lid, ...(d.data.usgsId && { usgsId: d.data.usgsId }), ...(d.data.timeZone && { timeZone: d.data.timeZone }), stages };
}

const ForecastSchema = z.object({
  issuedTime: z.string().optional(),
  secondaryUnits: z.string().optional(),
  data: z.array(z.object({ validTime: z.string(), primary: z.number().optional(), secondary: z.number().optional() })),
});
export type ForecastPoint = { time: string; stageFt?: number; flowCfs?: number };
export type RiverForecast = { issued?: string; points: ForecastPoint[] };

export function parseForecast(body: unknown): RiverForecast | null {
  const f = ForecastSchema.safeParse(body);
  if (!f.success || f.data.data.length === 0) return null;
  const k = f.data.secondaryUnits === "kcfs" ? 1000 : 1;
  const points = f.data.data.map((p) => {
    const s = num(p.primary);
    const q = num(p.secondary);
    return { time: new Date(p.validTime).toISOString(), ...(s !== undefined && { stageFt: s }), ...(q !== undefined && { flowCfs: Math.round(q * k) }) };
  });
  return { ...(f.data.issuedTime && { issued: new Date(f.data.issuedTime).toISOString() }), points };
}

/** The flood category a stage falls in: no_flooding, action, minor, moderate or major; undefined without stages. */
export function categoryFor(stage: number | undefined, s: FloodStages): string | undefined {
  if (stage === undefined || (s.action === undefined && s.minor === undefined)) return undefined;
  if (s.major !== undefined && stage >= s.major) return "major";
  if (s.moderate !== undefined && stage >= s.moderate) return "moderate";
  if (s.minor !== undefined && stage >= s.minor) return "minor";
  if (s.action !== undefined && stage >= s.action) return "action";
  return "no_flooding";
}

const CATEGORY_RANK: Record<string, number> = { no_flooding: 0, action: 1, minor: 2, moderate: 3, major: 4 };
export const CATEGORY_WORDS: Record<string, string> = {
  no_flooding: "below flood stage",
  action: "at action stage (near flooding)",
  minor: "minor flooding",
  moderate: "moderate flooding",
  major: "major flooding",
};

function zoneOk(zone: string | undefined): string {
  if (!zone) return "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "America/New_York";
  }
}

export function localWhen(iso: string, zone: string | undefined): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: zoneOk(zone), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function localDay(iso: string, zone: string | undefined): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: zoneOk(zone), weekday: "short", month: "short", day: "numeric" });
}

const ft = (n: number) => `${Math.round(n * 10) / 10} ft`;
const cfs = (n: number) => `${Math.round(n).toLocaleString("en-US")} cfs`;

/** The NWS facts for one gauge as feature properties (stage, flood stages, category, forecast crest and days). */
export function forecastProperties(g: NwpsGauge, d: GaugeDetail | undefined, fc: RiverForecast | undefined, now: Date): Record<string, unknown> {
  const p: Record<string, unknown> = { nwsId: g.lid, nwsLink: `https://water.noaa.gov/gauges/${g.lid.toLowerCase()}` };
  const stages = d?.stages ?? {};
  const zone = d?.timeZone;
  if (g.observed?.stageFt !== undefined) p.stageFt = g.observed.stageFt;
  if (stages.action !== undefined) p.actionStageFt = stages.action;
  if (stages.minor !== undefined) p.floodStageFt = stages.minor;
  if (stages.moderate !== undefined) p.moderateStageFt = stages.moderate;
  if (stages.major !== undefined) p.majorStageFt = stages.major;
  const cat = categoryFor(g.observed?.stageFt, stages) ?? (g.observed?.category && g.observed.category in CATEGORY_RANK ? g.observed.category : undefined);
  if (cat) p.floodCategory = cat;
  if (g.observed?.stageFt !== undefined && stages.minor !== undefined) {
    const below = stages.minor - g.observed.stageFt;
    p.floodStatus =
      `Stage ${ft(g.observed.stageFt)}; flood stage ${ft(stages.minor)}${stages.action !== undefined ? ` (action ${ft(stages.action)})` : ""}: ` +
      (below > 0 ? `${ft(below)} below flood stage` : CATEGORY_WORDS[cat ?? "minor"]);
  }
  const future = (fc?.points ?? []).filter((x) => Date.parse(x.time) >= now.getTime() - 3_600_000);
  if (future.length > 0) {
    const crest = future.reduce((best, x) => ((x.stageFt ?? -Infinity) > (best.stageFt ?? -Infinity) ? x : best), future[0]);
    const crestCat = categoryFor(crest.stageFt, stages);
    let worst = 0;
    for (const x of future) worst = Math.max(worst, CATEGORY_RANK[categoryFor(x.stageFt, stages) ?? "no_flooding"]);
    const worstCat = Object.keys(CATEGORY_RANK).find((k) => CATEGORY_RANK[k] === worst) ?? "no_flooding";
    if (stages.minor !== undefined || stages.action !== undefined) p.forecastCategory = worstCat;
    const level = [crest.stageFt !== undefined ? ft(crest.stageFt) : undefined, crest.flowCfs !== undefined ? cfs(crest.flowCfs) : undefined].filter(Boolean).join(", ");
    p.forecastCrest = `${level} ${localWhen(crest.time, zone)}${crestCat ? `: ${CATEGORY_WORDS[crestCat]}` : ""}`;
    const days = new Map<string, ForecastPoint[]>();
    for (const x of future) days.set(localDay(x.time, zone), [...(days.get(localDay(x.time, zone)) ?? []), x]);
    p.forecastDays = [...days.entries()].map(([day, xs]) => {
      const top = xs.reduce((b, x) => ((x.stageFt ?? -Infinity) > (b.stageFt ?? -Infinity) ? x : b), xs[0]);
      const parts = [top.stageFt !== undefined ? `up to ${ft(top.stageFt)}` : undefined, top.flowCfs !== undefined ? cfs(top.flowCfs) : undefined].filter(Boolean);
      return `${day}: ${parts.join(", ")}`;
    });
    if (fc?.issued) p.forecastIssued = localWhen(fc.issued, zone);
  }
  return p;
}

function metres(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dy = (a[1] - b[1]) * 110_570;
  return Math.hypot(dx, dy);
}

async function getJson(ctx: QueryContext, url: string, cacheKey: string, ttlSeconds: number, headers?: Record<string, string>): Promise<unknown> {
  try {
    const res = await ctx.fetch(url, { cacheKey, ttlSeconds, timeoutMs: UPSTREAM_TIMEOUT_MS, ...(headers && { headers }) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Joins NWS stage, flood stages and forecasts onto `features` (USGS gauges: matched by USGS id, else within MATCH_M
 * metres) and returns the NWS gauges that match none as new features (kind "nws"). Never throws: a failed NWPS call
 * leaves the gauges as they were and says so in `note`.
 */
export async function joinRiverForecasts(
  ctx: QueryContext,
  features: Feature<Point>[],
  now: Date,
): Promise<{ added: Feature<Point>[]; joined: number; forecasts: number; note?: string }> {
  const [w, s, e, n] = ctx.bbox;
  const list = await getJson(
    ctx,
    `${NWPS}/gauges?bbox.xmin=${w}&bbox.ymin=${s}&bbox.xmax=${e}&bbox.ymax=${n}&srid=EPSG_4326`,
    `streamflow:nwps-gauges:${ctx.bbox.map((x) => x.toFixed(3)).join(",")}`,
    900,
  );
  if (list === null) return { added: [], joined: 0, forecasts: 0, note: "The NWS river forecast service did not answer, so no gauge shows flood stage or a forecast" };
  const gauges = parseGauges(list).filter((g) => g.observed !== undefined || g.hasForecast);
  // Flood stages for the gauges that matter most: a current forecast first, then a reported category.
  const ranked = [...gauges].sort((a, b) => Number(b.hasForecast) - Number(a.hasForecast) || Number(b.observed?.category !== undefined) - Number(a.observed?.category !== undefined));
  const detailFor = ranked.slice(0, DETAIL_CAP);
  const forecastFor = ranked.filter((g) => g.hasForecast).slice(0, FORECAST_CAP);
  const [details, forecasts] = await Promise.all([
    Promise.all(detailFor.map(async (g) => parseDetail(await getJson(ctx, `${NWPS}/gauges/${g.lid}`, `streamflow:nwps-detail:${g.lid}`, 86_400)))),
    Promise.all(forecastFor.map(async (g) => parseForecast(await getJson(ctx, `${NWPS}/gauges/${g.lid}/stageflow/forecast`, `streamflow:nwps-fcst:${g.lid}:${now.toISOString().slice(0, 13)}`, 1_800)))),
  ]);
  const detailBy = new Map<string, GaugeDetail>();
  details.forEach((d) => d && detailBy.set(d.lid, d));
  const forecastBy = new Map<string, RiverForecast>();
  forecasts.forEach((f, i) => f && forecastBy.set(forecastFor[i].lid, f));

  const bySite = new Map<string, Feature<Point>>();
  for (const f of features) {
    const id = f.properties?.siteId;
    if (typeof id === "string") bySite.set(id.replace(/^USGS-/, ""), f);
  }
  const used = new Set<Feature<Point>>();
  const added: Feature<Point>[] = [];
  let joined = 0;
  for (const g of gauges) {
    const d = detailBy.get(g.lid);
    let match = d?.usgsId ? bySite.get(d.usgsId) : undefined;
    if (!match) {
      let best = MATCH_M;
      for (const f of features) {
        if (used.has(f)) continue;
        const m = metres(f.geometry.coordinates as [number, number], g.coordinates);
        if (m < best) {
          best = m;
          match = f;
        }
      }
    }
    const props = forecastProperties(g, d, forecastBy.get(g.lid), now);
    if (match) {
      used.add(match);
      Object.assign(match.properties ??= {}, props);
      joined++;
      continue;
    }
    if (!g.observed) continue;
    const extra: Record<string, unknown> = { name: g.name, kind: "nws", t: g.observed.time, ...props };
    if (g.observed.flowCfs !== undefined) extra.v = g.observed.flowCfs;
    added.push({ type: "Feature", geometry: { type: "Point", coordinates: g.coordinates }, properties: extra });
  }
  const notes: string[] = [];
  if (gauges.length > detailFor.length) notes.push(`flood stages looked up for ${detailFor.length} of ${gauges.length} NWS gauges`);
  return { added, joined, forecasts: forecastBy.size, ...(notes.length > 0 && { note: notes.join("; ") }) };
}

// ---- Dam releases (USACE CWMS) ----

/** Releases people paddle, with the Corps' series for observed and forecast outflow. Add one only after checking it live. */
export const RELEASES: { name: string; river: string; office: string; observed: string; forecast?: string; coordinates: [number, number]; timeZone: string; note: string }[] = [
  {
    name: "Gauley River below Summersville Dam (dam release)",
    river: "Gauley",
    office: "LRH",
    observed: "Summersville-Outflow.Flow.Inst.15Minutes.0.OBS",
    forecast: "Summersville-Outflow.Flow.Inst.1Hour.0.CELRH-FCST-DAILY",
    // The NWS gauge SUMW2 "Gauley River below Summersville Lake", at the dam's outlet: its stage joins this feature.
    coordinates: [-80.8882, 38.2151],
    timeZone: "America/New_York",
    note: "The Upper Gauley runs on this release; the Corps schedules recreational releases on fall weekends (Gauley Season).",
  },
];

const CwmsSchema = z.object({ units: z.string().optional(), values: z.array(z.tuple([z.number(), z.number().nullable()]).rest(z.unknown())) });

/** The newest reading and each local day's highest forecast release, from CWMS bodies. */
export function releaseProperties(
  r: (typeof RELEASES)[number],
  observedBody: unknown,
  forecastBody: unknown,
  now: Date,
): Record<string, unknown> | null {
  const obs = CwmsSchema.safeParse(observedBody);
  const values = obs.success ? obs.data.values.filter((v) => v[1] !== null && v[0] <= now.getTime()) : [];
  if (values.length === 0) return null;
  const last = values[values.length - 1];
  const p: Record<string, unknown> = {
    name: r.name,
    kind: "release",
    t: new Date(last[0]).toISOString(),
    v: Math.round(last[1] as number),
    releaseNote: r.note,
    cwmsLink: "https://water.usace.army.mil/",
  };
  const fc = CwmsSchema.safeParse(forecastBody);
  if (fc.success) {
    const days = new Map<string, number>();
    for (const [ms, val] of fc.data.values) {
      if (val === null || ms < now.getTime() - 3_600_000) continue;
      const day = localDay(new Date(ms).toISOString(), r.timeZone);
      days.set(day, Math.max(days.get(day) ?? 0, val));
    }
    if (days.size > 0) p.releaseForecast = [...days.entries()].map(([d, v]) => `${d}: up to ${cfs(v)}`);
  }
  return p;
}

/** Dam-release features for the RELEASES inside the box (one CWMS call each for observed and forecast flow). */
export async function releaseFeatures(ctx: QueryContext, bbox: BBox, now: Date): Promise<Feature<Point>[]> {
  const inside = RELEASES.filter((r) => r.coordinates[0] >= bbox[0] && r.coordinates[0] <= bbox[2] && r.coordinates[1] >= bbox[1] && r.coordinates[1] <= bbox[3]);
  const begin = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const end = new Date(now.getTime() + 8 * 86_400_000).toISOString();
  const headers = { accept: "application/json;version=2" };
  const hour = now.toISOString().slice(0, 13);
  const out: Feature<Point>[] = [];
  for (const r of inside) {
    const url = (name: string) => `${CWMS}/timeseries?office=${r.office}&name=${encodeURIComponent(name)}&begin=${begin}&end=${end}&unit=EN`;
    const [o, f] = await Promise.all([
      getJson(ctx, url(r.observed), `streamflow:cwms:${r.observed}:${hour}`, 900, headers),
      r.forecast ? getJson(ctx, url(r.forecast), `streamflow:cwms:${r.forecast}:${hour}`, 1_800, headers) : Promise.resolve(null),
    ]);
    const p = releaseProperties(r, o, f, now);
    if (p) out.push({ type: "Feature", geometry: { type: "Point", coordinates: r.coordinates }, properties: p });
  }
  return out;
}

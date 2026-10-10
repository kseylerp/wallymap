/**
 * How much warmer or cooler than normal each county of the contiguous US was over a month, a season or a year, from
 * NOAA NCEI Climate at a Glance (county mapping), joined to county outlines.
 *
 * Verified live 2026-10-10 ~10:20 UTC:
 *   https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping/110/tavg/{YYYYMM}/{months}/data.json
 *     -> { description: { title: "September 2026 Contiguous U.S. County Average Temperature", anomalies: "1901-2000 base
 *        period", units: "Degrees Fahrenheit", "period of record": "132 years" }, data: { "AL-001": { name, stateAbbr,
 *        value, anomaly, rank, mean }, ... } } for 3,107 counties (414 KB, under 1 s). Key is state abbreviation and
 *        three-digit county FIPS. `months` 1, 3 or 12 is the length of the period ending in YYYYMM (3 = "July - September
 *        2026"). rank runs from 1 (coldest of the record) to the number of years (warmest).
 *     A month not published yet answers 404 with an HTML page (202610 on 2026-10-10; 202609 was already out). The
 *     archive starts in 1895. Connecticut is still its 8 old counties, which do not match the 2022 planning regions in
 *     the outlines, so Connecticut is left out (noted in the result).
 *   Outlines: layers/_shared/counties.ts (Esri Living Atlas generalized counties, cached a week).
 * Without a period the layer tries last month, then the month before. Published periods do not change, so they are
 * cached for a week; a 404 is not cached.
 *
 * Live smoke 2026-10-10, SF Bay box [-122.7,37.2,-121.7,38.2], latest (September 2026, 1 month): 10 counties; San
 * Francisco +1.9 °F (63.8 against a 61.9 normal, 25th warmest of 132 Septembers), Alameda +0.8. Lower 48 box
 * [-125,24,-66,50] with months=12 (October 2025 - September 2026): 3,098 counties (two outline pages) in about 1 s warm;
 * Bibb County AL +2.6 °F, 2nd warmest of 131 such years.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { countiesInBbox, type County } from "./_shared/counties";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping/110/tavg";
const TTL_SECONDS = 7 * 86_400;

const inputSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}(0[1-9]|1[0-2])$/)
    .optional(),
  months: z.union([z.literal(1), z.literal(3), z.literal(12)]).default(1),
});

const entrySchema = z.object({
  name: z.string().optional(),
  stateAbbr: z.string().optional(),
  value: z.number().nullish(),
  anomaly: z.number().nullish(),
  rank: z.number().nullish(),
  mean: z.number().nullish(),
});
const bodySchema = z.object({
  description: z.object({ title: z.string().optional(), "period of record": z.string().optional() }).optional(),
  data: z.record(z.string(), z.unknown()),
});
export type AnomalyTable = z.infer<typeof bodySchema>;

export function anomalyUrl(period: string, months: number): string {
  return `${BASE}/${period}/${months}/data.json`;
}

/** The month before `now` (UTC) and the one before that, as YYYYMM: the newest periods NOAA may have published. */
export function latestCandidates(now: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let back = 1; back <= 2; back++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    out.push(`${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** ISO date of the last day of the period's final month. */
export function periodEnd(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6));
  return new Date(Date.UTC(y, m, 0)).toISOString();
}

/** "September 2026" from the title, without the trailing "Contiguous U.S. County Average Temperature". */
function periodLabel(title: string | undefined, period: string): string {
  const label = title?.replace(/\s*Contiguous U\.S\..*$/i, "").trim();
  return label && label.length > 0 ? label : period;
}

/** County polygons with `v` = anomaly °F, `t` = period end, joined by state abbreviation and county FIPS. */
export function joinAnomalies(counties: County[], table: AnomalyTable, period: string, months: number): { features: Feature<Geometry>[]; unmatched: County[] } {
  const years = Number(table.description?.["period of record"]?.match(/\d+/)?.[0] ?? Number.NaN);
  const label = periodLabel(table.description?.title, period);
  const t = periodEnd(period);
  const features: Feature<Geometry>[] = [];
  const unmatched: County[] = [];
  for (const county of counties) {
    const parsed = entrySchema.safeParse(table.data[`${county.stateAbbr}-${county.countyFips}`]);
    if (!parsed.success || typeof parsed.data.anomaly !== "number") {
      unmatched.push(county);
      continue;
    }
    const e = parsed.data;
    const props: Record<string, string | number> = {
      name: county.name,
      state: county.stateAbbr,
      fips: county.fips,
      v: e.anomaly as number,
      kind: (e.anomaly as number) > 0 ? "warmer" : (e.anomaly as number) < 0 ? "cooler" : "normal",
      t,
      period: label,
      months,
    };
    if (typeof e.value === "number") props.averageF = e.value;
    if (typeof e.mean === "number") props.normalF = e.mean;
    if (typeof e.rank === "number" && Number.isFinite(years)) {
      props.warmestRank = years - e.rank + 1;
      props.years = years;
    }
    features.push({ type: "Feature", geometry: county.geometry, properties: props });
  }
  return { features, unmatched };
}

type Fetched = { ok: true; table: AnomalyTable; period: string } | { ok: false; error: string; notPublished?: boolean };

async function fetchTable(ctx: QueryContext, period: string, months: number): Promise<Fetched> {
  try {
    const res = await ctx.fetch(anomalyUrl(period, months), {
      cacheKey: `temperature-anomaly:${period}:${months}`,
      ttlSeconds: TTL_SECONDS,
      validate: (body) => body.trimStart().startsWith("{"),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (res.status === 404) return { ok: false, error: `NOAA has no county temperatures for ${period} yet`, notPublished: true };
    if (!res.ok) return { ok: false, error: `NOAA Climate at a Glance returned ${res.status}` };
    const parsed = bodySchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, error: "NOAA Climate at a Glance returned an unexpected response" };
    return { ok: true, table: parsed.data, period };
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return { ok: false, error: timedOut ? `NOAA Climate at a Glance timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : "NOAA Climate at a Glance returned no usable response" };
  }
}

const temperatureAnomaly = defineLayer({
  id: "temperature-anomaly",
  title: "Temperature anomaly by county (NOAA)",
  description:
    "How much warmer or cooler than normal each county was, from NOAA's Climate at a Glance, for the contiguous United States only (the lower 48; not Alaska or Hawaii). " +
    "Each polygon is a county with v (the anomaly in degrees Fahrenheit, °F: the period's average temperature minus the 1901-2000 average for the same months; +3 means 3 °F warmer than the 20th-century normal), " +
    "kind ('warmer', 'cooler' or 'normal'), averageF (the period's average temperature), normalF (the 1901-2000 average), warmestRank (1 = the warmest on record since 1895, out of years), period (e.g. 'September 2026'), months and t (the period's last day). " +
    "period is the final month as YYYYMM (default: the newest NOAA has published, usually last month, out about the 8th); months is 1 (that month), 3 (the three months ending then, a season) or 12 (the year ending then). " +
    "Example questions: 'Was this summer hotter than normal here?', 'Which counties had a record warm year?', 'How unusual was last month's heat in Texas?'. User words: warming, temperature anomaly, hotter than normal. " +
    "Caveats: the baseline is 1901-2000, so most recent periods read warm against it; county values are area averages from a gridded dataset, not one station; the newest month can be revised slightly. " +
    "Connecticut is missing (NOAA still uses its old counties). The map view must be under 16,000,000 km² (the lower 48 fit).",
  coverage: "us",
  license: "Public domain (NOAA NCEI); county outlines Esri / US Census Bureau",
  requiredEnv: [],
  maxAreaKm2: 16_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("temperature-anomaly"), unit: "°F", fillOpacity: 0.6 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const now = Date.now();
    const citation = {
      source: "NOAA National Centers for Environmental Information, Climate at a Glance: County Mapping (public domain); county outlines Esri Living Atlas / US Census Bureau",
      url: "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping",
      retrieved: new Date(now).toISOString(),
    };
    if (outsideUs(ctx.bbox)) return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };

    const countiesP = countiesInBbox(ctx, ctx.bbox);
    let fetched: Fetched = { ok: false, error: "no period" };
    for (const period of input.period !== undefined ? [input.period] : latestCandidates(now)) {
      fetched = await fetchTable(ctx, period, input.months);
      if (fetched.ok || !fetched.notPublished) break;
    }
    const counties = await countiesP;
    if (!fetched.ok) return fetched.notPublished ? { error: fetched.error } : { error: fetched.error, hint: "upstream" };
    if (!counties.ok) return { error: counties.error, hint: "upstream" };

    const { features, unmatched } = joinAnomalies(counties.counties, fetched.table, fetched.period, input.months);
    const notes = [`${periodLabel(fetched.table.description?.title, fetched.period)}, °F against the 1901-2000 average`];
    if (unmatched.some((c) => c.stateAbbr === "CT")) notes.push("Connecticut has no county values (NOAA uses its old counties)");
    if (features.length === 0) notes.push("No contiguous-US counties in this view; NOAA county anomalies do not cover Alaska, Hawaii or territories");
    if (counties.truncated) notes.push("Too many counties to show them all; zoom in");
    const data: FeatureCollection = { type: "FeatureCollection", features };
    return { kind: "geojson", data, citation, coverageNote: notes.join("; ") };
  },
});

registerLayer(temperatureAnomaly);

export default temperatureAnomaly;

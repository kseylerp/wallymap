/**
 * River flow by month of the year at USGS stream gauges (spec T10 "River flow by month"): for each gauge in the box,
 * the median of each calendar month's mean flow over the gauge's whole record, the month it runs highest and lowest
 * with their cfs, and the monthly strip of the largest river under the map.
 *
 * A layer of its own, not a mode of `streamflow`: streamflow answers "how high is the river now" from live readings
 * and draws the network every 15 minutes; this answers "when in the year is it highest" from a record of decades, one
 * small fetch per box, with its own card and strip, so the model never mixes the two and streamflow stays untouched.
 *
 * Gauges in the box: the USGS instantaneous values service (layers/_shared/usgs.ts), active stream sites with a
 * discharge reading, largest flow now first, up to STAT_SITES (the statistics service takes at most 10 sites a call).
 * Monthly statistics: https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=A,B&statReportType=monthly
 * &statTypeCd=mean&parameterCd=00060, keyless. RDB: `#` comment lines, a header (agency_cd, site_no, parameter_cd,
 * ts_id, loc_web_ds, year_nu, month_nu, mean_va), a column-width row, then one row per year and month with that month's
 * mean flow in cfs. A site may have more than one time series (ts_id); the longest is used.
 * Verified live 2026-10-23: Merced River at Happy Isles Bridge (11264500) from October 1915, 2024 May 1,698 cfs and
 * September 13 cfs; Merced River at Pohono Bridge (11266500) in the same Yosemite Valley box.
 */
import { z } from "zod";
import type { Feature } from "geojson";
import { defineLayer, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type MonthlyStrip, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { amountText, highestMonth, lowestMonth, median, MONTH_NAMES, MONTH_SHORT } from "./_shared/months";
import { fetchIv, parseIv, type IvSite } from "./_shared/usgs";
import { gaugeName } from "./streamflow";
import { layerColor } from "@/lib/render/palette";

const STAT_URL = "https://waterservices.usgs.gov/nwis/stat/";
const USGS_STATS_URL = "https://waterservices.usgs.gov/docs/statistics/";
/** Most gauges looked up (one statistics call). */
export const STAT_SITES = 10;
/** The monthly record changes once a month at most. */
const STAT_TTL_SECONDS = 7 * 86_400;
const IV_TTL_SECONDS = 600;
/** A month this close to the peak (share of it) is named beside it ("May close behind"). */
const CLOSE_BEHIND = 0.8;

const inputSchema = z.object({
  site: z
    .string()
    .regex(/^(?:USGS-)?\d{8,15}$/)
    .optional(),
});

export type GaugeMonths = {
  siteNo: string;
  /** Median over the years of each calendar month's mean flow, cfs, January first. */
  medianCfs: (number | null)[];
  meanCfs: (number | null)[];
  firstYear: number;
  lastYear: number;
  years: number;
};

/** The monthly report (RDB) into each site's monthly medians; sites with no rows are left out. */
export function parseMonthlyStats(rdb: string): Map<string, GaugeMonths> {
  const lines = rdb.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const out = new Map<string, GaugeMonths>();
  if (lines.length < 2) return out;
  const header = lines[0].split("\t");
  const col = (name: string) => header.indexOf(name);
  const [iSite, iTs, iYear, iMonth, iMean] = [col("site_no"), col("ts_id"), col("year_nu"), col("month_nu"), col("mean_va")];
  if ([iSite, iYear, iMonth, iMean].some((i) => i < 0)) return out;
  // site → ts_id → rows
  const bySeries = new Map<string, Map<string, { year: number; month: number; value: number }[]>>();
  for (const line of lines.slice(2)) {
    const cells = line.split("\t");
    const site = cells[iSite]?.trim();
    const year = Number(cells[iYear]);
    const month = Number(cells[iMonth]);
    const value = Number(cells[iMean]);
    if (!site || !Number.isInteger(year) || !(month >= 1 && month <= 12) || cells[iMean]?.trim() === "" || !Number.isFinite(value) || value < 0) continue;
    const ts = iTs >= 0 ? (cells[iTs]?.trim() ?? "") : "";
    const series = bySeries.get(site) ?? new Map();
    bySeries.set(site, series);
    const rows = series.get(ts) ?? [];
    series.set(ts, rows);
    rows.push({ year, month, value });
  }
  for (const [site, series] of bySeries) {
    const rows = [...series.values()].sort((a, b) => b.length - a.length)[0];
    if (!rows || rows.length === 0) continue;
    const byMonth: number[][] = Array.from({ length: 12 }, () => []);
    for (const r of rows) byMonth[r.month - 1].push(r.value);
    const years = new Set(rows.map((r) => r.year));
    const round = (v: number | undefined) => (v === undefined ? null : v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    out.set(site, {
      siteNo: site,
      medianCfs: byMonth.map((xs) => round(median(xs))),
      meanCfs: byMonth.map((xs) => round(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined)),
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      years: years.size,
    });
  }
  return out;
}

const cfs = (v: number) => `${amountText(v)} cfs`;

/** "June, median 2,170 cfs (May close behind at 1,960 cfs)": the peak month and a neighbour within 80% of it. */
export function peakWords(m: GaugeMonths): string | undefined {
  const peak = highestMonth(m.medianCfs);
  if (!peak) return undefined;
  const neighbours = [(peak.month + 11) % 12, (peak.month + 1) % 12]
    .map((month) => ({ month, value: m.medianCfs[month] }))
    .filter((n): n is { month: number; value: number } => typeof n.value === "number" && n.value >= CLOSE_BEHIND * peak.value)
    .sort((a, b) => b.value - a.value);
  const close = neighbours[0] ? ` (${MONTH_NAMES[neighbours[0].month]} close behind at ${cfs(neighbours[0].value)})` : "";
  return `${MONTH_NAMES[peak.month]}, median ${cfs(peak.value)} for the month${close}`;
}

export function gaugeFeature(site: IvSite, m: GaugeMonths): Feature {
  const peak = highestMonth(m.medianCfs);
  const low = lowestMonth(m.medianCfs);
  const now = site.readings["00060"]?.value;
  const name = gaugeName(site.name);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: site.coordinates },
    properties: {
      name,
      ...(name !== site.name && { nameInSource: site.name }),
      siteNo: site.siteNo,
      v: peak?.value ?? null,
      ...(peak && { peak: `${MONTH_NAMES[peak.month]}: ${cfs(peak.value)}`, peakMonth: MONTH_NAMES[peak.month] }),
      ...(low && { low: `${MONTH_NAMES[low.month]}: ${cfs(low.value)}`, lowMonth: MONTH_NAMES[low.month] }),
      ...(now !== undefined && { nowCfs: now }),
      period: `${m.firstYear}–${m.lastYear} (${m.years} years)`,
      medianCfs: m.medianCfs,
      meanCfs: m.meanCfs,
      url: `https://waterdata.usgs.gov/monitoring-location/USGS-${site.siteNo}/`,
    },
  };
}

/** The monthly strip for one gauge: median flow by month as bars. */
export function flowStrip(name: string, m: GaugeMonths): MonthlyStrip {
  const period = `${m.firstYear}–${m.lastYear}`;
  return {
    place: name,
    period,
    rows: [{ kind: "bars", key: "flow", label: "River flow", unit: "cfs", values: m.medianCfs, legend: `Bars: median of each month's mean flow, ${period} (${m.years} years)` }],
    source: "USGS",
  };
}

/** "Jan 52; Feb 101; ...": every month's median for the note. */
function monthsLine(m: GaugeMonths): string {
  return MONTH_SHORT.map((s, i) => `${s} ${m.medianCfs[i] === null ? "–" : amountText(m.medianCfs[i] as number)}`).join("; ");
}

const HELP: Record<string, FieldHelp> = {
  v: { text: "The median flow of the gauge's highest month: each year's mean flow for that calendar month, the middle value over the record.", unit: "cubic feet per second", source: "USGS NWIS monthly statistics", url: USGS_STATS_URL },
  peak: { text: "The calendar month the river usually runs highest, with the median of that month's mean flow over the record.", unit: "cubic feet per second", source: "USGS", url: USGS_STATS_URL },
  low: { text: "The calendar month the river usually runs lowest, with its median mean flow.", unit: "cubic feet per second", source: "USGS", url: USGS_STATS_URL },
  nowCfs: { text: "The newest reading at the gauge (15-minute data, provisional).", unit: "cubic feet per second", source: "USGS", url: "https://waterservices.usgs.gov/" },
  period: { text: "The years of record the monthly medians are taken over." },
};

const CARD: CardSpec = {
  measure: { key: "v", label: "Highest month's flow", unit: "cfs" },
  facts: [
    { key: "peak", label: "Highest month" },
    { key: "low", label: "Lowest month" },
    { key: "nowCfs", label: "Flow now", unit: "cfs", format: "int" },
    { key: "period", label: "Years of record" },
  ],
  links: [{ key: "url", label: "Open on USGS Water Data" }],
  hidden: ["siteNo", "medianCfs", "meanCfs", "peakMonth", "lowMonth", "nameInSource"],
};

async function fetchStats(ctx: QueryContext, sites: string[]): Promise<string | null> {
  const ids = [...sites].sort();
  try {
    const res = await ctx.fetch(`${STAT_URL}?format=rdb&sites=${ids.join(",")}&statReportType=monthly&statTypeCd=mean&parameterCd=00060`, {
      cacheKey: `flow-by-month:stat:${ids.join(",")}`,
      ttlSeconds: STAT_TTL_SECONDS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const flowByMonth = defineLayer({
  id: "flow-by-month",
  title: "River flow by month",
  description:
    "When in the year a river runs highest and lowest: the median flow of each calendar month at the USGS stream gauges in the box, over each gauge's whole record (often 50 to 110 years). " +
    "site (a USGS site number, such as 11266500) picks one gauge; without it the box's gauges are read, the largest river first. " +
    "For 'when is the river highest', 'when does the snowmelt peak', 'when is the waterfall biggest'; the flow now is streamflow. " +
    "The coverageNote gives each gauge's peak and low month in cfs and every month for the largest: lead with the peak month and its cfs. " +
    "Draws the gauges and the largest river's flow by month as bars in the monthly strip under the map. " +
    "Caveats: dams upstream change the timing; a year can run far above or below the median.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS)",
  requiredEnv: [],
  maxAreaKm2: 200_000,
  input: inputSchema,
  style: { geometry: "point", color: layerColor("flow-by-month"), unit: "cfs" },
  fieldHelp: HELP,
  card: CARD,
  labels: { field: "name", max: 5, rankBy: "v" },
  time: { shape: "none" },
  display: { units: "us" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = { source: "USGS National Water Information System, monthly statistics of daily mean discharge (public domain)", url: USGS_STATS_URL, retrieved: new Date().toISOString(), label: "USGS (NWIS monthly statistics)" };
    const empty = { type: "FeatureCollection" as const, features: [] };
    if (outsideUs(ctx.bbox)) return { kind: "geojson", data: empty, citation, coverageNote: OUTSIDE_US_NOTE };
    const iv = await fetchIv(ctx, ["00060"], "flow-by-month", IV_TTL_SECONDS);
    if (!iv.ok) return { error: iv.error, hint: "upstream" };
    const wanted = input.site?.replace(/^USGS-/, "");
    const sites = parseIv(iv.bodies, new Date())
      .filter((s) => s.readings["00060"] !== undefined && (wanted === undefined || s.siteNo === wanted))
      .sort((a, b) => (b.readings["00060"]?.value ?? 0) - (a.readings["00060"]?.value ?? 0))
      .slice(0, STAT_SITES);
    if (sites.length === 0) {
      return { kind: "geojson", data: empty, citation, coverageNote: wanted ? `Gauge ${wanted} has no discharge reading in this box; widen the box around it` : "No USGS stream gauge with a discharge reading in this box" };
    }
    const rdb = await fetchStats(ctx, sites.map((s) => s.siteNo));
    if (rdb === null) return { error: "The USGS statistics service did not answer", hint: "upstream" };
    const stats = parseMonthlyStats(rdb);
    const read = sites
      .map((site) => ({ site, months: stats.get(site.siteNo) }))
      .filter((r): r is { site: IvSite; months: GaugeMonths } => r.months !== undefined && r.months.medianCfs.some((v) => v !== null));
    if (read.length === 0) return { kind: "geojson", data: empty, citation, coverageNote: "USGS has no monthly flow record for the gauges in this box" };
    const yearly = (m: GaugeMonths) => m.medianCfs.reduce<number>((s, v) => s + (v ?? 0), 0);
    read.sort((a, b) => yearly(b.months) - yearly(a.months));
    const features = read.map((r) => gaugeFeature(r.site, r.months));
    const [top, ...rest] = read;
    const topName = String(features[0].properties?.name);
    const low = lowestMonth(top.months.medianCfs);
    const lowWords = low ? `, and lowest in ${MONTH_NAMES[low.month]} at ${cfs(low.value)}` : "";
    const lead = `${topName} (USGS ${top.site.siteNo}) runs highest in ${peakWords(top.months)}${lowWords}; medians of each month's mean flow over ${top.months.firstYear}–${top.months.lastYear} (${top.months.years} years)`;
    const others = rest
      .slice(0, 5)
      .map((r, i) => {
        const p = highestMonth(r.months.medianCfs);
        return p ? `${features[i + 1].properties?.name}: highest in ${MONTH_NAMES[p.month]}, ${cfs(p.value)}` : undefined;
      })
      .filter(Boolean);
    const note = `${lead}. By month (median cfs): ${monthsLine(top.months)}${others.length ? `. Other gauges: ${others.join("; ")}` : ""}`;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      coverageNote: note,
      months: flowStrip(topName, top.months),
      title: `River flow by month (${features.length} gauge${features.length === 1 ? "" : "s"})`,
    };
  },
});

registerLayer(flowByMonth);

export default flowByMonth;

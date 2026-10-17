import type { Feature } from "geojson";
import type { Attribute, LinkedSeries, SeriesAxis } from "@/layers/types";

/**
 * The shape of a series for the note (spec §13: "the caption follows the data's shape"): the low and the peak with
 * numbers and dates, the ratio between them, whether it repeats, the features that drive it, the forecast's end, and
 * for a linked curve (the tide) its biggest swing. Computed over every feature, so the note can quote it.
 */
export type SeriesStory = {
  /** What the numbers are: the measure, its unit, and which feature they follow. */
  measure: string;
  frames: { from: string; to: string; now: string; step: "day" | "hour"; count: number; forecastFrom?: string };
  low: { value: number; date: string };
  peak: { value: number; date: string };
  /** peak ÷ low, one decimal ("more than quadruples" is a ratio over 4). */
  ratio: number | null;
  /** At the newest reading, and where the forecast ends. */
  now: { value: number; date: string };
  forecastEnd?: { value: number; date: string };
  /** "Repeats about every 12.4 hours" or why a repeat cannot be told from this span. */
  repeats: string;
  /** The forecast frames' highest values: the places (features) where the measure peaks, highest first. */
  forecastTop?: { name: string; value: number; date: string }[];
  /**
   * Hourly series: tomorrow by local solar time (UTC plus the longitude's hours), the three places where the measure
   * peaks, highest first, with the local hour ("where is the wind strongest tomorrow").
   */
  tomorrowTop?: { name: string; value: number; localHour: string; date: string }[];
  /** The named features that swelled most against their own median, largest first. */
  drivers?: { name: string; peakOverMedian: number; peakDate: string }[];
  /**
   * The note's skeleton in the data's shape (spec §13): the low and the peak with numbers and dates, the ratio in words,
   * the repeat, the drivers, the linked curve's swing; the caller adds what size and color mean.
   */
  caption?: string;
  /** A linked curve's range and its biggest swing within half a day. */
  linked?: { label: string; place: string; unit: string; low: number; high: number; biggestSwing?: string; repeats?: string };
};

/** A ratio in words: 2.7 "nearly triples", 4.4 "more than quadruples", 1.3 "rises by about 30%". */
export function ratioWords(r: number): string {
  if (!Number.isFinite(r) || r < 1.15) return "barely changes";
  if (r < 1.75) return `rises by about ${Math.round((r - 1) * 10) * 10}%`;
  if (r < 2.25) return "about doubles";
  if (r < 2.6) return "more than doubles";
  if (r < 3) return "nearly triples";
  if (r < 3.4) return "about triples";
  if (r < 3.75) return "more than triples";
  if (r < 4.25) return "about quadruples";
  if (r < 5) return "more than quadruples";
  return `rises about ${Math.round(r)}-fold`;
}

/** A driver's median must reach this (in the measure's unit): a creek's tenfold rise from almost nothing says little. */
const MIN_DRIVER = 20;

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

function seriesOf(f: Feature, key: string): (number | null)[] | undefined {
  const arr = (f.properties?.series as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(arr) ? (arr as (number | null)[]) : undefined;
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The period of a series, when it has one: the lag (in frames) of the first clear peak of its autocorrelation after the
 * correlation has first fallen below zero, with that correlation, or null when no such peak reaches 0.5. A smooth
 * series that only drifts (a river over one season) matches itself at short lags but never comes back, so it has no
 * period; a tide comes back about every 12.4 hours.
 */
export function repeatLag(values: (number | null)[], minLag = 2): { lag: number; r: number } | null {
  const xs = values.map((v) => (num(v) ? v : null));
  const known = xs.filter(num);
  if (known.length < minLag * 4) return null;
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  const variance = known.reduce((a, b) => a + (b - mean) ** 2, 0) / known.length;
  if (variance === 0) return null;
  const r = (lag: number) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i + lag < xs.length; i++) {
      const a = xs[i];
      const b = xs[i + lag];
      if (a === null || b === null) continue;
      sum += (a - mean) * (b - mean);
      n += 1;
    }
    return n >= 4 ? sum / n / variance : Number.NaN;
  };
  // At least three cycles in the data before calling it a repeat: two pulses forty days apart in ninety are not a cycle.
  const max = Math.floor(xs.length / 3);
  let lag = minLag;
  while (lag <= max && !(r(lag) < 0)) lag += 1;
  let best: { lag: number; r: number } | null = null;
  for (; lag <= max; lag++) {
    const here = r(lag);
    if (!Number.isFinite(here)) continue;
    if (!best || here > best.r) best = { lag, r: here };
    else if (best.r > 0.5 && here < best.r - 0.1) break;
  }
  return best && best.r > 0.6 ? { lag: best.lag, r: Math.round(best.r * 100) / 100 } : null;
}

/** The biggest rise or fall within `window` frames: "dropped 9.4 m in 6 hours, 03:00 to 09:00 on Oct 18". */
export function biggestSwing(times: string[], values: (number | null)[], window: number, unit: string, step: "day" | "hour"): string | undefined {
  let best: { d: number; i: number; j: number } | null = null;
  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    if (!num(a)) continue;
    for (let j = i + 1; j <= Math.min(values.length - 1, i + window); j++) {
      const b = values[j];
      if (!num(b)) continue;
      if (!best || Math.abs(b - a) > Math.abs(best.d)) best = { d: b - a, i, j };
    }
  }
  if (!best || best.d === 0) return undefined;
  const span = best.j - best.i;
  const when = (t: string) => (step === "hour" ? `${t.slice(11, 16)} UTC ${t.slice(0, 10)}` : t.slice(0, 10));
  return `${best.d < 0 ? "dropped" : "rose"} ${round(Math.abs(best.d))} ${unit} in ${span} ${step === "hour" ? "hours" : "days"}, ${when(times[best.i])} to ${when(times[best.j])}`;
}

/**
 * The story of a series result: the feature with the most of the layer's aggregate measure (the largest river reach,
 * the strongest current cell) gives the low, peak and ratio over the observed frames; the drivers are the named features
 * whose peak stands highest over their own median.
 */
export function seriesStory(
  features: Feature[],
  series: SeriesAxis,
  attributes: Attribute[] | undefined,
  linked?: LinkedSeries,
): SeriesStory | undefined {
  const measure = (attributes ?? []).find((a) => a.type === "measure" && a.aggregate !== undefined) ?? (attributes ?? []).find((a) => a.type === "measure");
  if (!measure) return undefined;
  const key = measure.key;
  const rows = features
    .map((f) => ({ f, s: seriesOf(f, key) }))
    .filter((x): x is { f: Feature; s: (number | null)[] } => x.s !== undefined && x.s.some(num));
  if (rows.length === 0) return undefined;
  const meanOf = (s: (number | null)[]) => {
    const v = s.slice(0, series.now + 1).filter(num);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : -Infinity;
  };
  // A measure totalled over some features (river pulse: its outlets) follows that total; otherwise the feature with the
  // most of it.
  const over = measure.aggregate === "sum" ? measure.aggregateOver : undefined;
  const totalled = over ? rows.filter((x) => x.f.properties?.[over] === true) : [];
  const lead =
    totalled.length > 0
      ? {
          f: { type: "Feature", geometry: null, properties: { name: undefined } } as unknown as Feature,
          s: series.times.map((_, k) => {
            const vals = totalled.map((x) => x.s[k]).filter(num);
            return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
          }),
        }
      : rows.reduce((best, x) => (meanOf(x.s) > meanOf(best.s) ? x : best));
  const totalLabel = totalled.length > 0 ? (measure.aggregateLabel ?? `Total ${measure.label.toLowerCase()}`) : undefined;
  const observed = lead.s.slice(0, series.now + 1);
  let lo = -1;
  let hi = -1;
  observed.forEach((v, k) => {
    if (!num(v)) return;
    if (lo < 0 || v < (observed[lo] as number)) lo = k;
    if (hi < 0 || v > (observed[hi] as number)) hi = k;
  });
  if (lo < 0 || hi < 0) return undefined;
  const t = series.times;
  const day = (k: number) => (series.step === "hour" ? t[k].slice(0, 16).replace("T", " ") + " UTC" : t[k].slice(0, 10));
  const low = observed[lo] as number;
  const peak = observed[hi] as number;
  const unit = measure.unit ? ` (${measure.unit})` : "";
  const name = typeof lead.f.properties?.name === "string" ? lead.f.properties.name : undefined;
  const lag = repeatLag(lead.s);
  const stepWord = series.step === "hour" ? "hours" : "days";
  const repeats = lag
    ? `Repeats about every ${lag.lag} ${stepWord} (correlation ${lag.r.toFixed(2)})`
    : series.step === "day"
      ? `No repeat within these ${t.length} days; they cover part of one year, so a yearly cycle cannot be seen`
      : `No regular repeat within these ${t.length} hours`;
  const end = lead.s.length - 1;
  const leadPast = observed.filter(num).sort((a, b) => a - b);
  const leadMedian = leadPast.length ? leadPast[Math.floor(leadPast.length / 2)] : 0;
  const drivers = rows
    .map(({ f, s }) => {
      const past = s.slice(0, series.now + 1).filter(num).sort((a, b) => a - b);
      const med = past.length ? past[Math.floor(past.length / 2)] : 0;
      let k = -1;
      s.slice(0, series.now + 1).forEach((v, i) => {
        if (num(v) && (k < 0 || v > (s[k] as number))) k = i;
      });
      return { name: String(f.properties?.name ?? ""), ratio: med > 0 && k >= 0 ? (s[k] as number) / med : 0, k, median: med };
    })
    .filter((d) => d.name && d.name !== "Unnamed river" && d.ratio > 1.15 && d.median >= Math.max(MIN_DRIVER, leadMedian * 0.03))
    .sort((a, b) => b.ratio - a.ratio);
  const seen = new Set<string>();
  const top = drivers.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true))).slice(0, 3);
  // Where the forecast frames peak (the windiest places tomorrow): each feature's highest forecast value, top three.
  const forecastTop =
    series.forecastFrom !== undefined
      ? rows
          .map(({ f, s }) => {
            let k = -1;
            for (let i = series.forecastFrom ?? 0; i < s.length; i++) if (num(s[i]) && (k < 0 || (s[i] as number) > (s[k] as number))) k = i;
            return { name: String(f.properties?.name ?? ""), value: k >= 0 ? (s[k] as number) : -Infinity, k };
          })
          .filter((x) => x.k >= 0 && x.name)
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((x) => ({ name: x.name, value: round(x.value), date: day(x.k) }))
      : [];
  // Tomorrow by local solar time (UTC + longitude / 15 hours), for an hourly forecast.
  const lons = features.flatMap((f) => (f.geometry?.type === "Point" ? [f.geometry.coordinates[0]] : []));
  const offsetH = lons.length > 0 ? Math.round(lons.reduce((a, b) => a + b, 0) / lons.length / 15) : 0;
  const localDay = (k: number) => new Date(Date.parse(t[k]) + offsetH * 3_600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${localDay(series.now)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const tomorrowFrames = series.step === "hour" ? t.map((_, k) => k).filter((k) => localDay(k) === tomorrow) : [];
  const tomorrowTop =
    tomorrowFrames.length >= 12
      ? rows
          .map(({ f, s }) => {
            let k = -1;
            for (const i of tomorrowFrames) if (num(s[i]) && (k < 0 || (s[i] as number) > (s[k] as number))) k = i;
            return { name: String(f.properties?.name ?? ""), value: k >= 0 ? (s[k] as number) : -Infinity, k };
          })
          .filter((x) => x.k >= 0 && x.name)
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((x) => ({
            name: x.name,
            value: round(x.value),
            localHour: `${String(new Date(Date.parse(t[x.k]) + offsetH * 3_600_000).getUTCHours()).padStart(2, "0")}:00 local solar time`,
            date: tomorrow,
          }))
      : [];
  const linkedStory =
    linked && linked.values.some(num)
      ? (() => {
          const vals = linked.values.filter(num);
          const swing = biggestSwing(linked.times, linked.values, series.step === "hour" ? 8 : 7, linked.unit, series.step);
          const cycle = repeatLag(linked.values);
          return {
            label: linked.label,
            place: linked.place,
            unit: linked.unit,
            low: round(Math.min(...vals)),
            high: round(Math.max(...vals)),
            ...(swing && { biggestSwing: swing }),
            ...(cycle && { repeats: `about every ${cycle.lag} ${stepWord}` }),
          };
        })()
      : undefined;
  const u = measure.unit ? ` ${measure.unit}` : "";
  const amount = (v: number) => `${round(v).toLocaleString("en-US")}${u}`;
  const hourly = series.step === "hour";
  const lowWord = hourly ? "weakest" : "lowest";
  const peakWord = hourly ? "strongest" : "peak";
  const ratio = low > 0 ? peak / low : null;
  const forecastLine =
    tomorrowTop.length > 0
      ? `Tomorrow (${tomorrow}) it is strongest at ${tomorrowTop.map((x) => `${x.name}, ${amount(x.value)} around ${x.localHour.replace(" local solar time", "")}`).join("; ")} (local solar time).`
      : forecastTop.length > 0
      ? `Ahead, it peaks at ${forecastTop.map((t) => `${amount(t.value)} at ${t.name} (${t.date})`).join(", ")}.`
      : end > series.now && num(lead.s[end])
        ? `The forecast ends at ${amount(lead.s[end] as number)} on ${day(end)}.`
        : "";
  const driverLine = top.length > 0 ? `Driven by ${top.map((d) => `the ${d.name} (${Math.round(d.ratio * 10) / 10}× its median, peaking ${day(d.k)})`).join(", ")}.` : "";
  const linkedLine = linkedStory
    ? `${linkedStory.label} at ${linkedStory.place} runs ${linkedStory.low} to ${linkedStory.high} ${linkedStory.unit}${linkedStory.repeats ? `, repeating ${linkedStory.repeats}` : ""}${linkedStory.biggestSwing ? `; it ${linkedStory.biggestSwing}` : ""}.`
    : "";
  const caption = [
    `${totalLabel ? `${totalLabel} (${totalled.length} outlets)` : `${measure.label} at ${name ?? "its highest point"}`}: ${lowWord} ${amount(low)} on ${day(lo)}, ${peakWord} ${amount(peak)} on ${day(hi)}${ratio !== null ? ` (it ${ratioWords(ratio)})` : ""}; now ${amount((lead.s[series.now] as number) ?? peak)}.`,
    `${repeats}.`,
    driverLine,
    forecastLine,
    linkedLine,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    caption,
    measure: totalLabel ? `${totalLabel}${unit}, ${totalled.length} outlets` : `${measure.label}${unit} where it is highest on average${name ? ` (${name})` : ""}`,
    frames: {
      from: t[0].slice(0, 10),
      to: t[t.length - 1].slice(0, 10),
      now: day(series.now),
      step: series.step,
      count: t.length,
      ...(series.forecastFrom !== undefined && { forecastFrom: day(series.forecastFrom) }),
    },
    low: { value: round(low), date: day(lo) },
    peak: { value: round(peak), date: day(hi) },
    ratio: low > 0 ? Math.round((peak / low) * 10) / 10 : null,
    now: { value: round((lead.s[series.now] as number) ?? peak), date: day(series.now) },
    ...(end > series.now && num(lead.s[end]) && { forecastEnd: { value: round(lead.s[end] as number), date: day(end) } }),
    repeats,
    ...(forecastTop.length > 0 && { forecastTop }),
    ...(tomorrowTop.length > 0 && { tomorrowTop }),
    ...(top.length > 0 && { drivers: top.map((d) => ({ name: d.name, peakOverMedian: Math.round(d.ratio * 10) / 10, peakDate: day(d.k) })) }),
    ...(linkedStory && { linked: linkedStory }),
  };
}

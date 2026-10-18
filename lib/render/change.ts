import type { Feature } from "geojson";

/**
 * Change between snapshots (docs/layer-contract.md `snapshots`), the pure half: which survey dates belong together
 * (epochs), which property names one thing across dates (a glacier's id), and the one-line change statement computed
 * from the data ("121 glaciers mapped in both the 1960s–70s and the 2010s lost 48% of their area"). Used by the time
 * panel, the compare strip and the model's summary, so all three say the same thing.
 */

const DAY_MS = 86_400_000;

function ms(iso: string): number {
  const s = /^\d{4}$/.test(iso) ? `${iso}-01-01` : /^\d{4}-\d{2}$/.test(iso) ? `${iso}-01` : iso;
  return Date.parse(s);
}

/** A feature's time value as epoch ms, or null. */
export function timeOf(f: Feature, timeField = "t"): number | null {
  const raw = f.properties?.[timeField];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1000 && raw <= 3000) return Date.UTC(raw, 0, 1);
  if (typeof raw !== "string") return null;
  const t = ms(raw.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * The survey epochs among sorted snapshot dates: dates closer together than a quarter of the widest gap between dates
 * are one campaign (glacier outlines from 1963, 1966 and 1974 against 2015 and 2019), every other date its own epoch
 * (land cover 2001, 2006 … 2021). Each epoch is its dates, oldest first; at least one epoch for one or more dates.
 */
export function snapshotEpochs(dates: readonly string[]): string[][] {
  const sorted = [...new Set(dates)].filter((d) => !Number.isNaN(ms(d))).sort((a, b) => ms(a) - ms(b));
  if (sorted.length === 0) return [];
  const gaps = sorted.slice(1).map((d, i) => ms(d) - ms(sorted[i]));
  const widest = Math.max(0, ...gaps);
  const epochs: string[][] = [[sorted[0]]];
  sorted.slice(1).forEach((d, i) => {
    if (gaps[i] < widest * 0.25) epochs[epochs.length - 1].push(d);
    else epochs.push([d]);
  });
  return epochs;
}

/** An epoch's window: its first date's start to its last date's end (whole UTC days), ISO. */
export function epochWindow(epoch: readonly string[]): [string, string] {
  const first = ms(epoch[0]);
  const last = ms(epoch[epoch.length - 1]);
  return [new Date(first).toISOString(), new Date(Math.floor(last / DAY_MS) * DAY_MS + DAY_MS - 1).toISOString()];
}

/**
 * An epoch as people say it: one year ("2015"), one decade ("the 1960s"), or two ("the 1960s–70s"); a span of
 * decades past that its first and last year ("1963–1994").
 */
export function epochLabel(epoch: readonly string[]): string {
  const years = [...new Set(epoch.map((d) => new Date(ms(d)).getUTCFullYear()))].sort((a, b) => a - b);
  if (years.length === 0) return "";
  if (years.length === 1) return String(years[0]);
  const d0 = Math.floor(years[0] / 10) * 10;
  const d1 = Math.floor(years[years.length - 1] / 10) * 10;
  if (d0 === d1) return `the ${d0}s`;
  if (d1 - d0 === 10) return `the ${d0}s–${String(d1).slice(2)}s`;
  return `${years[0]}–${years[years.length - 1]}`;
}

const STANDARD_IDS = ["osmId", "id", "siteId", "gnisId"] as const;
const ID_KEY = /(Id|_id|ID)$/;

/** A feature's value of `field` as a string to compare (a date by its instant), or null. */
function sideValue(f: Feature, field: string): string | null {
  const t = timeOf(f, field);
  if (t !== null) return String(t);
  const raw = f.properties?.[field];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
}

/**
 * The property that names one thing across dates or versions (a glacier's `glacierId`, an OSM id, a monument's name
 * across its 2021 and current boundaries): one whose value repeats on features with a different `field` (the date, or
 * the version key). Id-like keys first, the name last. Undefined when no property does (each feature is its own thing).
 */
export function identityKey(features: readonly Feature[], field = "t"): string | undefined {
  const candidates = new Set<string>(STANDARD_IDS);
  for (const f of features.slice(0, 50)) for (const k of Object.keys(f.properties ?? {})) if (ID_KEY.test(k)) candidates.add(k);
  candidates.add("name");
  for (const key of candidates) {
    const seen = new Map<string, Set<string | null>>();
    let repeats = 0;
    let present = 0;
    for (const f of features) {
      const raw = f.properties?.[key];
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      if (typeof raw === "string" && raw.trim() === "") continue;
      present += 1;
      const id = String(raw);
      const v = sideValue(f, field);
      const at = seen.get(id);
      if (!at) seen.set(id, new Set([v]));
      else if (!at.has(v)) {
        repeats += 1;
        at.add(v);
      } else if (key === "name") {
        // Two features with one name on one date are two things (unnamed glaciers called "Glacier"): not an identity.
        repeats = -Infinity;
      }
    }
    if (present >= features.length * 0.8 && repeats > 0) return key;
  }
  return undefined;
}

export type ChangeStatement = {
  /** The sentence: "121 glaciers mapped in both the 1960s–70s and the 2010s lost 48% of their area (42.4 to 21.9 km²)." */
  text: string;
  matched: number;
  /** Totals of the measure over the matched things, A (earlier) and B (later), when there is a measure. */
  before?: number;
  after?: number;
  /** (after − before) / before, when both exist and before > 0. */
  share?: number;
};

export type ChangeOptions = {
  /** The plural noun for the things ("glaciers"). */
  noun: string;
  aLabel: string;
  bLabel: string;
  /** The property naming one thing across both sides; without one the statement counts features only. */
  idKey?: string;
  measure?: { key: string; label: string; unit?: string };
  timeField?: string;
};

function amount(n: number): string {
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
}

/** One feature per id for a side: the earliest on side A, the latest on side B. */
function byId(features: readonly Feature[], key: string, latest: boolean, timeField: string): Map<string, Feature> {
  const out = new Map<string, Feature>();
  for (const f of features) {
    const raw = f.properties?.[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const id = String(raw);
    const had = out.get(id);
    if (!had) {
      out.set(id, f);
      continue;
    }
    const a = timeOf(had, timeField) ?? 0;
    const b = timeOf(f, timeField) ?? 0;
    if (latest ? b > a : b < a) out.set(id, f);
  }
  return out;
}

/**
 * The change between side A (earlier) and side B (later) in one sentence. With an id key and a measure: the things on
 * both sides and how their total changed ("121 glaciers mapped in both … lost 48% of their area (42.4 to 21.9 km²)"),
 * then how many are on one side only. Without an id: the counts on each side.
 */
export function changeStatement(a: readonly Feature[], b: readonly Feature[], opts: ChangeOptions): ChangeStatement | null {
  const timeField = opts.timeField ?? "t";
  if (a.length === 0 && b.length === 0) return null;
  if (!opts.idKey) {
    return { text: `${amount(a.length)} ${opts.noun} in ${opts.aLabel}, ${amount(b.length)} in ${opts.bLabel}.`, matched: 0 };
  }
  const ia = byId(a, opts.idKey, false, timeField);
  const ib = byId(b, opts.idKey, true, timeField);
  const both = [...ia.keys()].filter((k) => ib.has(k));
  const onlyA = ia.size - both.length;
  const onlyB = ib.size - both.length;
  const tail = [onlyA > 0 && `${amount(onlyA)} mapped only in ${opts.aLabel}`, onlyB > 0 && `${amount(onlyB)} only in ${opts.bLabel}`].filter(Boolean).join(", ");
  const tailText = tail ? ` ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.` : "";
  if (both.length === 0) return { text: `No ${opts.noun} were mapped in both ${opts.aLabel} and ${opts.bLabel}.${tailText}`, matched: 0 };
  const m = opts.measure;
  const num = (f: Feature | undefined) => {
    const v = m ? f?.properties?.[m.key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const pairs = both.map((k) => [num(ia.get(k)), num(ib.get(k))] as const).filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
  const head = `${amount(both.length)} ${opts.noun} mapped in both ${opts.aLabel} and ${opts.bLabel}`;
  if (!m || pairs.length === 0) return { text: `${head}.${tailText}`, matched: both.length };
  const before = pairs.reduce((s, p) => s + p[0], 0);
  const after = pairs.reduce((s, p) => s + p[1], 0);
  const unit = m.unit ? ` ${m.unit}` : "";
  const word = m.label.toLowerCase();
  if (before <= 0) return { text: `${head}: ${word} ${amount(before)} to ${amount(after)}${unit}.${tailText}`, matched: both.length, before, after };
  const share = (after - before) / before;
  const pct = Math.round(Math.abs(share) * 100);
  const verb = pct === 0 ? `kept about the same ${word}` : share < 0 ? `lost ${pct}% of their ${word}` : `gained ${pct}% in ${word}`;
  return {
    text: `${head} ${verb} (${amount(before)} to ${amount(after)}${unit}).${tailText}`,
    matched: both.length,
    before,
    after,
    share,
  };
}

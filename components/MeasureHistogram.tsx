"use client";

import type { FeatureCollection } from "geojson";
import { useMemo } from "react";
import { formatFilterNumber, type LayerFilters } from "@/lib/render/filters";
import { histogram, pickedBins, toggleBin } from "@/lib/render/attributes";

type MeasureHistogramProps = {
  /** The property the bars count. */
  field: { key: string; label: string; unit?: string };
  /** Every feature the layer loaded: the bars are the whole distribution, the picked ones in ink. */
  data: FeatureCollection;
  filters: LayerFilters;
  onChange: (next: LayerFilters) => void;
  /** What the features are called in a bar's label ("fires"); "features" by default. */
  noun?: string;
};

/** A number in the field's own words: whole numbers with separators, a unit unless it is a score. */
function amount(value: number, key: string, unit?: string): string {
  const text = formatFilterNumber(value, Number.isInteger(value) || Math.abs(value) >= 100, key, unit);
  return unit && unit !== "score" ? `${text} ${unit}` : text;
}

/**
 * The mini histogram (spec §12c): the only free range control. Bars over the measure's spread (a log scale when most
 * values sit at the low end), each a button: click one to keep only that band, click past the picked span to grow it,
 * click an end of the span to drop it, click the only picked bar to clear. No handles; the picked span's bounds read
 * under the bars in the field's unit.
 */
export function MeasureHistogram({ field, data, filters, onChange, noun = "features" }: MeasureHistogramProps) {
  const hist = useMemo(() => histogram(data, field.key), [data, field.key]);
  if (!hist) return null;
  const { bins } = hist;
  const picked = pickedBins(filters, field.key, bins);
  const max = Math.max(1, ...bins.map((b) => b.count));
  const range = filters[field.key]?.range;
  const lo = bins[0].lo;
  const hi = bins[bins.length - 1].hi;
  return (
    <div data-testid="measure-histogram" data-key={field.key}>
      <div role="group" aria-label={`${field.label}: pick a band`} className="measure-bars">
        {bins.map((bin, i) => {
          const label = `${amount(bin.lo, field.key, field.unit)} to ${amount(bin.hi, field.key, field.unit)}: ${bin.count.toLocaleString("en-US")} ${noun}`;
          return (
            <button
              key={i}
              type="button"
              aria-label={label}
              aria-pressed={picked.includes(i)}
              disabled={bin.count === 0 && !picked.includes(i) && picked.length === 0}
              onClick={() => onChange(toggleBin(filters, field.key, bins, i))}
              className="measure-bar"
            >
              <span aria-hidden className="measure-bar-fill" style={{ height: bin.count > 0 ? `${Math.max(12, (bin.count / max) * 100)}%` : "1px" }} />
            </button>
          );
        })}
      </div>
      <p className="mt-0.5 flex justify-between gap-2 text-[11px] leading-4 text-ink-muted tabular-nums">
        <span className={range ? "text-ink" : undefined}>{amount(range ? Math.max(lo, range[0]) : lo, field.key, field.unit)}</span>
        {hist.log && <span>log scale</span>}
        <span className={range ? "text-ink" : undefined}>{amount(range ? Math.min(hi, range[1]) : hi, field.key, field.unit)}</span>
      </p>
    </div>
  );
}

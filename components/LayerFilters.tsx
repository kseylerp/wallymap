"use client";

import type { FilterField, LayerFilters as Filters } from "@/lib/render/filters";
import type { MapAction } from "@/lib/render/state";

type LayerFiltersProps = {
  id: string;
  layerId: string;
  title: string;
  fields: FilterField[];
  filters: Filters;
  dispatch: (action: MapAction) => void;
};

type Range = Extract<FilterField, { kind: "range" }>;
type Category = Extract<FilterField, { kind: "category" }>;

/** "mountain_hiking" reads as "mountain hiking"; the raw value stays in the chip's title. */
function plain(value: string): string {
  return value.replace(/_/g, " ");
}

/** A range readout: whole numbers with separators (years without), decimals to two places at most. */
function formatNumber(value: number, integer: boolean, key: string): string {
  if (integer) return Math.round(value).toLocaleString("en-US", { useGrouping: !/year/i.test(key) });
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Drops float noise (0.30000000000000004 reads 0.3). */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/** Slider step: 1 for whole numbers, else about 200 steps across the span. */
function stepFor(field: Range): number {
  if (field.integer) return 1;
  const span = field.max - field.min;
  if (span <= 0) return 1;
  const raw = span / 200;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return clean(Math.max(pow, Math.round(raw / pow) * pow));
}

function CategoryFilter({ field, include, onChange }: { field: Category; include: string[]; onChange: (next: string[]) => void }) {
  const all = include.length === 0;
  const toggle = (value: string) => {
    const next = include.includes(value) ? include.filter((v) => v !== value) : [...include, value];
    // Every value picked is the same as none: no restriction.
    onChange(next.length === field.values.length ? [] : next);
  };
  return (
    <div role="group" aria-label={field.label} className="flex flex-wrap gap-1">
      <button type="button" aria-pressed={all} onClick={() => onChange([])} className="filter-chip">
        all
      </button>
      {field.values.map(({ value, count }) => (
        <button
          key={value}
          type="button"
          aria-pressed={include.includes(value)}
          onClick={() => toggle(value)}
          title={`${value}: ${count.toLocaleString()}`}
          className="filter-chip"
        >
          {plain(value)}{" "}
          <span className="filter-chip-count tabular-nums">{count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

function RangeFilter({
  field,
  range,
  onChange,
}: {
  field: Range;
  range: [number, number] | undefined;
  onChange: (next: [number, number] | undefined) => void;
}) {
  const [lo, hi] = range ?? [field.min, field.max];
  const step = stepFor(field);
  // The inputs run over round numbers (step multiples) that enclose the data, so every thumb stop reads "4000", not
  // 4164.94, and the ends are reachable even when the data's own min or max is not a step multiple.
  const inputMin = clean(Math.floor(field.min / step) * step);
  const inputMax = clean(Math.ceil(field.max / step) * step);
  const inputSpan = inputMax - inputMin || 1;
  // Only the thumb that moved is rounded; a thumb at or past the data's end means "no bound" on that side.
  const settle = (v: number) => (v <= field.min ? field.min : v >= field.max ? field.max : clean(Math.round(v / step) * step));
  const set = (a: number, b: number) => onChange(a <= field.min && b >= field.max ? undefined : [a, b]);
  // A thumb dragged past the other one pushes it along, so the two never lock together.
  const moveLo = (v: number) => {
    const next = settle(v);
    set(next, Math.max(hi, next));
  };
  const moveHi = (v: number) => {
    const next = settle(v);
    set(Math.min(lo, next), next);
  };
  const unit = field.unit && field.unit !== "score" ? ` ${field.unit}` : "";
  const readout = (v: number) => `${formatNumber(v, field.integer, field.key)}${unit}`;
  const pct = (v: number) => `${((Math.min(inputMax, Math.max(inputMin, v)) - inputMin) / inputSpan) * 100}%`;
  // The upper input sits on top; once the lower thumb is in the top half it goes on top, so it can always be pulled back.
  const loOnTop = lo - inputMin > inputSpan / 2;
  return (
    <div>
      <div className="filter-range" style={{ ["--lo" as string]: pct(lo), ["--hi" as string]: pct(hi) }}>
        <span aria-hidden className="filter-range-track" />
        <input
          type="range"
          min={inputMin}
          max={inputMax}
          step={step}
          value={lo}
          aria-label={`${field.label} from`}
          aria-valuetext={lo <= field.min ? `${readout(lo)}, lowest` : readout(lo)}
          style={loOnTop ? { zIndex: 1 } : undefined}
          onChange={(e) => moveLo(Number(e.target.value))}
        />
        <input
          type="range"
          min={inputMin}
          max={inputMax}
          step={step}
          value={hi}
          aria-label={`${field.label} to`}
          aria-valuetext={hi >= field.max ? `${readout(hi)}, highest` : readout(hi)}
          onChange={(e) => moveHi(Number(e.target.value))}
        />
      </div>
      <p className="mt-0.5 flex justify-between text-[11px] leading-4 text-ink-muted tabular-nums">
        <span className={lo > field.min ? "text-ink" : undefined}>{readout(lo)}</span>
        <span className={hi < field.max ? "text-ink" : undefined}>{readout(hi)}</span>
      </p>
    </div>
  );
}

/**
 * A layer's attribute filters, under its legend row: one block per field the data offers (lib/render/filters.ts):
 * category chips with counts ("all" clears the field), or a two-handle range with its bounds in tabular figures.
 * Every change applies at once to the map, the counts and the export; "Reset" clears them all.
 */
export function LayerFilters({ id, layerId, title, fields, filters, dispatch }: LayerFiltersProps) {
  const update = (key: string, entry: Filters[string] | undefined) => {
    const next: Filters = { ...filters };
    if (entry && ((entry.include && entry.include.length > 0) || entry.range)) next[key] = entry;
    else delete next[key];
    dispatch({ type: "set_filters", layerId, filters: next });
  };
  const active = Object.keys(filters).length > 0;

  return (
    <div id={id} role="region" aria-label={`Filters for ${title}`} data-testid="layer-filters" className="space-y-2.5 pt-2.5 pl-9">
      {fields.map((field) => (
        <div key={field.key}>
          <p className="mb-1 text-[11.5px] leading-4 text-ink-muted" title={field.key}>
            {field.label}
          </p>
          {field.kind === "category" ? (
            <CategoryFilter
              field={field}
              include={filters[field.key]?.include ?? []}
              onChange={(include) => update(field.key, { ...filters[field.key], include })}
            />
          ) : (
            <RangeFilter
              field={field}
              range={filters[field.key]?.range}
              onChange={(range) => update(field.key, { ...filters[field.key], range })}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => dispatch({ type: "set_filters", layerId, filters: {} })}
        disabled={!active}
        className="dashed-link text-[11.5px] text-ink-muted disabled:opacity-40"
      >
        Reset
      </button>
    </div>
  );
}

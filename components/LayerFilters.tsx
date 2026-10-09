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

/** Slider step: 1 for whole numbers, else about 200 steps across the span. */
function stepFor(field: Range): number {
  if (field.integer) return 1;
  const span = field.max - field.min;
  if (span <= 0) return 1;
  const raw = span / 200;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return Math.max(pow, Math.round(raw / pow) * pow);
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
          {plain(value)}
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
  const span = field.max - field.min || 1;
  const step = stepFor(field);
  // Thumbs land on round numbers (a step multiple), so the summary and the export read "acres ≥ 4000", not 4164.94.
  const snap = (v: number) => Math.min(field.max, Math.max(field.min, Math.round(v / step) * step));
  const set = (a: number, b: number) => {
    const [x, y] = [snap(a), snap(b)];
    onChange(x <= field.min && y >= field.max ? undefined : [x, y]);
  };
  const unit = field.unit && field.unit !== "score" ? ` ${field.unit}` : "";
  return (
    <div>
      <div
        className="filter-range"
        style={{
          ["--lo" as string]: `${((lo - field.min) / span) * 100}%`,
          ["--hi" as string]: `${((hi - field.min) / span) * 100}%`,
        }}
      >
        <span aria-hidden className="filter-range-track" />
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={step}
          value={lo}
          aria-label={`${field.label} from`}
          onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)}
        />
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={step}
          value={hi}
          aria-label={`${field.label} to`}
          onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))}
        />
      </div>
      <p className="mt-0.5 flex justify-between text-[11px] leading-4 text-ink-muted tabular-nums">
        <span className={lo > field.min ? "text-ink" : undefined}>
          {formatNumber(lo, field.integer, field.key)}
          {unit}
        </span>
        <span className={hi < field.max ? "text-ink" : undefined}>
          {formatNumber(hi, field.integer, field.key)}
          {unit}
        </span>
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

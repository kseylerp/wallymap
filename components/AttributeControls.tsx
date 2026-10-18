"use client";

import type { Feature, FeatureCollection } from "geojson";
import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePhonePanel } from "@/components/PhoneSheet";
import type { Attribute, FieldHelp } from "@/layers/types";
import { helpTitle, InfoMark } from "@/components/FieldHelp";
import { LayerFilters, RangeFilter } from "@/components/LayerFilters";
import { MeasureHistogram } from "@/components/MeasureHistogram";
import { formatValue } from "@/lib/format";
import {
  attributeGroups,
  attributesOf,
  chipAttribute,
  clearAttribute,
  encodedAttribute,
  extentOf,
  flagCount,
  isFlagOn,
  isGroupPicked,
  isPresetPicked,
  rankableMeasures,
  nameQuery,
  presetCount,
  toggleFlag,
  toggleGroup,
  togglePreset,
  holdsNumbers,
  rankedTop,
  rowName,
  withNameQuery,
  type AttributeGroup,
} from "@/lib/render/attributes";
import type { FilterField, LayerFilters as Filters } from "@/lib/render/filters";
import { isActiveEntry } from "@/lib/render/filters";
import { featureBBox, featureCenter } from "@/lib/render/inspect";
import { DARK_GREY, LINE, WHITE } from "@/lib/render/palette";
import { categoryKey } from "@/lib/render/categories";
import type { LoadedLayer, MapAction, RenderOp } from "@/lib/render/state";
import { RANKED_TOP_N } from "@/lib/render/views";

type AttributeControlsProps = {
  layer: LoadedLayer;
  op: RenderOp;
  /** Every feature the layer loaded (chip counts are of the whole result, so a picked chip keeps its number). */
  data: FeatureCollection;
  /** The features drawn (filters and the time window applied): what the top 10 ranks. */
  shown: FeatureCollection;
  /** The fields the data offers that the layer does not declare (lib/render/filters.ts), shown under More. */
  fields: FilterField[];
  dispatch: (action: MapAction) => void;
  /** Opens with More expanded (the layout test measures every control). */
  defaultMore?: boolean;
};

/** A chip's key as the map draws the class: a line on its casing, a disc on its halo, or a tinted square. */
function ClassKey({ color, shape = "line" }: { color: string; shape?: "line" | "point" | "polygon" }) {
  if (shape === "point") {
    return (
      <svg aria-hidden viewBox="0 0 10 10" width={10} height={10} className="shrink-0 self-center">
        <circle cx={5} cy={5} r={4} fill={color} stroke={DARK_GREY} strokeWidth={1} />
      </svg>
    );
  }
  if (shape === "polygon") {
    return (
      <svg aria-hidden viewBox="0 0 12 10" width={12} height={10} className="shrink-0 self-center">
        <rect x={1} y={1} width={10} height={8} rx={1} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={1.5} />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 14 6" width={14} height={6} className="shrink-0 self-center">
      <line x1={1} y1={3} x2={13} y2={3} stroke={WHITE} strokeWidth={LINE.casing} strokeLinecap="round" />
      <line x1={1} y1={3} x2={13} y2={3} stroke={color} strokeWidth={LINE.width} strokeLinecap="round" />
    </svg>
  );
}

/** An attribute's label line: its words, and the serif "i" when the layer explains the field. */
function AttributeLabel({ attr, help }: { attr: Pick<Attribute, "label">; help?: FieldHelp }) {
  return (
    <p className="mb-0.5 flex items-center gap-1 text-[11px] leading-4 text-ink-muted">
      <span>{attr.label}</span>
      {help && <InfoMark help={help} label={attr.label} />}
    </p>
  );
}

/**
 * Category or ordinal chips with counts (several may be picked; "all" clears). On the attribute that colors the lines,
 * each chip carries its class's ramp color: the chips are the legend, and pressing a key toggles its chip.
 */
function Chips({
  attr,
  groups,
  filters,
  keyed,
  shape = "line",
  helpText,
  onChange,
}: {
  attr: Attribute;
  groups: AttributeGroup[];
  filters: Filters;
  keyed: boolean;
  shape?: "line" | "point" | "polygon";
  helpText?: string;
  onChange: (next: Filters) => void;
}) {
  const none = !isActiveEntry(filters[attr.key]);
  // On a phone each chip set is one row that scrolls sideways (wrapped chips pushed the rest of the row down).
  const phone = usePhonePanel() !== null;
  return (
    <div role="group" aria-label={attr.label} data-chip-row={phone || undefined} className={phone ? "chip-row -mr-4 flex flex-nowrap gap-1.5 overflow-x-auto pr-4" : "flex flex-wrap gap-1"}>
      <button type="button" aria-pressed={none} onClick={() => onChange(clearAttribute(filters, attr))} className="filter-chip">
        All
      </button>
      {groups.map((group) => (
        <button
          key={group.label}
          type="button"
          aria-pressed={isGroupPicked(filters, attr, group)}
          onClick={() => onChange(toggleGroup(filters, attr, group, groups))}
          title={[`${group.label}: ${formatValue("count", group.count)}`, group.help, helpText].filter(Boolean).join(" · ")}
          data-testid="attribute-chip"
          className="filter-chip"
        >
          {keyed && group.color && <ClassKey color={group.color} shape={shape} />}
          {group.label} <span className="filter-chip-count tabular-nums">{formatValue("count", group.count)}</span>
        </button>
      ))}
    </div>
  );
}

/** A measure's value as the top 10 shows it: "110 routes", "1,350 MW", "72" for a score, "1985" for a year. */
function measureText(value: unknown, attr: Attribute | undefined, key = attr?.key ?? "v"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  // Whole numbers from 100 up ("97,729 acres", not "97,729.32"), one decimal from 10, two below.
  const abs = Math.abs(value);
  const text = formatValue(key, value, attr?.unit, abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  return attr?.unit && attr.unit !== "score" ? `${text} ${attr.unit}` : text;
}

/**
 * "Rank by" (spec §12c: a measure is ranked, not filtered): a select over the layer's measures, and, once one is picked,
 * the top 10 of the drawn features by it. Hovering a row rings its feature on the map; clicking flies there and opens
 * its card.
 */
function RankBy({ layer, op, data, shown, dispatch }: { layer: LoadedLayer; op: RenderOp; data: FeatureCollection; shown: FeatureCollection; dispatch: (a: MapAction) => void }) {
  const id = `rank-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Unset ranks by the layer's primary measure; "" is None, picked in the row (the eval's map checks read the same list).
  const { key: rankBy, measures, top } = useMemo(() => rankedTop(layer, op, data, shown, RANKED_TOP_N), [layer, op, data, shown]);
  const attr = measures.find((m) => m.key === rankBy);
  // On a phone the list starts at its top 3, with "Show 10" for the rest (ten rows filled half the sheet).
  const phone = usePhonePanel() !== null;
  const [all, setAll] = useState(false);
  const rows = phone && !all ? top.slice(0, PHONE_TOP_N) : top;
  const open = (f: Feature) => {
    const bbox = featureBBox(f);
    const at = featureCenter(f);
    if (!bbox || !at) return;
    dispatch({ type: "set_hover" });
    dispatch({ type: "fly_to", bbox, select: { layerId: layer.id, feature: f, lngLat: at } });
  };
  return (
    <div data-testid="rank-by">
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={id} className="text-[11px] leading-4 text-ink-muted">
          Rank by
        </label>
        <select
          id={id}
          value={rankBy ?? ""}
          onChange={(e) => dispatch({ type: "set_rank_by", layerId: layer.id, key: e.target.value })}
          className="legend-select rank-select"
        >
          <option value="">None</option>
          {measures.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {rankBy && top.length > 0 && (
        <ol aria-label={`Top ${top.length} by ${attr?.label ?? rankBy}`} data-testid="top-list" className="mt-1">
          {rows.map((f, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => open(f)}
                onMouseEnter={() => dispatch({ type: "set_hover", hover: { layerId: layer.id, feature: f } })}
                onMouseLeave={() => dispatch({ type: "set_hover" })}
                onFocus={() => dispatch({ type: "set_hover", hover: { layerId: layer.id, feature: f } })}
                onBlur={() => dispatch({ type: "set_hover" })}
                className="top-row"
              >
                <span className="w-4 shrink-0 text-right text-ink-muted tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{rowName(f)}</span>
                <span className="shrink-0 text-ink-muted tabular-nums">{measureText(f.properties?.[rankBy], attr, rankBy)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {phone && rankBy && top.length > PHONE_TOP_N && (
        <button type="button" onClick={() => setAll((a) => !a)} aria-expanded={all} className="row-link">
          {all ? `Show ${PHONE_TOP_N}` : `Show ${top.length}`}
        </button>
      )}
    </div>
  );
}

/** Rows of Rank by's list a phone shows before "Show 10". */
export const PHONE_TOP_N = 3;

/** A measure under More: presets from the source's classes as chips, then the mini histogram. */
function MeasureBlock({ attr, data, filters, help, onChange }: { attr: Attribute; data: FeatureCollection; filters: Filters; help?: FieldHelp; onChange: (next: Filters) => void }) {
  const extent = useMemo(() => extentOf(data, attr.key), [data, attr.key]);
  const phone = usePhonePanel() !== null;
  if (!extent) return null;
  return (
    <div data-attribute={attr.key}>
      <AttributeLabel attr={attr} help={help} />
      {attr.presets && attr.presets.length > 0 && (
        <div role="group" aria-label={`${attr.label} presets`} data-chip-row={phone || undefined} className={phone ? "chip-row -mr-4 mb-1 flex flex-nowrap gap-1.5 overflow-x-auto pr-4" : "mb-1 flex flex-wrap gap-1"}>
          {attr.presets.map((preset) => {
            const count = presetCount(data, attr.key, preset);
            if (count === 0 && !isPresetPicked(filters, attr, preset, extent)) return null;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={isPresetPicked(filters, attr, preset, extent)}
                onClick={() => onChange(togglePreset(filters, attr, preset, extent))}
                data-testid="measure-preset"
                className="filter-chip"
              >
                {preset.label} <span className="filter-chip-count tabular-nums">{formatValue("count", count)}</span>
              </button>
            );
          })}
        </div>
      )}
      <MeasureHistogram field={attr} data={data} filters={filters} onChange={onChange} />
    </div>
  );
}

/** A year (numeric) under More: the one two-handle range left in the row (spec §12c). */
function YearBlock({ attr, data, filters, help, onChange }: { attr: Attribute; data: FeatureCollection; filters: Filters; help?: FieldHelp; onChange: (next: Filters) => void }) {
  const extent = useMemo(() => extentOf(data, attr.key), [data, attr.key]);
  if (!extent) return null;
  return (
    <div data-attribute={attr.key}>
      <AttributeLabel attr={attr} help={help} />
      <RangeFilter
        field={{ key: attr.key, label: attr.label, kind: "range", min: extent[0], max: extent[1], integer: true }}
        range={filters[attr.key]?.range}
        onChange={(range) => onChange(range ? { ...clearAttribute(filters, attr), [attr.key]: { range } } : clearAttribute(filters, attr))}
      />
    </div>
  );
}

/**
 * A layer's attributes inline in its row (spec §12c): by default one chip set (its main category or ordinal) and
 * "Rank by" with its top 10; "More" opens everything else, each attribute with its type's control: chips, a measure's
 * presets and mini histogram, a year's range, flag toggles and a name search, then the fields the layer does not
 * declare. Every control writes the layer's filters, so the map, the counts, the legend, the export, the share link and
 * the agent's render.filters share one state.
 */
export function AttributeControls({ layer, op, data, shown, fields, dispatch, defaultMore = false }: AttributeControlsProps) {
  const [more, setMore] = useState(defaultMore);
  // On a phone "More filters" opens a page of its own in the sheet, with a back control (components/PhoneSheet.tsx).
  const panel = usePhonePanel();
  const moreId = `more-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const filters = useMemo(() => op.filters ?? {}, [op.filters]);
  const set = (next: Filters) => dispatch({ type: "set_filters", layerId: layer.id, filters: next });
  const attributes = attributesOf(layer);
  const chip = chipAttribute(layer);
  // Two primary chip sets show side by side (climbing: discipline and grade band); otherwise the one chip set.
  const primaries = attributes.filter((a) => a.primary && (a.type === "category" || a.type === "ordinal")).slice(0, 2);
  const shownChips = primaries.length > 1 ? primaries : chip ? [chip] : [];
  const encoded = encodedAttribute(layer);
  const measures = rankableMeasures(layer, data);
  const helpFor = (a: Attribute) => a.help ?? layer.fieldHelp?.[a.key];
  // The category the map colors symbols and areas by (lib/render/categories.ts): its chips carry its colors, so the
  // chips are the legend.
  const key = useMemo(() => categoryKey(layer, data), [layer, data]);
  const shape = layer.style.geometry;
  const colored = (attr: Attribute, groups: AttributeGroup[]): AttributeGroup[] =>
    key && key.attr.key === attr.key && shape !== "line"
      ? groups.map((g) => ({ ...g, color: key.groups.find((k) => k.label === g.label)?.color ?? g.color }))
      : groups;
  const isKeyed = (attr: Attribute) => (attr === encoded && shape === "line") || (key?.attr.key === attr.key && shape !== "line");
  const chipSets = shownChips.map((a) => ({ attr: a, groups: attributeGroups(a, data, filters) }));
  // Everything but the default chip sets, in declared order; a date's time lives on the scrubber, a place in chat.
  const rest = attributes.filter((a) => !shownChips.includes(a) && a.type !== "place" && !(a.type === "time" && !holdsNumbers(data, a.key)));
  const restKeys = new Set([...rest.map((a) => a.key), ...fields.map((f) => f.key)]);
  const hiddenActive = Object.entries(filters).filter(([k, f]) => restKeys.has(k) && isActiveEntry(f)).length;
  const blocks = rest.flatMap((attr) => {
    const help = helpFor(attr);
    switch (attr.type) {
      case "category":
      case "ordinal": {
        const groups = attributeGroups(attr, data, filters);
        if (groups.length < 2) return [];
        return [
          <div key={attr.key} data-attribute={attr.key}>
            <AttributeLabel attr={attr} help={help} />
            <Chips attr={attr} groups={colored(attr, groups)} filters={filters} keyed={isKeyed(attr)} shape={shape} helpText={helpTitle(help)} onChange={set} />
          </div>,
        ];
      }
      case "measure":
        return holdsNumbers(data, attr.key) ? [<MeasureBlock key={attr.key} attr={attr} data={data} filters={filters} help={help} onChange={set} />] : [];
      case "time":
        return [<YearBlock key={attr.key} attr={attr} data={data} filters={filters} help={help} onChange={set} />];
      case "flag": {
        const count = flagCount(data, attr.key);
        if (count === 0 && !isFlagOn(filters, attr)) return [];
        return [
          <button key={attr.key} type="button" aria-pressed={isFlagOn(filters, attr)} onClick={() => set(toggleFlag(filters, attr))} data-testid="flag-chip" className="filter-chip mr-1">
            {attr.label} <span className="filter-chip-count tabular-nums">{formatValue("count", count)}</span>
          </button>,
        ];
      }
      case "name":
        return [
          <label key={attr.key} className="flex min-w-0 items-center gap-2" data-attribute={attr.key}>
            <span className="shrink-0 text-[11px] leading-4 text-ink-muted">Search {attr.label.toLowerCase()}</span>
            <input
              type="search"
              value={nameQuery(filters, attr)}
              onChange={(e) => set(withNameQuery(filters, attr, e.target.value))}
              // On a phone the sheet grows to full and the field scrolls into sight above the keyboard.
              onFocus={(e) => {
                if (!panel) return;
                panel.expand();
                const field = e.currentTarget;
                window.setTimeout(() => field.scrollIntoView({ block: "center", behavior: "smooth" }), 350);
              }}
              placeholder="Type to filter"
              className="name-search min-w-0 flex-1"
            />
          </label>,
        ];
      default:
        return [];
    }
  });
  const hasMore = blocks.length > 0 || fields.length > 0;
  if (shownChips.length === 0 && measures.length === 0 && !hasMore) return null;

  return (
    <div role="group" aria-label={`Attributes for ${layer.title}`} data-testid="attribute-controls" className={panel ? "space-y-2 pt-2" : "space-y-1.5 pt-1.5 pl-9"}>
      {chipSets.map(({ attr, groups }) =>
        groups.length > 1 ? (
          <div key={attr.key} data-attribute={attr.key}>
            <AttributeLabel attr={attr} help={helpFor(attr)} />
            <Chips attr={attr} groups={colored(attr, groups)} filters={filters} keyed={isKeyed(attr)} shape={shape} helpText={helpTitle(helpFor(attr))} onChange={set} />
          </div>
        ) : null,
      )}
      {measures.length > 0 && <RankBy layer={layer} op={op} data={data} shown={shown} dispatch={dispatch} />}
      {hasMore && panel && (
        <button type="button" onClick={() => panel.openMore(layer.id)} className="row-link">
          More filters
          {hiddenActive > 0 && <span className="tabular-nums"> ({hiddenActive} active)</span>}
          <span aria-hidden className="ml-1">›</span>
        </button>
      )}
      {hasMore &&
        panel?.moreLayerId === layer.id &&
        panel.moreTarget &&
        createPortal(
          <div id={moreId} data-testid="attribute-more" className="space-y-3 pb-2">
            {blocks}
            {fields.length > 0 && <LayerFilters id={`${moreId}-fields`} layerId={layer.id} title={layer.title} fields={fields} filters={filters} data={data} dispatch={dispatch} />}
          </div>,
          panel.moreTarget,
        )}
      {hasMore && !panel && (
        <button type="button" onClick={() => setMore((o) => !o)} aria-expanded={more} aria-controls={moreId} className="row-link">
          {more ? "Fewer filters" : "More filters"}
          {hiddenActive > 0 && <span className="tabular-nums"> ({hiddenActive} active)</span>}
        </button>
      )}
      {/* Open stays open, so a bar or a chip can be pressed again without the row folding away. */}
      {more && hasMore && !panel && (
        <div id={moreId} data-testid="attribute-more" className="space-y-2 pt-1">
          {blocks}
          {fields.length > 0 && <LayerFilters id={`${moreId}-fields`} layerId={layer.id} title={layer.title} fields={fields} filters={filters} data={data} dispatch={dispatch} />}
        </div>
      )}
    </div>
  );
}

"use client";

import type { FeatureCollection } from "geojson";
import { useMemo } from "react";
import type { Facet, FieldHelp } from "@/layers/types";
import { helpTitle, InfoMark } from "@/components/FieldHelp";
import { RangeFilter } from "@/components/LayerFilters";
import { formatValue } from "@/lib/format";
import { clearFacet, facetGroups, facetRangeField, isGroupPicked, primaryFacet, toggleGroup, type FacetGroup } from "@/lib/render/facets";
import type { LayerFilters } from "@/lib/render/filters";
import type { MapAction } from "@/lib/render/state";
import { LINE, WHITE } from "@/lib/render/palette";

type FacetControlsProps = {
  layerId: string;
  title: string;
  facets: Facet[];
  /** Every feature the layer loaded (counts are of the whole result, so a picked chip keeps its number). */
  data: FeatureCollection;
  filters: LayerFilters;
  /** Draws a key on the primary facet's chips: its line ramp color (lines) or nothing. */
  geometry: "point" | "line" | "polygon";
  fieldHelp?: Record<string, FieldHelp>;
  dispatch: (action: MapAction) => void;
};

/** A chip's line key: a 14px stroke of the class's ramp color on its white casing, as the map draws it. */
function ClassKey({ color }: { color: string }) {
  return (
    <svg aria-hidden viewBox="0 0 14 6" width={14} height={6} className="shrink-0 self-center">
      <line x1={1} y1={3} x2={13} y2={3} stroke={WHITE} strokeWidth={LINE.casing} strokeLinecap="round" />
      <line x1={1} y1={3} x2={13} y2={3} stroke={color} strokeWidth={LINE.width} strokeLinecap="round" />
    </svg>
  );
}

/**
 * A layer's facets inline in its row (spec §12a), always visible: one line per facet, its label (with the "i" when the
 * layer explains the field) and either category chips with counts (several may be picked; "all" clears) or a labelled
 * two-handle slider with its bounds in the layer's unit. Every press writes the layer's filters, so the map, the
 * counts, the legend, the export and the share link follow. On the facet that drives the map, each chip carries its
 * class's color: the chips are the legend.
 */
export function FacetControls({ layerId, title, facets, data, filters, geometry, fieldHelp, dispatch }: FacetControlsProps) {
  const primary = primaryFacet({ facets });
  const set = (next: LayerFilters) => dispatch({ type: "set_filters", layerId, filters: next });
  const blocks = useMemo(
    () =>
      facets.map((facet) =>
        facet.kind === "category" ? { facet, groups: facetGroups(facet, data, filters) } : { facet, range: facetRangeField(facet, data) },
      ),
    [facets, data, filters],
  );
  const shown = blocks.filter((b) => ("groups" in b ? (b.groups?.length ?? 0) > 1 : b.range !== null));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={`Facets for ${title}`} data-testid="facet-controls" className="space-y-1.5 pt-1.5 pl-9">
      {shown.map((block) => {
        const { facet } = block;
        const help = fieldHelp?.[facet.key];
        const keyed = facet === primary && facet.encode === "color" && geometry === "line";
        return (
          <div key={facet.key} data-facet={facet.key}>
            <p className="mb-0.5 flex items-center gap-1 text-[11px] leading-4 text-ink-muted">
              <span title={helpTitle(help)}>{facet.label}</span>
              {help && <InfoMark help={help} label={facet.label} />}
            </p>
            {"groups" in block && block.groups ? (
              <CategoryChips
                facet={facet}
                groups={block.groups}
                filters={filters}
                keyed={keyed}
                helpText={helpTitle(help)}
                onChange={set}
              />
            ) : block.range ? (
              <RangeFilter
                field={block.range}
                range={filters[facet.key]?.range}
                onChange={(range) => {
                  const { [facet.key]: entry, ...rest } = filters;
                  const include = entry?.include?.length ? { include: entry.include } : {};
                  set(range || entry?.include?.length ? { ...rest, [facet.key]: { ...include, ...(range && { range }) } } : rest);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CategoryChips({
  facet,
  groups,
  filters,
  keyed,
  helpText,
  onChange,
}: {
  facet: Facet;
  groups: FacetGroup[];
  filters: LayerFilters;
  keyed: boolean;
  helpText?: string;
  onChange: (next: LayerFilters) => void;
}) {
  const none = !(filters[facet.key]?.include?.length);
  return (
    <div role="group" aria-label={facet.label} className="flex flex-wrap gap-1">
      <button type="button" aria-pressed={none} onClick={() => onChange(clearFacet(filters, facet))} className="filter-chip">
        all
      </button>
      {groups.map((group) => (
        <button
          key={group.label}
          type="button"
          aria-pressed={isGroupPicked(filters, facet, group)}
          onClick={() => onChange(toggleGroup(filters, facet, group, groups))}
          title={[`${group.label}: ${formatValue("count", group.count)}`, helpText].filter(Boolean).join(" · ")}
          data-testid="facet-chip"
          className="filter-chip"
        >
          {keyed && group.color && <ClassKey color={group.color} />}
          {group.label} <span className="filter-chip-count tabular-nums">{formatValue("count", group.count)}</span>
        </button>
      ))}
    </div>
  );
}

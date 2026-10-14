"use client";

import { useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { LayerFilters } from "@/components/LayerFilters";
import { TimeScrubber } from "@/components/TimeScrubber";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { applyFilters, deriveFilterFields, filterSummary, type FilterField, type MeasureRange } from "@/lib/render/filters";
import { FacetControls } from "@/components/FacetControls";
import { InfoMark } from "@/components/FieldHelp";
import type { FieldHelp } from "@/layers/types";
import { facetFilterSummary, facetsOf } from "@/lib/render/facets";
import { viewCaption } from "@/lib/render/views";
import type { Feature } from "geojson";
import { LegendKey } from "@/components/LegendKey";
import { formatValue } from "@/lib/format";
import { rasterKeyFilter } from "@/lib/render/rasterCalm";
import { currentScenarioValue, scenarioOf, scenarioValueText } from "@/lib/render/scenario";
import { compareBId, DELTA_FILL_ALPHA, effectiveMode } from "@/lib/render/compareView";
import { hexbinThreshold } from "@/lib/render/deck";
import { COMPARE_COLORS, DELTA_COLORS, DELTA_LINE_COLORS, isRouteProperties, LINE, WHITE } from "@/lib/render/palette";
import { type LoadedLayer, type MapAction, type MapState, type RenderMode, type RenderOp, type Selection, type TimeState } from "@/lib/render/state";
import { hasMissingImage, missingTilesStore } from "@/lib/render/tileErrors";
import { LAYER_PANEL_WIDTH } from "@/lib/render/viewportPadding";
import { hexTileLegend, legendSymbol, type LegendMode, type LegendSymbol } from "@/lib/render/wally/legend";

type LayerStackProps = {
  layers: MapState["layers"];
  renderOps: RenderOp[];
  catalog: LayerCatalog | null;
  dispatch: (action: MapAction) => void;
  /** Whether the panel shows; the layers map pill (MapPills) opens and closes it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The layer holding the selected feature; its row gets the ink selection rule. */
  selectedLayerId?: string;
  /** The time scrubber's state; the scrubber docks at the top of the panel while it exists. */
  time?: TimeState;
  /** The layers as drawn (lib/render/view.ts: time window and filters applied), for the shown / total counts. */
  shownLayers?: MapState["layers"];
  /** The compare control (components/CompareControl.tsx), docked under the time scrubber; it brings its own hairline. */
  compareSlot?: ReactNode;
  /** The scenario scrubbers (components/ScenarioScrubber.tsx), docked under the time scrubber; they bring their own hairlines. */
  scenarioSlot?: ReactNode;
  /** The scenario scrubber's state: a scenario layer's row slider shows the amount it holds. */
  scenario?: MapState["scenario"];
  /** The compare on screen, for the change view's legend sentence. */
  compare?: MapState["compare"];
};

/** The four ways a point layer draws, in short labels that fit the narrowest panel. */
const SHOW_AS: { value: RenderMode; label: string }[] = [
  { value: "points", label: "Points" },
  { value: "clusters", label: "Clusters" },
  { value: "heat", label: "Heat" },
  { value: "columns", label: "3D" },
];

/** The segment a point layer's mode lights up: hex tiles (`hexbin`) read as columns, their 2D form. */
function pointSegment(mode: RenderMode): RenderMode {
  return mode === "hexbin" ? "columns" : mode;
}

/**
 * A point layer's render mode (Points · Clusters · Heat · 3D): four equal-width text segments on a hairline, the
 * pressed one in ink, so the control always fits the row. In a panel under 280px the segments give way to a native
 * select (a container query on the panel), so nothing is ever clipped.
 */
function PointModeControl({ layer, mode, dispatch }: { layer: LoadedLayer; mode: RenderMode; dispatch: (action: MapAction) => void }) {
  const current = pointSegment(mode);
  const pick = (next: RenderMode) => current !== next && dispatch({ type: "set_style", layerId: layer.id, mode: next });
  return (
    <>
      <div role="group" aria-label={`Show ${layer.title} as`} data-testid="mode-control" className="mode-segments">
        {SHOW_AS.map((m) => (
          <button key={m.value} type="button" aria-pressed={current === m.value} onClick={() => pick(m.value)} className="mode-segment">
            {m.label}
          </button>
        ))}
      </div>
      <label data-testid="mode-select" className="mode-select-wrap">
        <span className="sr-only">Show {layer.title} as</span>
        <select value={current} onChange={(e) => pick(e.target.value as RenderMode)} className="legend-select mode-select">
          {SHOW_AS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/**
 * What the map draws for a layer, or for one of its features (the inspect card's swatch): the legend key built from
 * the same palette recipes deck.gl and Mapbox draw with (lib/render/wally/legend.ts). Dense point layers draw as hex
 * tiles, so their key is the tile ramp.
 */
export function layerLegend(layer: LoadedLayer, op: RenderOp | undefined, feature?: Feature, color?: string): LegendSymbol {
  const mode = legendModeFor(layer, op);
  if (mode === "lines" && !feature && !color && !op?.color && allRoutes(layer, op)) {
    return legendSymbol(layer.id, mode, { unit: layer.style.unit, routes: true });
  }
  const dense = layer.result.kind === "geojson" && layer.result.data.features.length > hexbinThreshold;
  const point = layer.style.geometry === "point";
  // Hex tiles and point columns key as the tile ramp (a picked cell too); clusters as the layer's symbol; extruded
  // areas as their area.
  if ((mode === "points" && dense && !feature) || (point && (mode === "hexbin" || mode === "columns"))) return hexTileLegend();
  if (mode === "clusters") return legendSymbol(layer.id, "points", { unit: layer.style.unit, color: color ?? op?.color, feature });
  if (mode === "columns") return legendSymbol(layer.id, "polygons", { unit: layer.style.unit, color: color ?? op?.color, feature });
  return legendSymbol(layer.id, mode, { unit: layer.style.unit, color: color ?? op?.color, feature });
}

/**
 * True when every feature the map draws for a layer (its data with the layer's filters applied, so a filter down to
 * routes counts) is a named route, which draws in Wally's gradient: then the layer's key is the gradient too. A layer
 * that mixes routes with plain segments keeps the key of its plain segments; a picked route has the gradient swatch.
 */
function allRoutes(layer: LoadedLayer, op: RenderOp | undefined): boolean {
  if (layer.result.kind !== "geojson") return false;
  const { features } = op?.filters ? applyFilters(layer.result.data, op.filters) : layer.result.data;
  return features.length > 0 && features.every((f) => isRouteProperties(f.properties));
}

/**
 * The swatch for a selected feature, as the map draws it: during a compare of its layer, in the side's color (A purple,
 * B pink) or, in delta mode, the feature's class color; otherwise the layer's own look for that feature.
 */
export function selectionSwatch(state: MapState, selection: Selection, layer: LoadedLayer): LegendSymbol {
  const op = state.renderOps.find((o) => o.layerId === selection.layerId);
  const mode = state.compare?.layerId === selection.layerId ? effectiveMode(state) : undefined;
  const feature = selection.feature;
  if (mode === "delta") {
    const cls: unknown = feature.properties?.delta;
    const color = cls === "a-only" || cls === "b-only" ? DELTA_COLORS[cls] : DELTA_COLORS.both;
    const area = feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
    // Unchanged lines draw sage, never a dark grey line (DELTA_LINE_COLORS); unchanged areas keep the dark grey outline.
    const lineColor = cls === "a-only" || cls === "b-only" ? DELTA_LINE_COLORS[cls] : DELTA_LINE_COLORS.both;
    return area
      ? { kind: "area", tint: color, tintAlpha: DELTA_FILL_ALPHA, hatch: color, hatchAlpha: 0, spacing: 0, outline: color, casing: WHITE }
      : { kind: "line", color: lineColor, dash: [0, 0], casing: WHITE, width: LINE.width, casingWidth: LINE.casing };
  }
  // Point sprites keep their own look on both sides; lines and areas take the side's color.
  if (mode && op?.mode !== "points") return layerLegend(layer, op, feature, selection.side === "b" ? COMPARE_COLORS.b : COMPARE_COLORS.a);
  return layerLegend(layer, op, feature);
}

/** Loaded layers top first (the last render op draws on top), then any layer still waiting for an op. */
function stackOrder(layers: MapState["layers"], renderOps: RenderOp[]): { layer: LoadedLayer; op?: RenderOp }[] {
  const withOps = renderOps
    .map((op) => ({ layer: layers[op.layerId], op }))
    .filter((item): item is { layer: LoadedLayer; op: RenderOp } => item.layer !== undefined)
    .reverse();
  const rest = Object.values(layers)
    .filter((layer) => !renderOps.some((op) => op.layerId === layer.id))
    .map((layer) => ({ layer }));
  return [...withOps, ...rest];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** How the map draws a layer, for its legend key: raster tiles hatch, vector tiles by geometry, geojson by mode. */
function legendModeFor(layer: LoadedLayer, op: RenderOp | undefined): LegendMode {
  if (layer.result.kind === "tiles") {
    if (layer.result.data.format === "raster") return "tiles";
    const geometry = layer.result.data.geometry ?? layer.style.geometry;
    return geometry === "polygon" ? "vector-polygons" : geometry === "line" ? "lines" : "points";
  }
  if (op) return op.mode;
  return layer.style.geometry === "polygon" ? "polygons" : layer.style.geometry === "line" ? "lines" : "points";
}

/**
 * Features drawn for a layer: the visible entry's count, or, while a swipe or toggle compare draws it twice, the
 * features on either side (side A alone read like a filter: "390 / 585" for an unfiltered layer). Null for tiles.
 */
export function drawnCount(shown: LoadedLayer | undefined, sideB: LoadedLayer | undefined): number | null {
  if (shown?.result.kind !== "geojson") return null;
  if (sideB?.result.kind !== "geojson") return shown.result.data.features.length;
  return new Set([...shown.result.data.features, ...sideB.result.data.features]).size;
}

type RowProps = {
  layer: LoadedLayer;
  /** The layer as drawn (time window and filters applied); its count shows as shown / total when smaller. */
  shownLayer: LoadedLayer | undefined;
  /** Side B of a swipe or toggle compare of this layer (then `shownLayer` is side A); the count is both sides'. */
  shownLayerB?: LoadedLayer;
  op: RenderOp | undefined;
  license: string | undefined;
  /** The amount a scenario layer shows (MapState.scenario, else the queried one); undefined for other layers. */
  scenarioValue?: number;
  dispatch: (action: MapAction) => void;
  onMove: (delta: 1 | -1) => void;
  dragProps: {
    draggable: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  armDrag: (armed: boolean) => void;
  dropTarget: boolean;
  dragging: boolean;
  selected: boolean;
  compare?: MapState["compare"];
};

/** A threshold readout: "All" at the data minimum, else "≥ 1,204 acres" (scores without a unit). */
export function measureLabel(value: number, range: MeasureRange, unit?: string, key = "v"): string {
  if (value <= range.min) return "All";
  const text = formatValue(key, value, unit, range.integer ? 0 : 2);
  return unit && unit !== "score" ? `≥ ${text} ${unit}` : `≥ ${text}`;
}

/** A labelled slider row: the small-caps label, a slim slider filling the row, the value inline at its end (no tooltip). */
function SliderRow({ label, srLabel, readout, children }: { label: string; srLabel: string; readout: string; children: (id: string) => ReactNode }) {
  const id = `slider-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <label htmlFor={id} className="small-caps w-[62px] shrink-0">
        {label}{" "}
        <span className="sr-only">{srLabel}</span>
      </label>
      {children(id)}
      <span aria-hidden className="w-10 shrink-0 text-right text-[12px] leading-4 text-ink tabular-nums">
        {readout}
      </span>
    </div>
  );
}

/**
 * A scenario layer's amount (sea level rise) as a labelled slider row over the scrubber's amounts, with the one shown
 * ("3 ft") inline.
 */
function ScenarioRowSlider({ layer, value, dispatch }: { layer: LoadedLayer; value: number; dispatch: (action: MapAction) => void }) {
  const scenario = scenarioOf(layer);
  if (!scenario) return null;
  const { values, unit, label } = scenario;
  const at = Math.max(0, values.indexOf(value));
  const fill = values.length > 1 ? (at / (values.length - 1)) * 100 : 100;
  return (
    <SliderRow label={label} srLabel={`for ${layer.title}`} readout={scenarioValueText(value, unit)}>
      {(id) => (
        <input
          id={id}
          type="range"
          min={0}
          max={values.length - 1}
          step={1}
          value={at}
          aria-valuetext={scenarioValueText(value, unit)}
          onChange={(e) => dispatch({ type: "set_scenario", layerId: layer.id, value: values[Number(e.target.value)] })}
          data-testid="scenario-row-slider"
          className="layer-opacity min-w-0 flex-1"
          style={{ ["--fill" as string]: `${Math.round(fill)}%` }}
        />
      )}
    </SliderRow>
  );
}

/** One of the row's sections (Show as): a hairline above, then its small-caps heading. */
function RowSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="row-section">
      <h3 className="small-caps mb-1.5 text-ink!">{heading}</h3>
      {children}
    </div>
  );
}

/**
 * One legend row, every part inside the panel's width, top to bottom: the header (the key, which is also the drag
 * handle; the title on up to two lines; the count, "6 of 280" when filtered; a Hide/Show text toggle; ×); one line of
 * source and coverage, its full text and licence behind the "i"; the facets (components/FacetControls.tsx) and "More
 * filters" for the free-form panel; Show as (point layers); and opacity as a labelled slider with its value inline.
 */
function LegendRow({
  layer,
  shownLayer,
  shownLayerB,
  op,
  license,
  scenarioValue,
  dispatch,
  onMove,
  dragProps,
  armDrag,
  dropTarget,
  dragging,
  selected,
  compare,
}: RowProps) {
  const visible = op?.visible ?? false;
  const opacity = op?.opacity ?? 1;
  const count = layer.result.kind === "geojson" ? layer.result.data.features.length : null;
  const shownCount = drawnCount(shownLayer, shownLayerB) ?? count;
  const data = layer.result.kind === "geojson" ? layer.result.data : null;
  const unit = layer.style.unit;
  const facets = facetsOf(layer.style);
  // The free-form panel keeps every other field; the facets have their own controls in the row.
  const fields = useMemo<FilterField[]>(
    () => (data ? deriveFilterFields(data, { unitForV: unit }).filter((f) => !facets.some((x) => x.key === f.key)) : []),
    [data, unit, facets],
  );
  const filters = op?.filters ?? {};
  const activeCount = Object.keys(filters).length;
  const summary =
    activeCount > 0
      ? [
          facetFilterSummary(facets, filters),
          filterSummary(fields, Object.fromEntries(Object.entries(filters).filter(([k]) => !facets.some((f) => f.key === k)))),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const caption = op?.visible ? viewCaption(op.view, layer, compare) : undefined;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = `filters-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { citation, coverageNote } = layer.result;
  const host = hostOf(citation.url);
  const sourceHelp: FieldHelp = {
    text: coverageNote ?? `${layer.title}, from ${citation.source}.`,
    source: [citation.source, license && `Licence: ${license}`, citation.retrieved && `Retrieved ${citation.retrieved.slice(0, 10)}`].filter(Boolean).join(" · "),
    url: citation.url,
  };
  const symbol = layerLegend(layer, op);
  // A raster layer's key shows the tiles' raw color through the same filter the map applies (lib/render/rasterCalm.ts).
  const isRaster = layer.result.kind === "tiles" && layer.result.data.format === "raster" && symbol.kind === "tiles";
  const swatch = isRaster ? layer.style.raster?.swatch : undefined;
  const keySymbol: LegendSymbol = symbol.kind === "tiles" && swatch ? { ...symbol, color: swatch } : symbol;
  const keyFilter = isRaster ? rasterKeyFilter(layer.style.raster) : "";
  const pointModes = op && layer.result.kind === "geojson" && layer.style.geometry === "point";

  const gripRef = useRef<HTMLButtonElement>(null);
  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? 1 : -1);
    // React moves the row's node to its new place, which drops focus; put it back so repeated presses work.
    requestAnimationFrame(() => gripRef.current?.focus());
  };

  const moreFilters = op && fields.length > 0 && (
    <div className="pl-9">
      <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-controls={filtersId} className="row-link mt-2">
        {facets.length > 0 ? "More filters" : "Filters"}
        {activeCount > 0 && <span className="tabular-nums"> · {activeCount}</span>}
      </button>
    </div>
  );

  return (
    <li
      data-testid="layer-card"
      data-layer-id={layer.id}
      data-selected={selected || undefined}
      data-hidden={!visible || undefined}
      data-drop-target={dropTarget || undefined}
      data-filters-open={(filtersOpen && fields.length > 0) || undefined}
      {...dragProps}
      className={`legend-row relative min-w-0 py-3 transition-opacity duration-150 ${dragging ? "opacity-40" : ""}`}
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto_auto_auto] items-start gap-x-2">
        <button
          type="button"
          ref={gripRef}
          aria-label={`Reorder ${layer.title} (arrow keys)`}
          disabled={!op}
          onPointerDown={() => armDrag(true)}
          onPointerUp={() => armDrag(false)}
          onKeyDown={onHandleKey}
          className="-my-[3px] flex h-6 w-6 cursor-grab items-center justify-center rounded-[4px] text-ink active:cursor-grabbing disabled:cursor-default"
        >
          <span className="flex" style={keyFilter ? { filter: keyFilter } : undefined}>
            <LegendKey symbol={keySymbol} />
          </span>
        </button>
        <p data-testid="layer-title" className={`line-clamp-2 text-[13px] leading-[18px] [overflow-wrap:anywhere] ${visible ? "text-ink" : "text-ink-muted"}`}>
          {layer.title}
        </p>
        {count !== null ? (
          <span data-testid="layer-count" className="text-right text-[12px] leading-[18px] whitespace-nowrap text-ink-muted tabular-nums">
            {shownCount !== null && shownCount !== count ? (
              <>
                <span className="text-ink">{shownCount.toLocaleString()}</span> of {count.toLocaleString()}
              </>
            ) : (
              <span className="text-ink">{count.toLocaleString()}</span>
            )}
          </span>
        ) : (
          <span className="small-caps text-right leading-[18px]">tiles</span>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "toggle_layer", layerId: layer.id })}
          disabled={!op}
          aria-label={`${visible ? "Hide" : "Show"} ${layer.title}`}
          data-testid="visibility-toggle"
          className="row-toggle hit-target"
        >
          {visible ? "Hide" : "Show"}
        </button>
        {/* Always visible (owner: "close out measures ... when I don't want them anymore"). */}
        <button type="button" onClick={() => dispatch({ type: "remove_layer", layerId: layer.id })} aria-label={`Remove ${layer.title}`} className={`${REMOVE_BUTTON} leading-[18px]`}>
          ×
        </button>
      </div>

      <p data-testid="layer-source" className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-ink-muted">
        <span className="min-w-0 truncate">
          <a href={citation.url} target="_blank" rel="noreferrer" className="dashed-link">
            {host ?? citation.source}
          </a>
          {coverageNote && <> · {coverageNote}</>}
        </span>
        <InfoMark help={sourceHelp} label={`the source of ${layer.title}`} />
      </p>
      {caption && (
        <p data-testid="view-caption" className="mt-1 text-[11.5px] leading-4 text-ink-muted">
          {caption}
        </p>
      )}
      {summary && (
        <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-4 text-ink-muted">
          <span data-testid="filter-summary" className="min-w-0 truncate">
            Filtered: {summary}
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: "set_filters", layerId: layer.id, filters: {} })}
            aria-label={`Remove filters on ${layer.title}`}
            className={REMOVE_BUTTON}
          >
            ×
          </button>
        </p>
      )}

      {/* Facets (spec §12a) are always visible, never behind a disclosure or hover. */}
      {op && data && facets.length > 0 && (
        <FacetControls
          layerId={layer.id}
          title={layer.title}
          facets={facets}
          data={data}
          filters={filters}
          geometry={layer.style.geometry}
          fieldHelp={layer.fieldHelp}
          dispatch={dispatch}
        />
      )}
      {moreFilters}
      {/* Open filters stay open, so a slider can be dragged and read without the row folding away. */}
      {op && filtersOpen && fields.length > 0 && (
        <LayerFilters id={filtersId} layerId={layer.id} title={layer.title} fields={fields} filters={filters} dispatch={dispatch} />
      )}
      {pointModes && (
        <RowSection heading="Show as">
          <PointModeControl layer={layer} mode={op.mode} dispatch={dispatch} />
        </RowSection>
      )}
      {op && (
        <div className="mt-3 space-y-2">
          {scenarioValue !== undefined && <ScenarioRowSlider layer={layer} value={scenarioValue} dispatch={dispatch} />}
          <SliderRow label="Opacity" srLabel={`for ${layer.title}`} readout={`${Math.round(opacity * 100)}%`}>
            {(id) => (
              <input
                id={id}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                aria-valuetext={`${Math.round(opacity * 100)}%`}
                onChange={(e) => dispatch({ type: "set_opacity", layerId: layer.id, opacity: Number(e.target.value) })}
                data-testid="opacity-slider"
                className="layer-opacity min-w-0 flex-1"
                style={{ ["--fill" as string]: `${Math.round(opacity * 100)}%` }}
              />
            )}
          </SliderRow>
        </div>
      )}
    </li>
  );
}

/**
 * The hairline ×: a text glyph (no icon font), muted until hovered. An invisible ::after reaches 8px past the glyph on
 * every side, so the hit area is at least 28px without the × looking or laying out any bigger.
 */
const REMOVE_BUTTON =
  "relative px-1 text-[15px] leading-none text-ink-muted transition-colors duration-150 hover:text-ink after:absolute after:-inset-2 after:content-['']";

/** Quiet text buttons in the panel header. */
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";

/**
 * The layer panel, a research legend: one row per loaded layer, top first, with its monochrome key, title, count,
 * Hide/Show and ×, its source, its facets, how it draws and its opacity, all visible and all inside the panel; drag
 * (or arrow keys on the key) to reorder. The top slot holds the time scrubber when one is mounted. Closed, it renders nothing: the layers map pill
 * reopens it.
 */
export function LayerStack({
  layers,
  renderOps,
  catalog,
  dispatch,
  open,
  onOpenChange,
  selectedLayerId,
  time,
  shownLayers,
  compareSlot,
  scenarioSlot,
  scenario,
  compare,
}: LayerStackProps) {
  const items = stackOrder(layers, renderOps);
  // A dated tile layer whose tiles all failed for the window's date (lib/render/tileErrors.ts).
  const missingTiles = useSyncExternalStore(missingTilesStore.subscribe, missingTilesStore.get, missingTilesStore.get);
  const missingImage = time !== undefined && hasMissingImage(shownLayers ?? layers, missingTiles);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const moveTo = (layerId: string, targetId: string) => {
    const toIndex = renderOps.findIndex((op) => op.layerId === targetId);
    if (toIndex !== -1 && layerId !== targetId) dispatch({ type: "reorder", layerId, toIndex });
  };

  if (!open) return null;

  return (
    <section
      aria-label="Layers"
      data-testid="layer-stack"
      // Phones: below the map pills instead of over them (the app positions the column at `--console-top`, measured
      // from the pills), clear of the map buttons on the right, ending above the chat sheet, and one scrolling column
      // (the scrubber, the compare and the layers scroll together) so a short screen never squeezes the list to nothing.
      data-scroll="console"
      className="glass-strong rise-in @container/panel pointer-events-auto flex max-h-[calc(100dvh-24px-var(--safe-top)-var(--safe-bottom))] max-w-[calc(100vw-24px-var(--safe-left)-var(--safe-right))] flex-col overflow-hidden rounded-panel max-md:max-h-[calc(54dvh-var(--console-top,60px)-12px)] max-md:max-w-[calc(100vw-68px-var(--safe-left)-var(--safe-right))] max-md:overflow-y-auto max-md:overscroll-contain md:max-h-[calc(100dvh-260px-var(--safe-top)-var(--safe-bottom))]"
      style={{ width: LAYER_PANEL_WIDTH }}
    >
      {/* The time scrubber docks here while any layer has dated features; empty, the slot takes no space. */}
      <div data-slot="time-scrubber" className="shrink-0 empty:hidden">
        {time && (
          <>
            <TimeScrubber time={time} dispatch={dispatch} missingImage={missingImage} />
            <div aria-hidden className="hairline mx-5" />
          </>
        )}
        {/* The scenario scrubber (sea level rise amounts) shares the slot, under the time scrubber. */}
        {scenarioSlot}
      </div>
      {/* Compare over time sits under the scrubber; empty (nothing to compare), the slot takes no space. */}
      <div data-slot="compare" className="shrink-0 empty:hidden">
        {compareSlot}
      </div>
      <header className="flex shrink-0 items-baseline gap-3 px-5 pt-4 pb-1.5">
        <h2 className="small-caps">
          Layers <span className="ml-1 text-ink tabular-nums">{items.length}</span>
        </h2>
        <span className="flex-1" />
        <button type="button" onClick={() => dispatch({ type: "clear_layers" })} className={TEXT_BUTTON}>
          Clear all
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-expanded
          aria-label="Close layers"
          className={TEXT_BUTTON}
        >
          Close
        </button>
      </header>
      <div aria-hidden className="hairline mx-5 shrink-0" />
      <ul className="legend-table min-h-0 overflow-y-auto overscroll-contain px-5 pb-2 max-md:shrink-0 max-md:overflow-visible">
        {items.map(({ layer, op }) => {
          const index = renderOps.findIndex((o) => o.layerId === layer.id);
          return (
            <LegendRow
              key={layer.id}
              layer={layer}
              shownLayer={shownLayers?.[layer.id]}
              shownLayerB={shownLayers?.[compareBId(layer.id)]}
              op={op}
              license={catalog?.[layer.id]?.license}
              scenarioValue={currentScenarioValue({ layers, scenario }, layer.id)}
              dispatch={dispatch}
              onMove={(delta) => {
                if (index !== -1) dispatch({ type: "reorder", layerId: layer.id, toIndex: index + delta });
              }}
              armDrag={(on) => setArmed(on ? layer.id : null)}
              dropTarget={overId === layer.id && dragId !== null && dragId !== layer.id}
              dragging={dragId === layer.id}
              selected={selectedLayerId === layer.id}
              compare={compare}
              dragProps={{
                // Only the key starts a drag, so the slider and text stay usable.
                draggable: armed === layer.id,
                onDragStart: (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", layer.id);
                  setDragId(layer.id);
                },
                onDragOver: (e) => {
                  if (!dragId || !op) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overId !== layer.id) setOverId(layer.id);
                },
                onDrop: (e) => {
                  e.preventDefault();
                  if (dragId) moveTo(dragId, layer.id);
                  setDragId(null);
                  setOverId(null);
                  setArmed(null);
                },
                onDragEnd: () => {
                  setDragId(null);
                  setOverId(null);
                  setArmed(null);
                },
              }}
            />
          );
        })}
      </ul>
    </section>
  );
}

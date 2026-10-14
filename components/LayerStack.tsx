"use client";

import { useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { LayerFilters } from "@/components/LayerFilters";
import { TimeScrubber } from "@/components/TimeScrubber";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import {
  applyFilters,
  deriveFilterFields,
  filterSummary,
  MEASURE_STEPS,
  measureAt,
  measureKey,
  measureMinimum,
  measurePosition,
  measureRange,
  withMeasureMinimum,
  type FilterField,
  type LayerFilters as Filters,
  type MeasureRange,
} from "@/lib/render/filters";
import type { Feature } from "geojson";
import { LegendKey } from "@/components/LegendKey";
import { formatValue } from "@/lib/format";
import { rasterKeyFilter } from "@/lib/render/rasterCalm";
import { currentScenarioValue, scenarioOf, scenarioValueText } from "@/lib/render/scenario";
import { COMPARE_COLORS, compareBId, DELTA_FILL_ALPHA, effectiveMode } from "@/lib/render/compareView";
import { hexbinThreshold } from "@/lib/render/deck";
import { isRouteProperties, WHITE } from "@/lib/render/palette";
import { POINT_MODES, type LoadedLayer, type MapAction, type MapState, type RenderMode, type RenderOp, type Selection, type TimeState } from "@/lib/render/state";
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
};

/** Modes the select offers line and area layers; areas with an `extrude` hint (or already extruded) can stand as 3D columns. */
const MODES: { value: RenderMode; label: string }[] = [
  { value: "points", label: "Points" },
  { value: "lines", label: "Lines" },
  { value: "polygons", label: "Polygons" },
  { value: "heat", label: "Heat" },
];
const EXTRUDE_MODE = { value: "columns" as RenderMode, label: "Columns (3D)" };

/** The segment a point layer's mode lights up: hex tiles (`hexbin`) read as columns, their 2D form. */
function pointSegment(mode: RenderMode): RenderMode {
  return mode === "hexbin" ? "columns" : mode;
}

/**
 * A point layer's render mode as a small text segmented control (Symbols · Clusters · Heat · Columns): research look, no
 * icons; the pressed segment is ink, the rest muted.
 */
function PointModeControl({ layer, mode, dispatch }: { layer: LoadedLayer; mode: RenderMode; dispatch: (action: MapAction) => void }) {
  const current = pointSegment(mode);
  return (
    <div role="group" aria-label={`Draw ${layer.title} as`} data-testid="mode-control" className="flex items-baseline text-[11.5px] leading-4">
      {POINT_MODES.map((m, i) => (
        <span key={m.value} className="flex items-baseline">
          {i > 0 && (
            <span aria-hidden className="px-1 text-ink-muted">
              ·
            </span>
          )}
          <button
            type="button"
            aria-pressed={current === m.value}
            onClick={() => current !== m.value && dispatch({ type: "set_style", layerId: layer.id, mode: m.value })}
            className={`hit-target transition-colors duration-150 ${current === m.value ? "text-ink underline decoration-1 underline-offset-[3px]" : "text-ink-muted hover:text-ink"}`}
          >
            {m.label}
          </button>
        </span>
      ))}
    </div>
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
    const color = cls === "a-only" ? COMPARE_COLORS.a : cls === "b-only" ? COMPARE_COLORS.b : COMPARE_COLORS.both;
    const area = feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
    return area
      ? { kind: "area", tint: color, tintAlpha: DELTA_FILL_ALPHA, hatch: color, hatchAlpha: 0, spacing: 0, outline: color, casing: WHITE }
      : { kind: "line", color, dash: [0, 0], casing: WHITE, width: 2.5, casingWidth: 4.5 };
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
};

/** A threshold readout: "All" at the data minimum, else "≥ 1,204 acres" (scores without a unit). */
export function measureLabel(value: number, range: MeasureRange, unit?: string, key = "v"): string {
  if (value <= range.min) return "All";
  const text = formatValue(key, value, unit, range.integer ? 0 : 2);
  return unit && unit !== "score" ? `≥ ${text} ${unit}` : `≥ ${text}`;
}

/**
 * The owner's fader: a minimum on the layer's primary measure `v` (popularity, fire acres, lake depth, wave height),
 * applied through the filters engine so the count, export and permalink follow. At the left end there is no filter.
 */
function MeasureSlider({
  layer,
  range,
  measure,
  filters,
  dispatch,
}: {
  layer: LoadedLayer;
  range: MeasureRange;
  /** The property the slider filters on (lib/render/filters.ts `measureKey`). */
  measure: string;
  filters: Filters;
  dispatch: (action: MapAction) => void;
}) {
  const value = measureMinimum(filters, range, measure);
  const position = measurePosition(value, range);
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Minimum {layer.style.unit && layer.style.unit !== "score" ? layer.style.unit : "value"} for {layer.title}</span>
      <input
        type="range"
        min={0}
        max={MEASURE_STEPS}
        step={1}
        value={position}
        aria-valuetext={measureLabel(value, range, layer.style.unit, measure)}
        onChange={(e) =>
          dispatch({
            type: "set_filters",
            layerId: layer.id,
            filters: withMeasureMinimum(filters, measureAt(Number(e.target.value), range), range, measure),
          })
        }
        data-testid="measure-slider"
        className="layer-opacity w-[60px]"
        style={{ ["--fill" as string]: `${Math.round((position / MEASURE_STEPS) * 100)}%` }}
      />
      <span aria-hidden className="text-[11px] whitespace-nowrap text-ink-muted tabular-nums">
        {measureLabel(value, range, layer.style.unit, measure)}
      </span>
    </label>
  );
}

/**
 * A scenario layer's row slider (sea level rise), in place of opacity: the amounts on the scenario scrubber, with the
 * one shown ("3 ft"). Opacity stays available to the agent (render, set_opacity).
 */
function ScenarioRowSlider({ layer, value, dispatch }: { layer: LoadedLayer; value: number; dispatch: (action: MapAction) => void }) {
  const scenario = scenarioOf(layer);
  if (!scenario) return null;
  const { values, unit, label } = scenario;
  const at = Math.max(0, values.indexOf(value));
  const fill = values.length > 1 ? (at / (values.length - 1)) * 100 : 100;
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">
        {label} for {layer.title}
      </span>
      <input
        type="range"
        min={0}
        max={values.length - 1}
        step={1}
        value={at}
        aria-valuetext={scenarioValueText(value, unit)}
        onChange={(e) => dispatch({ type: "set_scenario", layerId: layer.id, value: values[Number(e.target.value)] })}
        data-testid="scenario-row-slider"
        className="layer-opacity w-[60px]"
        style={{ ["--fill" as string]: `${Math.round(fill)}%` }}
      />
      <span aria-hidden className="w-9 text-right text-[11px] text-ink-muted tabular-nums">
        {scenarioValueText(value, unit)}
      </span>
    </label>
  );
}

/**
 * One legend row: the key (also the drag handle), the title over a muted line of coverage, license and source, the
 * feature count in tabular figures and an always-visible ×, and (on hover or focus) visibility, the measure threshold
 * (or opacity, for layers without a numeric `v`), mode and filters.
 */
function LegendRow({ layer, shownLayer, shownLayerB, op, license, scenarioValue, dispatch, onMove, dragProps, armDrag, dropTarget, dragging, selected }: RowProps) {
  const visible = op?.visible ?? false;
  const opacity = op?.opacity ?? 1;
  const count = layer.result.kind === "geojson" ? layer.result.data.features.length : null;
  const shownCount = drawnCount(shownLayer, shownLayerB) ?? count;
  const data = layer.result.kind === "geojson" ? layer.result.data : null;
  const unit = layer.style.unit;
  const fields = useMemo<FilterField[]>(() => (data ? deriveFilterFields(data, { unitForV: unit }) : []), [data, unit]);
  const filters = op?.filters ?? {};
  const activeCount = Object.keys(filters).length;
  const summary = activeCount > 0 ? filterSummary(fields, filters) : "";
  const range = useMemo(() => (data ? measureRange(data) : null), [data]);
  const measure = useMemo(() => (data ? measureKey(data) : "v"), [data]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = `filters-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { citation, coverageNote } = layer.result;
  const host = hostOf(citation.url);
  const symbol = layerLegend(layer, op);
  // A raster layer's key shows the tiles' raw color through the same filter the map applies (lib/render/rasterCalm.ts).
  const isRaster = layer.result.kind === "tiles" && layer.result.data.format === "raster" && symbol.kind === "tiles";
  const swatch = isRaster ? layer.style.raster?.swatch : undefined;
  const keySymbol: LegendSymbol = symbol.kind === "tiles" && swatch ? { ...symbol, color: swatch } : symbol;
  const keyFilter = isRaster ? rasterKeyFilter(layer.style.raster) : "";

  const gripRef = useRef<HTMLButtonElement>(null);
  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? 1 : -1);
    // React moves the row's node to its new place, which drops focus; put it back so repeated presses work.
    requestAnimationFrame(() => gripRef.current?.focus());
  };

  return (
    <li
      data-testid="layer-card"
      data-layer-id={layer.id}
      data-selected={selected || undefined}
      data-hidden={!visible || undefined}
      data-drop-target={dropTarget || undefined}
      data-filters-open={(filtersOpen && fields.length > 0) || undefined}
      {...dragProps}
      className={`legend-row relative py-2.5 transition-opacity duration-150 ${dragging ? "opacity-40" : ""}`}
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto_auto] items-start gap-x-3">
        <button
          type="button"
          ref={gripRef}
          aria-label={`Reorder ${layer.title} (arrow keys)`}
          title="Drag to reorder"
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
        <div className="min-w-0">
          <p className={`truncate text-[13px] leading-[18px] ${visible ? "text-ink" : "text-ink-muted"}`} title={layer.title}>
            {layer.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-ink-muted">
            {coverageNote && (
              <>
                <span title={coverageNote}>{coverageNote}</span>
                {" · "}
              </>
            )}
            {license && <span title={license}>{license} · </span>}
            <a href={citation.url} target="_blank" rel="noreferrer" title={citation.source} className="dashed-link whitespace-nowrap">
              {host ?? citation.source}
            </a>
          </p>
          {summary && (
            <p className="mt-0.5 flex items-baseline gap-1.5 text-[11.5px] leading-4 text-ink-muted">
              <span data-testid="filter-summary" className="min-w-0 truncate" title={summary}>
                Filtered: {summary}
              </span>
              <button
                type="button"
                onClick={() => dispatch({ type: "set_filters", layerId: layer.id, filters: {} })}
                aria-label={`Remove filters on ${layer.title}`}
                title="Clear filters"
                className={REMOVE_BUTTON}
              >
                ×
              </button>
            </p>
          )}
        </div>
        {count !== null ? (
          shownCount !== null && shownCount !== count ? (
            <span
              data-testid="layer-count"
              className="text-right text-[12px] leading-[18px] text-ink-muted tabular-nums"
              title={`${shownCount.toLocaleString()} of ${count.toLocaleString()} features shown`}
            >
              <span className="text-ink">{shownCount.toLocaleString()}</span> / {count.toLocaleString()}
            </span>
          ) : (
            <span
              data-testid="layer-count"
              className="text-right text-[12px] leading-[18px] text-ink tabular-nums"
              title={`${count.toLocaleString()} ${count === 1 ? "feature" : "features"}`}
            >
              {count.toLocaleString()}
            </span>
          )
        ) : (
          <span className="small-caps text-right leading-[18px]">tiles</span>
        )}
        {/* Always visible (owner: "close out measures ... when I don't want them anymore"), not only on hover. */}
        <button
          type="button"
          onClick={() => dispatch({ type: "remove_layer", layerId: layer.id })}
          aria-label={`Remove ${layer.title}`}
          title="Remove layer"
          className={`${REMOVE_BUTTON} -mr-1 leading-[18px]`}
        >
          ×
        </button>
      </div>

      {/* The grid row collapses to 0 while hidden; the padding lives inside it so a collapsed row stays tight. */}
      <div className="legend-controls">
        <div>
          <div className="flex items-center gap-2.5 pt-2 pl-9">
            <button
              type="button"
              onClick={() => dispatch({ type: "toggle_layer", layerId: layer.id })}
              disabled={!op}
              aria-pressed={visible}
              aria-label={`Show ${layer.title}`}
              title={visible ? "Hide layer" : "Show layer"}
              className="legend-check"
            />
            {op && range && <MeasureSlider layer={layer} range={range} measure={measure} filters={filters} dispatch={dispatch} />}
            {op && !range && scenarioValue !== undefined && (
              <ScenarioRowSlider layer={layer} value={scenarioValue} dispatch={dispatch} />
            )}
            {op && !range && scenarioValue === undefined && (
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Opacity for {layer.title}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => dispatch({ type: "set_opacity", layerId: layer.id, opacity: Number(e.target.value) })}
                  className="layer-opacity w-[60px]"
                  style={{ ["--fill" as string]: `${Math.round(opacity * 100)}%` }}
                />
                <span aria-hidden className="w-7 text-right text-[11px] text-ink-muted tabular-nums">
                  {Math.round(opacity * 100)}%
                </span>
              </label>
            )}
            {op && layer.result.kind === "geojson" && layer.style.geometry !== "point" && (
              <label>
                <span className="sr-only">Draw {layer.title} as</span>
                <select
                  value={op.mode}
                  onChange={(e) => dispatch({ type: "set_style", layerId: layer.id, mode: e.target.value as RenderMode })}
                  className="legend-select"
                >
                  {[...MODES, ...(layer.style.geometry === "polygon" && (layer.style.extrude || op.mode === "columns") ? [EXTRUDE_MODE] : [])].map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {op && fields.length > 0 && (
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                aria-expanded={filtersOpen}
                aria-controls={filtersId}
                className="legend-disclosure whitespace-nowrap"
              >
                Filters{activeCount > 0 && <span className="tabular-nums"> · {activeCount}</span>}
              </button>
            )}
          </div>
          {op && layer.result.kind === "geojson" && layer.style.geometry === "point" && (
            <div className="pt-1.5 pl-9">
              <PointModeControl layer={layer} mode={op.mode} dispatch={dispatch} />
            </div>
          )}
        </div>
      </div>
      {/* Open filters stay open off hover, so a slider can be dragged and read without the row folding away. */}
      {op && filtersOpen && fields.length > 0 && (
        <LayerFilters id={filtersId} layerId={layer.id} title={layer.title} fields={fields} filters={filters} dispatch={dispatch} />
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
 * The layer panel, a research legend: one row per loaded layer, top first, with its monochrome key, title, source
 * and count; visibility, opacity, render mode and removal on hover or focus; drag (or arrow keys on the key) to
 * reorder. The top slot holds the time scrubber when one is mounted. Closed, it renders nothing: the layers map pill
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
      className="glass-strong rise-in pointer-events-auto flex max-h-[calc(100dvh-24px-var(--safe-top)-var(--safe-bottom))] max-w-[calc(100vw-24px-var(--safe-left)-var(--safe-right))] flex-col overflow-hidden rounded-panel max-md:max-h-[calc(54dvh-var(--console-top,60px)-12px)] max-md:max-w-[calc(100vw-68px-var(--safe-left)-var(--safe-right))] max-md:overflow-y-auto max-md:overscroll-contain md:max-h-[calc(100dvh-260px-var(--safe-top)-var(--safe-bottom))]"
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
          aria-label="Collapse layers"
          title="Collapse"
          className={TEXT_BUTTON}
        >
          Hide
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

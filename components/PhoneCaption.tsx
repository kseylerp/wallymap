"use client";

import { useMemo } from "react";
import { RowLegend } from "@/components/RowLegend";
import { TimePanel, wholeSpan, windowText } from "@/components/TimePanel";
import { shortTitle } from "@/layers/contract";
import { failureLine, layerSourceStatus, timeShape } from "@/lib/render/contract";
import { featuresInView, useInView } from "@/lib/render/inView";
import { rowLegend, type LegendBlock } from "@/lib/render/legendView";
import { compareSideText, deltaKey, effectiveMode } from "@/lib/render/compareView";
import { compareSummary } from "@/lib/render/compare";
import type { LoadedLayer, MapAction, MapState } from "@/lib/render/state";
import { layerChange } from "@/lib/render/views";
import { periodOfUrl } from "@/lib/time";
import { currentScenarioValue, scenarioOf, scenarioValueText } from "@/lib/render/scenario";

const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };

function dayText(iso: string): string {
  const ms = Date.parse(/^\d{4}$/.test(iso) ? `${iso}-01-01` : iso);
  if (Number.isNaN(ms)) return iso;
  return /^\d{4}$/.test(iso) ? iso : new Date(ms).toLocaleDateString("en-US", DAY);
}

/**
 * What a layer's map shows, in one phrase: the amount or year of a scenario ("3 ft", "2020 estimate"), a dated tile's
 * period, the time window ("1963 – 2019, newest of each"), a single reading's or dataset's date, else for features when
 * they were fetched ("As of Oct 18, 2026"). A static picture with no date says none rather than today's.
 */
export function captionDate(
  layer: LoadedLayer,
  drawn: LoadedLayer | undefined,
  time: MapState["time"],
  at?: [number, number],
  scenarioText?: string,
): string {
  if (scenarioText) return scenarioText;
  const tiles = (drawn ?? layer).result;
  // A dated tile draws one period, whatever window the scrubber spans: say that period.
  if (tiles.kind === "tiles" && tiles.data.time) {
    const ms = periodOfUrl(tiles.data.url, tiles.data.time);
    if (ms !== null) return tiles.data.time.cadence === "yearly" ? String(new Date(ms).getUTCFullYear()) : new Date(ms).toLocaleDateString("en-US", DAY);
  }
  if (time && time.index.layerIds.includes(layer.id)) {
    const { index, window } = time;
    if (index.snapshots && wholeSpan(index, window)) {
      const stops = index.snapshots.stops;
      return `${stops[0].label}–${stops[stops.length - 1].label}, ${index.cadence ? "latest" : "newest of each"}`;
    }
    return windowText(window, index.bucket, at);
  }
  const shape = timeShape(layer);
  if ((shape.shape === "single" || shape.shape === "snapshots") && shape.span) {
    return shape.span.start === shape.span.end ? dayText(shape.span.start) : `${dayText(shape.span.start)} – ${dayText(shape.span.end)}`;
  }
  // A dataset of one declared year (wildfire hazard, 2023) says that year.
  if (shape.dates && shape.dates.length > 0) return dayText(shape.dates[shape.dates.length - 1]);
  if (layer.result.kind === "tiles") return "";
  const retrieved = layer.result.citation.retrieved;
  return retrieved ? `As of ${dayText(retrieved.slice(0, 10))}` : "";
}

/**
 * The phone's first screen (owner: "the first phone screen shows the date and a mini legend"): under the map pills, the
 * top layer's name and date, its key in one line, and for snapshots the change it shows; a failed source says so. Tap
 * opens the data console. Shown only while the console is closed.
 */
/** The scenario amount a tile layer shows ("3 ft", "2020 NLCD"), or undefined. */
function scenarioCaption(state: MapState, layer: LoadedLayer): string | undefined {
  const scenario = scenarioOf(layer);
  const value = currentScenarioValue(state, layer.id);
  return scenario && value !== undefined ? scenarioValueText(value, scenario.unit) : undefined;
}

export function PhoneCaption({ state, shown, onOpen }: { state: MapState; shown: MapState["layers"]; onOpen: () => void }) {
  const top = [...state.renderOps].reverse().find((op) => op.visible && state.layers[op.layerId]);
  const layer = top ? state.layers[top.layerId] : undefined;
  const drawn = layer ? shown[layer.id] : undefined;
  const compared = state.compare?.layerId === layer?.id ? state.compare : undefined;
  const deltaMode = compared && effectiveMode(state) === "delta";
  const inView = useInView();
  const blocks = useMemo((): LegendBlock[] => {
    if (!layer || !top) return [];
    if (compared && deltaMode) {
      // The delta's own key (spec §12 change view): what pink, grey and purple mean on this map.
      const a = compareSideText(compared, "a", layer);
      const b = compareSideText(compared, "b", layer);
      const delta = drawn?.result.kind === "geojson" ? compareSummary(drawn.result.data) : null;
      return [
        {
          kind: "categories",
          shape: layer.style.geometry,
          entries: deltaKey(layer, a, b, delta).map(({ label, color, outline }) => ({ label, color, ...(outline && { outline }) })),
        },
      ];
    }
    const data = drawn?.result.kind === "geojson" ? drawn.result.data : null;
    // The mini legend keys what is in view (lib/render/inView.ts): the zones around Denver, not 3a, 6a, 9a and 12a.
    const view = inView.bounds
      ? { data: data ? featuresInView(data, inView.bounds) : null, tile: inView.tiles[layer.id], zoom: state.viewport.zoom, latitude: state.viewport.latitude }
      : undefined;
    return rowLegend(layer, top, data, view);
  }, [layer, top, drawn, compared, deltaMode, inView, state.viewport.zoom, state.viewport.latitude]);
  // Snapshots state their change; a compare on the layer states the compare's (the owner's glacier case on a phone).
  const change = useMemo(
    () => (layer && (compared || timeShape(layer).shape === "snapshots") ? layerChange(layer, top?.filters, compared) : null),
    [layer, top?.filters, compared],
  );
  if (!layer) {
    // Nothing drawn because the source failed (mining claims where BLM's map is offline): say so on the first screen,
    // as the Layers row does, rather than leave a bare map.
    const failed = state.errors[state.errors.length - 1];
    if (!failed) return null;
    const line = failureLine(failed.sourceStatus, 0) ?? failed.message;
    return (
      <button type="button" onClick={onOpen} data-testid="phone-caption" aria-label="Open the layers" className="glass-strong rise-in pointer-events-auto block max-w-full rounded-[12px] px-3 py-2 text-left">
        <p className="line-clamp-3 text-[11.5px] leading-4 text-ink" data-testid="phone-caption-failure">
          {line}
        </p>
      </button>
    );
  }
  const count = drawn?.result.kind === "geojson" ? drawn.result.data.features.length : null;
  const failure = failureLine(layerSourceStatus(layer), count);
  const center: [number, number] = [state.viewport.longitude, state.viewport.latitude];
  const date = compared ? `${compareSideText(compared, "a", layer)} against ${compareSideText(compared, "b", layer)}` : captionDate(layer, drawn, state.time, center, scenarioCaption(state, layer));
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="phone-caption"
      aria-label={`${layer.title}: open the layers`}
      className="glass-strong rise-in pointer-events-auto block max-w-full rounded-[12px] px-3 py-2 text-left"
    >
      <p className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-4">
        <span className="shrink-0 font-semibold text-ink">{shortTitle(layer)}</span>
        {date && <span className="min-w-0 truncate text-ink-muted tabular-nums" data-testid="phone-caption-date">{date}</span>}
      </p>
      {failure ? (
        <p className="mt-1 line-clamp-2 text-[11.5px] leading-4 text-ink">{failure}</p>
      ) : (
        <>
          {layer.result.kind === "tiles" && layer.result.viewNote && (
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-4 text-ink" data-testid="phone-caption-view-note">
              {layer.result.viewNote}.
            </p>
          )}
          {change && (
            <p className="mt-1 line-clamp-3 text-[11.5px] leading-4 text-ink" data-testid="phone-caption-change">
              {change.text.split(". ")[0].replace(/\.$/, "")}.
            </p>
          )}
          {blocks.length > 0 && (
            <div className="mt-1">
              <RowLegend blocks={blocks} compact />
            </div>
          )}
        </>
      )}
    </button>
  );
}

/** The time panel on a phone with the console closed: one compact row above the chat, only while it is open. */
export function PhoneTimeDock({ state, dispatch }: { state: MapState; dispatch: (action: MapAction) => void }) {
  if (!state.time?.open) return null;
  return (
    <div data-testid="phone-time-dock" className="glass-strong rise-in pointer-events-auto rounded-[12px] px-2.5 py-1.5">
      <TimePanel
        time={state.time}
        dispatch={dispatch}
        layers={state.layers}
        renderOps={state.renderOps}
        compare={state.compare}
        compact
        at={[state.viewport.longitude, state.viewport.latitude]}
      />
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { buildExportBundle, clickDownload, downloadBundle, formatBytes, MAX_LOOSE_FILES, type ExportBundle } from "@/lib/export/exportView";
import { captureStore, Compositor, recordingPlan, VIDEO_LIMITS, webmType, type Caption } from "@/lib/export/capture";
import { channelText, encodeColor, resolveEncoding, sizeWord } from "@/lib/render/encode";
import { playheadStore, stepOverrideStore } from "@/lib/render/playhead";
import { rgbToHex } from "@/lib/render/ramp";
import { bucketAt } from "@/lib/render/reducer";
import { frameAggregate, frameDate, valueAt } from "@/lib/render/series";
import type { MapAction, MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { windowLabel } from "@/lib/time";

const SEG = "relative flex h-7 items-center gap-1.5 rounded-pill text-[13px] whitespace-nowrap transition-colors duration-150 ease-out";
const IDLE = "text-ink hover:bg-mist/70";
/** A quiet text action, as the console's Clear all and Close. */
const TEXT_BUTTON = "text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink";
const PRIMARY = "press rounded-[12px] bg-primary px-3 py-1 font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover";

/** True while at least one loaded layer is shown: then there is something to export. */
export function hasLayerOn(state: MapState): boolean {
  return state.renderOps.some((op) => op.visible && state.layers[op.layerId] !== undefined);
}

function amount(value: number, unit: string | undefined): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: digits });
  return unit && unit !== "score" ? `${text} ${unit}` : text;
}

/** The caption a still or a video carries (spec §13): the layers, the frame's date, its total, the legend, the sources. */
export function captionOf(state: MapState, playhead: number): Caption {
  const shown = state.renderOps.filter((op) => op.visible && state.layers[op.layerId]).reverse();
  const titles = shown.map((op) => state.layers[op.layerId].title.replace(/\s*\(.*?\)\s*/g, " ").trim());
  const time = state.time;
  let date: string | undefined;
  let total: string | undefined;
  let totalLabel: string | undefined;
  if (time) {
    const i = bucketAt(time.index, time.window[0]);
    const j = bucketAt(time.index, time.window[1]);
    const framed = time.index.series !== undefined || i === j;
    date = framed ? frameDate(Date.parse(time.index.buckets[j].start), time.index.bucket) : windowLabel(time.window, time.index.bucket);
    const agg = frameAggregate(state);
    if (agg && framed) {
      const v = valueAt(agg.values, playhead >= j && playhead <= j + 1 ? playhead : j);
      if (v !== null) {
        total = agg.kind === "count" ? Math.round(v).toLocaleString("en-US") : amount(v, agg.unit);
        totalLabel = agg.label;
      }
    }
  }
  const legend: Caption["legend"] = [];
  const top = shown[0];
  const layer = top && state.layers[top.layerId];
  if (layer?.result.kind === "geojson") {
    const enc = resolveEncoding(layer, top, layer.result.data);
    const flow = layer.result.flow !== undefined;
    if (enc?.size) legend.push({ word: flow ? "Brightness" : sizeWord(layer.style.geometry, top.mode), text: channelText(enc.size) });
    if (enc?.color) legend.push({ word: "Color", text: channelText(enc.color), ramp: Array.from({ length: 5 }, (_, k) => rgbToHex(encodeColor(k / 4))) });
  }
  const hosts = [...new Set(shown.map((op) => state.layers[op.layerId].result.citation.url).map((u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }).filter(Boolean))];
  return { title: titles.slice(0, 2).join(" · ") || "WallyMap", ...(date && { date }), ...(total && { total }), ...(totalLabel && { totalLabel }), legend, source: hosts.join(", ") };
}

type Pending =
  | { kind: "data"; bundle: ExportBundle }
  | { kind: "still"; blob: Blob; name: string }
  | { kind: "recording"; seconds: number; elapsed: number }
  | { kind: "video"; blob: Blob; name: string; seconds: number }
  | { kind: "error"; message: string };

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * "Export map…" at the foot of the Layers console, shown only while a layer is on. It is two steps: the action opens a
 * confirm that lists the files and their size; only the confirm's Export button downloads (GeoJSON and citations). The
 * same confirm offers a still image of the map and, with a time scrubber, a video of the timeline (spec §13): each is
 * made first (a video plays the whole timeline in at most 30 s while it records), then offered with its size, and only
 * its Save button opens the browser's save. Nothing downloads without that click.
 */
export function ExportControl({ mapState, catalog = null, dispatch }: { mapState: MapState; catalog?: LayerCatalog | null; dispatch?: (action: MapAction) => void }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [exporting, setExporting] = useState(false);
  const stateRef = useRef(mapState);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    stateRef.current = mapState;
  });
  const on = hasLayerOn(mapState);
  const askExport = useCallback(() => setPending({ kind: "data", bundle: buildExportBundle(mapState, catalog) }), [mapState, catalog]);
  const cancelExport = useCallback(() => {
    stopRef.current?.();
    setPending(null);
  }, []);
  const confirmExport = useCallback(async () => {
    if (pending?.kind !== "data") return;
    setExporting(true);
    try {
      await downloadBundle(pending.bundle);
    } finally {
      setExporting(false);
      setPending(null);
    }
  }, [pending]);

  /** A still of the map as it is: waits for both canvases to draw once, then composes the caption over them. */
  const makeStill = useCallback(() => {
    const source = captureStore.get();
    if (!source) return setPending({ kind: "error", message: "The map is not ready to save yet." });
    const compositor = new Compositor(source);
    compositor.start();
    source.repaint();
    let tries = 0;
    const wait = () => {
      tries += 1;
      if (compositor.copied < 2 && tries < 30) {
        source.repaint();
        requestAnimationFrame(wait);
        return;
      }
      compositor.compose(captionOf(visibleState(stateRef.current), playheadStore.get()));
      compositor.stop();
      compositor.out.toBlob((blob) => {
        if (blob) setPending({ kind: "still", blob, name: `wallymap-${stamp()}.png` });
        else setPending({ kind: "error", message: "The browser could not make the image." });
      }, "image/png");
    };
    requestAnimationFrame(wait);
  }, []);

  /** A video of the timeline: plays every frame from the first in at most 30 s while recording the composed canvas. */
  const makeVideo = useCallback(() => {
    const source = captureStore.get();
    const type = webmType();
    const time = stateRef.current.time;
    if (!source || !type || !time || !dispatch) {
      return setPending({ kind: "error", message: type ? "There is no timeline to record." : "This browser cannot record video (no WebM support)." });
    }
    const plan = recordingPlan(time.index.buckets.length);
    const compositor = new Compositor(source);
    compositor.start();
    const stream = compositor.out.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: plan.bitsPerSecond });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    let raf = 0;
    let done = false;
    const started = performance.now();
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stepOverrideStore.set(null);
      dispatch({ type: "set_time_playing", playing: false });
      compositor.stop();
      if (recorder.state !== "inactive") recorder.stop();
    };
    recorder.onstop = () => {
      stopRef.current = null;
      const blob = new Blob(chunks, { type: "video/webm" });
      const seconds = Math.round((performance.now() - started) / 1000);
      if (blob.size === 0) setPending({ kind: "error", message: "The recording came out empty." });
      else if (blob.size > VIDEO_LIMITS.maxBytes) setPending({ kind: "error", message: `The video came out at ${formatBytes(blob.size)}, over the 25 MB limit.` });
      else setPending({ kind: "video", blob, name: `wallymap-timeline-${stamp()}.webm`, seconds });
    };
    stopRef.current = () => {
      chunks.length = 0;
      finish();
    };
    // From the first frame, one frame wide, at the recording's pace.
    const first = time.index.buckets[0];
    dispatch({ type: "set_time_playing", playing: false });
    dispatch({ type: "set_time_mode", mode: "slide" });
    dispatch({ type: "set_time_window", window: [first.start, first.end] });
    stepOverrideStore.set(plan.stepMs);
    setPending({ kind: "recording", seconds: Math.round(plan.seconds), elapsed: 0 });
    recorder.start(1000);
    let lastSecond = 0;
    const tick = () => {
      const state = visibleState(stateRef.current);
      compositor.compose(captionOf(state, playheadStore.get()));
      const elapsed = (performance.now() - started) / 1000;
      if (Math.floor(elapsed) !== lastSecond) {
        lastSecond = Math.floor(elapsed);
        setPending({ kind: "recording", seconds: Math.round(plan.seconds), elapsed: lastSecond });
      }
      // Play starts once the first frame is on screen; it ends on the last frame, or at the time limit.
      if (elapsed > 0.6 && !stateRef.current.time?.playing && !done) {
        const t = stateRef.current.time;
        const atEnd = !t || bucketAt(t.index, t.window[1]) >= t.index.buckets.length - 1;
        if (atEnd && elapsed > 1.2) return finish();
        if (!atEnd) dispatch({ type: "set_time_playing", playing: true });
      }
      if (elapsed >= VIDEO_LIMITS.maxSeconds) return finish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }, [dispatch]);

  const save = useCallback(() => {
    if (pending?.kind === "still" || pending?.kind === "video") clickDownload(pending.name, pending.blob);
    setPending(null);
  }, [pending]);

  // With no layer on there is nothing to export: a confirm left open is dropped, so it cannot reappear with the next one.
  if (!on && pending !== null && pending.kind !== "recording") setPending(null);
  if (!on) return null;
  const exportOpen = pending !== null;
  const canRecord = mapState.time !== undefined && dispatch !== undefined;

  return (
    <div data-testid="export-control">
      <button
        type="button"
        aria-label="Export map"
        title="Export map: GeoJSON and citations, a still image, or a video of the timeline"
        aria-expanded={exportOpen}
        disabled={exporting || pending?.kind === "recording"}
        onClick={() => (exportOpen ? cancelExport() : askExport())}
        className={TEXT_BUTTON}
      >
        Export map…
      </button>
      {pending?.kind === "data" && (
        <div
          role="dialog"
          aria-label="Confirm export"
          onKeyDown={(e) => e.key === "Escape" && cancelExport()}
          className="map-pill rise-in mt-2 w-fit max-w-full rounded-card px-4 py-3 text-[13px] text-ink"
        >
          <p className="font-medium">
            {`Export ${pending.bundle.files.length} ${pending.bundle.files.length === 1 ? "file" : "files"} (${formatBytes(pending.bundle.files.reduce((sum, f) => sum + f.blob.size, 0))})?`}
          </p>
          <ul className="mt-1 text-ink-muted">
            {pending.bundle.files.map((f) => (
              <li key={f.name} className="break-all">
                {f.name} <span className="stat">{formatBytes(f.blob.size)}</span>
              </li>
            ))}
          </ul>
          {pending.bundle.files.length > MAX_LOOSE_FILES && <p className="mt-1 text-ink-muted">Saved as one zip.</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" autoFocus disabled={exporting} onClick={() => void confirmExport()} className={PRIMARY}>
              Export
            </button>
            <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
              Cancel
            </button>
          </div>
          <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-ink-muted" data-testid="export-media">
            <span>Or make</span>
            <button type="button" onClick={makeStill} className="dashed-link text-ink">
              Still image
            </button>
            {canRecord && (
              <>
                <span aria-hidden>·</span>
                <button type="button" onClick={makeVideo} className="dashed-link text-ink">
                  Video of this timeline
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {pending && pending.kind !== "data" && (
        <div role="dialog" aria-label="Save export" className="map-pill rise-in mt-2 w-fit max-w-full rounded-card px-4 py-3 text-[13px] text-ink" data-testid="export-media-dialog">
          {pending.kind === "recording" && (
            <>
              <p className="font-medium tabular-nums">
                Recording the timeline… {pending.elapsed} s of about {pending.seconds} s
              </p>
              <p className="mt-1 text-ink-muted">The map plays from the first frame; keep this tab open.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
                  Stop and discard
                </button>
              </div>
            </>
          )}
          {(pending.kind === "still" || pending.kind === "video") && (
            <>
              <p className="font-medium">
                Save {pending.name} ({formatBytes(pending.blob.size)}
                {pending.kind === "video" ? `, ${pending.seconds} s` : ""})?
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" autoFocus onClick={save} className={PRIMARY}>
                  Save
                </button>
                <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
                  Discard
                </button>
              </div>
            </>
          )}
          {pending.kind === "error" && (
            <>
              <p>{pending.message}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={cancelExport} className={`${SEG} px-3 ${IDLE}`}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

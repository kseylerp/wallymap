"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { ElevationProfile, type ProfileHighlight, type ProfileMark, type Units } from "@/components/ElevationProfile";
import { useIsPhone } from "@/components/useIsPhone";
import { type CrossSectionView, pointAlong, profileCursorStore } from "@/lib/render/crossSection";
import { gainLoss } from "@/lib/render/wally/sample";

/**
 * The cross-section chart (spec T08, "Cross-section chart"): the elevation-profile layer's ground along its line, in the
 * route preview's slot above the chat composer. Distance across in miles (or km), elevation up in feet (or m), the
 * vertical exaggeration stated, the steepest 100 m in pink with its angle and grade, the start and the top labelled
 * with their elevations. A pointer over the chart moves a dot along the line on the map (profileCursorStore, drawn by
 * MapCanvas). Small on a phone (a 120px chart), so the map keeps most of the screen.
 */

const M_PER_MI = 1609.344;
const FT_PER_M = 3.28084;

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

export function CrossSection({ view, onClose }: { view: CrossSectionView; onClose: () => void }) {
  const isPhone = useIsPhone();
  const [units, setUnits] = useState<Units>("mi");
  const [hover, setHover] = useState<number | null>(null);
  // The dot leaves the map with the chart.
  useEffect(() => () => profileCursorStore.set(null), []);

  const total = view.distancesM[view.distancesM.length - 1] ?? 0;
  const elevUnit = units === "mi" ? "ft" : "m";
  const scale = units === "mi" ? FT_PER_M : 1;
  const { gain, loss } = useMemo(() => gainLoss(view.elevationsM), [view.elevationsM]);

  const marks = useMemo((): ProfileMark[] => {
    const first = view.elevationsM.find((e): e is number => e !== null);
    let topAt = 0;
    let top = -Infinity;
    view.elevationsM.forEach((e, i) => {
      if (e !== null && e > top) {
        top = e;
        topAt = view.distancesM[i];
      }
    });
    if (first === undefined || !Number.isFinite(top)) return [];
    const atEnd = topAt >= total * 0.97;
    const out: ProfileMark[] = [{ distanceM: 0, label: `${fmt(first * scale)} ${elevUnit}` }];
    // The top is labelled with its place when it is the line's end (Half Dome), and on its own when it is not the start.
    if (topAt > total * 0.03) out.push({ distanceM: topAt, label: `${fmt(top * scale)} ${elevUnit}${atEnd && view.endName ? ` ${view.endName}` : " top"}` });
    return out;
  }, [view, scale, elevUnit, total]);

  const highlight: ProfileHighlight | undefined = view.steepest
    ? { fromM: view.steepest.fromM, toM: view.steepest.toM, label: `${view.steepest.deg}° · ${fmt(view.steepest.gradePct)}%` }
    : undefined;

  const scrub = (f: number) => {
    setHover(f);
    profileCursorStore.set(pointAlong(view.line, f * total));
  };
  const leave = () => {
    setHover(null);
    profileCursorStore.set(null);
  };
  const length = units === "mi" ? `${fmt(total / M_PER_MI, 1)} mi` : `${fmt(total / 1000, 1)} km`;

  return (
    <div className="mb-2 w-full shrink-0 in-data-[chat-open=true]:px-3">
      <section role="region" aria-label="Elevation cross-section" data-testid="cross-section" className="glass-strong rise-in w-full rounded-[20px] p-3 text-ink">
        <header className="flex items-baseline gap-2 px-1">
          <h3 className="min-w-0 flex-1 truncate font-serif text-[15px] font-semibold">{view.name}</h3>
          <span className="shrink-0 text-[11.5px] text-ink-muted tabular-nums" aria-label={`${length}, climb ${fmt(gain * scale)} ${elevUnit}, descent ${fmt(loss * scale)} ${elevUnit}`}>
            {length}
            <span aria-hidden className="ml-2">↑</span> {fmt(gain * scale)} {elevUnit}
            <span aria-hidden className="ml-2">↓</span> {fmt(loss * scale)} {elevUnit}
          </span>
          <button
            type="button"
            onClick={() => setUnits((u) => (u === "mi" ? "km" : "mi"))}
            aria-label={`Show ${units === "mi" ? "kilometers" : "miles"}`}
            className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold tracking-wide text-ink-muted uppercase transition-colors hover:bg-mist hover:text-ink"
          >
            {units}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cross-section"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink"
          >
            <X aria-hidden size={14} strokeWidth={2.25} />
          </button>
        </header>
        <div className="mt-2 overflow-hidden rounded-[14px] border border-line bg-paper pt-1">
          <ElevationProfile
            distancesM={view.distancesM}
            elevations={view.elevationsM}
            fraction={hover ?? 0}
            units={units}
            height={isPhone ? 120 : 150}
            onScrub={scrub}
            hover
            onLeave={leave}
            cursor={hover !== null}
            progress={false}
            solid
            highlight={highlight}
            marks={marks}
            exaggeration
          />
        </div>
      </section>
    </div>
  );
}

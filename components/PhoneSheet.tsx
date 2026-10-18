"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * The Layers console on a phone (owner, 2026-10-18: "UX on phone is a little janky with the filter box"): a bottom
 * sheet with a drag handle that snaps to peek, half and full, one scroll container (nothing inside scrolls up and down
 * on its own, so a drag never fights the map), swipe down past peek to close, the map pannable above it, and the sheet
 * lifted over the keyboard while a field has focus. The pure half (heights, the snap a release lands on) is tested.
 */

export type Snap = "peek" | "half" | "full";
export type SheetHeights = Record<Snap, number>;

/** The sheet's three heights for a viewport `vh` tall whose sheet may reach `top` px from the top (under the map pills). */
export function sheetHeights(vh: number, top: number): SheetHeights {
  const full = Math.max(220, Math.round(vh - top));
  const peek = Math.min(full, 168);
  const half = Math.min(full, Math.max(peek + 80, Math.round(vh * 0.55)));
  return { peek, half, full };
}

/** How far below peek a release closes the sheet, and the downward speed (px/ms) that closes it from peek. */
export const CLOSE_BELOW_PEEK = 56;
export const FLING = 0.6;

/**
 * Where a drag released at `height` lands: the nearest snap, one step further along a fast fling, or "close" when
 * dragged well below peek (or flung down from it).
 */
export function releaseSnap(height: number, velocity: number, h: SheetHeights): Snap | "close" {
  const order: Snap[] = ["peek", "half", "full"];
  if (height < h.peek - CLOSE_BELOW_PEEK) return "close";
  if (velocity > FLING && height <= h.peek + 8) return "close";
  let nearest: Snap = "peek";
  for (const s of order) if (Math.abs(h[s] - height) < Math.abs(h[nearest] - height)) nearest = s;
  if (Math.abs(velocity) > FLING) {
    // A fling moves on from where the finger let go, in the direction it was going (velocity > 0 is downward).
    const below = [...order].reverse().find((s) => h[s] < height);
    const above = order.find((s) => h[s] > height);
    if (velocity > 0) return below ?? "close";
    return above ?? "full";
  }
  return nearest;
}

/** What the rows inside the sheet share: the sheet is on, the filter page open (a layer id) and where it renders. */
export type PhonePanel = {
  moreLayerId: string | null;
  openMore: (layerId: string) => void;
  moreTarget: HTMLElement | null;
  /** Grows the sheet to full (a field took focus). */
  expand: () => void;
};

export const PhonePanelContext = createContext<PhonePanel | null>(null);

/** The phone sheet's shared state, or null on a desktop (and in tests that render a row alone). */
export function usePhonePanel(): PhonePanel | null {
  return useContext(PhonePanelContext);
}

/** The keyboard's height over the layout viewport (iOS and Android both shrink the visual viewport), 0 without one. */
function useKeyboardInset(): { inset: number; visible: number } {
  const [state, setState] = useState({ inset: 0, visible: typeof window === "undefined" ? 800 : window.innerHeight });
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      const visible = vv ? vv.height : window.innerHeight;
      const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      setState((s) => (s.inset === inset && s.visible === visible ? s : { inset, visible }));
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return state;
}

export function PhoneSheet({
  header,
  children,
  onClose,
  snap,
  onSnap,
  label = "Layers",
  page = "",
}: {
  /** The title row (Layers, Clear all, Close): part of the drag zone under the handle. */
  header: ReactNode;
  children: ReactNode;
  onClose: () => void;
  snap: Snap;
  onSnap: (snap: Snap) => void;
  label?: string;
  /** Which page the sheet shows ("" the list, a layer id its filter page): a new page opens at its top, Back returns to where the list was. */
  page?: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const lastPage = useRef(page);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || lastPage.current === page) return;
    if (lastPage.current === "") listScroll.current = el.scrollTop;
    el.scrollTop = page === "" ? listScroll.current : 0;
    lastPage.current = page;
  }, [page]);
  const [top, setTop] = useState(60);
  const { inset, visible } = useKeyboardInset();
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number; lastY: number; lastT: number; moved: boolean } | null>(null);

  // The sheet reaches up to just under the map pills (the app measures them into --console-top).
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const v = parseFloat(getComputedStyle(el).getPropertyValue("--console-top"));
    if (Number.isFinite(v) && v > 0) setTop(v);
  }, []);

  const h = sheetHeights(visible + inset, top);
  // With the keyboard up the sheet fills what is left above it, so the focused field stays in sight.
  const height = drag ?? (inset > 0 ? Math.max(160, visible - top) : h[snap]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button:not([data-sheet-handle]), a, input, select")) return;
    start.current = { y: e.clientY, h: height, t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dy = e.clientY - s.y;
    if (!s.moved && Math.abs(dy) < 6) return;
    s.moved = true;
    s.lastY = e.clientY;
    s.lastT = e.timeStamp;
    setDrag(Math.max(60, Math.min(h.full, s.h - dy)));
  };
  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (!s.moved) {
      // A tap on the handle steps the sheet up (peek, half, full) and back to half from full.
      if ((e.target as HTMLElement).closest("[data-sheet-handle]")) onSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "half");
      setDrag(null);
      return;
    }
    const released = Math.max(60, Math.min(h.full, s.h - (e.clientY - s.y)));
    const dt = Math.max(1, e.timeStamp - s.lastT);
    const velocity = dt > 120 ? 0 : (e.clientY - s.lastY) / dt + (e.clientY - s.y) / Math.max(1, e.timeStamp - s.t) / 2;
    const next = releaseSnap(released, velocity, h);
    setDrag(null);
    if (next === "close") onClose();
    else onSnap(next);
  };

  return (
    <section
      ref={sectionRef}
      aria-label={label}
      data-testid="layer-stack"
      data-sheet={snap}
      className="phone-sheet glass-strong pointer-events-auto fixed inset-x-0 z-40 flex flex-col rounded-t-[16px] shadow-[0_-6px_24px_rgba(0,0,0,0.12)]"
      style={{ height, bottom: inset, transition: drag === null ? "height 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none" }}
    >
      <div
        data-testid="sheet-drag"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        className="shrink-0 touch-none select-none"
      >
        <button
          type="button"
          data-sheet-handle
          data-testid="sheet-handle"
          aria-label={`Resize ${label.toLowerCase()} (${snap})`}
          // A thin strip with the pill (a 44px hit area around it, hit-target): the header under it is part of the drag zone.
          className="hit-target flex h-[14px] w-full items-end justify-center"
        >
          <span aria-hidden className="h-[5px] w-10 rounded-full bg-[color-mix(in_srgb,var(--ink)_28%,transparent)]" />
        </button>
        {header}
      </div>
      <div
        ref={scrollRef}
        data-scroll="console"
        className="min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none] pb-[calc(var(--safe-bottom)+12px)]"
      >
        {children}
      </div>
    </section>
  );
}

/** The sheet's snap state with the filter page: opening the page or focusing a field grows the sheet to full. */
export function usePhoneSheetState(open: boolean) {
  const [snap, setSnap] = useState<Snap>("half");
  const [moreLayerId, setMore] = useState<string | null>(null);
  const [moreTarget, setMoreTarget] = useState<HTMLElement | null>(null);
  // Closed, the sheet forgets its snap and page: reopened, it starts at half on the layer list (adjusted during render,
  // React's way to follow a prop change).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setSnap("half");
      setMore(null);
    }
  }
  const openMore = useCallback((layerId: string) => {
    setMore(layerId);
    setSnap((s) => (s === "peek" ? "half" : s));
  }, []);
  const expand = useCallback(() => setSnap("full"), []);
  return { snap, setSnap, moreLayerId, setMore, moreTarget, setMoreTarget, openMore, expand };
}

"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The topo heartbeat, ported from wally-guides' TopoHeartbeat (itself a port of the Wally app's SearchLoadingView):
 *
 *   - 4 s cycle, band width 0.15, ghost 0.12, peak 0.85, cosine falloff
 *   - two passes: constant ghost contours, then a wavefront stroked with the accent → coral gradient
 *   - paths ordered inside-out, so the pulse radiates from the innermost rings
 *   - the viewBox is expanded around its center so the whole whirl shows, not one blown-up crop
 *
 * WallyMap adds a rotating verb under the contours (every 2.5 s). The ghost contours use `currentColor`, so the
 * band follows the text color. The loop pauses off-screen and never starts under prefers-reduced-motion; the
 * ghost contours then stay as a static texture.
 */
const CYCLE = 4.0;
const BAND = 0.15;
const GHOST = 0.12;
const PEAK = 0.85;
/** Wally's framing shows the whole whirl; the chat's short, wide band passes a tighter zoom. */
const ZOOM = 1.55;
const NS = "http://www.w3.org/2000/svg";
const TOPO_URL = "/topo.svg";

export const HEARTBEAT_VERBS = [
  "Reading the terrain",
  "Finding the data",
  "Tracing contours",
  "Checking sources",
  "Drawing the map",
] as const;
export const VERB_INTERVAL_MS = 2500;

let gradientSeq = 0;

export function TopoHeartbeat({ className = "", zoom = ZOOM }: { className?: string; zoom?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [verb, setVerb] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setVerb((v) => (v + 1) % HEARTBEAT_VERBS.length), VERB_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.childElementCount > 0 || typeof fetch !== "function") return;

    let raf = 0;
    let cancelled = false;
    let observer: IntersectionObserver | null = null;

    fetch(TOPO_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (cancelled || !hostRef.current || hostRef.current.childElementCount > 0) return;
        const source = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
        const viewBox = source.getAttribute("viewBox") || "0 0 3304 4672";
        const ds: string[] = [];
        source.querySelectorAll("path").forEach((p) => {
          const d = p.getAttribute("d");
          if (d) ds.push(d);
        });
        if (!ds.length) return;

        const svg = document.createElementNS(NS, "svg");
        const vb = viewBox.split(/\s+/).map(Number);
        const w = vb[2] * zoom;
        const h = vb[3] * zoom;
        svg.setAttribute("viewBox", `${vb[0] - (w - vb[2]) / 2} ${vb[1] - (h - vb[3]) / 2} ${w} ${h}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
        svg.setAttribute("fill", "none");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");

        // Unique per instance: two heartbeats on a page must not share (and fight over) one gradient id.
        const gradId = `topo-wave-grad-${++gradientSeq}`;
        const defs = document.createElementNS(NS, "defs");
        const grad = document.createElementNS(NS, "linearGradient");
        grad.setAttribute("id", gradId);
        grad.setAttribute("x1", "0");
        grad.setAttribute("y1", "0");
        grad.setAttribute("x2", "1");
        grad.setAttribute("y2", "1");
        (
          [
            ["0%", "var(--accent)"],
            ["100%", "var(--coral)"],
          ] as const
        ).forEach(([offset, color]) => {
          const stop = document.createElementNS(NS, "stop");
          stop.setAttribute("offset", offset);
          stop.style.setProperty("stop-color", color);
          grad.appendChild(stop);
        });
        defs.appendChild(grad);
        svg.appendChild(defs);

        // Pass 1: ghost contours, always visible.
        ds.forEach((d) => {
          const el = document.createElementNS(NS, "path");
          el.setAttribute("d", d);
          el.setAttribute("stroke", "currentColor");
          el.setAttribute("stroke-opacity", String(GHOST));
          el.setAttribute("stroke-width", "3");
          el.setAttribute("stroke-linecap", "round");
          el.setAttribute("stroke-linejoin", "round");
          svg.appendChild(el);
        });

        // Pass 2: the wavefront.
        const wave: SVGPathElement[] = [];
        ds.forEach((d) => {
          const el = document.createElementNS(NS, "path");
          el.setAttribute("d", d);
          el.setAttribute("stroke", `url(#${gradId})`);
          el.setAttribute("stroke-width", "4.2");
          el.setAttribute("stroke-linecap", "round");
          el.setAttribute("stroke-linejoin", "round");
          el.style.opacity = "0";
          svg.appendChild(el);
          wave.push(el);
        });

        hostRef.current.appendChild(svg);

        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

        // Inside-out by contour size, so index maps to radial distance.
        const area = (el: SVGPathElement) => {
          try {
            const b = el.getBBox();
            return b.width * b.height;
          } catch {
            return 0;
          }
        };
        const order = wave.map((el) => ({ el, size: area(el) })).sort((a, b) => a.size - b.size);

        let running = true;
        if (typeof IntersectionObserver !== "undefined") {
          observer = new IntersectionObserver((entries) => {
            running = entries[0]?.isIntersecting ?? true;
          });
          observer.observe(hostRef.current);
        }

        const start = performance.now();
        let last = 0;
        const frame = (now: number) => {
          raf = requestAnimationFrame(frame);
          if (!running || now - last < 33) return; // ~30 fps, as in the app
          last = now;
          const phase = ((((now - start) / 1000 / CYCLE) % 1) + 1) % 1;
          for (let i = 0; i < order.length; i++) {
            const dist = Math.abs(i / order.length - phase);
            const wrapped = Math.min(dist, 1 - dist);
            const glow = wrapped < BAND ? (1 + Math.cos((wrapped / BAND) * Math.PI)) * 0.5 : 0;
            order[i].el.style.opacity = (glow * PEAK).toFixed(3);
          }
        };
        raf = requestAnimationFrame(frame);
      })
      .catch(() => {
        // No contours: the band keeps its plain surface and the verb still rotates.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [zoom]);

  return (
    <div
      role="status"
      data-testid="topo-heartbeat"
      className={["topo-heartbeat relative overflow-hidden rounded-card", className].filter(Boolean).join(" ")}
    >
      <div ref={hostRef} aria-hidden className="absolute inset-0 text-ink" />
      <p className="relative flex h-full items-end px-4 pb-3 text-[13px] font-medium text-ink-muted">
        {/* Keyed so each new verb fades in. */}
        <span key={verb} className="topo-verb" data-testid="heartbeat-verb">
          {HEARTBEAT_VERBS[verb]}…
        </span>
      </p>
    </div>
  );
}

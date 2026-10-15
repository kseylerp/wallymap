// @vitest-environment node
/**
 * The layer row stays inside its panel (owner, Red River Gorge: the row "falls outside of the box"). The panel is
 * rendered to HTML with the app's real stylesheet (app/globals.css through Tailwind) and laid out by headless
 * Chromium at a 320px panel (desktop) and a 260px panel (a phone, where the mode control becomes a select); every
 * element in the panel must sit inside it, every element in a row inside the row, and nothing may overflow its box.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LayerStack } from "@/components/LayerStack";
import { getLayer } from "@/layers";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";

const root = path.resolve(__dirname, "..");
const citation = { source: "OpenBeta and OpenStreetMap", url: "https://openbeta.io/", retrieved: "2026-10-14T00:00:00Z" };

function loaded(id: string, title: string, features: GeoJSON.Feature[], coverageNote?: string): LoadedLayer {
  const layer = getLayer(id)!;
  return {
    id,
    title,
    style: layer.style,
    fieldHelp: layer.fieldHelp,
    attributes: layer.attributes,
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation, ...(coverageNote && { coverageNote }) },
    receivedAt: "2026-10-14T00:00:00Z",
  } as LoadedLayer;
}

const point = (i: number, properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-83.66 + i * 1e-4, 37.8] },
  properties: { name: `Feature ${i}`, ...properties },
});
const line = (i: number, properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[-109.6, 38.59 + i * 1e-4], [-109.59, 38.59]] },
  properties: { name: `Trail ${i}`, ...properties },
});
const kinds = ["crag", "boulder", "area"];
const disciplines = [["sport"], ["trad"], ["sport", "trad"], ["boulder"], ["toprope", "sport"]];
const bands = [["beginner", "intermediate"], ["intermediate", "advanced"], ["advanced", "elite"], ["beginner"]];
const climbing = loaded(
  "climbing",
  "Climbing areas and crags of the Red River Gorge Geological Area, Daniel Boone National Forest",
  Array.from({ length: 280 }, (_, i) =>
    point(i, {
      name: i % 7 === 0 ? `The Motherlode and the Bob Marley Crag at Muir Valley Nature Preserve ${i}` : `Feature ${i}`,
      v: 2 + Math.round((108 * i * i) / (279 * 279)),
      kind: kinds[i % 3],
      disciplines: disciplines[i % 5],
      gradeBands: bands[i % 4],
      ...(i % 9 === 0 && { fee: true }),
    }),
  ),
  "OpenBeta areas merged with OpenStreetMap climbing nodes inside the view; counts are crowd-sourced",
);
const plants = loaded(
  "power-plants",
  "Power plants",
  Array.from({ length: 2500 }, (_, i) =>
    point(i, { v: 1 + ((i * 37) % 900), kind: ["wind", "solar", "natural gas", "nuclear"][i % 4], t: `${2000 + (i % 25)}-01-01` }),
  ).map((f, i) => ({ ...f, geometry: { type: "Point" as const, coordinates: [-102 + (i % 50) * 0.08, 31 + Math.floor(i / 50) * 0.06] } })),
);
const mtb = loaded(
  "mtb-trails",
  "Mountain bike trails",
  Array.from({ length: 60 }, (_, i) => line(i, { v: i % 7, kind: i % 2 ? "mtb" : "path" })),
);
const fires = loaded(
  "fire-perimeters",
  "Wildfire perimeters",
  Array.from({ length: 40 }, (_, i) => ({
    ...point(i, { acres: Math.round(5 * 1.27 ** i), year: 2001 + (i % 24) }),
    geometry: { type: "Polygon", coordinates: [[[i, 0], [i + 0.5, 0], [i + 0.5, 0.5], [i, 0]]] },
  })) as GeoJSON.Feature[],
);
const state: MapState = {
  ...initialMapState,
  layers: { climbing, "mtb-trails": mtb, "fire-perimeters": fires, "power-plants": plants },
  renderOps: [
    { layerId: "power-plants", mode: "hexbin", visible: true, hexBasis: "share:wind", filters: { kind: { include: ["wind"] } } },
    { layerId: "fire-perimeters", mode: "polygons", visible: true, filters: { year: { range: [2016, 2024] } } },
    { layerId: "mtb-trails", mode: "lines", visible: false, filters: { v: { include: ["4", "5"] } } },
    {
      layerId: "climbing",
      mode: "points",
      visible: true,
      opacity: 0.8,
      rankBy: "v",
      filters: { v: { range: [10, 110] }, disciplines: { include: ["sport"] }, name: { match: "Muir" } },
    },
  ],
};

const markup = renderToStaticMarkup(
  <LayerStack
    layers={state.layers}
    renderOps={state.renderOps}
    catalog={{ climbing: { title: climbing.title, style: climbing.style, license: "CC BY-SA 4.0 and ODbL" } }}
    dispatch={() => {}}
    open
    onOpenChange={() => {}}
    shownLayers={visibleState(state).layers}
    selectedLayerId="climbing"
    zoom={9}
    expandAttributes
  />,
);

/** The app's stylesheet for exactly the classes the markup uses, as Tailwind builds it for the page. */
async function stylesheet(html: string): Promise<string> {
  const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const candidates = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => unescape(m[1]).split(/\s+/)).filter(Boolean);
  const compiler = await compile(readFileSync(path.join(root, "app/globals.css"), "utf8"), {
    base: path.join(root, "app"),
    loadStylesheet: async (id: string, base: string) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, "utf8") };
    },
  });
  return compiler.build([...new Set(candidates)]);
}

/**
 * Measured at rest: no entrance animation or transition mid-flight, and without the invisible ::after hit areas (the
 * ×, the "i" and the small toggles reach 8px past their glyphs on purpose, for a 28px tap).
 */
const SETTLED = `*, *::before, *::after { animation: none !important; transition: none !important; }
[data-testid="layer-stack"] *::after { content: none !important; }`;

type Problem = { what: string; box: string };

/** In the page: every element of the panel inside it, every element of a row inside the row, nothing overflowing. */
function audit(): { panelWidth: number; problems: Problem[]; titles: string[]; segments: boolean; select: boolean } {
  const panel = document.querySelector<HTMLElement>('[data-testid="layer-stack"]')!;
  const p = panel.getBoundingClientRect();
  const problems: Problem[] = [];
  const name = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${String(el.getAttribute("class") ?? "").slice(0, 60)} "${(el.textContent ?? "").slice(0, 30)}"`;
  const inside = (r: DOMRect, b: DOMRect) => r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
  for (const el of panel.querySelectorAll("*")) {
    if (el.closest(".sr-only") || el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    const box = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    if (!inside(r, p)) problems.push({ what: `outside the panel: ${name(el)}`, box });
    const row = el.closest('[data-testid="layer-card"]');
    if (row && row !== el && !inside(r, row.getBoundingClientRect())) problems.push({ what: `outside its row: ${name(el)}`, box });
    // Text spilling past its own box (an unbreakable word, a clipped segment); truncation by design is allowed.
    const style = getComputedStyle(el);
    const truncates = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
    if (el instanceof HTMLElement && !truncates && !(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      problems.push({ what: `overflows its box (${el.scrollWidth} > ${el.clientWidth}): ${name(el)}`, box });
    }
  }
  for (const seg of panel.querySelectorAll<HTMLElement>(".mode-segment")) {
    if (seg.getClientRects().length && seg.scrollWidth > seg.clientWidth) problems.push({ what: `segment clipped: ${seg.textContent}`, box: "" });
  }
  const shown = (sel: string) => [...panel.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0);
  return {
    panelWidth: Math.round(p.width),
    problems,
    titles: [...panel.querySelectorAll("[title]")].filter((el) => !el.classList.contains("info-mark") && !el.closest('[data-testid="attribute-controls"]')).map(name),
    segments: shown('[data-testid="mode-control"]'),
    select: shown('[data-testid="mode-select"]'),
  };
}

describe("the layer row stays inside the panel (real layout, headless Chromium)", () => {
  let browser: Browser;
  let css: string;
  beforeAll(async () => {
    [browser, css] = await Promise.all([chromium.launch(), stylesheet(markup)]);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  // Desktop: the panel is 320px. A 328px phone: the panel is 100vw - 68px = 260px.
  it.each([
    { panel: 320, viewport: 1280, segments: true },
    { panel: 260, viewport: 328, segments: false },
  ])("at a $panel px panel every element is inside it", async ({ panel, viewport, segments }) => {
    const page = await browser.newPage({ viewport: { width: viewport, height: 8000 } });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}${SETTLED}</style></head>` +
        `<body style="margin:0;background:#ECEAE7"><div style="position:absolute;top:12px;right:12px">${markup}</div></body></html>`,
    );
    const result = await page.evaluate(audit);
    await page.close();
    expect(result.panelWidth).toBe(panel);
    expect(result.problems).toEqual([]);
    // No tooltips on the row's own controls (the facet chips keep theirs until the filter redesign).
    expect(result.titles).toEqual([]);
    expect(result.segments).toBe(segments);
    expect(result.select).toBe(!segments);
  }, 30_000);

  it("renders the row's parts in order with the counts and readouts in words", () => {
    const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Every control of spec §12c is on screen: the chip set, Rank by and its top 10, the grade bands, the measure's
    // histogram, the flag, the name search, a year's range, the hex basis and its sentence; no other two-handle slider.
    for (const part of ["Discipline", "Rank by", "Grade", "Beginner", "Fee charged", "Search name", "Darker cells", "Share wind", "Each cell ≈"]) {
      expect(text, part).toContain(part);
    }
    expect(markup).toContain('data-testid="top-list"');
    expect(markup).toContain('data-testid="measure-histogram"');
    expect(markup.match(/aria-label="[^"]* from"/g)).toEqual(['aria-label="Year from"']);
    expect(text).toMatch(/\d+ of 280/);
    expect(text).toContain("Opacity for Climbing");
    expect(text).toContain("80%");
    expect(text.indexOf("Routes")).toBeLessThan(text.indexOf("Show as"));
    expect(text.indexOf("Show as")).toBeLessThan(text.indexOf("Opacity for Climbing"));
  });
});

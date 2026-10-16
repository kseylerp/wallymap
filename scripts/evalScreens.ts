/**
 * Screen checks (the eval's Tier 2): `eval-model.mts --set --screens` opens the final map of each SCREEN_QUESTIONS
 * question in Chromium by its permalink, at 1440×900 and 375×812, opens the first feature's card, and checks the page
 * (lib/checks/screenChecks.ts): panels and their contents inside the panel and the screen, no text cut without an
 * ellipsis, the chat placeholder whole and uncovered, hex and symbol labels not clipped, and each line layer visible on
 * Topo and on Topo + Satellite (the pixels along its lines change when it is hidden). Screenshots and a contact sheet
 * (index.html) go to .superpowers/m3/checks/.
 *
 * The app runs from a clean copy of HEAD: unless CHECKS_BASE_URL (default http://localhost:5600) already answers, a git
 * worktree is added at CHECKS_WORKTREE (default <tmp>/wallymap-wt-checks), .env.local copied in, `pnpm dev -p 5600`
 * started, and both are removed afterwards. The development build exposes the map to these checks (MapCanvas.tsx
 * `__wallyMap`). Export is never clicked.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Feature } from "geojson";
import { chromium, type Browser, type Page } from "@playwright/test";
import { listLayers } from "@/layers";
import type { BBox } from "@/layers/types";
import {
  collectLabels,
  collectLayout,
  collectLineSamples,
  collectPlaceholder,
  H3_EDGE_M,
  labelProblems,
  layoutProblems,
  lineVisibilityProblem,
  PANELS,
  pixelDiffs,
  placeholderProblems,
} from "@/lib/checks/screenChecks";
import { bboxToViewport } from "@/lib/render/deck";
import { encodeState } from "@/lib/render/permalink";
import type { Basemap, MapState } from "@/lib/render/state";
import { visibleState } from "@/lib/render/view";
import { visibleMapPadding } from "@/lib/render/viewportPadding";
import { boundsOf } from "@/lib/render/views";

export type ScreenItem = { raw: string; slug: string; state: MapState; failures: string[] };

type Size = { name: "desktop" | "phone"; width: number; height: number };
const SIZES: Size[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 375, height: 812 },
];

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const OUT_DIR = join(ROOT, ".superpowers/m3/checks");
const PORT = 5600;
const BASE_URL = process.env.CHECKS_BASE_URL ?? `http://localhost:${PORT}`;
/** The basemaps a line layer must show on, by the basemap buttons' accessible names (components/MapPills.tsx). */
const BASEMAPS: { value: Basemap; label: string; button: string }[] = [
  { value: "outdoors", label: "Topo", button: "Topographical" },
  { value: "outdoors-satellite", label: "Topo + Satellite", button: "Topographical + Satellite" },
];

/** Presses a basemap button in the top bar. */
async function pickBasemap(page: Page, button: string): Promise<void> {
  await page.locator(`[role="group"][aria-label="Basemap"] button[aria-label="${button}"]`).first().click();
}

/* ---------- The server: a worktree copy of HEAD ---------- */

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<() => void> {
  if (await answers(BASE_URL)) return () => {};
  const dir = process.env.CHECKS_WORKTREE ?? join(tmpdir(), "wallymap-wt-checks");
  console.error(`screens: adding a worktree of HEAD at ${dir}`);
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: ROOT, stdio: "ignore" });
  copyFileSync(join(ROOT, ".env.local"), join(dir, ".env.local"));
  execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: dir, stdio: "ignore" });
  const child: ChildProcess = spawn("pnpm", ["dev", "-p", String(PORT)], { cwd: dir, stdio: "ignore", detached: true });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    try {
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ROOT, stdio: "ignore" });
    } catch {
      console.error(`screens: could not remove the worktree at ${dir}`);
    }
  };
  for (let i = 0; i < 120; i++) {
    if (await answers(BASE_URL)) return stop;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error(`the dev server at ${BASE_URL} did not start`);
}

/* ---------- Permalinks ---------- */

/** The camera the map would end on at this size: the reducer's last fit (else every drawn feature) with the panels' padding. */
function permalinkFor(state: MapState, size: Size): string {
  const visible = visibleState(state);
  const features = Object.values(visible.layers).flatMap((l) => (l.result.kind === "geojson" ? l.result.data.features : []));
  const bbox = state.camera?.bbox ?? boundsOf(features) ?? ([-125, 24, -66, 50] as BBox);
  const isMobile = size.width < 768;
  const padding = visibleMapPadding({ width: size.width, height: size.height, panelOpen: false, isMobile, layerPanelOpen: !isMobile });
  const viewport = bboxToViewport(bbox, size.width, size.height, padding);
  const servable = Object.fromEntries(listLayers().map((l) => [l.id, true]));
  return encodeState({ viewport, basemap: state.basemap, layers: state.layers, renderOps: state.renderOps, ...(state.time && { time: state.time }) }, servable);
}

/* ---------- Page helpers ---------- */

async function settle(page: Page, ms = 1200): Promise<void> {
  await page
    .waitForFunction(() => !/Restoring \d+ layer/.test(document.body.innerText), undefined, { timeout: 90_000 })
    .catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const hook = (window as unknown as { __wallyMap?: { map: { loaded: () => boolean; areTilesLoaded: () => boolean; once: (e: string, f: () => void) => void } } }).__wallyMap;
        if (!hook) return done();
        const timer = setTimeout(done, 20_000);
        const finish = () => {
          clearTimeout(timer);
          done();
        };
        if (hook.map.loaded() && hook.map.areTilesLoaded()) finish();
        else hook.map.once("idle", finish);
      }),
  );
  await page.waitForTimeout(ms);
}

/** A point inside the feature for a click: the point itself, a middle vertex of a line, an inside point of an area. */
function clickPoint(f: Feature): [number, number] | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates as [number, number];
  if (g.type === "LineString") return g.coordinates[Math.floor(g.coordinates.length / 2)] as [number, number];
  if (g.type === "MultiLineString") {
    const line = g.coordinates[0];
    return line[Math.floor(line.length / 2)] as [number, number];
  }
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
  if (!ring) return null;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const insideRing = (x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (let i = 2; i <= 6; i++) for (let j = 2; j <= 6; j++) {
    const x = w + ((e - w) * i) / 8;
    const y = s + ((n - s) * j) / 8;
    if (insideRing(x, y)) return [x, y];
  }
  return null;
}

/** Opens a card: clicks drawn features (the first few that land on the open map) until one opens, else the top-10's first row. */
async function openCard(page: Page, state: MapState): Promise<string | null> {
  const visible = visibleState(state);
  const ops = state.renderOps.filter((o) => o.visible);
  for (const op of [...ops].reverse()) {
    const layer = visible.layers[op.layerId];
    if (layer?.result.kind !== "geojson") continue;
    for (const f of layer.result.data.features.slice(0, 40)) {
      const lngLat = clickPoint(f);
      if (!lngLat) continue;
      const at = await page.evaluate((p) => {
        const hook = (window as unknown as { __wallyMap?: { map: { project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement } } }).__wallyMap;
        if (!hook) return null;
        const canvas = hook.map.getCanvas();
        const r = canvas.getBoundingClientRect();
        const q = hook.map.project(p);
        const x = q.x + r.x;
        const y = q.y + r.y;
        return document.elementFromPoint(x, y) === canvas ? { x, y } : null;
      }, lngLat);
      if (!at) continue;
      await page.mouse.click(at.x, at.y);
      const opened = await page.waitForSelector('[data-testid="inspect-card"]', { timeout: 2500 }).catch(() => null);
      if (opened) return op.layerId;
    }
  }
  const top = await page.$('[data-testid="top-list"] button');
  if (top) {
    await top.click();
    const opened = await page.waitForSelector('[data-testid="inspect-card"]', { timeout: 5000 }).catch(() => null);
    if (opened) return "top-list";
  }
  return null;
}

/** Each line layer on Topo and Topo + Satellite: the mean pixel change along its lines when its row's Hide is pressed. */
async function lineChecks(page: Page, state: MapState, slug: string): Promise<{ problems: string[]; readings: string[]; shots: string[] }> {
  const problems: string[] = [];
  const readings: string[] = [];
  const shots: string[] = [];
  const lines = state.renderOps.filter((o) => o.visible && o.mode === "lines" && state.layers[o.layerId]?.result.kind === "geojson");
  if (lines.length === 0) return { problems, readings, shots };
  const start = state.basemap;
  for (const basemap of BASEMAPS) {
    await pickBasemap(page, basemap.button);
    await settle(page, 1500);
    // A small picture of the lines on this basemap for the contact sheet.
    const lineShot = `${slug}-lines-${basemap.value}.jpg`;
    await page.screenshot({ path: join(OUT_DIR, lineShot), type: "jpeg", quality: 70 });
    shots.push(lineShot);
    for (const op of lines) {
      const title = state.layers[op.layerId].title;
      const points = await page.evaluate(collectLineSamples, { layerId: op.layerId, max: 400 });
      if (points.length < 5) {
        readings.push(`${title} on ${basemap.label}: too few line points on screen to measure (${points.length})`);
        continue;
      }
      const shown = (await page.screenshot()).toString("base64");
      const toggle = page.locator(`[data-layer-id="${op.layerId}"] [data-testid="visibility-toggle"]`).first();
      await toggle.click();
      await settle(page, 800);
      const hidden = (await page.screenshot()).toString("base64");
      await toggle.click();
      await settle(page, 500);
      const diffs = await page.evaluate(pixelDiffs, { a: `data:image/png;base64,${shown}`, b: `data:image/png;base64,${hidden}`, points });
      const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      readings.push(`${title} on ${basemap.label}: ${mean.toFixed(1)} mean pixel change over ${diffs.length} points`);
      const problem = lineVisibilityProblem(title, basemap.label, diffs);
      if (problem) problems.push(problem);
    }
  }
  // Back to the basemap the question ended on.
  const back = BASEMAPS.find((b) => b.value === start);
  if (back) await pickBasemap(page, back.button);
  return { problems, readings, shots };
}

type ScreenResult = { slug: string; size: Size["name"]; problems: string[]; notes: string[]; shot: string; lineShots: string[] };

async function checkOne(browser: Browser, item: ScreenItem, size: Size): Promise<ScreenResult> {
  const phone = size.name === "phone";
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  // tsx names inner functions with __name(); the page has no such helper.
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  const page = await context.newPage();
  const problems: string[] = [];
  const notes: string[] = [];
  const shot = `${item.slug}-${size.name}.png`;
  const lineShots: string[] = [];
  try {
    await page.goto(`${BASE_URL}/${permalinkFor(item.state, size)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => "__wallyMap" in window, undefined, { timeout: 120_000 });
    await settle(page, 2000);
    const failed = await page.locator("text=/Could not restore/").count();
    if (failed > 0) notes.push("Some layers could not be restored from the link.");
    // The placeholder before any card opens (on a phone the card sheet may cover the chat).
    problems.push(...placeholderProblems(await page.evaluate(collectPlaceholder)));
    if (!phone) {
      const lines = await lineChecks(page, item.state, item.slug);
      problems.push(...lines.problems);
      notes.push(...lines.readings);
      lineShots.push(...lines.shots);
    }
    const labels = await page.evaluate(collectLabels, H3_EDGE_M);
    if (labels) problems.push(...labelProblems(labels.labels, labels.canvas));
    // The console first (on a phone it starts closed, and a card may take its place), then the card.
    const layers = page.locator('button[aria-label^="Layers,"]').first();
    if (phone && (await layers.count()) && (await layers.getAttribute("aria-pressed")) !== "true") {
      await layers.click();
      await page.waitForTimeout(700);
    }
    const before = layoutProblems(await page.evaluate(collectLayout, PANELS));
    const opened = await openCard(page, item.state);
    if (!opened) notes.push("No card opened: no drawn feature could be clicked.");
    await page.waitForTimeout(700);
    const after = layoutProblems(await page.evaluate(collectLayout, PANELS));
    problems.push(...new Set([...before, ...after]));
    await page.screenshot({ path: join(OUT_DIR, shot) });
  } catch (err) {
    notes.push(`The page could not be checked: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    await page.screenshot({ path: join(OUT_DIR, shot) }).catch(() => undefined);
  } finally {
    await context.close();
  }
  return { slug: item.slug, size: size.name, problems, notes, shot, lineShots };
}

/* ---------- Contact sheet ---------- */

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function contactSheet(items: ScreenItem[], results: ScreenResult[]): string {
  const sections = items.map((item) => {
    const mine = results.filter((r) => r.slug === item.slug);
    const failures = [...item.failures.map((f) => `Map check: ${f}`), ...mine.flatMap((r) => r.problems.map((p) => `${r.size}: ${p}`))];
    const notes = mine.flatMap((r) => r.notes.map((n) => `${r.size}: ${n}`));
    const shots = mine
      .map((r) => `<figure><a href="${r.shot}"><img src="${r.shot}" alt="${escape(item.raw)} at ${r.size} size" loading="lazy"></a><figcaption>${r.size}</figcaption></figure>`)
      .join("");
    const lineShots = mine
      .flatMap((r) => r.lineShots)
      .map((s) => `<figure class="line"><a href="${s}"><img src="${s}" alt="Lines on ${s.includes("satellite") ? "Topo + Satellite" : "Topo"}" loading="lazy"></a><figcaption>lines on ${s.includes("satellite") ? "Topo + Satellite" : "Topo"}</figcaption></figure>`)
      .join("");
    return `<section><h2>${escape(item.raw)} <span class="${failures.length ? "fail" : "pass"}">${failures.length ? `${failures.length} failing` : "passes"}</span></h2>
<div class="shots">${shots}</div>
${lineShots ? `<div class="shots">${lineShots}</div>` : ""}
${failures.length ? `<ul class="failures">${failures.map((f) => `<li>${escape(f)}</li>`).join("")}</ul>` : ""}
${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${escape(n)}</li>`).join("")}</ul>` : ""}</section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Map checks</title><style>
body{margin:0;padding:24px 16px 48px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d1f21;background:#fbfaf7;max-width:1200px;margin-inline:auto}
h1{font:600 22px/1.2 Georgia,serif;margin:0 0 4px}p.meta{color:#666;margin:0 0 24px}
section{border-top:1px solid #ddd;padding:16px 0}h2{font:600 16px/1.3 Georgia,serif;margin:0 0 10px}
h2 span{font:500 12px/1 -apple-system,system-ui,sans-serif;border:1px solid #1d1f21;border-radius:999px;padding:3px 8px;margin-left:8px;vertical-align:2px}
h2 span.pass{border-color:#999;color:#666}
.shots{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}figcaption{color:#666;font-size:12px}
img{display:block;border:1px solid #ddd;max-width:100%}.shots{margin-bottom:8px}figure:first-child img{width:640px}figure:last-child img{width:188px}figure.line img{width:400px}
ul{margin:10px 0 0;padding-left:18px}ul.notes{color:#666;font-size:13px}
</style></head><body><h1>Map checks</h1><p class="meta">${items.length} questions at desktop (1440×900) and phone (375×812) size · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</p>
${sections.join("\n")}</body></html>`;
}

/* ---------- Entry ---------- */

export async function runScreens(items: ScreenItem[]): Promise<{ passed: number; total: number; sheet: string; results: ScreenResult[] }> {
  mkdirSync(OUT_DIR, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch();
  const results: ScreenResult[] = [];
  try {
    for (const item of items) {
      for (const size of SIZES) {
        const r = await checkOne(browser, item, size);
        results.push(r);
        console.log(JSON.stringify({ screen: item.raw, size: r.size, ok: r.problems.length === 0, problems: r.problems, notes: r.notes }));
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  const sheet = join(OUT_DIR, "index.html");
  writeFileSync(sheet, contactSheet(items, results));
  const passed = items.filter((item) => results.filter((r) => r.slug === item.slug).every((r) => r.problems.length === 0)).length;
  if (!existsSync(sheet)) throw new Error("contact sheet not written");
  return { passed, total: items.length, sheet, results };
}

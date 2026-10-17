/**
 * Screen checks (the eval's Tier 2): `eval-model.mts --set --screens` opens the final map of each SCREEN_QUESTIONS
 * question in Chromium by its permalink, at 1440×900 and 375×812, opens the first feature's card, and checks the page
 * (lib/checks/screenChecks.ts): panels and their contents inside the panel and the screen, no text cut without an
 * ellipsis, the chat placeholder whole and uncovered, hex and symbol labels not clipped, and each line layer visible on
 * Topo and on Topo + Satellite (the pixels along its lines change when it is hidden). Screenshots and a contact sheet
 * (index.html) go to .superpowers/m3/checks/.
 *
 * The app runs from a clean copy of HEAD: unless CHECKS_BASE_URL (default http://localhost:5600) already answers, ONE git
 * worktree at a fixed path (<tmp>/wallymap-wt-checks) is reused (checked out at HEAD, cleaned, its node_modules kept) or
 * added once, .env.local copied in and `pnpm dev -p 5600` started. When the run ends (also on a failure or Ctrl-C) the
 * server stops and the worktree's `.next` cache and Playwright output are deleted; the worktree itself stays for the
 * next run (`removeScreensWorktree` deletes it). The development build exposes the map to these checks (MapCanvas.tsx
 * `__wallyMap`). Export is never clicked.
 *
 * Disk: the checks folder keeps only the latest run (cleared at the start; each question's shots keep fixed names), the
 * line pictures are JPEG at quality 80, and the run stops cleanly when free disk drops under 2 GB (scripts/diskGuard.ts).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { listLayers } from "@/layers";
import type { BBox } from "@/layers/types";
import {
  areaFillProblem,
  collectAreaSamples,
  collectLabels,
  collectLayout,
  collectLineSamples,
  collectPointSamples,
  collectPlaceholder,
  findPickPoint,
  H3_EDGE_M,
  isOceanDemTile404,
  labelProblems,
  layoutProblems,
  lineVisibilityProblem,
  PANELS,
  pixelDiffs,
  placeholderProblems,
} from "@/lib/checks/screenChecks";
import { bboxToViewport } from "@/lib/render/deck";
import { encodeState } from "@/lib/render/permalink";
import { sizeText, watchDisk, type DiskGuard } from "@/scripts/diskGuard";
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
/** The one worktree the screens ever use: reused run after run, never a second one. */
export const WORKTREE = join(tmpdir(), "wallymap-wt-checks");
/** The basemaps a line layer must show on, by the basemap buttons' accessible names (components/MapPills.tsx). */
const BASEMAPS: { value: Basemap; label: string; button: string }[] = [
  { value: "outdoors", label: "Topo", button: "Topographical" },
  { value: "outdoors-satellite", label: "Topo + Satellite", button: "Topographical + Satellite" },
];

/** Presses a basemap button in the top bar. */
async function pickBasemap(page: Page, button: string): Promise<void> {
  await page.locator(`[role="group"][aria-label="Basemap"] button[aria-label="${button}"]`).first().click({ force: true });
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

/** True when `dir` is a registered worktree of this repository. */
function isWorktree(dir: string): boolean {
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return list.split("\n").some((line) => line === `worktree ${resolve(dir)}` || line === `worktree ${dir}`);
}

/** The worktree at HEAD: the existing one checked out and cleaned (node_modules and .env.local kept), else a new one. */
function prepareWorktree(dir: string): void {
  if (existsSync(dir) && isWorktree(dir)) {
    console.error(`screens: reusing the worktree at ${dir}`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "--detach", "--force", head], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["clean", "-fdx", "-e", "node_modules", "-e", ".env.local"], { cwd: dir, stdio: "ignore" });
    return;
  }
  // A leftover folder that is no longer a worktree goes, so there is only ever this one.
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
  console.error(`screens: adding the worktree at ${dir}`);
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: ROOT, stdio: "ignore" });
}

/** Deletes what a run leaves in the worktree: the dev server's `.next` cache and any Playwright output. */
function cleanWorktree(dir: string): void {
  for (const sub of [".next", "test-results", "playwright-report", "blob-report"]) rmSync(join(dir, sub), { recursive: true, force: true });
}

/** Removes the screens worktree entirely (node_modules included); the next run adds it again. */
export function removeScreensWorktree(): void {
  if (isWorktree(WORKTREE)) execFileSync("git", ["worktree", "remove", "--force", WORKTREE], { cwd: ROOT, stdio: "ignore" });
  rmSync(WORKTREE, { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
}

async function startServer(): Promise<() => void> {
  if (await answers(BASE_URL)) return () => {};
  const dir = WORKTREE;
  prepareWorktree(dir);
  copyFileSync(join(ROOT, ".env.local"), join(dir, ".env.local"));
  execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: dir, stdio: "ignore" });
  const child: ChildProcess = spawn("pnpm", ["dev", "-p", String(PORT)], { cwd: dir, stdio: "ignore", detached: true });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    try {
      cleanWorktree(dir);
    } catch {
      console.error(`screens: could not clean the worktree at ${dir}`);
    }
  };
  // Ctrl-C or a kill still stops the server and deletes its cache.
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  for (let i = 0; i < 120; i++) {
    if (await answers(BASE_URL)) return stop;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error(`the dev server at ${BASE_URL} did not start`);
}

/** Empties the checks folder of the last run's pictures, contact sheet and folders (reports in Markdown stay). */
function clearChecks(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith(".md")) continue;
    rmSync(join(OUT_DIR, name), { recursive: true, force: true });
  }
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
  // The whole final state but the camera: every op setting, query inputs, time, scenario, compare and 3D round-trip.
  return encodeState({ ...state, viewport }, servable);
}

/* ---------- Page helpers ---------- */

/** Runs in the page: the console's scroll positions (its list and, on a phone, the console itself). */
function saveScroll(): number[] {
  const root = document.querySelector('[data-testid="layer-stack"]');
  return root ? [root, ...Array.from(root.querySelectorAll("ul"))].map((el) => el.scrollTop) : [];
}

/** Runs in the page: puts the console's scroll positions back and moves focus off the control the harness used. */
function restoreScroll(tops: number[]): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
  const root = document.querySelector('[data-testid="layer-stack"]');
  if (!root) return;
  [root, ...Array.from(root.querySelectorAll("ul"))].forEach((el, i) => {
    if (tops[i] !== undefined) el.scrollTop = tops[i];
  });
}

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

/**
 * Opens a card: finds a screen point that picks a drawn feature the way a click does (polling while deck and the
 * terrain finish loading), clicks it, and falls back to the top 10's first row.
 */
async function openCard(page: Page, state: MapState): Promise<string | null> {
  const layerIds = state.renderOps.filter((o) => o.visible).map((o) => o.layerId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const at = await page.evaluate(findPickPoint, layerIds);
    if (at) {
      await page.mouse.click(at.x, at.y);
      const opened = await page.waitForSelector('[data-testid="inspect-card"]', { state: "attached", timeout: 6000 }).catch(() => null);
      if (opened) return at.layerId;
    }
    await page.waitForTimeout(2000);
  }
  const top = await page.$('[data-testid="top-list"] button');
  if (top) {
    await top.click({ timeout: 5000 }).catch(() => undefined);
    const opened = await page.waitForSelector('[data-testid="inspect-card"]', { state: "attached", timeout: 5000 }).catch(() => null);
    if (opened) return "top-list";
  }
  return null;
}

type RenderOps = MapState["renderOps"];

/**
 * Measures each op on the map as it stands, labelled `on` ("Topo + Satellite in 3D"): the mean pixel change along its
 * lines, under its symbols, along its outlines and inside its areas between the map with the layer and with the row's
 * opacity at 0. `fill: false` skips the insides (a selection fades them on purpose).
 */
async function measureOps(page: Page, state: MapState, ops: RenderOps, on: string, out: { readings: string[]; problems: string[] }, { fill: withFill = true } = {}): Promise<void> {
  const { readings, problems } = out;
  for (const op of ops) {
    const title = state.layers[op.layerId].title;
    const what = op.mode === "points" ? "symbols" : op.mode === "lines" ? "lines" : "outlines";
    const areas = what === "outlines" ? await page.evaluate(collectAreaSamples, { layerId: op.layerId, max: 400 }) : null;
    const points =
      what === "lines"
        ? await page.evaluate(collectLineSamples, { layerId: op.layerId, max: 400 })
        : what === "symbols"
          ? await page.evaluate(collectPointSamples, { layerId: op.layerId, max: 400 })
          : (areas?.outline ?? []);
    if (points.length < 5) {
      readings.push(`${title} on ${on}: too few ${what === "lines" ? "line points" : what === "symbols" ? "symbols" : "outline points"} on screen to measure (${points.length})`);
      continue;
    }
    const shown = (await page.screenshot()).toString("base64");
    // The row's opacity at 0, not its Hide: hiding a dated layer also closes the time panel, which moves the camera and
    // changes every pixel. Rows without the slider fall back to Hide (older rows named it "Show <title>").
    const slider = page.locator(`[data-layer-id="${op.layerId}"] [data-testid="opacity-slider"]`).first();
    const before = (await slider.count()) > 0 ? await slider.inputValue() : null;
    const scrolls = await page.evaluate(saveScroll);
    const toggle = page
      .locator(`[data-layer-id="${op.layerId}"] [data-testid="visibility-toggle"], button[aria-label="Hide ${title}"], button[aria-label="Show ${title}"]`)
      .first();
    if (before !== null) await slider.fill("0");
    else await toggle.click({ force: true });
    await settle(page, 800);
    const hidden = (await page.screenshot()).toString("base64");
    if (before !== null) await slider.fill(before);
    else await toggle.click({ force: true });
    // Filling the slider focused it and scrolled the console down to it; a person would not see that, so the console
    // goes back to where it was (left mid-row, the console check would blame the app for the harness).
    await page.evaluate(restoreScroll, scrolls);
    await settle(page, 500);
    const diffs = await page.evaluate(pixelDiffs, { a: `data:image/png;base64,${shown}`, b: `data:image/png;base64,${hidden}`, points });
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    readings.push(`${title} ${what} on ${on}: ${mean.toFixed(1)} mean pixel change over ${diffs.length} points`);
    const problem = lineVisibilityProblem(title, on, diffs, what);
    if (problem) problems.push(problem);
    if (withFill && areas && areas.inside.length >= 5) {
      const fill = await page.evaluate(pixelDiffs, { a: `data:image/png;base64,${shown}`, b: `data:image/png;base64,${hidden}`, points: areas.inside });
      const fillMean = fill.reduce((s, d) => s + d, 0) / fill.length;
      readings.push(`${title} fill on ${on}: ${fillMean.toFixed(1)} mean pixel change over ${fill.length} points`);
      const fillProblem = areaFillProblem(title, on, fill);
      if (fillProblem) problems.push(fillProblem);
    }
  }
}

/**
 * Each line, symbol and area layer on Topo and Topo + Satellite: the mean pixel change along its lines, under its
 * symbols, along its outlines and inside its areas when its row's Hide is pressed. Everything is measured flat (on 3D
 * terrain the native lines drape away from where map.project puts them); areas are measured again on 3D terrain when
 * the question ended in 3D, the way people first see them (glacier outlines on ice read far fainter draped than flat).
 */
async function lineChecks(page: Page, state: MapState, slug: string): Promise<{ problems: string[]; readings: string[]; shots: string[] }> {
  const problems: string[] = [];
  const readings: string[] = [];
  const shots: string[] = [];
  // Lines, symbols (points drawn as symbols) and areas (their outlines and their insides), each measured the same way.
  const lines = state.renderOps.filter(
    (o) => o.visible && (o.mode === "lines" || o.mode === "points" || o.mode === "polygons" || (o.mode === "columns" && state.layers[o.layerId]?.style.geometry === "polygon")) && state.layers[o.layerId]?.result.kind === "geojson",
  );
  if (lines.length === 0) return { problems, readings, shots };
  const start = state.basemap;
  const threeD = page.locator('button[aria-label="3D terrain"]').first();
  const wasOn = (await threeD.count()) > 0 && (await threeD.getAttribute("aria-pressed")) === "true";


  if (wasOn) {
    await threeD.click({ force: true });
    await settle(page, 1500);
  }
  for (const basemap of BASEMAPS) {
    await pickBasemap(page, basemap.button);
    await settle(page, 1500);
    // A small picture of the lines on this basemap for the contact sheet.
    const lineShot = `${slug}-lines-${basemap.value}.jpg`;
    await page.screenshot({ path: join(OUT_DIR, lineShot), type: "jpeg", quality: 80 });
    shots.push(lineShot);
    await measureOps(page, state, lines, `${basemap.label}`, { readings, problems });
  }
  // Areas again on 3D terrain, draped as people see them.
  const areaOps = lines.filter((o) => o.mode === "polygons" || o.mode === "columns");
  if (wasOn && areaOps.length > 0) {
    await threeD.click({ force: true });
    await settle(page, 2500);
    for (const basemap of BASEMAPS) {
      await pickBasemap(page, basemap.button);
      await settle(page, 2000);
      await measureOps(page, state, areaOps, `${basemap.label} in 3D`, { readings, problems });
    }
    await threeD.click({ force: true });
    await settle(page, 1000);
  }
  // Back to the basemap and the 3D the question ended on.
  const back = BASEMAPS.find((b) => b.value === start);
  if (back) await pickBasemap(page, back.button);
  if (wasOn) await threeD.click({ force: true });
  await settle(page, 1000);
  return { problems, readings, shots };
}

type ScreenResult = { slug: string; size: Size["name"]; problems: string[]; notes: string[]; shot: string; lineShots: string[] };

async function checkOne(browser: Browser, item: ScreenItem, size: Size): Promise<ScreenResult> {
  const phone = size.name === "phone";
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  // tsx names inner functions with __name(); the page has no such helper.
  // The suggestions card opens by itself on a first visit; a person who asked a question has seen it.
  await context.addInitScript({ content: "window.__name = (f) => f; try { localStorage.setItem('wallymap.suggestionsSeen', '1'); } catch {}" });
  const page = await context.newPage();
  const problems: string[] = [];
  const notes: string[] = [];
  // Uncaught errors and console errors are failures (a failed request is logged with its URL, see below).
  const pageErrors = new Set<string>();
  const consoleErrors = new Set<string>();
  page.on("pageerror", (e) => pageErrors.add(e.message.split("\n")[0].slice(0, 200)));
  // Mapbox has no terrain DEM tile over open ocean and answers 404 by design (isOceanDemTile404); the browser still logs
  // "Failed to load resource" for each, so those lines (the console names the tile in its location) are left out.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of 404/.test(text) && isOceanDemTile404(m.location().url ?? "", 404)) return;
    consoleErrors.add(text.split("\n")[0].slice(0, 200));
  });
  // A failed request's console line has no URL; this names it.
  page.on("response", (r) => {
    if (r.status() >= 400 && !isOceanDemTile404(r.url(), r.status())) {
      consoleErrors.add(`HTTP ${r.status()} from ${r.url().replace(/access_token=[^&]+/, "access_token=…").slice(0, 120)}`);
    }
  });
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
    // The development error badge (Next.js) over the chat input: an error reached the overlay while the link loaded
    // (read before these checks click or pick anything).
    const badge = await page.evaluate(() => {
      const text = document.querySelector("nextjs-portal")?.shadowRoot?.textContent ?? "";
      const m = /(\d+)\s*Issues?/.exec(text);
      return m ? Number(m[1]) : 0;
    });
    if (badge > 0) problems.push(`The page shows the development error badge (${badge} ${badge === 1 ? "issue" : "issues"}) over the chat input once the link has loaded: ${[...consoleErrors, ...pageErrors][0] ?? "see the console"}.`);
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
    // With a card open the other areas of its layer fade, but their outlines must still show (the owner's glaciers on
    // Topo + Satellite: siblings of a selected glacier vanished on the ice).
    if (!phone && opened) {
      const areaOps = item.state.renderOps.filter((o) => o.visible && (o.mode === "polygons" || o.mode === "columns") && item.state.layers[o.layerId]?.style.geometry === "polygon");
      await measureOps(page, item.state, areaOps, "the map with a card open", { readings: notes, problems }, { fill: false });
    }
    // Zero errors per question (coordinator, 2026-10-16): every uncaught error, every console error, and the dev badge
    // once the checks are done.
    for (const e of pageErrors) problems.push(`The page threw an error: ${e}`);
    if (consoleErrors.size > 0) problems.push(`The console logged ${consoleErrors.size} distinct ${consoleErrors.size === 1 ? "error" : "errors"}: ${[...consoleErrors].slice(0, 3).join("; ")}.`);
    const issues = await page.evaluate(() => {
      const text = document.querySelector("nextjs-portal")?.shadowRoot?.textContent ?? "";
      const m = /(\d+)\s*Issues?/.exec(text);
      return m ? Number(m[1]) : 0;
    });
    if (issues > 0) problems.push(`The development error badge shows ${issues} ${issues === 1 ? "issue" : "issues"} after the checks.`);
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

export async function runScreens(
  items: ScreenItem[],
  opts: { disk?: DiskGuard } = {},
): Promise<{ passed: number; total: number; sheet: string; results: ScreenResult[]; stoppedLow: boolean; disk: string }> {
  clearChecks();
  const disk = opts.disk ?? watchDisk((free) => console.error(`screens: free disk is down to ${sizeText(free)}; stopping after this screen`));
  const results: ScreenResult[] = [];
  let stop = () => {};
  let browser: Browser | undefined;
  try {
    stop = await startServer();
    // The GPU (Metal on a Mac): SwiftShader renders 3D terrain so slowly that the page stops answering.
    browser = await chromium.launch({ args: process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"] : [] });
    screens: for (const item of items) {
      for (const size of SIZES) {
        disk.sample();
        if (disk.low()) break screens;
        const r = await checkOne(browser, item, size);
        results.push(r);
        console.log(JSON.stringify({ screen: item.raw, size: r.size, ok: r.problems.length === 0, problems: r.problems, notes: r.notes }));
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    stop();
    disk.sample();
    if (!opts.disk) disk.stop();
  }
  const sheet = join(OUT_DIR, "index.html");
  writeFileSync(sheet, contactSheet(items, results));
  // A question passes only when both sizes ran without a problem (a run stopped for disk leaves some unchecked).
  const passed = items.filter((item) => {
    const mine = results.filter((r) => r.slug === item.slug);
    return mine.length === SIZES.length && mine.every((r) => r.problems.length === 0);
  }).length;
  if (!existsSync(sheet)) throw new Error("contact sheet not written");
  return { passed, total: items.length, sheet, results, stoppedLow: disk.low(), disk: disk.report() };
}

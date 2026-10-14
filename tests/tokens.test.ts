import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");

/** The CSS block for a selector, e.g. `:root {` or `[data-theme="dark"] {` (first match, no nesting). */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("}", start));
}

/** The value of a custom property inside a block, lowercased. */
function tokenValue(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m?.[1].trim().toLowerCase();
}

// Wally colors from spec §2 that the owner kept: off-white surfaces, accent, coral, sage, semantic.
const SPEC_HEX = [
  "#FAF9F5", // scaffold
  "#ECEAE7", // surface
  "#E4E1DC", // deeper surface
  "#6E5BFF", // accent purple
  "#F57272", // coral
  "#9FB693", // sage
  "#E8884A", // warning
  "#DC5046", // error
  "#5B9BD5", // info
  "#FF9500", // caution
];

describe("tokens in app/globals.css", () => {
  it.each(SPEC_HEX)("defines %s", (hex) => {
    expect(css.toLowerCase()).toContain(hex.toLowerCase());
  });

  it("uses the Wally off-white surfaces with the original ink, glass opacities, radii and accent", () => {
    const light = block(":root");
    expect(tokenValue(light, "--paper")).toBe("#faf9f5");
    expect(tokenValue(light, "--cream")).toBe("#eceae7");
    expect(tokenValue(light, "--mist")).toBe("#e4e1dc");
    expect(tokenValue(light, "--ink")).toBe("#1f1f1f");
    expect(tokenValue(light, "--ink-muted")).toBe("#66665f");
    expect(tokenValue(light, "--glass")).toBe("rgba(250, 249, 245, 0.82)");
    expect(tokenValue(light, "--glass-strong")).toBe("rgba(250, 249, 245, 0.9)");
    expect(tokenValue(light, "--r-card")).toBe("24px");
    expect(tokenValue(light, "--accent")).toBe("#6e5bff");
    expect(tokenValue(light, "--route-gradient")).toContain("#6e5bff");
    expect(tokenValue(light, "--route-gradient")).toContain("#f57272");
  });

  it("makes primary buttons ink with white text, not the accent", () => {
    const light = block(":root");
    expect(tokenValue(light, "--button-primary")).toBe("var(--ink)");
    expect(tokenValue(light, "--button-primary-text")).toBe("#ffffff");
    expect(css).toMatch(/\.chat-surface button\[type="submit"\]:not\(:disabled\)/);
  });

  it("defines the map palette tokens: pink, purple, sage, off-white, dark grey", () => {
    const light = block(":root");
    expect(tokenValue(light, "--coral")).toBe("#f57272");
    expect(tokenValue(light, "--accent")).toBe("#6e5bff");
    expect(tokenValue(light, "--sage")).toBe("#9fb693");
    expect(tokenValue(light, "--dark-grey")).toBe("#3a3a3c");
    expect(tokenValue(light, "--slate")).toBe("#3a3a3c");
  });

  it("draws the time window and its handles (the playhead) in purple", () => {
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
    expect(rule(".time-bar[data-in-window]")).toContain("var(--accent)");
    expect(rule(".time-band")).toContain("var(--accent)");
    expect(rule(".time-handle::before")).toContain("var(--accent)");
  });

  it("has one light theme: no dark mode", () => {
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("uses the system font (light) for UI text and Geologica for headings, as on wally.guide", () => {
    expect(css).toContain("--font-sans: -apple-system");
    expect(css).toContain("--font-serif: var(--font-geologica)");
    expect(css).not.toContain("--font-geist");
    expect(css).not.toContain("--font-source-serif");
  });
});

/** Every .ts and .tsx file under `dir`: map paint lives in plain .ts component files (mapTiles.ts, routeLayers.ts). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

/** Every .ts and .tsx source file under `dir`, tests excluded. */
function nonTestSources(dir: string): string[] {
  return sourceFiles(dir).filter((f) => !/\.test\.tsx?$/.test(f));
}

describe("map and UI code use the palette, not raw hex", () => {
  const files = [...nonTestSources(path.join(root, "components")), ...nonTestSources(path.join(root, "lib/render"))];
  const palette = path.join(root, "lib/render/palette.ts");

  it("scans the plain .ts component files and lib/render too", () => {
    expect(files.some((f) => f.endsWith("mapTiles.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("routeLayers.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("deck.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("wally", "pins.ts")))).toBe(true);
    expect(files).toContain(palette);
  });

  it.each(files.filter((f) => f !== palette).map((f) => [path.relative(root, f), f]))("%s has no raw #rgb or #rrggbb", (_rel, file) => {
    const hits = readFileSync(file, "utf8").match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? [];
    expect(hits).toEqual([]);
  });

  it("keeps the legacy per-layer colors out of the palette", () => {
    const source = readFileSync(palette, "utf8");
    for (const legacy of ["#FF5A36", "#B9A6FF", "#F2A33A", "#2F3A44", "#9A9A96", "#15803D"]) expect(source).not.toContain(legacy);
  });
});

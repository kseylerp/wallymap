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
    expect(tokenValue(light, "--ink")).toBe("#1a1a1a");
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

  it("has one light theme: no dark mode", () => {
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("uses Geist for UI text and Source Serif 4 for headings", () => {
    expect(css).toContain("--font-sans: var(--font-geist)");
    expect(css).toContain("--font-serif: var(--font-source-serif)");
    expect(css).not.toContain("-apple-system");
    expect(css).not.toContain("SF Pro Rounded");
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

describe("components use tokens, not raw hex", () => {
  const files = tsxFiles(path.join(root, "components"));

  it("finds component files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(root, f), f]))("%s has no raw #rrggbb", (_rel, file) => {
    const hits = readFileSync(file, "utf8").match(/#[0-9a-f]{6}\b/gi) ?? [];
    expect(hits).toEqual([]);
  });
});

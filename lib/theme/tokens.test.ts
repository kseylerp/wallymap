import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
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

// Every exact value from spec §2 (docs/superpowers/specs/2026-10-09-wallymap-m3-design.md).
const SPEC_HEX = [
  "#FAF9F5", // scaffold light
  "#151515", // scaffold dark
  "#ECEAE7", // surface light
  "#1A1A1A", // surface dark
  "#292929", // deeper surface dark
  "#1F1F1F", // text primary light / deeper surface dark
  "#F5F5F5", // text primary dark
  "#6B6B6B", // text secondary light
  "#A0A0A0", // text secondary dark
  "#6E5BFF", // accent purple
  "#F57272", // coral
  "#9FB693", // sage
  "#E8884A", // warning
  "#DC5046", // error
  "#5B9BD5", // info
  "#FF9500", // caution
  "#4A4A4A", // logo outline
];

describe("Wally tokens in app/globals.css", () => {
  it.each(SPEC_HEX)("defines %s", (hex) => {
    expect(css.toLowerCase()).toContain(hex.toLowerCase());
  });

  it("maps the light defaults onto the existing variable names", () => {
    const light = block(":root");
    expect(tokenValue(light, "--paper")).toBe("#faf9f5");
    expect(tokenValue(light, "--cream")).toBe("#eceae7");
    expect(tokenValue(light, "--ink")).toBe("#1f1f1f");
    expect(tokenValue(light, "--ink-muted")).toBe("#6b6b6b");
    expect(tokenValue(light, "--accent")).toBe("#6e5bff");
    expect(tokenValue(light, "--slate")).toBe("#2f3a44");
    expect(tokenValue(light, "--mist")).toBe("#e4e1dc");
    expect(tokenValue(light, "--route-gradient")).toContain("#6e5bff");
    expect(tokenValue(light, "--route-gradient")).toContain("#f57272");
  });

  it("overrides surfaces and text under [data-theme=dark]", () => {
    const dark = block('[data-theme="dark"]');
    expect(tokenValue(dark, "--paper")).toBe("#151515");
    expect(tokenValue(dark, "--cream")).toBe("#1a1a1a");
    expect(tokenValue(dark, "--ink")).toBe("#f5f5f5");
    expect(tokenValue(dark, "--ink-muted")).toBe("#a0a0a0");
    expect(tokenValue(dark, "--mist")).toBe("#292929");
    expect(tokenValue(dark, "--glass")).toBeDefined();
  });

  it("uses the system font stack, not Geist or Source Serif", () => {
    expect(css).toContain("--font-sans: -apple-system");
    expect(css).toContain('"SF Pro Rounded"');
    expect(css).not.toMatch(/geist|source-serif/i);
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

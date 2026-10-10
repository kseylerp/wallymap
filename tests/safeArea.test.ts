import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { place } from "@/components/InspectCard";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const css = read("app/globals.css");

/** Every rule body for `selector` (exact match before the brace), across media queries. */
function rules(selector: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = css.indexOf(`${selector} {`, at);
    if (start < 0) return out;
    out.push(css.slice(start, css.indexOf("}", start)));
    at = start + 1;
  }
}

describe("phone safe area", () => {
  it("lets the page run under the notch and home indicator", () => {
    expect(read("app/layout.tsx")).toMatch(/viewportFit:\s*"cover"/);
  });

  it("defines the four inset variables from env(), defaulting to 0", () => {
    const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(rootBlock).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
    }
  });

  it("moves the zoom controls and the Mapbox logo and attribution up by the bottom inset", () => {
    for (const selector of [".map-controls", ".mapboxgl-ctrl-bottom-left,\n.mapboxgl-ctrl-bottom-right"]) {
      expect(rules(selector)[0]).toContain("var(--safe-bottom)");
    }
    expect(rules(':root:has([data-chat-state="collapsed"]) .mapboxgl-ctrl-bottom-left')[0]).toContain("var(--safe-bottom)");
  });

  // The map itself stays edge to edge; each piece of chrome moves in.
  const chrome: [string, string, string[]][] = [
    ["map pills row", "components/App.tsx", ["--safe-top", "--safe-left", "--safe-right"]],
    ["data console", "components/App.tsx", ["--safe-right"]],
    ["data console size", "components/LayerStack.tsx", ["--safe-top", "--safe-bottom"]],
    ["zoom, globe and 3D", "components/MapControls.tsx", ["--safe-right"]],
    ["chat sheet, composer and collapsed pill", "components/ChatRail.tsx", ["--safe-bottom", "--safe-left", "--safe-right", "--safe-top"]],
    ["preview dock", "components/PreviewControl.tsx", ["--safe-left", "--safe-right"]],
    ["inspect card", "components/InspectCard.tsx", ["--safe-left", "--safe-right"]],
  ];
  it.each(chrome)("insets the %s", (_name, file, vars) => {
    const source = read(file);
    for (const v of vars) expect(source).toContain(v);
  });

  it("keeps the map canvas full-bleed, with the app root pinned to the visible area", () => {
    const app = read("components/App.tsx");
    expect(app).toContain('<main ref={mapBoxRef} className="absolute inset-0">');
    // position: fixed; inset: 0 follows Safari's visible area (acdb07b); a 100dvh root left a blank band.
    expect(app).toContain("fixed inset-0");
    expect(read("components/ChatRail.tsx")).not.toMatch(/h-\[\d+vh\]/);
  });

  it("places the inspect card inside the insets", () => {
    const view = { width: 390, height: 844, insets: { top: 47, right: 0, bottom: 34, left: 0 } };
    const card = { width: 340, height: 300 };
    // A point near the top: the card cannot tuck under the notch and the pills (64px under the inset).
    expect(place({ x: 200, y: 60 }, card, view).top).toBeGreaterThanOrEqual(47 + 64);
    // Near the bottom: it stays above the home indicator.
    const low = place({ x: 200, y: 200 }, { width: 340, height: 600 }, view);
    expect(low.below).toBe(true);
    expect(low.top + 600).toBe(844 - 34 - 12);
  });
});

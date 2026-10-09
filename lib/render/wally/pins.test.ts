import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { PIN_GLYPHS, pinIconFor, pinThreshold } from "@/lib/render/wally/pins";

const point = (properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-120, 39] },
  properties,
});

describe("pinIconFor", () => {
  it.each([
    ["species", "species"],
    ["photos", "photo"],
    ["streamflow", "gauge"],
    ["snowpack", "snow"],
    ["fire-detections", "fire"],
    ["forest-roads", "road"],
    ["something-new", "default"],
  ])("maps %s to the %s glyph", (layerId, glyph) => {
    expect(pinIconFor(layerId, point()).url).toBe(`/pins/${glyph}.svg`);
  });

  it("tells camp sites from parking by kind", () => {
    expect(pinIconFor("campsites", point({ kind: "camp_site" })).url).toBe("/pins/camp.svg");
    expect(pinIconFor("campsites", point({ kind: "parking" })).url).toBe("/pins/parking.svg");
    expect(pinIconFor("popularity-campsites", point({ kind: "parking" })).url).toBe("/pins/parking.svg");
    expect(pinIconFor("campsites", point()).url).toBe("/pins/camp.svg");
  });

  it("is a 34×44 sprite anchored at its tip, shared per glyph", () => {
    const icon = pinIconFor("species", point());
    expect(icon).toMatchObject({ width: 34, height: 44, anchorY: 44 });
    expect(pinIconFor("species", point({ other: 1 }))).toBe(icon);
  });

  it("switches to dots past 300 features", () => {
    expect(pinThreshold).toBe(300);
  });
});

describe("pin sprites", () => {
  it.each(PIN_GLYPHS.map((g) => [g]))("public/pins/%s.svg is a 34×44 teardrop", (glyph) => {
    const file = join(process.cwd(), "public", "pins", `${glyph}.svg`);
    expect(existsSync(file)).toBe(true);
    const svg = readFileSync(file, "utf8");
    // Drawn on a 34×44 grid, rasterized at 2x so pins stay sharp on high-density screens.
    expect(svg).toContain('width="68" height="88" viewBox="0 0 34 44"');
    expect(svg).toContain(glyph === "start" ? 'fill="#F57272"' : 'fill="#3A3A3C"');
  });
});

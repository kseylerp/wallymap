import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { PIN_SYMBOLS, pinIconFor } from "@/lib/render/wally/pins";

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
    ["trailheads", "trailhead"],
    ["something-new", "point"],
  ])("maps %s to the %s symbol", (layerId, symbol) => {
    expect(pinIconFor(layerId, point()).url).toBe(`/pins/${symbol}.svg`);
  });

  it("tells camp sites (triangle) from parking (square) by kind", () => {
    expect(pinIconFor("campsites", point({ kind: "camp_site" })).url).toBe("/pins/camp.svg");
    expect(pinIconFor("campsites", point({ kind: "parking" })).url).toBe("/pins/parking.svg");
    expect(pinIconFor("popularity-campsites", point({ kind: "parking" })).url).toBe("/pins/parking.svg");
    expect(pinIconFor("campsites", point()).url).toBe("/pins/camp.svg");
  });

  it("uses the solid ink twin for the selected feature", () => {
    expect(pinIconFor("species", point(), true).url).toBe("/pins/species-selected.svg");
    expect(pinIconFor("something-new", point(), true).url).toBe("/pins/point-selected.svg");
  });

  it("is a 24×24 sprite anchored at its center, shared per symbol", () => {
    const icon = pinIconFor("species", point());
    expect(icon).toMatchObject({ width: 24, height: 24, anchorY: 12 });
    expect(pinIconFor("species", point({ other: 1 }))).toBe(icon);
  });
});

describe("symbol sprites", () => {
  const read = (name: string) => {
    const file = join(process.cwd(), "public", "pins", `${name}.svg`);
    expect(existsSync(file)).toBe(true);
    return readFileSync(file, "utf8");
  };
  /** Every color a sprite uses. */
  const colors = (svg: string) => new Set(svg.match(/#[0-9A-Fa-f]{6}\b/g));

  it.each(PIN_SYMBOLS.map((s) => [s]))("%s is monochrome: ink and white only, on a 24×24 canvas", (symbol) => {
    for (const svg of [read(symbol), read(`${symbol}-selected`)]) {
      expect(svg).toContain('width="48" height="48" viewBox="0 0 24 24"');
      expect([...colors(svg)].every((c) => c === "#1F1F1F" || c === "#FFFFFF")).toBe(true);
      expect(svg).toContain("#1F1F1F");
    }
  });

  it.each(["camp", "parking", "gauge", "trailhead", "point"])("%s outlines a white 85% fill in 1.5px ink", (symbol) => {
    expect(read(symbol)).toContain('fill="#FFFFFF" fill-opacity="0.85" stroke="#1F1F1F" stroke-width="1.5"');
    expect(read(`${symbol}-selected`)).toContain('fill="#1F1F1F" stroke="#1F1F1F" stroke-width="1.5"');
  });

  it.each(["species", "snow"])("%s is hollow until selected", (symbol) => {
    expect(read(symbol)).toContain('fill="none" stroke="#1F1F1F" stroke-width="1.5"');
    expect(read(`${symbol}-selected`)).toContain('fill="#1F1F1F" stroke="#1F1F1F"');
  });

  it("draws the shapes the legend promises", () => {
    expect(read("camp")).toMatch(/<path d="M12 6\.2 18\.2 17H5\.8Z"/); // triangle
    expect(read("parking")).toContain("<rect"); // square
    expect(read("gauge")).toMatch(/<path d="M12 5\.6 18\.4 12 12 18\.4 5\.6 12Z"/); // diamond
    expect(read("photo")).toContain('r="3.25" fill="#1F1F1F"'); // small filled circle
    expect(read("fire")).toContain('r="5.5" fill="#FFFFFF"'); // filled circle with a halo
    expect(read("road")).toContain('stroke-dasharray="3 2"'); // dashed line
    expect(read("trailhead")).toContain('r="1.6" fill="#1F1F1F"'); // center dot
  });

  it("keeps the route's teardrops (start.svg, default.svg) for Mapbox", () => {
    expect(read("start")).toContain('viewBox="0 0 34 44"');
    expect(read("default")).toContain('viewBox="0 0 34 44"');
  });
});

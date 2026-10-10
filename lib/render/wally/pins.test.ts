import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { DARK_GREY, OFF_WHITE, PALETTE, PINK, PURPLE, WHITE } from "@/lib/render/palette";
import { PIN_SYMBOLS, pinIconFor, pinSymbolFor, routePinUrl } from "@/lib/render/wally/pins";

const point = (properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-120, 39] },
  properties,
});

/** The SVG behind a sprite's data URL. */
const svgOf = (url: string) => {
  expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  return decodeURIComponent(url.slice(url.indexOf(",") + 1));
};
const colors = (svg: string) => new Set(svg.match(/#[0-9A-Fa-f]{6}\b/g));
const layerFor: Record<string, string> = {
  camp: "campsites",
  species: "species",
  photo: "photos",
  gauge: "streamflow",
  snow: "snowpack",
  fire: "fire-detections",
  road: "forest-roads",
  trailhead: "trailheads",
  point: "something-new",
};

describe("pinSymbolFor", () => {
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
    expect(pinSymbolFor(layerId, point())).toBe(symbol);
    expect(pinIconFor(layerId, point()).id.startsWith(`${symbol}-`)).toBe(true);
  });

  it("tells camp sites (triangle) from parking (square) by kind", () => {
    expect(pinSymbolFor("campsites", point({ kind: "camp_site" }))).toBe("camp");
    expect(pinSymbolFor("campsites", point({ kind: "parking" }))).toBe("parking");
    expect(pinSymbolFor("popularity-campsites", point({ kind: "parking" }))).toBe("parking");
    expect(pinSymbolFor("campsites", point())).toBe("camp");
  });
});

describe("symbol sprites (owner's board, points variant A)", () => {
  it.each(PIN_SYMBOLS.filter((s) => s !== "parking").map((s) => [s]))("%s uses palette colors only, on a 24×24 drawing at 2x", (symbol) => {
    for (const selected of [false, true]) {
      const svg = svgOf(pinIconFor(layerFor[symbol], point(), selected).url);
      expect(svg).toContain('width="48" height="48" viewBox="0 0 24 24"');
      expect([...colors(svg)].every((c) => PALETTE.has(c))).toBe(true);
    }
  });

  it.each(["camp", "gauge", "point", "photo"])("%s fills off-white at 0.85 in a 1.5px dark grey stroke on a white halo", (symbol) => {
    const svg = svgOf(pinIconFor(layerFor[symbol], point()).url);
    expect(svg).toContain(`fill="${OFF_WHITE}" fill-opacity="0.85" stroke="${DARK_GREY}" stroke-width="1.5"`);
    expect(svg).toContain(`stroke="${WHITE}" stroke-opacity="0.85" stroke-width="3.5"`);
  });

  it.each(["species", "snow", "trailhead"])("%s is hollow, and fills purple when selected", (symbol) => {
    expect(svgOf(pinIconFor(layerFor[symbol], point()).url)).toContain(`fill="none" stroke="${DARK_GREY}" stroke-width="1.5"`);
    expect(svgOf(pinIconFor(layerFor[symbol], point(), true).url)).toContain(`fill="${PURPLE}"`);
  });

  it("selects with a purple fill, never solid ink", () => {
    const svg = svgOf(pinIconFor("campsites", point(), true).url);
    expect(svg).toContain(`fill="${PURPLE}"`);
    expect(svg).not.toContain("#1F1F1F");
  });

  it("draws fire detections as pink symbols with a dark grey stroke (hazards)", () => {
    const svg = svgOf(pinIconFor("fire-detections", point()).url);
    expect(svg).toContain(`fill="${PINK}" fill-opacity="1" stroke="${DARK_GREY}"`);
  });

  it("fills score symbols by their ramp, low scores off-white", () => {
    const low = svgOf(pinIconFor("popularity-campsites", point({ v: 0 })).url);
    const high = svgOf(pinIconFor("popularity-campsites", point({ v: 100 })).url);
    expect(low).toContain(`fill="${OFF_WHITE}"`);
    expect(high).toContain(`fill="${PURPLE}"`);
  });

  it("draws no white data fill anywhere (white is only halos)", () => {
    for (const symbol of PIN_SYMBOLS) {
      for (const selected of [false, true]) {
        expect(svgOf(pinIconFor(layerFor[symbol] ?? "campsites", point({ kind: symbol === "parking" ? "parking" : undefined }), selected).url)).not.toContain(`fill="${WHITE}"`);
      }
    }
  });

  it("draws the shapes the legend promises", () => {
    expect(svgOf(pinIconFor("campsites", point()).url)).toMatch(/<path d="M12 6\.2 18\.2 17H5\.8Z"/); // triangle
    expect(svgOf(pinIconFor("campsites", point({ kind: "parking" })).url)).toContain("<rect"); // square
    expect(svgOf(pinIconFor("streamflow", point()).url)).toMatch(/<path d="M12 5\.6 18\.4 12 12 18\.4 5\.6 12Z"/); // diamond
    expect(svgOf(pinIconFor("forest-roads", point()).url)).toContain('stroke-dasharray="3 2"'); // dashed line
    expect(svgOf(pinIconFor("trailheads", point()).url)).toContain(`r="1.6" fill="${DARK_GREY}"`); // dotted ring
  });

  it("is a 24×24 sprite anchored at its center, shared per symbol and fill", () => {
    const icon = pinIconFor("species", point());
    expect(icon).toMatchObject({ width: 24, height: 24, anchorY: 12 });
    expect(pinIconFor("species", point({ other: 1 }))).toBe(icon);
  });
});

describe("routePinUrl", () => {
  it("draws the route start pink and the end and via stops off-white", () => {
    expect(svgOf(routePinUrl("start"))).toContain(`fill="${PINK}"`);
    expect(svgOf(routePinUrl("end"))).toContain(`fill="${OFF_WHITE}"`);
    expect(svgOf(routePinUrl("via"))).toContain('r="4"');
  });
});

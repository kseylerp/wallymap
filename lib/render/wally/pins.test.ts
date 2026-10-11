import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { DARK_GREY, OFF_WHITE, PALETTE, PINK, PURPLE, SYMBOL, symbolSizePx, WHITE } from "@/lib/render/palette";
import { UnpremultiplySpriteExtension } from "@/lib/render/deck";
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

  it("keeps the symbol constants the owner ruled: 1.75px stroke, 3.5px halo at 0.9, 14px down to 10px", () => {
    expect(SYMBOL).toMatchObject({
      strokeWidth: 1.75,
      fillOpacity: 0.85,
      hollowFillOpacity: 0.6,
      haloWidth: 3.5,
      haloOpacity: 0.9,
      sizeMax: 14,
      sizeMin: 10,
      stroke: DARK_GREY,
      halo: WHITE,
      selectedFill: PURPLE,
      hazardFill: PINK,
    });
  });

  it.each([6, 8, 9.5, 11, 14])("draws the stroke and halo at true pixel widths at the zoom %s size", (zoom) => {
    const size = symbolSizePx(zoom);
    const svg = svgOf(pinIconFor("something-new", point(), false, size).url);
    const scale = Number(/scale\(([\d.]+)\)/.exec(svg)?.[1] ?? 1);
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]) * scale);
    expect(widths[0]).toBeCloseTo(SYMBOL.strokeWidth + SYMBOL.haloWidth, 2); // halo, under the outline
    expect(widths[1]).toBeCloseTo(SYMBOL.strokeWidth, 2);
    expect(svg).toContain(`stroke="${WHITE}" stroke-opacity="0.9"`);
    expect(svg).toContain(`stroke="${DARK_GREY}"`);
    expect(svg).not.toMatch(/stroke-opacity="[\d.]+"[^>]*stroke="#3A3A3C"/); // the outline is fully opaque
  });

  it("sizes symbols 10px at zoom 6 and below, 14px from zoom 11, never outside that", () => {
    expect(symbolSizePx(0)).toBe(10);
    expect(symbolSizePx(6)).toBe(10);
    expect(symbolSizePx(11)).toBe(14);
    expect(symbolSizePx(12.8)).toBe(14);
    expect(symbolSizePx(22)).toBe(14);
    expect(symbolSizePx(Number.NaN)).toBe(10);
    for (let z = 6; z < 11; z += 0.25) expect(symbolSizePx(z + 0.25)).toBeGreaterThanOrEqual(symbolSizePx(z));
    for (let z = 0; z <= 22; z += 0.5) expect(symbolSizePx(z)).toBeGreaterThanOrEqual(10);
  });

  it("scales the shape with the size (a 14px circle is 14/12 of the 12px drawing)", () => {
    expect(svgOf(pinIconFor("something-new", point(), false, 14).url)).toContain("scale(1.1667)");
    expect(svgOf(pinIconFor("something-new", point(), false, 10).url)).toContain("scale(0.8333)");
  });

  it.each(["camp", "gauge", "point", "photo"])("%s fills off-white at 0.85 in a dark grey stroke on a white halo", (symbol) => {
    const svg = svgOf(pinIconFor(layerFor[symbol], point(), false, 12).url);
    expect(svg).toContain(`fill="${OFF_WHITE}" fill-opacity="0.85" stroke="${DARK_GREY}" stroke-width="1.75"`);
    expect(svg).toContain(`stroke="${WHITE}" stroke-opacity="0.9" stroke-width="5.25"`);
  });

  it.each(["species", "snow", "trailhead"])("%s (hollow class) fills off-white at 0.6, and purple when selected", (symbol) => {
    expect(svgOf(pinIconFor(layerFor[symbol], point(), false, 12).url)).toContain(
      `fill="${OFF_WHITE}" fill-opacity="0.6" stroke="${DARK_GREY}" stroke-width="1.75"`,
    );
    expect(svgOf(pinIconFor(layerFor[symbol], point(), true).url)).toContain(`fill="${PURPLE}"`);
  });

  it("keeps the dotted ring's centre dot", () => {
    expect(svgOf(pinIconFor("trailheads", point()).url)).toContain(`r="1.6" fill="${DARK_GREY}"`);
  });

  it.each(["fire-detections", "earthquakes", "methane-plumes", "uranium", "weather-alerts"])("%s draws pink with a dark grey stroke", (layerId) => {
    const svg = svgOf(pinIconFor(layerId, point()).url);
    expect(svg).toContain(`fill="${PINK}" fill-opacity="1" stroke="${DARK_GREY}"`);
  });

  it("selects with a purple fill, never solid ink", () => {
    const svg = svgOf(pinIconFor("campsites", point(), true).url);
    expect(svg).toContain(`fill="${PURPLE}"`);
    expect(svg).not.toContain("#1F1F1F");
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

describe("sprite blending", () => {
  it("un-premultiplies the icon sprites so translucent fills and halos draw at the alpha the palette says", () => {
    const inject = new UnpremultiplySpriteExtension().getShaders().inject as Record<string, string>;
    expect(inject["fs:#main-end"]).toContain("fragColor.rgb / texColor.a");
    expect(inject["fs:#main-end"]).toContain("picking.isActive");
  });
});

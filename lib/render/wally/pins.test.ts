import type { Feature } from "geojson";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DARK_GREY, OFF_WHITE, PALETTE, PINK, PURPLE, SYMBOL, symbolSizePx, WHITE } from "@/lib/render/palette";
import { UnpremultiplySpriteExtension } from "@/lib/render/deck";
import { GLYPHS, kindGlyph, LAYER_GLYPHS, PIN_SYMBOLS, pinGlyphFor, pinIconFor, pinSymbolFor, routePinUrl, type PinGlyph } from "@/lib/render/wally/pins";

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
  point: "plain-c",
  square: "plain-a",
  diamond: "plain-d",
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
    ["plain-c", "point"],
    ["plain-a", "square"],
    ["plain-d", "diamond"],
    ["plain-b", "trailhead"],
  ])("keeps %s's plain %s shape as its fallback", (layerId, symbol) => {
    expect(pinSymbolFor(layerId, point())).toBe(symbol);
  });

  it("draws unmapped layers (and roads) as their plain shape, with no glyph", () => {
    expect(pinIconFor("plain-c", point()).id.startsWith("point-")).toBe(true);
    expect(pinIconFor("forest-roads", point()).id.startsWith("road-")).toBe(true);
    expect(svgOf(pinIconFor("plain-c", point()).url)).not.toContain("stroke-linecap");
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

  it.each(["species", "snow", "trailhead"])("%s (a glyph layer) draws the off-white disc at 0.85, and purple when selected", (symbol) => {
    expect(svgOf(pinIconFor(layerFor[symbol], point(), false, 12).url)).toContain(
      `fill="${OFF_WHITE}" fill-opacity="0.85" stroke="${DARK_GREY}" stroke-width="1.75"`,
    );
    expect(svgOf(pinIconFor(layerFor[symbol], point(), true).url)).toContain(`fill="${PURPLE}"`);
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

  it("draws the plain shapes where no glyph applies", () => {
    expect(svgOf(pinIconFor("campsites", point({ kind: "parking" })).url)).toContain("<rect"); // square
    expect(svgOf(pinIconFor("forest-roads", point()).url)).toContain('stroke-dasharray="3 2"'); // dashed line
    expect(svgOf(pinIconFor("plain-c", point()).url)).toContain('<circle cx="12" cy="12" r="5.5"'); // disc
  });

  it("gives plain layers different shapes by id, so two of them rarely look alike", () => {
    const shapes = new Set(["plain-a", "plain-b", "plain-c", "plain-d"].map((id) => pinSymbolFor(id, point())));
    expect(shapes.size).toBe(4);
  });

  it("never draws a bare triangle (the basemap's peak marker)", () => {
    for (const symbol of PIN_SYMBOLS) expect(svgOf(pinIconFor(layerFor[symbol] ?? "campsites", point()).url)).not.toMatch(/d="M12 6\.2 18\.2 17H5\.8Z"/);
  });

  it("gives each kind of outdoor feature its own glyph, and a dark fill a white glyph", () => {
    expect(kindGlyph("alpine_hut")).toBe("hut");
    expect(kindGlyph("spring")).toBe("drop");
    expect(kindGlyph("viewpoint")).toBe("eye");
    expect(kindGlyph("camp_site")).toBe("tent");
    expect(kindGlyph("parking")).toBe("parking");
    expect(kindGlyph("peak")).toBe("mountain");
    expect(kindGlyph("bench")).toBeNull();
    const svg = svgOf(pinIconFor("outdoor-features", point(), false, 14, { fill: "#6E5BFF", glyph: "hut" }).url);
    expect(svg).toContain('fill="#6E5BFF"');
    expect(svg).toContain('stroke="#FFFFFF" stroke-width');
  });

  it("is a 24×24 sprite anchored at its center, shared per symbol and fill", () => {
    const icon = pinIconFor("species", point());
    expect(icon).toMatchObject({ width: 24, height: 24, anchorY: 12 });
    expect(pinIconFor("species", point({ other: 1 }))).toBe(icon);
  });
});

/** The glyph path drawn inside a sprite, or undefined. */
const glyphPathOf = (svg: string) => /<path d="([^"]+)" fill="none" stroke="#3A3A3C" stroke-width="[\d.]+" stroke-linecap="round"/.exec(svg)?.[1];

describe("glyphs (owner, 2026-10-11: \"try for simple icons\")", () => {
  it.each([
    ["trailheads", "chevron"],
    ["outdoor-features", "chevron"],
    ["peaks", "mountain"],
    ["lakes", "wave"],
    ["surface-water", "wave"],
    ["streamflow", "drop"],
    ["groundwater", "drop"],
    ["snowpack", "asterisk"],
    ["snow-cover", "asterisk"],
    ["tides", "waves"],
    ["surf", "waves"],
    ["fishing", "hook"],
    ["campsites", "tent"],
    ["popularity-campsites", "tent"],
    ["recreation-sites", "tent"],
    ["species", "leaf"],
    ["gbif-occurrences", "leaf"],
    ["photos", "camera"],
    ["wikipedia-nearby", "info"],
    ["climbing", "bolts"],
    ["earthquakes", "arcs"],
    ["weather-alerts", "exclamation"],
    ["fire-detections", "flame"],
    ["methane-plumes", "cloud"],
    ["uranium", "trefoil"],
    ["mines", "pick"],
    ["dams", "dam"],
    ["power-plants", "bolt"],
    ["ports", "anchor"],
    ["sea-level-trends", "staff"],
    ["tree-mortality", "tree"],
    ["sequoia-mortality", "tree"],
  ] as const)("draws %s with the %s glyph inside the disc", (layerId, glyph) => {
    expect(pinGlyphFor(layerId, point())).toBe(glyph);
    const icon = pinIconFor(layerId, point());
    expect(icon.id.startsWith(`${glyph}-`)).toBe(true);
    const svg = svgOf(icon.url);
    expect(svg).toContain('<circle cx="12" cy="12" r="5.5"');
    expect(glyphPathOf(svg)).toBe(GLYPHS[glyph]);
  });

  it.each(["mtb-trails", "ski-routes", "paddling", "glaciers", "monuments", "condor-range", "wolf-packs", "forest-roads", "something-new"])(
    "gives %s no glyph (lines, polygons and unmapped layers fall back)",
    (layerId) => {
      expect(pinGlyphFor(layerId, point())).toBeNull();
      expect(glyphPathOf(svgOf(pinIconFor(layerId, point()).url))).toBeUndefined();
    },
  );

  it("keeps parking lots on campsite layers as the plain square", () => {
    expect(pinGlyphFor("campsites", point({ kind: "parking" }))).toBeNull();
    expect(svgOf(pinIconFor("campsites", point({ kind: "parking" })).url)).toContain("<rect");
  });

  const files = path.resolve(__dirname, "../../../public/pins");

  it("draws every glyph from its public/pins file: 24×24, 1.5px round strokes, no fill, dark grey, at most three strokes", () => {
    expect(readdirSync(files).filter((f) => f.endsWith(".svg")).sort()).toEqual(Object.keys(GLYPHS).map((g) => `${g}.svg`).sort());
    for (const [name, d] of Object.entries(GLYPHS)) {
      const file = readFileSync(path.join(files, `${name}.svg`), "utf8");
      expect(file).toContain('viewBox="0 0 24 24"');
      expect(file).toContain('fill="none"');
      expect(file).toContain(`stroke="${DARK_GREY}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`);
      expect(file).not.toMatch(/<(text|image|use|circle|rect)\b/);
      expect([...file.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])).toEqual([d]);
      expect(d.match(/M/gi)?.length, name).toBeLessThanOrEqual(3);
    }
  });

  it("maps every layer to a glyph that exists", () => {
    for (const glyph of Object.values(LAYER_GLYPHS)) expect(GLYPHS).toHaveProperty(glyph);
  });

  it.each([10, 12, 14])("draws the glyph stroke at true pixel width on a %spx symbol, rasterized at 2x", (size) => {
    const svg = svgOf(pinIconFor("peaks", point(), false, size).url);
    const outer = size / 12; // the drawing is laid out for a 12px symbol
    const width = Number(/stroke-width="([\d.]+)" stroke-linecap="round"/.exec(svg)?.[1]);
    expect(width * outer * SYMBOL.glyphScale).toBeCloseTo(SYMBOL.glyphStrokeWidth, 2);
    expect(svg).toContain('width="48" height="48" viewBox="0 0 24 24"'); // 2x for retina
    expect(pinIconFor("peaks", point(), false, size)).toMatchObject({ width: 24, height: 24, anchorY: 12 });
  });

  it.each(["fire-detections", "earthquakes", "weather-alerts", "methane-plumes", "uranium", "tree-mortality"])(
    "%s keeps the pink hazard disc with a dark grey glyph",
    (layerId) => {
      const svg = svgOf(pinIconFor(layerId, point()).url);
      expect(svg).toContain(`fill="${PINK}" fill-opacity="1" stroke="${DARK_GREY}"`);
      expect(glyphPathOf(svg)).toBe(GLYPHS[pinGlyphFor(layerId, point()) as PinGlyph]);
    },
  );

  it("selects with a purple disc and keeps the glyph dark grey", () => {
    const svg = svgOf(pinIconFor("gbif-occurrences", point(), true).url);
    expect(svg).toContain(`fill="${PURPLE}" fill-opacity="1" stroke="${DARK_GREY}"`);
    expect(glyphPathOf(svg)).toBe(GLYPHS.leaf);
    expect([...colors(svg)].every((c) => PALETTE.has(c))).toBe(true);
  });

  it("caches one sprite per glyph, fill and size", () => {
    expect(pinIconFor("lakes", point())).toBe(pinIconFor("lakes", point({ name: "Tahoe" })));
    expect(pinIconFor("lakes", point()).id).toBe(pinIconFor("surface-water", point()).id);
    expect(pinIconFor("lakes", point()).id).not.toBe(pinIconFor("lakes", point(), true).id);
    expect(pinIconFor("lakes", point(), false, 12).id).not.toBe(pinIconFor("lakes", point(), false, 14).id);
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

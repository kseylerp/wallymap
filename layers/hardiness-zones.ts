/**
 * USDA Plant Hardiness Zones (2023 map) as vector tiles, for the lower 48 states.
 * Tiles (verified live 2026-10-10, keyless, CORS open, gzip-compressed Mapbox vector tiles): a community copy on ArcGIS Online,
 *   https://vectortileservices1.arcgis.com/rKbpcgHXWYYaP4pQ/arcgis/rest/services/phzm_us_zones_shp_2023_view/VectorTileServer/tile/{z}/{y}/{x}.pbf
 *   (item 31d0ab3315844ce38caf45c9c81be8f7, titled "USDA Plant Hardiness Zones 2023"; ArcGIS orders the path z/y/x,
 *   and its 512-pixel tile scheme matches Mapbox vector tiles, level N = Mapbox zoom N).
 * Facts from decoding live tiles (z6 and z10 over Colorado) and the style document (resources/styles/root.json):
 *   - One source layer, `phzm_us_zones_shp_2023`, polygons only, extent 4096 (z6) / 4194304 (z10).
 *   - The only feature property is `_symbol`, an integer index into the zones in order: 0 = 3a, 1 = 3b, 2 = 4a, 3 = 4b,
 *     4 = 5a, 5 = 5b, 6 = 6a, 7 = 6b, 8 = 7a, 9 = 7b, 10 = 8a, 11 = 8b, 12 = 9a, 13 = 9b, 14 = 10a, 15 = 10b, 16 = 11a,
 *     17 = 11b, 18 = 12a (the style has one fill layer per index; the zone itself is not a property).
 *   - Tiles answer at every level 0 to 23; past z10 the geometry stops changing (7.6 KB at z11 to z16 over Denver), so maxzoom 12.
 *   - Bounds -124.813,24.4625 to -66.9125,49.4292: Alaska, Hawaii and Puerto Rico are not in this copy.
 * Drawing (2026-10-18): the layer declares `_symbol` as its color category with one legend swatch per half-zone (ZONE_COLORS,
 * purple → sage → pink) and the zone's label and °F band, so the map fills each zone by `_symbol` and the card names it.
 * Smoke (2026-10-10): tiles z0 8 KB, z3 69 KB, z6 15 KB, z8 7 KB, z10 to z16 7.6 KB, all HTTP 200 with access-control-allow-origin *.
 * No upstream call is made by the layer: it only hands the tile URL to the map.
 * Credit: USDA Agricultural Research Service and Oregon State University PRISM Climate Group made the map; the tiles are
 * a third party's copy, not USDA's, so the license and citation name both and say it is a copy.
 */
import { z } from "zod";
import { defineLayer, type Attribute, type AttributeLevel, type BBox, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";
import { layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { hexToRgb, oklchToRgb, rgbToHex, rgbToOklch } from "@/lib/render/ramp";

export const HARDINESS_TILE_URL =
  "https://vectortileservices1.arcgis.com/rKbpcgHXWYYaP4pQ/arcgis/rest/services/phzm_us_zones_shp_2023_view/VectorTileServer/tile/{z}/{y}/{x}.pbf";
export const HARDINESS_SOURCE_LAYER = "phzm_us_zones_shp_2023";

/** The lower 48 states, from the tile service's bounds. */
const LOWER_48: BBox = [-124.813, 24.4625, -66.9125, 49.4292];

/** The half-zones the tiles index by `_symbol`, coldest first: 0 = 3a ... 18 = 12a. */
export const HALF_ZONES = ["3a", "3b", "4a", "4b", "5a", "5b", "6a", "6b", "7a", "7b", "8a", "8b", "9a", "9b", "10a", "10b", "11a", "11b", "12a"] as const;

/** A half-zone's band of average yearly lowest winter temperature in °F: zone 1a starts at -60 °F and each half-zone is 5 °F. */
export function zoneRangeF(zone: string): [number, number] {
  const m = /^(\d+)([ab])$/.exec(zone);
  if (!m) throw new Error(`not a half-zone: ${zone}`);
  const low = -60 + 10 * (Number(m[1]) - 1) + (m[2] === "b" ? 5 : 0);
  return [low, low + 5];
}

const signed = (f: number) => (f < 0 ? `−${-f}` : String(f));

/** "Zone 7a (0 to 5 °F)". */
export function zoneLabel(zone: string): string {
  const [lo, hi] = zoneRangeF(zone);
  return `Zone ${zone} (${signed(lo)} to ${signed(hi)} °F)`;
}

/** A straight mix of two palette colors in OKLab (no hue sweep, so purple to sage never passes through a bright blue). */
function mixOklab(from: string, to: string, t: number): string {
  const lab = (hex: string) => {
    const [L, C, h] = rgbToOklch(hexToRgb(hex));
    const rad = (h * Math.PI) / 180;
    return [L, C * Math.cos(rad), C * Math.sin(rad)];
  };
  const [a, b] = [lab(from), lab(to)];
  const [L, A, B] = a.map((v, i) => v + (b[i] - v) * t);
  return rgbToHex(oklchToRgb([L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]));
}

/**
 * One color per half-zone, cold to warm on purple → sage → pink (spec §11: ramps derived from the approved five, mixed in
 * OKLab), so each band the tiles hold reads as its own zone and neighbouring zones step visibly: 3a purple, 7b sage, 12a pink.
 */
export const ZONE_COLORS: string[] = HALF_ZONES.map((_, i) => {
  const t = (i / (HALF_ZONES.length - 1)) * 2;
  if (t === 0) return PURPLE;
  return t <= 1 ? mixOklab(PURPLE, SAGE, t) : mixOklab(SAGE, PINK, t - 1);
});

const ZONE_HELP: FieldHelp = {
  text: "The USDA hardiness half-zone: the band of the average yearly lowest winter temperature over 1991 to 2020, 5 °F wide. It tells which perennial plants are likely to survive the winter.",
  unit: "°F",
  source: "USDA Agricultural Research Service and Oregon State University PRISM Climate Group, 2023",
  url: "https://planthardiness.ars.usda.gov/",
};

const ZONE_LEVELS: AttributeLevel[] = HALF_ZONES.map((zone, i) => ({ value: i, label: zoneLabel(zone) }));

const ATTRIBUTES: Attribute[] = [{ key: "_symbol", type: "category", label: "Hardiness zone", levels: ZONE_LEVELS, encode: "color", primary: true, help: ZONE_HELP }];

/** The key the map fills by: one swatch per half-zone, the tile's `_symbol` index as the value. */
export const HARDINESS_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Hardiness zone",
  field: "_symbol",
  unit: "°F",
  items: HALF_ZONES.map((zone, i) => ({ label: zoneLabel(zone), value: i, color: ZONE_COLORS[i], symbol: "polygon" as const })),
  note: "Average yearly lowest winter temperature, 1991 to 2020; colder zones purple, milder sage, warmer pink.",
};

const NOTE = "This hardiness map covers the lower 48 states only; Alaska, Hawaii and Puerto Rico are not in it";

const hardinessZones = defineLayer({
  id: "hardiness-zones",
  title: "Plant hardiness zones",
  description:
    "The USDA Plant Hardiness Zone Map (2023 edition) for the lower 48 states: the coldest-winter bands that tell gardeners which perennial plants, shrubs and trees are likely to survive. " +
    "Zones run from 3a (coldest) to 12a (warmest), in half-zones of 5 °F, each based on the average yearly lowest winter temperature over 1991 to 2020, so zone 7a is about 0 to 5 °F and zone 9b about 25 to 30 °F. " +
    "The map fills each half-zone in its own color, cold purple through sage to warm pink, with a legend naming every zone and its temperature band, and tapping the map names the zone there. " +
    "Use it for 'what growing zone is this', 'where is zone 8', 'what grows here' or 'has my growing zone warmed' questions (about half the country moved to the next warmer half-zone between the 2012 map and this one). " +
    "Returns map tiles drawn on the globe, not features you can count or list, and you cannot see the rendered map: say the zones are shown, colored by zone with the legend, and do not state a place's zone yourself; for an exact address point the user to the official lookup at planthardiness.ars.usda.gov. " +
    "Caveats: zones describe winter cold only, not heat, rainfall, soil or frost dates; local microclimates (cities, valleys, slopes) differ from the zone drawn. " +
    "Lower 48 states only: Alaska, Hawaii and Puerto Rico are missing from this copy. The tiles are a community copy of the USDA map, so credit both USDA and Oregon State. " +
    "Works at any size of region.",
  coverage: "us",
  surface: "land",
  license: "USDA-ARS / Oregon State University PRISM; community copy; show both credits",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("hardiness-zones"), fillOpacity: 0.3 },
  attributes: ATTRIBUTES,
  legend: HARDINESS_LEGEND,
  fieldHelp: { _symbol: ZONE_HELP },
  card: { facts: [{ key: "_symbol", label: "Hardiness zone", values: Object.fromEntries(HALF_ZONES.map((zone, i) => [String(i), zoneLabel(zone)])) }] },
  // One map edition (2023, from 1991 to 2020 temperatures): no time panel.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Outside the lower 48 the tiles are simply empty, so they are returned anyway along with the note.
    return {
      kind: "tiles",
      data: {
        url: HARDINESS_TILE_URL,
        minzoom: 0,
        maxzoom: 12,
        format: "vector",
        sourceLayer: HARDINESS_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source:
          "USDA Agricultural Research Service and Oregon State University PRISM Climate Group, 2023 USDA Plant Hardiness Zone Map (community vector-tile copy on ArcGIS Online)",
        url: "https://planthardiness.ars.usda.gov/",
        retrieved: new Date().toISOString(),
      },
      ...(bboxesDisjoint(ctx.bbox, LOWER_48) && { coverageNote: NOTE }),
    };
  },
});

registerLayer(hardinessZones);

export default hardinessZones;

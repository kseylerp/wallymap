/**
 * Bedrock and surface geology map from Macrostrat (CC BY 4.0), keyless. Tiles only: the "what rock is here" lookup for one point is the
 * separate `geologic-unit` layer, because a point result under this id would replace the loaded tiles on the map.
 *
 * Map: vector tiles https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt (tilejson at /carto/tilejson.json: zoom 0 to 22, world bounds).
 *   Decoded live on 2026-10-09: two source layers, `units` (polygons; properties map_id, source_id, name, age, lith, descrip, t_int, b_int,
 *   best_age_top, best_age_bottom, color as a hex string, ref_*) and `lines` (faults and other contacts; properties type, name, descrip).
 *   Tiles answer at z0 to z16 and beyond (z8 Tahoe: 927 units; z12: 47; z16: 5); the layer draws `units` only, since a tile result
 *   carries one source layer. The map draws them in this layer's palette tint with hatch and outline (the renderer's vector polygon
 *   recipe), not in Macrostrat's per-unit colours. The tile server is a public service run by the Macrostrat team; set no key.
 * Drawing (2026-10-18): each unit is filled by the age of its youngest rock (`best_age_top`, millions of years) in five
 * eras (GEOLOGY_LEGEND, a stepped ramp sage → pink → purple → dark grey), so units read apart by age; decoded over the
 * Tetons (z10 196/374) every unit carries best_age_top, name, age (a period name such as "Archean"), lith and descrip.
 * Smoke check 2026-10-10 (live, keyless, through runLayer): a tile result with the Macrostrat URL, and tiles fetched at z8, z12 and z16 over Tahoe all 200.
 */
import { z } from "zod";
import { defineLayer, type Attribute, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

export const GEOLOGY_TILE_URL = "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt";
export const GEOLOGY_SOURCE_LAYER = "units";

/** The eras a unit's youngest age falls in, youngest first: the lower bound in millions of years and the fill. */
export const ERAS: { label: string; from: number; color: string }[] = [
  { label: "Quaternary (under 2.6 million years: young sediments, glacial deposits, recent lava)", from: 0, color: SAGE },
  { label: "Tertiary (2.6 to 66 million years)", from: 2.58, color: PINK },
  { label: "Mesozoic (66 to 252 million years)", from: 66, color: PURPLE },
  { label: "Paleozoic (252 to 541 million years)", from: 252, color: rgbToHex(interpolateStops([PURPLE, DARK_GREY], 0.5)) },
  { label: "Precambrian (over 541 million years)", from: 541, color: DARK_GREY },
];

/** A stepped key: each unit takes the color of the era its youngest rock falls in (no blending between stops). */
export const GEOLOGY_LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Age of the youngest rock",
  field: "best_age_top",
  unit: "million years",
  stops: ERAS.map((e) => ({ label: e.label, value: e.from, color: e.color })),
  note: "Each unit is filled by the era of its youngest rock; the color steps at each era boundary rather than blending.",
};

const AGE_HELP: FieldHelp = {
  text: "The youngest age of the rock unit (best_age_top), in millions of years, from the source map's age as Macrostrat matched it to the geologic time scale.",
  unit: "million years",
  source: "Macrostrat",
  url: "https://macrostrat.org/",
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "best_age_top",
    type: "measure",
    label: "Age of the youngest rock",
    unit: "million years",
    help: AGE_HELP,
    presets: [
      { label: "Quaternary", max: 2.58 },
      { label: "Tertiary", min: 2.58, max: 66 },
      { label: "Mesozoic", min: 66, max: 252 },
      { label: "Paleozoic", min: 252, max: 541 },
      { label: "Precambrian", min: 541 },
    ],
  },
];

const CARD: CardSpec = {
  facts: [
    { key: "age", label: "Age" },
    { key: "best_age_top", label: "Youngest age", unit: "million years", format: "1dp" },
    { key: "best_age_bottom", label: "Oldest age", unit: "million years", format: "1dp" },
    { key: "lith", label: "Rock types" },
    { key: "descrip", label: "Description" },
  ],
  hidden: ["map_id", "source_id", "t_int", "b_int", "color"],
};

const geology = defineLayer({
  id: "geology",
  title: "Geology",
  description:
    "The geologic map: bedrock and surface rock units from Macrostrat, a compilation of geologic maps (world coverage, most detailed in the United States). " +
    "It draws as map tiles, each unit filled by the age of its youngest rock in five eras with a legend (Quaternary sage, Tertiary pink, Mesozoic purple, Paleozoic grey-purple, Precambrian dark grey), and tapping a unit shows its name, age, rock types and description; it carries no features you can count or list. " +
    "Use it for 'show the geology', 'geologic map', 'rock types around here', 'where does the rock change'. " +
    "To answer 'what rock is here', 'what is this peak made of' or 'how old is the ground at this spot', call the geologic-unit layer with that place's lon and lat; it returns the unit name, age, rock type and description. " +
    "Caveats: geologic maps are drawn at the scale of their source, so edges are generalised and small outcrops are missed; units can be loose ('undivided granitic rocks'); " +
    "surface deposits like glacial till or alluvium can hide the bedrock below. " +
    "You cannot see the rendered map: say it is shown, do not claim which rock lies where. Works at any size of region.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (Macrostrat; source maps by USGS and geological surveys)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("geology"), encode: { color: "best_age_top" } },
  attributes: ATTRIBUTES,
  legend: GEOLOGY_LEGEND,
  card: CARD,
  fieldHelp: { best_age_top: AGE_HELP, best_age_bottom: { ...AGE_HELP, text: "The oldest age of the rock unit (best_age_bottom), in millions of years." }, lith: { text: "The unit's rock types as Macrostrat lists them: major, minor and incidental." } },
  // A compiled map, not a dated record.
  time: { shape: "none" },

  async query(): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: {
        url: GEOLOGY_TILE_URL,
        minzoom: 0,
        maxzoom: 16,
        format: "vector",
        sourceLayer: GEOLOGY_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source: "Macrostrat geologic map compilation (CC BY 4.0), University of Wisconsin-Madison",
        url: "https://macrostrat.org/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: "Geologic map units from Macrostrat; detail follows each source map's scale, so it is finest in the United States",
    };
  },
});

registerLayer(geology);

export default geology;

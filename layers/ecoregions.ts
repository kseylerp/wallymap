/**
 * Ecoregions: areas of similar ecosystems (climate, landform, soils, vegetation, wildlife), as outlines named on the map
 * with each region's share of the box asked. In the lower 48 the US EPA's Level III (85 regions, "Blue Ridge") or
 * Level IV (967, "Southern Metasedimentary Mountains") ecoregions (public domain); elsewhere, or where EPA's map does not
 * reach, RESOLVE Ecoregions 2017 (846 worldwide, "Appalachian-Blue Ridge forests"; Dinerstein et al. 2017, CC BY 4.0).
 *
 * Served through Google Earth Engine (lib/ee/ecoregions.ts): one request clips the regions to the box, simplifies their
 * outlines to about a pixel and measures each clipped area. Outlines are dark grey hairlines (no fill), so they sit over a
 * vegetation or land cover map; the largest six are named on the map.
 */
import { z } from "zod";
import type { Feature } from "geojson";
import { bboxAreaKm2, defineLayer, type Attribute, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";
import { createEeClient, EeError } from "@/lib/ee/client";
import { readRegions, regionsExpression, type Region, type Scheme } from "@/lib/ee/ecoregions";
import { CONUS_BBOX } from "@/lib/ee/vegetation";
import { DARK_GREY, layerColor } from "@/lib/render/palette";

const EPA_URL = "https://www.epa.gov/eco-research/ecoregions";
const RESOLVE_URL = "https://ecoregions.appspot.com/";
const LICENSE = "US EPA ecoregions: public domain; RESOLVE Ecoregions 2017: CC BY 4.0 (Dinerstein et al., BioScience 2017)";

/** Level IV is drawn for boxes up to this size; wider asks get Level III (967 small regions would not read). */
export const LEVEL4_MAX_KM2 = 150_000;
/** Regions under this share of the box are left off the map and the note. */
const MIN_SHARE = 0.002;
const MAX_REGIONS = 60;

const LEVELS: { value: string; label: string; help: string }[] = [
  { value: "3", label: "EPA Level III ecoregion", help: "One of 85 US EPA ecoregions of the lower 48: broad areas of similar landform, climate, soils and vegetation (Omernik)." },
  { value: "4", label: "EPA Level IV ecoregion", help: "One of 967 US EPA ecoregions nested in Level III: the finest level, a valley, a ridge system or a plateau." },
  { value: "resolve", label: "RESOLVE ecoregion", help: "One of 846 terrestrial ecoregions of the world (RESOLVE Ecoregions 2017), each within one of 14 biomes." },
];

export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Ecoregions",
  field: "level",
  items: LEVELS.map((l) => ({ label: l.label, value: l.value, color: DARK_GREY, symbol: "line" as const, help: l.help })),
  note: "Outlines only; the six largest in view are named. Shares are of the box asked.",
};

const ATTRIBUTES: Attribute[] = [
  { key: "level", type: "category", label: "Level", levels: LEVELS.map(({ value, label }) => ({ value, label })), primary: true },
  { key: "share", type: "measure", label: "Share of view", unit: "share of 1" },
];

const FIELD_HELP: Record<string, FieldHelp> = {
  share: { text: "How much of the box asked this ecoregion covers.", unit: "share of 1" },
  area: { text: "The ecoregion's area inside the box asked, measured on Earth Engine before the outline was simplified." },
  parent: { text: "The broader region it sits in: the EPA Level II region for Level III, the Level III region for Level IV, the biome for RESOLVE." },
};

const CARD: CardSpec = {
  facts: [
    { key: "levelLabel", label: "Level" },
    { key: "share", label: "Share of view", format: "pct" },
    { key: "area", label: "Area in view" },
    { key: "parent", label: "Within" },
    { key: "code", label: "Code" },
  ],
  hidden: ["level", "areaSqKm"],
};

const inputSchema = z.object({
  level: z.union([z.literal(3), z.literal(4)]).default(3),
  scheme: z.enum(["auto", "epa", "resolve"]).default("auto"),
  /** The place the box stands for, repeated in the note. */
  place: z.string().max(80).optional(),
});

const pct = (p: number) => (p >= 0.995 ? "100%" : p >= 0.01 ? `${Math.round(p * 100)}%` : "under 1%");
const areaText = (km2: number) => `${Math.round(km2).toLocaleString("en-US")} km² (${Math.round(km2 / 2.58999).toLocaleString("en-US")} sq mi)`;

const SCHEME_NAME: Record<Scheme, string> = { epa3: "EPA Level III ecoregions", epa4: "EPA Level IV ecoregions", resolve: "RESOLVE ecoregions (2017)" };
const LEVEL_OF: Record<Scheme, string> = { epa3: "3", epa4: "4", resolve: "resolve" };

/** "Blue Ridge 93%, Ridge and Valley 7%" for the largest regions. */
export function regionsSentence(regions: Region[], max = 8): string {
  const shown = regions.slice(0, max).map((r) => `${r.name} ${pct(r.share)}`);
  const rest = regions.length - max;
  return rest > 0 ? `${shown.join(", ")} and ${rest} smaller` : shown.join(", ");
}

const failure = (error: unknown): LayerError => {
  if (error instanceof EeError) {
    const unset = /not set up/.test(error.sourceStatus.message);
    return { error: error.sourceStatus.message, hint: unset ? "unavailable" : "upstream", sourceStatus: error.sourceStatus };
  }
  return { error: String(error), hint: "upstream" };
};

const ecoregions = defineLayer({
  id: "ecoregions",
  title: "Ecoregions",
  description:
    "Ecoregions (areas of similar ecosystems) as named outlines, the coverage note giving each one's share of the box to quote: EPA Level III (85, such as 'Blue Ridge') or Level IV (967) in the lower 48, RESOLVE 2017 elsewhere (846, such as 'Borneo lowland rain forests'). " +
    "Use it for what ecosystems or ecoregions a place spans, and as outlines over vegetation-types; to compare two places query each place's box with place set to its name. " +
    "level 3 (default) or 4 (boxes up to 150,000 km²); scheme auto (EPA in the US, else RESOLVE), epa or resolve.",
  coverage: "global",
  surface: "land",
  license: LICENSE,
  requiredEnv: ["EE_PROJECT"],
  optionalEnv: ["EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("ecoregions"), fillOpacity: 0 },
  legend: LEGEND,
  attributes: ATTRIBUTES,
  fieldHelp: FIELD_HELP,
  card: CARD,
  labels: { field: "name", max: 6, rankBy: "share" },
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const ee = createEeClient({ env: ctx.env });
    const inUs = !bboxesDisjoint(ctx.bbox, CONUS_BBOX);
    const wide = bboxAreaKm2(ctx.bbox) > LEVEL4_MAX_KM2;
    const epa: Scheme = input.level === 4 && !wide ? "epa4" : "epa3";
    const notes: string[] = [];
    if (input.level === 4 && wide) notes.push(`Level IV is drawn for boxes up to ${LEVEL4_MAX_KM2.toLocaleString("en-US")} km², so this wider box shows Level III`);

    let scheme: Scheme = input.scheme === "resolve" || (input.scheme === "auto" && !inUs) ? "resolve" : epa;
    let regions: Region[];
    try {
      regions = readRegions(await ee.compute(regionsExpression(scheme, ctx.bbox)), ctx.bbox);
      // EPA's map stops at the border and the shore: a box mostly outside it reads RESOLVE instead (auto only).
      const covered = regions.reduce((s, r) => s + r.share, 0);
      if (input.scheme === "auto" && scheme !== "resolve" && covered < 0.5) {
        const world = readRegions(await ee.compute(regionsExpression("resolve", ctx.bbox)), ctx.bbox);
        if (world.reduce((s, r) => s + r.share, 0) > covered) {
          notes.push(`EPA's ecoregions cover only ${pct(covered)} of this box (they stop at the US border and the shore), so it shows RESOLVE's`);
          scheme = "resolve";
          regions = world;
        }
      }
    } catch (error) {
      return failure(error);
    }
    const kept = regions.filter((r) => r.share >= MIN_SHARE).slice(0, MAX_REGIONS);
    const where = input.place ? `in the box asked for ${input.place}` : "in the box asked";
    const features: Feature[] = kept.map((r) => ({
      type: "Feature",
      geometry: r.geometry,
      properties: {
        name: r.name,
        level: LEVEL_OF[scheme],
        levelLabel: LEVELS.find((l) => l.value === LEVEL_OF[scheme])!.label,
        share: Math.round(r.share * 1000) / 1000,
        areaSqKm: Math.round(r.areaM2 / 1e6),
        area: areaText(r.areaM2 / 1e6),
        ...(r.parent && { parent: r.parent }),
        ...(r.code && { code: r.code }),
      },
    }));
    const stated = kept.length > 0 ? `${SCHEME_NAME[scheme]}, share of the box ${where}: ${regionsSentence(kept)}` : `No ecoregion ${where} (open sea)`;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation: {
        source: scheme === "resolve" ? "RESOLVE Ecoregions 2017 (CC BY 4.0), Dinerstein et al., BioScience (2017); via Google Earth Engine" : "US EPA Level III and IV Ecoregions of the conterminous United States (2013, public domain); via Google Earth Engine",
        url: scheme === "resolve" ? RESOLVE_URL : EPA_URL,
        retrieved: new Date().toISOString(),
        label: scheme === "resolve" ? "RESOLVE Ecoregions 2017 (CC BY 4.0)" : "US EPA ecoregions (public domain)",
      },
      coverageNote: [stated, ...notes].join(". "),
    };
  },
});

registerLayer(ecoregions);

export default ecoregions;

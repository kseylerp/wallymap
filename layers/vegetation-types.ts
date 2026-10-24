/**
 * Vegetation types from LANDFIRE's existing vegetation type map (EVT, LANDFIRE 1.4.0, about 2014; USGS and the US Forest
 * Service, public domain): every 30 m of the lower 48 as one of 849 named ecological systems ("Southern Appalachian Oak
 * Forest", "Inter-Mountain Basins Big Sagebrush Steppe") or water, barren, developed and farm classes.
 *
 * Served through Google Earth Engine (lib/ee/vegetation.ts): the map draws the classes grouped into eight palette colors
 * (conifer forest, hardwood and mixed forest, shrubland, grassland, wetland and riparian, water, farmland and developed,
 * sparse and bare) through our own tile route, while the coverage note, the legend's shares and the card keep LANDFIRE's
 * own class names. The legend lists the groups in view with their share (viewShares); a tap reads the class at the point.
 */
import { z } from "zod";
import { bboxAreaKm2, defineLayer, type Attribute, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { bboxesDisjoint } from "./_shared/coverage";
import { pointFeature } from "./_shared/identify";
import { createEeClient, EeError, type EeClient } from "@/lib/ee/client";
import {
  CONUS_BBOX,
  EVT_YEAR,
  GROUPS,
  groupByKey,
  pointExpression,
  readPoint,
  readShares,
  sharesExpression,
  sharesScale,
  OTHER_TYPES_ALPHA,
  topTypes,
  typeColors,
  typesTileQuery,
  faintOver,
  type EvtClass,
  type EvtShares,
} from "@/lib/ee/vegetation";
import { eeTileTemplate } from "@/lib/ee/tiles";
import { hexToRgb, rgbToHex } from "@/lib/render/ramp";
import { layerColor, SAGE } from "@/lib/render/palette";

const CITATION_SOURCE = "LANDFIRE 1.4.0 Existing Vegetation Type (about 2014), US Geological Survey and US Forest Service (public domain); via Google Earth Engine";
const CITATION_URL = "https://landfire.gov/vegetation/evt";
const CITATION_LABEL = "LANDFIRE (USGS, US Forest Service; public domain)";
const LICENSE = "Public domain (LANDFIRE, US Geological Survey and US Forest Service)";
const MAP = `LANDFIRE 1.4.0 (about ${EVT_YEAR})`;

/** A color drawn at `alpha` over white, as the faint farmland and developed pixels look on a light map. */
const faint = (hex: string, alpha: number): string => rgbToHex(hexToRgb(hex).map((c) => 255 - (255 - c) * alpha) as [number, number, number]);

export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Vegetation type",
  field: "group",
  items: GROUPS.map((g) => ({ label: g.label, value: g.code, color: g.alpha < 1 ? faint(g.color, g.alpha) : g.color, symbol: "raster" as const, help: g.help })),
  note: "LANDFIRE's 849 vegetation types in eight colors; tap the map for the type's own name. Lower 48 only, as mapped about 2014.",
};

/**
 * An answer's key: its largest named types (LANDFIRE's own names), each in the color the map draws it, then the rest
 * under one faint entry. The shares in view come from viewShares by type (field `evt`).
 */
export function typesLegend(classes: EvtClass[]): LegendSpec {
  const colors = typeColors(classes);
  return {
    kind: "categories",
    title: "Vegetation type",
    field: "evt",
    items: [
      ...classes.map((cls, i) => ({ label: cls.name, value: cls.value, color: colors[i], symbol: "raster" as const, help: `${groupByKey(cls.group)!.label}; ${cls.physiognomy.toLowerCase()}.` })),
      { label: "Other types (drawn faint in their group's color)", value: 0, color: faintOver(SAGE, OTHER_TYPES_ALPHA), symbol: "raster" as const },
    ],
    note: "The largest LANDFIRE vegetation types in the box asked, each in its own color; tap the map for any type's name. Lower 48 only, as mapped about 2014.",
  };
}

const inputSchema = z.object({
  /** The place the box stands for, as the question names it; the note repeats it so two places' numbers never mix. */
  place: z.string().max(80).optional(),
});

const help = (text: string): FieldHelp => ({ text, source: "LANDFIRE Existing Vegetation Type", url: CITATION_URL });

const FIELD_HELP: Record<string, FieldHelp> = {
  groupLabel: help("Which of the map's eight colors this vegetation type is drawn in."),
  lifeForm: help("The type's physiognomy, LANDFIRE's word for its plant form: conifer, hardwood, conifer-hardwood, shrubland, grassland, riparian or wetland, sparse, developed or agricultural."),
  lfGroup: help("LANDFIRE's broader group of similar vegetation types, where LANDFIRE's own table names one."),
  map: help("The map edition: LANDFIRE 1.4.0 shows vegetation as of about 2014, after the fires and logging LANDFIRE had mapped by then."),
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "group",
    type: "category",
    label: "Vegetation group",
    levels: GROUPS.map((g) => ({ value: g.code, label: g.label, help: g.help })),
    primary: true,
  },
];

const pct = (p: number) => (p >= 0.995 ? "100%" : p >= 0.01 ? `${Math.round(p * 100)}%` : "under 1%");

/** "Southern Appalachian Oak Forest 29%, ..." for the largest types (at least 1% each, up to `max`). */
export function classesSentence(shares: EvtShares, max = 8): string {
  return shares.classes
    .filter((c) => c.share >= 0.01)
    .slice(0, max)
    .map((c) => `${c.cls.name} ${pct(c.share)}`)
    .join(", ");
}

/** "hardwood and mixed forest 85%, conifer forest and woodland 9%, ..." for the groups over 0.5%. */
export function groupsSentence(shares: EvtShares): string {
  return Object.entries(shares.groups)
    .filter(([, s]) => s >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([k, s]) => `${groupByKey(k)!.label.toLowerCase()} ${pct(s)}`)
    .join(", ");
}

const failure = (error: unknown): LayerError => {
  if (error instanceof EeError) {
    const unset = /not set up/.test(error.sourceStatus.message);
    return { error: error.sourceStatus.message, hint: unset ? "unavailable" : "upstream", sourceStatus: error.sourceStatus };
  }
  return { error: String(error), hint: "upstream" };
};

const OUTSIDE = "LANDFIRE vegetation types cover the lower 48 US states only; outside them use land-cover (worldwide) or ecoregions (RESOLVE, worldwide)";

const client = (env: Record<string, string | undefined>): EeClient => createEeClient({ env });

const vegetationTypes = defineLayer({
  id: "vegetation-types",
  title: "Vegetation types",
  description:
    "What grows where in the lower 48, 30 m: LANDFIRE's 849 named vegetation types (about 2014), such as 'Southern Appalachian Oak Forest', 'Appalachian Spruce-Fir Forest', 'Big Sagebrush Steppe'. " +
    "Use it for what grows here and what ecosystems or vegetation types cover a place; to compare two places query each place's box with place set to its name. " +
    "The coverage note gives the largest named types and their groups with shares of the box: quote those names and numbers. " +
    "Returns map tiles, not features you can count or list.",
  coverage: "us",
  surface: "land",
  license: LICENSE,
  requiredEnv: ["EE_PROJECT"],
  optionalEnv: ["EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("vegetation-types"), raster: { saturation: 0, opacity: 0.85, swatch: SAGE } },
  legend: LEGEND,
  attributes: ATTRIBUTES,
  fieldHelp: FIELD_HELP,
  card: {
    facts: [
      { key: "groupLabel", label: "Map group" },
      { key: "lifeForm", label: "Plant form" },
      { key: "lfGroup", label: "Vegetation group" },
      { key: "map", label: "Map" },
    ],
    hidden: ["group", "value"],
  },
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    if (bboxesDisjoint(ctx.bbox, CONUS_BBOX)) return { error: OUTSIDE };
    const citation = { source: CITATION_SOURCE, url: CITATION_URL, retrieved: new Date().toISOString(), label: CITATION_LABEL };
    let shares: EvtShares | null;
    try {
      shares = readShares(await client(ctx.env).compute(sharesExpression(ctx.bbox)));
    } catch (error) {
      return failure(error);
    }
    if (!shares) return { error: `No LANDFIRE vegetation in the box asked${input.place ? ` (${input.place})` : ""}: ${OUTSIDE}` };
    const where = input.place ? `in the box asked for ${input.place}` : "in the box asked";
    const km2 = Math.round(bboxAreaKm2(ctx.bbox)).toLocaleString("en-US");
    const top = topTypes(shares);
    return {
      kind: "tiles",
      data: { url: eeTileTemplate("vegetation-types", typesTileQuery(top.map((c) => c.value))), minzoom: 4, maxzoom: 15, format: "raster" },
      citation,
      coverageNote:
        `${MAP}, share of the mapped land ${where} (${km2} km²): largest vegetation types ${classesSentence(shares)}; ` +
        `by group ${groupsSentence(shares)}. Counted on a ${sharesScale(ctx.bbox)} m grid; the map colors the ${top.length} largest types, the rest faint`,
      legend: top.length > 0 ? typesLegend(top) : LEGEND,
    };
  },

  async viewShares(ctx) {
    if (bboxesDisjoint(ctx.bbox, CONUS_BBOX)) return null;
    try {
      const shares = readShares(await client(ctx.env).compute(sharesExpression(ctx.bbox)));
      if (!shares) return null;
      // By type (the answer's key names types); the layer's group key, when it is shown, reads `group`.
      return { field: "evt", shares: Object.fromEntries(shares.classes.map((c) => [String(c.cls.value), c.share])) };
    } catch (error) {
      return failure(error);
    }
  },

  async identify(ctx, at) {
    try {
      const cls = readPoint(await client(ctx.env).compute(pointExpression(at.lon, at.lat)));
      if (!cls) return null;
      const group = groupByKey(cls.group)!;
      return pointFeature(at, {
        name: cls.name,
        group: group.code,
        value: cls.value,
        groupLabel: group.label,
        lifeForm: cls.physiognomy,
        ...(cls.lfGroup && cls.lfGroup !== cls.name && { lfGroup: cls.lfGroup }),
        map: MAP,
      });
    } catch (error) {
      return failure(error);
    }
  },
});

registerLayer(vegetationTypes);

export default vegetationTypes;

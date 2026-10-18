/**
 * Principal aquifers of the United States (USGS, "Principal Aquifers of the 48 Conterminous United States, Hawaii, Puerto Rico,
 * and the U.S. Virgin Islands", 2003, from the Ground Water Atlas). The USGS publishes the data as files only, so the layer reads
 * two hosted copies of the same polygons (verified live 2026-10-10, both keyless, f=geojson works, maxRecordCount 2000):
 *   1. Nevada Division of Water Resources (a third-party copy of the USGS data, 1,759 polygons, but clipped to the west:
 *      the service extent is -124.57,31.33 to -107.03,49.00 and a Nebraska box returns nothing):
 *      https://arcgis.water.nv.gov/arcgis/rest/services/BaseLayers/USGS_Aquifers_Principal/FeatureServer/0
 *   2. Esri Living Atlas "USA Aquifers" (3,010 polygons for the whole country, so it has the High Plains / Ogallala aquifer):
 *      https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Aquifers_Feature_Layer_view/FeatureServer/0
 *      Its licence is the Esri Master License Agreement, so the layer uses it only for views that leave the Nevada copy's extent
 *      (or when the Nevada server fails), and the licence string says so.
 * Fields (same on both): AQ_NAME (aquifer name; Nevada copy in sentence case, Esri copy title case), AQ_CODE, ROCK_TYPE (100 unconsolidated
 *   sand and gravel, 200 semiconsolidated sand, 300 sandstone, 400 carbonate rock, 500 sandstone and carbonate rock, 600 igneous and
 *   metamorphic rock; 999 "Other rocks" with a blank name exists only in the Nevada copy and is filtered out), ROCK_NAME.
 * Output: name, kind (the rock type, spelled out), rockType (code), aquiferCode, and alias "Ogallala" on the High Plains aquifer.
 * The lower 48 box (-125,24,-66,50) returned the 2,000-polygon cap (about 2.4 MB), hence the 6 million km2 limit.
 * Smoke check 2026-10-10 (live, through runLayer): Nebraska box -102,40,-98,42 returned the High Plains Aquifer (alias Ogallala, unconsolidated
 *   sand and gravel) from the Esri copy in 0.4 s; a Nevada-Utah box -120,38,-114,41 returned 123 polygons from the Nevada copy in 0.6 s.
 * Smoke wide 2026-10-14 (live, through runLayer): the lower 48 -125,24,-66,50 (about 15 million km2) returned the 1,000 largest of 2,609
 *   polygons from the Esri copy in 0.8 s (529 KB at 0.295 degrees), High Plains Aquifer first.
 * Drawing (2026-10-18): `rockType` is the color category (ROCK_LEVELS: sand and gravel sage, sandstone pink, carbonate purple,
 *   igneous and metamorphic dark grey, the mixed classes in between) with a legend; the High Plains aquifer carries the flag
 *   `ogallala` so it can be singled out with one chip, and its card points to the groundwater layer for water levels.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type LegendSpec, type QueryContext, type CardSpec, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

export const NEVADA_COPY =
  "https://arcgis.water.nv.gov/arcgis/rest/services/BaseLayers/USGS_Aquifers_Principal/FeatureServer/0";
export const ESRI_COPY =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Aquifers_Feature_Layer_view/FeatureServer/0";

/** The part of the world the Nevada copy holds (its service extent, trimmed in a little). */
export const NEVADA_EXTENT: BBox = [-124.4, 31.5, -107.2, 48.9];

/** Aquifer polygons were drawn for a 1:2,500,000 atlas, so a coarse simplification costs nothing. */
const TTL_SECONDS = 7 * 86_400;
const FIELDS = ["AQ_NAME", "AQ_CODE", "ROCK_TYPE", "ROCK_NAME"];

export const ROCK_TYPES: Record<number, string> = {
  100: "Unconsolidated sand and gravel",
  200: "Semiconsolidated sand and gravel",
  300: "Sandstone",
  400: "Carbonate rock",
  500: "Sandstone and carbonate rock",
  600: "Igneous and metamorphic rock",
};

const mix = (a: string, b: string) => rgbToHex(interpolateStops([a, b], 0.5));

/** The rock types as the map fills them. */
export const ROCK_LEVELS: { value: number; label: string; color: string }[] = [
  { value: 100, label: ROCK_TYPES[100], color: SAGE },
  { value: 200, label: ROCK_TYPES[200], color: mix(SAGE, PINK) },
  { value: 300, label: ROCK_TYPES[300], color: PINK },
  { value: 400, label: ROCK_TYPES[400], color: PURPLE },
  { value: 500, label: ROCK_TYPES[500], color: mix(PINK, PURPLE) },
  { value: 600, label: ROCK_TYPES[600], color: DARK_GREY },
];

export const AQUIFERS_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Aquifer rock",
  field: "rockType",
  items: ROCK_LEVELS.map(({ value, label, color }) => ({ label, value, color, symbol: "polygon" as const })),
  note: "The shallowest principal aquifer, mapped at 1:2.5 million in 2003; the High Plains (Ogallala) aquifer is sand and gravel.",
};

/** On the High Plains aquifer's card: where its water levels are. */
export const OGALLALA_NOTE = "Water levels in many High Plains wells have fallen since irrigation began in the 1950s; the groundwater layer shows measured well levels";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inside(view: BBox, extent: BBox): boolean {
  return view[0] >= extent[0] && view[1] >= extent[1] && view[2] <= extent[2] && view[3] <= extent[3];
}

/**
 * Simplification in degrees for a view: about 1/400 of its width, between 0.002 and 0.2. A wide box (over the soft cap) uses
 * 1/200 of its width, up to 0.4: the lower 48 drops from about 1.9 MB to 0.55 MB for the 1,000 largest polygons.
 */
export function offsetFor(bbox: BBox, wide = false): number {
  const width = bbox[2] - bbox[0];
  return Math.min(wide ? 0.4 : 0.2, Math.max(0.002, Math.round((width / (wide ? 200 : 400)) * 10_000) / 10_000));
}

/** Aquifer polygons with a readable name and the rock type spelled out in `kind`. */
export function normalizeAquifers(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const rock = num(p.ROCK_TYPE);
    if (rock === 999) continue;
    const name = str(p.AQ_NAME) ?? "Unnamed aquifer";
    const properties: Record<string, string | number | boolean> = { name };
    const kind = (rock !== undefined ? ROCK_TYPES[rock] : undefined) ?? str(p.ROCK_NAME);
    if (kind !== undefined) properties.kind = kind;
    if (rock !== undefined) properties.rockType = rock;
    const code = num(p.AQ_CODE);
    if (code !== undefined) properties.aquiferCode = code;
    if (/high plains/i.test(name)) {
      properties.alias = "Ogallala";
      properties.ogallala = true;
      properties.waterLevels = OGALLALA_NOTE;
    }
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/** Most polygons in a wide result, largest first. */
const WIDE_LIMIT = 1000;

async function fromService(ctx: QueryContext, url: string, tag: string) {
  return arcgisQuery(ctx, url, {
    outFields: FIELDS,
    bbox: ctx.bbox,
    where: "ROCK_TYPE <> 999",
    orderByFields: "Shape__Area DESC",
    maxAllowableOffset: offsetFor(ctx.bbox, ctx.wide === true),
    // Wide (over 6 million km²): the strategy's limit and a count, so the note can say how many polygons there are in all.
    ...(ctx.wide && { resultRecordCount: ctx.wideStrategy?.limit ?? WIDE_LIMIT, withCount: true }),
    ttlSeconds: TTL_SECONDS,
    cacheSuffix: `aquifers:${tag}`,
  });
}

const AQUIFERS_URL = "https://pubs.usgs.gov/publication/70046037";

/** What the rock and code on an aquifer card mean (spec §12b). */
const HELP: Record<string, FieldHelp> = {
  kind: {
    text:
      "The aquifer's rock: unconsolidated sand and gravel, semiconsolidated sand and gravel, sandstone, carbonate rock, sandstone and carbonate " +
      "rock, or igneous and metamorphic rock.",
    source: "USGS Principal Aquifers (2003)",
    url: AQUIFERS_URL,
  },
  aquiferCode: {
    text: "The aquifer's code number in the USGS Principal Aquifers data: an identifier for the named aquifer, not a measurement.",
    source: "USGS Principal Aquifers (2003)",
    url: AQUIFERS_URL,
  },
};

/** The aquifer card: the rock in words, the other name, and the USGS code with its meaning. */
const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Rock type" },
    { key: "alias", label: "Also called" },
    { key: "waterLevels", label: "Water levels" },
    { key: "aquiferCode", label: "USGS aquifer code", format: "int" },
  ],
  // rockType is the numeric code behind kind; ogallala is the chip's flag.
  hidden: ["rockType", "ogallala"],
};

const ATTRIBUTES: Attribute[] = [
  { key: "rockType", type: "category", label: "Aquifer rock", levels: ROCK_LEVELS.map(({ value, label }) => ({ value, label })), encode: "color", primary: true },
  { key: "ogallala", type: "flag", label: "High Plains (Ogallala) aquifer" },
  { key: "name", type: "name", label: "Aquifer name" },
];

const aquifers = defineLayer({
  id: "aquifers",
  title: "Principal aquifers",
  description:
    "Principal aquifers of the United States (the rock or sand layers that hold pumped groundwater), including the High Plains (Ogallala) aquifer. Each polygon has name, kind (the rock: sand and gravel, sandstone, carbonate rock, igneous and metamorphic), rockType, aquiferCode, and on the High Plains alias 'Ogallala', ogallala (true) and waterLevels. The map fills each aquifer by its rock with a legend, and the Ogallala can be picked out with its chip. It shows the shallowest principal aquifer at 1:2.5 million scale (2003), so it is regional, the glacial aquifers of the northern states are missing, and it is not a well map; use groundwater for water levels. Read from third-party copies of USGS data. Over 6,000,000 km² it keeps the 1,000 largest.",
  coverage: "us",
  surface: "land",
  license:
    "USGS Principal Aquifers (public domain, 2003), served from third-party copies: Nevada Division of Water Resources (western US) and Esri Living Atlas USA Aquifers (rest of the US, Esri terms of use)",
  requiredEnv: [],
  maxAreaKm2: 6_000_000,
  wide: { orderBy: "area", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("aquifers"), fillOpacity: 0.2 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: AQUIFERS_LEGEND,
  labels: { field: "name", max: 8 },
  // One 2003 atlas: no time panel.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source:
        "USGS Principal Aquifers of the 48 Conterminous United States, Hawaii, Puerto Rico, and the U.S. Virgin Islands (public domain), copies hosted by Nevada Division of Water Resources and Esri Living Atlas",
      url: "https://pubs.usgs.gov/publication/70046037",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const west = inside(ctx.bbox, NEVADA_EXTENT);
    let res = await fromService(ctx, west ? NEVADA_COPY : ESRI_COPY, west ? "nv" : "esri");
    // The Nevada server is a state agency's; if it is down the Esri copy has the same polygons.
    if (!res.ok && west) res = await fromService(ctx, ESRI_COPY, "esri");
    if (!res.ok) return { error: res.error, hint: "upstream" };

    const data = normalizeAquifers(res.fc);
    const notes: string[] = [];
    if (res.truncated && !ctx.wide) notes.push("Showing the 2,000 largest aquifer polygons; zoom in for the rest");
    if (data.features.length === 0) notes.push("No principal aquifer is mapped here (the glacial aquifers of the northern states are not in this dataset)");
    return {
      kind: "geojson",
      data,
      citation,
      ...(res.total !== undefined && { total: res.total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(aquifers);

export default aquifers;

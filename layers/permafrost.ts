/**
 * Permafrost zones of the Northern Hemisphere: the Circum-Arctic Map of Permafrost and Ground-Ice Conditions (Brown,
 * Ferrians, Heginbottom and Melnikov; IPA, NSIDC), from a third-party ArcGIS Online copy, with the Permafrost map of the
 * Atlas of Canada (NRCan) as optional raster tiles.
 *
 * Verified live 2026-10-10:
 *   https://services.arcgis.com/6DIQcwlPy8knb6sg/arcgis/rest/services/North_Hemisphere_Permafrost_WFL1/FeatureServer/0
 *     "Circum-Arctic Permafrost and Ground Ice Conditions", polygons 25°N to 89°N, maxRecordCount 2000, fields
 *     EXTENT (C continuous 90-100%, D discontinuous 50-90%, S sporadic 10-50%, I isolated 0-10%, blank for none),
 *     CONTENT (ground ice in the upper 10-20 m: h high >20%, m medium 10-20%, l low 0-10%), LANDFORM (f lowlands with
 *     thick overburden, r mountains and plateaus with thin overburden or bedrock), RELICT ("yes"), COMBO, NUM_CODE.
 *     Non-permafrost codes (COMBO g glacier, l lake, o ocean, ld land) have a blank EXTENT and are filtered out by the
 *     query. 7,191 permafrost polygons in all; Alaska [-170,55,-140,72] at maxAllowableOffset 0.1 is 864 polygons, 300 KB,
 *     1.1 s. The item has no licence or copyright text and its owner is not the map's authors, so the licence is unstated.
 *   NRCan: https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/permafrost_atlas_of_canada_en/MapServer
 *     layer 6 "Permafrost and Ground Ice" (Atlas of Canada 5th edition), drawn through `export` in EPSG:3857 (the service
 *     itself is EPSG:3978, reprojected on the fly); CORS echoes the Origin; Open Government Licence - Canada.
 *
 * Live smoke through runLayer 2026-10-10: Fairbanks [-150,63,-145,66] 135 polygons in 0.4 s (133 discontinuous, mostly
 * low ice on uplands, 2 continuous); all of Alaska [-170,55,-140,72] 864 polygons in 0.5 s; canada=true returned the
 * NRCan export template, whose tiles answered 200 PNG over the Northwest Territories.
 * Drawing (2026-10-18): zones are colored by class on the ordinal ramp (encode color by kind, isolated to continuous), so
 * "is there permafrost under Fairbanks" reads from the map; each zone is named ("Discontinuous permafrost zone") for the
 * card title. Simplification is finer (view / 400, was / 200) and the triangle slivers it leaves are dropped: interior
 * Alaska [-152,62,-145,65] returned 269 polygons, 187 of them slivers of a few km², drawn as spikes in the Alaska Range.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type LayerError, type LayerResult, type CardSpec, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://services.arcgis.com/6DIQcwlPy8knb6sg/arcgis/rest/services/North_Hemisphere_Permafrost_WFL1/FeatureServer/0";
const NRCAN = "https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/permafrost_atlas_of_canada_en/MapServer";
const TTL_SECONDS = 30 * 86_400;
const MAX_RECORDS = 2000;

const EXTENTS: Record<string, { kind: string; percent: string; v: number }> = {
  C: { kind: "continuous", percent: "90-100%", v: 95 },
  D: { kind: "discontinuous", percent: "50-90%", v: 70 },
  S: { kind: "sporadic", percent: "10-50%", v: 30 },
  I: { kind: "isolated", percent: "0-10%", v: 5 },
};
const ICE: Record<string, string> = { h: "high (over 20%)", m: "medium (10-20%)", l: "low (under 10%)" };
const LANDFORMS: Record<string, string> = {
  f: "lowland or highland with thick sediment",
  r: "mountains or plateau with thin sediment or bedrock",
};

const inputSchema = z.object({
  canada: z.boolean().default(false),
});

/** Display simplification in degrees: about 1/200 of the view, between ~500 m and ~10 km. */
export function permafrostOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.1, Math.max(0.003, Math.round((span / 400) * 1000) / 1000));
}

/** Shoelace area of a ring in square degrees (a relative size: only compared with the offset). */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}

/**
 * Drops the slivers simplification leaves: polygon parts collapsed to a triangle (four positions or fewer) and smaller
 * than four offset squares. Interior Alaska [-152,62,-145,65] at the old offset (0.035°) came back with 243 such
 * triangles, drawn as the "shattered glass" spikes in the Alaska Range. Returns the kept features and how many parts
 * went.
 */
export function dropSlivers(features: Feature<Geometry>[], offset: number): { features: Feature<Geometry>[]; dropped: number } {
  const min = 4 * offset * offset;
  const sliver = (rings: Position[][]) => rings[0] !== undefined && rings[0].length <= 4 && ringArea(rings[0]) < min;
  let dropped = 0;
  const out: Feature<Geometry>[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g?.type === "Polygon") {
      if (sliver(g.coordinates)) dropped++;
      else out.push(f);
    } else if (g?.type === "MultiPolygon") {
      const parts = g.coordinates.filter((p) => !sliver(p));
      dropped += g.coordinates.length - parts.length;
      if (parts.length > 0) out.push({ ...f, geometry: { type: "MultiPolygon", coordinates: parts } });
    } else out.push(f);
  }
  return { features: out, dropped };
}

/** Permafrost polygons with kind = extent class, v = typical percent of ground frozen, groundIce, landform, relict. */
export function normalizePermafrost(fc: FeatureCollection): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const extent = EXTENTS[String(p.EXTENT ?? "").trim()];
    if (extent === undefined || f.geometry === null) continue;
    const name = `${extent.kind.charAt(0).toUpperCase()}${extent.kind.slice(1)} permafrost zone`;
    const props: Record<string, string | number> = { name, kind: extent.kind, percent: extent.percent, v: extent.v };
    const ice = ICE[String(p.CONTENT ?? "").trim()];
    if (ice) props.groundIce = ice;
    const landform = LANDFORMS[String(p.LANDFORM ?? "").trim()];
    if (landform) props.landform = landform;
    if (String(p.RELICT ?? "").trim() === "yes") props.relict = "yes";
    out.push({ type: "Feature", geometry: f.geometry, properties: props });
  }
  return out;
}

const IPA_URL = "https://nsidc.org/data/ggd318/versions/2";
const IPA_SOURCE = "IPA Circum-Arctic Map of Permafrost and Ground-Ice Conditions (Brown et al., NSIDC)";

/** What a permafrost zone's classes mean (spec §12b), in the map's own terms. */
const HELP: Record<string, FieldHelp> = {
  kind: {
    text: "How much of the ground is frozen year-round in this zone.",
    scale: "Continuous 90 to 100%, discontinuous 50 to 90%, sporadic 10 to 50%, isolated 0 to 10%",
    source: IPA_SOURCE,
    url: IPA_URL,
  },
  percent: { text: "The share of the ground frozen year-round, as the zone's class range.", source: IPA_SOURCE, url: IPA_URL },
  groundIce: {
    text: "How much ice the top 10 to 20 m of ground holds: high over 20%, medium 10 to 20%, low under 10%. High-ice ground slumps and sinks most when it thaws.",
    source: IPA_SOURCE,
    url: IPA_URL,
  },
  relict: { text: "Old permafrost left from colder times." },
};

/** The zones on the ordinal ramp, least frozen to most (sage → pink → purple), the map's color and its key. */
const ATTRIBUTES: Attribute[] = [
  {
    key: "kind",
    type: "ordinal",
    label: "Permafrost zone",
    scale: "IPA extent classes (share of ground frozen)",
    primary: true,
    levels: [
      { value: "isolated", label: "Isolated (0 to 10%)", help: "Frozen ground in a few small patches." },
      { value: "sporadic", label: "Sporadic (10 to 50%)", help: "Frozen ground in scattered patches." },
      { value: "discontinuous", label: "Discontinuous (50 to 90%)", help: "Most ground frozen, with thawed gaps." },
      { value: "continuous", label: "Continuous (90 to 100%)", help: "Nearly all ground frozen." },
    ],
  },
  {
    key: "groundIce",
    type: "category",
    label: "Ground ice",
    levels: [
      { value: "high (over 20%)", label: "High (over 20%)" },
      { value: "medium (10-20%)", label: "Medium (10 to 20%)" },
      { value: "low (under 10%)", label: "Low (under 10%)" },
    ],
  },
];

/** The zone card: the zone in words, its share of frozen ground, ground ice and landform. */
const CARD: CardSpec = {
  facts: [
    { key: "kind", label: "Zone", values: { continuous: "Continuous", discontinuous: "Discontinuous", sporadic: "Sporadic", isolated: "Isolated" } },
    { key: "percent", label: "Ground frozen" },
    { key: "groundIce", label: "Ground ice" },
    { key: "landform", label: "Landform" },
    { key: "relict", label: "Relict permafrost", values: { yes: "Yes" } },
  ],
  // name is the card's title ("Discontinuous permafrost zone").
  hidden: ["name"],
};

const permafrost = defineLayer({
  id: "permafrost",
  title: "Permafrost zones",
  description:
    "Permafrost zones (ground frozen year-round) across the Northern Hemisphere, from the IPA Circum-Arctic Map, as polygons whose kind is the share of ground frozen: 'continuous' (90-100%), 'discontinuous' (50-90%), 'sporadic' (10-50%) or 'isolated' (0-10%); Alaska, Canada, Greenland, Russia, Mongolia, the Tibetan Plateau and high mountains. " +
    "Each polygon has kind, percent (as text) and v (a typical percent: 95, 70, 30 or 5); " +
    "groundIce (ice in the top 10-20 m: high, medium or low; high-ice ground slumps and sinks most when it thaws), landform, and relict ('yes' for old permafrost left from colder times). " +
    "Set canada to true to draw the Atlas of Canada permafrost map (Natural Resources Canada) as map tiles instead, which is more detailed for Canada but returns map tiles, not features. " +
    "Example questions: 'Is there permafrost under Fairbanks?', 'Where is the permafrost continuous in Alaska?', 'Which areas have ice-rich permafrost that could thaw?'. User words: permafrost, frozen ground, thawing ground. " +
    "Caveats: a broad 1:10,000,000 map compiled in the 1990s, so it shows zones, not whether a given lot is frozen, and it predates recent thaw; the polygons are a third-party copy whose licence is not stated. " +
    "Northern Hemisphere only (south of about 25°N returns nothing). Zoom in to under 7,000,000 km² first (all of Alaska fits).",
  coverage: { bbox: [-180, 25, 180, 90] },
  surface: "land",
  license: "Unstated: a third-party ArcGIS copy of the IPA Circum-Arctic map (Brown et al., NSIDC, who ask for citation); Canada tiles Open Government Licence - Canada (NRCan)",
  requiredEnv: [],
  // All of Alaska (its box, 5,983,000 km², spans the Aleutians) answers.
  maxAreaKm2: 7_000_000,
  input: inputSchema,
  // Color by zone on the ordinal ramp: the old single hatch made every class look the same.
  style: { geometry: "polygon", color: layerColor("permafrost"), fillOpacity: 0.4, encode: { color: "kind" } },
  attributes: ATTRIBUTES,
  time: { shape: "none" },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const retrieved = new Date().toISOString();
    if (input.canada) {
      return {
        kind: "tiles",
        data: { url: mapServerExportTileUrl(NRCAN, { layers: "show:6" }), minzoom: 2, maxzoom: 10, format: "raster" },
        citation: {
          source: "Natural Resources Canada, The Atlas of Canada 5th edition, Permafrost (Open Government Licence - Canada)",
          url: NRCAN,
          retrieved,
        },
        coverageNote: "Atlas of Canada permafrost map; Canada only",
      };
    }
    const citation = {
      source:
        "Brown, J., O. Ferrians, J. A. Heginbottom and E. Melnikov, Circum-Arctic Map of Permafrost and Ground-Ice Conditions, Version 2 (IPA / NSIDC), via a third-party ArcGIS Online copy (licence not stated)",
      url: "https://nsidc.org/data/ggd318/versions/2",
      retrieved,
    };
    if (ctx.bbox[3] < 25) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: "The permafrost map covers the Northern Hemisphere north of 25°N only" };
    }
    const res = await arcgisQuery(ctx, SERVICE, {
      where: "EXTENT IN ('C','D','S','I')",
      outFields: ["EXTENT", "CONTENT", "LANDFORM", "RELICT"],
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: permafrostOffset(ctx.bbox),
      orderByFields: "Shape__Area DESC",
      ttlSeconds: TTL_SECONDS,
      // v2: the offset changed (view / 400), so bodies cached at the old one are not read.
      cacheSuffix: "zones-v2",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };
    const { features, dropped } = dropSlivers(normalizePermafrost(res.fc), permafrostOffset(ctx.bbox));
    const notes: string[] = ["kind = share of ground frozen: continuous 90-100%, discontinuous 50-90%, sporadic 10-50%, isolated 0-10%"];
    if (res.truncated) notes.push(`Showing the ${MAX_RECORDS} largest permafrost areas; zoom in for the small ones`);
    if (dropped > 0) notes.push(`${dropped} patches too small to draw at this zoom left out; zoom in to see them`);
    if (features.length === 0) notes.push("No permafrost mapped in this view");
    const data: FeatureCollection = { type: "FeatureCollection", features };
    return { kind: "geojson", data, citation, coverageNote: notes.join("; ") };
  },
});

registerLayer(permafrost);

export default permafrost;

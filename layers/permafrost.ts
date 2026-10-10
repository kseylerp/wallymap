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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
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
  return Math.min(0.1, Math.max(0.005, Math.round((span / 200) * 1000) / 1000));
}

/** Permafrost polygons with kind = extent class, v = typical percent of ground frozen, groundIce, landform, relict. */
export function normalizePermafrost(fc: FeatureCollection): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const extent = EXTENTS[String(p.EXTENT ?? "").trim()];
    if (extent === undefined || f.geometry === null) continue;
    const props: Record<string, string | number> = { kind: extent.kind, percent: extent.percent, v: extent.v };
    const ice = ICE[String(p.CONTENT ?? "").trim()];
    if (ice) props.groundIce = ice;
    const landform = LANDFORMS[String(p.LANDFORM ?? "").trim()];
    if (landform) props.landform = landform;
    if (String(p.RELICT ?? "").trim() === "yes") props.relict = "yes";
    out.push({ type: "Feature", geometry: f.geometry, properties: props });
  }
  return out;
}

const permafrost = defineLayer({
  id: "permafrost",
  title: "Permafrost zones",
  description:
    "Where the ground stays frozen year-round (permafrost) across the Northern Hemisphere: Alaska, Canada, Greenland, Russia, Mongolia, the Tibetan Plateau and high mountains, from the Circum-Arctic Map of Permafrost and Ground-Ice Conditions (International Permafrost Association). " +
    "Each polygon has kind, the share of the ground underlain by permafrost: 'continuous' (90-100%), 'discontinuous' (50-90%), 'sporadic' (10-50%) or 'isolated' (0-10%), with percent as text and v as a typical value (95, 70, 30 or 5); " +
    "groundIce (ice in the top 10-20 m: high, medium or low; high-ice ground slumps and sinks most when it thaws), landform, and relict ('yes' for old permafrost left from colder times). " +
    "Set canada to true to draw the Atlas of Canada permafrost map (Natural Resources Canada) as map tiles instead, which is more detailed for Canada but returns map tiles, not features. " +
    "Example questions: 'Is there permafrost under Fairbanks?', 'Where is the permafrost continuous in Alaska?', 'Which areas have ice-rich permafrost that could thaw?'. User words: permafrost, frozen ground, thawing ground. " +
    "Caveats: a broad 1:10,000,000 map compiled in the 1990s, so it shows zones, not whether a given lot is frozen, and it predates recent thaw; the polygons are a third-party copy whose licence is not stated. " +
    "Northern Hemisphere only (south of about 25°N returns nothing). Zoom in to under 5,000,000 km² first.",
  coverage: { bbox: [-180, 25, 180, 90] },
  license: "Unstated: a third-party ArcGIS copy of the IPA Circum-Arctic map (Brown et al., NSIDC, who ask for citation); Canada tiles Open Government Licence - Canada (NRCan)",
  requiredEnv: [],
  maxAreaKm2: 5_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("permafrost"), fillOpacity: 0.4 },

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
      cacheSuffix: "zones",
    });
    if (!res.ok) return { error: res.error, hint: "upstream" };
    const features = normalizePermafrost(res.fc);
    const capped = res.truncated || (res.fc as { properties?: { exceededTransferLimit?: unknown } }).properties?.exceededTransferLimit === true;
    const notes: string[] = [];
    if (capped) notes.push(`Showing the ${MAX_RECORDS} largest permafrost areas; zoom in for the small ones`);
    if (features.length === 0) notes.push("No permafrost mapped in this view");
    const data: FeatureCollection = { type: "FeatureCollection", features };
    return { kind: "geojson", data, citation, ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}) };
  },
});

registerLayer(permafrost);

export default permafrost;

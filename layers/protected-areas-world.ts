/**
 * Protected areas of the world: UNEP-WCMC / IUCN World Database on Protected Areas (WDPA, Protected Planet).
 * Service (verified live 2026-10-09, keyless ArcGIS MapServer, "protected areas only" view, WDPA v3.7):
 *   https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer
 *   layer 0 WDPA_point_latest, layer 1 WDPA_poly_latest. `export` draws PNG32 with transparency (a Sierra Nevada
 *   tile came back 40 KB: green terrestrial areas, blue marine ones, with outlines).
 * The layer returns a raster tile template and makes no upstream call; Mapbox fills {bbox-epsg-3857} per tile.
 * Notes: tiles are slow at low zoom (a z2 world quarter took 4.5 s), so minzoom is 3. License: Protected Planet allows
 * free non-commercial use only; commercial use needs a licence from UNEP-WCMC. The Protected Planet citation
 * wording is the service's own copyrightText.
 * Smoke through runLayer (2026-10-09): world bbox returns the tile template (200). Live tiles through the produced template:
 * Sierra Nevada z6 35 KB in 0.8 s, z3 23 KB in 3.0 s.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer";

/** Both the polygon (1) and point (0) sublayers: small reserves are only points in the database. */
export const WDPA_TILE_URL = mapServerExportTileUrl(SERVICE, { layers: "show:0,1" });

const protectedAreasWorld = defineLayer({
  id: "protected-areas-world",
  title: "Protected areas of the world",
  description:
    "World map of protected areas (national parks, nature reserves, wilderness, marine protected areas and similar) from the World Database on Protected Areas run by UNEP-WCMC and IUCN, drawn as map tiles: green for land and inland water, blue for ocean. " +
    "Use it for 'is this place protected', 'where are the parks and reserves in this country' or 'how much of this coast is a marine reserve', anywhere in the world, and as the global counterpart of the US-only public-lands and wilderness layers. " +
    "Caveats: it returns a picture on the map, not features you can list, count or click, so describe it only in general terms and do not name or measure individual areas from it. " +
    "It shows that an area is protected, not how strictly: a strict nature reserve and a multiple-use forest look alike. " +
    "Coverage depends on what each country reports, so a gap can mean the data is missing and not that the land is unprotected, and many small reserves are drawn only as dots. " +
    "Licence: free for non-commercial use only; commercial use needs permission from UNEP-WCMC, so say so when the user plans to use it commercially. " +
    "Tiles appear from about zoom level 3 (a continent view) and are slow to draw when zoomed far out. Works at any size of region.",
  coverage: "global",
  license: "Non-commercial use only (UNEP-WCMC and IUCN, Protected Planet terms); commercial use needs a licence",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("protected-areas-world") },

  async query(): Promise<LayerResult | LayerError> {
    return {
      kind: "tiles",
      data: { url: WDPA_TILE_URL, minzoom: 3, maxzoom: 14, format: "raster", tileSize: 256 },
      citation: {
        source:
          "UNEP-WCMC and IUCN, Protected Planet: The World Database on Protected Areas (WDPA), non-commercial use only",
        url: "https://www.protectedplanet.net/",
        retrieved: new Date().toISOString(),
      },
      coverageNote: "Free for non-commercial use only (UNEP-WCMC and IUCN); gaps may mean unreported areas, not unprotected land",
    };
  },
});

registerLayer(protectedAreasWorld);

export default protectedAreasWorld;

/**
 * FEMA National Flood Hazard Layer (NFHL): regulatory flood hazard zones.
 * Service (verified live 2026-10-09, keyless ArcGIS MapServer):
 *   https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer
 *   layer 28 "Flood Hazard Zones" (polygons, symbolised by FLD_ZONE and ZONE_SUBTY). Legend classes: 1% annual chance
 *   flood hazard (zones A, AE, AH, AO, V, VE; light blue), regulatory floodway (hatched), 0.2% annual chance (zone X
 *   shaded; orange), area of undetermined flood hazard (zone D), future conditions, and levee-related areas.
 * Notes from live requests: the layer has a scale threshold of about 1:36,000, so the service returns an empty
 * 886-byte tile below zoom 14 and data from zoom 14 (checked on Buffalo Bayou, Houston: z11 and z13 empty,
 * z14 4.9 KB, z15 6.6 KB). The source therefore starts at minzoom 14. Layers are chosen with layers=show:28.
 * The layer returns a raster tile template and makes no upstream call. Not every county has digital flood maps.
 * Smoke through runLayer (2026-10-09): Houston bbox returns the tile template (200); a European bbox returns an empty
 * result with the outside-the-US note. Live tiles through the produced template: Houston z14 4.9 KB, z16 8.0 KB.
 * Legend (2026-10-18): the colors FEMA draws, read from the service's own legend swatches (MapServer/legend, layer 28): 1% annual
 * chance #00E5FF (cyan at 30% alpha), floodway red hatch over it, 0.2% annual chance #FF8100, undetermined #F2E574, future
 * conditions grey hatch, levee areas black hatch over orange or yellow. The tiles draw as served (`raster: null`): the default
 * calming washed the pale cyan out on Topo.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { mapServerExportTileUrl } from "./_shared/arcgis-tiles";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const SERVICE = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";

export const FLOOD_ZONES_TILE_URL = mapServerExportTileUrl(SERVICE, { layers: "show:28" });

/** FEMA's own key, with the colors its tiles draw. */
export const FLOOD_ZONES_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Flood hazard zone",
  items: [
    { label: "1% annual chance flood (100-year; zones A, AE, AH, AO, V, VE)", color: "#00E5FF", symbol: "raster", help: "Flood insurance is usually required for buildings with a federally backed mortgage." },
    { label: "Regulatory floodway (red hatch)", color: "#FF0000", symbol: "raster", help: "The channel and nearby land that must be kept clear to carry the 1% flood." },
    { label: "0.2% annual chance flood (500-year; shaded zone X)", color: "#FF8100", symbol: "raster" },
    { label: "Area of undetermined flood hazard (zone D)", color: "#F2E574", symbol: "raster" },
    { label: "Future conditions 1% annual chance (grey hatch)", color: "#818181", symbol: "raster" },
    { label: "Area with reduced risk due to a levee (black hatch)", color: "#000000", symbol: "raster" },
  ],
  note: "Drawn only from about zoom 14 (street level); zoomed out the map shows nothing.",
};

const floodZones = defineLayer({
  id: "flood-zones",
  title: "FEMA flood zones",
  description:
    "FEMA's official flood hazard zones for the United States, from the National Flood Hazard Layer, drawn as map tiles in FEMA's own colors with its key as the legend: cyan is the 1% annual chance floodplain (the '100-year flood', zones A, AE, AH, AO, V and VE, where flood insurance is usually required), hatching marks the regulatory floodway (the channel that must stay clear), and orange is the 0.2% annual chance floodplain (the '500-year flood', zone X shaded). " +
    "Use it for 'floodplain', 'is this spot in a flood zone', 'flood risk for this campsite, trailhead or property', or to see which valleys and coasts flood. " +
    "Caveats: the tiles only appear when zoomed in to street or neighbourhood level (about zoom 14 and closer); zoomed out the map shows nothing, so tell the user to zoom in. " +
    "It is mapped flood hazard for regulation and insurance, not a forecast or a record of floods: places outside the zones can still flood, mountain flash floods and small creeks are often unmapped, and not every county has digital flood maps, so a blank area can mean no study. " +
    "Returns map tiles drawn on the globe, not features you can count or list, so describe what you see only in general terms and do not give a zone for an exact address; point the user to FEMA's Flood Map Service Center for that. " +
    "Covers the 50 states, DC and Puerto Rico; outside them the result is empty.",
  coverage: "us",
  surface: "land",
  license: "Public domain (FEMA)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  // FEMA's colors as served: the default raster calming made the pale 1% cyan vanish on Topo.
  style: { geometry: "polygon", color: layerColor("flood-zones"), raster: null },
  legend: FLOOD_ZONES_LEGEND,
  // The current effective flood maps: no time panel.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "FEMA National Flood Hazard Layer, Flood Hazard Zones (public domain)",
      url: "https://www.fema.gov/flood-maps/national-flood-hazard-layer",
      retrieved: new Date().toISOString(),
    };
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }
    return {
      kind: "tiles",
      data: { url: FLOOD_ZONES_TILE_URL, minzoom: 14, maxzoom: 18, format: "raster", tileSize: 256 },
      citation,
      coverageNote: "Flood zones draw only when zoomed in to about zoom 14 or closer; zoom in to see them",
    };
  },
});

registerLayer(floodZones);

export default floodZones;

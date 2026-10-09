/**
 * Public land ownership from the USGS Protected Areas Database of the United States (PAD-US 4.1), served as
 * Mapbox vector tiles from WildMap's own bucket:
 *   https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf
 * Facts from decoding live tiles on 2026-10-09 (z3 to z12 across CA, WY, CO, TX, FL, TN, DC, AK, HI):
 *   - One source layer, `padus`, polygons only (40,371 features sampled, every one a polygon).
 *   - Tiles exist at z3 to z12; z0 to z2 and z13+ answer 404. Mapbox overzooms z12 past that.
 *   - The bucket stores them gzipped and serves them gunzipped to clients that do not send
 *     Accept-Encoding: gzip (header `x-goog-stored-content-encoding: gzip`); browsers get gzip and inflate it.
 *   - Properties are simplified from PAD-US, not the raw `Mang_Type` / `Own_Type` / `Unit_Nm` / `Des_Tp` columns:
 *       name         unit name (raw Unit_Nm), e.g. "Plumas National Forest"
 *       agency       manager abbreviation (raw Mang_Name), missing on about 7% of features. Values seen:
 *                    federal USFS, BLM, FWS, NPS, USACE, USBR, DOE, TVA, ARS, DOD, NRCS; state "State",
 *                    "State Parks"; "Local"; "NGO" (private nonprofits); "Tribal"
 *       designation  readable designation (raw Des_Tp), e.g. "National Forest", "Wilderness Area", "Local Park",
 *                    "Private Conservation Land"; private parcels usually have no agency, only a "Private ..." designation
 *       access       open | restricted | closed | unknown (raw Pub_Access)
 *       category     protected_area | wilderness | state_park | nature_reserve | managed_forest | national_park | national_monument
 *   The map draws these polygons as a gray ink tint (not colored by manager); see landFillOpacity in components/mapTiles.ts.
 * No upstream call is made by the layer: it only hands the tile URL to the map.
 */
import { z } from "zod";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";

export const PADUS_TILE_URL = "https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf";
export const PADUS_SOURCE_LAYER = "padus";

const publicLands = defineLayer({
  id: "public-lands",
  title: "Public land ownership",
  description:
    "Who owns and manages land across the United States, from the USGS Protected Areas Database (PAD-US 4.1), drawn as tinted areas with white outlines. " +
    "Colors show the manager: National Park Service dark green, Forest Service olive green, BLM tan, Fish and Wildlife Service teal, state land and state parks blue, " +
    "wilderness areas deep green whoever manages them, and every other manager (other federal land such as the Bureau of Reclamation, Army Corps or military; local, tribal, " +
    "and private conservation land held by land trusts and other nonprofits) lavender. The tint fades as the map zooms in so trails stay readable. " +
    "PAD-US combines a Fee layer (who holds title) with Designation and Easement layers (wilderness areas, roadless areas, recreation areas, conservation easements), " +
    "so one place can carry several overlapping polygons, for example a wilderness area inside a national forest. " +
    "Each area has a name, a manager, a designation and a coarse public-access flag (open, restricted, closed, unknown). " +
    "Use it to show public land ownership on the map so the user can see where national forest, BLM, park, or state land lies; the model itself cannot read the map. " +
    "Caveats: this is ownership and management, not access rules. It does not say whether camping, hunting, fires, drones or vehicles are allowed, " +
    "private land outside the database is simply not drawn, and boundaries are approximate at parcel scale; check the managing agency before relying on it. " +
    "United States only. Returns map tiles drawn on the globe, not features you can count or list. You cannot see the rendered map: say the layer is shown and what each color means, but do not claim which land lies where. " +
    "Works at any size of region, from a whole state down to a single valley.",
  coverage: "us",
  license: "Public domain (USGS PAD-US 4.1)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: "#B9A6FF", fillOpacity: 0.28 },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Outside the US the tiles are simply empty, so they are returned anyway along with the note.
    return {
      kind: "tiles",
      data: {
        url: PADUS_TILE_URL,
        minzoom: 3,
        maxzoom: 12,
        format: "vector",
        sourceLayer: PADUS_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source: "U.S. Geological Survey Gap Analysis Project, Protected Areas Database of the United States (PAD-US) 4.1 (public domain)",
        url: "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview",
        retrieved: new Date().toISOString(),
      },
      ...(outsideUs(ctx.bbox) && { coverageNote: OUTSIDE_US_NOTE }),
    };
  },
});

registerLayer(publicLands);

export default publicLands;

import type { Basemap } from "@/lib/render/state";

const OUTDOORS_STYLE = "mapbox://styles/mapbox/outdoors-v12";
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

/** Mapbox style URL for a basemap. Natural Earth 2 falls back to Outdoors until its Studio style is set. */
export function basemapStyleUrl(b: Basemap): string {
  switch (b) {
    case "outdoors":
      return OUTDOORS_STYLE;
    case "satellite":
      return SATELLITE_STYLE;
    case "natural-earth-2":
      // Literal `process.env.NEXT_PUBLIC_*` access so Next inlines it into the client bundle.
      return process.env.NEXT_PUBLIC_NATURAL_EARTH_STYLE?.trim() || OUTDOORS_STYLE;
  }
}

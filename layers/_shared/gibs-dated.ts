/**
 * The tile answer for a NASA GIBS WMTS layer that follows the time scrubber: picks the day (clamped to what GIBS
 * has published), builds the tile URL and the `data.time` template. No network call is made.
 */
import type { LayerError, LayerResult, TileTime } from "../types";
import { gibsTileUrl } from "./gibs";
import { dateNote, resolveTileDate } from "./dated-tiles";

export type GibsDatedSpec = {
  /** GIBS layer identifier. */
  gibsId: string;
  /** GoogleMapsCompatible level: the finest zoom the layer is published at. */
  level: number;
  /** First day (YYYY-MM-DD) in the GIBS time dimension. */
  from: string;
  /** Last day when the archive has ended. */
  to?: string;
  /** Days behind today the newest reliably processed day sits. */
  daysBack: number;
  cadence: TileTime["cadence"];
  /** Plural noun for messages and the coverage note, e.g. "snow cover". */
  label: string;
  citationSource: string;
};

export function gibsDatedResult(spec: GibsDatedSpec, requested: string | undefined, now: number = Date.now()): LayerResult | LayerError {
  const choice = resolveTileDate(
    requested,
    { from: spec.from, to: spec.to, latestOffsetDays: -spec.daysBack, label: spec.label },
    now,
  );
  if (!choice.ok) return { error: choice.error };
  return {
    kind: "tiles",
    data: {
      url: gibsTileUrl(spec.gibsId, choice.date, spec.level),
      minzoom: 0,
      maxzoom: spec.level,
      format: "raster",
      time: {
        template: gibsTileUrl(spec.gibsId, "{date}", spec.level),
        cadence: spec.cadence,
        from: spec.from,
        ...(spec.to !== undefined && { to: spec.to }),
        daysBack: spec.daysBack,
      },
    },
    citation: { source: spec.citationSource, url: "https://earthdata.nasa.gov/gibs", retrieved: new Date(now).toISOString() },
    coverageNote: dateNote(spec.label.charAt(0).toUpperCase() + spec.label.slice(1), choice.date, choice.note),
  };
}

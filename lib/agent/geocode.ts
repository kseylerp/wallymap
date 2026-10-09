import { z } from "zod";
import type { BBox } from "@/layers/types";
import { featureBBoxes, findRegion, loadNaturalEarthRegions, regionDisplayName } from "./naturalEarth";

const ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";
const FALLBACK_HALF_SPAN_DEG = 0.1;
/** A Mapbox bbox narrower than this in both axes is a town or point, too small to be a named region such as a mountain range. */
const SMALL_BBOX_DEG = 0.5;

export type GeocodeResult = {
  bbox: BBox;
  center: [number, number];
  name: string;
  /** "natural-earth" when the place is a physical region (range, desert, ...) and Mapbox only found a point or town. */
  source: "mapbox" | "natural-earth";
};
export type GeocodeError = { error: string };

const featureSchema = z.object({
  properties: z.object({
    name: z.string().optional(),
    full_address: z.string().optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    coordinates: z.object({ longitude: z.number(), latitude: z.number() }),
  }),
});

const responseSchema = z.object({ features: z.array(z.unknown()) });

/** How long a failed Natural Earth download is remembered, so lookups during an outage do not each wait out the timeout. */
const REGIONS_RETRY_AFTER_MS = 60_000;
let failedAt: number | undefined;

function isSmall(bbox: BBox): boolean {
  return bbox[2] - bbox[0] < SMALL_BBOX_DEG && bbox[3] - bbox[1] < SMALL_BBOX_DEG;
}

/** The Natural Earth region named `place`, as a geocode result, or null when there is none or the download fails. */
async function regionResult(place: string): Promise<GeocodeResult | null> {
  if (failedAt !== undefined && Date.now() - failedAt < REGIONS_RETRY_AFTER_MS) return null;
  try {
    const fc = await loadNaturalEarthRegions();
    const region = findRegion(place, fc);
    if (!region) return null;
    const bbox = featureBBoxes(fc)[fc.features.indexOf(region)];
    if (!bbox || !bbox.every(Number.isFinite)) return null;
    return {
      bbox,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      name: regionDisplayName(region),
      source: "natural-earth",
    };
  } catch {
    failedAt = Date.now();
    return null;
  }
}

/**
 * Forward-geocodes a place name with Mapbox Geocoding v6. Never throws. `proximity` ([lng, lat]) biases the
 * match toward that point, so "Emerald Bay" next to Tahoe City is not Laguna Beach's Emerald Bay.
 */
export async function geocode(
  place: string,
  opts: { proximity?: [number, number] } = {},
): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return { error: "MAPBOX_TOKEN is not set" };
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", place);
  url.searchParams.set("limit", "1");
  if (opts.proximity) url.searchParams.set("proximity", `${opts.proximity[0]},${opts.proximity[1]}`);
  url.searchParams.set("access_token", token);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { error: `Geocoding failed with HTTP ${res.status}` };
    }
    const body = responseSchema.safeParse(await res.json());
    if (!body.success || body.data.features.length === 0) {
      return { error: `No match for ${place}` };
    }
    const feature = featureSchema.safeParse(body.data.features[0]);
    if (!feature.success) {
      return { error: `No match for ${place}` };
    }

    const { name, full_address, bbox, coordinates } = feature.data.properties;
    const center: [number, number] = [coordinates.longitude, coordinates.latitude];

    // Mapbox answers "the Andes" or "Sierra Nevada" with a town or a point; a named physical region is better.
    if (bbox === undefined || isSmall(bbox)) {
      const region = await regionResult(place);
      if (region) return region;
    }

    return {
      bbox: bbox ?? [
        center[0] - FALLBACK_HALF_SPAN_DEG,
        center[1] - FALLBACK_HALF_SPAN_DEG,
        center[0] + FALLBACK_HALF_SPAN_DEG,
        center[1] + FALLBACK_HALF_SPAN_DEG,
      ],
      center,
      name: full_address ?? name ?? place,
      source: "mapbox",
    };
  } catch (err) {
    return { error: `Geocoding failed: ${String(err)}` };
  }
}

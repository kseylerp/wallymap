import { z } from "zod";
import type { BBox } from "@/layers/types";

const ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";
const FALLBACK_HALF_SPAN_DEG = 0.1;

export type GeocodeResult = { bbox: BBox; center: [number, number]; name: string };
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

/** Forward-geocodes a place name with Mapbox Geocoding v6. Never throws. */
export async function geocode(place: string): Promise<GeocodeResult | GeocodeError> {
  const token = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return { error: "MAPBOX_TOKEN is not set" };
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", place);
  url.searchParams.set("limit", "1");
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
    return {
      bbox: bbox ?? [
        center[0] - FALLBACK_HALF_SPAN_DEG,
        center[1] - FALLBACK_HALF_SPAN_DEG,
        center[0] + FALLBACK_HALF_SPAN_DEG,
        center[1] + FALLBACK_HALF_SPAN_DEG,
      ],
      center,
      name: full_address ?? name ?? place,
    };
  } catch (err) {
    return { error: `Geocoding failed: ${String(err)}` };
  }
}

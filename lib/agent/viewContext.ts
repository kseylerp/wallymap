import { z } from "zod";
import { BBoxSchema } from "@/layers/types";
import type { MapView } from "@/lib/agent/view";

/** The `view` a chat request may carry (lib/agent/view.ts); anything else is ignored, never an error. */
export const MapViewSchema = z.object({
  bbox: BBoxSchema.nullable(),
  zoom: z.number().min(0).max(24),
  center: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  // A label for the area, one line and short: it goes into the system prompt.
  placeName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\r\n]*$/)
    .optional(),
});

/** The request's map view, or null when it is missing or malformed. */
export function parseMapView(raw: unknown): MapView | null {
  const parsed = MapViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const KM_PER_DEGREE = 111.32;

/** The view's width in km at its middle latitude, rounded to a figure worth saying. */
function widthKm([w, s, e, n]: [number, number, number, number]): number {
  const km = (e - w) * KM_PER_DEGREE * Math.cos((((s + n) / 2) * Math.PI) / 180);
  if (km < 10) return Math.max(1, Math.round(km));
  if (km < 100) return Math.round(km / 5) * 5;
  return Math.round(km / 50) * 50;
}

/** The per-turn system note describing what the user is looking at. */
export function viewSystemMessage(view: MapView): string {
  const zoom = Math.round(view.zoom * 10) / 10;
  const place = view.placeName ? `, showing ${JSON.stringify(view.placeName)}` : "";
  if (!view.bbox) {
    return (
      `Current map view: the whole globe (zoom ${zoom}${place}), so there is no bbox for "here". ` +
      "Geocode the place the user names; if they name none, ask which area they mean."
    );
  }
  return (
    `Current map view: bbox [${view.bbox.join(", ")}] (zoom ${zoom}, about ${widthKm(view.bbox)} km across${place}). ` +
    "When the user says here, this area, on screen, around me, in view, or names no place, use this bbox directly: " +
    "do not geocode, and do not call set_view."
  );
}

/** The system prompt for one turn: the fixed prompt plus, when the request sent one, the current view. */
export function systemForTurn(base: string, view: MapView | null): string {
  return view ? `${base}\n\n${viewSystemMessage(view)}` : base;
}

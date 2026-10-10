import { z } from "zod";
import { BBoxSchema, bboxAreaKm2 } from "@/layers/types";
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

/** The view's area in km², to two significant figures (417,205 reads as 420,000). */
function areaKm2(bbox: [number, number, number, number]): number {
  const area = bboxAreaKm2(bbox);
  if (area < 10) return Math.max(1, Math.round(area));
  const step = 10 ** (Math.floor(Math.log10(area)) - 1);
  return Math.round(area / step) * step;
}

/** The per-turn system note describing what the user is looking at. */
export function viewSystemMessage(view: MapView): string {
  const zoom = Math.round(view.zoom * 10) / 10;
  const place = view.placeName ? `, showing ${JSON.stringify(view.placeName)}` : "";
  if (!view.bbox) {
    return (
      `Current map view: the whole globe (zoom ${zoom}${place}), so there is no bbox for "here". ` +
      "Geocode the place the user names, call set_view to its bbox so the camera moves there, then query; if they name none, ask which area they mean."
    );
  }
  return (
    `Current map view: bbox [${view.bbox.join(", ")}] (zoom ${zoom}, about ${widthKm(view.bbox)} km across${place}). ` +
    "When the user says here, this area, on screen, around me, in view, or names no place, use this bbox directly: " +
    "do not geocode, and do not call set_view. " +
    "When the user names a place instead, ignore this bbox: geocode the place and call set_view to its bbox before you query, so the camera moves to the place they asked about. " +
    `This view covers about ${areaKm2(view.bbox).toLocaleString("en-US")} km²; a layer with a smaller km² limit returns a zoom_in error for it, ` +
    "and then you ask the user to zoom in or name a place instead of shrinking this bbox."
  );
}

/** The system prompt for one turn: the fixed prompt plus, when the request sent one, the current view. */
export function systemForTurn(base: string, view: MapView | null): string {
  return view ? `${base}\n\n${viewSystemMessage(view)}` : base;
}

import type { UIMessage } from "ai";
import { compactMessages } from "@/lib/agent/compactMessages";
import type { BBox } from "@/layers/types";

/**
 * What the map shows when a chat message is sent, so the agent can answer "what is here" from the screen. `bbox` is
 * [west, south, east, north] of the part of the map nobody has covered, or null when the camera is out at the globe
 * (where "here" means nothing and the agent should geocode instead).
 */
export type MapView = {
  bbox: BBox | null;
  zoom: number;
  center: [lon: number, lat: number];
  placeName?: string;
};

/** Below this zoom the whole globe is on screen, so the view sends no bbox. */
export const GLOBE_ZOOM = 3;

/** Keeps a longitude within 180° of `ref`, so a box that crosses the antimeridian stays contiguous. */
function unwrapNear(lng: number, ref: number): number {
  return ref + ((((lng - ref + 180) % 360) + 360) % 360) - 180;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

type CameraSample = {
  center: [number, number];
  zoom: number;
  /** Map points under the corners and edge midpoints of the uncovered part of the screen. */
  points: [number, number][];
  /** The map's own visible bounds (`map.getBounds()`), which caps points a pitched camera puts past the horizon. */
  bounds?: BBox | null;
};

/**
 * The view for the chat request from a camera sample. The box is the smallest one holding every sample point,
 * trimmed to the map's own bounds and to ±180°/±85°; a box that would wrap the whole world becomes null.
 */
export function viewFromCamera({ center, zoom, points, bounds }: CameraSample): MapView {
  const view: MapView = { bbox: null, zoom: round(zoom, 2), center: [round(center[0], 5), round(center[1], 5)] };
  if (zoom < GLOBE_ZOOM || points.length === 0) return view;
  const lngs = points.map(([lng]) => unwrapNear(lng, center[0]));
  const lats = points.map(([, lat]) => lat);
  let west = Math.min(...lngs);
  let east = Math.max(...lngs);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  if (bounds) {
    west = Math.max(west, unwrapNear(bounds[0], center[0]));
    east = Math.min(east, unwrapNear(bounds[2], center[0]));
    south = Math.max(south, bounds[1]);
    north = Math.min(north, bounds[3]);
  }
  if (!(east - west < 360) || !(east > west) || !(north > south)) return view;
  // A box across the antimeridian keeps the side the camera is on (layer bboxes cannot wrap).
  west = Math.max(west, -180);
  east = Math.min(east, 180);
  south = Math.max(south, -85);
  north = Math.min(north, 85);
  if (!(east > west) || !(north > south)) return view;
  view.bbox = [round(west, 4), round(south, 4), round(east, 4), round(north, 4)];
  return view;
}

type SendRequest = {
  id: string;
  messages: UIMessage[];
  body: object | undefined;
  trigger: string;
  messageId: string | undefined;
};

/**
 * The chat request body: earlier query results resent as summaries (the map already has the full data and the
 * route caps request size), plus the current map view. The view rides beside the messages, never inside them, so
 * later turns do not resend old views.
 */
export function buildChatBody({ id, messages, body, trigger, messageId }: SendRequest, view: MapView | null) {
  return {
    ...body,
    id,
    messages: compactMessages(messages),
    trigger,
    messageId,
    ...(view ? { view } : {}),
  };
}

/**
 * Units and name matching shared by the peaks and lakes layers (no layer registers here): whether a view is in the United States,
 * so its cards give feet, acres and square miles first (docs/layer-contract.md, display), heights in both units, and the name key
 * the two layers join OpenStreetMap and Wikidata on.
 */
import type { Position } from "geojson";
import type { BBox } from "./types";

export const FT_PER_M = 1 / 0.3048;

/**
 * Rough northern and southern borders of the lower 48 as [lon, lat] polylines (west to east), close enough to choose which unit
 * a card shows first. Alaska and Hawaii are boxes.
 */
const US_NORTH: [number, number][] = [
  [-124.8, 49], [-95.2, 49], [-89.6, 48], [-84.4, 46.5], [-82.5, 45.3], [-82.4, 42.9], [-81, 42.3], [-79.1, 42.6], [-78.9, 43.4],
  [-76.3, 44.2], [-74.7, 45], [-71.5, 45], [-70, 46.4], [-69.2, 47.45], [-67.8, 47.1], [-67, 45], [-66.9, 44.8],
];
const US_SOUTH: [number, number][] = [
  [-124.8, 32.53], [-117.1, 32.53], [-114.7, 32.7], [-111.07, 31.33], [-108.2, 31.33], [-108.2, 31.78], [-106.5, 31.78],
  [-104.5, 29.6], [-103.2, 28.97], [-102.4, 29.77], [-101, 29.5], [-100.3, 28.3], [-99.5, 27.5], [-98.8, 26.35], [-98.25, 26.05], [-97.5, 25.84], [-97.15, 25.84], [-80.5, 24.4], [-66.9, 24.4],
];

function borderLat(line: [number, number][], lon: number): number {
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    if (lon <= x1) return x1 === x0 ? Math.min(y0, y1) : y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0);
  }
  return line[line.length - 1][1];
}

/** Whether a [lon, lat] lies in the United States (rough borders, good to a few tens of km). */
export function inUnitedStates([lon, lat]: Position): boolean {
  if (lon >= -124.8 && lon <= -66.9) return lat <= borderLat(US_NORTH, lon) && lat >= borderLat(US_SOUTH, lon);
  if (lon >= -170 && lon <= -129.9 && lat >= 51 && lat <= 71.5) return lon <= -141 || lat <= 60.3;
  return lon >= -161 && lon <= -154.5 && lat >= 18.5 && lat <= 22.5;
}

/** US units first for a view centred in the United States (docs/layer-contract.md, display), metric first elsewhere. */
export function usUnitsFirst(bbox: BBox): boolean {
  return inUnitedStates([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
}

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** A height in metres as "14,440 ft (4,401 m)" (US first) or "4,401 m (14,440 ft)". */
export function heightText(m: number, usFirst: boolean): string {
  const ft = `${whole(m * FT_PER_M)} ft`;
  const metric = `${whole(m)} m`;
  return usFirst ? `${ft} (${metric})` : `${metric} (${ft})`;
}

/** A name for matching: lower case, "Mt." and "Mt" read as "Mount", punctuation and doubled spaces dropped. */
export function matchName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bmt\.?(?=\s)/g, "mount")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

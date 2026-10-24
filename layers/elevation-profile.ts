/**
 * Elevation profile (cross-section) along a straight line from A to B, computed by this app from AWS Terrain Tiles
 * (Mapzen Terrarium PNGs on S3, open data, no key; USGS 3DEP about 10 m in the US, SRTM about 30 m elsewhere), through
 * lib/terrain/profile.ts: the ground's height every 10 to 30 m along the line, the climb and descent, the highest and
 * lowest ground, and the steepest 100 m. One LineString answers, carrying the facts on its card and the profile itself
 * (distances and elevations) for the cross-section chart under the map (components/CrossSection.tsx).
 *
 * Unlike a route's profile it needs no trail: "elevation cross-section from Yosemite Valley to the top of Half Dome" is
 * the ground under a straight line between the two geocoded places, not the walk.
 * Live 2026-10-23 (through runLayer): Yosemite Valley (-119.5934, 37.7456) to Half Dome (-119.5332, 37.7459), 5.3 km
 * sampled every 10 m at zoom 14 in 0.4 s: 3,980 ft (1,213 m) to 8,826 ft (2,690 m), climbing about 4,900 ft; the
 * steepest 100 m is the face, over 60° (Half Dome's surveyed summit is 8,839 ft / 2,694 m).
 */
import { z } from "zod";
import type { Position } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { FT_PER_M, heightText, usUnitsFirst } from "./peaks-units";
import { crossSection, pathLengthM, type CrossSection } from "@/lib/terrain/profile";
import { TERRAIN_CITATION_SOURCE, TERRAIN_CITATION_URL } from "@/lib/terrain/dem";
import { verticalExaggeration } from "@/lib/render/crossSection";
import { layerColor } from "@/lib/render/palette";
import { geocode, type GeocodeError, type GeocodeResult } from "@/lib/agent/geocode";

/** The longest line profiled: past this the samples thin out to the coarse tiles and a cross-section stops meaning much. */
export const MAX_LENGTH_KM = 200;
const M_PER_MI = 1609.344;

const place = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  name: z.string().max(80).optional().describe("the place's name as the user said it, e.g. 'Half Dome'"),
});

const input = z.object({
  from: place.optional().describe("where the line starts: the first place's lon and lat from geocode, and its name"),
  to: place.optional().describe("where the line ends: the second place's lon and lat from geocode, and its name"),
  points: z
    .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
    .min(2)
    .max(20)
    .optional()
    .describe("instead of from and to: a short list of [lon, lat] points the line runs through, in order"),
});

type Input = z.infer<typeof input>;

const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const miles = (m: number) => (m / M_PER_MI).toLocaleString("en-US", { maximumFractionDigits: m < 16_000 ? 1 : 0 });
const km = (m: number) => (m / 1000).toLocaleString("en-US", { maximumFractionDigits: m < 10_000 ? 1 : 0 });

/** "3.3 mi (5.3 km)" or "5.3 km (3.3 mi)". */
function distanceText(m: number, usFirst: boolean): string {
  return usFirst ? `${miles(m)} mi (${km(m)} km)` : `${km(m)} km (${miles(m)} mi)`;
}

/** "2.9 mi" or "4.6 km": how far along the line. */
function alongText(m: number, usFirst: boolean): string {
  return usFirst ? `${miles(m)} mi` : `${km(m)} km`;
}

/** The facts of a cross-section as the card, the note and the chart read them. */
export function profileProperties(cs: CrossSection, names: { start?: string; end?: string }, usFirst: boolean): Record<string, unknown> {
  const start = names.start ?? "the start";
  const ve = verticalExaggeration(cs.lengthM, cs.high.m - cs.low.m);
  const st = cs.steepest;
  const steepestText = st
    ? `${st.deg}° (${whole(st.gradePct)}% grade) over ${whole(st.toM - st.fromM)} m, about ${alongText((st.fromM + st.toM) / 2, usFirst)} from ${start}, ${st.direction}`
    : undefined;
  // The first twenty keys are the ones the model's summary keeps: the words first, the arrays last.
  return {
    name: names.start && names.end ? `${names.start} to ${names.end}` : "Elevation profile",
    ...(names.start && { startName: names.start }),
    ...(names.end && { endName: names.end }),
    lengthText: distanceText(cs.lengthM, usFirst),
    startText: heightText(cs.startM, usFirst),
    endText: heightText(cs.endM, usFirst),
    highestText: `${heightText(cs.high.m, usFirst)}, ${alongText(cs.high.atM, usFirst)} from ${start}`,
    lowestText: `${heightText(cs.low.m, usFirst)}, ${alongText(cs.low.atM, usFirst)} from ${start}`,
    climbText: heightText(cs.climbM, usFirst),
    descentText: heightText(cs.descentM, usFirst),
    ...(steepestText && { steepestText }),
    startElevationM: cs.startM,
    startElevationFt: Math.round(cs.startM * FT_PER_M),
    endElevationM: cs.endM,
    endElevationFt: Math.round(cs.endM * FT_PER_M),
    highestM: cs.high.m,
    highestFt: Math.round(cs.high.m * FT_PER_M),
    climbM: cs.climbM,
    climbFt: Math.round(cs.climbM * FT_PER_M),
    ...(st && { steepestDeg: st.deg, steepestGradePct: st.gradePct }),
    lengthKm: Math.round(cs.lengthM / 100) / 10,
    lengthMi: Math.round(cs.lengthM / M_PER_MI / 0.1) / 10,
    descentM: cs.descentM,
    descentFt: Math.round(cs.descentM * FT_PER_M),
    lowestM: cs.low.m,
    lowestFt: Math.round(cs.low.m * FT_PER_M),
    highestAtM: cs.high.atM,
    ...(st && { steepestFromM: st.fromM, steepestToM: st.toM, steepestDirection: st.direction, steepestAt: st.at }),
    verticalExaggeration: ve,
    sampleSpacingM: cs.stepM,
    route: true,
    profileDistancesM: cs.distancesM,
    profileElevationsM: cs.elevationsM.map((e) => (Number.isNaN(e) ? null : e)),
  };
}

/** The coverage note: every number the answer should quote, in one place. */
export function profileNote(cs: CrossSection, names: { start?: string; end?: string }, usFirst: boolean): string {
  const start = names.start ?? "the start";
  const end = names.end ?? "the end";
  const st = cs.steepest;
  const parts = [
    `Straight line from ${start} to ${end}, ${distanceText(cs.lengthM, usFirst)}: starts at ${heightText(cs.startM, usFirst)} and ends at ${heightText(cs.endM, usFirst)}`,
    `highest ${heightText(cs.high.m, usFirst)} at ${alongText(cs.high.atM, usFirst)} from ${start}, lowest ${heightText(cs.low.m, usFirst)}`,
    `climbs ${heightText(cs.climbM, usFirst)} and descends ${heightText(cs.descentM, usFirst)} along the line`,
    ...(st
      ? [`steepest ${whole(st.toM - st.fromM)} m: ${st.deg}° (${whole(st.gradePct)}% grade), ${st.direction}, about ${alongText((st.fromM + st.toM) / 2, usFirst)} from ${start}`]
      : []),
    `sampled every ${cs.stepM} m from the elevation model (about 10 m in the US, 30 m elsewhere), so a cliff shorter than that reads gentler`,
    `the chart under the map draws it at about ×${verticalExaggeration(cs.lengthM, cs.high.m - cs.low.m)} vertical exaggeration`,
    "this is the ground under a straight line, not a trail: a walking route is longer and gentler",
  ];
  return parts.join("; ");
}

/** The line to profile from the input: `points`, else `from` and `to`. */
export function pathOf(input: Input): { path: Position[]; start?: string; end?: string } | null {
  if (input.points && input.points.length >= 2) return { path: input.points };
  if (input.from && input.to) return { path: [[input.from.lon, input.from.lat], [input.to.lon, input.to.lat]], start: input.from.name, end: input.to.name };
  return null;
}

/** How far an end may sit from its named place (outside the place's box) before the name's own location replaces it. */
export const END_TOLERANCE_M = 1_500;

function metresBetween([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

function inBox([lon, lat]: Position, [w, s, e, n]: BBox, padDeg = 0.005): boolean {
  return lon >= w - padDeg && lon <= e + padDeg && lat >= s - padDeg && lat <= n + padDeg;
}

type Locate = (name: string, near: [number, number]) => Promise<GeocodeResult | GeocodeError>;

/**
 * The line's ends checked against their names: an end whose name the geocoder places somewhere else (more than
 * END_TOLERANCE_M from the coordinate and the coordinate outside the place's box) moves to the place. The model passed
 * "Yosemite Valley" at a point on Half Dome's shoulder, 6,044 ft and 0.3 mi from the summit, while the valley floor is
 * near 4,000 ft (2026-10-23). Returns the ends to use and one clause per moved end for the note.
 */
export async function checkEnds(input: Input, locate: Locate = (name, near) => geocode(name, { proximity: near })): Promise<{ input: Input; moved: string[] }> {
  if (input.points || !input.from || !input.to) return { input, moved: [] };
  const moved: string[] = [];
  const fix = async (end: NonNullable<Input["from"]>, other: NonNullable<Input["from"]>) => {
    if (!end.name) return end;
    const found = await locate(end.name, [other.lon, other.lat]).catch(() => ({ error: "geocoder failed" }) as GeocodeError);
    if ("error" in found) return end;
    const given: Position = [end.lon, end.lat];
    if (inBox(given, found.bbox) || metresBetween(given, found.center) <= END_TOLERANCE_M) return end;
    moved.push(`${end.name} placed at its geocoded centre (${found.center[1].toFixed(4)}, ${found.center[0].toFixed(4)}), not at the point given`);
    return { ...end, lon: found.center[0], lat: found.center[1] };
  };
  const from = await fix(input.from, input.to);
  const to = await fix(input.to, from);
  return { input: { ...input, from, to }, moved };
}

const elevationProfile = defineLayer({
  id: "elevation-profile",
  title: "Elevation profile (cross-section)",
  description:
    "The shape of the land along a straight line from one place to another: an elevation cross-section computed by this app from an elevation model (AWS Terrain Tiles: USGS 3DEP about 10 m in the US, SRTM about 30 m elsewhere), sampled every 10 to 30 m. " +
    "Use it for 'elevation cross-section from A to B', 'elevation profile from A to B', 'how steep is it from A to B', 'how much do you climb from the valley to the summit'. " +
    "Geocode both places first and pass their lon and lat as from and to with their names (or points, a short list of [lon, lat] for a line with bends); the bbox only needs to hold the line. " +
    "It returns one line whose card and properties give startText and endText (elevations with feet and metres), highestText, lowestText, climbText and descentText, lengthText, steepestText (the steepest 100 m in degrees and percent grade, where along the line, climbing or descending), " +
    "and the profile (profileDistancesM, profileElevationsM) the chart under the map draws, with the vertical exaggeration stated. " +
    "Its coverageNote has every number: quote the start and top elevations, the climb, and the steepest part. " +
    "It is the ground under a straight line, not a trail: for the walking route use route; for a trail's own profile, preview the trail. Lines up to 200 km. Topographical basemap.",
  coverage: "global",
  surface: "any",
  license: "Open data: AWS Terrain Tiles (Mapzen) from USGS 3DEP (public domain), SRTM (public domain), GMTED2010 and ETOPO1; attribution to Mapzen and the sources",
  requiredEnv: [],
  // The line, not the box, is what is read: any box answers.
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input,
  style: { geometry: "line", color: layerColor("elevation-profile"), basemap: "outdoors" },
  time: { shape: "none" },
  legend: {
    kind: "symbol",
    items: [{ label: "Line of the cross-section", symbol: "line" }],
    note: "The chart under the map draws the ground along this line; hover it to find a point on the line.",
  },
  card: {
    measure: { key: "climbText", label: "Climb" },
    facts: [
      { key: "startText", label: "Start" },
      { key: "highestText", label: "Top" },
      { key: "endText", label: "End" },
      { key: "steepestText", label: "Steepest" },
      { key: "descentText", label: "Descent" },
      { key: "lowestText", label: "Lowest" },
      { key: "lengthText", label: "Length" },
    ],
    hidden: [
      "startName", "endName", "startElevationM", "startElevationFt", "endElevationM", "endElevationFt", "highestM", "highestFt", "climbM", "climbFt",
      "steepestDeg", "steepestGradePct", "lengthKm", "lengthMi", "descentM", "descentFt", "lowestM", "lowestFt", "highestAtM", "steepestFromM", "steepestToM",
      "steepestDirection", "steepestAt", "verticalExaggeration", "sampleSpacingM", "route", "profileDistancesM", "profileElevationsM",
    ],
  },
  fieldHelp: {
    climbText: { text: "Total climb along the line from start to end, counting rises past 3 m so the model's noise on flat ground does not add up.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    steepestText: { text: "The steepest stretch of about 100 m along the line: rise over run as degrees and percent grade (100% is 45°).", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    startText: { text: "Height of the ground at the line's start, from the elevation model.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    endText: { text: "Height of the ground at the line's end, from the elevation model.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
    highestText: { text: "The highest ground along the line and how far from the start it is.", source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL },
  },

  async query(ctx, given): Promise<LayerResult | LayerError> {
    const { input: raw, moved } = await checkEnds(given);
    const line = pathOf(raw);
    if (!line) return { error: "Give the line's two ends (from and to, each a lon and lat from geocode) or at least two points" };
    const lengthM = pathLengthM(line.path);
    if (lengthM < 50) return { error: "The two ends are under 50 m apart; give two different places" };
    if (lengthM > MAX_LENGTH_KM * 1000) return { error: `The line is ${whole(lengthM / 1000)} km long; profiles run up to ${MAX_LENGTH_KM} km` };
    const lons = line.path.map((p) => p[0]);
    const lats = line.path.map((p) => p[1]);
    const box: BBox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    const usFirst = usUnitsFirst(box);
    const cs = await crossSection(line.path);
    const citation = { source: TERRAIN_CITATION_SOURCE, url: TERRAIN_CITATION_URL, retrieved: new Date().toISOString().slice(0, 10) };
    if (!cs) {
      return {
        error: "AWS Terrain Tiles did not answer for this line, so there is no profile",
        hint: "upstream",
        sourceStatus: { ok: false, reason: "offline", message: "AWS Terrain Tiles did not answer." },
      };
    }
    const names = { start: line.start, end: line.end };
    void ctx;
    return {
      kind: "geojson",
      data: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "LineString", coordinates: line.path }, properties: profileProperties(cs, names, usFirst) }],
      },
      citation,
      coverageNote: profileNote(cs, names, usFirst) + (moved.length > 0 ? `; ${moved.join("; ")}` : ""),
      title: names.start && names.end ? `Elevation profile: ${names.start} to ${names.end}` : "Elevation profile",
    };
  },
});

registerLayer(elevationProfile);
export default elevationProfile;

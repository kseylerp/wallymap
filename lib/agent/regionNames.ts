/**
 * Names that describe a region rather than a place ("Colorado River basin", "Mojave Desert", "Bears Ears National
 * Monument"). Mapbox answers these with a town or street that shares a word ("Colorado River basin" was the town of
 * Basin, Colorado), so they are looked up in the app's own region sources first, in this order per kind:
 *   basin, watershed   USGS Watershed Boundary Dataset (the river-basins layer), then Natural Earth
 *   valley, plateau, desert, range, mountains   Natural Earth (the physical-regions layer)
 *   national park, monument, recreation area, preserve   World Database on Protected Areas (the protected-areas-world layer)
 *   national forest    USFS administrative forest boundaries
 *   wilderness         designated wilderness (the wilderness layer), then the Protected Areas database
 *   nation, reservation   Wikidata alone ("Navajo Nation": Mapbox knows only Navajo Nation Drive in Flagstaff)
 *   anything above that found nothing   Wikidata: an item of that exact name that is a region, with a coordinate and an area
 * Services verified live 2026-10-14 (keyless): hydro.nationalmap.gov WBD layers 1 to 4 (Upper and Lower Colorado Region are
 * two units), data-gis.unep-wcmc.org WDPA layer 1 (Bears Ears is stored as several units), apps.fs.usda.gov EDW forest
 * boundaries (forestname, "Tahoe National Forest"), the wilderness FeatureServer (NAME, "Desolation Wilderness"), and
 * wikidata.org (wbsearchentities, then wbgetentities for P625 coordinates and P2046 area).
 * Every source is optional: a lookup that fails or finds nothing returns null and the caller falls back to Mapbox.
 */
import type { BBox } from "@/layers/types";
import { featureBBox } from "./naturalEarth";

export type RegionSource = "natural-earth" | "river-basins" | "protected-areas-world" | "wilderness" | "national-forests" | "wikidata" | "world";

/**
 * The polar regions, which no geocoder answers well: Mapbox gave "Arctic" as Arctic, Rhode Island and "Arctic Circle"
 * as a street in Santa Claus, Indiana (2026-10-17). Their boxes are the polar circles (sea ice, permafrost, the poles).
 */
const WORLD_REGIONS: { names: string[]; name: string; bbox: BBox; center: [number, number] }[] = [
  { names: ["arctic", "the arctic", "arctic ocean", "the arctic ocean", "arctic circle", "the arctic circle", "north pole", "the north pole", "high arctic"], name: "the Arctic (north of the Arctic Circle)", bbox: [-180, 66.5, 180, 90], center: [0, 80] },
  { names: ["antarctica", "antarctic", "the antarctic", "southern ocean", "the southern ocean", "south pole", "the south pole"], name: "Antarctica and the Southern Ocean", bbox: [-180, -90, 180, -60], center: [0, -80] },
];

/** A polar region by name ("the Arctic", "Antarctica"), or null. */
export function worldRegion(place: string): RegionMatch | null {
  const key = place.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  const found = WORLD_REGIONS.find((r) => r.names.includes(key));
  return found ? { bbox: found.bbox, center: found.center, name: found.name, source: "world" } : null;
}

export type RegionMatch = {
  bbox: BBox;
  center: [number, number];
  name: string;
  source: RegionSource;
};

export type RegionKind =
  | "basin"
  | "watershed"
  | "valley"
  | "plateau"
  | "desert"
  | "range"
  | "park"
  | "monument"
  | "recreation"
  | "preserve"
  | "forest"
  | "wilderness"
  | "reservation";

export type RegionName = {
  kind: RegionKind;
  /** The name without its kind word and without a trailing "River": "Colorado" for "Colorado River basin". */
  base: string;
  /** The first part of the text, before any comma, as typed: "Colorado River basin". */
  full: string;
  /** True when the text says river or watershed, so a river basin is meant rather than a landform. */
  riverish: boolean;
};

const PATTERNS: [RegExp, RegionKind][] = [
  [/^(.+?)\s+(?:drainage\s+basin|river\s+basin|basin)$/i, "basin"],
  [/^(.+?)\s+(?:river\s+)?watershed$/i, "watershed"],
  [/^(.+?)\s+valley$/i, "valley"],
  [/^(.+?)\s+plateau$/i, "plateau"],
  [/^(.+?)\s+desert$/i, "desert"],
  [/^(.+?)\s+(?:mountain\s+range|ranges?|mountains|mtns)$/i, "range"],
  [/^(.+?)\s+national\s+park$/i, "park"],
  [/^(.+?)\s+national\s+monument$/i, "monument"],
  [/^(.+?)\s+national\s+recreation\s+area$/i, "recreation"],
  [/^(.+?)\s+national\s+(?:preserve|grassland)$/i, "preserve"],
  [/^(.+?)\s+national\s+forest$/i, "forest"],
  [/^(.+?)\s+wilderness(?:\s+area)?$/i, "wilderness"],
  [/^(.+?)\s+(?:nation|indian\s+reservation|reservation)$/i, "reservation"],
];

/** The kind of region a name describes, or null for a name of an ordinary place (a town, a lake, a street). */
export function parseRegionName(place: string): RegionName | null {
  const full = place.split(",")[0].trim().replace(/\s+/g, " ");
  for (const [pattern, kind] of PATTERNS) {
    const m = pattern.exec(full);
    if (!m) continue;
    const base = m[1].replace(/^the\s+/i, "").trim();
    if (base === "") return null;
    return { kind, base: base.replace(/\s+river$/i, "").trim() || base, full, riverish: /\b(river|watershed)\b/i.test(full) };
  }
  return null;
}

/** How long one lookup against a region source may take. */
const SOURCE_TIMEOUT_MS = 8_000;
/** The USGS hydrology service answers in 0.5 s or 10 s (measured 2026-10-14), so it gets longer; a miss sends the model to a town. */
const SLOW_SOURCE_TIMEOUT_MS = 15_000;
/** How long a failed source is skipped, so lookups during an outage do not each wait out the timeout. */
const RETRY_AFTER_MS = 20_000;
const failedAt = new Map<string, number>();
/** Answers found in the last hour, so a repeat lookup (the model asks again, or a second turn) does not wait on a slow service. */
const CACHE_TTL_MS = 3_600_000;
const answers = new Map<string, { at: number; match: RegionMatch }>();

/** Runs one source lookup; a source that failed in the last minute is skipped, and a failure never escapes. */
async function guarded<T>(source: string, run: () => Promise<T | null>): Promise<T | null> {
  const failed = failedAt.get(source);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return null;
  try {
    return await run();
  } catch {
    failedAt.set(source, Date.now());
    return null;
  }
}

/** Forgets which sources failed; for tests. */
export function resetRegionSources(): void {
  failedAt.clear();
  answers.clear();
}

async function getJson(url: URL | string, headers?: Record<string, string>, timeoutMs = SOURCE_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(headers && { headers }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A text for an ArcGIS where clause string: quotes doubled, wildcard characters dropped. */
const sqlText = (text: string) => text.replace(/[%_]/g, "").replace(/'/g, "''");

const sqlUpper = (text: string) => sqlText(text).toUpperCase();

function center(bbox: BBox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function validBBox(bbox: BBox): boolean {
  return bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1] && bbox[2] - bbox[0] <= 180 && bbox[3] - bbox[1] <= 90;
}

type Named = { name: string; bbox: BBox };

/**
 * Features of an ArcGIS layer for a where clause: the name field and the box of each geometry. Geometry is simplified
 * hard (a box only needs the extremes), and the service's own error replies (a 200 with an error body) count as failures.
 */
async function queryNames(layerUrl: string, where: string, nameField: string, offset: number, timeoutMs?: number): Promise<Named[]> {
  const url = new URL(`${layerUrl}/query`);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", nameField);
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("maxAllowableOffset", String(offset));
  url.searchParams.set("resultRecordCount", "200");
  url.searchParams.set("f", "geojson");
  const json = await getJson(url, undefined, timeoutMs);
  if (!isRecord(json)) throw new Error("not JSON");
  if ("error" in json) throw new Error("service error");
  if (!Array.isArray(json.features)) return [];
  const out: Named[] = [];
  for (const raw of json.features) {
    if (!isRecord(raw) || !isRecord(raw.properties) || !isRecord(raw.geometry)) continue;
    const value = raw.properties[nameField] ?? raw.properties[nameField.toLowerCase()] ?? raw.properties[nameField.toUpperCase()];
    if (typeof value !== "string") continue;
    const bbox = featureBBox(raw as unknown as Parameters<typeof featureBBox>[0]);
    if (validBBox(bbox)) out.push({ name: value.replace(/\\'/g, "'").trim(), bbox });
  }
  return out;
}

/** Units of one region can be apart (Bears Ears is two separate units), but not by more than this many degrees. */
const UNIT_GAP_DEG = 0.5;

function near(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] + UNIT_GAP_DEG && b[0] <= a[2] + UNIT_GAP_DEG && a[1] <= b[3] + UNIT_GAP_DEG && b[1] <= a[3] + UNIT_GAP_DEG;
}

function union(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

const bboxArea = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);

function degreesApart(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Units that touch or lie close together are one region (Upper and Lower Colorado Region, the units of a national
 * monument); units of the same name far apart are different places (a Colorado in Texas and one in Utah). Returns the group nearest to
 * `proximity`, or the biggest group when there is none, with the names in it.
 */
function pickGroup(units: Named[], proximity: [number, number] | undefined): { bbox: BBox; names: string[] } | null {
  const groups: Named[][] = [];
  for (const unit of units) {
    const touching = groups.filter((g) => g.some((u) => near(u.bbox, unit.bbox)));
    const merged = [unit, ...touching.flat()];
    for (const g of touching) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  if (groups.length === 0) return null;
  const scored = groups.map((g) => {
    const bbox = union(g.map((u) => u.bbox));
    return { g, bbox, apart: proximity ? degreesApart(proximity, center(bbox)) : 0, area: bboxArea(bbox) };
  });
  scored.sort((a, b) => a.apart - b.apart || b.area - a.area);
  const best = scored[0];
  const names = [...new Set(best.g.map((u) => u.name))];
  return { bbox: best.bbox, names };
}

function match(source: RegionSource, name: string, bbox: BBox): RegionMatch {
  return { bbox, center: center(bbox), name, source };
}

/**
 * The 18 regions (huc2) of the contiguous US as boxes, so the biggest basins (Colorado, Missouri, Great Basin) need no
 * network call: the USGS service answers in 0.5 s or 10 s. Recorded 2026-10-14 from WBD layer 1 at a 0.5 degree
 * simplification (the Colorado pair matches the service's own extent to 0.03 degrees). Alaska, Hawaii, the Caribbean and the
 * Pacific are left out; their boxes cross the antimeridian or are not one place.
 */
const HUC2_REGIONS: [string, BBox][] = [
  ["Texas-Gulf Region", [-103.9, 26, -93.1, 34.7]],
  ["Ohio Region", [-89.3, 35.3, -77.9, 42.4]],
  ["Tennessee Region", [-88.6, 34.1, -81.3, 37.2]],
  ["Upper Mississippi Region", [-97.4, 37, -85.9, 47.8]],
  ["Lower Mississippi Region", [-94.3, 28.9, -88.3, 37.8]],
  ["Rio Grande Region", [-109, 24.8, -97.3, 38.5]],
  ["Upper Colorado Region", [-112.3, 35.6, -105.6, 43.5]],
  ["Arkansas-White-Red Region", [-106.4, 31.2, -90.1, 39.4]],
  ["Great Basin Region", [-120.5, 35.2, -110.6, 42.9]],
  ["California Region", [-124.5, 32.2, -114.7, 43.3]],
  ["Lower Colorado Region", [-115.7, 29.9, -107.8, 39.3]],
  ["Souris-Red-Rainy Region", [-114.8, 45.5, -89.9, 50.6]],
  ["Pacific Northwest Region", [-124.9, 41.1, -109.9, 52.9]],
  ["Great Lakes Region", [-93.2, 40.4, -70.2, 51.1]],
  ["Missouri Region", [-113.9, 37, -90.1, 49.7]],
  ["South Atlantic-Gulf Region", [-90.6, 24.4, -75.4, 37.5]],
  ["New England Region", [-73.7, 40.9, -66, 47.8]],
  ["Mid Atlantic Region", [-80.5, 36.8, -71.8, 44.1]],
];

const WBD = "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer";
/** The units of the Watershed Boundary Dataset, coarse to fine: regions (huc2) to subbasins (huc8). */
const WBD_LAYERS = [1, 2, 3, 4];
const WBD_OFFSET = 0.05;

/**
 * Hydrologic units named for the river: "Colorado" is the Upper and the Lower Colorado Region, which together are the
 * Colorado River basin. The coarsest level that has a unit of that name wins ("<name> Region", then "Upper/Middle/Lower
 * <name>"), so a small river is its subbasin and a big one its regions. "Great Basin" is "Great Basin Region" in the data.
 */
async function riverBasinMatch(region: RegionName, proximity: [number, number] | undefined): Promise<RegionMatch | null> {
  const prefixes = ["", "Upper ", "Middle ", "Lower "];
  const names = (stem: string, suffix: string) => prefixes.map((p) => `${p}${stem}${suffix}`);
  for (const layer of WBD_LAYERS) {
    const wanted =
      layer === 1
        ? [...names(region.base, " Region"), ...names(region.full, " Region")]
        : names(region.base, "");
    if (layer === 1) {
      const known = HUC2_REGIONS.filter(([name]) => wanted.some((n) => normalize(n) === normalize(name))).map(([name, bbox]) => ({ name, bbox }));
      const group = pickGroup(known, proximity);
      if (group) return match("river-basins", `${region.full} (USGS ${group.names.join(" and ")})`, group.bbox);
      continue;
    }
    const where = `UPPER(name) IN (${wanted.map((n) => `'${sqlUpper(n)}'`).join(",")})`;
    const units = await queryNames(`${WBD}/${layer}`, where, "name", WBD_OFFSET, SLOW_SOURCE_TIMEOUT_MS);
    const group = pickGroup(units.filter((u) => wanted.some((n) => normalize(n) === normalize(u.name))), proximity);
    if (group) return match("river-basins", `${region.full} (USGS ${group.names.join(" and ")})`, group.bbox);
  }
  return null;
}

const WDPA = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/1";
const WDPA_DESIGNATION: Partial<Record<RegionKind, string>> = {
  park: "National Park",
  monument: "National Monument",
  recreation: "Recreation",
  preserve: "National",
  wilderness: "Wilderness",
};

/**
 * Protected areas of that name. The database stores many areas as several units ("Bears Ears" and "Bears Ears National
 * Monument - Indian Creek Unit"), so the units that start with the name, of that designation, are one region.
 */
async function protectedAreaMatch(region: RegionName, proximity: [number, number] | undefined): Promise<RegionMatch | null> {
  const designation = WDPA_DESIGNATION[region.kind];
  if (designation === undefined) return null;
  const where = `UPPER(name_eng) LIKE '${sqlUpper(region.base)}%' AND desig_eng LIKE '%${sqlText(designation)}%'`;
  const units = await queryNames(WDPA, where, "name_eng", 0.02);
  const base = normalize(region.base);
  const full = normalize(region.full);
  const units2 = units.filter((u) => {
    const n = normalize(u.name);
    return n === base || n === full || n.startsWith(`${full} `);
  });
  const group = pickGroup(units2, proximity);
  return group ? match("protected-areas-world", region.full, group.bbox) : null;
}

const USFS_FORESTS = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0";

async function forestMatch(region: RegionName, proximity: [number, number] | undefined): Promise<RegionMatch | null> {
  const units = await queryNames(USFS_FORESTS, `UPPER(forestname) = '${sqlUpper(region.full)}'`, "forestname", 0.02);
  const group = pickGroup(units.filter((u) => normalize(u.name) === normalize(region.full)), proximity);
  return group ? match("national-forests", group.names[0] ?? region.full, group.bbox) : null;
}

const WILDERNESS =
  "https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/Wilderness_Areas_in_the_United_States/FeatureServer/0";

async function wildernessMatch(region: RegionName, proximity: [number, number] | undefined): Promise<RegionMatch | null> {
  const units = await queryNames(WILDERNESS, `UPPER(NAME) LIKE '${sqlUpper(region.base)}%'`, "NAME", 0.01);
  const wanted = normalize(`${region.base} wilderness`);
  const group = pickGroup(units.filter((u) => normalize(u.name) === wanted), proximity);
  return group ? match("wilderness", group.names[0] ?? region.full, group.bbox) : null;
}

const WIKIDATA = "https://www.wikidata.org/w/api.php";
/** Wikidata asks API clients to say who they are. */
const WIKIDATA_HEADERS = { "user-agent": "WallyMap/1.0 (place lookup; https://wallymap.vercel.app)" };
/** What a Wikidata description of a region says; towns, people, paintings and documents of the same name are left out. */
const REGION_DESCRIPTION =
  /\b(desert|mountain range|mountain|mountains|range|plateau|valley|basin|drainage|watershed|highlands?|national (?:park|forest|monument|recreation area|preserve|grassland)|wilderness|region|reservation|indian tribe)\b/i;

/** Area units Wikidata uses for P2046, to km². */
const AREA_UNITS: Record<string, number> = {
  Q712226: 1, // square kilometre
  Q232291: 2.589988, // square mile
  Q35852: 0.01, // hectare
  Q81292: 0.00404686, // acre
};

type WikidataCandidate = { center: [number, number]; areaKm2: number; label: string };

function claimValues(claims: unknown, property: string): unknown[] {
  if (!isRecord(claims)) return [];
  const list = claims[property];
  if (!Array.isArray(list)) return [];
  return list.map((c) => (isRecord(c) && isRecord(c.mainsnak) && isRecord(c.mainsnak.datavalue) ? c.mainsnak.datavalue.value : undefined));
}

/** The mean of an item's coordinates (a region often lists several points), or undefined when it has none. */
function itemCenter(claims: unknown): [number, number] | undefined {
  const points = claimValues(claims, "P625").flatMap((v) =>
    isRecord(v) && typeof v.longitude === "number" && typeof v.latitude === "number" ? [[v.longitude, v.latitude] as [number, number]] : [],
  );
  if (points.length === 0) return undefined;
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
}

function itemAreaKm2(claims: unknown): number | undefined {
  for (const v of claimValues(claims, "P2046")) {
    if (!isRecord(v) || typeof v.amount !== "string" || typeof v.unit !== "string") continue;
    const factor = AREA_UNITS[v.unit.split("/").pop() ?? ""];
    const area = Number(v.amount) * (factor ?? Number.NaN);
    if (Number.isFinite(area) && area > 0) return area;
  }
  return undefined;
}

/** A square on the ground with the given area (km²) around a point. A region's real shape is not known, only its size. */
export function areaBBox([lng, lat]: [number, number], areaKm2: number): BBox {
  const half = Math.max(2.5, Math.sqrt(areaKm2) / 2);
  const dLat = half / 110.57;
  const dLng = half / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/**
 * A Wikidata item whose label is exactly the name, whose description says it is a region, and that has both a coordinate
 * and an area, boxed to that area around the coordinate. With several (the Colorado River basin is two items), the one
 * nearest `proximity` wins, else the biggest.
 */
async function wikidataMatch(region: RegionName, proximity: [number, number] | undefined): Promise<RegionMatch | null> {
  const search = new URL(WIKIDATA);
  search.searchParams.set("action", "wbsearchentities");
  search.searchParams.set("search", region.full);
  search.searchParams.set("language", "en");
  search.searchParams.set("type", "item");
  search.searchParams.set("limit", "8");
  search.searchParams.set("format", "json");
  const found = await getJson(search, WIKIDATA_HEADERS);
  if (!isRecord(found) || !Array.isArray(found.search)) return null;
  const items = found.search.flatMap((raw): { id: string; label: string }[] => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string") return [];
    const description = typeof raw.description === "string" ? raw.description : "";
    return normalize(raw.label) === normalize(region.full) && REGION_DESCRIPTION.test(description) ? [{ id: raw.id, label: raw.label }] : [];
  });
  if (items.length === 0) return null;

  const entities = new URL(WIKIDATA);
  entities.searchParams.set("action", "wbgetentities");
  entities.searchParams.set("ids", items.map((i) => i.id).join("|"));
  entities.searchParams.set("props", "claims");
  entities.searchParams.set("format", "json");
  const got = await getJson(entities, WIKIDATA_HEADERS);
  if (!isRecord(got) || !isRecord(got.entities)) return null;
  const candidates: WikidataCandidate[] = [];
  for (const item of items) {
    const entity = got.entities[item.id];
    const claims = isRecord(entity) ? entity.claims : undefined;
    const at = itemCenter(claims);
    const areaKm2 = itemAreaKm2(claims);
    if (at && areaKm2) candidates.push({ center: at, areaKm2, label: item.label });
  }
  candidates.sort((a, b) =>
    proximity ? degreesApart(proximity, a.center) - degreesApart(proximity, b.center) : b.areaKm2 - a.areaKm2,
  );
  const best = candidates[0];
  return best ? match("wikidata", best.label, areaBBox(best.center, best.areaKm2)) : null;
}

export type RegionLookupDeps = {
  /** Natural Earth (physical-regions) by the names to try, in order; supplied by the caller, which owns its download. */
  naturalEarth: (names: string[]) => Promise<RegionMatch | null>;
};

/** Natural Earth spells "Mountains" as "Mts." and has no "River" in its basin names. */
function naturalEarthNames(region: RegionName): string[] {
  const names = [region.full];
  if (region.kind === "range") names.push(region.full.replace(/\b(?:mountains|mtns)\b/i, "Mts."), `${region.base} Mountains`, `${region.base} Range`);
  if (region.kind === "basin" || region.kind === "watershed") names.push(`${region.base} Basin`);
  return [...new Set(names)];
}

/**
 * Resolves a region-describing name against the region sources (see the file comment), or null when `place` is not a
 * region name or no source knows it. `proximity` ([lng, lat], the current view) picks between regions of the same name.
 */
export async function lookupRegion(
  place: string,
  proximity: [number, number] | undefined,
  deps: RegionLookupDeps,
): Promise<RegionMatch | null> {
  const region = parseRegionName(place);
  if (!region) return null;
  const key = `${normalize(region.full)}@${proximity ? proximity.map((n) => Math.round(n)).join(",") : ""}`;
  const earlier = answers.get(key);
  if (earlier && Date.now() - earlier.at < CACHE_TTL_MS) return earlier.match;

  const physical = () => deps.naturalEarth(naturalEarthNames(region));
  const steps: (() => Promise<RegionMatch | null>)[] = [];
  const add = (source: string, run: () => Promise<RegionMatch | null>) => steps.push(() => guarded(source, run));

  switch (region.kind) {
    case "basin":
    case "watershed":
      // "Colorado River basin" is the USGS regions; "Great Basin" is a Natural Earth region that the USGS also lists.
      if (region.riverish) {
        add("river-basins", () => riverBasinMatch(region, proximity));
        steps.push(physical);
      } else {
        steps.push(physical);
        add("river-basins", () => riverBasinMatch(region, proximity));
      }
      break;
    case "valley":
    case "plateau":
    case "desert":
    case "range":
      steps.push(physical);
      break;
    case "park":
    case "monument":
    case "recreation":
    case "preserve":
      add("protected-areas-world", () => protectedAreaMatch(region, proximity));
      break;
    case "forest":
      add("national-forests", () => forestMatch(region, proximity));
      break;
    case "wilderness":
      add("wilderness", () => wildernessMatch(region, proximity));
      add("protected-areas-world", () => protectedAreaMatch(region, proximity));
      break;
  }
  add("wikidata", () => wikidataMatch(region, proximity));

  for (const step of steps) {
    const match = await step();
    if (match) {
      answers.set(key, { at: Date.now(), match });
      return match;
    }
  }
  return null;
}

/** What a Wikidata description of one natural feature says (a mountain, a rock, a lake), so towns and streets are left out. */
const FEATURE_DESCRIPTION =
  /\b(mountain|peak|summit|hill|rock|monolith|dome|butte|mesa|volcano|cliff|canyon|gorge|lake|waterfall|glacier|island|cape|headland|bay|beach|cave|arch|spring|geyser|crater)\b/i;

/**
 * One natural feature by name from Wikidata ("Table Mountain, Cape Town"): items labelled exactly the name before the
 * comma whose description says what kind of feature it is, the one whose description names the words after the comma
 * first (else Wikidata's own order), boxed `halfSpanKm` around its coordinate. For names the place geocoder knows only
 * as streets and Search Box only in another country (Table Mountain Street in Cape Town; Table Mountain in California).
 */
export async function wikidataFeature(place: string, halfSpanKm: number): Promise<RegionMatch | null> {
  const [name, ...rest] = place.split(/,|\(|\)/).map((p) => p.trim()).filter(Boolean);
  if (!name) return null;
  if (rest.length > 0) return wikidataFeatureNamed(name, rest.join(" ").toLowerCase(), halfSpanKm);
  // "Crater Lake Oregon": the last one or two words may be where it is.
  const words = name.split(/\s+/);
  for (const cut of [0, 1, 2]) {
    if (words.length - cut < 1) break;
    const found = await wikidataFeatureNamed(words.slice(0, words.length - cut).join(" "), words.slice(words.length - cut).join(" ").toLowerCase(), halfSpanKm);
    if (found) return found;
  }
  return null;
}

async function wikidataFeatureNamed(name: string, qualifier: string, halfSpanKm: number): Promise<RegionMatch | null> {
  try {
    const search = new URL(WIKIDATA);
    search.searchParams.set("action", "wbsearchentities");
    search.searchParams.set("search", name);
    search.searchParams.set("language", "en");
    search.searchParams.set("type", "item");
    search.searchParams.set("limit", "10");
    search.searchParams.set("format", "json");
    const found = await getJson(search, WIKIDATA_HEADERS);
    if (!isRecord(found) || !Array.isArray(found.search)) return null;
    const items = found.search
      .flatMap((raw, order): { id: string; label: string; description: string; order: number }[] => {
        if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string") return [];
        const description = typeof raw.description === "string" ? raw.description : "";
        return normalize(raw.label) === normalize(name) && FEATURE_DESCRIPTION.test(description) ? [{ id: raw.id, label: raw.label, description, order }] : [];
      })
      .sort((a, b) => {
        const named = (d: string) => (qualifier && qualifier.split(/\s+/).every((w) => d.toLowerCase().includes(w)) ? 0 : 1);
        return named(a.description) - named(b.description) || a.order - b.order;
      });
    if (items.length === 0) return null;
    // With a qualifier, only an item whose description names it: Table Mountain in California is not the one in Cape Town.
    const best = qualifier ? items.find((i) => qualifier.split(/\s+/).every((w) => i.description.toLowerCase().includes(w))) : items[0];
    if (!best) return null;
    const entities = new URL(WIKIDATA);
    entities.searchParams.set("action", "wbgetentities");
    entities.searchParams.set("ids", best.id);
    entities.searchParams.set("props", "claims");
    entities.searchParams.set("format", "json");
    const got = await getJson(entities, WIKIDATA_HEADERS);
    const entity = isRecord(got) && isRecord(got.entities) ? got.entities[best.id] : undefined;
    const at = isRecord(entity) ? itemCenter(entity.claims) : undefined;
    if (!at) return null;
    const dLat = halfSpanKm / 110.57;
    const dLng = halfSpanKm / (111.32 * Math.max(0.1, Math.cos((at[1] * Math.PI) / 180)));
    return { bbox: [at[0] - dLng, at[1] - dLat, at[0] + dLng, at[1] + dLat], center: at, name: `${best.label} (${best.description})`, source: "wikidata" };
  } catch {
    return null;
  }
}

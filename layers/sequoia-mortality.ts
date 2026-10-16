/**
 * Giant sequoia survival after the 2020 Castle Fire and 2021 KNP Complex Fire, one point per mapped tree.
 * Source (verified live 2026-10-10, keyless): USGS ScienceBase item 63d40479d34e06fef150e7b4, "Assessment of Giant
 * Sequoia Mortality and Regeneration within Burned Groves in Sequoia and Kings Canyon National Parks" (ver. 4.0, Feb 2026),
 *   https://www.sciencebase.gov/catalog/file/get/63d40479d34e06fef150e7b4?name=Sequoia_stemdata.csv
 *   (the `name=` form is stable across versions; the file's own `__disk__` URL changes with each revision).
 * Sequoia_stemdata.csv: 3,036 rows, 246 KB, columns TREE_ID, Grove, UTM_E, UTM_N, Last_Known_Status (Alive 1,484,
 * Dead 1,475, "Tree Not Found" 77), Crown_Live_Percent, Crown_Scorch_Percent, Crown_Torch_Percent (0 to 100 or NA),
 * Observation_Date (M/D/YYYY, 2022 to 2024), Diameter (cm at 1.37 m, 0 when not measured) and Fire_name (Castle or KNP).
 * The metadata XML says coordinates are NAD83 UTM zone 11 (northern hemisphere); utm11ToLonLat below converts them.
 * The file is fetched once and cached for a week under a fixed key (not the per-view key), then filtered to the view.
 * Output properties: grove, fire, status (live or dead), kind (same), crownLivePercent, crownScorchPercent,
 * crownTorchPercent, diameterCm, observed (ISO date), t (the fire's start date). No `v`: the count is the feature count.
 * Check (2026-10-10): all 2,940 trees with a named grove land inside that grove's outline extent from sequoia-groves (0 outside).
 * Smoke through runLayer (2026-10-10): box -119,35.8,-118.3,36.8 returned 2,959 trees (1,484 live, 1,475 dead) in 0.5 s (910 KB).
 * Wide (over 400,000 km², up to 1,600,000): the same file, biggest trunks first, capped at 3,000 so the whole survey still fits.
 *   Smoke 2026-10-14, California box -124.5,32.5,-114,42: all 2,959 of 2,959 in 0.6 s (largest a dead 762 cm tree in Suwanee grove).
 */
import { z } from "zod";
import type { Feature, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { bboxesDisjoint } from "./_shared/coverage";
import { textBody } from "@/lib/fetch";
import { layerColor } from "@/lib/render/palette";

const CSV_URL = "https://www.sciencebase.gov/catalog/file/get/63d40479d34e06fef150e7b4?name=Sequoia_stemdata.csv";
const CSV_CACHE_KEY = "sequoia-mortality:stemdata-v4";
const TTL_SECONDS = 7 * 86_400;
/**
 * Most trees a wide view carries: more than the whole survey (2,959 trees with a status), so a wide view still shows every
 * tree and counts stay right; the file is one cached download whatever the box.
 */
const WIDE_LIMIT = 3_000;

/** The burned groves of Sequoia and Kings Canyon, with margin. */
const RANGE: BBox = [-119.0, 35.8, -118.3, 36.8];

/** Start dates of the two fires the stems were surveyed after (InciWeb / NPS). */
const FIRES: Record<string, { name: string; start: string }> = {
  castle: { name: "Castle Fire", start: "2020-08-19" },
  knp: { name: "KNP Complex Fire", start: "2021-09-09" },
};

// ---- UTM zone 11 north to longitude and latitude (GRS80, Snyder, USGS PP 1395, eqs. 8-17 to 8-18) ----

const A = 6_378_137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const ZONE_11_CENTRAL_MERIDIAN = -117;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Converts NAD83 / WGS84 UTM zone 11 north metres to [longitude, latitude] degrees (accurate to well under a metre). */
export function utm11ToLonLat(easting: number, northing: number): [number, number] {
  const x = easting - 500_000;
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const c1 = EP2 * cos1 ** 2;
  const t1 = tan1 ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sin1 ** 2);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin1 ** 2) ** 1.5;
  const d = x / (n1 * K0);

  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    rad(ZONE_11_CENTRAL_MERIDIAN) +
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120) / cos1;
  return [deg(lon), deg(lat)];
}

// ---- CSV ----

/** Splits CSV text into rows of fields; handles quoted fields with commas, doubled quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function percent(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "" || raw.trim().toUpperCase() === "NA") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

/** M/D/YYYY to YYYY-MM-DD; undefined for anything else. */
function isoDate(raw: string | undefined): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw ?? "").trim());
  if (m === null) return undefined;
  const date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? undefined : date;
}

export type StemParse = { features: Feature<Point>[]; notFound: number };

/**
 * Converts the stem CSV to points inside `bbox` (all when omitted). Rows whose tree was not found on the last visit,
 * or without usable coordinates, are left out (`notFound` counts the former, inside the box).
 */
export function parseStems(csv: string, bbox?: BBox): StemParse {
  const rows = parseCsv(csv);
  const features: Feature<Point>[] = [];
  let notFound = 0;
  if (rows.length < 2) return { features, notFound };
  const col = new Map(rows[0].map((name, i) => [name.trim().toLowerCase(), i]));
  const get = (row: string[], name: string) => {
    const i = col.get(name);
    return i === undefined ? undefined : row[i]?.trim();
  };

  for (const row of rows.slice(1)) {
    const status = get(row, "last_known_status")?.toLowerCase();
    if (status !== "alive" && status !== "dead" && status !== "tree not found") continue;
    const e = Number(get(row, "utm_e"));
    const n = Number(get(row, "utm_n"));
    if (!Number.isFinite(e) || !Number.isFinite(n) || e <= 0 || n <= 0) continue;
    const [lon, lat] = utm11ToLonLat(e, n);
    if (bbox !== undefined && (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3])) continue;
    if (status === "tree not found") {
      notFound += 1;
      continue;
    }

    const kind = status === "alive" ? "live" : "dead";
    const observed = isoDate(get(row, "observation_date"));
    const fire = FIRES[(get(row, "fire_name") ?? "").toLowerCase()];
    const properties: Record<string, string | number> = { kind, status: kind };
    const grove = get(row, "grove");
    if (grove !== undefined && grove !== "" && grove.toUpperCase() !== "NA") properties.grove = grove;
    if (fire !== undefined) properties.fire = fire.name;
    const live = percent(get(row, "crown_live_percent"));
    const scorch = percent(get(row, "crown_scorch_percent"));
    const torch = percent(get(row, "crown_torch_percent"));
    if (live !== undefined) properties.crownLivePercent = live;
    if (scorch !== undefined) properties.crownScorchPercent = scorch;
    if (torch !== undefined) properties.crownTorchPercent = torch;
    const diameter = Number(get(row, "diameter"));
    if (Number.isFinite(diameter) && diameter > 0) properties.diameterCm = Math.round(diameter);
    if (observed !== undefined) properties.observed = observed;
    const start = fire?.start ?? observed;
    if (start !== undefined) properties.t = `${start}T00:00:00.000Z`;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] },
      properties,
    });
  }
  return { features, notFound };
}

const STEM_FILE = textBody({ markers: [/TREE_ID/, /UTM_E/, /Last_Known_Status/], minChars: 1000 });

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const sequoiaMortality = defineLayer({
  id: "sequoia-mortality",
  title: "Giant sequoia fire survival",
  description:
    "Which giant sequoias lived or died after the Castle Fire (2020) and the KNP Complex Fire (2021) in Sequoia and Kings Canyon National Parks: one point per mapped tree, from USGS field surveys in 2022 to 2024. " +
    "Each point has kind and status (live or dead), grove, fire, crownLivePercent, crownScorchPercent and crownTorchPercent (how much of the crown was still green, scorched brown, or burned away, 0 to 100, when recorded), diameterCm (trunk width when measured), observed (survey date) and t (the fire's start date). " +
    "There is no v: count the points. Points cluster at low zoom. " +
    "Use it for 'how many giant sequoias died in the fires', 'which groves lost the most trees' or 'did the big trees survive'; filter by kind to compare live and dead. " +
    "Caveats: these are the roughly 3,000 trees in the USGS survey (Redwood Mountain, Homers Nose, Suwanee, Garfield and a dozen other groves), not every sequoia, so the share dead is for the surveyed trees, and the surveyed trees skew to the areas that burned. " +
    "Trees the crews could not find on a later visit (77) are left out. Southern Sierra Nevada only; over 400,000 km² it still returns every tree. " +
    "Pair it with sequoia-groves for the grove outlines.",
  coverage: { bbox: RANGE },
  surface: "land",
  license: "Public domain (USGS)",
  requiredEnv: [],
  maxAreaKm2: 400_000,
  wide: { orderBy: "trunk diameter in cm", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "point", color: layerColor("sequoia-mortality"), cluster: true },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "USGS, Assessment of Giant Sequoia Mortality and Regeneration within Burned Groves in Sequoia and Kings Canyon National Parks (ver. 4.0; public domain)",
      url: "https://doi.org/10.5066/P96Z1PBK",
      retrieved: new Date().toISOString(),
    };

    if (bboxesDisjoint(ctx.bbox, RANGE)) {
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features: [] },
        citation,
        coverageNote: "The tree survey covers only Sequoia and Kings Canyon National Parks in California",
      };
    }

    let text: string;
    try {
      const res = await ctx.fetch(CSV_URL, {
        cacheKey: CSV_CACHE_KEY,
        ttlSeconds: TTL_SECONDS,
        validate: STEM_FILE,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `ScienceBase returned ${res.status}`, hint: "upstream" };
      text = await res.text();
    } catch (err) {
      return {
        error: isTimeout(err)
          ? `ScienceBase timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds`
          : "ScienceBase returned no response",
        hint: "upstream",
      };
    }

    const parsed = parseStems(text, ctx.bbox);
    const { notFound } = parsed;
    let features = parsed.features;
    // Wide: biggest trunks first, capped at the strategy's limit (which the whole survey fits under), with the count in the box.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    if (wideLimit !== undefined) {
      features = [...features].sort((a, b) => Number(b.properties?.diameterCm ?? -1) - Number(a.properties?.diameterCm ?? -1)).slice(0, wideLimit);
    }
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(wideLimit !== undefined && { total: parsed.features.length }),
      ...(notFound > 0 && features.length > 0
        ? { coverageNote: `${notFound} surveyed trees that could not be found on a later visit are left out` }
        : {}),
    };
  },
});

registerLayer(sequoiaMortality);

export default sequoiaMortality;

/**
 * Wildfire perimeters from NIFC (National Interagency Fire Center), two ArcGIS services in
 * one org (https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services). Field names
 * below were read from each service's `?f=json` metadata on 2026-10-09.
 *
 * History: InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0
 *   INCIDENT (string), FIRE_YEAR_INT (smallint; FIRE_YEAR is a string, so it is not used in
 *   `where`), GIS_ACRES (single), AGENCY (string), UNIT_ID, IRWINID, FEATURE_CA (category),
 *   DATE_CUR (string). There is no discovery date. The view is complete through 2019 but thin
 *   after (2020: 151 rows, 2021: 55), and a few rows carry junk years like 9999, so it is only
 *   queried for years before 2020.
 *
 * WFIGS: WFIGS_Interagency_Perimeters/FeatureServer/0 (2020 onward, includes in-progress fires)
 *   poly_IncidentName, poly_GISAcres (double), poly_IRWINID, poly_DateCurrent (date, epoch ms),
 *   poly_FeatureCategory ("Wildfire Daily Fire Perimeter" | "Wildfire Final Fire Perimeter" | ...),
 *   attr_FireDiscoveryDateTime (date, epoch ms), attr_POOJurisdictionalAgency,
 *   attr_IncidentTypeCategory ("WF" wildfire | "RX" prescribed).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";

const ORG = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
const HISTORY_URL = `${ORG}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0`;
const WFIGS_URL = `${ORG}/WFIGS_Interagency_Perimeters/FeatureServer/0`;

/** First year the WFIGS service is used instead of the history view. */
const WFIGS_FROM_YEAR = 2020;

const HISTORY_FIELDS = ["INCIDENT", "FIRE_YEAR_INT", "GIS_ACRES", "AGENCY", "IRWINID"];
const WFIGS_FIELDS = [
  "poly_IncidentName",
  "poly_GISAcres",
  "poly_IRWINID",
  "poly_DateCurrent",
  "attr_FireDiscoveryDateTime",
  "attr_POOJurisdictionalAgency",
];

const inputSchema = z.object({
  yearsBack: z.number().int().min(1).max(25).default(10),
  minAcres: z.number().min(0).default(100),
});

export function historyWhere(startYear: number, minAcres: number): string {
  return (
    `FIRE_YEAR_INT >= ${startYear} AND FIRE_YEAR_INT < ${WFIGS_FROM_YEAR} AND GIS_ACRES >= ${minAcres}` +
    ` AND (FEATURE_CA <> 'Prescribed Fire' OR FEATURE_CA IS NULL)`
  );
}

export function wfigsWhere(startYear: number, minAcres: number): string {
  return (
    `attr_FireDiscoveryDateTime >= DATE '${startYear}-01-01' AND poly_GISAcres >= ${minAcres}` +
    ` AND attr_IncidentTypeCategory = 'WF'`
  );
}

type Candidate = {
  key: string;
  /** Larger is newer; used to pick between several perimeters of one fire. */
  recency: number;
  feature: Feature<Geometry>;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function perimeter(
  base: Feature,
  fields: { name: string; year: number; acres: number; agency?: string; t: string },
): Feature<Geometry> {
  const properties: Record<string, string | number> = {
    name: fields.name,
    year: fields.year,
    acres: fields.acres,
    t: fields.t,
    v: fields.acres,
  };
  if (fields.agency !== undefined) properties.agency = fields.agency;
  return { type: "Feature", geometry: base.geometry, properties };
}

function fromHistory(fc: FeatureCollection): Candidate[] {
  const out: Candidate[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const year = num(p.FIRE_YEAR_INT);
    const acres = num(p.GIS_ACRES);
    if (!f.geometry || year === undefined || acres === undefined) continue;
    const name = str(p.INCIDENT) ?? "Unnamed fire";
    const key = str(p.IRWINID) ?? `${name.toLowerCase()}|${year}`;
    out.push({
      key,
      recency: acres,
      feature: perimeter(f, { name, year, acres, agency: str(p.AGENCY), t: `${year}-01-01T00:00:00.000Z` }),
    });
  }
  return out;
}

function fromWfigs(fc: FeatureCollection): Candidate[] {
  const out: Candidate[] = [];
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const discovered = num(p.attr_FireDiscoveryDateTime);
    const acres = num(p.poly_GISAcres);
    if (!f.geometry || discovered === undefined || acres === undefined) continue;
    const date = new Date(discovered);
    const name = str(p.poly_IncidentName) ?? "Unnamed fire";
    const year = date.getUTCFullYear();
    out.push({
      key: str(p.poly_IRWINID) ?? `${name.toLowerCase()}|${year}`,
      recency: num(p.poly_DateCurrent) ?? 0,
      feature: perimeter(f, {
        name,
        year,
        acres,
        agency: str(p.attr_POOJurisdictionalAgency),
        t: date.toISOString(),
      }),
    });
  }
  return out;
}

/**
 * Merges both services into one polygon collection. WFIGS holds several perimeters per fire
 * (daily progression plus final) and the history view repeats some rows, so only the newest
 * perimeter per fire is kept.
 */
export function normalizeFirePerimeters(
  history: FeatureCollection,
  wfigs: FeatureCollection,
): FeatureCollection {
  const best = new Map<string, Candidate>();
  for (const c of [...fromHistory(history), ...fromWfigs(wfigs)]) {
    const current = best.get(c.key);
    if (!current || c.recency > current.recency) best.set(c.key, c);
  }
  return { type: "FeatureCollection", features: [...best.values()].map((c) => c.feature) };
}

const TRUNCATED_NOTE = "Showing the 2,000 largest fires; zoom in for all";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const firePerimeters = defineLayer({
  id: "fire-perimeters",
  title: "Wildfire perimeters",
  description:
    "Outlines of US wildfires from the National Interagency Fire Center: current fires (shown as the latest mapped perimeter) and past years. " +
    "Each polygon has name, year, acres, agency (when known), t (discovery date, or January 1 of the fire year for fires before 2020) and v (burned acres, from the mapped perimeter). " +
    "Use yearsBack (1 to 25, default 10) to choose how far back to go and minAcres (default 100) to hide small fires. " +
    "United States only; elsewhere it returns nothing. Perimeters are simplified for display, so acreage is approximate and edges are not survey-grade. " +
    "Each source returns at most 2,000 fires, largest first; when that cap is hit the result says so, so zoom in for the rest. " +
    "Prescribed burns are excluded. Fires smaller than minAcres, and rare older fires never mapped, will not appear. " +
    "Zoom in to a region under 60,000 km² (about a 200 km square) first.",
  coverage: "us",
  license: "Public domain (NIFC WFIGS)",
  requiredEnv: [],
  maxAreaKm2: 60_000,
  input: inputSchema,
  style: { geometry: "polygon", color: "#FF5A36", fillOpacity: 0.35 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const retrieved = new Date();
    const citation = {
      source: "NIFC Interagency Fire Perimeter History and WFIGS Interagency Perimeters (public domain)",
      url: "https://data-nifc.opendata.arcgis.com/",
      retrieved: retrieved.toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > firePerimeters.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${firePerimeters.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const startYear = retrieved.getUTCFullYear() - input.yearsBack;
    const wfigsStart = Math.max(startYear, WFIGS_FROM_YEAR);
    const [history, wfigs] = await Promise.all([
      startYear < WFIGS_FROM_YEAR
        ? arcgisQuery(ctx, HISTORY_URL, {
            where: historyWhere(startYear, input.minAcres),
            outFields: HISTORY_FIELDS,
            bbox: ctx.bbox,
            maxAllowableOffset: 0.0005,
            orderByFields: "GIS_ACRES DESC",
            cacheSuffix: "perimeters-history",
          })
        : Promise.resolve({ ok: true as const, fc: EMPTY, truncated: false }),
      arcgisQuery(ctx, WFIGS_URL, {
        where: wfigsWhere(wfigsStart, input.minAcres),
        outFields: WFIGS_FIELDS,
        bbox: ctx.bbox,
        maxAllowableOffset: 0.0005,
        orderByFields: "poly_GISAcres DESC",
        cacheSuffix: "perimeters-wfigs",
        // Current-year fires change daily, so keep this cache short.
        ttlSeconds: 3600,
      }),
    ]);

    if (!history.ok) return { error: history.error, hint: "upstream" };
    if (!wfigs.ok) return { error: wfigs.error, hint: "upstream" };

    return {
      kind: "geojson",
      data: normalizeFirePerimeters(history.fc, wfigs.fc),
      citation,
      ...(history.truncated || wfigs.truncated ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(firePerimeters);

export default firePerimeters;

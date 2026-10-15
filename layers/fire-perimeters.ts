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
 *
 * Smoke wide (2026-10-14, through runLayer): the far West -125,32,-110,45 (about 1.9 million km²), yearsBack 10, returned 451 fires
 * of 4,104 in 8.3 s (925 KB, 250 per service at 0.05 degrees), the Martin fire (431,754 acres) first. Asking 1,000 per service
 * timed out at 25 s twice, so the wide limit is 500.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type Attribute, type FieldHelp } from "./types";
import { NWCG_FIRE_SIZE, nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { LOWER_48_KM2, OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

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

/**
 * Most fires in a wide result, biggest first; shared between the two services when both are asked. Both services
 * simplify big perimeters slowly: 250 per service over the far West took 9 to 13 s, 1,000 timed out at 25 s (2026-10-14).
 */
const WIDE_LIMIT = 500;

/** Display simplification in degrees: 0.0005 in a normal view, about a 300th of a wide box's width (up to 0.1). */
export function offsetFor(bbox: BBox, wide = false): number {
  if (!wide) return 0.0005;
  return Math.min(0.1, Math.max(0.0005, Math.round(((bbox[2] - bbox[0]) / 300) * 10_000) / 10_000));
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const ATTRIBUTES: Attribute[] = [
  { key: "acres", type: "measure", label: "Acres burned", unit: "acres", encode: "size", presets: NWCG_FIRE_SIZE },
  { key: "year", type: "time", label: "Year" },
  { key: "agency", type: "category", label: "Agency" },
  nameAttribute(),
];

const ACRES: FieldHelp = {
  text:
    "Burned area in acres, measured from the mapped fire perimeter (GIS acres) by the National Interagency Fire Center's data; " +
    "outlines are simplified, so treat it as approximate.",
  unit: "acres",
  source: "NIFC Interagency Fire Perimeter History and WFIGS Interagency Perimeters",
  url: "https://data-nifc.opendata.arcgis.com/",
};

const HELP: Record<string, FieldHelp> = {
  acres: ACRES,
  v: ACRES,
  year: { text: "The fire year (the year the fire was discovered)." },
  t: { text: "When the fire was discovered; fires before 2020 show January 1 of their fire year because the history records only the year." },
  agency: { text: "The agency with jurisdiction where the fire started, as the record gives it." },
};

const CARD: CardSpec = {
  measure: { key: "acres", label: "Acres burned", unit: "acres" },
  facts: [
    { key: "year", label: "Year" },
    { key: "t", label: "Discovered", format: "date" },
    { key: "agency", label: "Agency" },
  ],
};

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
    "Over 60,000 km² (a 250 km square), up to the lower 48, it keeps the 500 largest fires.",
  coverage: "us",
  license: "Public domain (NIFC WFIGS)",
  requiredEnv: [],
  maxAreaKm2: 60_000,
  // Ranking fires costs one count and one ordered page per service, so any box up to the lower 48 answers.
  hardMaxAreaKm2: LOWER_48_KM2,
  wide: { orderBy: "acres burned", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("fire-perimeters"), fillOpacity: 0.35 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,

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

    const startYear = retrieved.getUTCFullYear() - input.yearsBack;
    const wfigsStart = Math.max(startYear, WFIGS_FROM_YEAR);
    const both = startYear < WFIGS_FROM_YEAR;
    // Wide (over 60,000 km²): biggest fires first, the strategy's limit shared between the services, coarser lines, and counts.
    const wide = ctx.wide === true;
    const wideLimit = wide ? (ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined;
    const ranked = {
      maxAllowableOffset: offsetFor(ctx.bbox, wide),
      ...(wideLimit !== undefined && { resultRecordCount: Math.floor(wideLimit / (both ? 2 : 1)), withCount: true }),
    };
    const [history, wfigs] = await Promise.all([
      both
        ? arcgisQuery(ctx, HISTORY_URL, {
            where: historyWhere(startYear, input.minAcres),
            outFields: HISTORY_FIELDS,
            bbox: ctx.bbox,
            ...ranked,
            orderByFields: "GIS_ACRES DESC",
            cacheSuffix: "perimeters-history",
          })
        : Promise.resolve({ ok: true as const, fc: EMPTY, truncated: false, total: 0 }),
      arcgisQuery(ctx, WFIGS_URL, {
        where: wfigsWhere(wfigsStart, input.minAcres),
        outFields: WFIGS_FIELDS,
        bbox: ctx.bbox,
        ...ranked,
        orderByFields: "poly_GISAcres DESC",
        cacheSuffix: "perimeters-wfigs",
        // Current-year fires change daily, so keep this cache short.
        ttlSeconds: 3600,
      }),
    ]);

    if (!history.ok) return { error: history.error, hint: "upstream" };
    if (!wfigs.ok) return { error: wfigs.error, hint: "upstream" };

    // The total is perimeter rows in both services, so a fire the history view repeats can count twice; close enough for a note.
    const total = wide && history.total !== undefined && wfigs.total !== undefined ? history.total + wfigs.total : undefined;
    return {
      kind: "geojson",
      data: normalizeFirePerimeters(history.fc, wfigs.fc),
      citation,
      ...(total !== undefined && { total }),
      ...((history.truncated || wfigs.truncated) && !wide ? { coverageNote: TRUNCATED_NOTE } : {}),
    };
  },
});

registerLayer(firePerimeters);

export default firePerimeters;

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
 * Containment (since 2026-10-18): WFIGS_Incident_Locations/FeatureServer/0 (the incident points, 2020 on, same org),
 *   IrwinID, PercentContained, ContainmentDateTime, FireOutDateTime (epoch ms), FireCauseGeneral. One bbox query (incidents
 *   of at least half minAcres discovered since the start year, cached 30 minutes) is joined to the WFIGS perimeters by IRWIN
 *   id (braces and case ignored), so the card says whether a fire is out, contained or how much is contained. Checked
 *   2026-10-18: eastern Oregon -121,42,-116.4,46.3 since 2025 held 245 incidents. A failed join leaves the perimeters as
 *   they were and says so.
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
const LOCATIONS_URL = `${ORG}/WFIGS_Incident_Locations/FeatureServer/0`;
const LOCATION_FIELDS = ["IrwinID", "PercentContained", "ContainmentDateTime", "FireOutDateTime", "FireCauseGeneral"];

/**
 * The jurisdiction codes the records use, in words (audit 2026-10-17: BLM, C&L, DL, ARNG, DOF and PRI were unreadable).
 * Codes not listed pass through as written.
 */
export const AGENCY_NAMES: Record<string, string> = {
  BLM: "Bureau of Land Management",
  USFS: "US Forest Service",
  FS: "US Forest Service",
  NPS: "National Park Service",
  FWS: "US Fish and Wildlife Service",
  USFWS: "US Fish and Wildlife Service",
  DNR: "State natural resources department",
  BIA: "Bureau of Indian Affairs",
  BOR: "Bureau of Reclamation",
  DOD: "Department of Defense",
  ARNG: "Army National Guard",
  DOE: "Department of Energy",
  ST: "State",
  STATE: "State",
  DOF: "State forestry department",
  DL: "State lands department",
  CNTY: "County",
  "C&L": "County or local",
  CITY: "City",
  PRI: "Private land",
  PVT: "Private land",
  TRIBE: "Tribal land",
  OTHR: "Other",
};

export function agencyName(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return AGENCY_NAMES[code.toUpperCase()] ?? code;
}

/** An IRWIN id without braces, upper case, so perimeter and incident records match. */
export const irwinKey = (id: unknown) => (typeof id === "string" && id.trim() ? id.replace(/[{}]/g, "").trim().toUpperCase() : undefined);

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
  if (fields.agency !== undefined) {
    properties.agency = agencyName(fields.agency) ?? fields.agency;
    properties.agencyCode = fields.agency;
  }
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
      // The history records only the year: mid-year, so a ten-year histogram does not stack every old fire on January 1.
      feature: perimeter(f, { name, year, acres, agency: str(p.AGENCY), t: `${year}-07-01T00:00:00.000Z` }),
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
    const feature = perimeter(f, {
      name,
      year,
      acres,
      agency: str(p.attr_POOJurisdictionalAgency),
      t: date.toISOString(),
    });
    const props = feature.properties as Record<string, string | number>;
    props.discovered = date.toISOString();
    const mapped = num(p.poly_DateCurrent);
    if (mapped !== undefined) props.lastMapped = new Date(mapped).toISOString();
    const irwin = irwinKey(p.poly_IRWINID);
    if (irwin !== undefined) props.irwinId = irwin;
    out.push({
      key: str(p.poly_IRWINID) ?? `${name.toLowerCase()}|${year}`,
      recency: num(p.poly_DateCurrent) ?? 0,
      feature,
    });
  }
  return out;
}

/** The feature's bounding box (every position of its geometry). */
function extentOf(feature: Feature<Geometry>): BBox | null {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      box[0] = Math.min(box[0], c[0]);
      box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]);
      box[3] = Math.max(box[3], c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  if ("coordinates" in feature.geometry) visit(feature.geometry.coordinates);
  return Number.isFinite(box[0]) ? box : null;
}

/** How much two boxes overlap: their intersection over their union, 0 to 1. */
function overlap(a: BBox, b: BBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: BBox) => (r[2] - r[0]) * (r[3] - r[1]);
  return (w * h) / (area(a) + area(b) - w * h);
}

/**
 * True for two perimeters of one fire filed by two agencies (Empire by NPS and EMPIRE by USFS, 2017): the same name in
 * any case, the same year, acres within 10% and nearly the same extent.
 */
function sameFire(a: Candidate, b: Candidate): boolean {
  const pa = a.feature.properties ?? {};
  const pb = b.feature.properties ?? {};
  if (String(pa.name).toLowerCase() !== String(pb.name).toLowerCase() || pa.year !== pb.year) return false;
  const [x, y] = [Number(pa.acres), Number(pb.acres)];
  if (!(Math.abs(x - y) <= 0.1 * Math.max(x, y))) return false;
  const ea = extentOf(a.feature);
  const eb = extentOf(b.feature);
  return ea !== null && eb !== null && overlap(ea, eb) >= 0.6;
}

/**
 * Merges both services into one polygon collection. WFIGS holds several perimeters per fire
 * (daily progression plus final) and the history view repeats some rows, so only the newest
 * perimeter per fire is kept; one fire filed by two agencies under different ids is kept once (the larger).
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
  const kept: Candidate[] = [];
  for (const c of [...best.values()].sort((a, b) => Number(b.feature.properties?.acres) - Number(a.feature.properties?.acres))) {
    if (!kept.some((k) => sameFire(k, c))) kept.push(c);
  }
  return { type: "FeatureCollection", features: kept.map((c) => c.feature) };
}

export type Incident = { contained?: number; containedAt?: number; outAt?: number; cause?: string };

/** Incident points by IRWIN id, from a WFIGS_Incident_Locations answer. */
export function incidentsById(fc: FeatureCollection): Map<string, Incident> {
  const out = new Map<string, Incident>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const id = irwinKey(p.IrwinID);
    if (id === undefined) continue;
    out.set(id, {
      ...(num(p.PercentContained) !== undefined && { contained: num(p.PercentContained) }),
      ...(num(p.ContainmentDateTime) !== undefined && { containedAt: num(p.ContainmentDateTime) }),
      ...(num(p.FireOutDateTime) !== undefined && { outAt: num(p.FireOutDateTime) }),
      ...(str(p.FireCauseGeneral) !== undefined && { cause: str(p.FireCauseGeneral) }),
    });
  }
  return out;
}

/**
 * Adds the go/no-go facts to each perimeter whose incident is known: `status` (out, contained or active), `contained` (%),
 * `outDate`, `containedDate` and `cause`; the incident id is dropped once used. Returns how many perimeters were joined.
 */
export function joinIncidents(fc: FeatureCollection, incidents: Map<string, Incident>): number {
  let joined = 0;
  for (const f of fc.features) {
    const p = f.properties as Record<string, string | number> | null;
    if (!p) continue;
    const id = typeof p.irwinId === "string" ? p.irwinId : undefined;
    delete p.irwinId;
    const inc = id === undefined ? undefined : incidents.get(id);
    if (!inc) continue;
    joined += 1;
    if (inc.outAt !== undefined) {
      p.status = "out";
      p.outDate = new Date(inc.outAt).toISOString();
    } else if (inc.containedAt !== undefined || (inc.contained ?? 0) >= 100) {
      p.status = "contained";
    } else {
      p.status = "active";
    }
    if (inc.containedAt !== undefined) p.containedDate = new Date(inc.containedAt).toISOString();
    // A fire out or contained is 100% contained even when its last percent report was older (Tamarack: 84%, then out).
    if (p.status !== "active") p.contained = 100;
    else if (inc.contained !== undefined) p.contained = inc.contained;
    if (inc.cause !== undefined) p.cause = inc.cause;
  }
  return joined;
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
  // Agency stays the row's default chip set (the shared layers/attributes.test.ts holds it); status follows and is the key.
  { key: "agency", type: "category", label: "Agency" },
  {
    key: "status",
    type: "category",
    label: "Status",
    levels: [
      { value: "active", label: "Still burning", help: "Not yet fully contained." },
      { value: "contained", label: "Contained", help: "A control line holds all the way around; may still smoulder inside." },
      { value: "out", label: "Out", help: "Declared out by the fire managers." },
    ],
  },
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
  t: { text: "When the fire was discovered; fires before 2020 are placed mid-year (July 1) because the history records only the year." },
  discovered: { text: "When the fire was discovered (2020 on; the older history records only the year)." },
  agency: { text: "The agency with jurisdiction where the fire started, in words (the record's code is agencyCode)." },
  contained: {
    text: "How much of the fire's edge has a control line, as the incident last reported it; 100% means contained.",
    unit: "%",
    source: "NIFC WFIGS Incident Locations",
    url: "https://data-nifc.opendata.arcgis.com/",
  },
  status: { text: "Out (declared out), Contained (a line all the way around) or Still burning, from the incident record (2020 on)." },
  lastMapped: { text: "When this perimeter was last mapped; a fire still burning can have grown since." },
};

const CARD: CardSpec = {
  measure: { key: "acres", label: "Acres burned", unit: "acres" },
  facts: [
    { key: "status", label: "Status", values: { active: "Still burning", contained: "Contained", out: "Out" } },
    { key: "contained", label: "Contained", unit: "%", format: "int" },
    { key: "outDate", label: "Declared out", format: "date" },
    { key: "lastMapped", label: "Perimeter last mapped", format: "date" },
    { key: "discovered", label: "Discovered", format: "date" },
    { key: "year", label: "Year" },
    { key: "cause", label: "Cause" },
    { key: "agency", label: "Agency" },
  ],
  hidden: ["agencyCode", "containedDate", "t", "v"],
};

const firePerimeters = defineLayer({
  id: "fire-perimeters",
  title: "Wildfire perimeters",
  description:
    "Outlines of US wildfires from the National Interagency Fire Center: current fires (shown as the latest mapped perimeter) and past years. " +
    "Each polygon has name, year, acres, agency (in words, when known), t (discovery date, or July 1 of the fire year for fires before 2020) and v (burned acres, from the mapped perimeter). " +
    "Fires from 2020 on also have status ('active' still burning, 'contained' or 'out'), contained (percent of the edge contained), outDate, lastMapped (when the perimeter was last mapped; a burning fire may have grown since), discovered and cause, from the incident record. " +
    "Use yearsBack (1 to 25, default 10) to choose how far back to go and minAcres (default 100) to hide small fires. " +
    "United States only; elsewhere it returns nothing. Perimeters are simplified for display, so acreage is approximate and edges are not survey-grade. " +
    "Each source returns at most 2,000 fires, largest first; when that cap is hit the result says so, so zoom in for the rest. " +
    "Prescribed burns are excluded. Fires smaller than minAcres, and rare older fires never mapped, will not appear. " +
    "Over 60,000 km² (a 250 km square), up to the lower 48, it keeps the 500 largest fires.",
  coverage: "us",
  surface: "land",
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
  // The biggest fires carry their names on the map.
  labels: { field: "name", max: 5, rankBy: "acres" },

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
    // The incident points (containment, out date) for the WFIGS years, asked alongside the perimeters.
    const locations = arcgisQuery(ctx, LOCATIONS_URL, {
      where: `FireDiscoveryDateTime >= DATE '${wfigsStart}-01-01' AND IncidentSize >= ${input.minAcres / 2}`,
      outFields: LOCATION_FIELDS,
      bbox: ctx.bbox,
      maxRecords: 2000,
      orderByFields: "IncidentSize DESC",
      cacheSuffix: "perimeters-incidents",
      ttlSeconds: 1800,
    });
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
    const incidents = await locations;

    // The total is perimeter rows in both services, so a fire the history view repeats can count twice; close enough for a note.
    const total = wide && history.total !== undefined && wfigs.total !== undefined ? history.total + wfigs.total : undefined;
    const data = normalizeFirePerimeters(history.fc, wfigs.fc);
    const notes: string[] = [];
    if (incidents.ok) joinIncidents(data, incidentsById(incidents.fc));
    else {
      joinIncidents(data, new Map());
      notes.push("Containment could not be loaded right now, so the fires' status is not shown");
    }
    if ((history.truncated || wfigs.truncated) && !wide) notes.push(TRUNCATED_NOTE);
    return {
      kind: "geojson",
      data,
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 && { coverageNote: notes.join("; ") }),
    };
  },
});

registerLayer(firePerimeters);

export default firePerimeters;

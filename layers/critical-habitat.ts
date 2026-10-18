/**
 * US Fish and Wildlife Service critical habitat for threatened and endangered species.
 * Service (verified live 2026-10-09, keyless):
 *   https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer
 *   layer 0 "Final Critical Habitat Features" (polygons, maxRecordCount 1000)
 *   layer 2 "Proposed Critical Habitat Features" (same fields; proposed rule, not yet in force)
 * Fields used: comname (common name), sciname (scientific name), status ("Final" | "Proposed"),
 *   listing_status ("Endangered" | "Threatened" | "Proposed Endangered" | "Proposed Threatened"),
 *   pubdate (YYYYMMDD Federal Register publication date, string), fedreg (Federal Register citation).
 *   unitname, subunitname and effectdate mostly hold the placeholder "Please check current species specific
 *   shapefile", so they are not used.
 * Output properties: species (common name, else scientific), scientificName, status, listingStatus,
 * federalRegister, t (publication date), kind (the species name, for filtering).
 * Smoke through runLayer (2026-10-09): Lake Tahoe box -120.4,38.7,-119.8,39.3 returned 1 polygon (Sierra Nevada
 * yellow-legged frog) in 0.5 s; San Bernardino box -117.5,34,-116,35.2 returned 20 units (302 KB); Oregon Cascades
 * -122,43,-119,46 returned 3 species in 0.8 s (1.0 MB, mostly the northern spotted owl); the proposed layer returned
 * Quitobaquito tryonia for -113.1,31.9,-112.9,32.0. Units are simplified by an offset that grows with the view
 * (see simplifyOffset) because one unit can be a whole river system.
 * Smoke wide (2026-10-14): California -124,32,-114,42 (about 1 million km²) returned 127 units of 148 (final plus proposed) in
 * 1.1 s (392 KB); the 21 missing are too small to survive the 0.05 degree simplification, so the note sends the reader closer.
 * 2026-10-18: the service ignores maxAllowableOffset in its GeoJSON (Joshua Tree box -117.1,33.75,-115.7,34.45: 19 units,
 * 38,536 vertices 0.002 degrees apart, 701 KB), so rings are thinned here to the same offset (thinGeometry). Units are filled
 * by listing status (endangered pink, threatened purple, proposed for listing sage) with a legend; species and status are chips;
 * the card says what a designation means and links the Federal Register rule.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";

const SERVICE = "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer";
const FINAL_LAYER = `${SERVICE}/0`;
const PROPOSED_LAYER = `${SERVICE}/2`;

const FIELDS = ["comname", "sciname", "status", "listing_status", "pubdate", "fedreg"];

/** Designations change a few times a year at most. */
const TTL_SECONDS = 86_400;
const MAX_RECORDS = 1000;

const TRUNCATED_NOTE = "Showing the first 1,000 habitat units in view; zoom in or name a species for the rest";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const inputSchema = z.object({
  species: z.string().trim().min(1).max(80).optional(),
  includeProposed: z.boolean().default(true),
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Display simplification in degrees: finer when zoomed in, coarser over a wide view (one unit can be a whole river system).
 * A wide box (over the soft cap) may go coarser still, up to 0.05 degrees, to keep the payload small.
 */
export function simplifyOffset(bbox: BBox, wide = false): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(wide ? 0.05 : 0.03, Math.max(0.001, span / 150));
}

/** SQL string literal body: quotes doubled, LIKE wildcards stripped so a name cannot widen the match. */
function sqlText(value: string): string {
  return value.replace(/[%_]/g, "").replace(/'/g, "''").toUpperCase();
}

/** Where clause matching a species by part of its common or scientific name; undefined means no filter. */
export function speciesWhere(species: string | undefined): string | undefined {
  if (species === undefined) return undefined;
  const text = sqlText(species);
  if (text.trim() === "") return undefined;
  return `UPPER(comname) LIKE '%${text}%' OR UPPER(sciname) LIKE '%${text}%'`;
}

/** `YYYYMMDD` to `YYYY-MM-DD`; undefined for anything else (the service sometimes holds text). */
function publishedOn(raw: unknown): string | undefined {
  const text = str(raw);
  if (text === undefined || !/^\d{8}$/.test(text)) return undefined;
  const date = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? undefined : date;
}

/** A ring without vertices within `step` degrees of the last kept one; null when it collapses below four positions. */
function thinRing(ring: Position[], step: number): Position[] | null {
  if (ring.length < 4) return null;
  const r4 = (p: Position): Position => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
  const out: Position[] = [r4(ring[0])];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.abs(ring[i][0] - last[0]) >= step || Math.abs(ring[i][1] - last[1]) >= step) out.push(r4(ring[i]));
  }
  out.push(out[0]);
  return out.length >= 4 ? out : null;
}

/**
 * Display geometry thinned to `step` degrees (the offset the service was asked for and ignores). Holes and parts that
 * collapse are dropped; a unit whose every part would collapse is kept as sent, so no unit disappears.
 */
export function thinGeometry(geometry: Geometry, step: number): Geometry {
  const polygon = (rings: Position[][]): Position[][] | null => {
    const outer = thinRing(rings[0] ?? [], step);
    return outer === null ? null : [outer, ...rings.slice(1).map((r) => thinRing(r, step)).filter((r): r is Position[] => r !== null)];
  };
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: polygon(geometry.coordinates) ?? geometry.coordinates };
  if (geometry.type === "MultiPolygon") {
    const parts = geometry.coordinates.map(polygon).filter((p): p is Position[][] => p !== null);
    return { type: "MultiPolygon", coordinates: parts.length > 0 ? parts : geometry.coordinates };
  }
  return geometry;
}

/** "78FR10449 10497" to "78 FR 10449"; undefined when the citation does not read as volume FR page. */
export function federalRegisterCitation(raw: string): { text: string; url: string } | undefined {
  const m = /^\s*(\d+)\s*FR\s*(\d+)/i.exec(raw);
  if (!m) return undefined;
  return { text: `${m[1]} FR ${m[2]}`, url: `https://www.federalregister.gov/citation/${m[1]}-FR-${m[2]}` };
}

/** What a designation means for a visitor, on every unit's card. */
export const MEANING = "Applies to federal projects, funding and permits; it does not close the land or limit visits by itself";

/** Converts service rows to polygons with readable property names and `kind` (species); `step` thins the outlines. */
export function normalizeCriticalHabitat(fc: FeatureCollection, step?: number): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const common = str(p.comname);
    const scientific = str(p.sciname);
    const species = common ?? scientific ?? "Unnamed species";
    const properties: Record<string, string> = { species, kind: species };
    if (scientific !== undefined) properties.scientificName = scientific;
    const status = str(p.status);
    if (status !== undefined) properties.status = status;
    const listing = str(p.listing_status);
    if (listing !== undefined) properties.listingStatus = listing;
    const fedreg = str(p.fedreg);
    if (fedreg !== undefined) {
      const cite = federalRegisterCitation(fedreg);
      properties.federalRegister = cite?.text ?? fedreg;
      if (cite) properties.ruleUrl = cite.url;
    }
    const published = publishedOn(p.pubdate);
    if (published !== undefined) properties.published = published;
    properties.meaning = MEANING;
    features.push({ type: "Feature", geometry: step === undefined ? f.geometry : thinGeometry(f.geometry, step), properties });
  }
  return { type: "FeatureCollection", features };
}

const FWS_SOURCE = { source: "US Fish and Wildlife Service, Critical Habitat", url: "https://ecos.fws.gov/ecp/report/table/critical-habitat.html" };

/** Listing status as the map fills it: endangered pink, threatened purple, proposed for either sage. */
const LISTING_LEVELS = [
  { value: "Endangered", label: "Endangered", color: PINK, help: "In danger of extinction throughout all or much of its range." },
  { value: "Threatened", label: "Threatened", color: PURPLE, help: "Likely to become endangered in the foreseeable future." },
  { value: "Proposed Endangered", label: "Proposed for listing", color: SAGE, help: "Proposed for listing as endangered or threatened; not yet listed." },
  { value: "Proposed Threatened", label: "Proposed for listing", color: SAGE, help: "Proposed for listing as endangered or threatened; not yet listed." },
];

/**
 * One key entry per label: both proposed statuses share "Proposed for listing" (the attribute levels keep both values,
 * so its chip and its fill cover both).
 */
export const CRITICAL_HABITAT_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Species listed as",
  field: "listingStatus",
  items: LISTING_LEVELS.filter((l, i) => LISTING_LEVELS.findIndex((m) => m.label === l.label) === i).map(({ value, label, color, help }) => ({
    label,
    value,
    color,
    symbol: "polygon" as const,
    help,
  })),
  note: "Critical habitat binds federal actions and permits; it is not a closure.",
};

const ATTRIBUTES: Attribute[] = [
  // The map fills areas by the primary chip set, so listing status is primary: the fill, the key and the chips agree.
  {
    key: "listingStatus",
    type: "category",
    label: "Listed as",
    encode: "color",
    primary: true,
    levels: LISTING_LEVELS.map(({ value, label, help }) => ({ value, label, help })),
  },
  { key: "species", type: "category", label: "Species" },
  {
    key: "status",
    type: "category",
    label: "Designation",
    levels: [
      { value: "Final", label: "Final (in force)" },
      { value: "Proposed", label: "Proposed (not yet in force)" },
    ],
  },
];

const HELP: Record<string, FieldHelp> = {
  meaning: { text: "Critical habitat requires federal agencies to make sure the projects they fund, permit or carry out do not destroy or harm it. It does not create a refuge, close the land, or restrict private activity without a federal permit.", ...FWS_SOURCE },
  status: { text: "Final means the designation is in force; Proposed means it is a proposed rule, not yet in force.", ...FWS_SOURCE },
  listingStatus: { text: "How the species is listed under the Endangered Species Act: Endangered or Threatened (or proposed for either).", ...FWS_SOURCE },
  federalRegister: { text: "The Federal Register citation of the rule that designated the habitat: the volume, FR, then the page.", ...FWS_SOURCE },
};

const CARD: CardSpec = {
  facts: [
    { key: "species", label: "Species" },
    { key: "scientificName", label: "Scientific name" },
    { key: "listingStatus", label: "Listed as" },
    { key: "status", label: "Designation", values: { Final: "Final (in force)", Proposed: "Proposed (not yet in force)" } },
    { key: "published", label: "Rule published", format: "date" },
    { key: "meaning", label: "What it means" },
    { key: "federalRegister", label: "Federal Register rule" },
  ],
  links: [{ key: "ruleUrl", label: "Read the rule" }],
  /** Kind is the species again, kept for filtering. */
  hidden: ["kind"],
};

const criticalHabitat = defineLayer({
  id: "critical-habitat",
  title: "Critical habitat",
  description:
    "Areas the US Fish and Wildlife Service has designated as critical habitat for threatened and endangered species, drawn as polygons: the land and water a listed species needs to survive and recover. " +
    "Each polygon has species (common name), scientificName, status (Final means in force, Proposed means a proposed rule), listingStatus (Endangered or Threatened), federalRegister (the rule's citation, such as 78 FR 10449) and ruleUrl, published (the date the rule was published), meaning and kind (the species, for filtering). " +
    "The map fills units by listing status (endangered pink, threatened purple, proposed for listing sage) with a legend, and species chips split a crowded map by animal. " +
    "Use it for 'endangered species habitat', 'where do protected animals live here', or 'is there critical habitat on this trail or river', and to see which listed species have habitat in view. " +
    "Set species to part of a common or scientific name (for example 'bull trout', 'desert tortoise', 'Rana') to show one species; includeProposed (default true) adds proposed designations. " +
    "Caveats: critical habitat only binds federal actions and permits, so it is not a closure and does not by itself mean entry is restricted. " +
    "Many listed species have no critical habitat designated, so an empty map does not mean no protected species are present; the species layer shows sightings. " +
    "Boundaries are simplified for display and some units are drawn coarsely; do not use them for legal or permit decisions. " +
    "United States only; elsewhere it returns nothing. Over 300,000 km² (about a 550 km square) it keeps the 1,000 largest units and gives the total.",
  coverage: "us",
  surface: "any",
  license: "Public domain (US Fish and Wildlife Service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
  wide: { orderBy: "area", limit: MAX_RECORDS },
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("critical-habitat"), fillOpacity: 0.25 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: CRITICAL_HABITAT_LEGEND,
  labels: { field: "species", max: 6 },
  // Designations in force now; the rule date is a fact on the card.
  time: { shape: "none" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Fish and Wildlife Service, Critical Habitat for Threatened and Endangered Species (public domain)",
      url: "https://ecos.fws.gov/ecp/report/table/critical-habitat.html",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const where = speciesWhere(input.species);
    // Wide (over 300,000 km²): largest units first, capped at the strategy's limit, coarser lines, and a count per layer.
    const wide = ctx.wide === true;
    const common = {
      where,
      outFields: FIELDS,
      bbox: ctx.bbox,
      resultRecordCount: Math.min(MAX_RECORDS, (wide ? ctx.wideStrategy?.limit : undefined) ?? MAX_RECORDS),
      maxAllowableOffset: simplifyOffset(ctx.bbox, wide),
      ...(wide && { orderByFields: "Shape__Area DESC", withCount: true }),
      ttlSeconds: TTL_SECONDS,
    };
    const [finalRes, proposedRes] = await Promise.all([
      arcgisQuery(ctx, FINAL_LAYER, { ...common, cacheSuffix: "ch-final" }),
      input.includeProposed ? arcgisQuery(ctx, PROPOSED_LAYER, { ...common, cacheSuffix: "ch-proposed" }) : Promise.resolve(null),
    ]);

    if (!finalRes.ok) return { error: finalRes.error, hint: "upstream" };

    const notes: string[] = [];
    const step = simplifyOffset(ctx.bbox, wide);
    const features = normalizeCriticalHabitat(finalRes.fc, step).features;
    let truncated = finalRes.truncated;
    if (proposedRes !== null) {
      if (proposedRes.ok) {
        features.push(...normalizeCriticalHabitat(proposedRes.fc, step).features);
        truncated = truncated || proposedRes.truncated;
      } else {
        notes.push("Proposed critical habitat could not be loaded; only final designations are shown");
      }
    }
    if (truncated && !wide) notes.push(TRUNCATED_NOTE);
    // The total adds the proposed count only when the proposed layer was asked for and answered one.
    const total =
      finalRes.total === undefined
        ? undefined
        : proposedRes === null
          ? finalRes.total
          : proposedRes.ok && proposedRes.total !== undefined
            ? finalRes.total + proposedRes.total
            : undefined;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(criticalHabitat);

export default criticalHabitat;

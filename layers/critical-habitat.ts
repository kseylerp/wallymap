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
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type BBox, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

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

/** Display simplification in degrees: finer when zoomed in, coarser over a wide view (one unit can be a whole river system). */
export function simplifyOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.min(0.03, Math.max(0.001, span / 150));
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

/** `YYYYMMDD` to an ISO timestamp; undefined for anything else (the service sometimes holds text). */
function publishedAt(raw: unknown): string | undefined {
  const text = str(raw);
  if (text === undefined || !/^\d{8}$/.test(text)) return undefined;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** Converts service rows to polygons with readable property names, `kind` (species) and `t`. */
export function normalizeCriticalHabitat(fc: FeatureCollection): FeatureCollection {
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
    if (fedreg !== undefined) properties.federalRegister = fedreg;
    const t = publishedAt(p.pubdate);
    if (t !== undefined) properties.t = t;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const criticalHabitat = defineLayer({
  id: "critical-habitat",
  title: "Critical habitat",
  description:
    "Areas the US Fish and Wildlife Service has designated as critical habitat for threatened and endangered species, drawn as polygons: the land and water a listed species needs to survive and recover. " +
    "Each polygon has species (common name), scientificName, status (Final means in force, Proposed means a proposed rule), listingStatus (Endangered or Threatened), federalRegister (the rule's citation), t (when the designation was published) and kind (the species, for filtering). " +
    "Use it for 'endangered species habitat', 'where do protected animals live here', or 'is there critical habitat on this trail or river', and to see which listed species have habitat in view. " +
    "Set species to part of a common or scientific name (for example 'bull trout', 'desert tortoise', 'Rana') to show one species; includeProposed (default true) adds proposed designations. " +
    "Caveats: critical habitat only binds federal actions and permits, so it is not a closure and does not by itself mean entry is restricted. " +
    "Many listed species have no critical habitat designated, so an empty map does not mean no protected species are present; the species layer shows sightings. " +
    "Boundaries are simplified for display and some units are drawn coarsely; do not use them for legal or permit decisions. " +
    "United States only; elsewhere it returns nothing. Zoom in to a region under 300,000 km² (about a 550 km square) first.",
  coverage: "us",
  license: "Public domain (US Fish and Wildlife Service)",
  requiredEnv: [],
  maxAreaKm2: 300_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("critical-habitat"), fillOpacity: 0.25 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Fish and Wildlife Service, Critical Habitat for Threatened and Endangered Species (public domain)",
      url: "https://ecos.fws.gov/ecp/report/table/critical-habitat.html",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > criticalHabitat.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${criticalHabitat.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const where = speciesWhere(input.species);
    const common = {
      where,
      outFields: FIELDS,
      bbox: ctx.bbox,
      maxRecords: MAX_RECORDS,
      maxAllowableOffset: simplifyOffset(ctx.bbox),
      ttlSeconds: TTL_SECONDS,
    };
    const [finalRes, proposedRes] = await Promise.all([
      arcgisQuery(ctx, FINAL_LAYER, { ...common, cacheSuffix: "ch-final" }),
      input.includeProposed ? arcgisQuery(ctx, PROPOSED_LAYER, { ...common, cacheSuffix: "ch-proposed" }) : Promise.resolve(null),
    ]);

    if (!finalRes.ok) return { error: finalRes.error, hint: "upstream" };

    const notes: string[] = [];
    const features = normalizeCriticalHabitat(finalRes.fc).features;
    let truncated = finalRes.truncated;
    if (proposedRes !== null) {
      if (proposedRes.ok) {
        features.push(...normalizeCriticalHabitat(proposedRes.fc).features);
        truncated = truncated || proposedRes.truncated;
      } else {
        notes.push("Proposed critical habitat could not be loaded; only final designations are shown");
      }
    }
    if (truncated) notes.push(TRUNCATED_NOTE);

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(criticalHabitat);

export default criticalHabitat;

/**
 * Unpatented mining claims on US public land, from the Bureau of Land Management's Mineral and Land Records System (MLRS).
 * Service (verified live 2026-10-10, keyless, f=geojson works, maxRecordCount 2000):
 *   https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer
 *   layer 1 = Active Mining Claims, layer 2 = Closed Mining Claims, layer 0 = Case (the claim cases without geometry).
 *   Polygon layers. The host answers curl and Node but returned 403 to Python's default user agent.
 * Fields used: CSE_NAME (claim name, e.g. "ULI-13"), CSE_NR (case number, e.g. "UT101570964"), CSE_DISP ("Active", "Appeal - Stay Granted",
 *   "Closed", ...), BLM_PROD (claim type: "Lode Claim", "Placer Claim", "Mill Site", "Tunnel Site", "... - National Park"), RCRD_ACRS (recorded
 *   acres), QLTY (a long data-quality note beginning "1: MIDPOINT" .. "10: ..."; only its first line is kept), MC_PATENTED.
 *   The shapes come from the legal land description mapped onto the Public Land Survey System, so a claim is drawn as the quarter-quarter
 *   section or section its description names, not as surveyed. Many claims share one drawn square.
 * Density (Moab, UT): 328 active and 2,280 closed claims in a 0.2 x 0.2 degree box, 2,438 and 28,528 in 0.6 x 0.6. Hence a small area limit
 *   (2,500 km2), a 2,000-per-status cap and no tiles. A 2,000-claim answer is 200 KB for active and 1.5 MB for closed claims at full precision;
 *   the layer simplifies by 0.0001 degrees (about 10 m), which keeps the square corners.
 * Output: v = recorded acres, kind = "active" | "closed", plus name, caseNumber, claimType, disposition, acres, locationQuality, patented.
 * Smoke check 2026-10-10 (live, through runLayer): Moab box -109.8,38.4,-109.4,38.7 returned 1,346 active claims in 0.9 s (WES-1, a 20.66 acre
 *   lode claim, case UT105832859); with status both it hit the 2,000 closed-claim cap (3,346 claims in 0.5 s); a Los Angeles forest box
 *   -118.5,34,-118,34.4 returned 1 active claim (AN 30). One cold call to the service took 17 s once, so expect the occasional slow answer.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const SERVICE_URL = "https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer";
export const LAYERS = { active: 1, closed: 2 } as const;
export type Status = keyof typeof LAYERS;
const FIELDS = ["CSE_NAME", "CSE_NR", "CSE_DISP", "BLM_PROD", "RCRD_ACRS", "QLTY", "MC_PATENTED"];
/** Claim records change as filings arrive, but a day is fresh enough. */
const TTL_SECONDS = 86_400;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Service rows to claim polygons; `status` becomes `kind`. */
export function normalizeClaims(fc: FeatureCollection, status: Status): Feature<Geometry>[] {
  const out: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { name: str(p.CSE_NAME) ?? "Unnamed claim", kind: status };
    const caseNumber = str(p.CSE_NR);
    if (caseNumber !== undefined) properties.caseNumber = caseNumber;
    const claimType = str(p.BLM_PROD);
    if (claimType !== undefined) properties.claimType = claimType;
    const disposition = str(p.CSE_DISP);
    if (disposition !== undefined) properties.disposition = disposition;
    const acres = num(p.RCRD_ACRS);
    if (acres !== undefined) {
      properties.acres = acres;
      properties.v = acres;
    }
    const quality = str(p.QLTY)?.split("\n")[0].trim();
    if (quality) properties.locationQuality = quality;
    const patented = str(p.MC_PATENTED);
    if (patented !== undefined) properties.patented = patented;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

const miningClaims = defineLayer({
  id: "mining-claims",
  title: "Mining claims",
  description:
    "Unpatented mining claims on federal land in the western United States, from the Bureau of Land Management's mining claim records: claims a person or company has staked to look for or mine minerals, which can limit other uses of the ground. " +
    "Each polygon has name, caseNumber, claimType (lode, placer, mill site or tunnel site), disposition, kind ('active' or 'closed'), v and acres (recorded acres, typically 20 for a placer claim), and locationQuality. " +
    "status picks 'active' (default, claims still held), 'closed' (claims that lapsed or were relinquished, far more numerous) or 'both'. " +
    "Use it for 'are there mining claims here', 'active claims near Moab', 'uranium claims on this mesa', 'how many claims are in this area' or 'is this land staked'. " +
    "Claims are drawn from their legal land descriptions on the survey grid, so a claim shows as the quarter-quarter section or section it names, not its actual corners, and many claims share one square; do not use it to decide where it is safe to stake or camp. " +
    "It does not say what mineral a claim is for. Western public lands mostly; elsewhere it returns nothing. " +
    "At most 2,000 claims per status are returned, and the result says when that cap is hit. " +
    "Zoom in to a region under 2,500 km² (about a 50 km square) first.",
  coverage: "us",
  license: "Public domain (US Bureau of Land Management, MLRS)",
  requiredEnv: [],
  maxAreaKm2: 2_500,
  input: z.object({
    status: z
      .enum(["active", "closed", "both"])
      .default("active")
      .describe("Which claims: 'active' (default), 'closed' (lapsed or relinquished) or 'both'."),
  }),
  style: { geometry: "polygon", color: layerColor("mining-claims"), fillOpacity: 0.25 },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Bureau of Land Management, Mineral and Land Records System (MLRS) mining claims",
      url: "https://www.blm.gov/services/geospatial/GISData/mining-claims",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > miningClaims.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${miningClaims.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const statuses: Status[] = input.status === "both" ? ["active", "closed"] : [input.status];
    const results = await Promise.all(
      statuses.map((status) =>
        arcgisQuery(ctx, `${SERVICE_URL}/${LAYERS[status]}`, {
          outFields: FIELDS,
          bbox: ctx.bbox,
          maxAllowableOffset: 0.0001,
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: `mining-claims:${status}`,
        }),
      ),
    );

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    results.forEach((res: ArcgisResult, i) => {
      const status = statuses[i];
      if (!res.ok) {
        failed.push(`${status} claims (${res.error})`);
        return;
      }
      features.push(...normalizeClaims(res.fc, status));
      if (res.truncated) notes.push(`Showing 2,000 ${status} claims; zoom in for the rest`);
    });
    if (failed.length === statuses.length) {
      return { error: `Mining claims unavailable: ${failed.join("; ")}`, hint: "upstream" };
    }
    if (failed.length > 0) notes.push(`Missing the ${failed.join(" and the ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push(input.status === "both" ? "No mining claims in this area" : `No ${input.status} mining claims in this area`);
    }
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(miningClaims);

export default miningClaims;

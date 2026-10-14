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
 * Order: active claims first (statuses are queried and listed in that order), then newest case number first within a status.
 *   The service has no filing or location date, and ordering it by case number server-side took 14 s on the closed layer, so the
 *   2,000 cap keeps whichever claims the server returns first; the cap note says so.
 * Output: v = recorded acres, kind = "active" | "closed", plus name, caseNumber, claimType, disposition, acres, locationQuality, patented.
 * Smoke check 2026-10-10 (live, through runLayer): Moab box -109.8,38.4,-109.4,38.7 returned 1,346 active claims in 0.9 s (WES-1, a 20.66 acre
 *   lode claim, case UT105832859); with status both it hit the 2,000 closed-claim cap (3,346 claims in 0.5 s); a Los Angeles forest box
 *   -118.5,34,-118,34.4 returned 1 active claim (AN 30). One cold call to the service took 17 s once, so expect the occasional slow answer.
 * Wide (over 2,500 km², up to 10,000): named claims only (CSE_NAME > ' '), 2,000 split between the statuses asked, plus a count of every
 *   claim in the box. Smoke 2026-10-14 could not run: the whole gis.blm.gov/nlsdb server answered 404 (the BLM recreation services had
 *   moved to gis.blm.gov/natl the same day), so the wide path is checked by tests only.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisCount, arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const SERVICE_URL = "https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer";
export const LAYERS = { active: 1, closed: 2 } as const;
export type Status = keyof typeof LAYERS;
const FIELDS = ["CSE_NAME", "CSE_NR", "CSE_DISP", "BLM_PROD", "RCRD_ACRS", "QLTY", "MC_PATENTED"];
/** Claim records change as filings arrive, but a day is fresh enough. */
const TTL_SECONDS = 86_400;
/** Most claims per status in a view; also the wide limit. */
const MAX_CLAIMS = 2000;
/** Wide views keep named claims only ("sorts after a space" also skips blank names, and avoids IS NOT NULL ... AND). */
export const NAMED = "CSE_NAME > ' '";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Newest case numbers first ("UT106362534" before "UT101678581"); a claim without one goes last. */
export function byCaseNumberDesc(a: Feature<Geometry>, b: Feature<Geometry>): number {
  return String(b.properties?.caseNumber ?? "").localeCompare(String(a.properties?.caseNumber ?? ""));
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
    "BLM mining claims on US public land (mostly the West): staked claims for minerals that can limit other land use. Each polygon has name, caseNumber, claimType (lode, placer, mill site, tunnel site), disposition, kind ('active' or 'closed'), v and acres, and locationQuality. status picks active (default), closed (lapsed, far more) or both. Claims are drawn from legal descriptions on the survey grid, so a claim shows as the section or quarter-section named, not its corners, and many share one square; do not use it to decide where to stake or camp. No mineral is named. At most 2,000 per status; over 2,500 km², 2,000 named claims and the total.",
  coverage: "us",
  license: "Public domain (US Bureau of Land Management, MLRS)",
  requiredEnv: [],
  maxAreaKm2: 2_500,
  wide: { mode: "named", limit: MAX_CLAIMS },
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

    const statuses: Status[] = input.status === "both" ? ["active", "closed"] : [input.status];
    // Wide (over 2,500 km²): named claims only, the limit shared between the statuses asked, and a count of every claim
    // in the box for the note.
    const wide = ctx.wide === true && ctx.wideStrategy !== undefined;
    const perStatus = wide ? Math.floor((ctx.wideStrategy?.limit ?? MAX_CLAIMS) / statuses.length) : MAX_CLAIMS;
    const [results, counts] = await Promise.all([
      Promise.all(
        statuses.map((status) =>
          arcgisQuery(ctx, `${SERVICE_URL}/${LAYERS[status]}`, {
            outFields: FIELDS,
            where: wide ? NAMED : undefined,
            bbox: ctx.bbox,
            resultRecordCount: perStatus,
            maxAllowableOffset: 0.0001,
            ttlSeconds: TTL_SECONDS,
            cacheSuffix: `mining-claims:${status}`,
          }),
        ),
      ),
      wide
        ? Promise.all(
            statuses.map((status) =>
              arcgisCount(ctx, `${SERVICE_URL}/${LAYERS[status]}`, { bbox: ctx.bbox, ttlSeconds: TTL_SECONDS, cacheSuffix: `mining-claims:${status}` }),
            ),
          )
        : null,
    ]);

    const features: Feature<Geometry>[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    results.forEach((res: ArcgisResult, i) => {
      const status = statuses[i];
      if (!res.ok) {
        failed.push(`${status} claims (${res.error})`);
        return;
      }
      // The service has no filing date and sorting it by case number takes 14 s, so the cap keeps an arbitrary 2,000; within
      // a status the newest case numbers (a stand-in for filing order) come first.
      features.push(...normalizeClaims(res.fc, status).sort(byCaseNumberDesc));
      if (res.truncated && !wide) notes.push(`Showing an arbitrary 2,000 ${status} claims, not the newest; zoom in for the rest`);
    });
    if (failed.length === statuses.length) {
      return { error: `Mining claims unavailable: ${failed.join("; ")}`, hint: "upstream" };
    }
    if (failed.length > 0) notes.push(`Missing the ${failed.join(" and the ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push(input.status === "both" ? "No mining claims in this area" : `No ${input.status} mining claims in this area`);
    }
    // The total counts every claim in the box, so it is only given when every status asked answered and counted.
    const total =
      counts !== null && failed.length === 0 && counts.every((c) => c !== null) ? counts.reduce<number>((sum, c) => sum + (c ?? 0), 0) : undefined;
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(miningClaims);

export default miningClaims;

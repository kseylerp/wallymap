/**
 * Uranium legacy sites in the US Southwest: abandoned uranium mines on the Navajo Nation and Department of Energy Legacy Management
 * uranium mill-tailings sites. Two keyless ArcGIS FeatureServers (verified live 2026-10-10, f=geojson works):
 *   Navajo Nation abandoned uranium mines, 602 points, with 2007 hazard scores (published by the New Mexico Community Data Collaborative,
 *     NMCDC, from the Navajo Nation EPA / US EPA screening):
 *     https://services.arcgis.com/LGtNQDlIZBdntoA9/arcgis/rest/services/Navajo_Nation_Abandoned_Uranium_Mine_Point_Scores/FeatureServer/0
 *     Fields: Mine_Name, Aliases, Mine_ID, Chapter (Navajo chapter house area), Region, Map_ID, and the scores GrndWtrScr, Soil_Scr, Air_Scr,
 *     SurfWtrScr and Comp_Scr (composite: 10 to 17,640, mean 665). No licence is stated on the item.
 *   DOE Office of Legacy Management sites (681 points; the layer keeps the uranium mill-tailings ones):
 *     https://services7.arcgis.com/Oak1TVjJMSpGVWPC/arcgis/rest/services/DoeLmSitePoint/FeatureServer/0
 *     where siteRegulatoryDriver IN ('UMTRCA Title I', 'UMTRCA Title II', 'ULP') gives 64 sites (Title I: abandoned mill sites cleaned up by DOE;
 *     Title II: licensed mill sites handed to DOE for long-term care after cleanup; ULP: Uranium Leasing Program). Fields: featureName,
 *     siteStateCode, siteRegulatoryDriver, siteWebPageURL, siteFactSheetURL, siteTransferYear (a string, some in the future), subSiteId.
 * Output: Navajo points: kind "abandoned mine", v = composite hazard score, name, aliases, mineId, chapter, region and the four component scores.
 *   DOE points: kind "mill tailings site" (Title I or II) or "leasing program", name, state, program, siteId, url, factSheet, transferYear.
 * Smoke check 2026-10-10 (live, through runLayer): the lower 48 box returned 666 points (602 Navajo mines, 64 DOE sites) in 0.3 s; a Four Corners
 *   box -112,35,-106,38 returned 616 (Tract 15, Oljato chapter, composite score 170, first).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { bboxAreaKm2, defineLayer, type LayerError, type LayerResult } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

export const NAVAJO_URL =
  "https://services.arcgis.com/LGtNQDlIZBdntoA9/arcgis/rest/services/Navajo_Nation_Abandoned_Uranium_Mine_Point_Scores/FeatureServer/0";
export const DOE_URL = "https://services7.arcgis.com/Oak1TVjJMSpGVWPC/arcgis/rest/services/DoeLmSitePoint/FeatureServer/0";
export const DOE_WHERE = "siteRegulatoryDriver IN ('UMTRCA Title I', 'UMTRCA Title II', 'ULP')";
/** Both datasets are static (one is a 2007 study). */
const TTL_SECONDS = 7 * 86_400;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPoint(geometry: unknown): geometry is Point {
  return typeof geometry === "object" && geometry !== null && "type" in geometry && geometry.type === "Point";
}

/** Navajo Nation abandoned mines as points; v is the composite hazard score. */
export function normalizeNavajo(fc: FeatureCollection): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = {
      name: str(p.Mine_Name) ?? "Unnamed mine",
      kind: "abandoned mine",
      source: "Navajo Nation abandoned uranium mines (2007)",
    };
    const aliases = str(p.Aliases);
    if (aliases !== undefined) properties.aliases = aliases;
    const mineId = num(p.Mine_ID);
    if (mineId !== undefined) properties.mineId = mineId;
    const chapter = str(p.Chapter);
    if (chapter !== undefined) properties.chapter = chapter;
    const region = str(p.Region);
    if (region !== undefined) properties.region = region;
    const composite = num(p.Comp_Scr);
    if (composite !== undefined) {
      properties.hazardScore = composite;
      properties.v = composite;
    }
    const scores: [string, unknown][] = [
      ["groundwaterScore", p.GrndWtrScr],
      ["soilScore", p.Soil_Scr],
      ["airScore", p.Air_Scr],
      ["surfaceWaterScore", p.SurfWtrScr],
    ];
    for (const [key, value] of scores) {
      const score = num(value);
      if (score !== undefined) properties[key] = score;
    }
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

/** DOE Legacy Management uranium sites as points; a transfer year in the future is reported as expectedTransferYear. */
export function normalizeDoe(fc: FeatureCollection, thisYear: number): Feature<Point>[] {
  const out: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (!isPoint(f.geometry)) continue;
    const p = f.properties ?? {};
    const program = str(p.siteRegulatoryDriver);
    const properties: Record<string, string | number> = {
      name: str(p.featureName) ?? "Unnamed site",
      kind: program === "ULP" ? "leasing program" : "mill tailings site",
      source: "DOE Office of Legacy Management",
    };
    if (program !== undefined) properties.program = program;
    const state = str(p.siteStateCode);
    if (state !== undefined) properties.state = state;
    const siteId = str(p.subSiteId);
    if (siteId !== undefined) properties.siteId = siteId;
    const url = str(p.siteWebPageURL);
    if (url !== undefined) properties.url = url;
    const factSheet = str(p.siteFactSheetURL);
    if (factSheet !== undefined) properties.factSheet = factSheet;
    const year = Number(str(p.siteTransferYear));
    if (Number.isInteger(year) && year >= 1900) properties[year <= thisYear ? "transferYear" : "expectedTransferYear"] = year;
    out.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return out;
}

const uranium = defineLayer({
  id: "uranium",
  title: "Uranium legacy sites",
  description:
    "Legacy uranium sites in the western United States: abandoned uranium mines on the Navajo Nation, and Department of Energy uranium mill-tailings disposal sites. " +
    "Each point has name, kind ('abandoned mine', 'mill tailings site' or 'leasing program') and source. " +
    "Navajo mines (602 of them) also have v and hazardScore (a 2007 screening score combining groundwater, soil, air and surface-water scores, from 10 to about 17,600; higher means a higher estimated hazard, and it is not a measured exposure), the four component scores, aliases, chapter (the local Navajo chapter area), region and mineId. " +
    "DOE sites (about 60, from Utah and Colorado to Wyoming, New Mexico and Pennsylvania) have program (UMTRCA Title I sites were abandoned mills that DOE cleaned up; Title II sites were licensed mills handed to DOE for long-term care), state, siteId, url and factSheet to DOE's pages, and transferYear (when DOE took them over) or expectedTransferYear. " +
    "Use it for 'abandoned uranium mines on the Navajo Nation', 'uranium mill tailings near Moab', 'where are the uranium cleanup sites', 'how many abandoned mines near this chapter' or 'is there a uranium site near here'. " +
    "It is not every uranium mine: the Navajo list covers the Navajo Nation only, so abandoned mines elsewhere (Colorado Plateau, Wyoming) are missing, and the 2007 scores do not show cleanup done since; for historic mines and prospects with the uranium commodity everywhere, use mines with commodity uranium. " +
    "A point is a legacy hazard site, so say that old mine openings and tailings can be dangerous and that nothing here is a health or safety clearance. Works in the United States; elsewhere it returns nothing. " +
    "Zoom in to a region under 20,000,000 km² (the whole lower 48 fits) first.",
  coverage: "us",
  license:
    "Navajo mines: published by the New Mexico Community Data Collaborative from Navajo Nation EPA and US EPA screening (no licence stated); DOE sites: US Department of Energy (public domain)",
  requiredEnv: [],
  maxAreaKm2: 20_000_000,
  input: z.object({}),
  style: { geometry: "point", color: layerColor("uranium"), unit: "score" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = {
      source: "Navajo Nation abandoned uranium mines hazard scores (NMCDC, 2007) and US DOE Office of Legacy Management sites",
      url: "https://www.energy.gov/lm/uranium-mill-tailings-radiation-control-act-title-i-and-title-ii-sites",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const area = bboxAreaKm2(ctx.bbox);
    if (area > uranium.maxAreaKm2) {
      return {
        error: `Area is ${Math.round(area)} km²; zoom in to under ${uranium.maxAreaKm2} km²`,
        hint: "zoom_in",
      };
    }

    const [navajo, doe] = await Promise.all([
      arcgisQuery(ctx, NAVAJO_URL, {
        outFields: ["Mine_Name", "Aliases", "Mine_ID", "Chapter", "Region", "GrndWtrScr", "Soil_Scr", "Air_Scr", "SurfWtrScr", "Comp_Scr"],
        bbox: ctx.bbox,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "uranium:navajo",
      }),
      arcgisQuery(ctx, DOE_URL, {
        outFields: ["featureName", "siteStateCode", "siteRegulatoryDriver", "siteWebPageURL", "siteFactSheetURL", "siteTransferYear", "subSiteId"],
        where: DOE_WHERE,
        bbox: ctx.bbox,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "uranium:doe",
      }),
    ]);

    const features: Feature<Point>[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    const take = (res: ArcgisResult, label: string, normalize: (fc: FeatureCollection) => Feature<Point>[]) => {
      if (!res.ok) {
        failed.push(`${label} (${res.error})`);
        return;
      }
      features.push(...normalize(res.fc));
      if (res.truncated) notes.push(`Showing 2,000 ${label} records; zoom in for the rest`);
    };
    take(navajo, "Navajo mines", normalizeNavajo);
    take(doe, "DOE sites", (fc) => normalizeDoe(fc, new Date().getUTCFullYear()));

    if (failed.length === 2) return { error: `Uranium site data unavailable: ${failed.join("; ")}`, hint: "upstream" };
    if (failed.length > 0) notes.push(`Missing ${failed.join(" and ")}`);
    if (features.length === 0 && failed.length === 0) {
      notes.push("No Navajo Nation abandoned uranium mines or DOE uranium sites in this area; this layer does not cover other uranium mines (use mines with commodity uranium)");
    } else if (features.some((f) => f.properties?.kind === "abandoned mine")) {
      notes.push("Hazard scores are from a 2007 screening and do not reflect cleanup since");
    }

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(uranium);

export default uranium;

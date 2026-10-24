/**
 * Ecoregions on Earth Engine: the outlines and shares the ecoregions layer draws and reads (docs/top-10-use-cases.md T09).
 *
 * Tables (read 2026-10-23 with the project's credentials):
 *   - `EPA/Ecoregions/2013/L3`: US EPA Level III ecoregions of the lower 48 (85 regions in 1,250 parts), properties
 *     `us_l3name` ("Blue Ridge"), `us_l3code` ("66"), `na_l2name` and `na_l1name` (the North American levels above).
 *   - `EPA/Ecoregions/2013/L4`: Level IV (967 regions), `us_l4name` ("Southern Metasedimentary Mountains"),
 *     `us_l4code` ("66g") and the Level III parent's `us_l3name`. A region comes in many parts, so parts are merged by name.
 *   - `RESOLVE/ECOREGIONS/2017`: the 846 terrestrial ecoregions of the world (Dinerstein et al. 2017, CC BY 4.0),
 *     `ECO_NAME` ("Appalachian-Blue Ridge forests"), `BIOME_NAME`, `REALM`.
 * One request clips every region that touches the box to it, simplifies the outline to about a pixel of the map, and
 * measures the clipped area; the shares are those areas over the box's own area. The filter is `Filter.intersects` on
 * `.geo` (on `.all` it matches nothing).
 */
import { call, lambda, rectangle, type EeNode } from "./expr";
import type { BBox } from "@/layers/types";

export type Scheme = "epa3" | "epa4" | "resolve";

export const TABLES: Record<Scheme, { id: string; name: string; code?: string; parent?: string; parentLabel: string }> = {
  epa3: { id: "EPA/Ecoregions/2013/L3", name: "us_l3name", code: "us_l3code", parent: "na_l2name", parentLabel: "Within" },
  epa4: { id: "EPA/Ecoregions/2013/L4", name: "us_l4name", code: "us_l4code", parent: "us_l3name", parentLabel: "Level III region" },
  resolve: { id: "RESOLVE/ECOREGIONS/2017", name: "ECO_NAME", parent: "BIOME_NAME", parentLabel: "Biome" },
};

/** Metres across a box at its middle latitude. */
export function widthMetres([w, s, e, n]: BBox): number {
  return (e - w) * 111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
}

/** How far (m) an outline may move when simplified: about a pixel of a 1,000-pixel-wide map of the box, never under 30 m. */
export function tolerance(bbox: BBox): number {
  return Math.max(30, Math.round(widthMetres(bbox) / 1000));
}

/** The area of a lon/lat box on the sphere, m² (exact for a box with parallel and meridian edges). */
export function boxAreaM2([w, s, e, n]: BBox): number {
  const R = 6_371_008.8;
  return R * R * (((e - w) * Math.PI) / 180) * (Math.sin((n * Math.PI) / 180) - Math.sin((s * Math.PI) / 180));
}

const margin = (m: number) => call("ErrorMargin", { value: m });
const set = (object: EeNode, key: string, value: EeNode) => call("Element.set", { object, key, value });

/**
 * Every region of `scheme` touching the box, clipped to it and simplified, as GeoJSON features with `name`, `code`,
 * `parent` and `area` (m² of the clipped part, measured before simplifying). Parts of one region come separately.
 */
export function regionsExpression(scheme: Scheme, bbox: BBox): EeNode {
  const t = TABLES[scheme];
  const rect = rectangle(bbox);
  const [w, s, e, n] = bbox;
  const dx = (e - w) / 4;
  const dy = (n - s) / 4;
  const wideRect = rectangle([Math.max(-180, w - dx), Math.max(-85, s - dy), Math.min(180, e + dx), Math.min(85, n + dy)]);
  const tol = tolerance(bbox);
  const touching = call("Collection.filter", {
    collection: call("Collection.loadTable", { tableId: t.id }),
    filter: call("Filter.intersects", { leftField: ".geo", rightValue: rect }),
  });
  return call("Collection.map", {
    collection: touching,
    baseAlgorithm: lambda((f) => {
      const clipped = call("Geometry.intersection", { left: call("Feature.geometry", { feature: f }), right: rect, maxError: margin(tol) });
      // Drawn past the box (a quarter of it each way), so the outlines never trace the box's own edges as a thick frame
      // around the view (the Smokies' answer was boxed in black); the share is still measured inside the box.
      const drawn = call("Geometry.intersection", { left: call("Feature.geometry", { feature: f }), right: wideRect, maxError: margin(tol) });
      let out = call("Feature", { geometry: call("Geometry.simplify", { geometry: drawn, maxError: margin(tol) }) });
      out = set(out, "name", call("Element.get", { object: f, property: t.name }));
      if (t.code) out = set(out, "code", call("Element.get", { object: f, property: t.code }));
      if (t.parent) out = set(out, "parent", call("Element.get", { object: f, property: t.parent }));
      return set(out, "area", call("Geometry.area", { geometry: clipped, maxError: margin(tol) }));
    }),
  });
}

export type RegionPart = { name: string; code?: string; parent?: string; areaM2: number; geometry: GeoJSON.Geometry };
export type Region = { name: string; code?: string; parent?: string; areaM2: number; share: number; geometry: GeoJSON.Geometry };

/** Polygons of any geometry (a clip can leave lines and points in a GeometryCollection). */
function polygonsOf(g: GeoJSON.Geometry | null | undefined): GeoJSON.Position[][][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(polygonsOf);
  return [];
}

/** The parts from the result, merged by name into one outline each, with their share of the box; largest first. */
export function readRegions(result: unknown, bbox: BBox): Region[] {
  const features = ((result as { features?: unknown[] } | null)?.features ?? []) as { properties?: Record<string, unknown>; geometry?: GeoJSON.Geometry }[];
  const byName = new Map<string, { code?: string; parent?: string; areaM2: number; polys: GeoJSON.Position[][][] }>();
  for (const f of features) {
    const p = f.properties ?? {};
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const area = typeof p.area === "number" ? p.area : 0;
    const polys = polygonsOf(f.geometry);
    if (!name || name === "N/A" || area <= 0 || polys.length === 0) continue;
    const entry = byName.get(name) ?? { areaM2: 0, polys: [], ...(typeof p.code === "string" && { code: p.code }), ...(typeof p.parent === "string" && p.parent !== "N/A" && { parent: p.parent }) };
    entry.areaM2 += area;
    entry.polys.push(...polys);
    byName.set(name, entry);
  }
  const box = boxAreaM2(bbox);
  return [...byName.entries()]
    .map(([name, e]) => ({
      name,
      ...(e.code && { code: e.code }),
      ...(e.parent && { parent: e.parent }),
      areaM2: e.areaM2,
      share: Math.min(1, e.areaM2 / box),
      geometry: (e.polys.length === 1 ? { type: "Polygon", coordinates: e.polys[0] } : { type: "MultiPolygon", coordinates: e.polys }) as GeoJSON.Geometry,
    }))
    .sort((a, b) => b.areaM2 - a.areaM2);
}

/**
 * Soils of the United States from USDA NRCS SSURGO (the detailed county soil surveys), through Soil Data Access: a
 * keyless SQL service, POST https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest with { query, format:
 * "JSON+COLUMNNAME" } (answers { Table: [[column names], [row]...] }, every value a string or null; DECLARE is refused,
 * so the box is spelled out in each query). Public domain (USDA).
 *
 * Three queries run at once (live over Boulder, -105.35,39.95 to -105.15,40.1, about 285 km², 2026-10-23):
 *   polygons: mupolygon rows meeting the box, each clipped to it and simplified (STIntersection(box).Reduce(tolerance),
 *     as WKT): 1,122 polygons of 91 map units, 1.3 s, 0.7 MB at 0.0003°;
 *   shares: the clipped area of each map unit (SUM(STArea)) and its polygon count, 1.1 s;
 *   attributes: muaggatt (muname, drclassdcd the dominant drainage class, brockdepmin the shallowest depth to bedrock in
 *     cm, hydgrpdcd the dominant hydrologic group) joined to the major components and their horizons in the top 30 cm with
 *     the representative texture (chtexturegrp rvindicator 'Yes'), 0.8 s. A joined form with correlated subqueries took 13 s.
 * Each map unit's texture is its largest major component's top mineral horizon (an organic litter layer, "slightly
 * decomposed plant material", is skipped), grouped as Sand, Sandy loam, Loam, Clay loam or Clay (the ramp's order,
 * off-white → sage → purple); rock outcrop, water and organic soils have no texture class and draw a faint grey.
 * Boulder (live): Nederland very cobbly sandy loam, Valmont and Nunn clay loams, Niwot loam, Ascalon sandy loam.
 * Up to 600 km² every polygon; to 2,400 km² the 1,500 largest polygons (the shares stay exact); wider, a zoom-in error.
 */
import { z } from "zod";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { defineLayer, type Attribute, type AttributeLevel, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { bodyHash } from "@/lib/fetch/cache";
import { layerColor, OFF_WHITE, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

export const SDA_URL = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest";
/** Every polygon up to this area; SDA answers a few hundred km² in one or two seconds. */
export const SOILS_MAX_AREA_KM2 = 600;
/** Polygons a wide answer keeps, largest first. */
const WIDE_LIMIT = 1_500;
const TTL_SECONDS = 30 * 86_400;
const SDA_TIMEOUT_MS = 25_000;

/** The texture classes, sand to clay: the value is `textureRank`, the ramp position. */
export const TEXTURES = ["Sand", "Sandy loam", "Loam", "Clay loam", "Clay"] as const;
/** Ramp positions along off-white → sage → purple; sand is kept off the bare off-white so it still reads as a soil. */
const TEXTURE_AT = [0.16, 0.36, 0.55, 0.77, 1];
export const TEXTURE_COLORS = TEXTURE_AT.map((t) => rgbToHex(interpolateStops([OFF_WHITE, SAGE, PURPLE], t)));

const TEXTURE_HELP: Record<(typeof TEXTURES)[number], string> = {
  Sand: "Sand and loamy sand: gritty, drains fast, holds little water.",
  "Sandy loam": "Sandy loam: mostly sand with some silt and clay; drains well.",
  Loam: "Loam, silt loam and silt: a balanced mix, holds water and drains moderately.",
  "Clay loam": "Clay loam, sandy clay loam and silty clay loam: sticky when wet, drains slowly.",
  Clay: "Clay, silty clay and sandy clay: sticky and plastic when wet, cracks when dry, drains very slowly.",
};

/** The texture class of an SSURGO texture description ("Very cobbly sandy loam" is Sandy loam), with a kind for the rest. */
export function textureClassOf(texdesc: string | null | undefined, compname?: string | null, muname?: string | null): { label: string; rank?: number } {
  // The main soil is bare rock: its listed texture is the thin fill between outcrops, not the ground.
  if (/^\s*rock outcrop/i.test(compname ?? "")) return { label: "Rock outcrop" };
  if (/^\s*water\b/i.test(muname ?? "")) return { label: "Water" };
  const t = (texdesc ?? "").toLowerCase().trim();
  if (!t) return { label: "Not rated" };
  if (/bedrock/.test(t)) return { label: "Bedrock" };
  if (/muck|peat|plant material/.test(t)) return { label: "Organic" };
  if (/clay loam/.test(t)) return { label: "Clay loam", rank: 3 };
  if (/loamy (?:\w+ )?sand\b|\bsand$/.test(t)) return { label: "Sand", rank: 0 };
  if (/sandy loam/.test(t)) return { label: "Sandy loam", rank: 1 };
  if (/\bclay$/.test(t)) return { label: "Clay", rank: 4 };
  if (/loam|silt/.test(t)) return { label: "Loam", rank: 2 };
  return { label: t.charAt(0).toUpperCase() + t.slice(1) };
}

/** Hydrologic soil groups in words (how fast rain soaks in, so how much runs off). */
const HYDRO_GROUPS: Record<string, string> = {
  A: "A: low runoff, water soaks in fast",
  B: "B: moderately low runoff",
  C: "C: moderately high runoff, water soaks in slowly",
  D: "D: high runoff, water soaks in very slowly",
  "A/D": "A/D: soaks in fast when drained, very slowly when wet",
  "B/D": "B/D: moderately low runoff when drained, high when wet",
  "C/D": "C/D: moderately high runoff when drained, high when wet",
};

const DRAINAGE: AttributeLevel[] = [
  { value: "Excessively drained", label: "Excessively drained" },
  { value: "Somewhat excessively drained", label: "Somewhat excessively drained" },
  { value: "Well drained", label: "Well drained" },
  { value: "Moderately well drained", label: "Moderately well drained" },
  { value: "Somewhat poorly drained", label: "Somewhat poorly drained" },
  { value: "Poorly drained", label: "Poorly drained" },
  { value: "Very poorly drained", label: "Very poorly drained" },
];

/** Inches first: "16 in (40 cm)". */
export function depthText(cm: number): string {
  return `${Math.round(cm / 2.54)} in (${Math.round(cm)} cm)`;
}

// ---- WKT (SQL Server's STAsText of the clipped polygons) ----

/** Polygons in a WKT string: POLYGON, MULTIPOLYGON, or the polygons inside a GEOMETRYCOLLECTION; lines and points dropped. */
export function wktPolygons(wkt: string): Position[][][] {
  const out: Position[][][] = [];
  const re = /(MULTIPOLYGON|POLYGON|LINESTRING|POINT|MULTILINESTRING|MULTIPOINT|GEOMETRYCOLLECTION)\s*(EMPTY)?\s*/gi;
  let i = 0;
  const text = wkt.trim();
  // Reads one parenthesised group starting at `at` and returns its inner text and the index after it.
  const group = (at: number): [string, number] => {
    let depth = 0;
    for (let j = at; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") {
        depth--;
        if (depth === 0) return [text.slice(at + 1, j), j + 1];
      }
    }
    return [text.slice(at + 1), text.length];
  };
  const ring = (s: string): Position[] =>
    s
      .split(",")
      .map((pair) => pair.trim().split(/\s+/).slice(0, 2).map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)) as Position[];
  const polygonOf = (inner: string): Position[][] => {
    const rings: Position[][] = [];
    let k = 0;
    while (k < inner.length) {
      const open = inner.indexOf("(", k);
      if (open < 0) break;
      const close = inner.indexOf(")", open);
      const r = ring(inner.slice(open + 1, close));
      if (r.length >= 4) rings.push(r);
      k = close + 1;
    }
    return rings;
  };
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) break;
    const kind = m[1].toUpperCase();
    i = re.lastIndex;
    if (m[2]) continue;
    if (kind === "GEOMETRYCOLLECTION") {
      // Step inside the collection's parentheses and keep reading its members.
      if (text[i] === "(") i += 1;
      continue;
    }
    if (text[i] !== "(") continue;
    const [inner, next] = group(i);
    i = next;
    if (kind === "POLYGON") {
      const p = polygonOf(inner);
      if (p.length > 0) out.push(p);
    } else if (kind === "MULTIPOLYGON") {
      let k = 0;
      while (k < inner.length) {
        const open = inner.indexOf("(", k);
        if (open < 0) break;
        let depth = 0;
        let end = open;
        for (let j = open; j < inner.length; j++) {
          if (inner[j] === "(") depth++;
          else if (inner[j] === ")") {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        const p = polygonOf(inner.slice(open + 1, end));
        if (p.length > 0) out.push(p);
        k = end + 1;
      }
    }
    // Skip the comma between members of a collection.
    while (i < text.length && /[\s,)]/.test(text[i])) i++;
  }
  return out;
}

// ---- Soil Data Access ----

type Row = (string | null)[];

function boxWkt([w, s, e, n]: BBox): string {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return `geometry::STGeomFromText('POLYGON((${r(w)} ${r(s)},${r(e)} ${r(s)},${r(e)} ${r(n)},${r(w)} ${r(n)},${r(w)} ${r(s)}))', 4326)`;
}

/** The three queries for a box: clipped polygons (all, or the `top` largest), shares per map unit, and attributes. */
export function soilQueries(bbox: BBox, tolerance: number, top?: number): { polygons: string; shares: string; attributes: string } {
  const box = boxWkt(bbox);
  const meets = `p.mupolygongeo.STIntersects(${box}) = 1`;
  const clipped = `p.mupolygongeo.STIntersection(${box})`;
  return {
    polygons:
      `SELECT ${top ? `TOP ${top} ` : ""}p.mukey, ${clipped}.Reduce(${tolerance}).STAsText() AS wkt, ${clipped}.STArea() AS area ` +
      `FROM mupolygon p WHERE ${meets}${top ? " ORDER BY area DESC" : ""}`,
    shares: `SELECT p.mukey, SUM(${clipped}.STArea()) AS area, COUNT(*) AS n FROM mupolygon p WHERE ${meets} GROUP BY p.mukey`,
    attributes:
      "SELECT ma.mukey, ma.muname, ma.drclassdcd, ma.brockdepmin, ma.hydgrpdcd, c.compname, c.comppct_r, tg.texdesc, ch.hzdept_r " +
      "FROM muaggatt ma INNER JOIN component c ON c.mukey = ma.mukey AND c.majcompflag = 'Yes' " +
      "LEFT JOIN chorizon ch ON ch.cokey = c.cokey LEFT JOIN chtexturegrp tg ON tg.chkey = ch.chkey AND tg.rvindicator = 'Yes' " +
      `WHERE ma.mukey IN (SELECT DISTINCT p.mukey FROM mupolygon p WHERE ${meets}) AND (ch.hzdept_r IS NULL OR ch.hzdept_r < 30) ` +
      "ORDER BY ma.mukey, c.comppct_r DESC, ch.hzdept_r",
  };
}

async function sda(ctx: QueryContext, name: string, query: string): Promise<Row[] | LayerError> {
  let res: Response;
  try {
    res = await ctx.fetch(SDA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, format: "JSON+COLUMNNAME" }),
      cacheKey: `soils:${name}:${bodyHash(query)}`,
      ttlSeconds: TTL_SECONDS,
      timeoutMs: SDA_TIMEOUT_MS,
    });
  } catch (err) {
    const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
    return { error: timedOut ? `USDA Soil Data Access timed out after ${SDA_TIMEOUT_MS / 1000} seconds; zoom in and try again` : "USDA Soil Data Access returned no response", hint: "upstream" };
  }
  if (!res.ok) return { error: `USDA Soil Data Access returned ${res.status}`, hint: "upstream" };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // An empty answer (no soil polygons in the box) is an empty body.
    return [];
  }
  const table = typeof json === "object" && json !== null ? (json as { Table?: unknown }).Table : undefined;
  if (!Array.isArray(table)) return [];
  return (table as Row[]).slice(1);
}

/** One map unit's attributes: name, drainage, depth to bedrock, hydrologic group, and its dominant texture. */
export type MapUnit = {
  mukey: string;
  muname: string;
  drainage?: string;
  bedrockCm?: number;
  hydGroup?: string;
  component?: string;
  componentPct?: number;
  texture: { label: string; rank?: number };
  textureDetail?: string;
};

/**
 * Map units from the attribute rows (ordered by map unit, component share, horizon depth): each unit's largest major
 * component's first horizon with a mineral texture (an organic litter layer is skipped when a mineral one follows).
 */
export function mapUnitsOf(rows: Row[]): Map<string, MapUnit> {
  const out = new Map<string, MapUnit>();
  const firstComponent = new Map<string, string>();
  for (const [mukey, muname, drainage, bedrock, hyd, compname, comppct, texdesc] of rows) {
    if (!mukey) continue;
    if (!firstComponent.has(mukey)) firstComponent.set(mukey, compname ?? "");
    if ((compname ?? "") !== firstComponent.get(mukey)) continue;
    const texture = textureClassOf(texdesc, compname, muname);
    const prior = out.get(mukey);
    // Keep the first horizon unless it was organic litter or had no texture and this one has a class.
    if (prior && !(prior.texture.rank === undefined && texture.rank !== undefined)) continue;
    const bedrockCm = bedrock === null || bedrock === "" ? undefined : Number(bedrock);
    out.set(mukey, {
      mukey,
      muname: muname ?? "Unnamed map unit",
      ...(drainage && { drainage }),
      ...(bedrockCm !== undefined && Number.isFinite(bedrockCm) && { bedrockCm }),
      ...(hyd && { hydGroup: hyd }),
      ...(compname && { component: compname }),
      ...(comppct && Number.isFinite(Number(comppct)) && { componentPct: Number(comppct) }),
      texture,
      ...(texdesc && { textureDetail: texdesc }),
    });
  }
  return out;
}

/** A map unit's feature properties: what the card and the map read. */
export function unitProperties(u: MapUnit): Record<string, string | number> {
  const p: Record<string, string | number> = { heading: u.muname, soil: u.muname, texture: u.texture.label, mukey: u.mukey };
  if (u.texture.rank !== undefined) p.textureRank = u.texture.rank;
  if (u.textureDetail) p.textureDetail = u.textureDetail;
  if (u.drainage) p.drainage = u.drainage;
  if (u.bedrockCm !== undefined) {
    p.bedrockCm = u.bedrockCm;
    p.bedrockIn = Math.round(u.bedrockCm / 2.54);
    p.bedrock = depthText(u.bedrockCm);
  } else if (u.texture.label !== "Water") p.bedrock = "None within the soil profile (about 5 to 6.5 ft)";
  if (u.hydGroup) p.hydGroup = HYDRO_GROUPS[u.hydGroup] ?? u.hydGroup;
  if (u.component) p.component = u.componentPct ? `${u.component}, about ${u.componentPct}% of the map unit` : u.component;
  return p;
}

function pct(n: number): number {
  return Math.round(n * 100);
}

/** The note: shares of the box by texture class and by the largest map units, typical depth to bedrock, drainage. */
export function soilsNote(units: Map<string, MapUnit>, shares: Map<string, { area: number; n: number }>): string {
  const total = [...shares.values()].reduce((s, x) => s + x.area, 0);
  if (total <= 0) return "No SSURGO soil map units in this box";
  const share = (keyOf: (u: MapUnit) => string | undefined) => {
    const m = new Map<string, number>();
    for (const [mukey, s] of shares) {
      const u = units.get(mukey);
      const k = u ? keyOf(u) : undefined;
      if (k) m.set(k, (m.get(k) ?? 0) + s.area / total);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const textures = share((u) => u.texture.label).filter(([, v]) => pct(v) >= 1);
  const largest = [...shares.entries()]
    .sort((a, b) => b[1].area - a[1].area)
    .slice(0, 3)
    .map(([mukey, s]) => {
      const u = units.get(mukey);
      return `${u?.muname ?? mukey} (${u?.textureDetail ? u.textureDetail.toLowerCase() : (u?.texture.label.toLowerCase() ?? "no texture")}, about ${pct(s.area / total)}%)`;
    });
  // Depth to bedrock, weighted by area: the share with bedrock in the profile and its median depth.
  const withRock: { cm: number; w: number }[] = [];
  let rockShare = 0;
  for (const [mukey, s] of shares) {
    const u = units.get(mukey);
    if (u?.bedrockCm === undefined) continue;
    withRock.push({ cm: u.bedrockCm, w: s.area });
    rockShare += s.area / total;
  }
  let depth: string;
  if (withRock.length === 0) depth = "no bedrock within the soil profile anywhere in the box (soils at least 5 ft deep)";
  else {
    withRock.sort((a, b) => a.cm - b.cm);
    const half = withRock.reduce((s, x) => s + x.w, 0) / 2;
    let acc = 0;
    const median = withRock.find((x) => (acc += x.w) >= half)!.cm;
    depth = `bedrock within the soil profile under about ${pct(rockShare)}% of the box, typically at ${depthText(median)}; elsewhere deeper than about 5 ft`;
  }
  const drainage = share((u) => u.drainage)[0];
  return (
    `SSURGO soil map units in the box (${shares.size} map units, ${[...shares.values()].reduce((s, x) => s + x.n, 0)} polygons). ` +
    `Surface texture by share of the box: ${textures.map(([k, v]) => `${k.toLowerCase()} about ${pct(v)}%`).join(", ")}. ` +
    `Largest map units: ${largest.join("; ")}. Depth to bedrock: ${depth}.` +
    (drainage ? ` Mostly ${drainage[0].toLowerCase()} (about ${pct(drainage[1])}% of the box).` : "")
  );
}

const SOURCE = { source: "USDA NRCS Soil Survey Geographic Database (SSURGO), via Soil Data Access", url: "https://sdmdataaccess.sc.egov.usda.gov/" };

const HELP: Record<string, FieldHelp> = {
  texture: { text: "The texture class of the surface layer of the map unit's main soil: how much sand, silt and clay it holds, sand to clay.", ...SOURCE },
  textureRank: { text: "The surface texture as a step from sand (0) to clay (4).", scale: "0 sand, 1 sandy loam, 2 loam, 3 clay loam, 4 clay", ...SOURCE },
  textureDetail: { text: "The surface layer's texture as the soil survey describes it, with its rock fragments (gravelly, cobbly, stony).", ...SOURCE },
  drainage: { text: "The natural drainage class of the main soil: how often and how long the soil is wet, from excessively drained to very poorly drained.", ...SOURCE },
  bedrock: { text: "The shallowest depth to bedrock among the map unit's soils, inches first; most soil surveys describe the top 5 to 6.5 feet.", ...SOURCE },
  hydGroup: { text: "The hydrologic soil group of the main soil: how fast water soaks in when the soil is wet, A fastest to D slowest (most runoff).", ...SOURCE },
  component: { text: "The main soil (component) of the map unit and its share; map units often mix two or three soils.", ...SOURCE },
};

const ATTRIBUTES: Attribute[] = [
  { key: "texture", type: "ordinal", label: "Surface texture", levels: TEXTURES.map((t) => ({ value: t, label: t, help: TEXTURE_HELP[t] })), scale: "USDA soil texture classes, grouped sand to clay", primary: true },
  { key: "textureRank", type: "measure", label: "Surface texture, sand (0) to clay (4)" },
  { key: "drainage", type: "ordinal", label: "Drainage", levels: DRAINAGE, scale: "USDA natural drainage classes" },
  { key: "bedrockIn", type: "measure", label: "Depth to bedrock", unit: "in", lowFirst: true },
];

/** The key: the five texture classes on the off-white → sage → purple ramp, sand to clay. */
const LEGEND: LegendSpec = {
  kind: "ramp",
  title: "Surface texture",
  field: "textureRank",
  stops: TEXTURES.map((t, i) => ({ label: t, value: i, color: TEXTURE_COLORS[i] })),
  note: "Sand (pale) to clay (purple): the surface layer of each map unit's main soil. Faint grey where the surface is rock outcrop, water or organic soil.",
};

const CARD: CardSpec = {
  facts: [
    { key: "soil", label: "Soil" },
    { key: "textureDetail", label: "Texture" },
    { key: "texture", label: "Texture class" },
    { key: "drainage", label: "Drainage" },
    { key: "bedrock", label: "Depth to bedrock" },
    { key: "hydGroup", label: "Hydrologic group" },
    { key: "component", label: "Main soil" },
  ],
  hidden: ["heading", "textureRank", "bedrockCm", "bedrockIn", "mukey"],
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const soils = defineLayer({
  id: "soils",
  title: "Soils",
  description:
    "Soils of the United States from the USDA NRCS soil surveys (SSURGO), drawn as soil map unit polygons colored by the texture of the surface layer, sand (pale) through sandy loam, loam and clay loam to clay (purple). " +
    "Use it for 'what's the soil like', 'soil type', 'is the ground clay or sand', 'how deep is the soil', 'does it drain well'. " +
    "Each polygon has soil (the map unit name, such as 'Valmont clay loam, 1 to 3 percent slopes'), texture (Sand, Sandy loam, Loam, Clay loam, Clay, or Rock outcrop, Water, Organic), textureDetail (such as 'Very cobbly sandy loam'), " +
    "drainage (Well drained ... Very poorly drained), bedrock (depth to bedrock, inches first, or none within the profile), hydGroup (hydrologic group A to D in words) and component (the main soil). " +
    "The note gives the share of the box by texture class, the three largest map units with their shares, the typical depth to bedrock and the main drainage class; quote them. " +
    "Not land cover and not rock: for rock use geology. United States only (SSURGO); every polygon in a box up to 600 km² (about a 25 km square), the 1,500 largest up to 2,400 km²; zoom in for wider areas.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USDA NRCS)",
  requiredEnv: [],
  maxAreaKm2: SOILS_MAX_AREA_KM2,
  wide: { orderBy: "area", rank: "largest", limit: WIDE_LIMIT },
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("soils"), encode: { color: "textureRank" } },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: LEGEND,
  time: { shape: "none" },
  display: { units: "us" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const citation = { ...SOURCE, source: "USDA NRCS SSURGO soil surveys via Soil Data Access (public domain)", retrieved: new Date().toISOString() };
    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: `${OUTSIDE_US_NOTE}: soils come from the USDA soil surveys (SSURGO), which map the United States only` };
    }
    const wide = ctx.wide === true;
    const width = ctx.bbox[2] - ctx.bbox[0];
    const tolerance = Math.round(Math.max(0.0002, width / (wide ? 600 : 800)) * 1e6) / 1e6;
    const q = soilQueries(ctx.bbox, tolerance, wide ? (ctx.wideStrategy?.limit ?? WIDE_LIMIT) : undefined);
    const [polygons, shareRows, attrRows] = await Promise.all([sda(ctx, "polygons", q.polygons), sda(ctx, "shares", q.shares), sda(ctx, "attributes", q.attributes)]);
    for (const r of [polygons, shareRows, attrRows]) if (!Array.isArray(r)) return r;
    const units = mapUnitsOf(attrRows as Row[]);
    const shares = new Map<string, { area: number; n: number }>();
    for (const [mukey, area, n] of shareRows as Row[]) if (mukey) shares.set(mukey, { area: Number(area) || 0, n: Number(n) || 0 });
    const features: Feature<Polygon | MultiPolygon>[] = [];
    for (const [mukey, wkt] of polygons as Row[]) {
      if (!mukey || !wkt) continue;
      const parts = wktPolygons(wkt);
      if (parts.length === 0) continue;
      const u = units.get(mukey);
      features.push({
        type: "Feature",
        geometry: parts.length === 1 ? { type: "Polygon", coordinates: parts[0] } : { type: "MultiPolygon", coordinates: parts },
        properties: u ? unitProperties(u) : { heading: "Soil map unit", soil: "Soil map unit", texture: "Not rated", mukey },
      });
    }
    const total = [...shares.values()].reduce((s, x) => s + x.n, 0);
    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      coverageNote: features.length === 0 && shares.size === 0 ? "No SSURGO soil map units in this box (the survey may not cover it yet)" : soilsNote(units, shares),
      ...(wide && total > 0 && { total }),
    };
  },
});

registerLayer(soils);

export default soils;

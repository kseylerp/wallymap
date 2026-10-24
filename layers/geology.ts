/**
 * Bedrock and surface geology map from Macrostrat (CC BY 4.0), keyless. The map is vector tiles; the "what rock is here"
 * lookup for one point is the separate `geologic-unit` layer, because a point result under this id would replace the
 * loaded tiles on the map.
 *
 * Map: vector tiles https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt (tilejson at /carto/tilejson.json: zoom 0 to 22, world bounds).
 *   Decoded live on 2026-10-09: two source layers, `units` (polygons; properties map_id, source_id, name, age, lith, descrip, t_int, b_int,
 *   best_age_top, best_age_bottom, color as a hex string, ref_*) and `lines` (faults and other contacts; properties type, name, descrip).
 *   Tiles answer at z0 to z16 and beyond (z8 Tahoe: 927 units; z12: 47; z16: 5); the layer draws `units` only, since a tile result
 *   carries one source layer. The tile server is a public service run by the Macrostrat team; set no key.
 * Drawing (2026-10-23, spec T08): each unit is filled by its ROCK FAMILY (sedimentary sage, volcanic pink, plutonic purple,
 *   metamorphic grey hatched, loose sediments off-white stippled), darker with the age of its youngest rock in five steps
 *   (lib/render/rockFamily.ts classes a unit from its lith, name and description: over Zion, z11, `lith` is empty on most
 *   detailed units, so the name and description carry the rock words). Legend "Rock family" with "Darker = older".
 * Coverage note (2026-10-23): the units in the asked box, sampled on a GRID by GRID grid of points through Macrostrat's point
 *   API (the one geologic-unit uses; most detailed map at each point), tallied by unit name with rock types, ages in million
 *   years, formation names and share of the sampled points, and the rock families' shares. Zion Canyon (-113.02,37.19 to
 *   -112.9,37.33), live: Navajo Sandstone, Kayenta Formation, Temple Cap Sandstone and alluvium, Jurassic.
 * Smoke check 2026-10-10 (live, keyless, through runLayer): a tile result with the Macrostrat URL, and tiles fetched at z8, z12 and z16 over Tahoe all 200.
 */
import { z } from "zod";
import { defineLayer, bboxAreaKm2, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { ageSpanText, ageText, identifySchema, lithologyText, scaleRank, type Unit } from "./geologic-unit";
import { layerColor } from "@/lib/render/palette";
import { FAMILY_LABELS, ROCK_FAMILY_LEGEND, rockFamilyOf, type RockFamily } from "@/lib/render/rockFamily";
import { mapLimit } from "@/lib/fetch";

export const GEOLOGY_TILE_URL = "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.mvt";
export const GEOLOGY_SOURCE_LAYER = "units";

const POINT_URL = "https://macrostrat.org/api/v2/geologic_units/map";
const USER_AGENT = "WallyMap/0.1 (https://wallymap.vercel.app)";
/** Points across and up the box: 6 by 6 = 36 points, enough to rank a canyon's main units, cheap enough to ask at once. */
export const GRID = 6;
/** Points asked at once (Macrostrat answers one in about 0.2 to 0.5 s). */
const CONCURRENCY = 8;
/** Per point: a slow point is left out rather than holding the answer. */
const POINT_TIMEOUT_MS = 8_000;
/** Geologic maps do not change from day to day. */
const TTL_SECONDS = 7 * 86_400;
/** Above this the grid is too coarse to mean much (a continent): the note only says what the map is. */
export const SAMPLE_MAX_AREA_KM2 = 2_000_000;
/** Units listed in the note. */
const TOP_UNITS = 6;

const AGE_HELP: FieldHelp = {
  text: "The youngest age of the rock unit (best_age_top), in millions of years, from the source map's age as Macrostrat matched it to the geologic time scale.",
  unit: "million years",
  source: "Macrostrat",
  url: "https://macrostrat.org/",
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "best_age_top",
    type: "measure",
    label: "Age of the youngest rock",
    unit: "million years",
    help: AGE_HELP,
    presets: [
      { label: "Quaternary", max: 2.58 },
      { label: "Tertiary", min: 2.58, max: 66 },
      { label: "Mesozoic", min: 66, max: 252 },
      { label: "Paleozoic", min: 252, max: 541 },
      { label: "Precambrian", min: 541 },
    ],
  },
];

/**
 * The card for a tapped unit: its age in period names and its description. Tile properties reach the card as served, so
 * rows that read badly raw are left off: `lith` is Macrostrat's coded list ("Major:{unconsolidated colluvium}"), and the
 * youngest and oldest ages in millions of years repeat the Age row (a Quaternary unit reads "0 million years").
 * The source map's address is a link named "Source map".
 */
const CARD: CardSpec = {
  facts: [
    { key: "age", label: "Age" },
    { key: "descrip", label: "Description" },
  ],
  links: [{ key: "ref_url", label: "Source map" }],
  hidden: ["map_id", "source_id", "legend_id", "t_int", "b_int", "color", "lith", "best_age_top", "best_age_bottom"],
};

/** One sampled point's most detailed unit. */
export type SampledUnit = Unit & { family: RockFamily };

/** The cell centres of a GRID by GRID grid over the box, south-west first. */
export function gridPoints(bbox: BBox, n: number = GRID): [number, number][] {
  const [w, s, e, nn] = bbox;
  const out: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lon = w + ((i + 0.5) * (e - w)) / n;
      const lat = s + ((j + 0.5) * (nn - s)) / n;
      out.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    }
  }
  return out;
}

/** The most detailed unit Macrostrat maps at one point, or null (no unit, or the point failed). */
async function unitAt(ctx: QueryContext, lon: number, lat: number): Promise<SampledUnit | null> {
  try {
    const res = await ctx.fetch(`${POINT_URL}?lat=${lat}&lng=${lon}`, {
      cacheKey: `geology:point:${lat},${lon}`,
      ttlSeconds: TTL_SECONDS,
      timeoutMs: POINT_TIMEOUT_MS,
      headers: { "user-agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const parsed = identifySchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.success.data.length === 0) return null;
    const best = [...parsed.data.success.data].sort((a, b) => scaleRank(a) - scaleRank(b))[0];
    return { ...best, family: rockFamilyOf({ lith: best.lith, name: best.name, descrip: best.descrip, best_age_top: best.t_age, best_age_bottom: best.b_age }) };
  } catch {
    return null;
  }
}

/** "a, b and c". */
function listText(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A unit's rock types in a few words: its lithology, else the first clause of its description, else its family. */
export function rockWords(u: SampledUnit): string {
  const lith = u.lith?.trim();
  if (lith) return lithologyText(lith).toLowerCase();
  // A mapping remark in brackets ("(Mapped as single line where thin)") says nothing about the rock.
  const first = u.descrip?.replace(/\([^)]*\)?/g, "").trim().split(/[;.]/)[0]?.trim();
  if (first && first.length >= 4) return (first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first).replace(/^./, (c) => c.toLowerCase());
  return `${FAMILY_LABELS.find((f) => f.id === u.family)?.label.toLowerCase() ?? "sedimentary"} rock`;
}

function pct(n: number, of: number): number {
  return Math.round((100 * n) / of);
}

/**
 * The coverage note: the main units in the box with their rocks, ages and share of the sampled points, formation names
 * when the map gives them, and the rock families' shares. Units are tallied by name (one unit drawn in several polygons
 * counts together).
 */
export function unitsNote(units: (SampledUnit | null)[], asked: number): string {
  const got = units.filter((u): u is SampledUnit => u !== null);
  if (got.length === 0) return "Macrostrat returned no geologic map unit at the sampled points; the map tiles still show what is mapped";
  const byName = new Map<string, SampledUnit[]>();
  for (const u of got) {
    const name = u.name?.trim() || "Unnamed unit";
    byName.set(name, [...(byName.get(name) ?? []), u]);
  }
  const ranked = [...byName.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const parts = ranked.slice(0, TOP_UNITS).map(([name, us]) => {
    const u = us[0];
    const period = ageText(u);
    const span = ageSpanText(u.t_age ?? undefined, u.b_age ?? undefined)?.replace(/ old$/, "");
    const formations = u.strat_name?.trim();
    const named = formations && formations !== name ? ` (formations: ${formations.split(/;\s*/).slice(0, 3).join(", ")})` : "";
    const age = [period, span].filter(Boolean).join(", ");
    return `${name}${named}: ${rockWords(u)}; ${age || "age not given"}; about ${pct(us.length, got.length)}% of sampled points`;
  });
  const families = new Map<RockFamily, number>();
  for (const u of got) families.set(u.family, (families.get(u.family) ?? 0) + 1);
  const familyText = [...families.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${(FAMILY_LABELS.find((x) => x.id === f)?.label ?? f).toLowerCase()} about ${pct(n, got.length)}%`);
  const coarse = got.filter((u) => u.scale === "small" || u.scale === "tiny").length > got.length / 2;
  const more = ranked.length > TOP_UNITS ? `; ${ranked.length - TOP_UNITS} smaller units not listed` : "";
  const missed = got.length < asked ? ` (${asked - got.length} of ${asked} points did not answer)` : "";
  return (
    `Main geologic map units in the box, from ${got.length} points sampled on a ${GRID} by ${GRID} grid${missed} (most detailed map at each point): ` +
    `${parts.join(" | ")}${more}. By rock family: ${listText(familyText)}.` +
    (coarse ? " Map detail is coarse here (most points come from small-scale maps), so units are broad." : "") +
    " Faults are a separate layer (faults); for the rock at one spot use geologic-unit"
  );
}

const geology = defineLayer({
  id: "geology",
  title: "Geology",
  description:
    "What an AREA is made of (a canyon, a park, a range, the map view): the geologic map from Macrostrat (world coverage, most detailed in the United States), whose note names the main rock units in the box (formations such as Navajo Sandstone or Kayenta Formation) with rock types, ages in million years and each unit's share; quote those names, ages and shares. " +
    "It draws as map tiles filled by rock family (sedimentary sage, volcanic pink, plutonic purple, metamorphic grey hatched, loose sediments stippled), darker for older rock, legend 'Rock family'; query it for every 'what rocks make up <place>' or 'what's under my feet here' question, with geologic-unit for one spot and faults when faults are asked. " +
    "Tapping a unit shows its name, age and description. " +
    "For the rock at ONE spot ('what is this peak made of') call geologic-unit with that place's lon and lat; for faults ('are there faults', 'is there a fault line') query the faults layer as well. " +
    "Caveats: geologic maps are drawn at the scale of their source, so edges are generalised and small outcrops are missed; units can be loose ('undivided granitic rocks'); " +
    "surface deposits like glacial till or alluvium can hide the bedrock below; the shares come from sampled points, so say 'about'. Works at any size of region.",
  coverage: "global",
  surface: "land",
  license: "CC BY 4.0 (Macrostrat; source maps by USGS and geological surveys)",
  requiredEnv: [],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("geology") },
  attributes: ATTRIBUTES,
  legend: ROCK_FAMILY_LEGEND,
  card: CARD,
  fieldHelp: { best_age_top: AGE_HELP, best_age_bottom: { ...AGE_HELP, text: "The oldest age of the rock unit (best_age_bottom), in millions of years." }, lith: { text: "The unit's rock types as Macrostrat lists them: major, minor and incidental." } },
  // A compiled map, not a dated record.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const tiles = {
      kind: "tiles" as const,
      data: {
        url: GEOLOGY_TILE_URL,
        minzoom: 0,
        maxzoom: 16,
        format: "vector" as const,
        sourceLayer: GEOLOGY_SOURCE_LAYER,
        geometry: "polygon" as const,
      },
      citation: {
        source: "Macrostrat geologic map compilation (CC BY 4.0), University of Wisconsin-Madison",
        url: "https://macrostrat.org/",
        retrieved: new Date().toISOString(),
      },
    };
    if (bboxAreaKm2(ctx.bbox) > SAMPLE_MAX_AREA_KM2) {
      return { ...tiles, coverageNote: "Geologic map units from Macrostrat, filled by rock family; detail follows each source map's scale, so it is finest in the United States. Zoom in to a region for the main units by name" };
    }
    const points = gridPoints(ctx.bbox);
    const units = await mapLimit(points, CONCURRENCY, ([lon, lat]) => unitAt(ctx, lon, lat));
    return { ...tiles, coverageNote: unitsNote(units, points.length) };
  },
});

registerLayer(geology);

export default geology;

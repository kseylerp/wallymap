/**
 * Avalanche forecasts from the US avalanche centers, as avalanche.org publishes them (audit R10: "avalanche danger near
 * Stevens Pass today" had only weather-alerts, which carries warnings, not the daily danger rating).
 *
 * Zones: https://api.avalanche.org/v2/public/products/map-layer (keyless GeoJSON, the layer avalanche.org's own map
 * draws). Verified 2026-10-23: 84 forecast zones (MultiPolygons, feature id = the zone id), each with name, center,
 * center_id, state, timezone, off_season, danger ("no rating", "low" ...), danger_level (-1 for none, 1 to 5), color,
 * travel_advice, link (the zone's forecast page), center_link, start_date and end_date of the current product. In late
 * October every zone read -1 "no rating" (23 marked off_season), so the layer must say plainly when nothing is rated.
 *
 * Detail for a rated zone: https://api.avalanche.org/v2/public/product?type=forecast&center_id=<center>&zone_id=<zone
 * id> answers the product now in force for that zone. Verified 2026-10-23: NWAC zone 3024 (Stevens Pass) answered its
 * early-season summary; past forecasts (/v2/public/product/178000, GNFAC 2026-01-15) carry danger as
 * [{ lower, middle, upper, valid_day: "current" | "tomorrow" }] (1 to 5 per elevation band: below, near and above
 * treeline), forecast_avalanche_problems [{ name, likelihood, size: [min, max], location: ["north upper", ...] }] and
 * bottom_line (HTML). At most MAX_DETAIL zones get the detail call; the others keep the map layer's rating.
 *
 * Terms: avalanche.org's public API is keyless and unlicensed; the forecasts belong to each avalanche center, so every
 * answer credits the center and links its own forecast page, and the note quotes it rather than inferring danger.
 * Colors are the North American Public Avalanche Danger Scale's (avalanche.org), a safety standard read by color, so
 * they draw as published (lib/render/palette.ts STANDARD_COLOR_LAYERS).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type Attribute, type BBox, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type QueryContext } from "./types";
import { registerLayer } from "./registry";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { layerColor } from "@/lib/render/palette";

const API = "https://api.avalanche.org/v2/public";
const MAP_LAYER = `${API}/products/map-layer`;
/** Most zones that get the full forecast (danger by elevation, problems, bottom line). */
export const MAX_DETAIL = 8;

/** The North American Public Avalanche Danger Scale, as avalanche.org draws it (No rating a shade darker than its grey: at #888888 an off-season zone changed the Topo pixels by 19 of 255, under the 24 the screen check needs; darker still fails on imagery). */
export const DANGER = [
  { value: 0, label: "No rating", color: "#7A7A7A", help: "The center has not rated this zone today (out of season, or not enough information)." },
  { value: 1, label: "1 Low", color: "#50B848", help: "Generally safe avalanche conditions. Watch for unstable snow on isolated terrain features." },
  { value: 2, label: "2 Moderate", color: "#FFF200", help: "Heightened avalanche conditions on specific terrain features. Evaluate snow and terrain carefully." },
  { value: 3, label: "3 Considerable", color: "#F7941E", help: "Dangerous avalanche conditions. Careful snowpack evaluation, cautious route-finding and conservative decision-making essential." },
  { value: 4, label: "4 High", color: "#ED1C24", help: "Very dangerous avalanche conditions. Travel in avalanche terrain not recommended." },
  { value: 5, label: "5 Extreme", color: "#231F20", help: "Avoid all avalanche terrain." },
] as const;

const inputSchema = z.object({});

const ZoneSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  geometry: z.unknown(),
  properties: z.object({
    name: z.string(),
    center: z.string().optional(),
    center_id: z.string(),
    state: z.string().optional(),
    timezone: z.string().optional(),
    off_season: z.boolean().optional(),
    travel_advice: z.string().nullable().optional(),
    danger: z.string().nullable().optional(),
    danger_level: z.number().nullable().optional(),
    link: z.string().nullable().optional(),
    center_link: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
  }),
});
type Zone = z.infer<typeof ZoneSchema>;

const ProductSchema = z.object({
  product_type: z.string().optional(),
  published_time: z.string().nullable().optional(),
  expires_time: z.string().nullable().optional(),
  bottom_line: z.string().nullable().optional(),
  danger: z
    .array(z.object({ lower: z.number().nullable().optional(), middle: z.number().nullable().optional(), upper: z.number().nullable().optional(), valid_day: z.string().optional() }))
    .optional(),
  forecast_avalanche_problems: z
    .array(
      z.object({
        name: z.string(),
        likelihood: z.string().nullable().optional(),
        size: z.array(z.union([z.string(), z.number()])).nullable().optional(),
        location: z.array(z.string()).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});
export type Product = z.infer<typeof ProductSchema>;

/** The bounds of any GeoJSON geometry's coordinates. */
export function geometryBounds(g: unknown): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
      return;
    }
    for (const x of c) walk(x);
  };
  if (typeof g === "object" && g !== null && "coordinates" in g) walk((g as { coordinates: unknown }).coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** The zones whose outline's bounds meet the box. */
export function zonesInBox(body: unknown, bbox: BBox): Zone[] {
  const features = typeof body === "object" && body !== null && "features" in body && Array.isArray(body.features) ? body.features : [];
  const out: Zone[] = [];
  for (const raw of features) {
    const z = ZoneSchema.safeParse(raw);
    if (!z.success) continue;
    const b = geometryBounds(z.data.geometry);
    if (b && overlaps(b, bbox)) out.push(z.data);
  }
  return out;
}

/** A 0 to 5 level (anything not 1 to 5 is no rating). */
export function level(n: number | null | undefined): number {
  return typeof n === "number" && n >= 1 && n <= 5 ? Math.round(n) : 0;
}

const levelText = (n: number) => DANGER[level(n)].label;

/** Plain text from the forecast's HTML: tags dropped, entities read, spaces folded, cut at a sentence near `max`. */
export function plainText(html: string, max = 320): string {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = cut.lastIndexOf(". ");
  return `${stop > max / 2 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`}`;
}

const ASPECTS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const BAND_WORDS: Record<string, string> = { upper: "above treeline", middle: "near treeline", lower: "below treeline" };

/** "north, northeast and east aspects above and near treeline", or "all aspects above treeline", from the rose's cells. */
export function locationText(cells: string[]): string {
  const byBand = new Map<string, Set<string>>();
  for (const c of cells) {
    const [aspect, band] = c.trim().toLowerCase().split(/\s+/);
    if (!aspect || !band) continue;
    const set = byBand.get(band) ?? new Set<string>();
    set.add(aspect);
    byBand.set(band, set);
  }
  // Bands with the same aspects read together.
  const groups = new Map<string, string[]>();
  for (const band of ["upper", "middle", "lower"]) {
    const set = byBand.get(band);
    if (!set) continue;
    const aspects = ASPECTS.filter((a) => set.has(a));
    const key = aspects.length === 8 ? "all aspects" : aspects.join(", ");
    groups.set(key, [...(groups.get(key) ?? []), band]);
  }
  return [...groups.entries()]
    .map(([aspects, bands]) => {
      const where = bands.map((b) => BAND_WORDS[b] ?? b);
      const bandText = where.length === 3 ? "at all elevations" : where.join(" and ").replace(/ treeline and (\w+) treeline/, " and $1 treeline");
      return `${aspects}${aspects === "all aspects" ? "" : " aspects"} ${bandText}`;
    })
    .join("; ");
}

/** "Wind Slab: possible, size 1 to 1.5, all aspects above treeline". */
export function problemText(p: NonNullable<Product["forecast_avalanche_problems"]>[number]): string {
  const parts = [p.name];
  if (p.likelihood) parts.push(p.likelihood);
  if (p.size && p.size.length > 0) {
    const [a, b] = p.size.map(String);
    parts.push(b && b !== a ? `size ${a} to ${b}` : `size ${a}`);
  }
  if (p.location && p.location.length > 0) parts.push(locationText(p.location));
  return `${parts[0]}: ${parts.slice(1).join(", ")}`;
}

function localTime(iso: string | null | undefined, zone: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleString("en-US", { timeZone: zone ?? "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch {
    return d.toISOString();
  }
}

/** One zone's feature: the map layer's rating, refined by the product when there is one. */
export function zoneFeature(zone: Zone, product: Product | null): Feature {
  const p = zone.properties;
  const props: Record<string, unknown> = {
    name: p.name,
    center: p.center ?? p.center_id,
    centerId: p.center_id,
    ...(p.state && { state: p.state }),
  };
  let v = level(p.danger_level);
  const today = product?.danger?.find((d) => d.valid_day === "current") ?? product?.danger?.[0];
  const tomorrow = product?.danger?.find((d) => d.valid_day === "tomorrow");
  if (today) {
    const bands = [level(today.upper), level(today.middle), level(today.lower)];
    v = Math.max(v, ...bands);
    props.upper = levelText(bands[0]);
    props.middle = levelText(bands[1]);
    props.lower = levelText(bands[2]);
  }
  if (tomorrow) {
    const t = [level(tomorrow.upper), level(tomorrow.middle), level(tomorrow.lower)];
    if (Math.max(...t) > 0) props.tomorrow = `Above treeline ${levelText(t[0])}, near ${levelText(t[1])}, below ${levelText(t[2])}`;
  }
  props.v = v;
  props.danger = v;
  const problems = (product?.forecast_avalanche_problems ?? []).map(problemText);
  if (problems.length > 0) props.problems = problems;
  if (product?.bottom_line) props.bottomLine = plainText(product.bottom_line);
  if (p.travel_advice && v > 0) props.travelAdvice = p.travel_advice;
  const issued = localTime(product?.published_time ?? p.start_date, p.timezone);
  const expires = localTime(product?.expires_time ?? p.end_date, p.timezone);
  if (v > 0) {
    if (issued) props.issued = issued;
    if (expires) props.expires = expires;
  }
  if (p.off_season || v === 0) props.season = p.off_season ? "Out of season: no daily rating" : "No rating today";
  if (p.link) props.link = p.link;
  if (p.center_link) props.centerLink = p.center_link;
  return { type: "Feature", geometry: zone.geometry as Geometry, properties: props };
}

async function fetchProduct(ctx: QueryContext, zone: Zone): Promise<Product | null> {
  const id = zone.id;
  if (id === undefined) return null;
  try {
    const res = await ctx.fetch(`${API}/product?type=forecast&center_id=${encodeURIComponent(zone.properties.center_id)}&zone_id=${id}`, {
      cacheKey: `avalanche:product:${zone.properties.center_id}:${id}`,
      ttlSeconds: 900,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const parsed = ProductSchema.safeParse(await res.json());
    return parsed.success && parsed.data.product_type === "forecast" ? parsed.data : null;
  } catch {
    return null;
  }
}

const HELP: Record<string, FieldHelp> = {
  danger: {
    text: "The day's avalanche danger for the zone on the North American Public Avalanche Danger Scale, as the avalanche center rates it: 1 Low to 5 Extreme; the highest of its elevation bands.",
    scale: "North American Public Avalanche Danger Scale, 1 to 5",
    source: "The zone's avalanche center, via avalanche.org",
    url: "https://avalanche.org/avalanche-encyclopedia/human/resources/north-american-public-avalanche-danger-scale/",
  },
  upper: { text: "Danger above treeline (the alpine), as the center rates it today." },
  middle: { text: "Danger near treeline, as the center rates it today." },
  lower: { text: "Danger below treeline, as the center rates it today." },
  problems: { text: "The avalanche problems the center names today: the kind of avalanche, how likely, how big (size 1 small to 5 largest), and on which aspects and elevations." },
  bottomLine: { text: "The center's own summary of the day, shortened." },
};

const CARD: CardSpec = {
  facts: [
    { key: "danger", label: "Danger", values: Object.fromEntries(DANGER.map((d) => [String(d.value), d.label])) },
    { key: "upper", label: "Above treeline" },
    { key: "middle", label: "Near treeline" },
    { key: "lower", label: "Below treeline" },
    { key: "tomorrow", label: "Tomorrow" },
    { key: "problems", label: "Avalanche problems", format: "list" },
    { key: "bottomLine", label: "Bottom line" },
    { key: "travelAdvice", label: "Travel advice" },
    { key: "season", label: "Season" },
    { key: "issued", label: "Issued" },
    { key: "expires", label: "Expires" },
    { key: "center", label: "Avalanche center" },
  ],
  links: [
    { key: "link", label: "Read the full forecast" },
    { key: "centerLink", label: "Avalanche center" },
  ],
  hidden: ["v", "centerId", "state"],
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "danger",
    type: "ordinal",
    label: "Avalanche danger",
    primary: true,
    levels: DANGER.map((d) => ({ value: d.value, label: d.label, help: d.help })),
    scale: "North American Public Avalanche Danger Scale (1 Low to 5 Extreme)",
  },
  { key: "center", type: "category", label: "Avalanche center" },
];

export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Avalanche danger today (North American scale)",
  field: "danger",
  items: DANGER.map((d) => ({ label: d.label, value: d.value, color: d.color, symbol: "polygon" as const, help: d.help })),
  note: "Each zone is filled by its center's rating for today, the highest of its elevation bands. Read the center's forecast before going.",
};

const avalanche = defineLayer({
  id: "avalanche",
  title: "Avalanche forecasts (US avalanche centers)",
  description:
    "Today's avalanche danger in each US backcountry forecast zone, from the avalanche centers (NWAC, CAIC, UAC, Sierra Avalanche Center and the others) via avalanche.org. " +
    "Each zone is a polygon with name, center, danger (0 no rating, 1 Low, 2 Moderate, 3 Considerable, 4 High, 5 Extreme: the North American Public Avalanche Danger Scale, the highest of the day's elevation bands), upper, middle and lower (danger above, near and below treeline), tomorrow, problems (avalanche problem, likelihood, size and aspects), bottomLine (the center's summary), travelAdvice, issued and expires (local time), season (when unrated) and link (the zone's forecast page). " +
    "Use it for 'avalanche danger near Stevens Pass', 'is it safe to ski tour in the Wasatch today', 'avalanche forecast for Teton Pass'. " +
    "Always name the center, quote its rating and issue date, and link its forecast; never infer danger from snow or weather. " +
    "Out of season (roughly May to November) zones carry no rating: say so plainly and point to the center's page. Warnings issued by the NWS are in weather-alerts; snow depth is snowpack. " +
    "Coverage: the United States (avalanche.org zones); no forecasts for Canada or Europe here.",
  coverage: "us",
  surface: "land",
  license: "Forecasts by each US avalanche center, published through avalanche.org's public API (keyless; credit and link the center)",
  requiredEnv: [],
  maxAreaKm2: 10_000_000,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("avalanche"), fillOpacity: 0.45 },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: LEGEND,
  time: { shape: "single" },
  labels: { field: "name", max: 10 },
  display: { units: "us", timeZone: "local" },

  async query(ctx): Promise<LayerResult | LayerError> {
    const now = new Date();
    let body: unknown;
    try {
      const res = await ctx.fetch(MAP_LAYER, {
        cacheKey: "avalanche:map-layer",
        ttlSeconds: 900,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        validate: (b) => b.includes('"features"'),
      });
      if (!res.ok) return { error: `avalanche.org returned ${res.status}`, hint: "upstream" };
      body = await res.json();
    } catch {
      return { error: "avalanche.org did not answer", hint: "upstream" };
    }
    const citation = { source: "US avalanche centers via avalanche.org (public map layer and forecasts)", url: "https://avalanche.org/", retrieved: now.toISOString() };
    const zones = zonesInBox(body, ctx.bbox);
    if (zones.length === 0) {
      return {
        kind: "geojson",
        data: { type: "FeatureCollection", features: [] },
        citation,
        coverageNote: "No avalanche.org forecast zone covers this area (US backcountry zones only)",
      };
    }
    const rated = zones.filter((z) => level(z.properties.danger_level) > 0).slice(0, MAX_DETAIL);
    const products = new Map<Zone, Product | null>();
    await Promise.all(rated.map(async (z) => products.set(z, await fetchProduct(ctx, z))));
    const features = zones.map((z) => zoneFeature(z, products.get(z) ?? null));
    features.sort((a, b) => Number(b.properties?.danger ?? 0) - Number(a.properties?.danger ?? 0));
    const data: FeatureCollection = { type: "FeatureCollection", features };
    const ratedCount = features.filter((f) => Number(f.properties?.danger) > 0).length;
    let coverageNote: string;
    if (ratedCount === 0) {
      const centers = [...new Set(zones.map((z) => z.properties.center ?? z.properties.center_id))];
      const off = zones.filter((z) => z.properties.off_season).length;
      coverageNote =
        `No avalanche danger rating today for the ${zones.length} zone${zones.length === 1 ? "" : "s"} in view (${centers.join(", ")}): ` +
        `${off > 0 ? "the centers are between seasons" : "the centers have not rated them"} and issue daily ratings once there is enough snow. ` +
        `Snow can still slide on any steep slope; check the center's page for its early-season statement`;
    } else {
      const top = features[0].properties as Record<string, unknown>;
      coverageNote = `${ratedCount} of ${zones.length} zones rated today; highest: ${top.name} (${top.center}) ${DANGER[Number(top.danger)].label}${top.issued ? `, issued ${top.issued}` : ""}`;
    }
    return { kind: "geojson", data, citation, coverageNote };
  },
});

registerLayer(avalanche);

export default avalanche;

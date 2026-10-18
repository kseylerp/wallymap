import type { Feature } from "geojson";
import type { CardFact, CardSpec, FieldHelp } from "@/layers/types";
import { formatValue as formatNumber } from "@/lib/format";
import { formatTime, formatValue, friendlyKey, isYearOnly, summarizeFeature, type Row } from "@/lib/render/inspect";
import type { ResolvedDisplay } from "@/layers/contract";
import { localTime, quantity } from "@/lib/render/units";

/**
 * The inspect card's content for one feature (spec §12b, owner 2026-10-14): the measure under its own name ("Routes 5"),
 * the facts in plain labels and units, links by name, and every other property under Details with a humanised label.
 * Every row that has help carries it, so the card shows the serif "i" beside it and never a bare "Score N".
 */

export type CardRow = Row & { help?: FieldHelp };
export type CardLink = { key: string; label: string; url: string };
export type CardContent = {
  measure: CardRow | null;
  facts: CardRow[];
  links: CardLink[];
  /** Collapsed: identifiers and every property the schema does not name. */
  details: CardRow[];
  /** Popularity and remoteness signals (no schema needed). */
  signals: CardRow[];
  /** A picture the feature links (a Wikipedia thumbnail), shown inline rather than as a link. */
  image?: CardLink;
};

/**
 * How the card prints numbers and times (docs/layer-contract.md `display`): the layer's units (US first with metric
 * second for US-centred data), the clock, and where the feature is (its local zone). Without it, values print as held.
 */
export type CardDisplay = ResolvedDisplay & { at?: [number, number] | null };

/** Keys the card never shows: internal ids (the source's own row keys) and query notes that belong to the layer row. */
const INTERNAL = /^(id|fid|gid|objectid|globalid|uuid|osm_?id|osm_?type|h3|wikidata|irwinid|ref)$|(_id|Id|ID)$|^(note|notes|queryNote|error|errors|warning|debug)$/;

/** A link that is a picture: shown inline on the card. */
function isImageLink(link: CardLink): boolean {
  return /thumbnail|image|photo|picture/i.test(link.key) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(link.url);
}

/** Keys the card never lists as a row: the title, the date chip, internals. */
const COMPARE_KEYS = new Set(["delta", "deltaEdge", "dv", "before", "after"]);
// The compare's bookkeeping on a delta feature (lib/render/compare.ts): the strip states the change in words and units.
const HIDDEN = new Set(["name", "heading", "t", "tPrecision", "signals", "popularityNote", "aggregate", "tallest", "stack", "delta", "deltaEdge", "dv", "before", "after"]);

/**
 * Unit suffixes in property keys: `maxLengthM` reads "Max length … m", `areaKm2` "Area … km²", `swellPeriodS` "Swell
 * period … s", `tempC` "Temp … °C", `precipitationMm` "Precipitation … mm".
 */
const KEY_UNITS: [RegExp, string][] = [
  [/Km2$/, "km²"],
  [/Km$/, "km"],
  [/Ft$/, "ft"],
  [/Pct$/, "%"],
  [/Mw$|MW$/, "MW"],
  [/Mm$/, "mm"],
  [/Cm$/, "cm"],
  [/(?<=[a-z])M$/, "m"],
  [/(?<=[a-z])S$/, "s"],
  [/(?<=[a-z])C$/, "°C"],
  [/(?<=[a-z])F$/, "°F"],
];

/** Link names for URL properties the schema does not name: a page is "Link", a picture "Image". */
const LINK_LABELS: Record<string, string> = { url: "Link", link: "Link", href: "Link", website: "Website", thumbnail: "Image", image: "Image", photo: "Photo" };

/** A URL property as a named link ("Website"), never its address as text. */
function urlLink(key: string, url: string): CardLink {
  return { key, label: LINK_LABELS[key.toLowerCase()] ?? humanKey(key).label, url };
}

/** A property key as a reader's label and the unit its name implies: `maxLengthM` → ["Max length", "m"]. */
export function humanKey(key: string): { label: string; unit?: string } {
  for (const [pattern, unit] of KEY_UNITS) {
    if (pattern.test(key)) return { label: friendlyKey(key.replace(pattern, "")), unit };
  }
  return { label: friendlyKey(key) };
}

/** Values that say the source has nothing: "n/a", "Not Available", "Unknown", "None". */
const EMPTY_VALUES = new Set(["n/a", "na", "n.a.", "not available", "not applicable", "unknown", "none", "null", "-", "—", "–", "?"]);

/** True when a card value says nothing ("Condition: Not Available"); such rows are left off the card. */
export function isEmptyValue(value: string): boolean {
  return EMPTY_VALUES.has(value.trim().toLowerCase());
}

/**
 * The rows worth showing: rows that say nothing ("n/a", "Not Available", "Unknown", "None") are left out. When every row
 * of the card says nothing, they are kept under Details, so the card still says what the source holds.
 */
function dropEmpty(facts: CardRow[], details: CardRow[], hasMeasure: boolean): { facts: CardRow[]; details: CardRow[] } {
  const keptFacts = facts.filter((r) => !isEmptyValue(r.value));
  const keptDetails = details.filter((r) => !isEmptyValue(r.value));
  if (keptFacts.length > 0 || keptDetails.length > 0 || hasMeasure) return { facts: keptFacts, details: keptDetails };
  return { facts: [], details: [...facts, ...details] };
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value);
}

/** A fact's value as text in its format and unit; null when the feature has nothing for it. */
export function factValue(fact: CardFact, props: Record<string, unknown>, display?: CardDisplay): string | null {
  if (fact.parts) {
    const parts = fact.parts
      .map((p) => ({ p, v: props[p.key] }))
      .filter(({ v }) => typeof v === "number" && Number.isFinite(v) && v !== 0)
      .map(({ p, v }) => `${p.label} ${formatNumber("count", v as number)}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const raw = props[fact.key];
  if (raw === null || raw === undefined || raw === "") return null;
  // Degrees sit on the number ("262°"); other units after a space.
  const unit = fact.unit ? (fact.unit === "°" ? "°" : ` ${fact.unit}`) : "";
  if (fact.values && (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") && fact.values[String(raw)] !== undefined) {
    return fact.values[String(raw)];
  }
  // In the layer's display units, the other system second ("5,280 ft (1,609 m)").
  if (display && typeof raw === "number" && (fact.unit || fact.format === "km" || fact.format === "m") && fact.format !== "pct") {
    const u = fact.format === "km" ? "km" : fact.format === "m" ? "m" : fact.unit;
    if (u && u !== "°") return quantity(fact.format === "int" ? Math.round(raw) : raw, u, display, fact.key);
  }
  switch (fact.format) {
    case "int":
      return typeof raw === "number" ? `${formatNumber(fact.key, Math.round(raw), undefined, 0)}${unit}` : `${String(raw)}${unit}`;
    case "1dp":
      return typeof raw === "number" ? `${formatNumber(fact.key, raw, undefined, 1)}${unit}` : `${String(raw)}${unit}`;
    case "km":
      return typeof raw === "number" ? `${formatNumber(fact.key, raw, undefined, 1)} km` : String(raw);
    case "m":
      return typeof raw === "number" ? `${formatNumber(fact.key, Math.round(raw), undefined, 0)} m` : String(raw);
    case "date":
      return typeof raw === "string" ? ((display && localTime(raw, display.at, display)) || formatTime(raw, props)) : String(raw);
    case "list": {
      const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(/\s*[,;]\s*/);
      // Codes in a list read through the fact's values ("advanced" → "Advanced").
      return items.filter(Boolean).map((x) => fact.values?.[x] ?? x.replace(/_/g, " ")).join(" · ");
    }
    case "link":
      return isUrl(raw) ? raw : String(raw);
    case "pct":
      return typeof raw === "number" ? `${Math.round(raw * 100)}%` : String(raw);
    default:
      if (isYearOnly(raw, props)) return String(raw).trim().slice(0, 4);
      return typeof raw === "number" ? `${formatNumber(fact.key, raw, fact.unit)}${unit}` : `${formatValue(raw, undefined, fact.key)}${unit}`;
  }
}

/** The help for a key: the schema's own, else the layer's field help. */
function helpFor(key: string, own: FieldHelp | undefined, fieldHelp: Record<string, FieldHelp> | undefined): FieldHelp | undefined {
  return own ?? fieldHelp?.[key];
}

/**
 * The card for one feature of a layer with a `card` schema: its measure, facts and links as declared, and every other
 * property (identifiers included) under Details, humanised. Without a schema, the plain summary (summarizeFeature)
 * with help attached and the score's name in place of "Score".
 */
export function cardContent(
  feature: Feature,
  opts: { unit?: string; card?: CardSpec; fieldHelp?: Record<string, FieldHelp>; display?: CardDisplay } = {},
): CardContent {
  const { unit, card, fieldHelp, display } = opts;
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const summary = summarizeFeature(feature, unit, card ? 0 : 8);
  if (!card) return withImage(plainContent(feature, summary, unit, fieldHelp, display));

  const used = new Set<string>([...HIDDEN, ...(card.hidden ?? [])]);
  let measure: CardRow | null = null;
  // Properties the measure already shows (its twin copies of v): not repeated as facts.
  const shown = new Set<string>();
  if (card.measure && props[card.measure.key] !== undefined && props[card.measure.key] !== null) {
    const m = card.measure;
    const raw = props[m.key];
    const value =
      typeof raw === "number"
        ? display && m.unit
          ? quantity(raw, m.unit, display, m.key)
          : `${formatNumber(m.key, raw, m.unit)}${m.unit ? ` ${m.unit}` : ""}`
        : formatValue(raw, m.unit, m.key);
    // `v` copied into a named property (routes, hazard score) is the same number: listed once, with either's help.
    const twins = Object.keys(props).filter((k) => k !== m.key && (k === "v" || m.key === "v") && props[k] === raw);
    const help = helpFor(m.key, m.help, fieldHelp) ?? twins.map((k) => fieldHelp?.[k]).find(Boolean);
    measure = { key: m.key, label: m.label, value, ...withHelp(help) };
    used.add(m.key);
    for (const k of twins) {
      used.add(k);
      shown.add(k);
    }
  }
  const facts: CardRow[] = [];
  for (const fact of card.facts ?? []) {
    if (shown.has(fact.key)) continue;
    const value = factValue(fact, props, display);
    used.add(fact.key);
    for (const p of fact.parts ?? []) used.add(p.key);
    if (value === null) continue;
    facts.push({ key: fact.key, label: fact.label, value, ...withHelp(helpFor(fact.key, fact.help, fieldHelp)) });
  }
  // The source's own spelling when the shown name was put in ordinary capitals or spelled out (layers/_shared/names.ts).
  if (typeof props.nameInSource === "string" && props.nameInSource !== "" && !used.has("nameInSource")) {
    facts.push({ key: "nameInSource", label: "Name in source", value: props.nameInSource, help: NAME_IN_SOURCE_HELP });
    used.add("nameInSource");
  }
  const links: CardLink[] = [];
  for (const link of card.links ?? []) {
    used.add(link.key);
    const url = props[link.key];
    if (isUrl(url)) links.push({ key: link.key, label: link.label, url });
  }
  const details: CardRow[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (used.has(key) || raw === null || raw === undefined || raw === "") continue;
    if (typeof raw === "object") continue;
    if (display && INTERNAL.test(key)) continue;
    // v is the number the map draws by: a schema with no measure, or whose measure is shown, has named it elsewhere.
    if (key === "v" && (!card.measure || measure !== null)) continue;
    // An address the schema does not name is still a link by name, not text.
    if (isUrl(raw)) {
      links.push(urlLink(key, raw));
      continue;
    }
    const { label, unit: keyUnit } = humanKey(key);
    const value =
      typeof raw === "number"
        ? display && keyUnit
          ? quantity(raw, keyUnit, display, key)
          : `${formatNumber(key, raw)}${keyUnit ? ` ${keyUnit}` : ""}`
        : isYearOnly(raw, props)
          ? String(raw).trim().slice(0, 4)
          : ((display && typeof raw === "string" && localTime(raw, display.at, display)) || formatValue(raw, undefined, key));
    details.push({ key, label, value, ...withHelp(fieldHelp?.[key]) });
  }
  if (feature.id !== undefined && !("id" in props) && !display) details.unshift({ key: "id", label: "Id", value: String(feature.id) });
  return withImage({ measure, ...dropEmpty(facts, details, measure !== null), links, signals: summary.signals });
}

/** The first picture link, taken out of the links to show inline. */
function withImage(content: CardContent): CardContent {
  const image = content.links.find(isImageLink);
  return image ? { ...content, image, links: content.links.filter((l) => l !== image) } : content;
}

const NAME_IN_SOURCE_HELP: FieldHelp = {
  text: "The name as the source writes it. The title shows it in ordinary capitals, with the source's abbreviations spelled out.",
};

function withHelp(help: FieldHelp | undefined): { help?: FieldHelp } {
  return help ? { help } : {};
}

/** The plain summary with help on every row that has some, and a score named by its property, never "Score". */
function plainContent(
  feature: Feature,
  summary: ReturnType<typeof summarizeFeature>,
  unit: string | undefined,
  fieldHelp: Record<string, FieldHelp> | undefined,
  display?: CardDisplay,
): CardContent {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  let measure: CardRow | null = summary.value;
  if (measure) {
    const twin = Object.keys(props).find((k) => k !== "v" && !HIDDEN.has(k) && props[k] === props.v);
    const help = fieldHelp?.v ?? (twin ? fieldHelp?.[twin] : undefined);
    // A score with its own scale (a hazard score of 10 to 17,600) is not "/ 100", and is named by its property.
    if (unit === "score" && (help?.scale || twin)) {
      const label = twin ? friendlyKey(twin) : measure.label;
      measure = { key: "v", label, value: formatValue(props.v, undefined, twin ?? "v") };
    }
    measure = { ...measure, ...withHelp(help) };
  }
  // Addresses are links by name, never text rows.
  const links: CardLink[] = [];
  const keep = (rows: Row[]): Row[] =>
    rows.filter((r) => {
      const raw = props[r.key];
      if (!isUrl(raw)) return true;
      links.push(urlLink(r.key, raw));
      return false;
    });
  // A unit in the key ("precipitationMm") reads as a unit on the value, as with a schema.
  const attach = (rows: Row[]): CardRow[] =>
    rows
      .filter((r) => !(display && INTERNAL.test(r.key)) && !COMPARE_KEYS.has(r.key))
      .map((r) => {
        const { label, unit: keyUnit } = humanKey(r.key);
        const raw = props[r.key];
        const unitRow =
          keyUnit && typeof raw === "number" ? { label, value: display ? quantity(raw, keyUnit, display, r.key) : `${r.value} ${keyUnit}` } : {};
        const timed = display && typeof raw === "string" ? localTime(raw, display.at, display) : null;
        return { ...r, ...unitRow, ...(timed && { value: timed }), ...withHelp(fieldHelp?.[r.key]) };
      });
  const rows = dropEmpty(attach(keep(summary.rows)), attach(keep(summary.details)), measure !== null);
  return { measure, facts: rows.facts, links, details: rows.details, signals: attach(summary.signals) };
}

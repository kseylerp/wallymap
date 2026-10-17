import type { Feature } from "geojson";
import type { CardFact, CardSpec, FieldHelp } from "@/layers/types";
import { formatValue as formatNumber } from "@/lib/format";
import { formatDate, formatValue, friendlyKey, summarizeFeature, type Row } from "@/lib/render/inspect";

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
};

/** Keys the card never lists as a row: the title, the date chip, internals. */
const HIDDEN = new Set(["name", "t", "signals", "popularityNote", "aggregate", "tallest", "stack"]);

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

function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value);
}

/** A fact's value as text in its format and unit; null when the feature has nothing for it. */
export function factValue(fact: CardFact, props: Record<string, unknown>): string | null {
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
      return typeof raw === "string" ? formatDate(raw) : String(raw);
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
export function cardContent(feature: Feature, opts: { unit?: string; card?: CardSpec; fieldHelp?: Record<string, FieldHelp> } = {}): CardContent {
  const { unit, card, fieldHelp } = opts;
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const summary = summarizeFeature(feature, unit, card ? 0 : 8);
  if (!card) return plainContent(feature, summary, unit, fieldHelp);

  const used = new Set<string>([...HIDDEN, ...(card.hidden ?? [])]);
  let measure: CardRow | null = null;
  // Properties the measure already shows (its twin copies of v): not repeated as facts.
  const shown = new Set<string>();
  if (card.measure && props[card.measure.key] !== undefined && props[card.measure.key] !== null) {
    const m = card.measure;
    const raw = props[m.key];
    const value = typeof raw === "number" ? `${formatNumber(m.key, raw, m.unit)}${m.unit ? ` ${m.unit}` : ""}` : formatValue(raw, m.unit, m.key);
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
    const value = factValue(fact, props);
    used.add(fact.key);
    for (const p of fact.parts ?? []) used.add(p.key);
    if (value === null) continue;
    facts.push({ key: fact.key, label: fact.label, value, ...withHelp(helpFor(fact.key, fact.help, fieldHelp)) });
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
    // v is the number the map draws by: a schema with no measure, or whose measure is shown, has named it elsewhere.
    if (key === "v" && (!card.measure || measure !== null)) continue;
    // An address the schema does not name is still a link by name, not text.
    if (isUrl(raw)) {
      links.push(urlLink(key, raw));
      continue;
    }
    const { label, unit: keyUnit } = humanKey(key);
    const value = typeof raw === "number" ? `${formatNumber(key, raw)}${keyUnit ? ` ${keyUnit}` : ""}` : formatValue(raw, undefined, key);
    details.push({ key, label, value, ...withHelp(fieldHelp?.[key]) });
  }
  if (feature.id !== undefined && !("id" in props)) details.unshift({ key: "id", label: "Id", value: String(feature.id) });
  return { measure, facts, links, details, signals: summary.signals };
}

function withHelp(help: FieldHelp | undefined): { help?: FieldHelp } {
  return help ? { help } : {};
}

/** The plain summary with help on every row that has some, and a score named by its property, never "Score". */
function plainContent(
  feature: Feature,
  summary: ReturnType<typeof summarizeFeature>,
  unit: string | undefined,
  fieldHelp: Record<string, FieldHelp> | undefined,
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
    rows.map((r) => {
      const { label, unit: keyUnit } = humanKey(r.key);
      const raw = props[r.key];
      const unitRow = keyUnit && typeof raw === "number" ? { label, value: `${r.value} ${keyUnit}` } : {};
      return { ...r, ...unitRow, ...withHelp(fieldHelp?.[r.key]) };
    });
  return { measure, facts: attach(keep(summary.rows)), links, details: attach(keep(summary.details)), signals: attach(summary.signals) };
}

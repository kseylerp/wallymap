/**
 * Forest types from Forest Typology (ForTy), Google DeepMind with WRI and IIASA (spec §14): every 10 m of land as primary
 * forest, naturally regenerating forest, planted forest, plantation forest, tree crops and agroforestry, or other land
 * (FAO definitions), with a probability for each class. Neumann et al., Scientific Data (2026); CC BY 4.0.
 *
 * Served through Google Earth Engine (lib/ee): the server makes the picture with its own credentials and the map loads
 * our tile route (app/api/ee/tiles/forest-types/...), never Google's. The assets, their bands and how the classes are
 * read are in lib/ee/forestTypes.ts. Three answers:
 *   - the 2020 baseline (v1.0, the peer-reviewed map) with the confidence control as a plain two-option
 *     toggle in the layer row ("All" or "Only confident pixels", the most likely class at least 70% sure), the default;
 *     it is not time, so the time panel and compare stay out of it;
 *   - one year of the yearly beta series 2017 to 2025 (`year`), on the time scrubber;
 *   - the change view (`convertedSince`): natural forest (primary or naturally regenerating) in that year that is
 *     plantation, tree crops or other land in 2025, in the change grammar's pink with the areas stated.
 * The legend lists the classes in view with their share of the view (POST /api/layer/forest-types/shares, viewShares),
 * and a tap reads the six probabilities at the point (identify).
 */
import { z } from "zod";
import { defineLayer, type Attribute, type FieldHelp, type LayerError, type LayerResult, type LegendSpec, type TileScenario, type TimeSpec } from "./types";
import { registerLayer } from "./registry";
import { pointFeature } from "./_shared/identify";
import { createEeClient, EeError, type EeClient } from "@/lib/ee/client";
import {
  CLASSES,
  CONFIDENT,
  FIRST_YEAR,
  LAST_YEAR,
  OTHER_ALPHA,
  OTHER_CODE,
  TARGETS,
  UNCHANGED_ALPHA,
  UNCHANGED_COLOR,
  YEARS,
  areaScale,
  conversionAreasExpression,
  pointExpression,
  readConversionAreas,
  readPoint,
  readShares,
  sharesExpression,
  tileQuery,
  type ConversionAreas,
  type Source,
  type TileParams,
} from "@/lib/ee/forestTypes";
import { eeTileTemplate } from "@/lib/ee/tiles";
import { DARK_GREY, layerColor, SAGE } from "@/lib/render/palette";
import { hexToRgb, rgbToHex } from "@/lib/render/ramp";

const CITATION_SOURCE =
  "Forest Typology (ForTy) 2020 v1.0 and yearly beta 2017–2025, Google DeepMind, World Resources Institute and IIASA " +
  "(CC BY 4.0); Neumann et al., Scientific Data (2026); via Google Earth Engine";
// The paper as the dataset's Earth Engine page cites it (EarthArXiv, May 2026); the row's source line names the makers instead of the host.
const CITATION_URL = "https://www.nature.com/articles/s41597-026-08299-5";
const CITATION_LABEL = "Google DeepMind, WRI, IIASA (ForTy, CC BY 4.0)";
const LICENSE = "CC BY 4.0 (Google DeepMind, WRI, IIASA; Neumann et al., Scientific Data 2026)";

export const CONFIDENT_PCT = Math.round(CONFIDENT * 100);
const BELOW_LABEL = `Not drawn: less than ${CONFIDENT_PCT}% sure`;

/** A color drawn at `alpha` over the key's white, as the faint pixels look on a light map (the swatch cannot be see-through). */
const faint = (hex: string, alpha: number): string => rgbToHex(hexToRgb(hex).map((c) => 255 - (255 - c) * alpha) as [number, number, number]);

/** The class key, one swatch per class in the colors the tiles draw: other land faint, so its swatch is pale, not dark. */
export const LEGEND: LegendSpec = {
  kind: "categories",
  title: "Forest type",
  field: "class",
  items: CLASSES.map((c) => ({ label: c.label, value: c.code, color: c.code === OTHER_CODE ? faint(c.color, OTHER_ALPHA) : c.color, symbol: "raster" as const, help: c.help })),
  note: "Each 10 m pixel shows its most likely class; other land is drawn faint and water left out. Colors are WallyMap's, not ForTy's.",
};

function classesLegend(confident: boolean): LegendSpec {
  if (!confident) return LEGEND;
  return { ...LEGEND, items: [...(LEGEND.items ?? []), { label: BELOW_LABEL, value: 0, color: faint(DARK_GREY, 0.1), symbol: "raster" as const, help: `Pixels whose most likely class is less than ${CONFIDENT_PCT}% sure are left blank.` }] };
}

const km2 = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(0) : n.toFixed(1));

/** The change key: lost natural forest by what replaced it, each with its area in the asked box. */
function changeLegend(since: number, areas: ConversionAreas | null): LegendSpec {
  return {
    kind: "categories",
    title: `Natural forest converted since ${since}`,
    field: "change",
    items: [
      ...TARGETS.map((t) => ({
        label: areas ? `To ${t.label.toLowerCase()}: ${km2(areas.byTarget[t.key])} km²` : `To ${t.label.toLowerCase()}`,
        value: t.code,
        color: t.color,
        symbol: "raster" as const,
      })),
      { label: `Natural forest still standing in ${LAST_YEAR} (faint)`, value: 0, color: faint(UNCHANGED_COLOR, UNCHANGED_ALPHA), symbol: "raster" as const },
    ],
    note: "Natural forest is primary or naturally regenerating. Yearly beta maps; areas are for the box asked, estimated on a coarser grid.",
  };
}

/** The confidence control: a two-step scenario, "All" or "Only confident pixels". */
function confidenceScenario(params: TileParams): TileScenario {
  const all = eeTileTemplate("forest-types", tileQuery({ ...params, minConfidence: 0 }));
  return {
    param: "confidence",
    label: "Pixels shown",
    unit: "% sure",
    // A setting in the layer row, not time: no scrubber, play or compare (TileScenario.control).
    control: "toggle",
    values: [0, CONFIDENT_PCT],
    labels: ["All", "Only confident pixels"],
    tokens: ["all", "confident"],
    template: all.replace("conf=all", "conf={value}"),
  };
}

const inputSchema = z.object({
  confidence: z.enum(["all", "confident"]).default("all"),
  year: z.number().int().min(FIRST_YEAR).max(LAST_YEAR).optional(),
  convertedSince: z.number().int().min(FIRST_YEAR).max(LAST_YEAR - 1).optional(),
});

const help = (text: string): FieldHelp => ({ text, unit: "share of 1", source: "ForTy (Neumann et al., Scientific Data 2026)", url: CITATION_URL });

const FIELD_HELP: Record<string, FieldHelp> = Object.fromEntries([
  ...CLASSES.map((c) => [`p_${c.key}`, help(`How likely the model thinks this 10 m pixel is ${c.label.toLowerCase()}: ${c.help}`)]),
  ["summary", { text: "The most likely class at this point and how sure the model is. The six chances add up to 100%; the map draws the largest.", source: "ForTy (Neumann et al., Scientific Data 2026)", url: CITATION_URL }],
]);

const ATTRIBUTES: Attribute[] = [
  {
    key: "class",
    type: "category",
    label: "Forest type",
    levels: CLASSES.map((c) => ({ value: c.code, label: c.label, help: c.help })),
    primary: true,
  },
];

/** "almost certainly" .. "possibly", for a probability. */
export function sureWords(p: number): string {
  if (p >= 0.9) return "Almost certainly";
  if (p >= CONFIDENT) return "Very likely";
  if (p >= 0.5) return "Likely";
  return "Possibly";
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function sourceOf(input: z.infer<typeof inputSchema>): Source {
  return input.year !== undefined ? { kind: "year", year: input.year } : { kind: "baseline" };
}

function minConfidenceOf(input: z.infer<typeof inputSchema>, scenario?: number | string): number {
  if (scenario !== undefined && scenario !== "") return Number(scenario) >= CONFIDENT_PCT ? CONFIDENT : 0;
  return input.confidence === "confident" ? CONFIDENT : 0;
}

/** "primary forest 36%, naturally regenerating forest 26%, ..." for the classes over 0.5% of the box, largest first. */
export function sharesSentence(shares: Record<string, number>): string {
  return Object.entries(shares)
    .map(([code, share]) => ({ label: code === "0" ? `less than ${CONFIDENT_PCT}% sure (not drawn)` : (CLASSES.find((c) => String(c.code) === code)?.label.toLowerCase() ?? code), share }))
    .filter((e) => e.share >= 0.005)
    .sort((a, b) => b.share - a.share)
    .map((e) => `${e.label} ${pct(e.share)}`)
    .join(", ");
}

const SPAN = { start: String(FIRST_YEAR), end: String(LAST_YEAR) };
const TIME_NONE: TimeSpec = { shape: "none" };
const TIME_YEARS: TimeSpec = { shape: "continuous", step: "year", span: SPAN };
const TIME_CHANGE: TimeSpec = { shape: "snapshots", dates: YEARS.map(String), step: "year", span: SPAN };

const failure = (error: unknown): LayerError => {
  if (error instanceof EeError) {
    const unset = /not set up/.test(error.sourceStatus.message);
    return { error: error.sourceStatus.message, hint: unset ? "unavailable" : "upstream", sourceStatus: error.sourceStatus };
  }
  return { error: String(error), hint: "upstream" };
};

const client = (env: Record<string, string | undefined>): EeClient => createEeClient({ env });

const forestTypes = defineLayer({
  id: "forest-types",
  title: "Forest types",
  description:
    "Global map of what kind of forest grows where, 10 m detail, from Google DeepMind, WRI and IIASA (Forest Typology, ForTy): primary forest, naturally regenerating forest, planted forest, plantation forest, tree crops and agroforestry (oil palm, rubber, cocoa, coffee), or other land, each pixel its most likely class with a probability for all six. " +
    "Use it for 'is this primary forest or plantation', 'old or natural forest versus plantations', 'where are the oil palm plantations', 'what replaced the forest'. " +
    "By default it is the 2020 baseline map (FAO definitions, about 90% accurate); confidence 'confident' draws only pixels at least 70% sure (strict, for regulation such as the EU deforestation rule), 'all' every pixel (extent). " +
    "year (2017–2025) shows that year of the early yearly series instead. " +
    "convertedSince (2017–2024) draws the change view: natural forest (primary or naturally regenerating) in that year that is plantation, tree crops or other land in 2025, in pink, with the areas in km² for the box in the coverage note; use it for 'where has natural forest been converted to plantations since 2017'. " +
    "The coverage note gives each class's share of the box asked (or the converted areas): quote those numbers. " +
    "Caveats: a model's classification, not a survey; the yearly series is a beta. " +
    "Returns map tiles drawn on the globe, not features you can count or list.",
  coverage: "global",
  surface: "land",
  license: LICENSE,
  requiredEnv: ["EE_PROJECT"],
  // The service account key in production; locally the gcloud application default credentials (lib/ee/auth.ts).
  optionalEnv: ["EE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: inputSchema,
  style: { geometry: "polygon", color: layerColor("forest-types"), raster: { saturation: 0, opacity: 0.85, swatch: SAGE } },
  legend: LEGEND,
  attributes: ATTRIBUTES,
  fieldHelp: FIELD_HELP,
  card: {
    facts: [
      { key: "summary", label: "Reading" },
      ...CLASSES.map((c) => ({ key: `p_${c.key}`, label: c.label, format: "pct" as const })),
      { key: "before", label: "Before" },
      { key: "map", label: "Map" },
    ],
    hidden: ["class", "change"],
  },
  // Each answer says its own (below): the 2020 baseline has none, the yearly series is years on the scrubber, the change
  // view is the snapshots it compares.
  time: { shape: "none" },
  display: { units: "metric" },

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const retrieved = new Date().toISOString();
    const citation = { source: CITATION_SOURCE, url: CITATION_URL, retrieved, label: CITATION_LABEL };
    const ee = client(ctx.env);
    const minConfidence = minConfidenceOf(input);

    if (input.convertedSince !== undefined) {
      if (input.year !== undefined) return { error: "Use either year or convertedSince, not both" };
      const since = input.convertedSince;
      const params: TileParams = { view: "change", since, to: LAST_YEAR, minConfidence };
      let areas: ConversionAreas | null;
      try {
        areas = readConversionAreas(await ee.compute(conversionAreasExpression(since, LAST_YEAR, minConfidence, ctx.bbox)));
      } catch (error) {
        return failure(error);
      }
      const sure = minConfidence > 0 ? `, counting only pixels at least ${CONFIDENT_PCT}% sure in both years` : "";
      const stated = areas
        ? `Natural forest in ${since} that is something else in ${LAST_YEAR}, in the box asked: about ${km2(areas.converted)} km²` +
          (areas.naturalBefore > 0 ? ` (${((100 * areas.converted) / areas.naturalBefore).toFixed(1)}% of ${km2(areas.naturalBefore)} km² of natural forest)` : "") +
          `: ${TARGETS.map((t) => `${t.label.toLowerCase()} ${km2(areas!.byTarget[t.key])} km²`).join(", ")}`
        : `Natural forest in ${since} that is something else in ${LAST_YEAR}`;
      return {
        kind: "tiles",
        data: { url: eeTileTemplate("forest-types", tileQuery(params)), minzoom: 3, maxzoom: 14, format: "raster" },
        citation,
        time: TIME_CHANGE,
        coverageNote: `${stated}. ForTy yearly beta; areas estimated on a ${areaScale(ctx.bbox)} m grid${sure}`,
        legend: changeLegend(since, areas),
      };
    }

    const source = sourceOf(input);
    const params: TileParams = { view: "classes", source, minConfidence };
    let shares: Record<string, number> = {};
    try {
      shares = readShares(await ee.compute(sharesExpression(source, minConfidence, ctx.bbox)));
    } catch (error) {
      return failure(error);
    }
    const which = source.kind === "baseline" ? "ForTy 2020 baseline (v1.0)" : `ForTy ${source.year} (yearly beta)`;
    const inBox = Object.keys(shares).length > 0 ? `; share of the land in the box asked: ${sharesSentence(shares)}` : "; no ForTy data in the box asked (sea or outside the map)";
    const url = eeTileTemplate("forest-types", tileQuery(params));
    return {
      kind: "tiles",
      data: {
        url,
        minzoom: 3,
        maxzoom: 14,
        format: "raster",
        ...(source.kind === "baseline"
          ? { scenario: confidenceScenario(params) }
          : {
              time: {
                template: eeTileTemplate("forest-types", tileQuery(params)).replace(`src=${source.year}`, "src={year}"),
                cadence: "yearly" as const,
                from: String(FIRST_YEAR),
                to: String(LAST_YEAR),
              },
            }),
      },
      citation,
      time: source.kind === "baseline" ? TIME_NONE : TIME_YEARS,
      coverageNote: `${which}, ${minConfidence > 0 ? `only pixels at least ${CONFIDENT_PCT}% sure` : "every pixel"}${inBox}`,
      legend: classesLegend(minConfidence > 0),
    };
  },

  async viewShares(ctx, at, input) {
    if (input.convertedSince !== undefined) return null;
    const year = at.time ? Number(at.time.slice(0, 4)) : undefined;
    const source: Source = input.year !== undefined && year !== undefined && year >= FIRST_YEAR && year <= LAST_YEAR ? { kind: "year", year } : sourceOf(input);
    try {
      return { field: "class", shares: readShares(await client(ctx.env).compute(sharesExpression(source, minConfidenceOf(input, at.scenario), ctx.bbox))) };
    } catch (error) {
      return failure(error);
    }
  },

  async identify(ctx, at, input) {
    const ee = client(ctx.env);
    const year = at.time ? Number(at.time.slice(0, 4)) : undefined;
    const source: Source =
      input.convertedSince !== undefined
        ? { kind: "year", year: LAST_YEAR }
        : input.year !== undefined
          ? { kind: "year", year: year !== undefined && year >= FIRST_YEAR && year <= LAST_YEAR ? year : input.year }
          : { kind: "baseline" };
    try {
      const reading = readPoint(await ee.compute(pointExpression(source, at.lon, at.lat)));
      if (!reading) return null;
      const cls = CLASSES.find((c) => c.code === reading.classCode)!;
      const top = reading.probabilities[cls.key];
      const props: Record<string, unknown> = {
        name: cls.label,
        class: cls.code,
        summary: `${sureWords(top)} ${cls.label.toLowerCase()} (${pct(top)} sure)`,
        ...Object.fromEntries(CLASSES.map((c) => [`p_${c.key}`, reading.probabilities[c.key]])),
        map: source.kind === "baseline" ? "ForTy 2020 baseline (v1.0)" : `ForTy ${source.year} (yearly beta)`,
      };
      if (input.convertedSince !== undefined) {
        const before = readPoint(await ee.compute(pointExpression({ kind: "year", year: input.convertedSince }, at.lon, at.lat)));
        if (before) {
          const was = CLASSES.find((c) => c.code === before.classCode)!;
          props.before = `${was.label} in ${input.convertedSince} (${pct(before.probabilities[was.key])} sure)`;
        }
      }
      return pointFeature(at, props);
    } catch (error) {
      return failure(error);
    }
  },
});

registerLayer(forestTypes);

export default forestTypes;

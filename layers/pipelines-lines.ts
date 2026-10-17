/**
 * Energy pipelines and high-voltage power lines in the United States, from the Esri Federal User Community mirror of the
 * federal (EIA / HIFLD) data. The mirror is a frozen copy (the plan records it as of 2025-08), so it lags the agencies.
 * Services (verified live 2026-10-10, keyless, polylines, maxRecordCount 2000), all under
 *   https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/<name>/FeatureServer/0
 *   Natural_Gas_Interstate_and_Intrastate_Pipelines_1   32,892 segments   TYPEPIPE (Interstate | Intrastate), Operator, Status (Operating)
 *   Crude_Oil_Trunk_Pipelines_1                         236 lines         Opername, Pipename
 *   Hydrocarbon_Gas_Liquids_Pipelines_1                 133 lines         Opername, Pipename
 *   Petroleum_Products_Pipelines_1                      329 lines         Opername, Pipename
 *   US_Electric_Power_Transmission_Lines                94,619 segments   ID, TYPE ("AC; OVERHEAD"), STATUS (IN SERVICE | INACTIVE | UNDER CONSTRUCTION |
 *                                                       NOT AVAILABLE), OWNER, VOLTAGE (kV; -999999 when unknown), VOLT_CLASS
 *                                                       (UNDER 100, 100-161, 220-287, 345, 500, 735 AND ABOVE, DC, NOT AVAILABLE)
 * Gas and transmission are many short segments, so a cap per service (MAX_PER_SERVICE) keeps a dense view readable:
 * gas keeps the longest segments, transmission the highest voltage. Transmission defaults to 100 kV and up (minKv)
 * because the lower-voltage network is distribution-scale clutter, and leaves out INACTIVE lines.
 * Output properties: kind (natural gas pipeline | crude oil pipeline | gas liquids pipeline | petroleum products pipeline |
 * transmission line), name, operator, plus pipelineType (gas), status, owner, voltageKv and v (kV) and voltageClass (power lines).
 * Smoke through runLayer (2026-10-10): Houston -97,29,-95,31, network all, returned 1,929 lines in 0.5 s (698 KB: 914 gas,
 * 23 crude, 18 gas liquids, 18 products, 956 power lines of 100 kV and up); Tahoe -120.4,38.7,-119.8,39.3 returned 13 lines (5 KB);
 * Houston with network transmission and minKv 345 returned 83 lines (38 KB).
 * Smoke wide (2026-10-14): West Texas -104,29,-96,35 (about 392,000 km²), network all, returned 1,330 lines of 6,842 in 5.3 s
 * (503 KB, 600 per service, simplified to 0.008 degrees).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type CardSpec, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery, type ArcgisResult } from "./_shared/arcgis";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const BASE = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services";

const NETWORKS = ["all", "pipelines", "gas", "crude", "gas-liquids", "products", "transmission"] as const;
type Network = (typeof NETWORKS)[number];
type Source = "gas" | "crude" | "gas-liquids" | "products" | "transmission";

const SOURCES: Record<Source, { url: string; fields: string[]; order: string; kind: string }> = {
  gas: {
    url: `${BASE}/Natural_Gas_Interstate_and_Intrastate_Pipelines_1/FeatureServer/0`,
    fields: ["TYPEPIPE", "Operator", "Status"],
    order: "Shape__Length DESC",
    kind: "natural gas pipeline",
  },
  crude: {
    url: `${BASE}/Crude_Oil_Trunk_Pipelines_1/FeatureServer/0`,
    fields: ["Opername", "Pipename"],
    order: "Shape__Length DESC",
    kind: "crude oil pipeline",
  },
  "gas-liquids": {
    url: `${BASE}/Hydrocarbon_Gas_Liquids_Pipelines_1/FeatureServer/0`,
    fields: ["Opername", "Pipename"],
    order: "Shape__Length DESC",
    kind: "gas liquids pipeline",
  },
  products: {
    url: `${BASE}/Petroleum_Products_Pipelines_1/FeatureServer/0`,
    fields: ["Opername", "Pipename"],
    order: "Shape__Length DESC",
    kind: "petroleum products pipeline",
  },
  transmission: {
    url: `${BASE}/US_Electric_Power_Transmission_Lines/FeatureServer/0`,
    fields: ["ID", "TYPE", "STATUS", "OWNER", "VOLTAGE", "VOLT_CLASS"],
    order: "VOLTAGE DESC",
    kind: "transmission line",
  },
};

const DEFAULT_MIN_KV = 100;
/** Most features requested from one service. */
const MAX_PER_SERVICE = 1500;
/** Most features in a whole result: the per-service cap shrinks when several services are asked, so `all` stays near this. */
const MAX_TOTAL = 3000;

/** Features requested per service: MAX_PER_SERVICE alone, fewer when several services share MAX_TOTAL. */
export function perServiceCap(services: number): number {
  return Math.min(MAX_PER_SERVICE, Math.floor(MAX_TOTAL / Math.max(1, services)));
}
/** The mirror is frozen; a week is plenty. */
const TTL_SECONDS = 7 * 86_400;
/** Display simplification in degrees (about 300 m). */
const SIMPLIFY_DEG = 0.003;
/** Most lines in a wide result (all kinds together), the longest (power lines: highest voltage) first. */
const WIDE_LIMIT = 3000;

/** Simplification for a wide box: about a thousandth of its longer side, never finer than SIMPLIFY_DEG, so the payload stays small. */
export function wideOffset(bbox: BBox): number {
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  return Math.max(SIMPLIFY_DEG, Math.round((span / 1000) * 1e4) / 1e4);
}

const inputSchema = z.object({
  network: z.enum(NETWORKS).default("all"),
  minKv: z.number().min(0).max(1000).default(DEFAULT_MIN_KV),
});

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && !/^(not available|unknown|none)$/i.test(value.trim()) ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The services a network choice stands for. */
export function sourcesFor(network: Network): Source[] {
  switch (network) {
    case "all":
      return ["gas", "crude", "gas-liquids", "products", "transmission"];
    case "pipelines":
      return ["gas", "crude", "gas-liquids", "products"];
    default:
      return [network];
  }
}

/** Where clause for one service: transmission lines get the voltage floor and lose inactive lines. */
export function whereFor(source: Source, minKv: number): string | undefined {
  if (source !== "transmission") return undefined;
  const parts = ["STATUS<>'INACTIVE'"];
  if (minKv > 0) parts.push(`VOLTAGE>=${Math.round(minKv)}`);
  return parts.join(" AND ");
}

/** Converts one service's rows to lines with kind, name, operator and, for power lines, voltage as `v`. */
export function normalizeLines(fc: FeatureCollection, source: Source): Feature<Geometry>[] {
  const spec = SOURCES[source];
  const features: Feature<Geometry>[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const properties: Record<string, string | number> = { kind: spec.kind };

    if (source === "transmission") {
      const kv = num(p.VOLTAGE);
      const owner = str(p.OWNER);
      const status = str(p.STATUS);
      const voltageClass = str(p.VOLT_CLASS);
      properties.name = owner !== undefined ? `${owner} transmission line` : "Transmission line";
      if (owner !== undefined) properties.owner = owner;
      if (status !== undefined) properties.status = status.toLowerCase();
      if (kv !== undefined && kv > 0) {
        properties.voltageKv = kv;
        properties.v = kv;
      }
      if (voltageClass !== undefined) properties.voltageClass = `${voltageClass} kV`;
      const type = str(p.TYPE);
      if (type !== undefined) properties.lineType = type.toLowerCase();
    } else if (source === "gas") {
      const operator = str(p.Operator);
      properties.name = operator ?? "Natural gas pipeline";
      if (operator !== undefined) properties.operator = operator;
      const type = str(p.TYPEPIPE);
      if (type !== undefined) properties.pipelineType = type.toLowerCase();
      const status = str(p.Status);
      if (status !== undefined) properties.status = status.toLowerCase();
    } else {
      const pipe = str(p.Pipename);
      const operator = str(p.Opername);
      properties.name = pipe ?? operator ?? spec.kind;
      if (operator !== undefined) properties.operator = operator;
    }
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return features;
}

/** What the voltage and types on a line card mean (spec §12b). */
const HELP: Record<string, FieldHelp> = {
  v: { text: "The power line's operating voltage, as the federal transmission-line data gives it.", unit: "kilovolts (kV)", source: "HIFLD electric power transmission lines" },
  voltageClass: { text: "The voltage band the data files the line under: under 100, 100 to 161, 220 to 287, 345, 500, 735 kV and above, or direct current." },
  pipelineType: { text: "Interstate pipelines cross state lines; intrastate pipelines stay inside one state." },
};

/** The line card: voltage for power lines, then what the line is and who runs it. */
const CARD: CardSpec = {
  measure: { key: "v", label: "Voltage", unit: "kV" },
  facts: [
    {
      key: "kind",
      label: "Line",
      values: {
        "natural gas pipeline": "Natural gas pipeline",
        "crude oil pipeline": "Crude oil pipeline",
        "gas liquids pipeline": "Gas liquids pipeline (propane, ethane)",
        "petroleum products pipeline": "Petroleum products pipeline",
        "transmission line": "Power transmission line",
      },
    },
    { key: "operator", label: "Operator" },
    { key: "owner", label: "Owner" },
    { key: "pipelineType", label: "Pipeline type", values: { interstate: "Interstate", intrastate: "Intrastate" } },
    {
      key: "status",
      label: "Status",
      values: { operating: "Operating", "in service": "In service", "under construction": "Under construction", "not available": "Not given" },
    },
    {
      key: "voltageClass",
      label: "Voltage class",
      values: { "UNDER 100 kV": "Under 100 kV", "735 AND ABOVE kV": "735 kV and above", "DC kV": "Direct current", "NOT AVAILABLE kV": "Not given" },
    },
    {
      key: "lineType",
      label: "Line type",
      values: { "ac; overhead": "AC, overhead", "ac; underground": "AC, underground", "dc; overhead": "DC, overhead", "dc; underground": "DC, underground" },
    },
  ],
};

const pipelinesLines = defineLayer({
  id: "pipelines-lines",
  title: "Pipelines and power lines",
  description:
    "Where the big energy networks run across the United States, drawn as lines: natural gas pipelines, crude oil pipelines, gas liquids (propane, ethane) pipelines, refined petroleum product pipelines, and high-voltage electric transmission lines. " +
    "Each line has kind (natural gas pipeline, crude oil pipeline, gas liquids pipeline, petroleum products pipeline or transmission line, for filtering), name, operator or owner, and for power lines v and voltageKv (kilovolts), voltageClass and status. Gas pipelines also have pipelineType (interstate or intrastate). Pipelines have no size or flow in this data. " +
    "Set network to pick one kind: gas, crude, gas-liquids, products, transmission, pipelines (the four pipeline kinds) or all (the default). minKv (default 100) hides power lines below that voltage so the main grid stands out; use 0 for every line, 345 for the backbone. " +
    "Use it for 'where does the pipeline run', 'what power lines cross this valley', 'how close is the transmission line to the proposed solar farm' or 'is there a gas pipeline near here'. " +
    "Caveats: the source is a frozen copy of federal data from 2025 and misses newer lines; positions are approximate (good to about a street block at best), not survey-grade, and must not be used to dig or build; gas and power lines are cut into short segments, so counting features does not count pipelines. " +
    "Each kind is capped at 1,500 lines per view (longest gas segments and highest voltage first), and a view of several kinds at about 3,000 in all (600 per kind for all, 750 for pipelines), and the result says when it trims; pick one network to see more of it. " +
    "United States only; elsewhere it returns nothing. Over 150,000 km² (a 390 km square) it keeps the 3,000 longest (power lines: highest kV) and the total.",
  coverage: "us",
  surface: "any",
  license: "Public domain (EIA / DHS HIFLD, Esri Federal User Community mirror)",
  requiredEnv: [],
  maxAreaKm2: 150_000,
  wide: { orderBy: "length, power lines by voltage", limit: WIDE_LIMIT },
  input: inputSchema,
  style: { geometry: "line", color: layerColor("pipelines-lines") },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const citation = {
      source: "US Energy Information Administration and DHS HIFLD pipelines and electric transmission lines, via the Esri Federal User Community mirror (frozen copy, 2025)",
      url: "https://www.eia.gov/maps/",
      retrieved: new Date().toISOString(),
    };

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    const sources = sourcesFor(input.network);
    // Wide (over 150,000 km²): the strategy's limit shared across the services, coarser lines, and a count per service.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;
    const cap = Math.min(perServiceCap(sources.length), Math.floor((wideLimit ?? Infinity) / sources.length));
    const results: { source: Source; res: ArcgisResult }[] = await Promise.all(
      sources.map(async (source) => ({
        source,
        res: await arcgisQuery(ctx, SOURCES[source].url, {
          where: whereFor(source, input.minKv),
          outFields: SOURCES[source].fields,
          bbox: ctx.bbox,
          resultRecordCount: cap,
          maxAllowableOffset: ctx.wide ? wideOffset(ctx.bbox) : SIMPLIFY_DEG,
          orderByFields: SOURCES[source].order,
          withCount: ctx.wide === true,
          ttlSeconds: TTL_SECONDS,
          cacheSuffix: `pl-${source}`,
        }),
      })),
    );

    const ok = results.filter((r): r is { source: Source; res: Extract<ArcgisResult, { ok: true }> } => r.res.ok);
    if (ok.length === 0) {
      const first = results[0].res;
      return { error: first.ok ? "ArcGIS service returned no data" : first.error, hint: "upstream" };
    }

    const features = ok.flatMap((r) => normalizeLines(r.res.fc, r.source));
    const notes: string[] = [];
    const trimmed = ok.filter((r) => r.res.truncated).map((r) => SOURCES[r.source].kind);
    if (trimmed.length > 0 && !ctx.wide) notes.push(`Showing the first ${cap.toLocaleString("en-US")} ${trimmed.join(", ")} in view; zoom in or pick one network for the rest`);
    const failed = results.filter((r) => !r.res.ok).map((r) => SOURCES[r.source].kind);
    if (failed.length > 0) notes.push(`${failed.join(", ")} could not be loaded`);

    // The total is the sum of every service's count, so it only stands when each service answered one.
    const counts = results.map((r) => (r.res.ok ? r.res.total : undefined));
    const total = ctx.wide && counts.every((c) => c !== undefined) ? counts.reduce((a: number, c) => a + (c ?? 0), 0) : undefined;

    return {
      kind: "geojson",
      data: { type: "FeatureCollection", features },
      citation,
      ...(total !== undefined && { total }),
      ...(notes.length > 0 ? { coverageNote: notes.join("; ") } : {}),
    };
  },
});

registerLayer(pipelinesLines);

export default pipelinesLines;

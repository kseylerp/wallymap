/**
 * Electric power: US power plants (EIA), individual wind turbines (USGS) and utility-scale solar projects (USGS), one
 * `source` input choosing which. Three keyless services (verified live 2026-10-10):
 *   plants   Esri Federal User Community mirror of the EIA power plant data (data period Feb 2025, "EIA-860, EIA-860M and EIA-923")
 *            https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/Power_Plants_in_the_US/FeatureServer/0
 *            13,446 points, maxRecordCount 2000. Fields used: Plant_Name, Utility_Na, State, County, PrimSource (batteries, biomass,
 *            coal, geothermal, hydroelectric, natural gas, nuclear, other, petroleum, pumped storage, solar, wind), tech_desc,
 *            Total_MW (summer capacity of the primary fuel group), Install_MW (nameplate), Period (YYYYMM). It has no year online.
 *   wind     USGS US Wind Turbine Database, PostgREST API, one row per turbine
 *            https://energy.usgs.gov/api/uswtdb/v1/turbines?xlong=gte.W&xlong=lte.E&ylat=gte.S&ylat=lte.N&select=...&order=t_cap.desc.nullslast&limit=N
 *            Fields used: case_id, p_name (project), p_year (year the project came online), p_tnum (turbines in the project),
 *            p_cap (project MW), t_cap (turbine kW, null for about half of the older ones), t_manu, t_model, t_hh (hub height m),
 *            t_rd (rotor diameter m), t_state, t_offshore, xlong, ylat.
 *   solar    USGS/LBNL US Large-Scale Solar Photovoltaic Database, same API style, one row per project
 *            https://energy.usgs.gov/api/uspvdb/v1/projects?...   Fields used: case_id, p_name, p_year, p_cap_ac (MW), p_cap_dc,
 *            p_state, p_county, p_tech_pri, p_type, p_battery, xlong, ylat.
 * The wind and solar APIs return a plain JSON array, no count header; the layer asks for one row more than it shows and
 * says it trimmed when that extra row arrives. The two do not duplicate the plants: wind and solar plants appear in all three,
 * so `source` picks one to avoid double counting; the USGS two carry the year online that the EIA mirror lacks.
 * Output properties: name, kind (fuel; "wind"; "solar"), v (MW), plus plant: utility, state, county, technology, nameplateMw,
 * dataPeriod; wind: project, turbines, projectMw, manufacturer, model, hubHeightM, rotorDiameterM, year; solar: state, county,
 * mwDc, technology, siteType, battery, year. t = January 1 of the year online (wind and solar only).
 * Smoke through runLayer (2026-10-10): plants, Bay Area -122.5,37.5,-121.5,38.3 returned 100 plants in 0.3 s (34 KB, Delta Energy Center
 * 842 MW first); wind-turbines, Tehachapi -118.5,35,-118.1,35.3 returned 2,906 turbines in 3.0 s (913 KB); solar-projects, Mojave
 * -118.5,34.5,-117.5,35.3 returned 134 projects in 0.5 s (39 KB, Eland Solar 350 MW first); fuel coal in -98,31,-94,34 returned 6 (Martin Lake 2,410 MW).
 */
import { z } from "zod";
import type { Feature, FeatureCollection, Point } from "geojson";
import { defineLayer, type BBox, type LayerError, type LayerResult, type QueryContext, type CardSpec, type Facet, type FieldHelp } from "./types";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { UPSTREAM_TIMEOUT_MS } from "./_shared/constants";
import { OUTSIDE_US_NOTE, WHOLE_US_KM2, outsideUs } from "./_shared/coverage";
import { layerColor } from "@/lib/render/palette";

const PLANTS_URL = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/Power_Plants_in_the_US/FeatureServer/0";
const WIND_URL = "https://energy.usgs.gov/api/uswtdb/v1/turbines";
const SOLAR_URL = "https://energy.usgs.gov/api/uspvdb/v1/projects";

const FUELS = [
  "batteries",
  "biomass",
  "coal",
  "geothermal",
  "hydroelectric",
  "natural gas",
  "nuclear",
  "other",
  "petroleum",
  "pumped storage",
  "solar",
  "wind",
] as const;

const SOURCES = ["plants", "wind-turbines", "solar-projects"] as const;

const PLANT_FIELDS = ["Plant_Name", "Utility_Na", "State", "County", "PrimSource", "tech_desc", "Total_MW", "Install_MW", "Period"];
const WIND_FIELDS = [
  "case_id", "p_name", "p_year", "p_tnum", "p_cap", "t_state", "t_manu", "t_model", "t_cap", "t_hh", "t_rd", "t_offshore", "xlong", "ylat",
];
const SOLAR_FIELDS = [
  "case_id", "p_name", "p_year", "p_cap_ac", "p_cap_dc", "p_state", "p_county", "p_tech_pri", "p_type", "p_battery", "xlong", "ylat",
];

const MAX_PLANTS = 2000;
const MAX_TURBINES = 3000;
const MAX_PROJECTS = 2000;
/** The mirror is frozen and the USGS databases update a few times a year. */
const TTL_SECONDS = 7 * 86_400;

const inputSchema = z.object({
  source: z.enum(SOURCES).default("plants"),
  fuel: z.enum(FUELS).optional(),
});

type PowerInput = z.infer<typeof inputSchema>;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Adds `year` and `t` (January 1 of that year) for a plausible year; leaves both out otherwise. */
function addYear(properties: Record<string, string | number>, year: unknown): void {
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1880 || year > 2100) return;
  properties.year = year;
  properties.t = new Date(Date.UTC(year, 0, 1)).toISOString();
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Where clause for the plants service: the optional fuel (an enum value, so safe to inline). */
export function plantsWhere(fuel: PowerInput["fuel"]): string | undefined {
  return fuel === undefined ? undefined : `PrimSource='${fuel}'`;
}

/** PostgREST request URL for the USGS wind or solar API: a bbox, a column list, biggest first, one row over the cap. */
export function usgsUrl(base: string, fields: string[], order: string, bbox: BBox, cap: number): string {
  const [west, south, east, north] = bbox;
  const search = new URLSearchParams();
  search.append("xlong", `gte.${west}`);
  search.append("xlong", `lte.${east}`);
  search.append("ylat", `gte.${south}`);
  search.append("ylat", `lte.${north}`);
  search.set("select", fields.join(","));
  search.set("order", order);
  search.set("limit", String(cap + 1));
  return `${base}?${search.toString()}`;
}

/** PostgREST aggregate count of the USGS wind or solar rows in a bbox (`select=count()`), for a wide result's total. */
export function usgsCountUrl(base: string, bbox: BBox): string {
  const [west, south, east, north] = bbox;
  const search = new URLSearchParams();
  search.append("xlong", `gte.${west}`);
  search.append("xlong", `lte.${east}`);
  search.append("ylat", `gte.${south}`);
  search.append("ylat", `lte.${north}`);
  search.set("select", "count()");
  return `${base}?${search.toString()}`;
}

/** The count from a `select=count()` answer (`[{"count":15980}]`), or undefined on any failure. */
async function usgsCount(ctx: QueryContext, url: string, cacheKey: string | undefined): Promise<number | undefined> {
  try {
    const res = await ctx.fetch(url, { cacheKey, ttlSeconds: TTL_SECONDS, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const count = Array.isArray(body) ? (body[0] as { count?: unknown } | undefined)?.count : undefined;
    return typeof count === "number" && Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/** EIA plants as points with MW as v and the fuel as kind. */
export function normalizePlants(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    const fuel = str(p.PrimSource) ?? "other";
    const properties: Record<string, string | number> = { name: str(p.Plant_Name) ?? "Unnamed plant", kind: fuel };
    const mw = num(p.Total_MW);
    if (mw !== undefined) {
      properties.mw = round1(mw);
      properties.v = round1(mw);
    }
    const nameplate = num(p.Install_MW);
    if (nameplate !== undefined) properties.nameplateMw = round1(nameplate);
    const utility = str(p.Utility_Na);
    if (utility !== undefined) properties.utility = utility;
    const tech = str(p.tech_desc);
    if (tech !== undefined) properties.technology = tech;
    const county = str(p.County);
    if (county !== undefined) properties.county = county;
    const state = str(p.State);
    if (state !== undefined) properties.state = state;
    const period = str(p.Period);
    if (period !== undefined && /^\d{6}$/.test(period)) properties.dataPeriod = `${period.slice(0, 4)}-${period.slice(4)}`;
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

function pointFrom(row: Record<string, unknown>): Point | null {
  const lon = num(row.xlong);
  const lat = num(row.ylat);
  if (lon === undefined || lat === undefined) return null;
  return { type: "Point", coordinates: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] };
}

/** USGS turbines as points: v is the turbine's MW (its own rating, else the project's average per turbine). */
export function normalizeTurbines(rows: unknown[]): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const geometry = pointFrom(r);
    if (geometry === null) continue;
    const project = str(r.p_name);
    const properties: Record<string, string | number> = { name: project ?? "Wind turbine", kind: "wind" };
    if (project !== undefined) properties.project = project;
    const kw = num(r.t_cap);
    const projectMw = num(r.p_cap);
    const turbines = num(r.p_tnum);
    const mw = kw !== undefined && kw > 0 ? kw / 1000 : projectMw !== undefined && turbines !== undefined && turbines > 0 ? projectMw / turbines : undefined;
    if (mw !== undefined) {
      properties.mw = Math.round(mw * 100) / 100;
      properties.v = properties.mw;
    }
    if (turbines !== undefined) properties.turbines = turbines;
    if (projectMw !== undefined) properties.projectMw = round1(projectMw);
    const manufacturer = str(r.t_manu);
    if (manufacturer !== undefined) properties.manufacturer = manufacturer;
    const model = str(r.t_model);
    if (model !== undefined) properties.model = model;
    const hub = num(r.t_hh);
    if (hub !== undefined && hub > 0) properties.hubHeightM = Math.round(hub);
    const rotor = num(r.t_rd);
    if (rotor !== undefined && rotor > 0) properties.rotorDiameterM = Math.round(rotor);
    const state = str(r.t_state);
    if (state !== undefined) properties.state = state;
    addYear(properties, r.p_year);
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

/** USGS solar projects as points with AC megawatts as v. */
export function normalizeSolar(rows: unknown[]): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const geometry = pointFrom(r);
    if (geometry === null) continue;
    const properties: Record<string, string | number> = { name: str(r.p_name) ?? "Solar project", kind: "solar" };
    const ac = num(r.p_cap_ac);
    if (ac !== undefined) {
      properties.mw = round1(ac);
      properties.v = round1(ac);
    }
    const dc = num(r.p_cap_dc);
    if (dc !== undefined) properties.mwDc = round1(dc);
    const tech = str(r.p_tech_pri);
    if (tech !== undefined) properties.technology = tech;
    const siteType = str(r.p_type);
    if (siteType !== undefined) properties.siteType = siteType;
    const battery = str(r.p_battery);
    if (battery !== undefined) properties.battery = battery;
    const county = str(r.p_county);
    if (county !== undefined) properties.county = county;
    const state = str(r.p_state);
    if (state !== undefined) properties.state = state;
    addYear(properties, r.p_year);
    features.push({ type: "Feature", geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
}

const FACETS: Facet[] = [
  {
    key: "kind",
    label: "Fuel",
    kind: "category",
    values: FUELS.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
  },
  { key: "mw", label: "Capacity", kind: "range", unit: "MW", encode: "size" },
];

const CAPACITY: FieldHelp = {
  text:
    "Generating capacity in megawatts: for EIA plants the summer capacity of the plant's primary fuel, for a wind turbine its own rating " +
    "(else the project's average per turbine), for a solar project its AC capacity.",
  unit: "MW",
  source: "US EIA (EIA-860, EIA-860M, EIA-923); USGS wind turbine and large-scale solar databases",
  url: "https://www.eia.gov/electricity/data/eia860/",
};

const HELP: Record<string, FieldHelp> = {
  mw: CAPACITY,
  v: CAPACITY,
  kind: { text: "The primary energy source: for EIA plants the fuel group the plant mostly uses; wind and solar for the USGS databases." },
  nameplateMw: { text: "Nameplate capacity: the maximum output the generators are rated for, usually above the summer capacity.", unit: "MW" },
  projectMw: { text: "Capacity of the whole wind project this turbine belongs to.", unit: "MW" },
  mwDc: { text: "The solar project's DC capacity (panel rating), higher than its AC output to the grid.", unit: "MW" },
  dataPeriod: { text: "The month of the EIA data the plant record comes from." },
  hubHeightM: { text: "Height of the turbine hub above the ground.", unit: "m" },
  rotorDiameterM: { text: "Diameter of the circle the blades sweep.", unit: "m" },
  year: { text: "The year the wind or solar project came online." },
};

const CARD: CardSpec = {
  measure: { key: "mw", label: "Capacity", unit: "MW" },
  facts: [
    { key: "kind", label: "Fuel" },
    { key: "technology", label: "Technology" },
    { key: "utility", label: "Utility" },
    { key: "project", label: "Project" },
    { key: "turbines", label: "Turbines in project", format: "int" },
    { key: "year", label: "Online since" },
    { key: "state", label: "State" },
  ],
};

const powerPlants = defineLayer({
  id: "power-plants",
  title: "Power plants, wind and solar",
  description:
    "Where electricity is made in the United States, as points sized by megawatts: v is the capacity in MW (megawatts), kind is the fuel for filtering, and with 3D on each point rises as a column with its MW. " +
    "Set source to choose the data: plants (default) is every EIA power plant of any fuel (coal, natural gas, nuclear, hydroelectric, wind, solar, geothermal, biomass, petroleum, batteries, pumped storage), with name, utility, state, county, technology, mw (summer capacity), nameplateMw and dataPeriod; wind-turbines is the USGS database of individual wind turbines, each with project, turbines (in the project), projectMw, manufacturer, model, hubHeightM, rotorDiameterM and the year it came online; solar-projects is the USGS database of large solar farms (AC megawatts as v, mwDc, technology, siteType, battery, year). " +
    "Set fuel (for example coal, nuclear, hydroelectric, natural gas) to show one fuel; it applies to plants only. " +
    "Wind turbines and solar projects carry t (January 1 of the year they came online) and year, so the time scrubber plays the build-out; the plants source has no dates. " +
    "Use it for 'where are the power plants', 'what coal plants are near here', 'show wind farms by the year they were built', 'how big is that solar farm' or 'which dams make electricity'. " +
    "Caveats: the plants list comes from a copy of EIA data with a data period of February 2025 (see dataPeriod), so it lags EIA and misses newer plants, retirements and renamed ones. The plants source also lists wind and solar plants, so do not add its wind and solar counts to the USGS ones. " +
    "Capacity is what a plant can produce, not what it did produce. About half the older wind turbines have no rating; their v is the project average per turbine. " +
    "Plants are capped at 2,000 per view (largest first), turbines at 3,000 and solar projects at 2,000, and the result says when it trims. Points cluster at low zoom. " +
    "United States only; elsewhere it returns nothing. Any box up to the whole US answers: over 250,000 km² (about a 500 km square) it returns the 2,000 largest by MW (turbines and solar projects likewise) and its note says how many there are in all, so pass the whole region asked about (West Texas, the Great Plains) rather than a slice of it.",
  coverage: "us",
  license: "Public domain (US EIA via Esri Federal User Community; USGS US Wind Turbine and Large-Scale Solar PV databases)",
  requiredEnv: [],
  maxAreaKm2: 250_000,
  // Ranking the whole country costs one count and one ordered page, so the hard cap is the US itself.
  hardMaxAreaKm2: WHOLE_US_KM2,
  wide: { orderBy: "capacity in MW", limit: MAX_PLANTS },
  input: inputSchema,
  style: { geometry: "point", color: layerColor("power-plants"), unit: "MW", extrude: "v", cluster: true, facets: FACETS },
  fieldHelp: HELP,
  card: CARD,

  async query(ctx, input): Promise<LayerResult | LayerError> {
    const retrieved = new Date().toISOString();
    const citations = {
      plants: {
        source: "US Energy Information Administration power plants (EIA-860, EIA-860M, EIA-923; data period Feb 2025), via the Esri Federal User Community mirror",
        url: "https://www.eia.gov/electricity/data/browser/",
        retrieved,
      },
      "wind-turbines": {
        source: "USGS, American Clean Power Association and LBNL, US Wind Turbine Database (public domain)",
        url: "https://eerscmap.usgs.gov/uswtdb/",
        retrieved,
      },
      "solar-projects": {
        source: "USGS and Lawrence Berkeley National Laboratory, US Large-Scale Solar Photovoltaic Database (public domain)",
        url: "https://eerscmap.usgs.gov/uspvdb/",
        retrieved,
      },
    };
    const citation = citations[input.source];

    if (outsideUs(ctx.bbox)) {
      return { kind: "geojson", data: EMPTY, citation, coverageNote: OUTSIDE_US_NOTE };
    }

    // Wide (over 250,000 km²): the same largest-first fetch, capped at the strategy's limit, plus a count for the note.
    const wideLimit = ctx.wide ? ctx.wideStrategy?.limit : undefined;

    if (input.source === "plants") {
      const res = await arcgisQuery(ctx, PLANTS_URL, {
        where: plantsWhere(input.fuel),
        outFields: PLANT_FIELDS,
        bbox: ctx.bbox,
        resultRecordCount: Math.min(MAX_PLANTS, wideLimit ?? MAX_PLANTS),
        orderByFields: "Total_MW DESC",
        withCount: ctx.wide === true,
        ttlSeconds: TTL_SECONDS,
        cacheSuffix: "plants",
      });
      if (!res.ok) return { error: res.error, hint: "upstream" };
      return {
        kind: "geojson",
        data: normalizePlants(res.fc),
        citation,
        ...(res.total !== undefined && { total: res.total }),
        ...(res.truncated && !ctx.wide
          ? { coverageNote: `Showing the ${MAX_PLANTS.toLocaleString("en-US")} largest plants in view; zoom in or pick a fuel for the rest` }
          : {}),
      };
    }

    const wind = input.source === "wind-turbines";
    const cap = Math.min(wind ? MAX_TURBINES : MAX_PROJECTS, wideLimit ?? Infinity);
    const url = wind
      ? usgsUrl(WIND_URL, WIND_FIELDS, "t_cap.desc.nullslast", ctx.bbox, cap)
      : usgsUrl(SOLAR_URL, SOLAR_FIELDS, "p_cap_ac.desc.nullslast", ctx.bbox, cap);
    const label = wind ? "USGS wind turbine database" : "USGS solar database";

    const counting = ctx.wide
      ? usgsCount(ctx, usgsCountUrl(wind ? WIND_URL : SOLAR_URL, ctx.bbox), ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${wind ? "wind" : "solar"}:count`)
      : Promise.resolve(undefined);

    let rows: unknown;
    try {
      const res = await ctx.fetch(url, {
        cacheKey: ctx.cacheKey === undefined ? undefined : `${ctx.cacheKey}:${wind ? "wind" : "solar"}`,
        ttlSeconds: TTL_SECONDS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { error: `${label} returned ${res.status}`, hint: "upstream" };
      rows = await res.json();
    } catch (err) {
      return {
        error: isTimeout(err) ? `${label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds` : `${label} returned no response`,
        hint: "upstream",
      };
    }
    if (!Array.isArray(rows)) return { error: `${label} did not return a list`, hint: "upstream" };

    const trimmed = rows.length > cap;
    const data = wind ? normalizeTurbines(rows.slice(0, cap)) : normalizeSolar(rows.slice(0, cap));
    const total = await counting;
    return {
      kind: "geojson",
      data,
      citation,
      ...(total !== undefined && { total }),
      ...(trimmed && !ctx.wide
        ? {
            coverageNote: `Showing the ${cap.toLocaleString("en-US")} largest ${wind ? "turbines" : "solar projects"} in view; zoom in for the rest`,
          }
        : {}),
    };
  },
});

registerLayer(powerPlants);

export default powerPlants;

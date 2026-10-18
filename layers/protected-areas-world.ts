/**
 * Protected areas of the world: UNEP-WCMC / IUCN World Database on Protected Areas (WDPA, Protected Planet).
 * Service (verified live 2026-10-09, keyless ArcGIS MapServer, "protected areas only" view, WDPA v3.7):
 *   https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer
 *   layer 0 WDPA_point_latest, layer 1 WDPA_poly_latest. `export` draws PNG32 with transparency (a Sierra Nevada
 *   tile came back 40 KB: green terrestrial areas, blue marine ones, with outlines).
 * The layer returns a raster tile template and makes no upstream call; Mapbox fills {bbox-epsg-3857} per tile.
 * Notes: tiles are slow at low zoom (a z2 world quarter took 4.5 s), so minzoom is 3. License: Protected Planet allows
 * free non-commercial use only; commercial use needs a licence from UNEP-WCMC. The Protected Planet citation
 * wording is the service's own copyrightText.
 * Smoke through runLayer (2026-10-09): world bbox returns the tile template (200). Live tiles through the produced template:
 * Sierra Nevada z6 35 KB in 0.8 s, z3 23 KB in 3.0 s.
 * Features mode (regions under FEATURES_MAX_AREA_KM2): `query` on layer 1 (WDPA_poly_latest, maxRecordCount 2000, lowercase
 * fields), largest first by gis_area (km²), simplified with maxAllowableOffset. Verified live 2026-10-11: French Guiana
 * (-54.6,2.1,-51.6,5.8) 47 polygons, 75 KB, 0.5 s (largest Parque Nacional Montanhas Do Tumucumaque, 38,295 km²); a
 * 270,000 km² Alps box holds 16,852, the 300 largest came back in 2.8 s (700 KB). Some names carry a literal backslash
 * before an apostrophe ("D\'Adhésion"); it is removed. Fixture: layers/__fixtures__/protected-areas-world.guiana.json.
 * Source switch (2026-10-18): data-gis.unep-wcmc.org answered every query and export with an error ("Could not access any server
 * machines", HTTP 500 on export), so the map drew nothing. UNEP-WCMC's own hosted copy on ArcGIS Online is now the primary:
 *   https://services5.arcgis.com/Mj0hjvkNtV7NRhA7/arcgis/rest/services/WDPA_v0/FeatureServer/1  "WDPA_poly_Latest"
 *   (same lowercase fields plus desig_type; data last edited 2026-10-05; maxRecordCount 2000; supports orderBy and geojson).
 * The old MapServer stays as the fallback for the same query; when both fail the answer is an upstream error with its source
 * status, never a blank tile layer. International designations (UNESCO-MAB biosphere reserves, World Heritage and Ramsar
 * sites, desig_type 'International') are left out: they overlay the national parks and buried them (Costa Rica box
 * -86,8,-82.5,11.3: the five largest of 183 were international, an 18,312 km² Nicaraguan biosphere reserve first). Live
 * 2026-10-18 through runLayer: that box returned 159 national and regional areas in 1.0 s (234 KB). Over 500,000 km² the same query keeps
 * the 300 largest, drawn coarser, instead of the tile picture (the old export is down too).
 */
import { z } from "zod";
import type { Feature, FeatureCollection } from "geojson";
import {
  bboxAreaKm2,
  defineLayer,
  type BBox,
  type CardSpec,
  type Attribute,
  type FieldHelp,
  type LayerError,
  type LayerResult,
  type LegendSpec,
  type QueryContext,
} from "./types";
import { nameAttribute } from "./_shared/bands";
import { registerLayer } from "./registry";
import { arcgisQuery } from "./_shared/arcgis";
import { DARK_GREY, layerColor, PURPLE, SAGE, SURFACE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

/** UNEP-WCMC's hosted WDPA polygons on ArcGIS Online: the primary source. */
export const WDPA_POLYGONS = "https://services5.arcgis.com/Mj0hjvkNtV7NRhA7/arcgis/rest/services/WDPA_v0/FeatureServer/1";
/** The older UNEP-WCMC MapServer's polygon sublayer: asked only when the hosted copy fails. */
export const WDPA_POLYGONS_FALLBACK = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/1";
/** National and regional designations only: international overlays (biosphere reserves, World Heritage, Ramsar) bury the parks. */
export const WDPA_WHERE = "desig_type <> 'International'";
/** Over this size the 300 largest are drawn coarser (simplifyOffset with `wide`). */
export const FEATURES_MAX_AREA_KM2 = 500_000;
/** Most polygons returned, largest first. */
export const MAX_AREAS = 300;
export const WDPA_FIELDS = ["site_id", "name", "name_eng", "desig_eng", "iucn_cat", "rep_area", "gis_area", "realm", "status_yr", "iso3"];

const LICENCE_NOTE = "free for non-commercial use only (UNEP-WCMC and IUCN); gaps may mean unreported areas, not unprotected land";

function citation() {
  return {
    source: "UNEP-WCMC and IUCN, Protected Planet: The World Database on Protected Areas (WDPA), non-commercial use only",
    url: "https://www.protectedplanet.net/",
    retrieved: new Date().toISOString(),
  };
}

/** Display simplification in degrees: about 1/1,500 of the region's width, between ~50 m and ~2 km (~10 km over a wide box). */
export function simplifyOffset(bbox: BBox, wide = false): number {
  return Math.min(wide ? 0.1 : 0.02, Math.max(0.0005, (bbox[2] - bbox[0]) / 1_500));
}

/** IUCN categories grouped by how strictly the land is protected: the map's color category (`protection`). */
export type Protection = "strict" | "park" | "habitat" | "sustainable" | "none";

const PROTECTION_OF: Record<string, Protection> = { Ia: "strict", Ib: "strict", II: "park", III: "habitat", IV: "habitat", V: "sustainable", VI: "sustainable" };

/**
 * The groups in order, strictest first, with their fills: purple, sage, a darker sage, dark grey, and a pale surface for none.
 * Labels are short enough for a chip; the IUCN categories each group holds are in its help.
 */
export const PROTECTION_LEVELS: { value: Protection; label: string; help: string; color: string }[] = [
  { value: "strict", label: "Strict reserve or wilderness", help: "IUCN Ia and Ib: managed mainly for science or wilderness; visits limited.", color: PURPLE },
  { value: "park", label: "National park", help: "IUCN II: large natural areas protecting ecosystems, open for visits and recreation.", color: SAGE },
  { value: "habitat", label: "Monument or habitat area", help: "IUCN III and IV: a landmark feature, or an area managed for particular species or habitats.", color: rgbToHex(interpolateStops([SAGE, DARK_GREY], 0.5)) },
  { value: "sustainable", label: "Lived-in or sustainable use", help: "IUCN V and VI: lived-in landscapes and seascapes, and areas where natural resources are used sustainably.", color: DARK_GREY },
  { value: "none", label: "No IUCN category", help: "The country reported no IUCN category, or it does not apply to this designation.", color: SURFACE },
];

export const PROTECTION_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Protection",
  field: "protection",
  items: PROTECTION_LEVELS.map((l) => ({ label: l.label, value: l.value, color: l.color, symbol: "polygon" as const, help: l.help })),
  note: "International designations (biosphere reserves, World Heritage and Ramsar sites) are left out; they overlay the areas shown.",
};

/** IUCN categories that say something; "Not Reported", "Not Applicable" and "Not Assigned" are left out. */
const IUCN = /^(Ia|Ib|II|III|IV|V|VI)$/;

/** Some WDPA names carry a literal backslash before an apostrophe. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\\(['"])/g, "$1").trim();
  return name === "" ? undefined : name;
}

/** ISO 3166 three-letter codes to two-letter ones (the codes WDPA's iso3 holds; XKX is Kosovo's user-assigned code). */
const ISO3_TO_ISO2: Record<string, string> = Object.fromEntries(
  (
    "ABW AW AFG AF AGO AO AIA AI ALA AX ALB AL AND AD ARE AE ARG AR ARM AM ASM AS ATA AQ ATF TF ATG AG AUS AU AUT AT AZE AZ " +
    "BDI BI BEL BE BEN BJ BES BQ BFA BF BGD BD BGR BG BHR BH BHS BS BIH BA BLM BL BLR BY BLZ BZ BMU BM BOL BO BRA BR BRB BB " +
    "BRN BN BTN BT BVT BV BWA BW CAF CF CAN CA CCK CC CHE CH CHL CL CHN CN CIV CI CMR CM COD CD COG CG COK CK COL CO COM KM " +
    "CPV CV CRI CR CUB CU CUW CW CXR CX CYM KY CYP CY CZE CZ DEU DE DJI DJ DMA DM DNK DK DOM DO DZA DZ ECU EC EGY EG ERI ER " +
    "ESH EH ESP ES EST EE ETH ET FIN FI FJI FJ FLK FK FRA FR FRO FO FSM FM GAB GA GBR GB GEO GE GGY GG GHA GH GIB GI GIN GN " +
    "GLP GP GMB GM GNB GW GNQ GQ GRC GR GRD GD GRL GL GTM GT GUF GF GUM GU GUY GY HKG HK HMD HM HND HN HRV HR HTI HT HUN HU " +
    "IDN ID IMN IM IND IN IOT IO IRL IE IRN IR IRQ IQ ISL IS ISR IL ITA IT JAM JM JEY JE JOR JO JPN JP KAZ KZ KEN KE KGZ KG " +
    "KHM KH KIR KI KNA KN KOR KR KWT KW LAO LA LBN LB LBR LR LBY LY LCA LC LIE LI LKA LK LSO LS LTU LT LUX LU LVA LV MAC MO " +
    "MAF MF MAR MA MCO MC MDA MD MDG MG MDV MV MEX MX MHL MH MKD MK MLI ML MLT MT MMR MM MNE ME MNG MN MNP MP MOZ MZ MRT MR " +
    "MSR MS MTQ MQ MUS MU MWI MW MYS MY MYT YT NAM NA NCL NC NER NE NFK NF NGA NG NIC NI NIU NU NLD NL NOR NO NPL NP NRU NR " +
    "NZL NZ OMN OM PAK PK PAN PA PCN PN PER PE PHL PH PLW PW PNG PG POL PL PRI PR PRK KP PRT PT PRY PY PSE PS PYF PF QAT QA " +
    "REU RE ROU RO RUS RU RWA RW SAU SA SDN SD SEN SN SGP SG SGS GS SHN SH SJM SJ SLB SB SLE SL SLV SV SMR SM SOM SO SPM PM " +
    "SRB RS SSD SS STP ST SUR SR SVK SK SVN SI SWE SE SWZ SZ SXM SX SYC SC SYR SY TCA TC TCD TD TGO TG THA TH TJK TJ TKL TK " +
    "TKM TM TLS TL TON TO TTO TT TUN TN TUR TR TUV TV TWN TW TZA TZ UGA UG UKR UA UMI UM URY UY USA US UZB UZ VAT VA VCT VC " +
    "VEN VE VGB VG VIR VI VNM VN VUT VU WLF WF WSM WS XKX XK YEM YE ZAF ZA ZMB ZM ZWE ZW"
  )
    .match(/[A-Z]{3} [A-Z]{2}/g)!
    .map((pair) => pair.split(" ")),
);

/** Where the standard English short name reads oddly on a card ("Congo - Kinshasa"). */
const COUNTRY_NAMES: Record<string, string> = {
  CD: "Democratic Republic of the Congo",
  CG: "Republic of the Congo",
  HK: "Hong Kong",
  MO: "Macao",
  MM: "Myanmar",
  ABNJ: "Areas beyond national jurisdiction",
};

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * The country names behind WDPA's iso3 ("CRI" → "Costa Rica"); a site shared by several countries lists each
 * ("BRA;PER" → "Brazil · Peru"). A code with no name stays as written.
 */
export function countryName(iso3: string): string {
  return iso3
    .split(/\s*[;,]\s*/)
    .filter(Boolean)
    .map((code) => {
      const two = ISO3_TO_ISO2[code.toUpperCase()];
      const named = COUNTRY_NAMES[two ?? code.toUpperCase()] ?? (two ? REGION_NAMES.of(two) : undefined);
      return named && named !== two ? named : code;
    })
    .join(" · ");
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * WDPA polygons as features: name, designation (in English), iucn (category, when one is assigned), areaKm2 and v
 * (the mapped area in km², or the reported one when there is no mapped area), country (its name, from the ISO3 code), realm, statusYear and siteId. Largest first;
 * features with no geometry are skipped.
 */
export function normalizeProtectedAreas(fc: FeatureCollection): FeatureCollection {
  const features: Feature[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties ?? {};
    const name = cleanName(p.name) ?? cleanName(p.name_eng);
    if (name === undefined) continue;
    const properties: Record<string, string | number> = { name };
    const english = cleanName(p.name_eng);
    if (english !== undefined && english !== name) properties.nameEnglish = english;
    if (typeof p.desig_eng === "string" && p.desig_eng.trim() !== "") properties.designation = p.desig_eng.trim();
    if (typeof p.iucn_cat === "string" && IUCN.test(p.iucn_cat)) properties.iucn = p.iucn_cat;
    properties.protection = PROTECTION_OF[String(properties.iucn ?? "")] ?? "none";
    const area = positive(p.gis_area) ?? positive(p.rep_area);
    if (area !== undefined) {
      properties.areaKm2 = area >= 10 ? Math.round(area) : Math.round(area * 10) / 10;
      properties.v = properties.areaKm2;
    }
    if (typeof p.iso3 === "string" && p.iso3.trim() !== "") properties.country = countryName(p.iso3.trim());
    if (typeof p.realm === "string") properties.realm = p.realm;
    if (typeof p.status_yr === "number" && p.status_yr > 0) properties.statusYear = p.status_yr;
    if (typeof p.site_id === "number" || typeof p.site_id === "string") properties.siteId = String(p.site_id);
    features.push({ type: "Feature", geometry: f.geometry, properties });
  }
  features.sort((a, b) => Number(b.properties?.v ?? 0) - Number(a.properties?.v ?? 0));
  return { type: "FeatureCollection", features: mergeDesignations(features) };
}

function extent(f: Feature): BBox | null {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      box[0] = Math.min(box[0], c[0]);
      box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]);
      box[3] = Math.max(box[3], c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  if (f.geometry && "coordinates" in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(box[0]) ? box : null;
}

/**
 * A name as two designations of one place compare it: case, accents, spaces and punctuation ignored ("Irbes saurums" and
 * "Irbes šaurums", "Nida-Perkone" and "Nida - Pērkone", "Ile Du Grand-Connétable" and "Île du Grand Connétable").
 */
function nameKey(name: unknown): string {
  return String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * One place under two legal designations (Väinamere as an EU Birds Directive area and a Habitats Directive area, nearly
 * the same outline) draws once: the larger polygon stays and lists both designations. Same name, boxes overlapping by
 * 60% or more of their union. `features` is largest first.
 */
export function mergeDesignations(features: Feature[]): Feature[] {
  const kept: { f: Feature; box: BBox | null }[] = [];
  for (const f of features) {
    const box = extent(f);
    const same = kept.find((k) => {
      if (nameKey(k.f.properties?.name) !== nameKey(f.properties?.name) || !k.box || !box) return false;
      const w = Math.min(k.box[2], box[2]) - Math.max(k.box[0], box[0]);
      const h = Math.min(k.box[3], box[3]) - Math.max(k.box[1], box[1]);
      if (w <= 0 || h <= 0) return false;
      const area = (r: BBox) => (r[2] - r[0]) * (r[3] - r[1]);
      return (w * h) / (area(k.box) + area(box) - w * h) >= 0.6;
    });
    if (!same) {
      kept.push({ f, box });
      continue;
    }
    const a = same.f.properties ?? {};
    const b = f.properties?.designation;
    if (typeof b === "string" && !String(a.designation ?? "").split(" · ").includes(b)) {
      same.f = { ...same.f, properties: { ...a, designation: a.designation ? `${a.designation} · ${b}` : b } };
    }
  }
  return kept.map((k) => k.f);
}

/** One query of a WDPA polygon service: national and regional areas in the box, largest first, capped and simplified. */
function queryService(ctx: QueryContext, url: string, wide: boolean) {
  return arcgisQuery(ctx, url, {
    where: WDPA_WHERE,
    outFields: WDPA_FIELDS,
    bbox: ctx.bbox,
    maxRecords: MAX_AREAS,
    orderByFields: "gis_area DESC",
    maxAllowableOffset: simplifyOffset(ctx.bbox, wide),
    cacheSuffix: url === WDPA_POLYGONS ? "wdpa:hosted" : "wdpa:polygons",
  });
}

/**
 * Named polygons from UNEP-WCMC's hosted copy, else from its older MapServer; an upstream error with the source status
 * when neither answers (so the row says the source is down instead of drawing nothing).
 */
async function queryFeatures(ctx: QueryContext): Promise<LayerResult | LayerError> {
  const wide = bboxAreaKm2(ctx.bbox) > FEATURES_MAX_AREA_KM2;
  const hosted = await queryService(ctx, WDPA_POLYGONS, wide);
  const result = hosted.ok ? hosted : await queryService(ctx, WDPA_POLYGONS_FALLBACK, wide);
  if (!result.ok) {
    const message = `The World Database on Protected Areas did not answer (UNEP-WCMC hosted copy: ${hosted.ok ? "ok" : hosted.error}; UNEP-WCMC server: ${result.error}).`;
    return { error: message, hint: "upstream", sourceStatus: { ok: false, reason: "server-error", message } };
  }
  const data = normalizeProtectedAreas(result.fc);
  const n = data.features.length.toLocaleString("en-US");
  const head = result.truncated
    ? `The ${n} largest national and regional protected areas in this region (more, smaller ones exist; zoom in for them)`
    : `${n} national and regional protected areas in this region, largest first`;
  return {
    kind: "geojson",
    data,
    citation: citation(),
    coverageNote: `${head}; international designations (biosphere reserves, World Heritage and Ramsar sites) and reserves recorded only as points are not included; ${LICENCE_NOTE}`,
    // The fallback answered after the hosted copy failed: the source is fine as far as the person is concerned.
    ...(!hosted.ok && { sourceStatus: { ok: true as const } }),
  };
}

const IUCN_URL = "https://www.iucn.org/theme/protected-areas/about/protected-area-categories";

const IUCN_NAMES: Record<string, string> = {
  Ia: "Ia Strict Nature Reserve",
  Ib: "Ib Wilderness Area",
  II: "II National Park",
  III: "III Natural Monument or Feature",
  IV: "IV Habitat/Species Management Area",
  V: "V Protected Landscape/Seascape",
  VI: "VI Protected area with sustainable use of natural resources",
};

const ATTRIBUTES: Attribute[] = [
  {
    key: "protection",
    type: "category",
    label: "Protection",
    levels: PROTECTION_LEVELS.map(({ value, label, help }) => ({ value, label, help })),
    encode: "color",
    primary: true,
  },
  { key: "iucn", type: "category", label: "IUCN category", levels: Object.entries(IUCN_NAMES).map(([value, label]) => ({ value, label })) },
  {
    key: "areaKm2",
    type: "measure",
    label: "Area",
    unit: "km²",
    encode: "size",
    presets: [
      { label: "Under 10 km²", max: 10 },
      { label: "10 to 1,000 km²", min: 10, max: 1_000 },
      { label: "1,000 km² and up", min: 1_000 },
    ],
  },
  nameAttribute(),
];

const AREA: FieldHelp = {
  text: "The area of the mapped polygon in the World Database on Protected Areas, or the reported area when none is mapped.",
  unit: "km²",
};

const HELP: Record<string, FieldHelp> = {
  iucn: {
    text:
      "The IUCN management category, which says how an area is managed: Ia Strict Nature Reserve, Ib Wilderness Area, II National Park, III " +
      "Natural Monument or Feature, IV Habitat/Species Management Area, V Protected Landscape/Seascape, VI Protected area with sustainable use of " +
      "natural resources.",
    scale: "Ia, Ib, II, III, IV, V, VI (absent when not reported or not assigned)",
    source: "IUCN Protected Area Management Categories",
    url: IUCN_URL,
  },
  areaKm2: AREA,
  v: AREA,
  protection: { text: "How strictly the area is protected, from its IUCN category: " + PROTECTION_LEVELS.map((l) => `${l.label}: ${l.help}`).join(" "), url: IUCN_URL },
  designation: { text: "The legal designation in English as the country reports it (National Park, Nature Reserve and so on)." },
  statusYear: { text: "The year the area was designated or its current status was set." },
  realm: { text: "Whether the area is terrestrial, marine or coastal (both)." },
  country: { text: "The country that reported the area to the World Database on Protected Areas." },
};

const CARD: CardSpec = {
  measure: { key: "areaKm2", label: "Area", unit: "km²" },
  facts: [
    { key: "designation", label: "Designation" },
    { key: "protection", label: "Protection", values: Object.fromEntries(PROTECTION_LEVELS.map((l) => [l.value, l.label])) },
    { key: "iucn", label: "IUCN category", values: IUCN_NAMES },
    { key: "statusYear", label: "Designated" },
    { key: "realm", label: "Realm" },
    { key: "country", label: "Country" },
  ],
  hidden: ["v", "siteId"],
};

const protectedAreasWorld = defineLayer({
  id: "protected-areas-world",
  title: "Protected areas of the world",
  description:
    "Protected areas of the world (national parks, nature reserves, wilderness, marine protected areas and similar) from the World Database on Protected Areas run by UNEP-WCMC and IUCN, read from UNEP-WCMC's hosted copy. " +
    "It returns named polygons, largest first (up to 300): name, designation (National Park, Nature Reserve...), iucn category when assigned, protection (the IUCN category grouped as strict reserve or wilderness, national park, natural monument or habitat area, protected landscape or sustainable use, or none reported), and areaKm2 and v (area in km²), so you can name and compare the parks. " +
    "The map fills each area by its protection group with a legend; over 500,000 km² it keeps the 300 largest and draws them coarser. " +
    "International designations (UNESCO biosphere reserves, World Heritage and Ramsar sites) are left out because they overlay and hide the national parks; say so if asked about them. " +
    "Use it for 'is this place protected', 'where are the parks and reserves in this country' or 'how much of this coast is a marine reserve', anywhere in the world, and as the global counterpart of the US-only public-lands and wilderness layers. " +
    "Coverage depends on what each country reports, so a gap can mean the data is missing and not that the land is unprotected; many countries report no IUCN category, and many small reserves are recorded only as points and are left out. " +
    "Licence: free for non-commercial use only; commercial use needs permission from UNEP-WCMC, so say so when the user plans to use it commercially. " +
    "If the database does not answer, the layer returns an error saying so rather than an empty map. Works for regions up to about a continent (25 million km²); zoom in from a whole-world view.",
  coverage: "global",
  surface: "any",
  license: "Non-commercial use only (UNEP-WCMC and IUCN, Protected Planet terms); commercial use needs a licence",
  requiredEnv: [],
  // About a continent (Brazil's box, 18.5 million km², took 4 s on 2026-10-18); the whole world timed out after 25 s.
  maxAreaKm2: 25_000_000,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("protected-areas-world") },
  fieldHelp: HELP,
  card: CARD,
  attributes: ATTRIBUTES,
  legend: PROTECTION_LEGEND,
  labels: { field: "name", max: 10, rankBy: "areaKm2" },
  // Current designations; the status year is a fact on the card, not a time axis.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    return queryFeatures(ctx);
  },
});

registerLayer(protectedAreasWorld);

export default protectedAreasWorld;

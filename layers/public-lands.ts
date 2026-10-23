/**
 * Public land ownership from the USGS Protected Areas Database of the United States (PAD-US 4.1), served as
 * Mapbox vector tiles from a bucket the maintainer pays for (set PADUS_TILES_URL to serve your own copy):
 *   https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf
 * Facts from decoding live tiles on 2026-10-09 (z3 to z12 across CA, WY, CO, TX, FL, TN, DC, AK, HI):
 *   - One source layer, `padus`, polygons only (40,371 features sampled, every one a polygon).
 *   - Tiles exist at z3 to z12; z0 to z2 and z13+ answer 404. Mapbox overzooms z12 past that.
 *   - The bucket stores them gzipped and serves them gunzipped to clients that do not send
 *     Accept-Encoding: gzip (header `x-goog-stored-content-encoding: gzip`); browsers get gzip and inflate it.
 *   - Properties are simplified from PAD-US, not the raw `Mang_Type` / `Own_Type` / `Unit_Nm` / `Des_Tp` columns:
 *       name         unit name (raw Unit_Nm), e.g. "Plumas National Forest"
 *       agency       manager abbreviation (raw Mang_Name), missing on about 7% of features. Values seen:
 *                    federal USFS, BLM, FWS, NPS, USACE, USBR, DOE, TVA, ARS, DOD, NRCS; state "State",
 *                    "State Parks"; "Local"; "NGO" (private nonprofits); "Tribal"
 *       designation  readable designation (raw Des_Tp), e.g. "National Forest", "Wilderness Area", "Local Park",
 *                    "Private Conservation Land"; private parcels usually have no agency, only a "Private ..." designation
 *       access       open | restricted | closed | unknown (raw Pub_Access)
 *       category     protected_area | wilderness | state_park | nature_reserve | managed_forest | national_park | national_monument
 *   Drawing (2026-10-18): `agency` is the layer's color category in six groups (MANAGER_GROUPS, PUBLIC_LANDS_LEGEND): the
 *   legend lists each raw agency value with its group color, so the tile renderer can fill by `agency` with a match expression;
 *   features without an agency (private conservation land, about 7%) take the "Other or unrecorded" group.
 * No upstream call is made by the layer: it only hands the tile URL to the map.
 * Camping rules (2026-10-23, AUDIT R14): ownership is not access, so the note names the hand-kept dispersed-camping
 * closures whose box meets the view (layers/_data/closures.json, shared with forest-roads: Sedona, BLM Moab, the Lake
 * Tahoe Basin, Crested Butte, each with its order, date and link), and elsewhere says to check the closure orders.
 */
import { z } from "zod";
import { defineLayer, type Attribute, type AttributeLevel, type CardSpec, type FieldHelp, type LayerError, type LayerResult, type LegendSpec } from "./types";
import { registerLayer } from "./registry";
import { OUTSIDE_US_NOTE, outsideUs } from "./_shared/coverage";
import { campingRuleNote, campingRulesFor } from "./forest-roads";
import { DARK_GREY, layerColor, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { interpolateStops, rgbToHex } from "@/lib/render/ramp";

export const PADUS_TILE_URL = "https://storage.googleapis.com/wally-tiles/padus/v1/{z}/{x}/{y}.pbf";
export const PADUS_SOURCE_LAYER = "padus";

/**
 * Who manages the land, in six groups the approved palette can tell apart, each listing the PAD-US `agency` values it holds.
 * National parks are pink and national forests sage (2026-10-18: parks in sage faded into green Topo, and forests in
 * dark sage looked like BLM's dark grey). Other federal land (military, dams, energy), the least common, comes last.
 */
export const MANAGER_GROUPS: { label: string; color: string; help: string; agencies: Record<string, string> }[] = [
  {
    label: "National parks and wildlife refuges",
    color: PINK,
    help: "Managed by the National Park Service or the Fish and Wildlife Service.",
    agencies: { NPS: "National Park Service", FWS: "US Fish and Wildlife Service" },
  },
  {
    label: "National forests",
    color: SAGE,
    help: "Managed by the US Forest Service.",
    agencies: { USFS: "US Forest Service" },
  },
  {
    label: "Bureau of Land Management",
    color: DARK_GREY,
    help: "Public land managed by the Bureau of Land Management, mostly open range in the West.",
    agencies: { BLM: "Bureau of Land Management" },
  },
  {
    label: "State land and state parks",
    color: PURPLE,
    help: "Owned or managed by a state: state parks, forests, wildlife areas and state trust land.",
    agencies: { State: "State agency", "State Parks": "State parks agency" },
  },
  {
    label: "Local, tribal and private conservation land",
    color: rgbToHex(interpolateStops([PINK, DARK_GREY], 0.45)),
    help: "City and county parks, tribal land, and land held by land trusts and other nonprofits; access varies.",
    agencies: { Local: "Local government", Tribal: "Tribal government", NGO: "Private nonprofit (land trust)" },
  },
  {
    label: "Other federal (military, dams, energy)",
    color: rgbToHex(interpolateStops([DARK_GREY, PURPLE], 0.5)),
    help: "Army Corps of Engineers, Bureau of Reclamation, Department of Defense, Department of Energy, Tennessee Valley Authority and other federal agencies; often closed to the public.",
    agencies: {
      USACE: "US Army Corps of Engineers",
      USBR: "Bureau of Reclamation",
      DOD: "Department of Defense",
      DOE: "Department of Energy",
      TVA: "Tennessee Valley Authority",
      ARS: "Agricultural Research Service",
      NRCS: "Natural Resources Conservation Service",
    },
  },
];

/** What every raw `agency` value means, for the card. */
export const AGENCY_NAMES: Record<string, string> = Object.assign({}, ...MANAGER_GROUPS.map((g) => g.agencies));

const AGENCY_LEVELS: AttributeLevel[] = MANAGER_GROUPS.flatMap((g) => Object.keys(g.agencies).map((value) => ({ value, label: g.label, help: g.help })));

/**
 * The key the map fills by: one item per raw `agency` value, labelled with its group and carrying the group's color, so a
 * tile `match` on `agency` reads straight off it (the legend shows one swatch per label). Unlisted or missing agencies draw
 * in the layer's own sage outline only.
 */
export const PUBLIC_LANDS_LEGEND: LegendSpec = {
  kind: "categories",
  title: "Managed by",
  field: "agency",
  items: MANAGER_GROUPS.flatMap((g) => Object.keys(g.agencies).map((value) => ({ label: g.label, value, color: g.color, symbol: "polygon" as const, help: g.help }))),
  note: "Areas with no manager recorded (often private conservation land) are outlined only. One place can carry overlapping areas, such as a wilderness inside a national forest.",
};

const ACCESS_HELP: FieldHelp = {
  text: "PAD-US public access: open (open to the public without a permit), restricted (a permit, fee or season applies, or only part is open), closed (no public access), unknown (not recorded). Check the managing agency before relying on it.",
  source: "USGS PAD-US 4.1, Pub_Access",
  url: "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview",
};

const ATTRIBUTES: Attribute[] = [
  { key: "agency", type: "category", label: "Managed by", levels: AGENCY_LEVELS, encode: "color", primary: true },
  {
    key: "access",
    type: "category",
    label: "Public access",
    help: ACCESS_HELP,
    levels: [
      { value: "open", label: "Open" },
      { value: "restricted", label: "Restricted" },
      { value: "closed", label: "Closed" },
      { value: "unknown", label: "Unknown" },
    ],
  },
];

const CARD: CardSpec = {
  facts: [
    { key: "agency", label: "Managed by", values: AGENCY_NAMES },
    { key: "designation", label: "Designation", values: { PUB: "Public land (no special designation)" } },
    { key: "access", label: "Public access", values: { open: "Open", restricted: "Restricted", closed: "Closed", unknown: "Not recorded" }, help: ACCESS_HELP },
  ],
  // `category` is a coarser copy of the designation ("Wilderness area" beside "Wilderness Area"): the card shows the designation once.
  hidden: ["category"],
};

const publicLands = defineLayer({
  id: "public-lands",
  title: "Public land ownership",
  description:
    "Who owns and manages land across the United States, from the USGS Protected Areas Database (PAD-US 4.1), drawn as tinted, hatched areas with a legend. " +
    "Fills show the manager in six groups: national parks and wildlife refuges (National Park Service, Fish and Wildlife Service) pink; national forests (Forest Service) sage; Bureau of Land Management dark grey; other federal land (military, Army Corps, Reclamation, energy) grey-purple; state land and state parks purple; local, tribal and private conservation land brick red. Areas with no manager recorded are outlined only. " +
    "PAD-US combines a Fee layer (who holds title) with Designation and Easement layers (wilderness areas, roadless areas, recreation areas, conservation easements), " +
    "so one place can carry several overlapping polygons, for example a wilderness area inside a national forest. " +
    "Each area has a name, a manager (agency), a designation and a coarse public-access flag (open, restricted, closed, unknown); tapping an area shows them in plain words. " +
    "Use it to show public land ownership on the map so the user can see where national forest, BLM, park, or state land lies; the model itself cannot read the map. " +
    "Caveats: this is ownership and management, not access rules. It does not say whether camping, hunting, fires, drones or vehicles are allowed " +
    "(the note quotes the known dispersed-camping closures near Sedona, Moab, Lake Tahoe and Crested Butte with their orders), " +
    "private land outside the database is simply not drawn, and boundaries are approximate at parcel scale; check the managing agency before relying on it. " +
    "United States only. Returns map tiles drawn on the globe, not features you can count or list. You cannot see the rendered map: say the layer is shown and what each color means, but do not claim which land lies where. " +
    "Works at any size of region, from a whole state down to a single valley.",
  coverage: "us",
  surface: "land",
  license: "Public domain (USGS PAD-US 4.1)",
  requiredEnv: [],
  // A deployment's own copy of the tiles; the default is the maintainer's bucket.
  optionalEnv: ["PADUS_TILES_URL"],
  maxAreaKm2: Number.POSITIVE_INFINITY,
  input: z.object({}),
  style: { geometry: "polygon", color: layerColor("public-lands"), fillOpacity: 0.28 },
  attributes: ATTRIBUTES,
  legend: PUBLIC_LANDS_LEGEND,
  card: CARD,
  fieldHelp: { access: ACCESS_HELP, agency: { text: "The agency that manages the land (PAD-US Mang_Name), grouped on the map: " + MANAGER_GROUPS.map((g) => `${g.label}: ${g.help}`).join(" ") } },
  // PAD-US 4.1, one edition: no time panel.
  time: { shape: "none" },

  async query(ctx): Promise<LayerResult | LayerError> {
    // Outside the US the tiles are simply empty, so they are returned anyway along with the note.
    return {
      kind: "tiles",
      data: {
        url: ctx.env.PADUS_TILES_URL || PADUS_TILE_URL,
        minzoom: 3,
        maxzoom: 12,
        format: "vector",
        sourceLayer: PADUS_SOURCE_LAYER,
        geometry: "polygon",
      },
      citation: {
        source: "U.S. Geological Survey Gap Analysis Project, Protected Areas Database of the United States (PAD-US) 4.1 (public domain)",
        url: "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview",
        retrieved: new Date().toISOString(),
      },
      coverageNote: outsideUs(ctx.bbox) ? OUTSIDE_US_NOTE : campingRuleNote(campingRulesFor(ctx.bbox)),
    };
  },
});

registerLayer(publicLands);

export default publicLands;

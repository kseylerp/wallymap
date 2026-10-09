/**
 * Prints the README layer table (markdown) from the layer registry.
 *
 *   pnpm exec tsx scripts/layer-table.mts            # print to stdout
 *   pnpm exec tsx scripts/layer-table.mts --write    # replace the block between
 *                                                    # <!-- layers:start --> and <!-- layers:end --> in README.md
 *
 * id, title, coverage and key columns come from the registry. "Shows", "Source" and
 * "Freshness" are not on the Layer type, so they are written here; the script throws
 * when a registered layer has no entry, so the table cannot silently go stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { listLayers, type Layer } from "@/layers";

const META: Record<string, { shows: string; source: string; freshness: string; coverage?: string }> = {
  "osm-trails": { shows: "Hiking paths and tracks with difficulty and surface", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  "fire-perimeters": { shows: "Current and past US wildfire outlines", source: "NIFC (WFIGS)", freshness: "Updated through the fire season" },
  "fire-detections": { shows: "Satellite hotspots from the last 1 to 10 days", source: "NASA FIRMS", freshness: "Near real time (hours)" },
  "forest-loss": { shows: "Where tree cover was lost, by year", source: "UMD / Global Forest Watch", freshness: "Yearly" },
  "forest-alerts": { shows: "Recent forest clearing in the tropics", source: "Global Forest Watch (GLAD, RADD)", freshness: "Weekly", coverage: "Tropics (30°S to 30°N)" },
  snowpack: { shows: "Snow water equivalent at mountain weather stations", source: "USDA NRCS SNOTEL", freshness: "Latest reading (daily)", coverage: "Western US" },
  "forest-roads": { shows: "Forest Service roads open to motor vehicles", source: "USDA Forest Service MVUM", freshness: "Yearly" },
  campsites: { shows: "Campsites and parking lots", source: "OpenStreetMap", freshness: "Live (cached up to a day)" },
  streamflow: { shows: "River flow and gauge height at stream gauges", source: "USGS Water Data", freshness: "Latest reading (15 minutes), provisional" },
  species: { shows: "Wildlife and plant sightings", source: "iNaturalist", freshness: "Daily" },
  population: { shows: "Where people live", source: "NASA GIBS (GPW v4)", freshness: "Fixed at 2020" },
  "night-lights": { shows: "Satellite picture of the Earth at night", source: "NASA GIBS (VIIRS)", freshness: "Daily (date in the note)" },
  wilderness: { shows: "Designated wilderness boundaries", source: "Wilderness.net / USGS", freshness: "Updated occasionally" },
  photos: { shows: "Where geotagged photos were taken", source: "Wikimedia Commons, Mapillary", freshness: "Live" },
  "physical-regions": { shows: "Named mountain ranges, deserts and plateaus", source: "Natural Earth", freshness: "Static" },
  "public-lands": { shows: "Who owns and manages the land", source: "USGS PAD-US 4.1", freshness: "Static (release 4.1)" },
  popularity: { shows: "Estimated popularity score (0 to 100) per trail", source: "Computed from OSM, Commons, Mapillary", freshness: "Computed per query" },
  "popularity-campsites": { shows: "Estimated popularity score (0 to 100) per campsite", source: "Computed from OSM, Commons, Mapillary", freshness: "Computed per query" },
  remoteness: { shows: "Remoteness score (0 to 100) per hexagon", source: "Computed from OSM and wilderness boundaries", freshness: "Computed per query" },
};

function coverageText(l: Layer): string {
  const override = META[l.id]?.coverage;
  if (override) return override;
  if (l.coverage === "global") return "Global";
  if (l.coverage === "us") return "US";
  return `Box ${l.coverage.bbox.join(", ")}`;
}

function keyText(l: Layer): string {
  const parts = [
    ...l.requiredEnv.map((n) => `\`${n}\` (required)`),
    ...(l.optionalEnv ?? []).map((n) => `\`${n}\` (optional)`),
  ];
  return parts.length > 0 ? parts.join(", ") : "None";
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

export function layerTable(): string {
  const rows = listLayers().map((l) => {
    const m = META[l.id];
    if (!m) throw new Error(`scripts/layer-table.mts has no entry for layer "${l.id}"`);
    return `| \`${l.id}\` | ${cell(l.title)} | ${cell(m.shows)} | ${cell(m.source)} | ${coverageText(l)} | ${keyText(l)} | ${cell(m.freshness)} |`;
  });
  return [
    "| Id | Title | What it shows | Source | Coverage | Key needed | Freshness |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const table = layerTable();
if (process.argv.includes("--write")) {
  const path = "README.md";
  const text = readFileSync(path, "utf8");
  const re = /(<!-- layers:start -->)[\s\S]*?(<!-- layers:end -->)/;
  if (!re.test(text)) throw new Error("README.md is missing the layers:start / layers:end markers");
  writeFileSync(path, text.replace(re, `$1\n${table}\n$2`));
  console.log(`Updated ${path}`);
} else {
  console.log(table);
}

/**
 * Records a live sample of every layer's features for the card-text test (lib/checks/cardSamples.test.ts), so no layer
 * can ship a card that shows raw keys ("Huc 10190003", "Depth ft", "Rank 1"), whether or not an eval question draws it.
 *
 *   node --env-file=.env.local --import tsx scripts/card-samples.mts            # every layer
 *   node --env-file=.env.local --import tsx scripts/card-samples.mts mines dams # only these
 *
 * Each layer runs once through runLayer on the box below (mostly boxes the eval questions asked). A geojson answer keeps
 * up to SAMPLE_SIZE features, chosen so every property key seen appears at least once, with the geometry reduced to one
 * point (the card reads properties only). A tiles answer is recorded as tiles (a raster has no card). A layer whose
 * source fails keeps its previous sample and is reported.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Feature, Geometry, Position } from "geojson";
import { listLayers } from "@/layers";
import { runLayer } from "@/lib/layers/run";
import type { BBox } from "@/layers/types";

export const SAMPLES_FILE = new URL("../lib/checks/__fixtures__/card-samples.json", import.meta.url);

/** Most features kept per layer. */
const SAMPLE_SIZE = 12;

export type CardSample =
  | { kind: "geojson"; recorded: string; bbox: BBox; features: Feature[] }
  | { kind: "tiles"; recorded: string; bbox: BBox }
  /** A source that was down when recorded, with what it said (the test skips it and names it). */
  | { kind: "unavailable"; recorded: string; bbox: BBox; error: string };

/** Where each layer has features: one box and input per layer. */
export const SAMPLE_QUERIES: Record<string, { bbox: BBox; input?: Record<string, unknown>; fixture?: string }> = {
  aquifers: { bbox: [-101.845, 40.93, -101.481, 41.245] },
  "burn-severity": { bbox: [-122.6, 44.5, -121.8, 45.1], input: { year: 2020 } },
  campsites: { bbox: [-109.8, 38.4, -109.4, 38.7], input: { includeParking: true } },
  "air-quality": { bbox: [-119.7, 37.68, -119.5, 37.78], input: { at: [-119.59, 37.74] } },
  "carbon-flux": { bbox: [-139.854, 54.662, -129.995, 60] },
  "forest-types": { bbox: [117.6, 4.8, 118.0, 5.1] },
  climbing: { bbox: [-84, 37.5, -83, 38] },
  terrain: { bbox: [-110.95, 43.45, -110.9, 43.5] },
  "condor-range": { bbox: [-121.93, 35.774, -121.244, 36.377] },
  "critical-habitat": { bbox: [-113.85, 37.0, -113.458, 37.341], input: { species: "desert tortoise", includeProposed: true } },
  dams: { bbox: [-112, 35.5, -110, 37.5] },
  "river-pulse": { bbox: [-92, 36, -88, 40] },
  "ocean-currents": { bbox: [-152.5, 59.5, -150, 61.3] },
  "wind-flow": { bbox: [-120.5, 37, -118.5, 38.5] },
  "weather-forecast": { bbox: [-113.2, 37.1, -112.85, 37.5] },
  avalanche: { bbox: [-121.2, 47.6, -120.9, 47.85] },
  disasters: { bbox: [-87.635, 24.43, -79.938, 31.001], input: { days: 90, years: 5 } },
  disturbance: { bbox: [-125, 49, -122, 51] },
  drought: { bbox: [-109.06, 36.992, -102.042, 41.003] },
  earthquakes: { bbox: [-119.089, 37.549, -118.62, 37.75], input: { days: 365, minMagnitude: 1 } },
  "fire-detections": { bbox: [-125, 32, -100, 49] },
  "fire-hazard": { bbox: [-121.4, 43.9, -121.2, 44.1] },
  "fire-perimeters": { bbox: [-122.6, 44.5, -121.8, 45.1], input: { yearsBack: 10, minAcres: 100 } },
  "fire-weather": { bbox: [-121.293, 32.575, -114.453, 35.756] },
  fishing: { bbox: [-111.351, 45.457, -110.755, 45.915] },
  "flood-extent": { bbox: [22.5, -18.501, 25.262, -17.47] },
  "flood-zones": { bbox: [-82.564, 35.588, -82.542, 35.601] },
  "forest-alerts": { bbox: [20, -3, 24, 1] },
  "forest-loss": { bbox: [-66.81, -13.692, -59.774, -7.976] },
  "forest-roads": { bbox: [-112.008, 34.906, -111.005, 35.883] },
  "gbif-occurrences": { bbox: [-105.6, 39.5, -105.1, 40], input: { scientificName: "Puma concolor", density: false } },
  "geologic-unit": { bbox: [-119.795, 37.495, -119.307, 37.904], input: { lon: -119.588651, lat: 37.749375 } },
  geology: { bbox: [-112.941, 35.763, -111.446, 36.4] },
  glaciers: { bbox: [-110.178, 42.799, -109.128, 43.569] },
  "grazing-allotments": { bbox: [-117.5, 37.5, -115.5, 39], input: { show: "both" } },
  greenness: { bbox: [-121, 36, -119, 38] },
  groundwater: { bbox: [-112.313, 33.29, -111.926, 33.874] },
  "hardiness-zones": { bbox: [-73.438, 42.727, -71.465, 45.035] },
  "imagery-by-date": { bbox: [-156.724, 20.757, -156.541, 21.057], input: { date: "2023-07-01", sensor: "landsat" } },
  lakes: { bbox: [-120.25, 38.93, -119.95, 39.23] },
  "land-cover": { bbox: [-73.495, -51.58, -72.249, -50.602] },
  "methane-plumes": { bbox: [-104.5, 31, -101.5, 34], input: { days: 730 } },
  mines: { bbox: [-117.542, 39.997, -116.334, 41.001] },
  // Nevada (Carlin trend): the Moab box's source answered offline.
  "mining-claims": { bbox: [-116.5, 40.6, -116.1, 40.9] },
  monuments: { bbox: [-110.5, 36.8, -109.2, 38.2], input: { version: "both" } },
  "mtb-trails": { bbox: [-109.8, 38.4, -109.4, 38.7] },
  "night-lights": { bbox: [-114.356, 38.818, -114.123, 39.064] },
  "old-growth": { bbox: [-122.5, 43.5, -121.5, 44.5] },
  "osm-trails": { bbox: [6.814, 45.833, 7.044, 46.031] },
  "outdoor-features": { bbox: [7.6, 45.9, 7.9, 46.1] },
  paddling: { bbox: [-115.3, 44.6, -114.3, 45.3] },
  peaks: { bbox: [18, -34.5, 19, -33.5] },
  permafrost: { bbox: [-150, 64, -146, 66] },
  phenology: { bbox: [-83.675, 36.541, -75.174, 39.466] },
  photos: { bbox: [138.65, 35.3, 138.8, 35.4] },
  "physical-regions": { bbox: [-121, 35.3, -118, 40.5] },
  "pipelines-lines": { bbox: [-102.3, 31.651, -101.772, 32.171] },
  popularity: { bbox: [-120.15, 38.9, -120.0, 39.0] },
  "popularity-campsites": { bbox: [-109.8, 38.4, -109.4, 38.7] },
  population: { bbox: [-114.356, 38.818, -114.123, 39.064] },
  ports: { bbox: [-97.4, 25.8, -80.0, 30.5] },
  "power-plants": { bbox: [-114.816, 31.332, -109.045, 37.004] },
  "protected-areas-world": { bbox: [20, 54, 30, 60] },
  "public-lands": { bbox: [-112.182, 37.655, -112.115, 37.72] },
  "recreation-sites": { bbox: [-112.076, 34.306, -110.963, 35.585] },
  remoteness: { bbox: [-110.178, 42.799, -109.128, 43.569] },
  // California (CDEC): www.usbr.gov timed out from here on 2026-10-17.
  "reservoir-levels": { bbox: [-123, 40.4, -121.5, 41.2] },
  "river-basins": { bbox: [-105.11, 39.618, -104.583, 39.914] },
  "sea-ice": { bbox: [-180, 66, 180, 90] },
  "sea-level-rise": { bbox: [-80.187, 32.632, -79.763, 32.982], input: { feet: 6 } },
  // NOAA answered every request with one station on 2026-10-17; the recorded list stands in when it is down.
  "sea-level-trends": { bbox: [-123, 37, -121.5, 38.5], fixture: "sealvltrends.sample.json" },
  "sequoia-groves": { bbox: [-119.5, 35.8, -118.3, 37] },
  "sequoia-mortality": { bbox: [-119.5, 35.8, -118.3, 37] },
  "ski-routes": { bbox: [6.814, 45.833, 7.044, 46.031] },
  smoke: { bbox: [-125, 32, -100, 49] },
  "snow-cover": { bbox: [-121.8, 45.2, -121.5, 45.5] },
  snowpack: { bbox: [-122, 45, -121, 46] },
  species: { bbox: [-115.585, 51.161, -115.545, 51.194] },
  streamflow: { bbox: [-110.886, 43.235, -110.057, 43.654] },
  surf: { bbox: [-122.6, 37.3, -122.0, 37.6], input: { forecast: true, season: false } },
  "surface-water": { bbox: [-115.5, 35.5, -113.5, 37.5] },
  "temperature-anomaly": { bbox: [-120.919, 35.907, -118.361, 37.586] },
  tides: { bbox: [-68.657, 44.004, -68.031, 44.429] },
  "tree-mortality": { bbox: [-106.5, 39.3, -105.8, 39.8] },
  uranium: { bbox: [-110.963, 35.058, -108.184, 37.316] },
  "weather-alerts": { bbox: [-124, 32, -112, 42] },
  "wikipedia-nearby": { bbox: [18.4, -34, 18.5, -33.95] },
  wilderness: { bbox: [-110, 42.7, -109.3, 43.4] },
  "wolf-packs": { bbox: [-124.862, 45.544, -116.916, 49.003] },
};

function firstPosition(g: Geometry | null): Position | null {
  if (!g) return null;
  switch (g.type) {
    case "Point":
      return g.coordinates;
    case "MultiPoint":
    case "LineString":
      return g.coordinates[0] ?? null;
    case "MultiLineString":
    case "Polygon":
      return g.coordinates[0]?.[0] ?? null;
    case "MultiPolygon":
      return g.coordinates[0]?.[0]?.[0] ?? null;
    case "GeometryCollection":
      return g.geometries.length > 0 ? firstPosition(g.geometries[0]) : null;
  }
}

/** Up to SAMPLE_SIZE features: first every feature that brings a key not seen yet, then the rest in order. */
export function pickSample(features: Feature[], size = SAMPLE_SIZE): Feature[] {
  const seen = new Set<string>();
  const picked: Feature[] = [];
  for (const f of features) {
    const keys = Object.keys(f.properties ?? {}).filter((k) => !seen.has(k));
    if (keys.length === 0 || picked.length >= size) continue;
    keys.forEach((k) => seen.add(k));
    picked.push(f);
  }
  for (const f of features) {
    if (picked.length >= size) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return picked.map((f) => {
    const p = firstPosition(f.geometry);
    // A frame series (one value per day or hour under each key: river pulse, currents, wind) is never a card row and
    // would make the file huge; a list of dated readings (a reservoir's history) stays.
    const { series, ...rest } = f.properties ?? {};
    const properties = series === undefined || Array.isArray(series) ? (f.properties ?? {}) : rest;
    return { type: "Feature", ...(f.id !== undefined && { id: f.id }), geometry: p ? { type: "Point", coordinates: p.slice(0, 2) } : null, properties } as Feature;
  });
}

export function readSamples(): Record<string, CardSample> {
  return existsSync(SAMPLES_FILE) ? (JSON.parse(readFileSync(SAMPLES_FILE, "utf8")) as Record<string, CardSample>) : {};
}

async function main(only: string[]) {
  const samples = readSamples();
  const recorded = new Date().toISOString().slice(0, 10);
  const layers = listLayers().filter((l) => only.length === 0 || only.includes(l.id));
  for (const layer of layers) {
    const q = SAMPLE_QUERIES[layer.id];
    if (!q) {
      console.log(`${layer.id}: no sample box (add one to SAMPLE_QUERIES)`);
      continue;
    }
    const started = Date.now();
    let { body } = await runLayer(layer.id, { bbox: q.bbox, zoom: 10, input: q.input ?? {} });
    // A source that is down, or answered nothing here: the layer's own recorded response, read by the layer's own code.
    if (q.fixture && ("error" in body || (body.kind === "geojson" && body.data.features.length === 0))) {
      const text = readFileSync(new URL(`../layers/__fixtures__/${q.fixture}`, import.meta.url), "utf8");
      const fetch = (async () => new Response(text, { status: 200 })) as unknown as Parameters<typeof layer.query>[0]["fetch"];
      body = await layer.query({ bbox: q.bbox, zoom: 10, env: {}, fetch }, layer.input.parse(q.input ?? {}));
      console.log(`${layer.id}: live source failed or empty; read the recorded ${q.fixture}`);
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if ("error" in body) {
      const kept = samples[layer.id];
      console.log(`${layer.id}: ERROR ${String(body.error).slice(0, 160)} (${secs} s)${kept ? `; kept the ${kept.recorded} sample` : ""}`);
      if (!kept || kept.kind === "unavailable") samples[layer.id] = { kind: "unavailable", recorded, bbox: q.bbox, error: String(body.error).slice(0, 200) };
      continue;
    }
    if (body.kind === "tiles") {
      samples[layer.id] = { kind: "tiles", recorded, bbox: q.bbox };
      console.log(`${layer.id}: tiles (${secs} s)`);
      continue;
    }
    const features = pickSample(body.data.features);
    if (features.length === 0) {
      console.log(`${layer.id}: no features in the sample box (${secs} s)${samples[layer.id] ? "; kept the previous sample" : ""}`);
      continue;
    }
    samples[layer.id] = { kind: "geojson", recorded, bbox: q.bbox, features };
    console.log(`${layer.id}: ${features.length} of ${body.data.features.length} (${secs} s)`);
  }
  const sorted = Object.fromEntries(Object.entries(samples).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(SAMPLES_FILE, `${JSON.stringify(sorted, null, 1)}\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) await main(process.argv.slice(2));

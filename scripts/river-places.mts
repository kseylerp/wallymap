/**
 * Builds data/river-places.json: the towns the river-pulse layer names a reach after ("Mississippi near Baton Rouge"),
 * from Natural Earth 10m populated places (public domain), every place of at least 20,000 people, as [name, lon, lat]
 * rounded to 0.01°. Static: rerun only to change the rule.
 *
 *   node --import tsx scripts/river-places.mts
 */
import { writeFileSync } from "node:fs";

const URL_PLACES = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson";
const MIN_POP = 20_000;
type Place = { properties: { name: string; pop_max: number; longitude: number; latitude: number } };

const res = await fetch(URL_PLACES);
if (!res.ok) throw new Error(`${URL_PLACES} answered ${res.status}`);
const { features } = (await res.json()) as { features: Place[] };
const places = features
  .filter((f) => f.properties.pop_max >= MIN_POP && f.properties.name)
  .sort((a, b) => b.properties.pop_max - a.properties.pop_max)
  .map((f) => [f.properties.name, Number(f.properties.longitude.toFixed(2)), Number(f.properties.latitude.toFixed(2))]);
const out = new URL("../data/river-places.json", import.meta.url);
writeFileSync(out, `${JSON.stringify({ source: "Natural Earth 10m populated places (public domain), at least 20,000 people", places })}\n`);
console.log(`wrote ${places.length} places to data/river-places.json`);

/**
 * Routes the words people use to the data layers that answer them. The table is
 * rendered into the system prompt and echoed by list_layers, so keep it short.
 * When a question matches several layers, the model queries them in table order.
 */
export type VocabularyEntry = {
  layerId: string;
  synonyms: string[];
  notes: string;
};

export const VOCABULARY: VocabularyEntry[] = [
  { layerId: "osm-trails", synonyms: ["trail", "hike", "path", "route"], notes: "named footpaths and tracks" },
  { layerId: "fire-perimeters", synonyms: ["wildfire", "fire", "burn", "burned area"], notes: "fire outlines; also query fire-detections" },
  { layerId: "fire-detections", synonyms: ["active fire", "hotspot", "smoke"], notes: "satellite heat spots from recent days" },
  { layerId: "forest-loss", synonyms: ["deforestation", "logging", "clearcut", "tree loss"], notes: "yearly loss; also query forest-alerts" },
  { layerId: "forest-alerts", synonyms: ["recent clearing", "new deforestation"], notes: "recent weekly alerts" },
  { layerId: "snowpack", synonyms: ["snow", "snowpack", "SWE", "snow depth"], notes: "snow water equivalent" },
  { layerId: "streamflow", synonyms: ["river flow", "flow", "cfs", "runoff", "gauge"], notes: "stream gauges; a river name itself is a geocode" },
  { layerId: "forest-roads", synonyms: ["dispersed", "boondocking", "free camping", "forest road", "4x4"], notes: "roads open to motor vehicles; cannot say where dispersed camping is allowed, so tell the user to check the ranger district" },
  { layerId: "campsites", synonyms: ["campground", "campsite", "camping"], notes: "established sites" },
  { layerId: "species", synonyms: ["wildlife", "species", "birds", "bears", "animals"], notes: "sighting records" },
  { layerId: "photos", synonyms: ["photos", "instagrammable", "geotag", "viewpoint"], notes: "geotagged pictures" },
  { layerId: "public-lands", synonyms: ["public land", "BLM", "national forest", "who owns"], notes: "land ownership" },
  { layerId: "wilderness", synonyms: ["wilderness", "designated wilderness"], notes: "protected wilderness areas" },
  { layerId: "physical-regions", synonyms: ["region", "range", "the Andes", "plateau"], notes: "named landform regions" },
  { layerId: "night-lights", synonyms: ["night sky", "light pollution", "dark sky", "dark"], notes: "satellite night brightness" },
  { layerId: "population", synonyms: ["people", "population", "density"], notes: "residents per area" },
  { layerId: "popularity", synonyms: ["crowded", "busy", "popular", "congestion", "foot traffic"], notes: "estimate computed from other layers" },
  { layerId: "remoteness", synonyms: ["remote", "untouched", "wild", "solitude"], notes: "estimate computed from other layers" },
];

/** One line per layer: id, its synonyms, then a short note. */
export function vocabularyForPrompt(): string {
  return VOCABULARY.map((e) => `- ${e.layerId}: ${e.synonyms.join(", ")} (${e.notes})`).join("\n");
}

/** Synonyms for one layer; empty when the layer has no entry. */
export function synonymsFor(layerId: string): string[] {
  return VOCABULARY.find((e) => e.layerId === layerId)?.synonyms ?? [];
}

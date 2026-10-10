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
  { layerId: "osm-trails", synonyms: ["trail", "hike", "path"], notes: "named footpaths and tracks" },
  { layerId: "fire-perimeters", synonyms: ["wildfire", "fire", "burn", "burned area"], notes: "fire outlines; also query fire-detections" },
  { layerId: "fire-detections", synonyms: ["active fire", "hotspot"], notes: "satellite heat sources from recent days, not smoke" },
  { layerId: "forest-loss", synonyms: ["deforestation", "logging", "clearcut", "tree loss"], notes: "yearly loss; also query forest-alerts" },
  { layerId: "forest-alerts", synonyms: ["recent clearing", "new deforestation"], notes: "recent weekly alerts" },
  { layerId: "snowpack", synonyms: ["snow", "snowpack", "SWE"], notes: "snow water equivalent, not depth or avalanche danger" },
  { layerId: "streamflow", synonyms: ["river flow", "cfs", "runoff", "gauge", "flood", "high water"], notes: "stream gauges; a river name itself is a geocode" },
  { layerId: "forest-roads", synonyms: ["dispersed", "boondocking", "free camping", "forest road", "off-road", "4x4"], notes: "roads open to motor vehicles; also query campsites; cannot say where dispersed camping is allowed, so tell the user to check the ranger district" },
  { layerId: "campsites", synonyms: ["campground", "campsite", "camping"], notes: "established sites" },
  { layerId: "species", synonyms: ["wildlife", "species", "birds", "bird", "birding", "bears", "animals"], notes: "sighting records" },
  { layerId: "photos", synonyms: ["photos", "instagrammable", "geotag", "viewpoint"], notes: "geotagged pictures; viewpoints by photo density" },
  { layerId: "public-lands", synonyms: ["public land", "BLM", "national forest", "who owns"], notes: "land ownership" },
  { layerId: "wilderness", synonyms: ["wilderness", "designated wilderness"], notes: "protected wilderness areas" },
  { layerId: "physical-regions", synonyms: ["region", "the Andes", "the Rockies", "mountain range", "plateau"], notes: "named landform regions" },
  { layerId: "night-lights", synonyms: ["night sky", "light pollution", "dark sky", "stargazing"], notes: "satellite night brightness" },
  { layerId: "population", synonyms: ["population", "how many people", "density"], notes: "residents per area" },
  { layerId: "popularity-campsites", synonyms: ["busiest campgrounds", "crowded campsites"], notes: "camp site scores" },
  { layerId: "popularity", synonyms: ["crowded", "busy", "popular", "congestion", "foot traffic"], notes: "trails; see popularity-campsites" },
  { layerId: "remoteness", synonyms: ["remote", "untouched", "off the grid", "solitude"], notes: "estimate computed from other layers" },
  { layerId: "mtb-trails", synonyms: ["mountain biking", "mountain bike", "mtb", "singletrack", "flow trail", "bike park"], notes: "rated bike trails, v = 0-6 difficulty" },
];

/** One line per layer: id, its synonyms, then a short note. */
export function vocabularyForPrompt(): string {
  return VOCABULARY.map((e) => `- ${e.layerId}: ${e.synonyms.join(", ")} (${e.notes})`).join("\n");
}

/** Synonyms for one layer; empty when the layer has no entry. */
export function synonymsFor(layerId: string): string[] {
  return VOCABULARY.find((e) => e.layerId === layerId)?.synonyms ?? [];
}

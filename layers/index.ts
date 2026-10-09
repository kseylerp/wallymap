export { registerLayer, getLayer, listLayers, clearRegistry } from "./registry";
export * from "./types";

// Layer imports go below this line (each layer file registers itself on import).
import "./osm-trails";
import "./fire-perimeters";
import "./fire-detections";

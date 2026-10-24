import { listLayers } from "@/layers";
import { catalogEntry } from "@/lib/layers/catalog";

/** Public layer catalog for the browser: titles and styles, never env or query code (lib/layers/catalog.ts). */
export async function GET(): Promise<Response> {
  return Response.json(listLayers().map(catalogEntry));
}

import { catalogFields, type LayerCatalog } from "@/lib/agent/applyToolResult";

/**
 * The public layer catalog the browser reads once (`GET /api/layers`): each layer's title, style, licence, field help,
 * card and attributes by id. The app and the permalink restore read it the same way, so a layer opened from a link has
 * the same row controls as one the agent drew. An empty catalog means the request failed.
 */
export async function fetchCatalog(): Promise<LayerCatalog> {
  try {
    const res = await fetch("/api/layers");
    if (!res.ok) return {};
    const entries = (await res.json()) as ({ id: string } & LayerCatalog[string])[];
    return Object.fromEntries(
      entries.map((e) => [
        e.id,
        {
          title: e.title,
          style: e.style,
          license: e.license,
          ...catalogFields(e),
          ...(typeof e.maxAreaKm2 === "number" && { maxAreaKm2: e.maxAreaKm2 }),
        },
      ]),
    );
  } catch {
    // Without a catalog, layers still draw with the fallback title and style.
    return {};
  }
}

import { listLayers } from "@/layers";

/** Public layer catalog for the browser: titles and styles, never env or query code. */
export async function GET(): Promise<Response> {
  return Response.json(
    listLayers().map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      coverage: l.coverage,
      license: l.license,
      style: l.style,
      ...(l.fieldHelp && { fieldHelp: l.fieldHelp }),
      ...(l.card && { card: l.card }),
    })),
  );
}

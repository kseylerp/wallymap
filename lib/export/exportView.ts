import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { zipStored } from "@/lib/export/zip";
import type { MapState } from "@/lib/render/state";

export type ExportFile = { name: string; blob: Blob };
export type ExportBundle = { files: ExportFile[] };

/** More files than this are downloaded as one .zip instead of several separate downloads. */
export const MAX_LOOSE_FILES = 3;

/** "2.1 MB", "377 B": a size for the confirm step. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The layers the export covers: those with a visible render op, in drawing order. */
function visibleLayers(state: MapState) {
  const seen = new Set<string>();
  return state.renderOps.flatMap((op) => {
    const layer = state.layers[op.layerId];
    if (!op.visible || !layer || seen.has(layer.id)) return [];
    seen.add(layer.id);
    return [layer];
  });
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * One `<layerId>.geojson` per visible GeoJSON layer (the full result, with a `wallymap` block naming its title,
 * retrieval time, license and citation) plus `citations.md` covering every visible layer, tile layers included,
 * the map viewport and the export time.
 */
export function buildExportBundle(state: MapState, catalog: LayerCatalog | null, now: Date = new Date()): ExportBundle {
  const layers = visibleLayers(state);
  const files: ExportFile[] = [];
  const bullets: string[] = [];

  for (const layer of layers) {
    const { citation } = layer.result;
    const license = catalog?.[layer.id]?.license ?? "not recorded";
    const retrieved = citation.retrieved || layer.receivedAt;
    if (layer.result.kind === "geojson") {
      const collection = {
        ...layer.result.data,
        wallymap: { layer: layer.title, layerId: layer.id, retrieved, license, citation },
      };
      files.push({
        name: `${fileSafe(layer.id)}.geojson`,
        blob: new Blob([JSON.stringify(collection)], { type: "application/geo+json" }),
      });
    }
    bullets.push(
      `- **${layer.title}** (\`${layer.id}\`${layer.result.kind === "tiles" ? ", map tiles, not exported as data" : ""}): ` +
        `${citation.source}, <${citation.url}>, retrieved ${retrieved}, license: ${license}`,
    );
  }

  const { longitude, latitude, zoom, pitch, bearing } = state.viewport;
  const markdown = [
    "# WallyMap export: sources",
    "",
    `Exported ${now.toISOString()}.`,
    "",
    `Map view: longitude ${fixed(longitude, 5)}, latitude ${fixed(latitude, 5)}, zoom ${fixed(zoom, 2)}, pitch ${fixed(pitch, 0)}, bearing ${fixed(bearing, 0)}; basemap ${state.basemap}.`,
    "",
    "## Layers",
    "",
    ...(bullets.length > 0 ? bullets : ["- No visible layers."]),
    "",
  ].join("\n");
  files.push({ name: "citations.md", blob: new Blob([markdown], { type: "text/markdown" }) });
  return { files };
}

/** Packs the bundle into a single .zip blob (stored, no compression). */
export async function zipBundle(bundle: ExportBundle, now: Date = new Date()): Promise<Blob> {
  const entries = await Promise.all(
    bundle.files.map(async ({ name, blob }) => ({ name, data: new Uint8Array(await blob.arrayBuffer()) })),
  );
  return new Blob([zipStored(entries, now) as BlobPart], { type: "application/zip" });
}

function clickDownload(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start reading the blob before it is released.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Downloads the bundle; call it only from a click the user confirmed. Separate files up to `MAX_LOOSE_FILES`, otherwise one zip. Returns the names downloaded. */
export async function downloadBundle(bundle: ExportBundle, now: Date = new Date()): Promise<string[]> {
  if (bundle.files.length > MAX_LOOSE_FILES) {
    const name = `wallymap-export-${now.toISOString().slice(0, 10)}.zip`;
    clickDownload(name, await zipBundle(bundle, now));
    return [name];
  }
  for (const [i, file] of bundle.files.entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 150));
    clickDownload(file.name, file.blob);
  }
  return bundle.files.map((f) => f.name);
}

import type { LayerCatalog } from "@/lib/agent/applyToolResult";
import { zipStored } from "@/lib/export/zip";
import type { MapState } from "@/lib/render/state";
import { compareSummary } from "@/lib/render/compare";
import { compareSides, effectiveMode, windowText } from "@/lib/render/compareView";
import { applyFilters, deriveFilterFields, filterSummary } from "@/lib/render/filters";
import { activeFilters } from "@/lib/render/reducer";
import { visibleState } from "@/lib/render/view";
import { windowLabel } from "@/lib/time";

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

/** A layer's exported and loaded feature counts, when the time window or its filters left some out. */
function narrowing(state: MapState, layerId: string): { shown?: number; total?: number } {
  const loaded = state.layers[layerId];
  const shown = visibleState(state).layers[layerId];
  if (loaded?.result.kind !== "geojson" || shown?.result.kind !== "geojson") return {};
  const total = loaded.result.data.features.length;
  const count = shown.result.data.features.length;
  return count === total ? {} : { shown: count, total };
}

/** What an export records about a compare: the mode drawn, both windows, and (GeoJSON) the delta counts. */
export type CompareNote = {
  layerId: string;
  mode: string;
  a: [string, string];
  b: [string, string];
  aLabel?: string;
  bLabel?: string;
  counts?: { aOnly: number; bOnly: number; both: number };
};

function compareNote(state: MapState): CompareNote | undefined {
  const compare = state.compare;
  const loaded = compare ? state.layers[compare.layerId] : undefined;
  if (!compare || !loaded) return undefined;
  const filters = activeFilters(state.renderOps.find((op) => op.layerId === compare.layerId)?.filters);
  const delta = loaded.result.kind === "geojson" ? compareSides(loaded, filters, compare, true).delta : undefined;
  const summary = delta?.result.kind === "geojson" ? compareSummary(delta.result.data) : undefined;
  return {
    layerId: compare.layerId,
    mode: effectiveMode(state) ?? compare.mode,
    a: compare.a,
    b: compare.b,
    ...(compare.aLabel && { aLabel: compare.aLabel }),
    ...(compare.bLabel && { bLabel: compare.bLabel }),
    ...(summary && { counts: { aOnly: summary.aOnly, bOnly: summary.bOnly, both: summary.both } }),
  };
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * One `<layerId>.geojson` per visible GeoJSON layer (the features as drawn: inside the time window and the layer's
 * filters, with a `wallymap` block naming its title, retrieval time, license, citation and what narrowed it) plus
 * `citations.md` covering every visible layer, tile layers included, the map viewport, the time window and the
 * export time. During a compare the compared layer exports whole (all its loaded features, its filters applied; not
 * side A and not the delta), its block carries a `compare` note instead of the time window, and `citations.md` gains a
 * compare section: mode, the A and B windows and the delta counts.
 */
export function buildExportBundle(state: MapState, catalog: LayerCatalog | null, now: Date = new Date()): ExportBundle {
  const layers = visibleLayers(visibleState(state));
  const time = state.time;
  const timeNote = time ? `${windowLabel(time.window, time.index.bucket)} (${time.window[0]} to ${time.window[1]})` : undefined;
  const files: ExportFile[] = [];
  const bullets: string[] = [];
  const compared = compareNote(state);

  for (const layer of layers) {
    const { citation } = layer.result;
    const license = catalog?.[layer.id]?.license ?? "not recorded";
    const retrieved = citation.retrieved || layer.receivedAt;
    const loaded = state.layers[layer.id];
    const filters = activeFilters(state.renderOps.find((op) => op.layerId === layer.id)?.filters);
    const isCompared = compared?.layerId === layer.id;
    // The compared layer's view is one side (or the delta); the export takes every loaded feature its filters keep.
    const data =
      isCompared && loaded.result.kind === "geojson"
        ? filters
          ? applyFilters(loaded.result.data, filters)
          : loaded.result.data
        : layer.result.kind === "geojson"
          ? layer.result.data
          : undefined;
    const narrowed =
      isCompared && data && loaded.result.kind === "geojson"
        ? data.features.length === loaded.result.data.features.length
          ? {}
          : { shown: data.features.length, total: loaded.result.data.features.length }
        : narrowing(state, layer.id);
    const filterNote =
      filters && loaded.result.kind === "geojson"
        ? filterSummary(deriveFilterFields(loaded.result.data, { unitForV: loaded.style.unit }), filters)
        : "";
    if (data) {
      const collection = {
        ...data,
        wallymap: {
          layer: layer.title,
          layerId: layer.id,
          retrieved,
          license,
          citation,
          // Only a layer with dates was narrowed by the window; an undated layer exports whole. The compared layer
          // ignores the window and records the compare instead.
          ...(isCompared
            ? { compare: compared }
            : time && time.index.layerIds.includes(layer.id) && { timeWindow: time.window }),
          ...(filters && { filters }),
        },
      };
      files.push({
        name: `${fileSafe(layer.id)}.geojson`,
        blob: new Blob([JSON.stringify(collection)], { type: "application/geo+json" }),
      });
    }
    const shown = narrowed.shown !== undefined ? `; ${narrowed.shown.toLocaleString("en-US")} of ${narrowed.total?.toLocaleString("en-US")} features exported` : "";
    bullets.push(
      `- **${layer.title}** (\`${layer.id}\`${layer.result.kind === "tiles" ? ", map tiles, not exported as data" : ""}): ` +
        `${citation.source}, <${citation.url}>, retrieved ${retrieved}, license: ${license}${shown}${filterNote ? `; filtered: ${filterNote}` : ""}`,
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
    ...(timeNote ? [`Time window: ${timeNote}. Dated features outside it are not exported; features without a date are.`, ""] : []),
    ...(compared ? compareMarkdown(compared, state.layers[compared.layerId]?.title ?? compared.layerId) : []),
    ...(layers.some((l) => activeFilters(state.renderOps.find((op) => op.layerId === l.id)?.filters))
      ? ["Filters set in the layer panel apply: each filtered layer exports only the features that pass.", ""]
      : []),
    "## Layers",
    "",
    ...(bullets.length > 0 ? bullets : ["- No visible layers."]),
    "",
  ].join("\n");
  files.push({ name: "citations.md", blob: new Blob([markdown], { type: "text/markdown" }) });
  return { files };
}

function compareMarkdown(note: CompareNote, title: string): string[] {
  const side = (w: [string, string], label: string | undefined) => `${w[0]} to ${w[1]} (${label ?? windowText(w)})`;
  const counts = note.counts
    ? ` Delta: ${note.counts.aOnly.toLocaleString("en-US")} A only, ${note.counts.bOnly.toLocaleString("en-US")} B only, ${note.counts.both.toLocaleString("en-US")} both.`
    : "";
  return [
    "## Compare",
    "",
    `${title} (\`${note.layerId}\`), ${note.mode} mode. A: ${side(note.a, note.aLabel)}. B: ${side(note.b, note.bLabel)}.${counts}`,
    "The compared layer exports all its loaded features (its filters apply; the time window does not).",
    "",
  ];
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

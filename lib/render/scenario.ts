import type { LayerResult, TileScenario } from "@/layers/types";
import type { LoadedLayer, MapState } from "@/lib/render/state";

/**
 * Scenario tile layers (sea level rise: one tile service per amount of rise), the pure half. A tiles result that
 * publishes `data.scenario` can be pointed at any of its `values`: the scenario scrubber (components/ScenarioScrubber.tsx)
 * and compare (lib/render/compareView.ts) rewrite its URL from `template`, and lib/render/view.ts draws the value the
 * reducer holds in `MapState.scenario`.
 */

/** A layer's scenario contract, or undefined for any other layer. */
export function scenarioOf(layer: LoadedLayer | undefined): TileScenario | undefined {
  return layer?.result.kind === "tiles" ? layer.result.data.scenario : undefined;
}

/** What replaces `{value}` for a value: its token when the contract lists one, else the number as written. */
function tokenFor(scenario: TileScenario, value: number): string {
  const at = scenario.values.indexOf(value);
  return at >= 0 && scenario.tokens?.[at] !== undefined ? scenario.tokens[at] : String(value);
}

/** The tile URL for one value: `template` with every `{value}` filled. */
export function scenarioTileUrl(scenario: TileScenario, value: number): string {
  return scenario.template.replace(/\{value\}/g, tokenFor(scenario, value));
}

/** The listed value nearest to `value` (the lower one on a tie); undefined when the list is empty or `value` is not a number. */
export function snapScenarioValue(scenario: TileScenario, value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  let best: number | undefined;
  for (const v of scenario.values) {
    if (best === undefined || Math.abs(v - value) < Math.abs(best - value)) best = v;
  }
  return best;
}

/** The value a tiles result was loaded at (its URL read against the template), or undefined when none matches. */
export function loadedScenarioValue(result: LayerResult): number | undefined {
  if (result.kind !== "tiles" || !result.data.scenario) return undefined;
  const scenario = result.data.scenario;
  return scenario.values.find((v) => scenarioTileUrl(scenario, v) === result.data.url);
}

/** The value a scenario layer shows now: the scrubber's (`MapState.scenario`) when it is on this layer, else the loaded one. */
export function currentScenarioValue(state: Pick<MapState, "scenario" | "layers">, layerId: string): number | undefined {
  const layer = state.layers[layerId];
  const scenario = scenarioOf(layer);
  if (!layer || !scenario) return undefined;
  if (state.scenario?.layerId === layerId && scenario.values.includes(state.scenario.value)) return state.scenario.value;
  return loadedScenarioValue(layer.result) ?? scenario.values[0];
}

/** A number in short text: at most `digits` decimals, no trailing zeros ("0.9", "3", "120"). */
function short(n: number, digits: number): string {
  const text = n.toFixed(digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** One value with its unit, as the slider's readout and the compare sides say it: "3 ft", "0.5 ft", "1.2 m". */
export function scenarioValueText(value: number, unit: string): string {
  return `${short(value, 2)} ${unit}`;
}

const M_PER_FT = 0.3048;
const M_PER_IN = 0.0254;

/**
 * The scrubber's readout: the value in its own unit, then the other two of feet, metres and inches ("3 ft · 0.9 m ·
 * 36 in", "1 m · 3.3 ft · 39 in", "36 in · 3 ft · 0.9 m"). Metres and feet to one decimal, inches whole. Any other
 * unit reads as the value alone.
 */
export function scenarioReadout(value: number, unit: string): string {
  const own = scenarioValueText(value, unit);
  const metres = unit === "ft" ? value * M_PER_FT : unit === "m" ? value : unit === "in" ? value * M_PER_IN : undefined;
  if (metres === undefined) return own;
  const parts: Record<"ft" | "m" | "in", string> = {
    ft: `${short(metres / M_PER_FT, 1)} ft`,
    m: `${short(metres, 1)} m`,
    in: `${short(metres / M_PER_IN, 0)} in`,
  };
  const others = (["ft", "m", "in"] as const).filter((u) => u !== unit).map((u) => parts[u]);
  return [own, ...others].join(" · ");
}

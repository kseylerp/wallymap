const KM_PER_MI = 1.609344;
const FT_PER_M = 3.28084;

/**
 * The same lengths and climbs in miles and feet (lengthMi, roundTripMi, inViewMi, gainFt, roundTripGainFt), so a US answer
 * quotes them as they are instead of converting (Bend's hikes were read out in km and m). Mutates; returns the properties.
 */
export function addUsUnits(p: Record<string, unknown>): Record<string, unknown> {
  const mi = (km: unknown) => (typeof km === "number" && Number.isFinite(km) ? Math.round((km / KM_PER_MI) * 10) / 10 : undefined);
  const ft = (m: unknown) => (typeof m === "number" && Number.isFinite(m) ? Math.round(m * FT_PER_M) : undefined);
  for (const [from, to, f] of [
    ["lengthKm", "lengthMi", mi],
    ["roundTripKm", "roundTripMi", mi],
    ["inViewKm", "inViewMi", mi],
    ["gainM", "gainFt", ft],
    ["roundTripGainM", "roundTripGainFt", ft],
  ] as const) {
    const v = f(p[from]);
    if (v !== undefined) p[to] = v;
  }
  return p;
}

/** The US-unit copies addUsUnits adds; cards hide them (the card converts the metric ones itself). */
export const US_UNIT_KEYS = ["lengthMi", "roundTripMi", "inViewMi", "gainFt", "roundTripGainFt"];

/** Round-trip numbers of a whole hike (layers/_shared/hikes.ts), shared with the terrain enrichment; no Node imports. */

/**
 * The climb of a hike's round trip from its climb and descent one way: once round a loop, up and back down for an out
 * and back or a network's longest stretch; undefined for a line that is not a hike.
 */
export function roundTripGain(shape: unknown, gain: number, loss: number): number | undefined {
  if (shape === "loop") return Math.round(Math.max(gain, loss));
  if (shape === "out-and-back" || shape === "network") return Math.round(gain + loss);
  return undefined;
}

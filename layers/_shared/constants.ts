/** Per-request cap for every upstream call a layer makes. */
export const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Whether a layer makes its secondary lookups (what a hike leads to, water by a camp, air quality beside the smoke, who
 * manages the land in view, a campground's season): always, except in unit tests, whose fetch stubs count the main calls;
 * a test that covers a lookup sets AUX_LOOKUPS=on.
 */
export function auxLookups(): boolean {
  return !process.env.VITEST || process.env.AUX_LOOKUPS === "on";
}

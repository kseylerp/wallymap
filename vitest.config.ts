import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    // Terrain enrichment (lib/terrain/enrich.ts) would fetch elevation tiles on every layer answer; its own tests turn it on.
    env: { TERRAIN_ENRICH: "off" },
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "layers/**/*.test.ts", "lib/**/*.test.ts"],
  },
});

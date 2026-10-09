import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Load .env.local into this process (and the dev server it spawns) so the smoke
// test can see whether a model key is present. Values are never printed.
function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(".env.local", "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    const [, key, raw] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "pnpm dev",
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

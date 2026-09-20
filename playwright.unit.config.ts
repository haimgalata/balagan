import { defineConfig } from "@playwright/test";

/**
 * Pure unit tests (pricing, cart storage/migration, fallback catalog) — no browser, no dev server.
 *   npm run test:unit
 * The browser suites are in playwright.config.ts (npm run test:e2e).
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*.unit.spec.ts$/,
  fullyParallel: true,
  reporter: [["list"]],
});

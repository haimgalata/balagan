import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

/**
 * Storefront regression suite (tests/step3, tests/step4): the storefront must look and behave like the
 * pre-migration baseline (tag `baseline/pre-product-management`), whether the
 * catalog comes from the bundled files ("static") or from the database ("supabase").
 *
 *   npx playwright test                       # static + supabase(stubbed RPC), desktop + mobile
 *   BASELINE_DIR=<worktree of the tag> npx playwright test visual --update-snapshots --project=baseline-desktop --project=baseline-mobile
 *                                             # (re)generate the "before" screenshots from the tag
 *
 * Both app variants are served by their own Vite dev server (ports below). The
 * "supabase" variant points at a fake host and the tests intercept its RPC in the
 * browser, so no real backend or credentials are involved. Chrome (installed) is used.
 * Screenshots are git-ignored (multi-MB) and regenerated from the tag — see tests/step3/README.md.
 */
const PORTS = { baseline: 5190, static: 5191, supabase: 5192, live: 5193 } as const;
export const STUB_SUPABASE_URL = "https://stub.supabase.test";
const STUB_KEY = "stub-anon-key";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

type Mode = keyof typeof PORTS;
const project = (mode: Mode, vp: keyof typeof VIEWPORTS) => ({
  name: `${mode}-${vp}`,
  metadata: { mode, viewport: vp },
  use: {
    baseURL: `http://localhost:${PORTS[mode]}`,
    viewport: VIEWPORTS[vp],
    channel: "chrome" as const,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    reducedMotion: "reduce" as const,
  },
});

const baselineDir = process.env.BASELINE_DIR;
// Optional: run the same suite against your REAL Supabase project (anon key only):
//   $env:LIVE_SUPABASE_URL="https://xxxx.supabase.co"; $env:LIVE_SUPABASE_ANON_KEY="..."
//   npx playwright test --project=live-desktop --project=live-mobile parity navigation visual cart
const liveUrl = (process.env.LIVE_SUPABASE_URL ?? "").trim();
const liveKey = (process.env.LIVE_SUPABASE_ANON_KEY ?? "").trim();
const withLive = !baselineDir && liveUrl !== "" && liveKey !== "";

const servers: NonNullable<PlaywrightTestConfig["webServer"]> = baselineDir
  ? [{ command: `npx vite --port ${PORTS.baseline} --strictPort`, cwd: baselineDir, url: `http://localhost:${PORTS.baseline}`, reuseExistingServer: false, timeout: 60_000 }]
  : [
      {
        command: `npx vite --port ${PORTS.static} --strictPort`,
        url: `http://localhost:${PORTS.static}`,
        env: { VITE_CATALOG_SOURCE: "static" },
        reuseExistingServer: false,
        timeout: 60_000,
      },
      {
        command: `npx vite --port ${PORTS.supabase} --strictPort`,
        url: `http://localhost:${PORTS.supabase}`,
        env: { VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: STUB_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: STUB_KEY },
        reuseExistingServer: false,
        timeout: 60_000,
      },
      ...(withLive
        ? [{
            command: `npx vite --port ${PORTS.live} --strictPort`,
            url: `http://localhost:${PORTS.live}`,
            env: { VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: liveUrl, VITE_SUPABASE_ANON_KEY: liveKey },
            reuseExistingServer: false,
            timeout: 60_000,
          }]
        : []),
    ];

export default defineConfig({
  testDir: "./tests",
  // Pure unit tests (no browser) live in *.unit.spec.ts and run via playwright.unit.config.ts.
  testIgnore: /.*.unit.spec.ts$/,
  // Same snapshot for every mode/project of a given viewport: the whole point is that they must be identical.
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/__screenshots__/{testFileName}/{arg}{ext}",
  timeout: 90_000,
  fullyParallel: true,
  workers: 2,
  reporter: [["list"]],
  // 0 differing pixels allowed; the generous timeout only covers slow machines rendering multi-MB full-page images
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixels: 0, scale: "css", timeout: 30_000 } },
  projects: baselineDir
    ? [project("baseline", "desktop"), project("baseline", "mobile")]
    : [
        project("static", "desktop"), project("static", "mobile"), project("supabase", "desktop"), project("supabase", "mobile"),
        ...(withLive ? [project("live", "desktop"), project("live", "mobile")] : []),
      ],
  webServer: servers,
});

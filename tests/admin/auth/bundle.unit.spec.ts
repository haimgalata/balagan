import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Builds the production bundle for real and checks that the private admin code (including the Supabase client)
 * is a separate, on-demand chunk — the customer never downloads it — and that the customer bundle stays lean.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/**
 * Customer entry chunk baseline, gzipped. 64,558 bytes before the admin existed (Step 4); unchanged through
 * Steps 5-7 (all admin-only growth stayed in the separate lazy chunk). 66,182 bytes after adding the cart's
 * shared-stock quantity check (src/storefront/lib/stockApi.ts + the CartContext changes it needed) — the first deliberate
 * customer-facing growth since Step 4. 67,426 bytes after Business Settings: the old static
 * businessHours.ts/deliveryInfo.ts + useBusinessStatus.ts were replaced by DB-backed
 * BusinessSettingsContext/businessSettingsApi.ts/scheduleStatus.ts + useStoreStatus/useOrderStatus (Hero,
 * BusinessInfoBar and CartDrawer now read from it) — every visitor needs this, so it stays in the customer
 * bundle, not the admin-only chunk. Allowed growth from here: 1.2 KB, for incidental future changes.
 */
const CUSTOMER_GZIP_BASELINE = 67_426;
const ALLOWED_GROWTH = 1_200;

/** Runs a real production build into a temp dir and hands the output to `check`. */
function withBuild(extraEnv: Record<string, string>, check: (outDir: string) => void) {
  const outDir = mkdtempSync(join(tmpdir(), "balagan-build-"));
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: "https://stub.supabase.test", VITE_SUPABASE_ANON_KEY: "stub-anon-key", VITE_CUSTOMER_AUTH: "", ...extraEnv },
    });
    check(outDir);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const readChunks = (outDir: string) => {
  const html = readFileSync(join(outDir, "index.html"), "utf8");
  const entryFiles = [...html.matchAll(/assets\/([^"']+\.js)/g)].map((match) => match[1]);
  const assets = readdirSync(join(outDir, "assets")).filter((name) => name.endsWith(".js"));
  const entryName = entryFiles[0];
  return {
    html,
    entryFiles,
    entry: readFileSync(join(outDir, "assets", entryName), "utf8"),
    others: assets.filter((name) => name !== entryName).map((name) => ({ name, code: readFileSync(join(outDir, "assets", name), "utf8") })),
  };
};

// Markers that exist only in the club (customer account) code: its login-session key, the member RPC names, the
// test-only mock adapter's token prefix.
const ACCOUNT_ONLY = ["balagan-customer-auth", "get_my_customer", "join_club", "customer_addresses", "mock-customer-token.", "חברי מועדון בלאגן מזמינים מהר יותר", "מחוברים כחברי מועדון בלאגן",
  // the personal area (/account)
  "set_marketing_consent", "delete_my_account", "get_my_orders", "מחיקת החשבון שלי"];

test("the club login is not in a normal build at all, and the mock login can never ship", async () => {
  test.setTimeout(240_000);
  withBuild({}, (outDir) => {
    const { entry, others } = readChunks(outDir);
    for (const marker of ACCOUNT_ONLY) {
      expect(entry.includes(marker), `customer bundle must not contain "${marker}"`).toBe(false);
      for (const chunk of others) expect(chunk.code.includes(marker), `no chunk of a normal build may contain "${marker}" (${chunk.name})`).toBe(false);
    }
  });
});

test("with a login adapter, the club code is a separate on-demand chunk — never in the customer entry", async () => {
  test.setTimeout(240_000);
  withBuild({ VITE_CUSTOMER_AUTH: "mock" }, (outDir) => {
    const { entry, others } = readChunks(outDir);
    for (const marker of [...ACCOUNT_ONLY, "auth/v1", "@supabase"]) expect(entry.includes(marker), `customer bundle must not contain "${marker}"`).toBe(false);
    const accountChunk = others.find((chunk) => chunk.code.includes("get_my_customer"));
    expect(accountChunk, "an account chunk exists").toBeDefined();
    expect(entry, "the entry reaches the account code only through a dynamic import").toMatch(/import\(["'`]\.\/AccountPanel-/);
    expect(entry, "the entry reaches the /account page only through a dynamic import").toMatch(/import\(["'`]\.\/AccountApp-/);
    expect(others.some((chunk) => chunk.code.includes("delete_my_account")), "the personal-area page is its own chunk").toBe(true);
    // and it is still free of the Supabase client: login/profile are plain fetches
    for (const chunk of others.filter((c) => c.code.includes("get_my_customer"))) expect(chunk.code.includes("signInWithPassword")).toBe(false);
    expect(gzipSync(Buffer.from(entry)).length, "the entry is no bigger than a normal build's budget").toBeLessThanOrEqual(CUSTOMER_GZIP_BASELINE + ALLOWED_GROWTH);
  });
});

test("admin code is a separate on-demand chunk; the customer bundle has none of it", async () => {
  test.setTimeout(240_000);
  const outDir = mkdtempSync(join(tmpdir(), "balagan-build-"));
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: "https://stub.supabase.test", VITE_SUPABASE_ANON_KEY: "stub-anon-key", VITE_CUSTOMER_AUTH: "" },
    });

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const entryFiles = [...html.matchAll(/assets\/([^"']+\.js)/g)].map((match) => match[1]);
    expect(entryFiles, "index.html loads exactly one script").toHaveLength(1);
    expect(html, "index.html must not preload the admin chunk").not.toMatch(/AdminApp/);

    const assets = readdirSync(join(outDir, "assets")).filter((name) => name.endsWith(".js"));
    const entryName = entryFiles[0];
    const entry = readFileSync(join(outDir, "assets", entryName), "utf8");
    const others = assets.filter((name) => name !== entryName);

    // markers that exist only in admin code
    const ADMIN_ONLY = ["balagan-admin-auth", "auth/v1", "signInWithPassword", "get_my_role", "noindex,nofollow", "כניסה לניהול", "admin_export_audience", "admin_list_customers"];
    for (const marker of ADMIN_ONLY) expect(entry.includes(marker), `customer bundle must not contain "${marker}"`).toBe(false);

    // ...and they do exist in a separate chunk that is loaded on demand
    const adminChunk = others.map((name) => readFileSync(join(outDir, "assets", name), "utf8")).find((code) => code.includes("balagan-admin-auth"));
    expect(adminChunk, "an admin chunk exists").toBeDefined();
    for (const marker of ["signInWithPassword", "get_my_role", "כניסה לניהול"]) expect(adminChunk!.includes(marker)).toBe(true);
    expect(entry, "the entry reaches the admin only through a dynamic import").toMatch(/import\(["'`]\.\/AdminApp-/);

    // customer bundle size guard
    const gzip = gzipSync(Buffer.from(entry)).length;
    expect(gzip, `customer entry chunk is ${gzip} bytes gzipped`).toBeLessThanOrEqual(CUSTOMER_GZIP_BASELINE + ALLOWED_GROWTH);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

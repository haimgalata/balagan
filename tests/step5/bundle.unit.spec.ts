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
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Customer entry chunk before the admin existed (Step 4): 64,558 bytes gzipped. Allowed growth: 1.2 KB. */
const CUSTOMER_GZIP_BEFORE_ADMIN = 64_558;
const ALLOWED_GROWTH = 1_200;

test("admin code is a separate on-demand chunk; the customer bundle has none of it", async () => {
  test.setTimeout(240_000);
  const outDir = mkdtempSync(join(tmpdir(), "balagan-build-"));
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: "https://stub.supabase.test", VITE_SUPABASE_ANON_KEY: "stub-anon-key" },
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
    const ADMIN_ONLY = ["balagan-admin-auth", "auth/v1", "signInWithPassword", "is_admin", "noindex,nofollow", "כניסה לניהול"];
    for (const marker of ADMIN_ONLY) expect(entry.includes(marker), `customer bundle must not contain "${marker}"`).toBe(false);

    // ...and they do exist in a separate chunk that is loaded on demand
    const adminChunk = others.map((name) => readFileSync(join(outDir, "assets", name), "utf8")).find((code) => code.includes("balagan-admin-auth"));
    expect(adminChunk, "an admin chunk exists").toBeDefined();
    for (const marker of ["signInWithPassword", "is_admin", "כניסה לניהול"]) expect(adminChunk!.includes(marker)).toBe(true);
    expect(entry, "the entry reaches the admin only through a dynamic import").toMatch(/import\(["'`]\.\/AdminApp-/);

    // customer bundle size guard
    const gzip = gzipSync(Buffer.from(entry)).length;
    expect(gzip, `customer entry chunk is ${gzip} bytes gzipped`).toBeLessThanOrEqual(CUSTOMER_GZIP_BEFORE_ADMIN + ALLOWED_GROWTH);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

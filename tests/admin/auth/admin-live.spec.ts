import { test, expect } from "../../catalog/fixtures";
import { ADMIN_STORAGE_KEY } from "./adminStubs";

/**
 * OPTIONAL live check of the admin login against your REAL Supabase project. You run it; the credentials are
 * read from environment variables only — never stored, never printed, never committed.
 *
 *   $env:LIVE_SUPABASE_URL="https://YOUR-PROJECT.supabase.co"; $env:LIVE_SUPABASE_ANON_KEY="<anon key>"
 *   $env:LIVE_ADMIN_EMAIL="<admin email>"; $env:LIVE_ADMIN_PASSWORD="<admin password>"
 *   $env:LIVE_USER_EMAIL="<ordinary NON-admin user>"; $env:LIVE_USER_PASSWORD="<its password>"   # optional
 *   npx playwright test admin-live --project=live-desktop
 *
 * It only reads (login, is_admin(), three head-count queries) and signs out at the end.
 */
const adminEmail = (process.env.LIVE_ADMIN_EMAIL ?? "").trim();
const adminPassword = process.env.LIVE_ADMIN_PASSWORD ?? "";
const userEmail = (process.env.LIVE_USER_EMAIL ?? "").trim();
const userPassword = process.env.LIVE_USER_PASSWORD ?? "";

test.beforeEach(({ mode }) => {
  test.skip(mode !== "live", "live project only (see the header of this file)");
});

test("the real admin can log in, sees real counts from the admin-only tables, and can sign out", async ({ page }) => {
  test.skip(!adminEmail || !adminPassword, "set LIVE_ADMIN_EMAIL and LIVE_ADMIN_PASSWORD");
  await page.goto("/admin");
  await page.getByLabel("אימייל").fill(adminEmail);
  await page.getByLabel("סיסמה", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "התחברות" }).click();

  await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible({ timeout: 20_000 });
  const counts = (await page.locator("dd").allInnerTexts()).map(Number);
  expect(counts).toHaveLength(3);
  expect(counts[0], "categories").toBeGreaterThanOrEqual(2);
  expect(counts[1], "subcategories").toBeGreaterThanOrEqual(32);
  expect(counts[2], "products (incl. hidden)").toBeGreaterThanOrEqual(141);
  expect(await page.evaluate((key) => localStorage.getItem(key), ADMIN_STORAGE_KEY)).not.toBeNull();

  await page.reload(); // the session survives a reload
  await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), ADMIN_STORAGE_KEY)).toBeNull();
});

test("a wrong password is refused with the generic message", async ({ page }) => {
  test.skip(!adminEmail, "set LIVE_ADMIN_EMAIL");
  await page.goto("/admin");
  await page.getByLabel("אימייל").fill(adminEmail);
  await page.getByLabel("סיסמה", { exact: true }).fill("definitely-not-the-password");
  await page.getByRole("button", { name: "התחברות" }).click();
  await expect(page.getByRole("alert")).toHaveText("האימייל או הסיסמה שגויים.", { timeout: 20_000 });
});

test("an ordinary (non-admin) account is refused and signed out", async ({ page }) => {
  test.skip(!userEmail || !userPassword, "set LIVE_USER_EMAIL and LIVE_USER_PASSWORD (a normal account that is NOT in admin_users)");
  await page.goto("/admin");
  await page.getByLabel("אימייל").fill(userEmail);
  await page.getByLabel("סיסמה", { exact: true }).fill(userPassword);
  await page.getByRole("button", { name: "התחברות" }).click();
  await expect(page.getByText("החשבון הזה אינו מורשה לניהול.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "סקירה" })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), ADMIN_STORAGE_KEY)).toBeNull();
});

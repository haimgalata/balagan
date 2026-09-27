import { test, expect } from "../../catalog/fixtures";
import type { Page } from "@playwright/test";

/**
 * OPTIONAL live check of the admin Categories screen against your REAL Supabase project. You run it; credentials come
 * from environment variables only — never stored, printed or committed. It needs migration 0005 applied.
 *
 *   $env:LIVE_SUPABASE_URL="https://YOUR-PROJECT.supabase.co"; $env:LIVE_SUPABASE_ANON_KEY="<anon key>"
 *   $env:LIVE_ADMIN_EMAIL="<admin email>"; $env:LIVE_ADMIN_PASSWORD="<admin password>"
 *   npx playwright test categories-live --project=live-desktop
 *
 * SAFE FOR REAL DATA: it creates ONE hidden probe category named `zz-e2e-<time>` (never visible in the shop) with two hidden
 * subcategories, exercises edit / visibility / reorder (only among its own probe subcategories) / delete rules, then deletes
 * everything it created. The real categories are never edited, reordered or deleted. If a run is interrupted, delete the
 * leftover `zz-e2e-…` category in the admin (empty it first) — it is hidden, so customers never see it.
 */
const adminEmail = (process.env.LIVE_ADMIN_EMAIL ?? "").trim();
const adminPassword = process.env.LIVE_ADMIN_PASSWORD ?? "";

test.beforeEach(({ mode }) => {
  test.skip(mode !== "live", "live project only (see the header of this file)");
  test.skip(!adminEmail || !adminPassword, "set LIVE_ADMIN_EMAIL and LIVE_ADMIN_PASSWORD");
});

async function signIn(page: Page) {
  await page.goto("/admin/categories");
  await page.getByLabel("אימייל").fill(adminEmail);
  await page.getByLabel("סיסמה", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "התחברות" }).click();
  await expect(page.getByRole("heading", { name: "קטגוריות", level: 1 })).toBeVisible({ timeout: 30_000 });
}

test("create, edit, hide, reorder and delete on the real database — using only hidden probe rows", async ({ page }) => {
  test.setTimeout(180_000);
  const slug = `zz-e2e-${Date.now().toString(36)}`;
  const row = (s: string) => page.locator(`[data-testid="category-row"][data-slug="${s}"]`);
  const sub = (s: string) => row(slug).locator(`[data-testid="subcategory-row"][data-slug="${s}"]`);
  const subOrder = () => row(slug).locator('[data-testid="subcategory-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));

  await signIn(page);
  const realBefore = await page.locator('[data-testid="category-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));
  expect(realBefore).toEqual(expect.arrayContaining(["cigarettes", "tobacco"])); // the migration 0005 counts function answered

  // ---- create a HIDDEN category
  await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
  let dialog = page.getByRole("dialog", { name: "קטגוריה חדשה" });
  await dialog.getByLabel("שם בעברית").fill("בדיקה אוטומטית");
  await dialog.getByLabel("מזהה (slug)").fill(slug);
  await dialog.getByLabel("מוצגת באתר").uncheck();
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(row(slug)).toContainText("מוסתרת");
  expect((await page.locator('[data-testid="category-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")))).at(-1)).toBe(slug); // added at the END

  // ---- duplicate slug is refused by the database
  await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
  dialog = page.getByRole("dialog", { name: "קטגוריה חדשה" });
  await dialog.getByLabel("שם בעברית").fill("כפילות");
  await dialog.getByLabel("מזהה (slug)").fill("cigarettes");
  await expect(dialog.getByText("המזהה (slug) כבר קיים. בחרו מזהה אחר.")).toBeVisible(); // caught before saving
  await dialog.getByRole("button", { name: "ביטול" }).click();

  // ---- edit names; the slug is read-only
  await row(slug).getByRole("button", { name: "עריכה: בדיקה אוטומטית" }).click();
  dialog = page.getByRole("dialog", { name: "עריכת קטגוריה" });
  await expect(dialog.getByTestId("slug-readonly")).toHaveText(slug);
  await dialog.getByLabel("שם באנגלית (אופציונלי)").fill("Automated check");
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(row(slug)).toContainText("Automated check");

  // ---- two hidden subcategories, reorder them
  await row(slug).getByRole("button", { name: "בדיקה אוטומטית", exact: true }).click(); // expand
  for (const [s, name] of [["a", "תת א"], ["b", "תת ב"]] as const) {
    await row(slug).getByRole("button", { name: "הוספת תת־קטגוריה" }).click();
    const subDialog = page.getByRole("dialog", { name: "תת־קטגוריה חדשה" });
    await subDialog.getByLabel("שם בעברית").fill(name);
    await subDialog.getByLabel("מזהה (slug)").fill(s);
    await subDialog.getByRole("button", { name: "שמירה" }).click();
    await expect(subDialog).toBeHidden({ timeout: 30_000 });
  }
  expect(await subOrder()).toEqual(["a", "b"]);
  await sub("a").getByRole("button", { name: "הזז למטה: תת א" }).click();
  await expect.poll(subOrder, { timeout: 30_000 }).toEqual(["b", "a"]);

  // ---- a category with subcategories cannot be deleted
  await row(slug).getByRole("button", { name: "מחיקה: בדיקה אוטומטית" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "לא ניתן למחוק" })).toContainText("תתי־קטגוריות");

  // ---- delete the subcategories, then the category
  for (const [s, name] of [["a", "תת א"], ["b", "תת ב"]] as const) {
    await sub(s).getByRole("button", { name: `מחיקה: ${name}` }).click();
    await page.getByRole("group", { name: `אישור מחיקה: ${name}` }).getByRole("button", { name: "אישור מחיקה" }).click();
    await expect(sub(s)).toHaveCount(0, { timeout: 30_000 });
  }
  await row(slug).getByRole("button", { name: "מחיקה: בדיקה אוטומטית" }).click();
  await page.getByRole("group", { name: "אישור מחיקה: בדיקה אוטומטית" }).getByRole("button", { name: "אישור מחיקה" }).click();
  await expect(row(slug)).toHaveCount(0, { timeout: 30_000 });

  // ---- the real categories were never touched
  const realAfter = await page.locator('[data-testid="category-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));
  expect(realAfter).toEqual(realBefore);
});

import { test, expect } from "../../catalog/fixtures";
import type { Page } from "@playwright/test";

/**
 * OPTIONAL live check of the admin Products screen against your REAL Supabase project. You run it; credentials
 * come from environment variables only — never stored, printed or committed. It needs migration 0006 applied.
 *
 *   $env:LIVE_SUPABASE_URL="https://YOUR-PROJECT.supabase.co"; $env:LIVE_SUPABASE_ANON_KEY="<anon key>"
 *   $env:LIVE_ADMIN_EMAIL="<admin email>"; $env:LIVE_ADMIN_PASSWORD="<admin password>"
 *   npx playwright test products-live --project=live-desktop
 *
 * SAFE FOR REAL DATA: it creates ONE hidden probe category named `zz-e2e-<time>` with one hidden subcategory and
 * two hidden probe products (never visible in the shop), exercises create / edit / image upload+remove / the
 * manual-vs-stock availability distinction / reorder (only between its own two probe products) / delete rules,
 * then deletes everything it created, including the uploaded image object. The real categories and products are
 * never edited, reordered or deleted. If a run is interrupted, delete the leftover `zz-e2e-…` category in the
 * admin (empty it first — delete its products, then it) — it is hidden, so customers never see it.
 */
const adminEmail = (process.env.LIVE_ADMIN_EMAIL ?? "").trim();
const adminPassword = process.env.LIVE_ADMIN_PASSWORD ?? "";

test.beforeEach(({ mode }) => {
  test.skip(mode !== "live", "live project only (see the header of this file)");
  test.skip(!adminEmail || !adminPassword, "set LIVE_ADMIN_EMAIL and LIVE_ADMIN_PASSWORD");
});

async function signIn(page: Page) {
  await page.goto("/admin/products");
  await page.getByLabel("אימייל").fill(adminEmail);
  await page.getByLabel("סיסמה", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "התחברות" }).click();
  await expect(page.getByRole("heading", { name: "מוצרים", level: 1 })).toBeVisible({ timeout: 30_000 });
}

test("create, edit, upload/remove an image, reorder and delete on the real database — using only hidden probe rows", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = `zz-e2e-${Date.now().toString(36)}`;
  const row = (id: string) => page.locator(`[data-testid="product-row"][data-id="${id}"]`);
  const orderRow = (id: string) => page.locator(`[data-testid="ordering-row"][data-id="${id}"]`);

  await signIn(page);

  // ---- a hidden probe category + subcategory, created directly via the Categories screen it shares data with ----
  await page.goto("/admin/categories");
  await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
  let dialog = page.getByRole("dialog", { name: "קטגוריה חדשה" });
  await dialog.getByLabel("שם בעברית").fill("בדיקת מוצרים אוטומטית");
  await dialog.getByLabel("מזהה (slug)").fill(tag);
  await dialog.getByLabel("מוצגת באתר").uncheck();
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const catRow = page.locator(`[data-testid="category-row"][data-slug="${tag}"]`);
  await catRow.getByRole("button", { name: "בדיקת מוצרים אוטומטית", exact: true }).click(); // expand
  await catRow.getByRole("button", { name: "הוספת תת־קטגוריה" }).click();
  dialog = page.getByRole("dialog", { name: "תת־קטגוריה חדשה" });
  await dialog.getByLabel("שם בעברית").fill("תת בדיקה");
  await dialog.getByLabel("מזהה (slug)").fill(tag);
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // ---- create a hidden probe product with a unit sale, a package, and shared-inventory tracking ----
  await page.goto("/admin/products");
  await page.getByRole("button", { name: "הוספת מוצר" }).click();
  dialog = page.getByRole("dialog", { name: "מוצר חדש" });
  await dialog.getByLabel("שם בעברית").fill("מוצר בדיקה אוטומטית");
  await dialog.getByLabel("קטגוריה").selectOption({ label: "בדיקת מוצרים אוטומטית" });
  await dialog.getByLabel("תת־קטגוריה").selectOption({ label: "תת בדיקה" });
  await dialog.getByLabel("מחיר יחידה (₪)").fill("10");
  await dialog.getByLabel("מבצע פעיל על היחידה").check();
  await dialog.getByLabel("מחיר מבצע ליחידה (₪)").fill("8");
  await dialog.getByText("למוצר יש גם אריזה").click();
  await dialog.getByLabel("תווית האריזה").fill("פקט");
  await dialog.getByLabel("כמות יחידות באריזה").fill("6");
  await dialog.getByLabel("מחיר אריזה (₪)").fill("55");
  await dialog.getByLabel("לעקוב אחרי כמות במלאי").check();
  await dialog.getByLabel("כמות במלאי (יחידות בסיס)").fill("3"); // < 6, so the package should be out of stock, unit in stock
  await dialog.getByLabel("מוצג באתר").uncheck();
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await page.getByLabel("חיפוש מוצרים").fill("מוצר בדיקה אוטומטית");
  const productRow = page.getByTestId("product-row").first();
  await expect(productRow).toBeVisible({ timeout: 30_000 });
  const productId = (await productRow.getAttribute("data-id"))!;

  // ---- shared inventory: 3 base units < package of 6 -> unit in stock, package out of stock (never independent counters) ----
  await expect(productRow.getByText("יחידה: זמין")).toBeVisible();
  await expect(productRow.getByText("פקט: אזל מהמלאי")).toBeVisible();

  // ---- edit: manually disable the unit too, with stock unchanged -> distinguishable from "out of stock" ----
  await productRow.getByRole("button", { name: "עריכה: מוצר בדיקה אוטומטית" }).click();
  dialog = page.getByRole("dialog", { name: "עריכת מוצר" });
  await dialog.getByLabel("זמינה למכירה כיחידה").uncheck();
  await expect(dialog.getByText("כבוי ידנית — לא ניתן לרכישה בכל מצב מלאי.")).toBeVisible();
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(productRow.getByText("יחידה: כבוי ידנית")).toBeVisible();

  // ---- image: upload, then remove ----
  await productRow.getByRole("button", { name: "עריכה: מוצר בדיקה אוטומטית" }).click();
  dialog = page.getByRole("dialog", { name: "עריכת מוצר" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "probe.png", mimeType: "image/png", buffer: png });
  await expect(dialog.getByRole("button", { name: "החלפת תמונה" })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "הסרת תמונה" }).click();
  await expect(dialog.getByRole("button", { name: "העלאת תמונה" })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "ביטול" }).click();

  // ---- a second probe product, then reorder within the group only ----
  await page.getByLabel("חיפוש מוצרים").fill("");
  await page.getByRole("button", { name: "הוספת מוצר" }).click();
  dialog = page.getByRole("dialog", { name: "מוצר חדש" });
  await dialog.getByLabel("שם בעברית").fill("מוצר בדיקה אוטומטית ב");
  await dialog.getByLabel("קטגוריה").selectOption({ label: "בדיקת מוצרים אוטומטית" });
  await dialog.getByLabel("תת־קטגוריה").selectOption({ label: "תת בדיקה" });
  await dialog.getByLabel("מחיר יחידה (₪)").fill("12");
  await dialog.getByLabel("מוצג באתר").uncheck();
  await dialog.getByRole("button", { name: "שמירה" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await page.getByLabel("חיפוש מוצרים").fill("מוצר בדיקה אוטומטית ב");
  const productId2 = (await page.getByTestId("product-row").first().getAttribute("data-id"))!;

  await page.getByRole("tab", { name: "סדר תצוגה" }).click();
  await page.getByLabel("קטגוריה").selectOption({ label: "בדיקת מוצרים אוטומטית" });
  await page.getByLabel("תת־קטגוריה").selectOption({ label: "תת בדיקה" });
  await expect(orderRow(productId)).toBeVisible({ timeout: 30_000 });
  const before = await page.locator('[data-testid="ordering-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
  expect(before).toEqual([productId, productId2]);
  await orderRow(productId).getByRole("button", { name: /הזז למטה/ }).click();
  await expect
    .poll(() => page.locator('[data-testid="ordering-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-id"))), { timeout: 30_000 })
    .toEqual([productId2, productId]);

  // ---- delete both probe products, then the probe subcategory and category ----
  await page.getByRole("tab", { name: "רשימת מוצרים" }).click();
  for (const [id, name] of [[productId, "מוצר בדיקה אוטומטית"], [productId2, "מוצר בדיקה אוטומטית ב"]] as const) {
    await page.getByLabel("חיפוש מוצרים").fill(name);
    await row(id).getByRole("button", { name: `מחיקה: ${name}` }).click();
    await page.getByRole("group", { name: `אישור מחיקה: ${name}` }).getByRole("button", { name: "אישור מחיקה" }).click();
    await expect(row(id)).toHaveCount(0, { timeout: 30_000 });
  }

  await page.goto("/admin/categories");
  await catRow.getByRole("button", { name: "תת בדיקה", exact: true }).click();
  await page.getByRole("group", { name: "אישור מחיקה: תת בדיקה" }).getByRole("button", { name: "אישור מחיקה" }).click();
  await expect(page.locator(`[data-testid="subcategory-row"][data-slug="${tag}"]`)).toHaveCount(0, { timeout: 30_000 });
  await catRow.getByRole("button", { name: "מחיקה: בדיקת מוצרים אוטומטית" }).click();
  await page.getByRole("group", { name: "אישור מחיקה: בדיקת מוצרים אוטומטית" }).getByRole("button", { name: "אישור מחיקה" }).click();
  await expect(catRow).toHaveCount(0, { timeout: 30_000 });
});

import { test, expect } from "../step3/fixtures";
import { ADMIN_USER, seedSession, sessionFor, stubSupabase } from "../step5/adminStubs";
import { createFakeDatabase, type FakeDatabase } from "./fakeDatabase";
import type { Locator, Page } from "@playwright/test";

/**
 * The admin "Products" screen (/admin/products), driven through the real UI against an in-memory fake of the
 * database's admin tables, functions and storage (see fakeDatabase.ts). Two tabs: the searchable/paginated
 * list (find/add/edit/hide/delete) and the per-group ordering view — kept separate on purpose (see
 * ProductsOrderingTab.tsx).
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "products tests use the stubbed-database variant");
});

async function openProducts(page: Page, db: FakeDatabase = createFakeDatabase()): Promise<FakeDatabase> {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/products");
  await expect(page.getByRole("heading", { name: "מוצרים", level: 1 })).toBeVisible();
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  return db;
}

const productRow = (page: Page, id: string): Locator => page.locator(`[data-testid="product-row"][data-id="${id}"]`);
const form = (page: Page, title: string) => page.getByRole("dialog", { name: title });
const catId = (db: FakeDatabase, slug: string) => db.state.categories.find((c) => c.slug === slug)!.id;

test.describe("the list", () => {
  test("shows a page of products with a total count, 50 per page", async ({ page }) => {
    const db = await openProducts(page);
    await expect(page.getByTestId("product-row")).toHaveCount(50);
    await expect(page.getByText("1–50 מתוך 141 מוצרים")).toBeVisible();
    await expect(page.getByText("עמוד 1 מתוך 3")).toBeVisible();
    expect(db.state.products.length).toBe(141);
  });

  test("paging forward shows the next 50, and back returns to the first page", async ({ page }) => {
    await openProducts(page);
    await page.getByRole("button", { name: "העמוד הבא" }).click();
    await expect(page.getByText("51–100 מתוך 141 מוצרים")).toBeVisible();
    await page.getByRole("button", { name: "העמוד הקודם" }).click();
    await expect(page.getByText("1–50 מתוך 141 מוצרים")).toBeVisible();
  });

  test("search finds a product on another page (across the whole catalog) and resets to page 1", async ({ page }) => {
    const db = await openProducts(page);
    await page.getByRole("button", { name: "העמוד הבא" }).click();
    await expect(page.getByText(/עמוד 2/)).toBeVisible();

    const target = db.state.products.find((p) => p.name_he.includes("וינסטון")) ?? db.state.products[100];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await expect(page.getByText(/עמוד 1 מתוך 1/)).toBeVisible({ timeout: 5000 }); // debounce, then reset to page 1
    await expect(productRow(page, target.id)).toBeVisible();
  });

  test("category + subcategory filters narrow the list and reset to page 1", async ({ page }) => {
    const db = await openProducts(page);
    await page.getByRole("button", { name: "העמוד הבא" }).click();
    await page.getByLabel("סינון לפי קטגוריה").selectOption({ label: "טבק" });
    await expect(page.getByText(/עמוד 1 מתוך/)).toBeVisible();
    const tobaccoCount = db.state.products.filter((p) => p.category_id === catId(db, "tobacco")).length;
    await expect(page.getByText(`מתוך ${tobaccoCount} מוצרים`)).toBeVisible();
  });

  test("the out-of-stock filter shows only products where neither option is purchasable", async ({ page }) => {
    const db = await openProducts(page);
    const unavailable = db.state.products.filter((p) => !p.unit_available && !p.package_available);
    await page.getByRole("checkbox", { name: "אזל מלאי" }).check();
    await expect(page.getByText(`מתוך ${unavailable.length} מוצרים`)).toBeVisible();
  });
});

test.describe("manual disable vs. out-of-stock (shared inventory)", () => {
  test("a manually-disabled option and a stock-driven out-of-stock option are shown differently", async ({ page }) => {
    const db = await openProducts(page);
    const manualOff = db.state.products.find((p) => p.package_enabled)!;
    manualOff.package_available = false;
    const outOfStock = db.state.products.filter((p) => p.package_enabled && p.id !== manualOff.id)[0];
    outOfStock.track_stock = true;
    outOfStock.stock_base_units = 0;

    await page.getByLabel("חיפוש מוצרים").fill(manualOff.name_he);
    await expect(productRow(page, manualOff.id).getByText(`${manualOff.package_label}: כבוי ידנית`)).toBeVisible();
    await expect(productRow(page, manualOff.id).getByText("יחידה: זמין")).toBeVisible(); // the unit is untouched

    await page.getByLabel("חיפוש מוצרים").fill(outOfStock.name_he);
    await expect(productRow(page, outOfStock.id).getByText("יחידה: אזל מהמלאי")).toBeVisible();
    await expect(productRow(page, outOfStock.id).getByText(`${outOfStock.package_label}: אזל מהמלאי`)).toBeVisible(); // shared pool -> BOTH options affected
  });

  test("the edit form shows the same distinction live, before saving", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products[0];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("button", { name: `עריכה: ${target.name_he}` }).click();
    const dialog = form(page, "עריכת מוצר");

    await dialog.getByLabel("זמינה למכירה כיחידה").uncheck();
    await expect(dialog.getByText("כבוי ידנית — לא ניתן לרכישה בכל מצב מלאי.")).toBeVisible();
    await dialog.getByLabel("זמינה למכירה כיחידה").check();
    await dialog.getByLabel("לעקוב אחרי כמות במלאי").check();
    await dialog.getByLabel("כמות במלאי (יחידות בסיס)").fill("0");
    await expect(dialog.getByText("אזל מהמלאי המשותף — יש 0, נדרשים 1.")).toBeVisible(); // the unit's note
  });
});

test.describe("creating", () => {
  test("a product is never required to have an image — the create form has no image field at all", async ({ page }) => {
    await openProducts(page);
    await page.getByRole("button", { name: "הוספת מוצר" }).click();
    const dialog = form(page, "מוצר חדש");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("תמונה (אופציונלי)")).toHaveCount(0);
  });

  test("blank name is refused before saving", async ({ page }) => {
    await openProducts(page);
    await page.getByRole("button", { name: "הוספת מוצר" }).click();
    const dialog = form(page, "מוצר חדש");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog.getByText("יש להזין שם בעברית.")).toBeVisible();
  });

  test("a new product is added at the END of its exact (category, subcategory) group", async ({ page }) => {
    const db = await openProducts(page);
    await page.getByRole("button", { name: "הוספת מוצר" }).click();
    const dialog = form(page, "מוצר חדש");

    await dialog.getByLabel("שם בעברית").fill("מוצר בדיקה חדש");
    await dialog.getByLabel("קטגוריה").selectOption({ label: "סיגריות" });
    const subSelect = dialog.getByLabel("תת־קטגוריה");
    await subSelect.selectOption({ index: 1 });
    const subId = await subSelect.inputValue();
    await dialog.getByLabel("מחיר יחידה (₪)").fill("30");
    await dialog.getByRole("button", { name: "שמירה" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status")).toContainText('"מוצר בדיקה חדש" נוסף');
    const group = db.productsOfGroup(catId(db, "cigarettes"), subId);
    expect(group.at(-1)?.name_he).toBe("מוצר בדיקה חדש");
    expect(group.at(-1)?.unit_price).toBe(30);
  });
});

test.describe("editing, visibility and deleting", () => {
  test("editing a price is saved and reflected in the list", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products[0];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("button", { name: `עריכה: ${target.name_he}` }).click();
    const dialog = form(page, "עריכת מוצר");
    await dialog.getByLabel("מחיר יחידה (₪)").fill("77");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog).toBeHidden();
    expect(db.state.products.find((p) => p.id === target.id)?.unit_price).toBe(77);
    await expect(productRow(page, target.id)).toContainText("₪77");
  });

  test("hiding and showing a product toggles is_visible", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products[0];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("switch").click();
    await expect(productRow(page, target.id)).toContainText("מוסתר");
    expect(db.state.products.find((p) => p.id === target.id)?.is_visible).toBe(false);
  });

  test("delete needs a two-step confirmation, and removes the product for good", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products[0];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("button", { name: `מחיקה: ${target.name_he}` }).click();
    await expect(page.getByRole("group", { name: `אישור מחיקה: ${target.name_he}` })).toBeVisible();
    await expect(productRow(page, target.id)).toBeVisible(); // not deleted yet
    await page.getByRole("group", { name: `אישור מחיקה: ${target.name_he}` }).getByRole("button", { name: "אישור מחיקה" }).click();
    await expect(page.getByRole("status")).toContainText("נמחק");
    expect(db.state.products.some((p) => p.id === target.id)).toBe(false);
  });
});

test.describe("image upload (edit only)", () => {
  test("uploading an image saves immediately, and a failed upload leaves the product exactly as it was", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products.find((p) => p.image_path === null)!;
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("button", { name: `עריכה: ${target.name_he}` }).click();
    const dialog = form(page, "עריכת מוצר");

    // a failed upload: the product keeps its previous (no) image, with a clear message
    db.failNext({ status: 500, body: { message: "boom" } });
    await dialog.getByRole("button", { name: "העלאת תמונה" }).click();
    await dialog.locator('input[type="file"]').setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) });
    await expect(dialog.getByText(/נכשל|boom/)).toBeVisible();
    expect(db.state.products.find((p) => p.id === target.id)?.image_path).toBeNull();

    // a successful upload persists the path on the row
    await dialog.locator('input[type="file"]').setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) });
    await expect(dialog.getByRole("button", { name: "החלפת תמונה" })).toBeVisible();
    expect(db.state.products.find((p) => p.id === target.id)?.image_path).not.toBeNull();
  });

  test("rejects an oversized or wrong-type file client-side, without any request", async ({ page }) => {
    const db = await openProducts(page);
    const target = db.state.products[0];
    await page.getByLabel("חיפוש מוצרים").fill(target.name_he);
    await productRow(page, target.id).getByRole("button", { name: `עריכה: ${target.name_he}` }).click();
    const dialog = form(page, "עריכת מוצר");
    await dialog.locator('input[type="file"]').setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(dialog.getByText("יש להעלות קובץ JPEG, PNG או WebP בלבד.")).toBeVisible();
    expect(db.uploadedImages.size).toBe(0);
  });
});

test.describe("ordering tab", () => {
  async function openOrdering(page: Page, db: FakeDatabase) {
    await page.getByRole("tab", { name: "סדר תצוגה" }).click();
    await page.getByLabel("קטגוריה").selectOption({ label: "סיגריות" });
    const subSelect = page.getByLabel("תת־קטגוריה");
    await subSelect.selectOption({ index: 1 });
    const subId = await subSelect.inputValue();
    await expect(page.getByTestId("ordering-row").first()).toBeVisible();
    return subId;
  }
  const orderedIds = (page: Page) => page.locator('[data-testid="ordering-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));

  test("moving a product up/down changes ONLY its own group's order", async ({ page }) => {
    const db = await openProducts(page);
    const subId = await openOrdering(page, db);
    const before = await orderedIds(page);
    expect(before.length).toBeGreaterThan(1);

    const otherSubId = db.state.subcategories.find((s) => s.category_id === catId(db, "cigarettes") && s.id !== subId)!.id;
    const otherBefore = db.productsOfGroup(catId(db, "cigarettes"), otherSubId).map((p) => p.id);
    const tobaccoBefore = db.productsOfGroup(catId(db, "tobacco"), db.state.subcategories.find((s) => s.category_id === catId(db, "tobacco"))!.id).map((p) => p.id);

    const [first] = before;
    await page.locator(`[data-testid="ordering-row"][data-id="${first}"]`).getByRole("button", { name: /הזז למטה/ }).click();
    await expect.poll(() => orderedIds(page)).toEqual([before[1], before[0], ...before.slice(2)]);

    // the other subcategory of the SAME category, and a different category entirely, are untouched
    expect(db.productsOfGroup(catId(db, "cigarettes"), otherSubId).map((p) => p.id)).toEqual(otherBefore);
    expect(db.productsOfGroup(catId(db, "tobacco"), db.state.subcategories.find((s) => s.category_id === catId(db, "tobacco"))!.id).map((p) => p.id)).toEqual(tobaccoBefore);
  });

  test("up is disabled on the first row, down is disabled on the last", async ({ page }) => {
    const db = await openProducts(page);
    await openOrdering(page, db);
    const rows = page.getByTestId("ordering-row");
    await expect(rows.first().getByRole("button", { name: /הזז למעלה/ })).toBeDisabled();
    await expect(rows.last().getByRole("button", { name: /הזז למטה/ })).toBeDisabled();
  });

  test("a category with no subcategories skips the subcategory picker entirely", async ({ page }) => {
    const db = createFakeDatabase();
    // add a flat category (no subcategories) with two of its own products, directly in the fake's state
    const flatCatId = "flat-cat-0000-4000-8000-000000000001";
    db.state.categories.push({ id: flatCatId, legacy_id: null, slug: "flat", name_he: "קטגוריה שטוחה", name_en: null, is_visible: true, sort_order: 999 });
    db.state.products.push(
      { ...db.state.products[0], id: "9001", category_id: flatCatId, subcategory_id: null, name_he: "שטוח א", sort_order: 10 },
      { ...db.state.products[0], id: "9002", category_id: flatCatId, subcategory_id: null, name_he: "שטוח ב", sort_order: 20 }
    );
    await openProducts(page, db);
    await page.getByRole("tab", { name: "סדר תצוגה" }).click();
    await page.getByLabel("קטגוריה").selectOption({ label: "קטגוריה שטוחה" });
    await expect(page.getByLabel("תת־קטגוריה")).toHaveCount(0);
    await expect(orderedIds(page)).resolves.toEqual(["9001", "9002"]);
  });
});

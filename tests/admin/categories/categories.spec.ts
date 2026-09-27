import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, seedSession, sessionFor, stubSupabase } from "../auth/adminStubs";
import { createFakeDatabase, type FakeDatabase } from "./fakeDatabase";
import type { Locator, Page } from "@playwright/test";

/**
 * The admin "Categories" screen (/admin/categories), driven through the real UI against an in-memory fake of the
 * database's admin tables and functions (see fakeDatabase.ts). Tests that change something in the admin then look at
 * the real storefront, which reads its catalog from the same fake state.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "categories tests use the stubbed-database variant");
});

async function openCategories(page: Page, db: FakeDatabase = createFakeDatabase()): Promise<FakeDatabase> {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/categories");
  await expect(page.getByRole("heading", { name: "קטגוריות", level: 1 })).toBeVisible();
  await expect(page.getByTestId("category-row").first()).toBeVisible();
  return db;
}

const categoryRow = (page: Page, slug: string): Locator => page.locator(`[data-testid="category-row"][data-slug="${slug}"]`);
const subRow = (page: Page, categorySlug: string, slug: string): Locator =>
  categoryRow(page, categorySlug).locator(`[data-testid="subcategory-row"][data-slug="${slug}"]`);
const expand = async (page: Page, slug: string) => {
  const toggle = categoryRow(page, slug).getByRole("button", { expanded: false }).first();
  if (await toggle.count()) await toggle.click();
};
const orderedSlugs = (page: Page) => page.locator('[data-testid="category-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));
const subSlugs = (page: Page, categorySlug: string) =>
  categoryRow(page, categorySlug).locator('[data-testid="subcategory-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-slug")));
const form = (page: Page, title: string) => page.getByRole("dialog", { name: title });

/** Tab labels on the public storefront, e.g. ["סיגריות · 110", "טבק · 31"]. */
async function storefrontTabs(page: Page): Promise<string[]> {
  await page.goto("/");
  await page.locator("#categories").waitFor();
  return page.locator("#categories button").evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter((text) => / · \d+$/.test(text))
  );
}

test.describe("the list", () => {
  test("shows both categories with their counts, slugs and a collapsed subcategory list", async ({ page }) => {
    await openCategories(page);
    expect(await orderedSlugs(page)).toEqual(["cigarettes", "tobacco"]);

    const cigarettes = categoryRow(page, "cigarettes");
    await expect(cigarettes).toContainText("סיגריות");
    await expect(cigarettes).toContainText("110 מוצרים");
    await expect(cigarettes).toContainText("20 תתי־קטגוריות");
    await expect(categoryRow(page, "tobacco")).toContainText("31 מוצרים");
    await expect(categoryRow(page, "tobacco")).toContainText("12 תתי־קטגוריות");

    await expect(cigarettes.getByRole("button", { name: "סיגריות", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("subcategory-row")).toHaveCount(0); // collapsed
  });

  test("expanding a category shows its subcategories in storefront order with their product counts", async ({ page }) => {
    await openCategories(page);
    await expand(page, "cigarettes");
    const slugs = await subSlugs(page, "cigarettes");
    expect(slugs).toHaveLength(20);
    expect(slugs.slice(0, 4)).toEqual(["marlboro", "winston", "pall-mall", "next"]);
    await expect(subRow(page, "cigarettes", "marlboro")).toContainText("13 מוצרים"); // 16 Marlboro products: 13 cigarettes + 3 tobacco
    await expect(subRow(page, "cigarettes", "l&m")).toBeVisible(); // a slug containing "&"
    await expect(categoryRow(page, "cigarettes").getByRole("button", { name: "סיגריות", exact: true })).toHaveAttribute("aria-expanded", "true");
  });

  test("the nav link is current, and /admin/categories can be opened directly", async ({ page }) => {
    await openCategories(page);
    await expect(page.getByRole("link", { name: "קטגוריות" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "ראשי" }).click();
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "קטגוריות", level: 1 })).toBeVisible();
  });
});

test.describe("creating", () => {
  test("a new category: slug suggested from the English name, saved at the END of the list", async ({ page }) => {
    const db = await openCategories(page);
    await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
    const dialog = form(page, "קטגוריה חדשה");
    await expect(dialog).toBeVisible();

    // a blank Hebrew name is refused
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog.getByText("יש להזין שם בעברית.")).toBeVisible();

    await dialog.getByLabel("שם בעברית").fill("נרגילות");
    await dialog.getByLabel("שם באנגלית (אופציונלי)").fill("Hookah Tobacco");
    await expect(dialog.getByLabel("מזהה (slug)")).toHaveValue("hookah-tobacco"); // suggested
    await dialog.getByRole("button", { name: "שמירה" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status")).toContainText('הקטגוריה "נרגילות" נוספה');
    expect(await orderedSlugs(page)).toEqual(["cigarettes", "tobacco", "hookah-tobacco"]);
    const created = db.state.categories.find((c) => c.slug === "hookah-tobacco")!;
    expect(created).toMatchObject({ name_he: "נרגילות", name_en: "Hookah Tobacco", is_visible: true, sort_order: 30 });
    await expect(categoryRow(page, "hookah-tobacco")).toContainText("0 מוצרים");
  });

  test("the slug can be edited by hand, and then the suggestion stops overwriting it", async ({ page }) => {
    await openCategories(page);
    await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
    const dialog = form(page, "קטגוריה חדשה");
    await dialog.getByLabel("מזהה (slug)").fill("my-own");
    await dialog.getByLabel("שם באנגלית (אופציונלי)").fill("Something Else");
    await expect(dialog.getByLabel("מזהה (slug)")).toHaveValue("my-own");
  });

  test("slug validation explains each problem before saving", async ({ page }) => {
    await openCategories(page);
    await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
    const dialog = form(page, "קטגוריה חדשה");
    await dialog.getByLabel("שם בעברית").fill("בדיקה");
    const slug = dialog.getByLabel("מזהה (slug)");

    await slug.fill("has space");
    await expect(dialog.getByText(/אותיות אנגליות קטנות, ספרות/).last()).toBeVisible();
    await slug.fill("tobacco");
    await expect(dialog.getByText("המזהה (slug) כבר קיים. בחרו מזהה אחר.")).toBeVisible();
    await slug.fill("cigarettes-plus");
    await expect(dialog.getByText(/דומה מדי למזהה של קטגוריה אחרת/)).toBeVisible();
    await slug.fill("x".repeat(41));
    await expect(dialog.getByText("המזהה ארוך מדי (עד 40 תווים).")).toBeVisible();
    await slug.fill("");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog.getByText("יש להזין מזהה (slug).")).toBeVisible();
  });

  test("a duplicate created elsewhere in the meantime is caught by the database and explained", async ({ page }) => {
    const db = await openCategories(page);
    db.state.categories.push({ id: "f0000000-0000-4000-8000-000000000999", legacy_id: null, slug: "hookah", name_he: "נוצר במקום אחר", name_en: null, is_visible: true, sort_order: 30 });

    await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
    const dialog = form(page, "קטגוריה חדשה");
    await dialog.getByLabel("שם בעברית").fill("נרגילה");
    await dialog.getByLabel("מזהה (slug)").fill("hookah"); // the page does not know it exists yet
    await dialog.getByRole("button", { name: "שמירה" }).click();

    await expect(dialog.getByText("המזהה (slug) כבר קיים. בחרו מזהה אחר.")).toBeVisible();
    await expect(dialog).toBeVisible(); // stays open so the slug can be fixed
    await expect(categoryRow(page, "hookah")).toContainText("נוצר במקום אחר"); // the list was reloaded
    await dialog.getByLabel("מזהה (slug)").fill("hookah-2"); // "hookah" + dash: refused as look-alike (a link to #hookah-2 would open "hookah")
    await expect(dialog.getByText(/דומה מדי למזהה של קטגוריה אחרת/)).toBeVisible();
    await dialog.getByLabel("מזהה (slug)").fill("shisha");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog).toBeHidden();
    await expect(categoryRow(page, "shisha")).toBeVisible();
  });

  test("a new subcategory is added at the end of ITS category, and slugs only need to be unique within it", async ({ page }) => {
    const db = await openCategories(page);
    await expand(page, "tobacco");
    await categoryRow(page, "tobacco").getByRole("button", { name: "הוספת תת־קטגוריה" }).click();
    const dialog = form(page, "תת־קטגוריה חדשה");
    await expect(dialog).toContainText("בקטגוריה: טבק");

    await dialog.getByLabel("שם בעברית").fill("מרלבורו כפול");
    await dialog.getByLabel("מזהה (slug)").fill("marlboro"); // exists in tobacco already
    await expect(dialog.getByText("המזהה (slug) כבר קיים. בחרו מזהה אחר.")).toBeVisible();
    await dialog.getByLabel("מזהה (slug)").fill("hookah-mix"); // new
    await dialog.getByRole("button", { name: "שמירה" }).click();

    await expect(dialog).toBeHidden();
    const slugs = await subSlugs(page, "tobacco");
    expect(slugs.at(-1)).toBe("hookah-mix");
    expect(slugs).toHaveLength(13);
    expect(db.subcategoriesOf("tobacco").at(-1)).toMatchObject({ slug: "hookah-mix", sort_order: 130 });
  });
});

test.describe("editing", () => {
  test("names can be changed; the slug is shown read-only", async ({ page }) => {
    const db = await openCategories(page);
    await categoryRow(page, "cigarettes").getByRole("button", { name: "עריכה: סיגריות" }).click();
    const dialog = form(page, "עריכת קטגוריה");
    await expect(dialog.getByTestId("slug-readonly")).toHaveText("cigarettes");
    await expect(dialog.getByLabel("מזהה (slug)")).toHaveCount(0); // no input to change it
    await expect(dialog.getByText(/לא ניתן לשינוי אחרי היצירה/)).toBeVisible();

    await dialog.getByLabel("שם בעברית").fill("סיגריות ועוד");
    await dialog.getByLabel("שם באנגלית (אופציונלי)").fill("Cigarettes");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog).toBeHidden();
    await expect(categoryRow(page, "cigarettes")).toContainText("סיגריות ועוד");
    await expect(categoryRow(page, "cigarettes")).toContainText("Cigarettes");
    expect(db.state.categories.find((c) => c.slug === "cigarettes")).toMatchObject({ name_he: "סיגריות ועוד", name_en: "Cigarettes" });

    expect((await storefrontTabs(page))[0]).toMatch(/^סיגריות ועוד · 110$/); // the shop shows the new name
  });

  test("clearing the Hebrew name is refused", async ({ page }) => {
    await openCategories(page);
    await categoryRow(page, "tobacco").getByRole("button", { name: "עריכה: טבק" }).click();
    const dialog = form(page, "עריכת קטגוריה");
    await dialog.getByLabel("שם בעברית").fill("   ");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog.getByText("יש להזין שם בעברית.")).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test("a subcategory can be renamed", async ({ page }) => {
    const db = await openCategories(page);
    await expand(page, "cigarettes");
    await subRow(page, "cigarettes", "winston").getByRole("button", { name: "עריכה: ווינסטון" }).click();
    const dialog = form(page, "עריכת תת־קטגוריה");
    await dialog.getByLabel("שם בעברית").fill("ווינסטון קלאסי");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(subRow(page, "cigarettes", "winston")).toContainText("ווינסטון קלאסי");
    expect(db.subcategoriesOf("cigarettes").find((s) => s.slug === "winston")!.name_he).toBe("ווינסטון קלאסי");
  });
});

test.describe("visibility (and what the shop shows)", () => {
  test("hiding a category removes it from the shop; showing it brings it back", async ({ page }) => {
    await openCategories(page);
    const toggle = categoryRow(page, "cigarettes").getByRole("switch", { name: "סיגריות — מוצגת באתר" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(categoryRow(page, "cigarettes")).toContainText("מוסתרת");
    await expect(categoryRow(page, "cigarettes")).toContainText("היא והמוצרים שבה אינם מוצגים באתר");
    await expect(page.getByRole("status")).toContainText('"סיגריות" הוסתרה');

    expect(await storefrontTabs(page)).toEqual(["טבק · 31"]);
    await expect(page.locator("div.snap-start")).toHaveCount(31);

    await page.goto("/admin/categories");
    await categoryRow(page, "cigarettes").getByRole("switch", { name: "סיגריות — מוצגת באתר" }).click();
    expect(await storefrontTabs(page)).toEqual(["סיגריות · 110", "טבק · 31"]);
  });

  test("subcategories of a hidden category are marked as not shown", async ({ page }) => {
    await openCategories(page);
    await expand(page, "tobacco");
    await categoryRow(page, "tobacco").getByRole("switch", { name: "טבק — מוצגת באתר" }).click();
    await expect(subRow(page, "tobacco", "golden-virginia")).toContainText("בקטגוריה מוסתרת");
  });

  test("hiding one subcategory removes just its products from the shop", async ({ page }) => {
    await openCategories(page);
    await expand(page, "cigarettes");
    await subRow(page, "cigarettes", "marlboro").getByRole("switch", { name: "מרלבורו — מוצגת באתר" }).click();
    await expect(subRow(page, "cigarettes", "marlboro")).toContainText("מוסתרת");
    expect((await storefrontTabs(page))[0]).toBe("סיגריות · 97"); // 110 - 13 (the 3 tobacco Marlboro products are in another category)
  });
});

test.describe("ordering", () => {
  test("moving a category up reorders the list and the shop's tabs", async ({ page }) => {
    const db = await openCategories(page);
    await expect(categoryRow(page, "cigarettes").getByRole("button", { name: "הזז למעלה: סיגריות" })).toBeDisabled(); // first
    await expect(categoryRow(page, "tobacco").getByRole("button", { name: "הזז למטה: טבק" })).toBeDisabled(); // last

    await categoryRow(page, "tobacco").getByRole("button", { name: "הזז למעלה: טבק" }).click();
    await expect.poll(() => orderedSlugs(page)).toEqual(["tobacco", "cigarettes"]);
    expect(db.categoriesInOrder().map((c) => [c.slug, c.sort_order])).toEqual([["tobacco", 10], ["cigarettes", 20]]);
    await expect(page.getByRole("status")).toContainText("הסדר עודכן");

    expect(await storefrontTabs(page)).toEqual(["טבק · 31", "סיגריות · 110"]);
  });

  test("moving a subcategory changes its position among its siblings only", async ({ page }) => {
    const db = await openCategories(page);
    await expand(page, "cigarettes");
    await subRow(page, "cigarettes", "marlboro").getByRole("button", { name: "הזז למטה: מרלבורו" }).click();
    await expect.poll(async () => (await subSlugs(page, "cigarettes")).slice(0, 3)).toEqual(["winston", "marlboro", "pall-mall"]);
    expect(db.subcategoriesOf("cigarettes").slice(0, 2).map((s) => [s.slug, s.sort_order])).toEqual([["winston", 10], ["marlboro", 20]]);
    expect(db.subcategoriesOf("tobacco")[0].slug).toBe("marlboro"); // the other category is untouched
    await expect(subRow(page, "cigarettes", "winston").getByRole("button", { name: "הזז למעלה: ווינסטון" })).toBeDisabled(); // now first
  });

  test("a stale list is rejected by the database, explained, and the screen reloads", async ({ page }) => {
    const db = await openCategories(page);
    db.state.categories.push({ id: "f0000000-0000-4000-8000-000000000998", legacy_id: null, slug: "added-elsewhere", name_he: "נוסף במקום אחר", name_en: null, is_visible: true, sort_order: 30 });

    await categoryRow(page, "tobacco").getByRole("button", { name: "הזז למעלה: טבק" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "הרשימה השתנתה במקום אחר" })).toBeVisible();
    await expect(categoryRow(page, "added-elsewhere")).toBeVisible(); // reloaded
    expect(await orderedSlugs(page)).toEqual(["cigarettes", "tobacco", "added-elsewhere"]); // nothing was reordered

    await categoryRow(page, "tobacco").getByRole("button", { name: "הזז למעלה: טבק" }).click(); // works with the fresh list
    await expect.poll(() => orderedSlugs(page)).toEqual(["tobacco", "cigarettes", "added-elsewhere"]);
  });
});

test.describe("deleting", () => {
  test("a category that still holds products or subcategories cannot be deleted, and the reason is shown", async ({ page }) => {
    const db = await openCategories(page);
    await categoryRow(page, "cigarettes").getByRole("button", { name: "מחיקה: סיגריות" }).click();
    const note = page.getByRole("alert").filter({ hasText: "לא ניתן למחוק" });
    await expect(note).toContainText("יש בה 110 מוצרים");
    await expect(note).toContainText("יש בה 20 תתי־קטגוריות");
    await expect(note).toContainText("אפשר להסתיר במקום למחוק");
    await expect(page.getByRole("group", { name: /אישור מחיקה/ })).toHaveCount(0);
    expect(db.state.categories).toHaveLength(2);
  });

  test("an empty category can be deleted after a two-step confirmation (cancel keeps it)", async ({ page }) => {
    const db = await openCategories(page);
    await page.getByRole("button", { name: "הוספת קטגוריה" }).click();
    const dialog = form(page, "קטגוריה חדשה");
    await dialog.getByLabel("שם בעברית").fill("זמנית");
    await dialog.getByLabel("מזהה (slug)").fill("temp");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(categoryRow(page, "temp")).toBeVisible();

    await categoryRow(page, "temp").getByRole("button", { name: "מחיקה: זמנית" }).click();
    const confirm = page.getByRole("group", { name: "אישור מחיקה: זמנית" });
    await expect(confirm).toContainText('למחוק את "זמנית"?');
    await confirm.getByRole("button", { name: "ביטול" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(categoryRow(page, "temp")).toBeVisible();

    await categoryRow(page, "temp").getByRole("button", { name: "מחיקה: זמנית" }).click();
    await page.getByRole("group", { name: "אישור מחיקה: זמנית" }).getByRole("button", { name: "אישור מחיקה" }).click();
    await expect(categoryRow(page, "temp")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText('"זמנית" נמחקה');
    expect(db.state.categories.map((c) => c.slug)).toEqual(["cigarettes", "tobacco"]);
  });

  test("a subcategory with products is blocked; an empty one can be deleted", async ({ page }) => {
    const db = await openCategories(page);
    await expand(page, "tobacco");
    await subRow(page, "tobacco", "choice").getByRole("button", { name: "מחיקה: צ'וייס" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "לא ניתן למחוק" })).toContainText("יש בה 1 מוצר");

    await categoryRow(page, "tobacco").getByRole("button", { name: "הוספת תת־קטגוריה" }).click();
    const dialog = form(page, "תת־קטגוריה חדשה");
    await dialog.getByLabel("שם בעברית").fill("ריקה");
    await dialog.getByLabel("מזהה (slug)").fill("empty-one");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(subRow(page, "tobacco", "empty-one")).toBeVisible();
    await subRow(page, "tobacco", "empty-one").getByRole("button", { name: "מחיקה: ריקה" }).click();
    await page.getByRole("group", { name: "אישור מחיקה: ריקה" }).getByRole("button", { name: "אישור מחיקה" }).click();
    await expect(subRow(page, "tobacco", "empty-one")).toHaveCount(0);
    expect(db.subcategoriesOf("tobacco")).toHaveLength(12);
  });
});

test.describe("when things go wrong", () => {
  test("a server error on a change is explained and the list still matches the database", async ({ page }) => {
    const db = await openCategories(page);
    db.failNext({ status: 500, body: { message: "boom" } });
    await categoryRow(page, "cigarettes").getByRole("switch", { name: "סיגריות — מוצגת באתר" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "הפעולה נכשלה. נסו שוב." })).toBeVisible();
    await expect(categoryRow(page, "cigarettes").getByRole("switch")).toHaveAttribute("aria-checked", "true"); // unchanged, as stored
    // and it works on the next try
    await categoryRow(page, "cigarettes").getByRole("switch", { name: "סיגריות — מוצגת באתר" }).click();
    await expect(categoryRow(page, "cigarettes").getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  test("a dropped connection is reported as a connection problem", async ({ page }) => {
    const db = await openCategories(page);
    db.failNext("network");
    await categoryRow(page, "tobacco").getByRole("switch", { name: "טבק — מוצגת באתר" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "אין חיבור לשרת" })).toBeVisible();
  });

  test("if migration 0005 has not been applied, the screen says exactly what to do", async ({ page }) => {
    await stubSupabase(page, { extra: createFakeDatabase({ migration0005: false }).handle });
    await seedSession(page, sessionFor(ADMIN_USER));
    await page.goto("/admin/categories");
    await expect(page.getByRole("alert")).toContainText("0005_admin_categories.sql");
    await expect(page.getByRole("button", { name: "נסו שוב" })).toBeVisible();
  });

  test("if the list cannot be loaded, the screen offers a retry", async ({ page }) => {
    const db = createFakeDatabase();
    db.failAll({ status: 500 });
    await stubSupabase(page, { extra: db.handle });
    await seedSession(page, sessionFor(ADMIN_USER));
    await page.goto("/admin/categories");
    await expect(page.getByText("לא ניתן לטעון את הקטגוריות כרגע.")).toBeVisible();
    db.failAll(null); // the service recovers
    await page.getByRole("button", { name: "נסו שוב" }).click();
    await expect(categoryRow(page, "cigarettes")).toBeVisible();
  });
});

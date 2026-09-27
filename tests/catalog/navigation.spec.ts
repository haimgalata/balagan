import { test, expect, gotoReady, cartBadge, baseline } from "./fixtures";

/** Navigation, deep links, tab counts and search must behave identically for both catalog sources. */

test("deep link #tobacco-golden-virginia opens tobacco and brings the subcategory into view", async ({ page }) => {
  await gotoReady(page, "#tobacco-golden-virginia");
  await page.waitForTimeout(1200);
  await expect(page.locator("main section[id]")).toHaveAttribute("id", "tobacco");
  await expect(page.locator("#tobacco-golden-virginia")).toBeInViewport();
});

test("deep link #cigarettes-l&m (subcategory slug containing &)", async ({ page }) => {
  await gotoReady(page, "#cigarettes-l&m");
  await page.waitForTimeout(1200);
  await expect(page.locator("main section[id]")).toHaveAttribute("id", "cigarettes");
  await expect(page.locator("[id='cigarettes-l&m']")).toBeInViewport();
});

test("footer category link switches the visible category", async ({ page }) => {
  await gotoReady(page);
  await page.locator("footer").getByRole("link", { name: "טבק" }).click();
  await page.waitForTimeout(800);
  await expect(page.locator("main section[id]")).toHaveAttribute("id", "tobacco");
  await expect(page.locator("div.snap-start")).toHaveCount(31);
});

test("category tabs show the product counts", async ({ page }) => {
  await gotoReady(page);
  const tabs = page.locator("#categories");
  await expect(tabs.getByRole("button", { name: /^סיגריות/ }).first()).toContainText("110");
  await expect(tabs.getByRole("button", { name: /^טבק/ }).first()).toContainText("31");
});

test("every subcategory anchor from the baseline exists and lists its products in order", async ({ page }) => {
  await gotoReady(page);
  for (const category of baseline.categories) {
    if (category.slug !== "cigarettes") {
      await page.locator("#categories").getByRole("button", { name: new RegExp(`^${category.name}`) }).first().click();
      await page.waitForTimeout(500);
    }
    for (const sub of category.subcategories.filter((s) => s.productCount > 0)) {
      const cards = page.locator(`[id='${sub.anchorId}'] div.snap-start h3`);
      await expect(cards).toHaveCount(sub.productCount);
      const names = await cards.allInnerTexts();
      expect(names.map((n) => n.trim())).toEqual(sub.productIds.map((id) => baseline.products.find((p) => p.id === id)!.name));
    }
  }
});

test("search finds the same products as before and adds to the cart", async ({ page }) => {
  await gotoReady(page);
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await page.getByPlaceholder(/חיפוש מוצרים/).fill("מרלבורו");
  const expected = baseline.products.filter((p) => p.name.toLowerCase().includes("מרלבורו") || p.brand.toLowerCase().includes("מרלבורו"));
  const addButtons = page.getByRole("button", { name: "הוסף לסל" });
  await expect(addButtons).toHaveCount(expected.length);
  // the out-of-stock product (id 3) is listed but can't be added
  const oos = expected.filter((p) => !p.inStock).length;
  await expect(page.getByRole("button", { name: "הוסף לסל" }).and(page.locator(":disabled"))).toHaveCount(oos);

  await addButtons.first().click();
  await page.getByRole("button", { name: "סגור חיפוש" }).click();
  await expect.poll(() => cartBadge(page)).toBe("1"); // addItem confirms availability asynchronously — wait for it to settle
});

test("add a unit and a package from a card: two separate lines, badge counts purchase items", async ({ page }) => {
  await gotoReady(page);
  const card = page.locator("div.snap-start").first(); // מרלבורו אדום, unit ₪51, package פקט ₪500
  await card.getByRole("button", { name: "יחידה" }).click();
  await card.getByRole("button", { name: "פקט" }).click();
  await expect.poll(() => cartBadge(page)).toBe("2"); // 1 unit + 1 package = 2 items (not 11 units); addItem confirms availability asynchronously
  await page.getByRole("button", { name: "פתיחת סל הקניות" }).first().click();
  await page.waitForTimeout(500);
  const drawer = page.locator('[role="dialog"][aria-label="סל הקניות"]');
  await expect(drawer.locator("li")).toHaveCount(2);
  await expect(drawer).toContainText("₪551"); // ₪51 (unit) + ₪500 (package)
});

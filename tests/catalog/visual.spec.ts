import { test, expect, gotoReady, settle, cartFixtures } from "./fixtures";

/**
 * Pixel comparison against screenshots rendered from the baseline tag
 * (`BASELINE_DIR=<worktree> npx playwright test visual --update-snapshots
 *  --project=baseline-desktop --project=baseline-mobile`). 0 differing pixels allowed.
 * Names carry the viewport so desktop and mobile don't share a file.
 */
const multiCart = cartFixtures.find((f) => f.name === "multi-product")!.storageValue;

test.describe("age gate", () => {
  test.use({ ageVerified: false });
  test("01 age gate", async ({ page, vp }) => {
    await page.goto("/");
    // the gate is a translucent overlay: let the page behind it finish rendering (catalog loaded) first
    await page.locator("div.snap-start").first().waitFor({ state: "attached" });
    await settle(page);
    await expect(page).toHaveScreenshot(`${vp}-01-age-gate.png`);
  });
});

test("02/03 cigarettes: top of page and full page", async ({ page, vp }) => {
  await gotoReady(page);
  await expect(page).toHaveScreenshot(`${vp}-02-cigarettes-top.png`);
  await expect(page).toHaveScreenshot(`${vp}-03-cigarettes-full.png`, { fullPage: true });
});

test("04 tobacco full page", async ({ page, vp }) => {
  await gotoReady(page);
  await page.locator("#categories").getByRole("button", { name: /^טבק/ }).first().click();
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot(`${vp}-04-tobacco-full.png`, { fullPage: true });
});

for (const [n, hash] of [["05-deeplink-cigarettes-marlboro", "#cigarettes-marlboro"], ["06-deeplink-tobacco-golden-virginia", "#tobacco-golden-virginia"], ["07-deeplink-cigarettes-lm", "#cigarettes-l&m"]] as const) {
  test(`${n}`, async ({ page, vp }) => {
    await gotoReady(page, hash);
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot(`${vp}-${n}.png`);
  });
}

test("08 search overlay", async ({ page, vp }) => {
  await gotoReady(page);
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await page.getByPlaceholder(/חיפוש מוצרים/).fill("מרלבורו");
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot(`${vp}-08-search-overlay.png`);
});

test("09 out-of-stock card", async ({ page, vp }) => {
  await gotoReady(page);
  const card = page.locator("div.snap-start", { hasText: "מרלבורו טאץ׳" }).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await expect(card).toHaveScreenshot(`${vp}-09-out-of-stock-card.png`);
});

test.describe("saved cart", () => {
  test.use({ savedCart: multiCart });
  test("10/11 cart summary bar and cart drawer", async ({ page, vp }) => {
    await gotoReady(page);
    await expect(page).toHaveScreenshot(`${vp}-10-cart-summary-bar.png`);
    await page.getByRole("button", { name: "פתיחת סל הקניות" }).first().click();
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot(`${vp}-11-cart-drawer.png`);
  });
});

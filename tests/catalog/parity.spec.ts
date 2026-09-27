import { test, expect, gotoReady, extractDomText, domText } from "./fixtures";

/**
 * The rendered storefront text (info bar, category tabs, subcategory nav, and one line per
 * product card: brand, name, unit price, old pack prices, out-of-stock badge, button states)
 * must equal the text captured from the untouched app at Step 0 — for BOTH catalog sources.
 */
for (const category of ["cigarettes", "tobacco"] as const) {
  test(`rendered text equals the pre-migration baseline — ${category}`, async ({ page, vp }) => {
    await gotoReady(page);
    if (category === "tobacco") {
      await page.locator("#categories").getByRole("button", { name: /^טבק/ }).first().click();
      await page.waitForTimeout(600);
    }
    const actual = (await extractDomText(page)) + "\n";
    expect(actual).toBe(domText(vp, category));
  });
}

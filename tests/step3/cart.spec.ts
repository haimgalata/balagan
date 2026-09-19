import { test, expect, gotoReady, cartFixtures, cartObserved } from "./fixtures";

/**
 * Every saved-cart payload from tests/baseline/cart-legacy-fixtures.json must render EXACTLY as the
 * untouched app rendered it (tests/baseline/cart-legacy-observed.json): same drawer lines, same
 * total, same header badge, same value written back to localStorage.
 *
 * ONE intentional difference (documented in the plan): a line whose product id can't be resolved is no
 * longer erased from storage on load (the old code dropped it). It is still not rendered or priced.
 */
for (const fixture of cartFixtures) {
  test.describe(`saved cart: ${fixture.name}`, () => {
    test.use({ savedCart: fixture.storageValue });

    test("renders exactly as the pre-migration app did", async ({ page }) => {
      const expected = cartObserved.find((o) => o.name === fixture.name)!;
      await gotoReady(page);
      const storageAfterLoad = await page.evaluate(() => localStorage.getItem("balagan_cart"));

      await page.getByRole("button", { name: "פתיחת סל הקניות" }).first().click();
      await page.waitForTimeout(500);
      const observed = await page.evaluate(() => {
        const n = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
        const drawer = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "סל הקניות") as HTMLElement;
        const text = n(drawer.innerText);
        const total = /סה"כ לתשלום ₪([0-9.]+)/.exec(text);
        return {
          headerCartButtonText: n((document.querySelector('header button[aria-label="פתיחת סל הקניות"]') as HTMLElement | null)?.innerText),
          drawerLines: [...drawer.querySelectorAll("li")].map((li) => n((li as HTMLElement).innerText)),
          drawerTotal: total ? Number(total[1]) : null,
        };
      });

      expect(observed.headerCartButtonText).toBe(expected.headerCartButtonText);
      expect(observed.drawerLines).toEqual(expected.drawerLines);
      expect(observed.drawerTotal).toBe(expected.drawerTotal);

      if (fixture.name === "unknown-product-id") {
        // intentional: the unresolvable line stays in storage (structurally cleaned), just isn't shown
        expect(JSON.parse(storageAfterLoad!)).toEqual([{ productId: "9999", quantity: 2 }, { productId: "1", quantity: 1 }]);
      } else {
        expect(storageAfterLoad).toBe(expected.storageAfterLoad);
      }
    });
  });
}

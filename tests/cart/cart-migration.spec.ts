import { test, expect, gotoReady, cartFixtures, cartBadge, openCart, rowTexts, drawerTotal, readLocalStorage, LEGACY_CART_KEY, V2_CART_KEY } from "../catalog/fixtures";

/**
 * Every saved-cart payload captured from the pre-migration app (tests/baseline/cart-legacy-fixtures.json)
 * is loaded into the real app and must migrate as decided:
 *   - saved units stay UNITS (10 units are 10 units — never silently a package) and are re-priced at the
 *     unit price, so a former "10 units = ₪500" cart is now ₪510;
 *   - the old key `balagan_cart` is left byte-for-byte untouched and the cart is stored under `balagan_cart_v2`;
 *   - nothing is deleted (an id that can't be resolved stays in storage, just not shown);
 *   - a line whose option is out of stock is shown as "אזל" and left out of the count and the total;
 *   - the ancient {type:"pack"} shape keeps its pack choice as a PACKAGE line.
 * Expected figures are worked out here from the catalog prices (unit ₪51 for ids 1-2, ₪46 for id 3, ₪49 for
 * id 5, ₪121 for id 58; package "פקט" of id 1: ₪510 regular / ₪500 sale) — not copied from the app.
 */
interface Expected {
  v2: unknown[];
  badge: string; // header badge text ("" when nothing purchasable)
  total: number | null;
  rows: string[][]; // fragments each visible row must contain, in order
}
const u = (productId: string, quantity: number) => ({ productId, option: "unit", quantity });

const EXPECTED: Record<string, Expected> = {
  empty: { v2: [], badge: "", total: null, rows: [] },
  "one-unit": { v2: [u("1", 1)], badge: "1", total: 51, rows: [["1 × יחידה (₪51)", "₪51"]] },
  "nine-units": { v2: [u("1", 9)], badge: "9", total: 459, rows: [["9 × יחידה (₪51)", "₪459"]] },
  "ten-units": { v2: [u("1", 10)], badge: "10", total: 510, rows: [["10 × יחידה (₪51)", "₪510"]] }, // was ₪500 with the old auto-pack
  "twenty-three-units": { v2: [u("1", 23)], badge: "23", total: 1173, rows: [["23 × יחידה (₪51)", "₪1173"]] },
  "multi-product": {
    v2: [u("1", 12), u("2", 3), u("3", 1), u("58", 10)],
    badge: "25", // product 3 (out of stock) not counted
    total: 1975, // 612 + 153 + 1210; product 3 (₪46) excluded
    rows: [["12 × יחידה (₪51)", "₪612"], ["3 × יחידה (₪51)", "₪153"], ["אזל — לא נכלל בסכום"], ["10 × יחידה (₪121)", "₪1210"]],
  },
  "legacy-pack-shape": {
    v2: [{ productId: "1", option: "package", quantity: 2 }, u("2", 3)],
    badge: "5", // 2 packages + 3 units = 5 purchase items
    total: 1153, // 2 x ₪500 + 3 x ₪51
    rows: [["2 × פקט (₪510 ₪500)", "₪1000", "מבצע", "-₪20"], ["3 × יחידה (₪51)", "₪153"]],
  },
  "unknown-product-id": { v2: [u("9999", 2), u("1", 1)], badge: "1", total: 51, rows: [["1 × יחידה (₪51)"]] }, // 9999 kept in storage, not shown
  "bad-quantities": { v2: [u("5", 2)], badge: "2", total: 98, rows: [["2 × יחידה (₪49)", "₪98"]] },
  "duplicate-lines": { v2: [u("1", 12)], badge: "12", total: 612, rows: [["12 × יחידה (₪51)", "₪612"]] },
  "not-an-array": { v2: [], badge: "", total: null, rows: [] },
  "corrupt-json": { v2: [], badge: "", total: null, rows: [] },
};

test("expectations cover exactly the captured fixtures", () => {
  expect(cartFixtures.map((f) => f.name).sort()).toEqual(Object.keys(EXPECTED).sort());
});

for (const fixture of cartFixtures) {
  test.describe(`saved dev cart: ${fixture.name}`, () => {
    test.use({ savedCart: fixture.storageValue });

    test("migrates to explicit-option lines without deleting anything or touching the old key", async ({ page }) => {
      const expected = EXPECTED[fixture.name];
      await gotoReady(page);

      // storage: old key untouched, new key holds the migrated cart
      expect(await readLocalStorage(page, LEGACY_CART_KEY)).toBe(fixture.storageValue);
      expect(JSON.parse((await readLocalStorage(page, V2_CART_KEY))!)).toEqual(expected.v2);

      // what the customer sees
      expect(await cartBadge(page)).toBe(expected.badge);
      const drawer = await openCart(page);
      expect(await drawerTotal(drawer)).toBe(expected.total);
      const rows = await rowTexts(drawer);
      expect(rows).toHaveLength(expected.rows.length);
      expected.rows.forEach((fragments, i) => {
        for (const fragment of fragments) expect(rows[i], `row ${i + 1} should contain "${fragment}"`).toContain(fragment);
      });
    });
  });
}

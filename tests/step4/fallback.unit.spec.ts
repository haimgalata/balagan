import { test, expect } from "@playwright/test";
import { fallbackCatalog } from "../../src/data/fallbackCatalog";
import { mapCatalog } from "../../src/lib/catalogMapper";
import { parseRpcCatalog } from "../../src/lib/catalogApi";
import { getOptionPricing } from "../../src/lib/pricing";
import { baseline, buildRpcCatalog } from "../step3/fixtures";

/**
 * The offline fallback catalog is a literal snapshot in the database's own shape. It must equal what
 * the seeded database returns (built here from the frozen pre-migration baseline), and go through the
 * same mapper as live data.
 */
test.describe("fallback catalog", () => {
  test("equals the seeded database catalog (built from the frozen baseline)", () => {
    expect(fallbackCatalog).toEqual(buildRpcCatalog());
  });

  test("passes the same strict shape validation as a live response", () => {
    expect(parseRpcCatalog(JSON.parse(JSON.stringify(fallbackCatalog)))).not.toBeNull();
  });

  test("141 products, ids and render order exactly as the baseline", () => {
    const order = baseline.categories.flatMap((c) => c.subcategories.flatMap((s) => s.productIds));
    expect(fallbackCatalog.products.map((p) => p.id)).toEqual(order);
    expect(fallbackCatalog.products).toHaveLength(141);
  });

  test("mapped products carry per-option data and the package price is stored, not derived", () => {
    const { products } = mapCatalog(fallbackCatalog, "");
    const p1 = products.find((p) => p.id === "1")!;
    expect(p1.unit).toEqual({ price: 51, salePrice: null, inStock: true });
    expect(p1.package).toEqual({ label: "פקט", unitCount: 10, price: 510, salePrice: 500, inStock: true });
    expect(getOptionPricing(p1, "package")).toMatchObject({ regularCents: 51000, saleCents: 50000, onSale: true });
    // decimal-priced product: 40.9 -> package 409 / sale 399 as literal data
    const p45 = products.find((p) => p.id === "45")!;
    expect(p45.package).toMatchObject({ price: 409, salePrice: 399 });
    // out-of-stock products (3 and 9) are unavailable on both options
    for (const id of ["3", "9"]) {
      const p = products.find((x) => x.id === id)!;
      expect([p.inStock, p.unit.inStock, p.package!.inStock]).toEqual([false, false, false]);
    }
  });
});

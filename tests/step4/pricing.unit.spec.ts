import { test, expect } from "@playwright/test";
import {
  UNIT_LABEL,
  formatPrice,
  getLineBaseUnits,
  getLineTotalCents,
  getOptionBaseUnits,
  getOptionLabel,
  getOptionPricing,
  getSavingsCents,
  isOptionInStock,
  toCents,
} from "../../src/lib/pricing";
import type { Product } from "../../src/types";

/** A product as the catalog delivers it; overrides replace whole `unit` / `package` objects. */
const product = (overrides: Partial<Product> = {}): Product => ({
  id: "1",
  name: "מוצר בדיקה",
  category: "cigarettes",
  brand: "Test",
  unitPrice: 51,
  image: "/x.svg",
  inStock: true,
  unit: { price: 51, salePrice: null, inStock: true },
  package: { label: "פקט", unitCount: 10, price: 510, salePrice: 500, inStock: true },
  ...overrides,
});

test.describe("formatPrice / toCents", () => {
  test("formats agorot exactly like the site always showed prices", () => {
    expect(formatPrice(5100)).toBe("51");
    expect(formatPrice(4490)).toBe("44.9");
    expect(formatPrice(4095)).toBe("40.95");
    expect(formatPrice(40410)).toBe("404.1");
    expect(formatPrice(5)).toBe("0.05");
    expect(formatPrice(0)).toBe("0");
    expect(formatPrice(115300)).toBe("1153");
    expect(formatPrice(-1000)).toBe("-10");
  });

  test("toCents rounds away floating-point noise", () => {
    expect(toCents(44.9)).toBe(4490);
    expect(toCents(99.9)).toBe(9990);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(51)).toBe(5100);
  });

  test("no float artifacts for any decimal price x any small quantity (was: 9 x 44.9 = 404.09999999999997)", () => {
    for (const price of [40.9, 42.9, 44.9, 47.9, 99.9]) {
      for (let quantity = 1; quantity <= 60; quantity++) {
        const shown = formatPrice(toCents(price) * quantity);
        expect(shown, `${quantity} x ${price}`).toMatch(/^\d+(\.\d{1,2})?$/);
      }
    }
    expect(formatPrice(toCents(44.9) * 9)).toBe("404.1");
    expect(formatPrice(toCents(40.9) * 3)).toBe("122.7");
  });
});

test.describe("getOptionPricing", () => {
  test("unit without a sale: effective = regular", () => {
    expect(getOptionPricing(product(), "unit")).toEqual({ regularCents: 5100, saleCents: null, effectiveCents: 5100, onSale: false });
  });

  test("package with an active sale: regular kept for the strikethrough, effective = sale", () => {
    expect(getOptionPricing(product(), "package")).toEqual({ regularCents: 51000, saleCents: 50000, effectiveCents: 50000, onSale: true });
  });

  test("unit and package sales are independent", () => {
    const p = product({
      unit: { price: 51, salePrice: 45, inStock: true },
      package: { label: "מארז", unitCount: 24, price: 1000, salePrice: null, inStock: true },
    });
    expect(getOptionPricing(p, "unit")).toMatchObject({ onSale: true, effectiveCents: 4500, regularCents: 5100 });
    expect(getOptionPricing(p, "package")).toMatchObject({ onSale: false, effectiveCents: 100000 });
  });

  test("a 'sale' that is not lower than the regular price is ignored", () => {
    const p = product({ unit: { price: 51, salePrice: 51, inStock: true }, package: { label: "פקט", unitCount: 10, price: 500, salePrice: 600, inStock: true } });
    expect(getOptionPricing(p, "unit")).toMatchObject({ onSale: false, effectiveCents: 5100 });
    expect(getOptionPricing(p, "package")).toMatchObject({ onSale: false, effectiveCents: 50000 });
  });

  test("no package option => null", () => {
    expect(getOptionPricing(product({ package: null }), "package")).toBeNull();
  });

  test("the package price is independent of the unit price and unit count (no formula)", () => {
    // 10 units at 51 would be 510; a package may be priced anywhere — cheaper OR dearer per unit
    const cheaper = product({ package: { label: "קרטון", unitCount: 10, price: 400, salePrice: null, inStock: true } });
    const dearer = product({ package: { label: "קרטון", unitCount: 10, price: 900, salePrice: null, inStock: true } });
    const differentCount = product({ package: { label: "קרטון", unitCount: 24, price: 400, salePrice: null, inStock: true } });
    expect(getOptionPricing(cheaper, "package")!.effectiveCents).toBe(40000);
    expect(getOptionPricing(dearer, "package")!.effectiveCents).toBe(90000);
    expect(getOptionPricing(differentCount, "package")!.effectiveCents).toBe(40000);
  });
});

test.describe("labels and availability", () => {
  test("labels: 'יחידה' for the unit, the product's own label for the package", () => {
    expect(UNIT_LABEL).toBe("יחידה");
    expect(getOptionLabel(product(), "unit")).toBe("יחידה");
    expect(getOptionLabel(product(), "package")).toBe("פקט");
    expect(getOptionLabel(product({ package: { label: "שישייה", unitCount: 6, price: 30, salePrice: null, inStock: true } }), "package")).toBe("שישייה");
  });

  test("availability is per option", () => {
    const p = product({ unit: { price: 51, salePrice: null, inStock: false }, package: { label: "פקט", unitCount: 10, price: 510, salePrice: null, inStock: true } });
    expect(isOptionInStock(p, "unit")).toBe(false);
    expect(isOptionInStock(p, "package")).toBe(true);
    expect(isOptionInStock(product({ package: null }), "package")).toBe(false);
  });
});

test.describe("explicit choice: units never turn into a package", () => {
  test("10 single units cost 10 x the unit price, NOT the package price", () => {
    const p = product();
    const unit = getOptionPricing(p, "unit")!;
    const pkg = getOptionPricing(p, "package")!;
    expect(getLineTotalCents(unit, 10)).toBe(51000); // ₪510
    expect(getLineTotalCents(pkg, 1)).toBe(50000); // ₪500 — only when the package is chosen
    expect(getLineTotalCents(unit, 23)).toBe(117300); // ₪1173: 23 units stay 23 units
  });

  test("savings are only what the active sale takes off the regular price", () => {
    const p = product();
    expect(getSavingsCents(getOptionPricing(p, "package")!, 2)).toBe(2000); // 2 x (510 - 500)
    expect(getSavingsCents(getOptionPricing(p, "unit")!, 10)).toBe(0);
  });
});

// added for the cart shared-stock quantity check (src/lib/stockApi.ts, src/context/CartContext.tsx) — a unit
// and a package draw from the SAME base-unit pool, so quantities must convert to this common unit first.
test.describe("getOptionBaseUnits / getLineBaseUnits", () => {
  test("a unit is always 1 base unit; a package is its unit count", () => {
    const p = product();
    expect(getOptionBaseUnits(p, "unit")).toBe(1);
    expect(getOptionBaseUnits(p, "package")).toBe(10);
  });

  test("a package option on a product with no package is 0 base units, never silently 1", () => {
    expect(getOptionBaseUnits(product({ package: null }), "package")).toBe(0);
  });

  test("line totals scale with quantity", () => {
    const p = product();
    expect(getLineBaseUnits(p, "unit", 7)).toBe(7);
    expect(getLineBaseUnits(p, "package", 2)).toBe(20); // 2 packages of 10 = 20 base units
  });

  test("your example: 1 package (10) + 2 units (2) = 12; the same 12 as 12 loose units", () => {
    const p = product();
    const total = getLineBaseUnits(p, "package", 1) + getLineBaseUnits(p, "unit", 2);
    expect(total).toBe(12);
    expect(total).toBe(getLineBaseUnits(p, "unit", 12));
  });
});

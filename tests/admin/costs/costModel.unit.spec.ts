import { test, expect } from "@playwright/test";
import {
  costChange, costWithVat, formatPercent, marginPercent, marginTone, missingBarcodes, netProfit, normalizeBarcode, parseCostOverview,
  priceExVat, summarize, unitCostFromLine, type CostRow,
} from "../../../src/admin/costs/costModel";
import { describeCostsError } from "../../../src/admin/costs/costsApi";

test.describe("net profit (the example the owner agreed to)", () => {
  test("Marlboro Gold: 42 ₪ sale, 33.46 cost before VAT → cost incl. VAT 39.48, net profit 2.13 ₪ = 6%", () => {
    expect(costWithVat(33.46, 18)).toBe(39.48);
    expect(priceExVat(42, 18)).toBe(35.59);
    expect(netProfit(42, 33.46, 18)).toBe(2.13);
    expect(marginPercent(42, 33.46, 18)).toBe(6);
    expect(formatPercent(6)).toBe("6%");
  });
  test("a loss is negative, a zero price has no margin", () => {
    expect(netProfit(30, 30, 18)).toBe(-4.58);
    expect(marginPercent(30, 30, 18)).toBeLessThan(0);
    expect(marginPercent(0, 10, 18)).toBeNull();
  });
  test("VAT comes from the settings, not a constant", () => {
    expect(netProfit(42, 33.46, 17)).toBe(2.44);
  });
});

test.describe("unit cost from an invoice line", () => {
  test("Globrands carton of 10: 318.64 → 31.86 a pack", () => expect(unitCostFromLine(318.64, 0, 10)).toBe(31.86));
  test("2% line discount is taken off first: 263.46 −2% → 25.82 a pack", () => expect(unitCostFromLine(263.46, 2, 10)).toBe(25.82));
  test("Philip Morris prices per pack: 33.46 stays 33.46", () => expect(unitCostFromLine(33.46, 0, 1)).toBe(33.46));
  test("zero units is refused", () => expect(() => unitCostFromLine(10, 0, 0)).toThrow());
});

test.describe("margin colour", () => {
  test("thresholds", () => {
    expect(marginTone(null, 5)).toBe("none");
    expect(marginTone(-0.1, 5)).toBe("loss");
    expect(marginTone(0, 5)).toBe("low");
    expect(marginTone(4.9, 5)).toBe("low");
    expect(marginTone(5, 5)).toBe("good");
    expect(marginTone(6, 5)).toBe("good");
  });
});

test("cost change against the previous one", () => {
  expect(costChange(33.46, 32.9)).toBe(0.56);
  expect(costChange(32.9, 33.46)).toBe(-0.56);
  expect(costChange(33.46, 33.46)).toBeNull();
  expect(costChange(null, 1)).toBeNull();
});

test("barcode clean-up", () => {
  expect(normalizeBarcode(" 7290 0000-12345 ")).toBe("7290000012345");
  expect(normalizeBarcode("12")).toBeNull();
  expect(normalizeBarcode("12a$4")).toBeNull();
});

const row = (over: Partial<CostRow>): CostRow => ({
  id: "1", name: "מרלבורו", category: "cigarettes", subcategory: "מרלבורו", isVisible: true, salePrice: 42, hasBarcode: false, reviewNote: null,
  supplierId: "philip-morris", costExVat: 33.46, costSource: "invoice", costUpdatedAt: null, previousCostExVat: null, ...over,
});

test("counts and the shelf-by-shelf missing-barcode list (visible cigarettes only)", () => {
  const rows = [row({ id: "1" }), row({ id: "2", hasBarcode: true }), row({ id: "3", subcategory: "ווינסטון", costExVat: null }), row({ id: "4", isVisible: false }), row({ id: "5", category: "tobacco" })];
  expect(summarize(rows)).toEqual({ total: 5, withCost: 4, withBarcode: 1 });
  expect(missingBarcodes(rows)).toEqual([
    { group: "מרלבורו", names: [{ id: "1", name: "מרלבורו" }] },
    { group: "ווינסטון", names: [{ id: "3", name: "מרלבורו" }] },
  ]);
});

test("parses admin_cost_overview() (numerics may arrive as strings)", () => {
  const parsed = parseCostOverview({
    vat_percent: "18.00", low_margin_percent: 5, suppliers: [{ id: "dubek", name: "דובק" }],
    products: [{ id: "119", name: "נובלס", category: "cigarettes", subcategory: "נובלס", is_visible: true, sale_price: "38.00", has_barcode: false,
      review_note: null, supplier_id: "dubek", unit_cost_ex_vat: "29.26", cost_source: "invoice", cost_updated_at: "2026-10-18T10:00:00Z", previous_cost_ex_vat: null }],
  });
  expect(parsed?.vatPercent).toBe(18);
  expect(parsed?.rows[0]).toMatchObject({ id: "119", salePrice: 38, costExVat: 29.26, supplierId: "dubek", costSource: "invoice" });
  expect(parseCostOverview(null)).toBeNull();
  expect(parseCostOverview({ products: [{}], suppliers: [] })).toBeNull();
});

test("error mapping", () => {
  expect(describeCostsError({ code: "P0001", message: "BARCODE_BLOCKED" }).kind).toBe("blocked-barcode");
  expect(describeCostsError({ code: "23505", message: 'duplicate key value violates unique constraint "products_barcode_key"' }).kind).toBe("duplicate-barcode");
  expect(describeCostsError({ code: "42501", message: "NOT_AUTHORIZED" }).kind).toBe("permission");
  expect(describeCostsError({ code: "PGRST202", message: "Could not find the function public.admin_cost_overview" }).kind).toBe("setup-needed");
  expect(describeCostsError({ code: "", message: "Failed to fetch" }).kind).toBe("network");
});

test("shekel format: a loss reads -₪2.53", async () => {
  const { formatShekels } = await import("../../../src/admin/costs/costModel");
  expect(formatShekels(-2.53)).toBe("-₪2.53");
  expect(formatShekels(2.1)).toBe("₪2.10");
});

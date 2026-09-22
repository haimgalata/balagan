import { test, expect } from "@playwright/test";
import { approxPricePerUnit, validateProduct, type ProductDraft } from "../../src/admin/products/productValidation";
import { ERROR_MESSAGES, describeError } from "../../src/admin/products/productErrors";

const baseDraft: ProductDraft = {
  name_he: "מוצר", category_id: "cat-1", subcategory_id: "sub-1", barcode: "",
  unit_price: "10", unit_sale_enabled: false, unit_sale_price: "",
  package_enabled: false, package_label: "", package_unit_count: "", package_price: "",
  package_sale_enabled: false, package_sale_price: "",
  track_stock: false, stock_base_units: "",
};

test.describe("validateProduct", () => {
  test("a minimal valid draft (unit only, no package, no stock tracking) has no errors", () => {
    expect(validateProduct(baseDraft, { categoryHasSubcategories: true })).toEqual({});
  });

  test("blank name is refused", () => {
    expect(validateProduct({ ...baseDraft, name_he: "  " }, { categoryHasSubcategories: false })).toHaveProperty("name_he");
  });

  test("a subcategory is required only when the category has one", () => {
    expect(validateProduct({ ...baseDraft, subcategory_id: "" }, { categoryHasSubcategories: true })).toHaveProperty("subcategory_id");
    expect(validateProduct({ ...baseDraft, subcategory_id: "" }, { categoryHasSubcategories: false })).not.toHaveProperty("subcategory_id");
  });

  test("unit price must be a non-negative number", () => {
    expect(validateProduct({ ...baseDraft, unit_price: "" }, { categoryHasSubcategories: false })).toHaveProperty("unit_price");
    expect(validateProduct({ ...baseDraft, unit_price: "-1" }, { categoryHasSubcategories: false })).toHaveProperty("unit_price");
    expect(validateProduct({ ...baseDraft, unit_price: "abc" }, { categoryHasSubcategories: false })).toHaveProperty("unit_price");
    expect(validateProduct({ ...baseDraft, unit_price: "0" }, { categoryHasSubcategories: false })).not.toHaveProperty("unit_price");
  });

  test("a unit sale needs a price lower than the regular price", () => {
    const withSale = (unit_sale_price: string) =>
      validateProduct({ ...baseDraft, unit_sale_enabled: true, unit_sale_price }, { categoryHasSubcategories: false });
    expect(withSale("")).toHaveProperty("unit_sale_price");
    expect(withSale("10")).toHaveProperty("unit_sale_price"); // not LOWER than regular
    expect(withSale("11")).toHaveProperty("unit_sale_price");
    expect(withSale("9")).not.toHaveProperty("unit_sale_price");
  });

  test("package fields are required only when the package is enabled, and unit count must be > 1", () => {
    const pkg = { ...baseDraft, package_enabled: true };
    expect(validateProduct(pkg, { categoryHasSubcategories: false })).toMatchObject({ package_label: expect.any(String), package_unit_count: expect.any(String), package_price: expect.any(String) });
    expect(validateProduct({ ...pkg, package_label: "פקט", package_unit_count: "1", package_price: "50" }, { categoryHasSubcategories: false })).toHaveProperty("package_unit_count");
    expect(validateProduct({ ...pkg, package_label: "פקט", package_unit_count: "10", package_price: "50" }, { categoryHasSubcategories: false })).toEqual({});
    // disabled package: none of its fields are checked even if blank/invalid
    expect(validateProduct(baseDraft, { categoryHasSubcategories: false })).not.toHaveProperty("package_label");
  });

  test("a package sale needs a price lower than the package's regular price", () => {
    const pkg = { ...baseDraft, package_enabled: true, package_label: "פקט", package_unit_count: "10", package_price: "50", package_sale_enabled: true };
    expect(validateProduct({ ...pkg, package_sale_price: "50" }, { categoryHasSubcategories: false })).toHaveProperty("package_sale_price");
    expect(validateProduct({ ...pkg, package_sale_price: "49" }, { categoryHasSubcategories: false })).toEqual({});
  });

  test("stock quantity is required, and must be a non-negative integer, only when tracking is on", () => {
    expect(validateProduct({ ...baseDraft, track_stock: true, stock_base_units: "" }, { categoryHasSubcategories: false })).toHaveProperty("stock_base_units");
    expect(validateProduct({ ...baseDraft, track_stock: true, stock_base_units: "-1" }, { categoryHasSubcategories: false })).toHaveProperty("stock_base_units");
    expect(validateProduct({ ...baseDraft, track_stock: true, stock_base_units: "3.5" }, { categoryHasSubcategories: false })).toHaveProperty("stock_base_units");
    expect(validateProduct({ ...baseDraft, track_stock: true, stock_base_units: "0" }, { categoryHasSubcategories: false })).toEqual({});
    expect(validateProduct({ ...baseDraft, track_stock: false, stock_base_units: "" }, { categoryHasSubcategories: false })).toEqual({}); // not tracked -> ignored
  });
});

test.describe("approxPricePerUnit", () => {
  test("divides package price by unit count; null when either is missing/invalid", () => {
    expect(approxPricePerUnit("60", "10")).toBe(6);
    expect(approxPricePerUnit("", "10")).toBeNull();
    expect(approxPricePerUnit("60", "")).toBeNull();
    expect(approxPricePerUnit("60", "0")).toBeNull();
  });
});

test.describe("describeError (products)", () => {
  test("maps database errors to specific Hebrew messages", () => {
    expect(describeError({ code: "23505", message: 'duplicate key value violates unique constraint "products_barcode_key"' }).kind).toBe("duplicate-barcode");
    expect(describeError({ code: "23514", message: 'violates check constraint "products_name_he_not_blank"' }).kind).toBe("blank-name");
    expect(describeError({ code: "23514", message: 'violates check constraint "products_stock_base_units_nonneg"' }).kind).toBe("invalid-stock");
    expect(describeError({ code: "23514", message: 'violates check constraint "products_package_complete"' }).kind).toBe("invalid-package");
    expect(describeError({ code: "23514", message: 'violates check constraint "products_unit_sale_valid"' }).kind).toBe("invalid-price");
    expect(describeError({ code: "42501", message: "permission denied for table products" }).kind).toBe("permission");
    expect(describeError({ code: "P0001", message: "the list must be exactly the existing products of this category/subcategory group (reload and try again)" }).kind).toBe("stale-list");
    expect(describeError({ code: "PGRST202", message: "Could not find the function public.admin_reorder_products in the schema cache" }).kind).toBe("setup-needed");
    expect(ERROR_MESSAGES["setup-needed"]).toContain("0006_admin_products.sql");
    expect(describeError({ code: "", message: "TypeError: Failed to fetch" }).kind).toBe("network");
    expect(describeError({}).kind).toBe("unknown");
  });

  test("every kind has a non-empty Hebrew message", () => {
    for (const [kind, message] of Object.entries(ERROR_MESSAGES)) expect(message, kind).toMatch(/[֐-׿]/);
  });
});

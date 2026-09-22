/**
 * Client-side mirror of the database CHECKs on `products` (supabase/migrations/0001_schema.sql,
 * 0006_admin_products.sql) — pure, so it is unit-tested without a browser. The database is still the real
 * enforcer (see productErrors.ts for what happens if something slips past this anyway); this only gives
 * instant, specific feedback in the form instead of a round trip.
 */
export interface ProductDraft {
  name_he: string;
  category_id: string;
  /** "" means "no subcategory"; required whenever the chosen category has at least one (see categoryHasSubcategories). */
  subcategory_id: string;
  barcode: string;
  unit_price: string;
  unit_sale_enabled: boolean;
  unit_sale_price: string;
  package_enabled: boolean;
  package_label: string;
  package_unit_count: string;
  package_price: string;
  package_sale_enabled: boolean;
  package_sale_price: string;
  track_stock: boolean;
  stock_base_units: string;
}

export type ProductField =
  | "name_he" | "subcategory_id" | "barcode"
  | "unit_price" | "unit_sale_price"
  | "package_label" | "package_unit_count" | "package_price" | "package_sale_price"
  | "stock_base_units";

export interface ProductValidationContext {
  /** Does the currently-selected category have at least one subcategory? (then one must be chosen — see CategorySection.tsx) */
  categoryHasSubcategories: boolean;
}

const PACKAGE_LABEL_MAX = 30;

/** "" / whitespace-only / not-a-finite-number -> null. Mirrors how a `numeric` column reads a blank form field. */
function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
function parseCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Every problem found, keyed by field (a field with no entry is fine). Empty object => the draft can be saved.
 * Messages are ready to show next to the field.
 */
export function validateProduct(draft: ProductDraft, ctx: ProductValidationContext): Partial<Record<ProductField, string>> {
  const errors: Partial<Record<ProductField, string>> = {};

  if (draft.name_he.trim() === "") errors.name_he = "יש להזין שם בעברית.";

  if (ctx.categoryHasSubcategories && draft.subcategory_id === "") {
    errors.subcategory_id = "לקטגוריה הזו יש תתי־קטגוריות — יש לבחור אחת, אחרת המוצר לא יופיע באתר.";
  }

  const unitPrice = parseAmount(draft.unit_price);
  if (unitPrice === null || unitPrice < 0) errors.unit_price = "יש להזין מחיר יחידה תקין (0 ומעלה).";
  if (draft.unit_sale_enabled) {
    const salePrice = parseAmount(draft.unit_sale_price);
    if (salePrice === null || salePrice < 0) errors.unit_sale_price = "יש להזין מחיר מבצע תקין (0 ומעלה).";
    else if (unitPrice !== null && salePrice >= unitPrice) errors.unit_sale_price = "מחיר המבצע חייב להיות נמוך מהמחיר הרגיל.";
  }

  if (draft.package_enabled) {
    if (draft.package_label.trim() === "") errors.package_label = "יש להזין תווית לאריזה (למשל \"פקט\" או \"שישייה\").";
    else if (draft.package_label.trim().length > PACKAGE_LABEL_MAX) errors.package_label = `התווית ארוכה מדי (עד ${PACKAGE_LABEL_MAX} תווים).`;

    const count = parseCount(draft.package_unit_count);
    if (count === null || count <= 1) errors.package_unit_count = "כמות היחידות באריזה חייבת להיות מספר שלם גדול מ-1.";

    const packagePrice = parseAmount(draft.package_price);
    if (packagePrice === null || packagePrice < 0) errors.package_price = "יש להזין מחיר אריזה תקין (0 ומעלה).";
    if (draft.package_sale_enabled) {
      const packageSale = parseAmount(draft.package_sale_price);
      if (packageSale === null || packageSale < 0) errors.package_sale_price = "יש להזין מחיר מבצע תקין (0 ומעלה).";
      else if (packagePrice !== null && packageSale >= packagePrice) errors.package_sale_price = "מחיר המבצע חייב להיות נמוך ממחיר האריזה הרגיל.";
    }
  }

  if (draft.track_stock) {
    const stock = parseCount(draft.stock_base_units);
    if (stock === null) errors.stock_base_units = "יש להזין כמות מלאי תקינה (מספר שלם 0 ומעלה).";
  }

  return errors;
}

export const hasErrors = (errors: Partial<Record<ProductField, string>>): boolean => Object.keys(errors).length > 0;

/** ≈ price per base unit of the package, for the form's non-blocking hint (never sent to the server). */
export function approxPricePerUnit(packagePrice: string, packageUnitCount: string): number | null {
  const price = parseAmount(packagePrice);
  const count = parseCount(packageUnitCount);
  if (price === null || count === null || count <= 0) return null;
  return price / count;
}

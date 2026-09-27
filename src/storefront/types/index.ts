/**
 * Shared TypeScript types for the store.
 * The catalog comes from the database (see `src/storefront/lib/catalogApi.ts`); the bundled
 * fallback in `src/storefront/data/fallbackCatalog.ts` has the same shape.
 */

/** What the customer can choose to buy: a single unit, or the product's optional package. */
export type PurchaseOption = "unit" | "package";

/** One purchasable option (the unit, or the optional package). */
export interface ProductOption {
  /** Regular price. */
  price: number;
  /** Active sale price, or null when that option's sale is off. */
  salePrice: number | null;
  inStock: boolean;
}

export interface ProductPackage extends ProductOption {
  /** Custom label such as "פקט" / "מארז" / "שישייה". */
  label: string;
  /** How many units the package contains (descriptive; never used to compute a price). */
  unitCount: number;
}

export interface Product {
  id: string;
  name: string;
  /** English name. */
  nameEn?: string;
  /** The required unit option — every product has one. */
  unit: ProductOption;
  /** The optional package option, or null when the product is sold by the unit only. */
  package: ProductPackage | null;
  /** Category slug — matches a category `slug` in the catalog. */
  category: string;
  brand: string;
  /**
   * Explicit subcategory slug from the catalog. `CategorySection` groups products by it
   * (falling back to a slug derived from `brand` when it is absent).
   */
  subcategorySlug?: string;
  /** Regular price of a single unit (same as `unit.price`; kept for the storefront's existing consumers). */
  unitPrice: number;
  image: string;
  /** True when at least one option can be bought (the "אזל" badge shows when this is false). */
  inStock: boolean;
  /** Optional short description shown on product details/cards */
  description?: string;
}

export interface Subcategory {
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
}

export interface Category {
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
  subcategories: Subcategory[];
}

/**
 * A cart line is identified by product + option. `quantity` counts THAT option
 * (2 packages = quantity 2, never 20 units). The same product can appear as two
 * independent lines (units and package); nothing is ever converted between them.
 */
export interface CartItem {
  productId: string;
  option: PurchaseOption;
  quantity: number;
}

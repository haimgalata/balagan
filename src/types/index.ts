/**
 * Shared TypeScript types for the store.
 * Keep these in sync with the shapes used in `src/data/*`.
 */

/** One purchasable option (the unit, or the optional package). Read from the database catalog. */
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
  /** How many units the package contains (descriptive; not used for pricing). */
  unitCount: number;
}

export interface Product {
  id: string;
  name: string;
  /** English name (database catalog only). */
  nameEn?: string;
  /**
   * Full option data from the database catalog. Not used by the storefront UI yet
   * (it still derives pack prices from `unitPrice`, see `src/lib/pricing.ts`) —
   * present so the explicit-option cart can switch over without a data change.
   */
  unit?: ProductOption;
  package?: ProductPackage | null;
  /** Category slug — must match a `slug` in `src/data/categories.ts` */
  category: string;
  brand: string;
  /**
   * Explicit subcategory slug (see `src/data/categories.ts`). Prefer this
   * over relying on `brand`'s derived slug when a brand name doesn't
   * slugify to the same value as its subcategory (e.g. punctuation,
   * transliteration differences) — see `CategorySection`.
   */
  subcategorySlug?: string;
  /** Price of a single unit. Pack pricing is always derived from this — see `src/lib/pricing.ts`. */
  unitPrice: number;
  image: string;
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
 * `quantity` is always the TOTAL number of individual units of this product
 * in the cart — there is no separate "pack" line. Packs (and their discount)
 * are derived from this total on the fly, see `src/lib/pricing.ts`.
 */
export interface CartItem {
  productId: string;
  quantity: number;
}

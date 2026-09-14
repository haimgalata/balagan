/**
 * Shared TypeScript types for the store.
 * Keep these in sync with the shapes used in `src/data/*`.
 */

export interface Product {
  id: string;
  name: string;
  /** Category slug — must match a `slug` in `src/data/categories.ts` */
  category: string;
  brand: string;
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
  slug: string;
}

export interface Category {
  id: string;
  name: string;
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

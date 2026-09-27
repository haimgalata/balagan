import type { Category, Product } from "@/storefront/types";
import type { RpcCatalog } from "@/storefront/lib/catalogApi";

/** Same path the static catalog and `ProductCard` use for "no photo yet". */
const GENERIC_PLACEHOLDER = "/images/products/placeholder.svg";
const IMAGE_BUCKET = "product-images";

export interface MappedCatalog {
  categories: Category[];
  products: Product[];
}

/**
 * Turns the database catalog into the storefront's existing `Category[]` /
 * `Product[]` shapes, so the components render it exactly as they render the
 * static data:
 *
 *  - `name` is the Hebrew name; `brand` stays the (English) gold line on the card;
 *  - `subcategorySlug` is set explicitly from the database (CategorySection groups by it);
 *  - `unitPrice` is the unit's regular price — the storefront still derives its
 *    pack price from it (`src/lib/pricing.ts`) until the explicit-option cart lands;
 *  - `inStock` is true when at least one option can be bought (today both options
 *    share one flag, so this equals the old `inStock`);
 *  - a product without an uploaded photo keeps the shared placeholder, and
 *    `ProductCard` swaps it for the category art exactly as before.
 *
 * Order is preserved from the RPC (already category → subcategory → product order).
 */
export function mapCatalog(rpc: RpcCatalog, supabaseUrl: string): MappedCatalog {
  const imageUrl = (path: string | null): string =>
    path === null
      ? GENERIC_PLACEHOLDER
      : `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;

  const categories: Category[] = rpc.categories.map((c) => ({
    id: c.id,
    name: c.name_he,
    ...(c.name_en ? { nameEn: c.name_en } : {}),
    slug: c.slug,
    subcategories: c.subcategories.map((s) => ({
      id: s.id,
      name: s.name_he,
      ...(s.name_en ? { nameEn: s.name_en } : {}),
      slug: s.slug,
    })),
  }));

  const products: Product[] = rpc.products.map((p) => ({
    id: p.id,
    name: p.name_he,
    ...(p.name_en ? { nameEn: p.name_en } : {}),
    category: p.category,
    brand: p.brand ?? "",
    ...(p.subcategory ? { subcategorySlug: p.subcategory } : {}),
    unitPrice: p.unit.price,
    image: imageUrl(p.image_path),
    inStock: p.unit.in_stock || (p.package?.in_stock ?? false),
    ...(p.description ? { description: p.description } : {}),
    unit: { price: p.unit.price, salePrice: p.unit.sale_price, inStock: p.unit.in_stock },
    package: p.package
      ? {
          label: p.package.label,
          unitCount: p.package.unit_count,
          price: p.package.price,
          salePrice: p.package.sale_price,
          inStock: p.package.in_stock,
        }
      : null,
  }));

  return { categories, products };
}

import { PackageSearch } from "lucide-react";
import type { Category, Product } from "@/storefront/types";
import { useCatalog } from "@/storefront/context/CatalogContext";
import { ProductSlider } from "@/storefront/components/ProductSlider";

interface CategorySectionProps {
  category: Category;
}

function subcategorySlugOf(product: Product): string {
  return product.subcategorySlug ?? product.brand.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Renders one category's products on the homepage, grouped by brand
 * (subcategory) when subcategories exist. Anchored with the same ids
 * the header navigation links to (`#slug`, `#slug-subSlug`).
 *
 * `scroll-mt-[160px]` is a generous upper bound for the sticky stack these
 * anchors can land under — `BusinessInfoBar` (h-9/36px) + `CategoryBrowser`'s
 * nav bar at its tallest, tabs row expanded (see that file) — so a jump
 * never ends up hidden underneath it. When the tabs row happens to be
 * collapsed (scrolling down) the stack is shorter, so this just means a bit
 * of extra breathing room above the target rather than a flush fit.
 */
export function CategorySection({ category }: CategorySectionProps) {
  const { getProductsByCategory } = useCatalog();
  const allProducts = getProductsByCategory(category.slug);

  if (import.meta.env.DEV && category.subcategories.length > 0) {
    const knownSlugs = new Set(category.subcategories.map((sub) => sub.slug));
    for (const product of allProducts) {
      if (!knownSlugs.has(subcategorySlugOf(product))) {
        console.warn(
          `[CategorySection] "${product.name}" (id ${product.id}, brand "${product.brand}") doesn't ` +
            `match any subcategory in "${category.name}" — it won't appear in the browse UI. Set an ` +
            `explicit subcategorySlug on the product or add a matching subcategory.`
        );
      }
    }
  }

  if (allProducts.length === 0) {
    return (
      <section id={category.slug} className="scroll-mt-[160px] py-5 sm:py-7">
        <h2 className="mb-3 text-lg font-bold text-brand-text sm:text-xl">{category.name}</h2>
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-brand-border py-12 text-center text-brand-text-muted">
          <PackageSearch size={32} aria-hidden="true" />
          <p>בקרוב מוצרים נוספים בקטגוריה זו</p>
        </div>
      </section>
    );
  }

  return (
    <section id={category.slug} className="scroll-mt-[160px] py-5 sm:py-7">
      <h2 className="mb-3 text-lg font-bold text-brand-text sm:text-xl">{category.name}</h2>

      {category.subcategories.length === 0 ? (
        <ProductSlider products={allProducts} label={category.name} />
      ) : (
        <div className="flex flex-col gap-5">
          {category.subcategories.map((sub) => {
            const subProducts = allProducts.filter((product) => subcategorySlugOf(product) === sub.slug);
            if (subProducts.length === 0) return null;

            return (
              <div key={sub.id} id={`${category.slug}-${sub.slug}`} className="scroll-mt-[160px]">
                <h3 className="mb-2 text-sm font-semibold text-brand-gold">{sub.name}</h3>
                <ProductSlider products={subProducts} label={sub.name} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

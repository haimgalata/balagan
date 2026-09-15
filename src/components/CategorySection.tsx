import type { Category } from "@/types";
import { getProductsByCategory } from "@/data/products";
import { ProductSlider } from "@/components/ProductSlider";

interface CategorySectionProps {
  category: Category;
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
  const allProducts = getProductsByCategory(category.slug);

  return (
    <section id={category.slug} className="scroll-mt-[160px] py-5 sm:py-7">
      <h2 className="mb-3 text-lg font-bold text-brand-text sm:text-xl">{category.name}</h2>

      {category.subcategories.length === 0 ? (
        <ProductSlider products={allProducts} />
      ) : (
        <div className="flex flex-col gap-5">
          {category.subcategories.map((sub) => {
            const subProducts = allProducts.filter(
              (product) => product.brand.toLowerCase().replace(/\s+/g, "-") === sub.slug
            );
            if (subProducts.length === 0) return null;

            return (
              <div key={sub.id} id={`${category.slug}-${sub.slug}`} className="scroll-mt-[160px]">
                <h3 className="mb-2 text-sm font-semibold text-brand-gold">{sub.name}</h3>
                <ProductSlider products={subProducts} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

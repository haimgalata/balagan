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
 */
export function CategorySection({ category }: CategorySectionProps) {
  const allProducts = getProductsByCategory(category.slug);

  return (
    <section id={category.slug} className="scroll-mt-16 py-5 sm:py-7">
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
              <div key={sub.id} id={`${category.slug}-${sub.slug}`} className="scroll-mt-16">
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

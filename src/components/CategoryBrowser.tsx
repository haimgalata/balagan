import { useState } from "react";
import { categories } from "@/data/categories";
import { CategoryCard } from "@/components/CategoryCard";
import { SubcategoryNav } from "@/components/SubcategoryNav";
import { CategorySection } from "@/components/CategorySection";
import { useScrollDirection } from "@/hooks/useScrollDirection";

/**
 * Owns which main category (סיגריות / טבק) is active, and renders:
 *
 *  1. A sticky nav bar (`top-9`, matching `BusinessInfoBar`'s `h-9` exactly
 *     so it tucks in directly beneath it with no gap and no overlap — see
 *     that file) containing two rows:
 *       - the main-category tabs, which collapse (an animated `max-height`,
 *         so the subcategory row below reclaims the space) while scrolling
 *         down and reappear while scrolling up — `useScrollDirection` is
 *         the same hide-on-down/show-on-up pattern `Header` used to use
 *         before it became plain, non-sticky content;
 *       - the subcategory quick-nav, which — unlike the tabs — stays
 *         visible and sticky in *both* scroll directions.
 *  2. That one category's products (`CategorySection`) below it, as
 *     ordinary (non-sticky) page content.
 *
 * Selecting a category is what decides which products are shown;
 * subcategories are navigation within that, not a separate filter.
 */
export function CategoryBrowser() {
  const [activeSlug, setActiveSlug] = useState(categories[0]?.slug);
  const activeCategory = categories.find((category) => category.slug === activeSlug);
  const tabsHidden = useScrollDirection();

  return (
    <>
      <div id="categories" className="sticky top-9 z-20 border-b border-brand-border bg-brand-bg-elevated">
        <div className="mx-auto max-w-container px-4 sm:px-6">
          <div
            className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out ${
              tabsHidden ? "max-h-0 opacity-0" : "max-h-20 opacity-100"
            }`}
          >
            <div className="no-scrollbar flex gap-2 overflow-x-auto py-2 sm:gap-3">
              {categories.map((category) => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  active={category.slug === activeSlug}
                  onSelect={() => setActiveSlug(category.slug)}
                />
              ))}
            </div>
          </div>

          {activeCategory && (
            <div className="py-1.5">
              <SubcategoryNav category={activeCategory} />
            </div>
          )}
        </div>
      </div>

      {activeCategory && (
        <div className="mx-auto max-w-container px-4 sm:px-6">
          <div className="border-t border-brand-border">
            <CategorySection category={activeCategory} />
          </div>
        </div>
      )}
    </>
  );
}

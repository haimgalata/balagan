import { useRef, useState } from "react";
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
 *
 * `sentinelRef` marks where this block naturally sits in the page flow,
 * before it goes sticky. `useScrollDirection` uses it to hold off the
 * hide-on-scroll-down/show-on-scroll-up behavior until the page has
 * actually scrolled that far — otherwise the tabs would start
 * collapsing from scroll happening in sections above (Hero /
 * `BusinessInfoBar` / `SecurePaymentBar`), before this row is even the
 * thing being scrolled past. The `36` offset matches `top-9` below (and
 * `BusinessInfoBar`'s `h-9`) — the point at which this bar's top edge
 * actually reaches the sticky `BusinessInfoBar` above it.
 */
export function CategoryBrowser() {
  const [activeSlug, setActiveSlug] = useState(categories[0]?.slug);
  const activeCategory = categories.find((category) => category.slug === activeSlug);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tabsHidden = useScrollDirection(16, { ref: sentinelRef, offset: 36 });

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" />
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

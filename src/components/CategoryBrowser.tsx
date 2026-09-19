import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Cigarette, Leaf, Loader2, Package, type LucideIcon } from "lucide-react";
import type { Category } from "@/types";
import { useCatalog } from "@/context/CatalogContext";
import { CategoryCard } from "@/components/CategoryCard";
import { CategoryOverflowMenu } from "@/components/CategoryOverflowMenu";
import { SubcategoryNav } from "@/components/SubcategoryNav";
import { CategorySection } from "@/components/CategorySection";
import { useScrollDirection } from "@/hooks/useScrollDirection";
import { useHorizontalScroll } from "@/hooks/useHorizontalScroll";

/** Semantic icon per category slug, where one genuinely fits; categories
 * without a good match (e.g. a future אביזרים) fall back to a generic
 * package icon rather than guessing. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  cigarettes: Cigarette,
  tobacco: Leaf,
};

/** Beyond this many main categories, the rest move into the "עוד
 * קטגוריות" overflow panel instead of growing the tab row indefinitely —
 * see `CategoryOverflowMenu`. */
const OVERFLOW_THRESHOLD = 7;

/** Main category whose slug matches (or prefixes, for a subcategory
 * anchor like `cigarettes-marlboro`) the given hash, if any. */
function resolveSlugFromHash(categories: Category[], hash: string): string | undefined {
  if (!hash) return undefined;
  return categories.find(
    (category) => category.slug === hash || hash.startsWith(`${category.slug}-`)
  )?.slug;
}

/**
 * Resolves the category to show on first load from `location.hash`, so a
 * shared/bookmarked link like `#tobacco` or `#cigarettes-marlboro` (a
 * subcategory anchor) lands on the right category instead of always
 * defaulting to the first one. No router — just a one-time hash read.
 */
function resolveInitialSlug(categories: Category[]): string | undefined {
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return resolveSlugFromHash(categories, hash) ?? categories[0]?.slug;
}

/**
 * The catalog is loaded from the database (see `CatalogContext`). On a
 * returning visit it is available instantly from the local cache; only a
 * first-ever visit briefly waits here. The real browser below mounts once data
 * exists, so its initial-category / deep-link logic always runs against real
 * categories (a `#cigarettes-marlboro` link still lands correctly).
 */
export function CategoryBrowser() {
  const { status } = useCatalog();

  if (status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto flex min-h-[60vh] max-w-container flex-col items-center justify-center gap-3 px-4 text-brand-text-muted sm:px-6"
      >
        <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
        <span className="text-sm">טוען מוצרים…</span>
      </div>
    );
  }

  return <CategoryBrowserContent />;
}

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
function CategoryBrowserContent() {
  const { categories, getProductsByCategory } = useCatalog();
  const [activeSlug, setActiveSlug] = useState(() => resolveInitialSlug(categories));
  const activeCategory = categories.find((category) => category.slug === activeSlug);
  // Latest categories for the hashchange listener below, without re-subscribing (and
  // re-scrolling) every time a background refresh swaps in a new catalog object.
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;

  // If a background refresh removed the category being viewed, fall back to the first one.
  useEffect(() => {
    if (categories.length > 0 && !categories.some((category) => category.slug === activeSlug)) {
      setActiveSlug(categories[0].slug);
    }
  }, [categories, activeSlug]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tabsHidden = useScrollDirection(16, { ref: sentinelRef, offset: 36 });
  const { scrollerRef, canScrollStart, canScrollEnd, scroll } = useHorizontalScroll();

  // Reacts to hash changes after mount too (not just the initial load) —
  // e.g. clicking a same-page category link in `Footer`, which only
  // changes `location.hash` and would otherwise be a no-op since this
  // component doesn't remount. Also lands on a subcategory anchor once
  // the right category (possibly just switched to) has rendered it.
  useEffect(() => {
    const applyHash = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (!hash) return;
      const slug = resolveSlugFromHash(categoriesRef.current, hash);
      if (slug) setActiveSlug(slug);
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ block: "start" });
      });
    };

    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  let visibleCategories = categories;
  let overflowCategories: typeof categories = [];
  if (categories.length > OVERFLOW_THRESHOLD) {
    visibleCategories = categories.slice(0, OVERFLOW_THRESHOLD);
    overflowCategories = categories.slice(OVERFLOW_THRESHOLD);
    // Keep the active category visible even if it would otherwise have
    // landed in the overflow panel.
    if (activeCategory && overflowCategories.some((category) => category.slug === activeSlug)) {
      const displaced = visibleCategories[visibleCategories.length - 1];
      visibleCategories = [...visibleCategories.slice(0, -1), activeCategory];
      overflowCategories = overflowCategories.map((category) =>
        category.slug === activeSlug ? displaced : category
      );
    }
  }

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
            <div className="relative">
              {canScrollStart && (
                <button
                  type="button"
                  onClick={() => scroll("prev")}
                  aria-label="הצג קטגוריות קודמות"
                  className="absolute inset-y-0 start-0 z-10 hidden items-center bg-gradient-to-l from-brand-bg-elevated via-brand-bg-elevated/90 to-transparent py-0.5 pe-6 ps-0.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold md:flex"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-border bg-brand-bg-elevated text-brand-text transition-colors hover:border-brand-gold hover:text-brand-gold">
                    <ArrowRight size={14} />
                  </span>
                </button>
              )}

              <div
                ref={scrollerRef}
                role="region"
                aria-label="קטגוריות ראשיות"
                tabIndex={0}
                className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth py-2 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold sm:gap-3"
              >
                {visibleCategories.map((category) => (
                  <CategoryCard
                    key={category.id}
                    category={category}
                    active={category.slug === activeSlug}
                    count={getProductsByCategory(category.slug).length}
                    icon={CATEGORY_ICONS[category.slug] ?? Package}
                    onSelect={() => setActiveSlug(category.slug)}
                  />
                ))}
                <CategoryOverflowMenu categories={overflowCategories} onSelect={setActiveSlug} />
              </div>

              {canScrollEnd && (
                <button
                  type="button"
                  onClick={() => scroll("next")}
                  aria-label="הצג קטגוריות נוספות"
                  className="absolute inset-y-0 end-0 z-10 hidden items-center bg-gradient-to-r from-brand-bg-elevated via-brand-bg-elevated/90 to-transparent py-0.5 pe-0.5 ps-6 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold md:flex"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-border bg-brand-bg-elevated text-brand-text transition-colors hover:border-brand-gold hover:text-brand-gold">
                    <ArrowLeft size={14} />
                  </span>
                </button>
              )}
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

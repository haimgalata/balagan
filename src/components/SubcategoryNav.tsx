import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Category } from "@/types";
import { useHorizontalScroll } from "@/hooks/useHorizontalScroll";

interface SubcategoryNavProps {
  category: Category;
}

/**
 * Horizontally scrollable brand/subcategory quick-nav for the currently
 * active main category. Purely a "scroll to that section" convenience —
 * it does not filter or hide any products (see `CategorySection`, which
 * always renders every subcategory of the active category in full).
 *
 * `snap-x snap-mandatory` + `snap-start` on each pill means any scroll —
 * touch swipe, arrow click, or wheel — always comes to rest with a pill's
 * edge flush against the row's edge, so an item never sits half-cut-off.
 *
 * Touch/swipe scrolling is native and unchanged. On top of that, desktop
 * gets: prev/next arrow buttons (shown only when there's actually more
 * content in that direction, like `ProductSlider`'s), and vertical
 * mouse-wheel/trackpad input redirected to horizontal scroll — a native
 * `wheel` listener (not React's `onWheel`, which is passive by default and
 * can't `preventDefault`) so it doesn't also scroll the page.
 *
 * Scroll math assumes the modern, spec-compliant RTL `scrollLeft` behavior
 * (0 at the start/right edge, growing negative as content scrolls toward
 * the left) — same assumption `ProductSlider` documents.
 */
export function SubcategoryNav({ category }: SubcategoryNavProps) {
  const { scrollerRef, canScrollStart, canScrollEnd, scroll } = useHorizontalScroll([category.slug]);

  if (category.subcategories.length === 0) return null;

  const scrollToSub = (subSlug: string) => {
    document
      .getElementById(`${category.slug}-${subSlug}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
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
        aria-label={`תתי-קטגוריות: ${category.name}`}
        tabIndex={0}
        className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold"
      >
        {category.subcategories.map((sub) => (
          <button
            key={sub.id}
            type="button"
            onClick={() => scrollToSub(sub.slug)}
            className="shrink-0 snap-start whitespace-nowrap rounded-full border border-brand-border px-3.5 py-2.5 text-xs text-brand-text-muted outline-none transition-colors hover:border-brand-gold hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:px-3 sm:py-1.5 sm:text-sm"
          >
            {sub.name}
          </button>
        ))}
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
  );
}

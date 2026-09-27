import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Product } from "@/storefront/types";
import { ProductCard } from "@/storefront/components/ProductCard";

interface ProductSliderProps {
  products: Product[];
  emptyMessage?: string;
  /** Accessible label for the scrollable row, e.g. a brand/category name. */
  label?: string;
}

/**
 * Horizontal product row for a brand. Scrolls natively via touch/swipe on
 * every breakpoint; the prev/next buttons (desktop only, real pointers have
 * room for them) are a convenience on top of that, not a replacement.
 *
 * `--cards`/`--gap` (set here, read by `ProductCard`'s width `calc()`)
 * control how many *whole* cards are visible per row at each breakpoint —
 * see `ProductCard` for the full explanation. `--gap` must match this row's
 * own `gap-*` classes exactly, or the math (and the "always a whole card"
 * guarantee) breaks.
 *
 * Scroll math assumes the modern, spec-compliant RTL `scrollLeft` behavior
 * (0 at the start/right edge, growing negative as content scrolls toward
 * the left) that current evergreen browsers implement.
 */
export function ProductSlider({ products, emptyMessage = "לא נמצאו מוצרים", label }: ProductSliderProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  if (products.length === 0) {
    return <p className="py-8 text-center text-brand-text-muted">{emptyMessage}</p>;
  }

  const scroll = (direction: "prev" | "next") => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.8;
    el.scrollBy({ left: direction === "next" ? -amount : amount, behavior: "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        role="region"
        aria-label={label ?? "מוצרים"}
        tabIndex={0}
        className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth pb-1 outline-none [--cards:2] [--gap:0.5rem] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold sm:gap-2.5 sm:[--cards:3] sm:[--gap:0.625rem] md:[--cards:4] lg:[--cards:5] xl:[--cards:6]"
      >
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>

      <div className="mt-1.5 hidden justify-end gap-2 lg:flex">
        <button
          type="button"
          onClick={() => scroll("prev")}
          aria-label="הצג מוצרים קודמים"
          className="rounded-full border border-brand-border p-2 text-brand-text outline-none transition-colors hover:border-brand-gold hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <ArrowRight size={18} />
        </button>
        <button
          type="button"
          onClick={() => scroll("next")}
          aria-label="הצג מוצרים נוספים"
          className="rounded-full border border-brand-border p-2 text-brand-text outline-none transition-colors hover:border-brand-gold hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <ArrowLeft size={18} />
        </button>
      </div>
    </div>
  );
}

import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Product } from "@/types";
import { ProductCard } from "@/components/ProductCard";

interface ProductSliderProps {
  products: Product[];
  emptyMessage?: string;
}

/**
 * Horizontal product row for a brand. Scrolls natively via touch/swipe on
 * every breakpoint; the prev/next buttons (desktop only, real pointers have
 * room for them) are a convenience on top of that, not a replacement.
 *
 * Scroll math assumes the modern, spec-compliant RTL `scrollLeft` behavior
 * (0 at the start/right edge, growing negative as content scrolls toward
 * the left) that current evergreen browsers implement.
 */
export function ProductSlider({ products, emptyMessage = "לא נמצאו מוצרים" }: ProductSliderProps) {
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
        className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth pb-1 sm:gap-2.5"
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
          className="rounded-full border border-brand-border p-2 text-brand-text transition-colors hover:border-brand-gold hover:text-brand-gold"
        >
          <ArrowRight size={18} />
        </button>
        <button
          type="button"
          onClick={() => scroll("next")}
          aria-label="הצג מוצרים נוספים"
          className="rounded-full border border-brand-border p-2 text-brand-text transition-colors hover:border-brand-gold hover:text-brand-gold"
        >
          <ArrowLeft size={18} />
        </button>
      </div>
    </div>
  );
}

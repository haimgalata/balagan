import { useOrderStatus } from "@/storefront/hooks/useOrderStatus";
import { formatPrice } from "@/storefront/lib/pricing";

/**
 * Thin strip rendered right after `Hero`: whether the site is taking ONLINE ORDERS right now (a separate
 * concept from the physical store's own hours — see `Hero.tsx`'s pill for that) + today's order hours +
 * minimum order + delivery fee, all from `useOrderStatus` (BusinessSettingsContext).
 *
 * `sticky top-0` — it sits in normal document flow immediately after the
 * hero, then sticks flush to the very top of the viewport once scrolled up
 * to that point (the navbar is normal, non-sticky content — see
 * `Header.tsx` — so there's nothing above this to sit below). `z-30` keeps
 * it above `CategoryBrowser`'s sticky nav bar (`z-20`), which sticks
 * directly beneath it — see that file for how the two stack without
 * overlapping.
 *
 * Its rendered height (`h-9` = 36px) feeds the sticky `top` offset in
 * `CategoryBrowser.tsx` and the `scroll-mt-*` values on the category
 * anchors in `CategorySection.tsx` — keep those in sync if this height
 * changes.
 */
export function BusinessInfoBar() {
  const { isOpen, hoursLabel, minOrderCents, deliveryFeeCents } = useOrderStatus();

  return (
    <div className="sticky top-0 z-30 border-b border-brand-border bg-brand-bg-elevated">
      <div className="mx-auto flex h-9 max-w-container items-center justify-center gap-2.5 overflow-x-auto px-4 no-scrollbar sm:gap-6 sm:px-6">
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-semibold sm:text-sm">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isOpen ? "bg-brand-success" : "bg-brand-danger"
            }`}
            aria-hidden="true"
          />
          <span className={isOpen ? "text-brand-success" : "text-brand-danger"}>
            {isOpen ? "הזמנות פתוחות" : "הזמנות סגורות"}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-brand-text-muted sm:text-sm">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-text-muted"
            aria-hidden="true"
          />

          <span>
            {hoursLabel}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-brand-text-muted sm:text-sm">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-text-muted"
            aria-hidden="true"
          />

          <span>
            <span className="sm:hidden">מינימום ₪{formatPrice(minOrderCents)}</span>
            <span className="hidden sm:inline">מינימום הזמנה ₪{formatPrice(minOrderCents)}</span>
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-brand-text-muted sm:text-sm">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-text-muted"
            aria-hidden="true"
          />

          <span>משלוח ₪{formatPrice(deliveryFeeCents)}</span>
        </span>
      </div>
    </div>
  );
}

import { useBusinessStatus } from "@/hooks/useBusinessStatus";
import { DELIVERY_FEE, MINIMUM_ORDER } from "@/data/deliveryInfo";

/**
 * Thin strip rendered right after `Hero`: live open/closed status + today's
 * hours + minimum order + delivery fee.
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
  const { isOpen, hoursLabel } = useBusinessStatus();

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
            {isOpen ? "פתוח עכשיו" : "סגור כעת"}
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
            <span className="sm:hidden">מינימום ₪{MINIMUM_ORDER}</span>
            <span className="hidden sm:inline">מינימום הזמנה ₪{MINIMUM_ORDER}</span>
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-brand-text-muted sm:text-sm">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-text-muted"
            aria-hidden="true"
          />

          <span>משלוח ₪{DELIVERY_FEE}</span>
        </span>
      </div>
    </div>
  );
}

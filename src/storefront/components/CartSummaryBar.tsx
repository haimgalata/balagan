import { ShoppingCart } from "lucide-react";
import { useCart } from "@/storefront/context/CartContext";
import { Button } from "@/shared/ui/Button";
import { formatPrice } from "@/storefront/lib/pricing";

/**
 * Compact persistent cart summary, fixed to the bottom of the viewport.
 * Reads straight from `useCart()` — no separate cart state — so it updates
 * the instant `addItem`/`increment`/`decrement`/`removeLine` change the
 * cart anywhere in the app (a product card, search results, the drawer
 * itself). "לצפייה בסל" just calls the same `openCart()` the header's cart
 * icon uses — the existing drawer/checkout flow, nothing new.
 *
 * Only rendered once there's something to summarize (`totalCount > 0`) and
 * hidden while the drawer itself is open, so it never competes with the
 * drawer's own totals/checkout button. Renders its own bottom spacer right
 * alongside itself (both conditional on the same check) so the page's real
 * content — importantly the footer — never ends up hidden underneath it.
 */
export function CartSummaryBar() {
  const { totalCount, totalPriceCents, isOpen, openCart } = useCart();

  if (totalCount === 0 || isOpen) return null;

  return (
    <>
      <div className="h-16" aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-border bg-brand-bg-elevated/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-container items-center justify-between gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={openCart}
            aria-label="פתיחת סל הקניות"
            className="flex min-w-0 items-center gap-2.5 text-start"
          >
            <span className="relative flex shrink-0 items-center justify-center rounded-full bg-brand-bg p-2 text-brand-gold">
              <ShoppingCart size={18} />
              <span className="absolute -top-1 -end-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand-gold px-1 text-[10px] font-bold text-brand-bg">
                {totalCount}
              </span>
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs text-brand-text-muted">{totalCount} פריטים בסל</span>
              <span className="truncate text-base font-bold text-brand-gold">₪{formatPrice(totalPriceCents)}</span>
            </span>
          </button>

          <Button variant="primary" size="sm" className="shrink-0" onClick={openCart}>
            לצפייה בסל
          </Button>
        </div>
      </div>
    </>
  );
}

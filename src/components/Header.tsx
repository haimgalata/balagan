import { Phone, ShoppingCart, User } from "lucide-react";
import { Search } from "@/components/Search";
import { useCart } from "@/context/CartContext";
import { useSmartHeader } from "@/hooks/useSmartHeader";

/** The store's real phone number (also used in the footer). */
const STORE_PHONE = "08-994-5190";
const STORE_PHONE_HREF = "tel:089945190";

/**
 * Site navbar — deliberately minimal: a contact icon at the RTL "start"
 * (right) edge, then search/cart/login at the "end" (left) edge. No logo,
 * no category menu, no hamburger — category navigation lives in the
 * homepage's own category buttons instead (see `CategoryCard`).
 *
 * Smart sticky behavior: hides on scroll-down, reappears on scroll-up,
 * always visible at the top of the page (see `useSmartHeader`). The
 * header is `fixed`, so `App.tsx` reserves matching space with a spacer.
 */
export function Header() {
  const { totalCount, openCart } = useCart();
  const hidden = useSmartHeader();

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 border-b border-brand-border bg-brand-bg-secondary/95 backdrop-blur transition-transform duration-300 ease-in-out ${
        hidden ? "-translate-y-full" : "translate-y-0"
      }`}
    >
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:h-14">
        <a
          href={STORE_PHONE_HREF}
          aria-label={`התקשרו אלינו: ${STORE_PHONE}`}
          className="flex shrink-0 items-center gap-1.5 rounded-md p-2 text-brand-text transition-colors hover:text-brand-gold"
        >
          <Phone size={20} />
        </a>

        <div className="flex items-center gap-1 sm:gap-2">
          <Search />

          <button
            type="button"
            onClick={openCart}
            aria-label="פתיחת סל הקניות"
            className="relative rounded-md p-2 text-brand-text transition-colors hover:text-brand-gold"
          >
            <ShoppingCart size={20} />
            {totalCount > 0 && (
              <span className="absolute -top-1 -end-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-gold px-1 text-[11px] font-bold text-brand-bg">
                {totalCount}
              </span>
            )}
          </button>

          {/* Frontend-only placeholder — no real auth exists yet (see CLAUDE.md). */}
          <button
            type="button"
            onClick={() => alert("בקרוב תתאפשר התחברות לאזור האישי.")}
            aria-label="התחברות / אזור אישי"
            className="flex items-center gap-1.5 rounded-md p-2 text-brand-text transition-colors hover:text-brand-gold"
          >
            <User size={20} />
            <span className="hidden text-sm font-medium lg:inline">אזור אישי</span>
          </button>
        </div>
      </div>
    </header>
  );
}

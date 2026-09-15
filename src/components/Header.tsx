import type { MouseEvent } from "react";
import { Phone, ShoppingCart, User } from "lucide-react";
import { Search } from "@/components/Search";
import { useCart } from "@/context/CartContext";

/** The store's real phone number (also used in the footer). */
const STORE_PHONE = "08-994-5190";
const STORE_PHONE_HREF = "tel:089945190";

/**
 * Site navbar — a contact+search group at the RTL "start" (right) edge,
 * cart/login at the "end" (left) edge, and the store logo absolutely
 * centered on the *viewport* (not between the two groups — see the
 * centering wrapper below). No category menu, no hamburger — category
 * navigation lives in the homepage's own category tabs instead (see
 * `CategoryCard`).
 *
 * Deliberately plain, normal-flow content — NOT fixed/sticky. It scrolls
 * away with the page like any other section once the user scrolls past it.
 * (The sticky top-of-viewport experience while scrolling belongs entirely
 * to `BusinessInfoBar` and `CategoryBrowser`'s nav bar.)
 */
export function Header() {
  const { totalCount, openCart } = useCart();

  const scrollToTop = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <header className="border-b border-brand-border bg-brand-bg-secondary">
      <div className="relative mx-auto flex h-12 max-w-container items-center justify-between gap-3 px-4 sm:px-6 lg:h-14">
        <div className="flex items-center gap-1 sm:gap-2">
          <a
            href={STORE_PHONE_HREF}
            aria-label={`התקשרו אלינו: ${STORE_PHONE}`}
            className="flex shrink-0 items-center gap-1.5 rounded-md p-2 text-brand-text transition-colors hover:text-brand-gold"
          >
            <Phone size={20} />
          </a>

          <Search />
        </div>

        {/* Centered independently of the two side groups above, so it stays
            dead-center on the viewport even if the groups' widths differ. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <a
            href="#top"
            onClick={scrollToTop}
            aria-label="בלגן - מרכז הסיגריות והטבק, חזרה לראש הדף"
            className="pointer-events-auto flex items-center rounded-md p-1"
          >
            <img
              src="/images/logo.jpeg"
              alt="בלגן - מרכז הסיגריות והטבק"
              className="h-8 w-8 rounded-sm object-cover sm:h-9 sm:w-9 lg:h-10 lg:w-10"
            />
          </a>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
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

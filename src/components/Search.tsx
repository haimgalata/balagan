import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SearchIcon, X, PackageX } from "lucide-react";
import { useCatalog } from "@/context/CatalogContext";
import { useCart } from "@/context/CartContext";
import { Button } from "@/components/ui/Button";

/**
 * Header search — filters the local mock product catalog only
 * (no backend). Works as a touch-friendly full-screen overlay on
 * every breakpoint so mobile and desktop share the same behavior.
 *
 * The overlay is rendered via a portal into `document.body` rather than
 * inline here. `Header` is a `fixed` element that also carries a Tailwind
 * transform utility (for its scroll-hide behavior) — any non-`none`
 * `transform` on an ancestor makes it the containing block for descendant
 * `fixed` elements, so an inline `fixed inset-0` overlay would be confined
 * to Header's own (short) box instead of the viewport. Portaling out from
 * under Header sidesteps that entirely, independent of Header's transform
 * state, with no change to Header's own behavior or this overlay's markup.
 */
export function Search() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { addUnits } = useCart();
  const { products } = useCatalog();

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return products.filter(
      (product) =>
        product.name.toLowerCase().includes(trimmed) ||
        product.brand.toLowerCase().includes(trimmed)
    );
  }, [query, products]);

  const handleClose = () => {
    setIsOpen(false);
    setQuery("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="חיפוש"
        className="rounded-md p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-2"
      >
        <SearchIcon size={22} />
      </button>

      {isOpen &&
        createPortal(
          <div className="fixed inset-0 z-[95] flex flex-col bg-black/90">
            <div className="flex items-center gap-3 border-b border-brand-border bg-brand-bg-secondary px-4 py-3 sm:px-6 sm:py-4">
              <SearchIcon size={20} className="shrink-0 text-brand-gold" />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                type="text"
                inputMode="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="חיפוש מוצרים... (למשל מרלבורו, דראם)"
                className="min-w-0 flex-1 bg-transparent text-base text-brand-text placeholder:text-brand-text-muted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
              />
              <button
                type="button"
                onClick={handleClose}
                aria-label="סגור חיפוש"
                className="shrink-0 rounded-md p-1.5 text-brand-text-muted outline-none transition-colors hover:bg-brand-bg-elevated hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
              >
                <X size={22} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                {query.trim() && results.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-16 text-brand-text-muted">
                    <PackageX size={36} />
                    <p>לא נמצאו מוצרים תואמים ל&quot;{query}&quot;</p>
                  </div>
                )}

                {results.map((product) => (
                  <div
                    key={product.id}
                    className="flex items-center gap-4 rounded-lg border border-brand-border bg-brand-bg-elevated p-3"
                  >
                    <img
                      src={product.image}
                      alt={product.name}
                      className="h-16 w-16 shrink-0 rounded-md object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-brand-text">{product.name}</p>
                      <p className="text-sm text-brand-text-muted">{product.brand}</p>
                      <p className="font-semibold text-brand-gold">₪{product.unitPrice}</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={!product.inStock}
                      onClick={(event) => {
                        addUnits(product.id, 1);
                        event.currentTarget.blur();
                      }}
                      className="shrink-0"
                    >
                      הוסף לסל
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { Category } from "@/storefront/types";
import { useCatalog } from "@/storefront/context/CatalogContext";

interface CategoryOverflowMenuProps {
  categories: Category[];
  onSelect: (slug: string) => void;
}

/**
 * "עוד קטגוריות" trigger + panel for main categories that don't fit in
 * `CategoryCard`'s row (see `CategoryBrowser`, which decides which
 * categories land here once the count crosses a threshold). A flat list
 * is enough — category data is single-level, so a mega-menu would be
 * over-engineering for what's actually here.
 *
 * The panel is portaled to `document.body` (same reason `Search`'s
 * overlay is: the trigger lives inside `CategoryCard`'s
 * `overflow-x-auto` row, and any non-`visible` overflow value on an
 * ancestor clips absolutely-positioned descendants — the same
 * overflow-x/y coupling quirk `src/index.css` documents). Position is
 * computed from the trigger's rect when opened, and the menu closes on
 * scroll/resize rather than tracking continuously.
 */
export function CategoryOverflowMenu({ categories, onSelect }: CategoryOverflowMenuProps) {
  const { getProductsByCategory } = useCatalog();
  const [isOpen, setIsOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    const closeOnScrollOrResize = () => setIsOpen(false);

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", closeOnScrollOrResize, true);
    window.addEventListener("resize", closeOnScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", closeOnScrollOrResize, true);
      window.removeEventListener("resize", closeOnScrollOrResize);
    };
  }, [isOpen]);

  if (categories.length === 0) return null;

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPanelPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setIsOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        aria-expanded={isOpen}
        aria-controls="category-overflow-panel"
        className="flex shrink-0 snap-start items-center gap-1 rounded-lg border border-brand-border bg-brand-bg-elevated px-4 py-2.5 text-sm font-semibold text-brand-text outline-none transition-colors hover:border-brand-gold hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:text-base"
      >
        עוד קטגוריות
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen &&
        panelPosition &&
        createPortal(
          <div
            ref={panelRef}
            id="category-overflow-panel"
            role="menu"
            aria-label="קטגוריות נוספות"
            style={{ position: "fixed", top: panelPosition.top, right: panelPosition.right }}
            className="z-[95] min-w-[11rem] overflow-hidden rounded-lg border border-brand-border bg-brand-bg-elevated shadow-2xl"
          >
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(category.slug);
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-start text-sm text-brand-text outline-none transition-colors hover:bg-brand-bg focus-visible:bg-brand-bg"
              >
                <span>{category.name}</span>
                <span className="text-brand-text-muted">{getProductsByCategory(category.slug).length}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

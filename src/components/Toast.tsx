import { useEffect } from "react";
import { Check } from "lucide-react";
import { useCart } from "@/context/CartContext";

const AUTO_DISMISS_MS = 3000;

/**
 * Non-blocking confirmation toast shown after `addUnits` runs (see
 * `CartContext`). Reuses the cart's toast state instead of a separate
 * notification system — every "add to cart" entry point (ProductCard,
 * Search, the cart drawer's `+`) already goes through `addUnits`, so they
 * all get this for free. Centered fixed positioning (both axes) keeps it
 * from ever affecting page layout/scroll while staying clearly visible
 * above the rest of the content, including open drawers/search.
 */
export function Toast() {
  const { toast, dismissToast } = useCart();

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(dismissToast, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeout);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div
        key={toast.id}
        className="animate-toast-in pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border border-brand-border bg-brand-bg-elevated px-4 py-3 text-center text-sm font-medium text-brand-text shadow-lg"
      >
        <Check size={16} className="shrink-0 text-brand-success" />
        <span>{toast.message}</span>
      </div>
    </div>
  );
}

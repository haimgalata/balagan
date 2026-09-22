import { useEffect } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { useCart } from "@/context/CartContext";

const AUTO_DISMISS_MS = 3000;

/**
 * Non-blocking toast shown after `addItem` runs (see `CartContext`): a success confirmation, or a warning
 * when the add was refused (not enough shared stock, or availability couldn't be confirmed). Reuses the
 * cart's toast state instead of a separate notification system — every "add to cart" entry point
 * (ProductCard, Search, the cart drawer's `+`) already goes through `addItem`, so they all get this for
 * free. Centered fixed positioning (both axes) keeps it from ever affecting page layout/scroll while staying
 * clearly visible above the rest of the content, including open drawers/search.
 */
export function Toast() {
  const { toast, dismissToast } = useCart();

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(dismissToast, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeout);
  }, [toast, dismissToast]);

  if (!toast) return null;
  const isWarning = toast.kind === "warning";

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div
        key={toast.id}
        className={`animate-toast-in pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border bg-brand-bg-elevated px-4 py-3 text-center text-sm font-medium shadow-lg ${
          isWarning ? "border-brand-danger/40 text-brand-danger" : "border-brand-border text-brand-text"
        }`}
      >
        {isWarning ? (
          <TriangleAlert size={16} className="shrink-0 text-brand-danger" />
        ) : (
          <Check size={16} className="shrink-0 text-brand-success" />
        )}
        <span>{toast.message}</span>
      </div>
    </div>
  );
}

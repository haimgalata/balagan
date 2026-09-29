import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCatalog } from "@/storefront/context/CatalogContext";
import { useCart, type CartLine } from "@/storefront/context/CartContext";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { getLineBaseUnits } from "@/storefront/lib/pricing";
import { checkStockAvailability } from "@/storefront/lib/stockApi";

const config = getCatalogConfig();

export type ValidationPhase = "checking" | "ready" | "failed";

export interface CheckoutValidation {
  phase: ValidationPhase;
  /** True once the first validation pass has settled — distinguishes the initial load from a silent background recheck. */
  hasValidatedOnce: boolean;
  /** Line keys (`${productId}:${option}`) whose effective price changed since checkout was entered. Informational, never blocking. */
  changedPriceKeys: ReadonlySet<string>;
  /** How many lines that were present when checkout opened have since disappeared (product hidden/deleted). */
  droppedCount: number;
  /** Lines that no longer fit their shared stock at the current cart quantity — must be resolved before continuing. */
  blockedLines: CartLine[];
  /** Re-runs validation. Called on mount, whenever the tab regains focus, and once more right before the final submit. */
  revalidate: () => void;
}

/**
 * Re-validates the cart against the database at the moments that matter (mount, tab refocus, pre-submit)
 * instead of a durable "checkout session" with a lifetime to reason about — see the checkout design doc.
 * A price change is never blocking (the line already re-prices live once the catalog updates); a stock
 * shortfall blocks only the affected line (via the cart's own `overLimit` flag); a network/RPC failure
 * fails CLOSED (`phase: "failed"`) — checkout never lets the customer proceed on an unverified cart.
 */
export function useCheckoutValidation(): CheckoutValidation {
  const { lines, revalidateCart } = useCart();
  const { refresh } = useCatalog();
  const [phase, setPhase] = useState<ValidationPhase>("checking");
  const [hasValidatedOnce, setHasValidatedOnce] = useState(false);
  const priceSnapshot = useRef<Map<string, number> | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const revalidate = useCallback(() => {
    priceSnapshot.current = new Map(linesRef.current.map((line) => [line.key, line.pricing.effectiveCents]));
    setPhase("checking");

    const totalsByProduct = new Map<string, number>();
    for (const line of linesRef.current) {
      totalsByProduct.set(
        line.product.id,
        (totalsByProduct.get(line.product.id) ?? 0) + getLineBaseUnits(line.product, line.option, line.quantity)
      );
    }
    const stockItems = [...totalsByProduct.entries()].map(([productId, baseUnits]) => ({ productId, baseUnits }));

    void revalidateCart(); // background — updates each line's `overLimit` flag reactively, best-effort

    void Promise.all([refresh(), checkStockAvailability(config, stockItems)])
      .then(([catalogOk]) => setPhase(catalogOk ? "ready" : "failed"))
      .catch(() => setPhase("failed"))
      .finally(() => setHasValidatedOnce(true));
  }, [refresh, revalidateCart]);

  // Runs once, on mount, against whatever is in the cart at that moment.
  useEffect(() => {
    revalidate();
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [revalidate]);

  const changedPriceKeys = useMemo(() => {
    const before = priceSnapshot.current;
    if (!before) return new Set<string>();
    const changed = new Set<string>();
    for (const line of lines) {
      const prev = before.get(line.key);
      if (prev !== undefined && prev !== line.pricing.effectiveCents) changed.add(line.key);
    }
    return changed;
  }, [lines]);

  const droppedCount = useMemo(() => {
    const before = priceSnapshot.current;
    if (!before) return 0;
    const currentKeys = new Set(lines.map((line) => line.key));
    let count = 0;
    for (const key of before.keys()) if (!currentKeys.has(key)) count += 1;
    return count;
  }, [lines]);

  const blockedLines = useMemo(() => lines.filter((line) => line.available && line.overLimit), [lines]);

  return { phase, hasValidatedOnce, changedPriceKeys, droppedCount, blockedLines, revalidate };
}

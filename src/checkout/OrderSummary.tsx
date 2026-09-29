import { useCart } from "@/storefront/context/CartContext";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { CartLineRow } from "@/storefront/components/CartLineRow";
import { formatPrice } from "@/storefront/lib/pricing";

interface OrderSummaryProps {
  /** Line keys whose price changed since checkout was entered — see `useCheckoutValidation`. */
  changedPriceKeys: ReadonlySet<string>;
}

/**
 * The order summary inside checkout: the same lines, edited the same way, as the cart drawer — reusing
 * `CartLineRow` so a stock/availability flag looks and behaves identically in both places. Quantities can
 * be changed or lines removed directly here; there is no separate checkout-local copy of the cart.
 */
export function OrderSummary({ changedPriceKeys }: OrderSummaryProps) {
  const { lines, totalPriceCents, increment, decrement, removeLine } = useCart();
  const { settings } = useBusinessSettings();

  return (
    <div className="rounded-2xl border border-brand-border bg-brand-bg-elevated">
      <ul className="px-4">
        {lines.map((line) => (
          <CartLineRow
            key={line.key}
            line={line}
            onIncrement={() => void increment(line.product.id, line.option)}
            onDecrement={() => decrement(line.product.id, line.option)}
            onRemove={() => removeLine(line.product.id, line.option)}
            priceChanged={changedPriceKeys.has(line.key)}
          />
        ))}
      </ul>

      <div className="border-t border-brand-border px-4 py-4">
        <p className="mb-3 text-center text-xs text-brand-text-muted">
          משלוח ₪{formatPrice(settings.delivery_fee_cents)} · מינימום הזמנה ₪{formatPrice(settings.min_order_cents)}
        </p>
        <div className="flex items-center justify-between text-lg">
          <span className="font-medium text-brand-text">סה&quot;כ לתשלום</span>
          <span className="font-bold text-brand-gold">₪{formatPrice(totalPriceCents)}</span>
        </div>
      </div>
    </div>
  );
}

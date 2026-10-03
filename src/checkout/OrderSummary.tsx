import type { ReactNode } from "react";
import { useCart } from "@/storefront/context/CartContext";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { CartLineRow } from "@/storefront/components/CartLineRow";
import { formatPrice } from "@/storefront/lib/pricing";
import { OrderTotals } from "@/storefront/components/OrderTotals";
import type { AppliedCoupon } from "@/checkout/couponTypes";

interface OrderSummaryProps {
  /** Line keys whose price changed since checkout was entered — see `useCheckoutValidation`. */
  changedPriceKeys: ReadonlySet<string>;
  /** The coupon box (club builds only). */
  couponSlot?: ReactNode;
  /** The coupon currently applied, shown as its own line. Display only — the database prices the order. */
  coupon?: AppliedCoupon | null;
}

/**
 * The order summary inside checkout: the same lines, edited the same way, as the cart drawer — reusing
 * `CartLineRow` so a stock/availability flag looks and behaves identically in both places. Quantities can
 * be changed or lines removed directly here; there is no separate checkout-local copy of the cart.
 */
export function OrderSummary({ changedPriceKeys, couponSlot, coupon }: OrderSummaryProps) {
  const { lines, totalPriceCents, increment, decrement, removeLine } = useCart();
  const { settings } = useBusinessSettings();
  const freeDelivery = coupon?.discountType === "free_delivery";
  const savingsCents = lines.reduce((sum, line) => (line.available ? sum + line.savingsCents : sum), 0);

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
        {couponSlot}
        <p className="mb-3 text-center text-xs text-brand-text-muted">מינימום הזמנה ₪{formatPrice(settings.min_order_cents)}</p>
        <OrderTotals
          subtotalCents={totalPriceCents}
          deliveryFeeCents={settings.delivery_fee_cents}
          savingsCents={savingsCents}
          coupon={coupon ? { code: coupon.code, discountCents: coupon.discountCents, freeDelivery } : null}
        />
      </div>
    </div>
  );
}

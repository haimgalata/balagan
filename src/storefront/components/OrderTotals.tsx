import { formatPrice, getPayableTotalCents } from "@/storefront/lib/pricing";

interface OrderTotalsProps {
  /** The items (after sale prices), before delivery. */
  subtotalCents: number;
  deliveryFeeCents: number;
  /** What the sales already took off the items, for the small "you saved" note. */
  savingsCents?: number;
  /** A club coupon applied in checkout. Display only — the database prices the real order. */
  coupon?: { code: string; discountCents: number; freeDelivery: boolean } | null;
}

/**
 * The money summary under the cart lines, shared by the cart drawer and checkout so both show the same story:
 * items -> (coupon) -> delivery -> the amount that is actually due (items + delivery - coupon, like the order's total).
 */
export function OrderTotals({ subtotalCents, deliveryFeeCents, savingsCents = 0, coupon = null }: OrderTotalsProps) {
  const freeDelivery = coupon?.freeDelivery === true;
  const total = getPayableTotalCents({ subtotalCents, deliveryFeeCents, couponDiscountCents: coupon?.discountCents, freeDelivery });

  return (
    <div className="mb-4 flex flex-col gap-1.5 text-sm" data-testid="order-totals">
      <div className="flex items-center justify-between text-brand-text-muted">
        <span>סכום ביניים</span>
        <span className="text-brand-text">₪{formatPrice(subtotalCents)}</span>
      </div>
      {savingsCents > 0 && <p className="-mt-1 text-xs text-brand-success">כולל חיסכון של ₪{formatPrice(savingsCents)} במבצעים</p>}
      {coupon && !freeDelivery && (
        <div className="flex items-center justify-between text-brand-text-muted" data-testid="coupon-discount-line">
          <span>
            קופון <span dir="ltr">{coupon.code}</span>
          </span>
          <span className="text-brand-success">-₪{formatPrice(coupon.discountCents)}</span>
        </div>
      )}
      <div className="flex items-center justify-between text-brand-text-muted" data-testid="delivery-line">
        <span>משלוח</span>
        {freeDelivery ? (
          <span className="text-brand-success">
            <s className="text-brand-text-muted">₪{formatPrice(deliveryFeeCents)}</s> חינם (קופון)
          </span>
        ) : (
          <span className="text-brand-text">₪{formatPrice(deliveryFeeCents)}</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-brand-border pt-2 text-lg">
        <span className="font-medium text-brand-text">סה&quot;כ לתשלום</span>
        <span className="font-bold text-brand-gold">₪{formatPrice(total)}</span>
      </div>
    </div>
  );
}

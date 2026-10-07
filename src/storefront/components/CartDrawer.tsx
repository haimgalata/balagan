import { ShoppingCart } from "lucide-react";
import { useCart } from "@/storefront/context/CartContext";
import { CartLineRow } from "@/storefront/components/CartLineRow";
import { Drawer } from "@/shared/ui/Drawer";
import { Button } from "@/shared/ui/Button";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { formatPrice } from "@/storefront/lib/pricing";
import { OrderTotals } from "@/storefront/components/OrderTotals";
import { getOrderingRules } from "@/storefront/lib/fulfillment";
import { useOrderStatus } from "@/storefront/hooks/useOrderStatus";

/**
 * Cart drawer — frontend-only, backed by CartContext (localStorage).
 *
 * One row per line = a product + the option the customer explicitly chose (a unit, or the
 * product's package), rendered by the shared `CartLineRow` (also used by the checkout page's
 * order summary, so both stay identical). A line whose option is out of stock is marked "אזל"
 * and left out of the total.
 *
 * "מעבר לתשלום" is a real navigation to `/checkout` (see `src/checkout/`) once the cart total
 * meets the store's minimum order — below that, the button stays disabled with an explanation. When orders are
 * picked up at the store (see fulfillment.ts) there is no minimum and no delivery fee.
 */
export function CartDrawer() {
  const { lines, totalPriceCents, isOpen, closeCart, increment, decrement, removeLine } = useCart();
  const { settings } = useBusinessSettings();
  const rules = getOrderingRules(settings);
  const pickup = rules.fulfillment === "pickup";
  // Outside the order hours (or while the owner paused orders) checkout can't be reached; the database refuses such
  // an order anyway (ORDERS_CLOSED, migration 0015).
  const { isOpen: ordersOpen, hoursLabel } = useOrderStatus();

  const savingsCents = lines.reduce((sum, line) => (line.available ? sum + line.savingsCents : sum), 0);
  const remainingForMinCents = Math.max(0, rules.minOrderCents - totalPriceCents);
  const belowMinimum = remainingForMinCents > 0;

  const handleCheckoutClick = () => {
    if (belowMinimum || !ordersOpen) return; // the button is disabled too; this is just defense in depth
    window.location.assign("/checkout");
  };

  return (
    <Drawer isOpen={isOpen} onClose={closeCart} title="סל הקניות" side="left">
      {lines.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-brand-text-muted">
          <ShoppingCart size={40} />
          <p>הסל שלך ריק כרגע</p>
          <Button variant="secondary" onClick={closeCart}>
            המשך בקנייה
          </Button>
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <ul className="flex-1 overflow-y-auto px-4 py-4">
            {lines.map((line) => (
              <CartLineRow
                key={line.key}
                line={line}
                onIncrement={() => void increment(line.product.id, line.option)}
                onDecrement={() => decrement(line.product.id, line.option)}
                onRemove={() => removeLine(line.product.id, line.option)}
              />
            ))}
          </ul>

          <div className="border-t border-brand-border px-4 py-4">
            <p className="mb-3 text-center text-xs text-brand-text-muted">
              {pickup ? "איסוף עצמי מהחנות" : `מינימום הזמנה ₪${formatPrice(rules.minOrderCents)}`}
            </p>

            <OrderTotals subtotalCents={totalPriceCents} deliveryFeeCents={rules.deliveryFeeCents} savingsCents={savingsCents} pickup={pickup} />

            <Button variant="primary" size="lg" className="w-full" disabled={belowMinimum || !ordersOpen} onClick={handleCheckoutClick}>
              מעבר לתשלום
            </Button>

            {!ordersOpen && (
              <p role="status" className="mt-2.5 text-center text-xs text-brand-danger">
                ההזמנות באתר סגורות כרגע{hoursLabel !== "סגור היום" ? ` (שעות הזמנה היום: ${hoursLabel})` : ""}
              </p>
            )}

            {ordersOpen && belowMinimum && (
              <p role="status" className="mt-2.5 text-center text-xs text-brand-danger">
                נדרשים עוד ₪{formatPrice(remainingForMinCents)} להשלמת מינימום ההזמנה
              </p>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

import { useState } from "react";
import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { useCart } from "@/context/CartContext";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { DELIVERY_FEE, MINIMUM_ORDER } from "@/data/deliveryInfo";

const CHECKOUT_MESSAGE_MS = 4000;

/**
 * Cart drawer — frontend-only, backed by CartContext (localStorage).
 *
 * Each product has a single total-units quantity (see `CartContext`); the
 * pack discount is derived from it automatically and shown explicitly here
 * (packs applied, remaining single units, and the ₪ saved) so the customer
 * can see exactly why their total is what it is. "מעבר לתשלום" is
 * intentionally inert for now — clicking it shows an in-panel message
 * instead of a native `alert()`; wire it up to a real checkout flow once a
 * backend/payment provider exists.
 */
export function CartDrawer() {
  const { lines, totalPrice, isOpen, closeCart, increment, decrement, removeItem } = useCart();
  const [showCheckoutMessage, setShowCheckoutMessage] = useState(false);

  const handleCheckoutClick = () => {
    setShowCheckoutMessage(true);
    window.setTimeout(() => setShowCheckoutMessage(false), CHECKOUT_MESSAGE_MS);
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
            {lines.map(({ product, quantity, breakdown }) => (
              <li
                key={product.id}
                className="flex gap-3 border-b border-brand-border py-4 first:pt-0 last:border-b-0"
              >
                <img
                  src={product.image}
                  alt={product.name}
                  className="h-16 w-16 shrink-0 rounded-md border border-brand-border object-cover"
                />

                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-brand-text">{product.name}</p>
                      <p className="text-xs text-brand-text-muted">
                        {product.brand} · סה&quot;כ {quantity} יחידות
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(product.id)}
                      aria-label={`הסר ${product.name} מהסל`}
                      className="shrink-0 rounded-md p-1 text-brand-text-muted outline-none transition-colors hover:text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <div className="flex flex-col gap-0.5 text-xs text-brand-text-muted">
                    {breakdown.packs > 0 && (
                      <div className="flex items-center justify-between">
                        <span>
                          {breakdown.packs} × פקט (₪{breakdown.packPrice})
                        </span>
                        <span className="text-brand-text">₪{breakdown.packs * breakdown.packPrice}</span>
                      </div>
                    )}
                    {breakdown.remainingUnits > 0 && (
                      <div className="flex items-center justify-between">
                        <span>
                          {breakdown.remainingUnits} × יחידה (₪{product.unitPrice})
                        </span>
                        <span className="text-brand-text">
                          ₪{breakdown.remainingUnits * product.unitPrice}
                        </span>
                      </div>
                    )}
                    {breakdown.discount > 0 && (
                      <div className="flex items-center justify-between text-brand-success">
                        <span>הנחת פקט</span>
                        <span>-₪{breakdown.discount}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 rounded-md border border-brand-border">
                      <button
                        type="button"
                        onClick={() => increment(product.id)}
                        aria-label="הוסף יחידה"
                        className="rounded p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-1.5"
                      >
                        <Plus size={16} />
                      </button>
                      <span className="min-w-[1.5rem] text-center text-sm font-medium text-brand-text">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => decrement(product.id)}
                        aria-label="הפחת יחידה"
                        className="rounded p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-1.5"
                      >
                        <Minus size={16} />
                      </button>
                    </div>
                    <span className="font-semibold text-brand-gold">₪{breakdown.finalTotal}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t border-brand-border px-4 py-4">
            <p className="mb-3 text-center text-xs text-brand-text-muted">
              משלוח ₪{DELIVERY_FEE} · מינימום הזמנה ₪{MINIMUM_ORDER}
            </p>

            <div className="mb-4 flex items-center justify-between text-lg">
              <span className="font-medium text-brand-text">סה&quot;כ לתשלום</span>
              <span className="font-bold text-brand-gold">₪{totalPrice}</span>
            </div>

            <Button variant="primary" size="lg" className="w-full" onClick={handleCheckoutClick}>
              מעבר לתשלום
            </Button>

            {showCheckoutMessage && (
              <p role="status" className="mt-2.5 text-center text-xs text-brand-text-muted">
                בקרוב תתאפשר רכישה מקוונת. בינתיים ניתן לרכוש טלפונית או בחנות.
              </p>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

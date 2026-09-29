import { Minus, Plus, Trash2 } from "lucide-react";
import type { CartLine } from "@/storefront/context/CartContext";
import { formatPrice } from "@/storefront/lib/pricing";

interface CartLineRowProps {
  line: CartLine;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  /** True when this option's price changed since the customer last saw it (checkout re-validation only). */
  priceChanged?: boolean;
}

/**
 * One cart line: image, name/option, quantity stepper, price. Shared by the cart drawer and the checkout
 * order summary so both editing surfaces stay pixel-identical and behave the same (same stock/availability
 * flags, same +/- semantics) — see `src/storefront/context/CartContext.tsx` for what `available`/`overLimit` mean.
 */
export function CartLineRow({ line, onIncrement, onDecrement, onRemove, priceChanged = false }: CartLineRowProps) {
  const { product, option, quantity, label, pricing, available, overLimit } = line;
  const optionText = option === "package" && product.package ? `${label} (${product.package.unitCount} יח׳)` : label;

  return (
    <li className="flex gap-3 border-b border-brand-border py-4 first:pt-0 last:border-b-0">
      <img
        src={product.image}
        alt={product.name}
        className={`h-16 w-16 shrink-0 rounded-md border border-brand-border object-cover ${available ? "" : "opacity-50"}`}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-brand-text">{product.name}</p>
            <p className="text-xs text-brand-text-muted">
              {product.brand} · {optionText}
            </p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`הסר ${product.name} (${optionText}) מהסל`}
            className="shrink-0 rounded-md p-1 text-brand-text-muted outline-none transition-colors hover:text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-0.5 text-xs text-brand-text-muted">
          <div className="flex items-center justify-between">
            <span>
              {quantity} × {label} (
              {pricing.onSale && <span className="text-brand-danger line-through">₪{formatPrice(pricing.regularCents)} </span>}
              ₪{formatPrice(pricing.effectiveCents)})
            </span>
            <span className="text-brand-text">₪{formatPrice(line.lineTotalCents)}</span>
          </div>
          {available && line.savingsCents > 0 && (
            <div className="flex items-center justify-between text-brand-success">
              <span>מבצע</span>
              <span>-₪{formatPrice(line.savingsCents)}</span>
            </div>
          )}
          {!available && <p className="text-brand-danger">אזל — לא נכלל בסכום</p>}
          {available && overLimit && <p className="text-brand-danger">הכמות שבסל אינה זמינה יותר במלאי — אפשר להקטין אותה</p>}
          {priceChanged && <p className="text-brand-gold">המחיר עודכן מאז שנוסף לסל</p>}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 rounded-md border border-brand-border">
            <button
              type="button"
              onClick={onIncrement}
              disabled={!available || overLimit}
              aria-label={`הוסף ${label}`}
              className="rounded p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-40 sm:p-1.5"
            >
              <Plus size={16} />
            </button>
            <span className="min-w-[1.5rem] text-center text-sm font-medium text-brand-text">{quantity}</span>
            <button
              type="button"
              onClick={onDecrement}
              aria-label={`הפחת ${label}`}
              className="rounded p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-1.5"
            >
              <Minus size={16} />
            </button>
          </div>
          <span className={`font-semibold ${available ? "text-brand-gold" : "text-brand-text-muted"}`}>
            ₪{formatPrice(line.lineTotalCents)}
          </span>
        </div>
      </div>
    </li>
  );
}

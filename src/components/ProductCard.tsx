import { Plus } from "lucide-react";
import type { Product } from "@/types";
import { useCart } from "@/context/CartContext";
import { Button } from "@/components/ui/Button";
import { UNIT_LABEL, formatPrice, getOptionPricing, type OptionPricing } from "@/lib/pricing";

interface ProductCardProps {
  product: Product;
}

const GENERIC_PLACEHOLDER = "/images/products/placeholder.svg";

/** Branded, category-level art shown in place of the old generic
 * placeholder, until a product gets a real photo (see `productImageSrc`
 * below — any product whose `image` has moved off the shared generic
 * placeholder path is assumed to have a real photo and is left alone). */
const CATEGORY_ART: Record<string, string> = {
  cigarettes: "/images/products/pack-cigarettes.svg",
  tobacco: "/images/products/pack-tobacco.svg",
};

function productImageSrc(product: Product): string {
  if (product.image !== GENERIC_PLACEHOLDER) return product.image;
  return CATEGORY_ART[product.category] ?? product.image;
}

/**
 * One option's price: its regular price, or — only when THAT option's sale is active — the regular
 * price in red strikethrough next to the sale price. Unit and package are independent.
 */
function PriceValue({ pricing }: { pricing: OptionPricing }) {
  if (!pricing.onSale) {
    return <span className="font-semibold text-brand-text">₪{formatPrice(pricing.regularCents)}</span>;
  }
  return (
    <span className="flex items-center gap-1">
      <span className="text-brand-danger line-through">₪{formatPrice(pricing.regularCents)}</span>
      <span className="font-bold text-brand-gold">₪{formatPrice(pricing.effectiveCents)}</span>
    </span>
  );
}

/**
 * Reusable product card, sized for use inside `ProductSlider`. All product
 * data comes in via props from the catalog — never hardcode product info
 * here. The card shows the required UNIT option and, when the product has
 * one, its single PACKAGE option (custom label, unit count, its own regular
 * price and optional sale — see `src/lib/pricing.ts`).
 *
 * Width is `calc((100% - var(--gap) * (var(--cards) - 1)) / var(--cards))`
 * rather than a fixed size: `--cards` (how many full cards should be
 * visible at once) and `--gap` (matching the row's actual flex `gap`) are
 * CSS custom properties set responsively on `ProductSlider`'s scroller and
 * inherited here. Because it's percentage-based, `--cards` full cards
 * exactly fill the row's visible width at any viewport size — continuously,
 * not just at breakpoints — with zero partial card peeking at the edge.
 *
 * Each button adds exactly the option the customer chose (`unit` or
 * `package`) as its own cart line (see `src/context/CartContext.tsx`) —
 * adding several units never turns into a package. Neither opens the cart
 * drawer, so the user can keep browsing. Each option can be out of stock on
 * its own (its button is disabled); the "אזל" badge shows when neither can be bought.
 */
export function ProductCard({ product }: ProductCardProps) {
  const { addItem } = useCart();
  const unitPricing = getOptionPricing(product, "unit");
  const packagePricing = getOptionPricing(product, "package");

  return (
    <div
      className="flex shrink-0 snap-start flex-col overflow-hidden rounded-lg border border-brand-border bg-brand-bg-elevated transition-colors hover:border-brand-border-strong"
      style={{ width: "calc((100% - var(--gap) * (var(--cards) - 1)) / var(--cards))" }}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-brand-bg">
        <img
          src={productImageSrc(product)}
          alt={product.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        {!product.inStock && (
          <span className="absolute top-1 start-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-brand-text-muted">
            אזל
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 border-t border-brand-border p-1.5 sm:p-2">
        <p className="truncate text-[11px] font-medium text-brand-gold">{product.brand}</p>
        <h3 className="line-clamp-2 min-h-[2.25rem] text-[13px] font-medium leading-tight text-brand-text">
          {product.name}
        </h3>

        <div className="mt-0.5 flex flex-col gap-0.5 text-xs tabular-nums">
          {unitPricing && (
            <div className="flex items-center justify-between">
              <span className="text-brand-text-muted">{UNIT_LABEL}</span>
              <PriceValue pricing={unitPricing} />
            </div>
          )}
          {product.package && packagePricing && (
            <div className="flex items-center justify-between">
              <span className="text-brand-text-muted">
                {product.package.label} ({product.package.unitCount})
              </span>
              <PriceValue pricing={packagePricing} />
            </div>
          )}
        </div>

        <div className="mt-auto flex gap-1 pt-1.5">
          <Button
            variant="outline"
            size="xs"
            className="flex-1"
            disabled={!product.unit.inStock}
            onClick={(event) => {
              addItem(product.id, "unit");
              // Drop focus so mobile browsers don't keep rendering the
              // tapped state after the click handler runs (see Button.tsx).
              event.currentTarget.blur();
            }}
          >
            <Plus size={12} className="shrink-0" />
            <span className="truncate">{UNIT_LABEL}</span>
          </Button>
          {product.package && (
            <Button
              variant="primary"
              size="xs"
              className="flex-1"
              disabled={!product.package.inStock}
              onClick={(event) => {
                addItem(product.id, "package");
                event.currentTarget.blur();
              }}
            >
              <Plus size={12} className="shrink-0" />
              <span className="truncate">{product.package.label}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

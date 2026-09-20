/**
 * Pricing for the two things a customer can explicitly choose to buy: a single
 * UNIT, or the product's optional PACKAGE. Each option has its own regular price
 * and its own optional sale, all read from the product (i.e. from the database).
 *
 * There is NO global pack rule here: a package price is never computed from the
 * unit price, and adding N single units never switches to the package price — the
 * customer gets the package price only by choosing the package.
 *
 * All arithmetic is done in integer agorot (cents) and formatted at the edge, so
 * totals never show floating-point noise (9 × ₪44.9 is ₪404.1, not 404.09999999999997).
 *
 * This module is pure (type-only imports) so it can be unit-tested without a browser.
 */
import type { Product, PurchaseOption } from "../types";

export const UNIT_LABEL = "יחידה";

/** ₪ amount (possibly with decimals, as stored) -> integer agorot. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Integer agorot -> display number without the ₪ sign, exactly as prices have always
 * looked on the site: 5100 -> "51", 4490 -> "44.9", 40410 -> "404.1", 5 -> "0.05".
 */
export function formatPrice(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const shekels = Math.floor(abs / 100);
  const agorot = abs % 100;
  if (agorot === 0) return `${sign}${shekels}`;
  if (agorot % 10 === 0) return `${sign}${shekels}.${agorot / 10}`;
  return `${sign}${shekels}.${String(agorot).padStart(2, "0")}`;
}

export interface OptionPricing {
  /** Regular price, agorot. */
  regularCents: number;
  /** Active sale price, agorot, or null when there is no active sale. */
  saleCents: number | null;
  /** What the customer pays per item: the sale price when a sale is active, else the regular price. */
  effectiveCents: number;
  onSale: boolean;
}

/**
 * Pricing of one option of a product, or null when the product does not have that
 * option (no package). A sale counts only if it is a real reduction (lower than the regular price).
 */
export function getOptionPricing(product: Product, option: PurchaseOption): OptionPricing | null {
  const data = option === "unit" ? product.unit : product.package;
  if (!data) return null;
  const regularCents = toCents(data.price);
  const saleCents = data.salePrice !== null && toCents(data.salePrice) < regularCents ? toCents(data.salePrice) : null;
  return { regularCents, saleCents, effectiveCents: saleCents ?? regularCents, onSale: saleCents !== null };
}

/** Customer-facing name of an option: "יחידה" for the unit, the product's own label for the package. */
export function getOptionLabel(product: Product, option: PurchaseOption): string {
  return option === "package" && product.package ? product.package.label : UNIT_LABEL;
}

/** True when the option exists and can currently be bought. */
export function isOptionInStock(product: Product, option: PurchaseOption): boolean {
  const data = option === "unit" ? product.unit : product.package;
  return data ? data.inStock : false;
}

/** Total for `quantity` of an option, agorot. */
export function getLineTotalCents(pricing: OptionPricing, quantity: number): number {
  return pricing.effectiveCents * quantity;
}

/** How much cheaper `quantity` of an option is than at its regular price, agorot (0 when not on sale). */
export function getSavingsCents(pricing: OptionPricing, quantity: number): number {
  return (pricing.regularCents - pricing.effectiveCents) * quantity;
}

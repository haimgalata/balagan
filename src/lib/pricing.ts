/**
 * Pack pricing rules.
 *
 * A pack always contains `UNITS_PER_PACK` units. Pack prices are always
 * derived from a product's `unitPrice` — never hardcode a pack price
 * separately in data or components.
 *
 * The cart itself only ever stores a total unit quantity per product (see
 * `src/context/CartContext.tsx`) — the pack discount is derived from that
 * total automatically, regardless of whether the units were added one at a
 * time or via the "+ פקט" shortcut. `getPriceBreakdown` is the single place
 * that turns a quantity into packs/remaining-units/price.
 */

export const UNITS_PER_PACK = 10;
export const PACK_DISCOUNT = 10;

/** Regular (pre-discount) pack price: `unitPrice * UNITS_PER_PACK`. */
export function getRegularPackPrice(unitPrice: number): number {
  return unitPrice * UNITS_PER_PACK;
}

/** Discounted pack price shown to customers: regular pack price minus `PACK_DISCOUNT`. */
export function getPackPrice(unitPrice: number): number {
  return getRegularPackPrice(unitPrice) - PACK_DISCOUNT;
}

export interface PriceBreakdown {
  totalUnits: number;
  /** How many full discounted packs fit into `totalUnits`. */
  packs: number;
  /** Units left over after taking out whole packs. */
  remainingUnits: number;
  /** Discounted price of a single pack for this product. */
  packPrice: number;
  /** What `totalUnits` would cost with no pack discount at all — for showing the discount. */
  regularTotal: number;
  /** How much cheaper `finalTotal` is than `regularTotal`. */
  discount: number;
  /** What the customer actually pays. */
  finalTotal: number;
}

/**
 * Every group of `UNITS_PER_PACK` units in `totalUnits` is automatically
 * priced as a discounted pack — the customer never loses the discount for
 * having added units one at a time instead of via the pack shortcut.
 */
export function getPriceBreakdown(unitPrice: number, totalUnits: number): PriceBreakdown {
  const packs = Math.floor(totalUnits / UNITS_PER_PACK);
  const remainingUnits = totalUnits % UNITS_PER_PACK;
  const packPrice = getPackPrice(unitPrice);
  const finalTotal = packs * packPrice + remainingUnits * unitPrice;
  const regularTotal = totalUnits * unitPrice;

  return {
    totalUnits,
    packs,
    remainingUnits,
    packPrice,
    regularTotal,
    discount: regularTotal - finalTotal,
    finalTotal,
  };
}

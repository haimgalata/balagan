/**
 * FROZEN copy of the pre-Step-4 `src/lib/pricing.ts` (the old global pack rule):
 * 10 units per pack, pack price = unit x 10 - 10.
 *
 * It exists ONLY for the one-off scripts that document/reproduce the old storefront
 * (baseline capture, legacy cart fixtures, the catalog seed generator). The application
 * itself no longer contains any pack formula — every package price is per-product data.
 * Do not import this from `src/`.
 */
export const UNITS_PER_PACK = 10;
export const PACK_DISCOUNT = 10;

export function getRegularPackPrice(unitPrice) {
  return unitPrice * UNITS_PER_PACK;
}

export function getPackPrice(unitPrice) {
  return getRegularPackPrice(unitPrice) - PACK_DISCOUNT;
}

export function getPriceBreakdown(unitPrice, totalUnits) {
  const packs = Math.floor(totalUnits / UNITS_PER_PACK);
  const remainingUnits = totalUnits % UNITS_PER_PACK;
  const packPrice = getPackPrice(unitPrice);
  const finalTotal = packs * packPrice + remainingUnits * unitPrice;
  const regularTotal = totalUnits * unitPrice;
  return { totalUnits, packs, remainingUnits, packPrice, regularTotal, discount: regularTotal - finalTotal, finalTotal };
}

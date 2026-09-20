/**
 * Saved-cart storage rules — pure functions (type-only imports), so they are unit-tested
 * without a browser.
 *
 * The cart lives under `balagan_cart_v2` as `[{ productId, option, quantity }]`, where a line
 * is a product + the option the customer explicitly chose ("unit" or "package") and `quantity`
 * counts THAT option. Nothing is ever converted between options.
 *
 * The previous cart format (`balagan_cart`, where quantity = total units and packs were derived
 * automatically) is migrated once, non-destructively:
 *   - the old key is only ever READ — never written, never removed;
 *   - `{productId, quantity}` becomes that many UNIT lines (duplicates merged);
 *   - the ancient `{productId, type:"pack", quantity}` shape becomes PACKAGE lines with the same
 *     quantity (the explicit pack choice is kept; if the product has no package option the line simply
 *     isn't shown — it stays in storage);
 *   - malformed entries / corrupt JSON are skipped, exactly as before.
 * Ids are deliberately NOT checked against the catalog here: the catalog loads asynchronously and
 * products can be hidden in the admin, so a line that can't be resolved right now must not be erased.
 */
import type { CartItem, PurchaseOption } from "../types";

export const CART_STORAGE_KEY = "balagan_cart_v2";
export const LEGACY_CART_STORAGE_KEY = "balagan_cart";

const isOption = (value: unknown): value is PurchaseOption => value === "unit" || value === "package";

/** Whole, positive quantity or 0 (anything else — strings, NaN, negatives, fractions below 1 — is dropped). */
const asQuantity = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function mergeInto(lines: Map<string, CartItem>, productId: string, option: PurchaseOption, quantity: number): void {
  const key = `${productId}\u0000${option}`;
  const existing = lines.get(key);
  if (existing) existing.quantity += quantity;
  else lines.set(key, { productId, option, quantity });
}

/** Cleans a parsed v2 payload: valid lines only, one line per product + option (duplicates summed). */
export function sanitizeCartItems(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const lines = new Map<string, CartItem>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { productId, option, quantity } = entry as Record<string, unknown>;
    if (typeof productId !== "string" || !isOption(option)) continue;
    const q = asQuantity(quantity);
    if (q > 0) mergeInto(lines, productId, option, q);
  }
  return [...lines.values()];
}

/** Converts a parsed legacy (`balagan_cart`) payload to v2 lines — see the module comment for the rules. */
export function migrateLegacyCart(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const lines = new Map<string, CartItem>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { productId, type, quantity } = entry as Record<string, unknown>;
    if (typeof productId !== "string") continue;
    const q = asQuantity(quantity);
    if (q > 0) mergeInto(lines, productId, type === "pack" ? "package" : "unit", q);
  }
  return [...lines.values()];
}

/**
 * The cart to start with: the v2 cart when its key exists; otherwise the legacy cart migrated once;
 * otherwise empty. Only ever reads from storage.
 */
export function loadCart(storage: { getItem(key: string): string | null }): CartItem[] {
  const current = storage.getItem(CART_STORAGE_KEY);
  if (current !== null) {
    try {
      return sanitizeCartItems(JSON.parse(current));
    } catch {
      return []; // corrupted v2 payload
    }
  }
  const legacy = storage.getItem(LEGACY_CART_STORAGE_KEY);
  if (legacy === null) return [];
  try {
    return migrateLegacyCart(JSON.parse(legacy));
  } catch {
    return []; // corrupted legacy payload
  }
}

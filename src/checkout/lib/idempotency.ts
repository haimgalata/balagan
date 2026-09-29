const STORAGE_KEY = "balagan_checkout_idempotency_key";

/**
 * `crypto.randomUUID()` is restricted to secure contexts (https:/localhost) — see `uniqueImageId` in
 * `src/admin/products/productsApi.ts` for the same gotcha this project already hit once. The idempotency
 * key doesn't need cryptographic randomness, only practical uniqueness, so a Math.random()-based fallback
 * in the same v4 shape (the database column is `uuid`) is fine.
 */
function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // insecure context — fall through to the plain-random fallback below
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * One id per checkout attempt, reused across retries of the SAME attempt (double-click, a page refresh,
 * a request that timed out without a response) — see `create_order()` in
 * `supabase/migrations/0009_orders.sql`, which returns the already-created order for a repeat key instead
 * of creating a second one. Persisted in `sessionStorage` so it survives a refresh; cleared once an order
 * is actually created (`clearIdempotencyKey`) so a later, separate order gets its own fresh key.
 *
 * `storage` is injectable (defaults to `sessionStorage`), same reasoning as `loadCart` in
 * `src/storefront/lib/cartStorage.ts` — keeps the reuse/expiry logic unit-testable without a browser.
 */
export function getOrCreateIdempotencyKey(storage: KeyValueStorage = window.sessionStorage): string {
  try {
    const existing = storage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = generateUuid();
    storage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return generateUuid(); // storage unavailable (private mode etc.) — still correct, just can't survive a refresh
  }
}

export function clearIdempotencyKey(storage: KeyValueStorage = window.sessionStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

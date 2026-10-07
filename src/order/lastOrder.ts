/**
 * The last order placed on THIS device, so the customer can get back to its tracking page (the success screen, the
 * homepage's "your order" strip). Only the order id (the key to its status page), its number and when it was placed —
 * nothing personal. Kept 3 days, then forgotten; also forgotten once the order is finished.
 *
 * Imports nothing and `storage` is injectable, so it is unit-testable and costs the homepage almost nothing.
 */
export const LAST_ORDER_KEY = "balagan_last_order_v1";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LastOrder {
  id: string;
  number: number;
  /** epoch ms */
  placedAt: number;
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const defaultStorage = (): KeyValueStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function parseLastOrder(raw: string | null, now = Date.now()): LastOrder | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { id, number, placedAt } = v as Record<string, unknown>;
    if (typeof id !== "string" || !UUID.test(id) || typeof number !== "number" || typeof placedAt !== "number") return null;
    if (now - placedAt > MAX_AGE_MS || placedAt > now + 60_000) return null;
    return { id, number, placedAt };
  } catch {
    return null;
  }
}

export function readLastOrder(storage: KeyValueStorage | null = defaultStorage(), now = Date.now()): LastOrder | null {
  try {
    return storage ? parseLastOrder(storage.getItem(LAST_ORDER_KEY), now) : null;
  } catch {
    return null;
  }
}

export function saveLastOrder(order: LastOrder, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAST_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* private mode / quota: the success screen still shows the link */
  }
}

export function forgetLastOrder(storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(LAST_ORDER_KEY);
  } catch {
    /* ignore */
  }
}

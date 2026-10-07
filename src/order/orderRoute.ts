/**
 * The one piece of the order-tracking page the CUSTOMER bundle contains: a pure check of the address, used by
 * `src/main.tsx` to decide whether to load the page. Imports nothing — mirrors `checkoutRoute.ts`/`adminRoute.ts`.
 *
 * `/order/<uuid>`: the order's own (unguessable) id is the only key to its status — the same capability the
 * `get_order_status()` RPC is built on (migration 0009). Order NUMBERS are sequential and never used in this address.
 */
export const ORDER_ROOT = "/order";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for `/order` and anything below it. */
export function isOrderPathname(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === ORDER_ROOT || path.startsWith(`${ORDER_ROOT}/`);
}

/** The order id in `/order/<uuid>` (a trailing slash is fine), or null for anything else. */
export function orderIdFromPathname(pathname: string): string | null {
  const match = /^\/order\/([^/]+)\/?$/i.exec(pathname);
  return match && UUID.test(match[1]) ? match[1].toLowerCase() : null;
}

export function orderPath(orderId: string): string {
  return `${ORDER_ROOT}/${orderId}`;
}

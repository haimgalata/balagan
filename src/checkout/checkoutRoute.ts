/**
 * The one piece of checkout code the CUSTOMER bundle contains: a pure check of the address, used by
 * `src/main.tsx` to decide whether to load the checkout app. Keep it tiny and import nothing (no React,
 * no Supabase) so the customer bundle stays free of checkout code — mirrors `src/admin/adminRoute.ts`.
 */
export const CHECKOUT_ROOT = "/checkout";

/** True for `/checkout` and anything below it (`/checkout/...`). */
export function isCheckoutPathname(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === CHECKOUT_ROOT || path.startsWith(`${CHECKOUT_ROOT}/`);
}

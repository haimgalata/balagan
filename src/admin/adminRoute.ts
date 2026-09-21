/**
 * The one piece of admin code the CUSTOMER bundle contains: a pure check of the address, used by
 * `src/main.tsx` to decide whether to load the admin app. Keep it tiny and import nothing (no React, no
 * Supabase) so the customer bundle stays free of admin code. The customer site never links to `/admin`.
 */
export const ADMIN_ROOT = "/admin";

/** True for `/admin` and anything below it (`/admin/...`). */
export function isAdminPathname(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === ADMIN_ROOT || path.startsWith(`${ADMIN_ROOT}/`);
}

/** `/admin/` -> `/admin`; `/ADMIN/products/` -> `/admin/products`. */
export function normalizeAdminPath(pathname: string): string {
  const path = pathname.toLowerCase().replace(/\/+$/, "");
  return path === "" ? ADMIN_ROOT : path;
}

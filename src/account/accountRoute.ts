/**
 * The one piece of account-PAGE code the main bundle contains: a pure check of the address, used by src/main.tsx to
 * decide whether to load the /account app. Imports nothing (no React, no Supabase) — mirrors checkoutRoute.ts /
 * adminRoute.ts. In a build without a club login the call site is dead code and this file is dropped entirely.
 */
export const ACCOUNT_ROOT = "/account";

/** True for `/account` and anything below it. */
export function isAccountPathname(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === ACCOUNT_ROOT || path.startsWith(`${ACCOUNT_ROOT}/`);
}

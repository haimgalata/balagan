/**
 * Admin constants (pure — safe to import from tests).
 */

/** Signed-in admin is signed out after this long with no clicks / keys / touches. */
export const IDLE_LOGOUT_MS = 60 * 60 * 1000;
/** How often the idle check runs. Uses wall-clock time, so it also works after the computer slept. */
export const IDLE_CHECK_MS = 15_000;

/** Where supabase-js keeps the admin session in localStorage (separate from anything the storefront uses). */
export const ADMIN_STORAGE_KEY = "balagan-admin-auth";

/** Why the login screen is being shown instead of the dashboard (shown as a notice above the form). */
export type SignedOutNotice = "not-authorized" | "idle";

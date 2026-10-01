/**
 * The version of the site terms ("תקנון") a customer accepts at checkout. `create_order()` stamps every order with
 * 'v1' (supabase/migrations/0009_orders.sql) and records it on a member's profile (migration 0012), so a member
 * who has accepted the CURRENT version isn't asked to tick the terms box again (the 18+ confirmation is still
 * required on every order). When the terms change: bump this AND the version `create_order()` writes.
 */
export const CURRENT_TERMS_VERSION = "v1";

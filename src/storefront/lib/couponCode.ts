/**
 * Coupon codes are typed by people (the owner when creating one, a member at checkout), so both sides normalize them
 * the same way: Unicode NFKC (folds full-width letters/digits), then every space and invisible/bidi mark removed (those
 * sneak in when a code is pasted next to Hebrew text), then upper-cased. Case, spaces and such never matter; `0`/`O`
 * and `1`/`I` are NOT folded.
 *
 * Pinned to the SQL `normalize_coupon_code()` (supabase/migrations/0014_coupons.sql) by identical examples in
 * tests/account/couponCode.unit.spec.ts and scripts/verify-order-management.mjs. The database always re-normalizes
 * and is the only authority; this is for the input box and the admin form.
 */
const IGNORED = /[\s​-‏‪-‮⁦-⁩﻿]/g;

export function normalizeCouponCode(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFKC").replace(IGNORED, "").toUpperCase();
}

/** What an owner may create: Latin letters, digits, `_` and `-`, 3–24 characters (no Hebrew: a Hebrew keyboard layout would make a code look right but not match). */
export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,24}$/;

export function isValidCouponCode(normalized: string): boolean {
  return COUPON_CODE_PATTERN.test(normalized);
}

/** True when the text contains Hebrew letters — used for a friendly "type the code in English letters" hint. */
export const containsHebrew = (text: string): boolean => /[֐-׿]/.test(text);

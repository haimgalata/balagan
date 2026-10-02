import { test, expect } from "@playwright/test";
import { containsHebrew, isValidCouponCode, normalizeCouponCode } from "../../src/storefront/lib/couponCode";

/**
 * The same examples as the database check in scripts/verify-order-management.mjs ("Coupons: code normalization"), so the
 * checkout input / admin form and normalize_coupon_code() (migration 0014) cannot drift apart.
 */
test("normalizeCouponCode mirrors normalize_coupon_code()", () => {
  expect(normalizeCouponCode(" club 20 ")).toBe("CLUB20");
  expect(normalizeCouponCode("ｃｌｕｂ２０"), "full-width letters and digits fold").toBe("CLUB20");
  expect(normalizeCouponCode("CLUB‏20‎"), "invisible direction marks (pasted next to Hebrew) are dropped").toBe("CLUB20");
  expect(normalizeCouponCode("‫welcome-25‬")).toBe("WELCOME-25");
  expect(normalizeCouponCode("a b"), "a non-breaking space is a space").toBe("AB");
  expect(normalizeCouponCode("0O1I"), "look-alikes are NOT folded").toBe("0O1I");
  expect(normalizeCouponCode(null)).toBe("");
  expect(normalizeCouponCode(undefined)).toBe("");
  expect(normalizeCouponCode("   ")).toBe("");
});

test("what an owner may create: Latin letters, digits, - and _, 3-24 characters", () => {
  for (const ok of ["CLUB20", "WEEKEND10", "WELCOME25", "A-B_C", "ABC", "A".repeat(24)]) expect(isValidCouponCode(ok), ok).toBe(true);
  for (const bad of ["", "AB", "A".repeat(25), "club20", "קוד123", "CLUB 20", "CLUB.20", "CLUB!"]) expect(isValidCouponCode(bad), bad).toBe(false);
});

test("a typed code is judged after normalization", () => {
  expect(isValidCouponCode(normalizeCouponCode(" club 20 "))).toBe(true);
  expect(isValidCouponCode(normalizeCouponCode("קוד123"))).toBe(false);
});

test("Hebrew is detected for the keyboard-layout hint", () => {
  expect(containsHebrew("שלום")).toBe(true);
  expect(containsHebrew("CLUB20")).toBe(false);
  expect(containsHebrew("CLUB ש")).toBe(true);
});

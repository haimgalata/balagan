import { test, expect } from "@playwright/test";
import { formatLocalPhone, isIsraeliMobile, isValidIsraeliPhone, normalizeIsraeliPhone } from "../../src/storefront/lib/phone";

/**
 * The same examples as the database check in scripts/verify-order-management.mjs ("Phone normalization"), so the
 * form and normalize_il_phone() (migration 0012) cannot drift apart.
 */
test("normalizeIsraeliPhone mirrors normalize_il_phone()", () => {
  expect(normalizeIsraeliPhone("050-123-4567")).toBe("+972501234567");
  for (const variant of ["+972 50 123 4567", "972501234567", "00972501234567", "+972(0)501234567"]) {
    expect(normalizeIsraeliPhone(variant), variant).toBe("+972501234567");
  }
  expect(normalizeIsraeliPhone("08-994-5190")).toBe("+97289945190");
  expect(normalizeIsraeliPhone("072-123-4567")).toBe("+972721234567");
  for (const bad of [null, undefined, "", "abc", "12345", "0123456789", "+12025550100", "050-123-456", "050-123-45678"]) {
    expect(normalizeIsraeliPhone(bad), String(bad)).toBeNull();
  }
});

test("only mobiles can be club members; landlines still work for guest checkout", () => {
  expect(isIsraeliMobile(normalizeIsraeliPhone("052-000-0000"))).toBe(true);
  expect(isIsraeliMobile(normalizeIsraeliPhone("08-994-5190"))).toBe(false);
  expect(isIsraeliMobile(null)).toBe(false);
  // the guest checkout rule is unchanged: 9-digit landline or 10-digit mobile, any separators
  expect(isValidIsraeliPhone("08-994-5190")).toBe(true);
  expect(isValidIsraeliPhone("050 123 4567")).toBe(true);
  expect(isValidIsraeliPhone("12345")).toBe(false);
});

test("formatLocalPhone is display-only", () => {
  expect(formatLocalPhone("+972501234567")).toBe("050-123-4567");
  expect(formatLocalPhone("+97289945190")).toBe("+97289945190");
});

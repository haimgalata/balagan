import { test, expect } from "@playwright/test";
import { CHECKOUT_ROOT, isCheckoutPathname } from "../../src/checkout/checkoutRoute";

test.describe("isCheckoutPathname", () => {
  test("matches /checkout and anything below it, case-insensitively", () => {
    for (const path of ["/checkout", "/checkout/", "/checkout/anything", "/CHECKOUT", "/Checkout/Confirm"]) {
      expect(isCheckoutPathname(path), path).toBe(true);
    }
  });

  test("does not match look-alikes or customer paths", () => {
    for (const path of ["/", "/checkoutx", "/checkouts", "/a/checkout", "/products/checkout", "/index.html", "/#checkout", ""]) {
      expect(isCheckoutPathname(path), JSON.stringify(path)).toBe(false);
    }
  });

  test("CHECKOUT_ROOT is /checkout", () => {
    expect(CHECKOUT_ROOT).toBe("/checkout");
  });
});

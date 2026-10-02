import { test, expect } from "@playwright/test";
import { formatOrderDate, orderAddressLine, orderStatusLabel, orderStatusTone, summarizeItems } from "../../src/account/orderLabels";
import type { MyOrder } from "../../src/account/types";

const order = (over: Partial<MyOrder> = {}): MyOrder => ({
  id: "o1", orderNumber: 1042, status: "confirmed", paymentMethod: "cash", paymentStatus: "pending", createdAt: "2026-09-20T07:00:00Z",
  subtotalCents: 50000, deliveryFeeCents: 1500, discountCents: 0, couponCode: null, totalCents: 51500, street: "הרצל", houseNumber: "12", entrance: "", floor: "", apartment: "",
  items: [{ productId: "1", name: "מרלבורו", brand: null, option: "package", optionLabel: "פקט", quantity: 2, unitPriceCents: 25000, lineTotalCents: 50000 }],
  ...over,
});

test("every status the store uses has a customer-facing Hebrew label; unknown ones degrade gracefully", () => {
  for (const status of ["pending", "confirmed", "preparing", "out_for_delivery", "completed", "cancelled", "expired"]) {
    expect(orderStatusLabel(status), status).not.toBe("בטיפול");
  }
  expect(orderStatusLabel("something-new")).toBe("בטיפול");
  expect(orderStatusTone("out_for_delivery")).toBe("active");
  expect(orderStatusTone("completed")).toBe("done");
  expect(orderStatusTone("cancelled")).toBe("bad");
});

test("dates are Israel dates, whatever the visitor's own timezone", () => {
  // 21:30 UTC on 19 Sep is already 20 Sep in Israel (UTC+3 in September)
  expect(formatOrderDate("2026-09-19T21:30:00Z")).toBe("20.9.2026");
  expect(formatOrderDate("not a date")).toBe("");
});

test("an order is summarized in one line, long ones are cut", () => {
  expect(summarizeItems(order())).toBe("2 × מרלבורו (פקט)");
  const many = order({ items: ["א", "ב", "ג", "ד", "ה"].map((name) => ({ productId: null, name, brand: null, option: "unit" as const, optionLabel: "יחידה", quantity: 1, unitPriceCents: 1, lineTotalCents: 1 })) });
  expect(summarizeItems(many)).toBe("1 × א, 1 × ב, 1 × ג ועוד 2");
});

test("the address line leaves out what is empty", () => {
  expect(orderAddressLine(order())).toBe("הרצל 12");
  expect(orderAddressLine(order({ entrance: "ב", floor: "2", apartment: "5" }))).toBe("הרצל 12, כניסה ב, קומה 2, דירה 5");
});

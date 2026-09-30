import { test, expect } from "@playwright/test";
import {
  advanceAction,
  backAction,
  buildSearchFilter,
  canCancel,
  cancelHoldsStock,
  formatAge,
  formatShekel,
  israelDateToIso,
  israelStartOfDay,
  needsStockReturn,
  paidButDead,
} from "../../../src/admin/orders/orderModel";
import { describeError } from "../../../src/admin/orders/ordersErrors";
import { isOrdersPath, parseOrdersPath } from "../../../src/admin/orders/ordersRoute";

test.describe("status moves offered to the user", () => {
  test("forward path is new -> preparing -> out for delivery -> completed, then nothing", () => {
    expect(advanceAction("confirmed")?.to).toBe("preparing");
    expect(advanceAction("preparing")?.to).toBe("out_for_delivery");
    expect(advanceAction("out_for_delivery")?.to).toBe("completed");
    for (const s of ["completed", "cancelled", "expired", "pending"] as const) expect(advanceAction(s)).toBeNull();
  });

  test("one step back for staff; reopening a completed order is owner-only", () => {
    expect(backAction("confirmed", "staff")).toBeNull();
    expect(backAction("preparing", "staff")?.to).toBe("confirmed");
    expect(backAction("out_for_delivery", "staff")?.to).toBe("preparing");
    expect(backAction("completed", "staff")).toBeNull();
    expect(backAction("completed", "owner")?.to).toBe("out_for_delivery");
    expect(backAction("cancelled", "owner")).toBeNull();
  });

  test("only open orders can be cancelled; cancelling after dispatch holds the stock", () => {
    for (const s of ["confirmed", "preparing", "out_for_delivery"] as const) expect(canCancel(s)).toBe(true);
    for (const s of ["completed", "cancelled", "expired", "pending"] as const) expect(canCancel(s)).toBe(false);
    expect(cancelHoldsStock("out_for_delivery")).toBe(true);
    expect(cancelHoldsStock("preparing")).toBe(false);
  });

  test("attention flags", () => {
    expect(needsStockReturn({ order_status: "cancelled", stock_return_status: "pending_return" })).toBe(true);
    expect(needsStockReturn({ order_status: "cancelled", stock_return_status: "restored" })).toBe(false);
    expect(paidButDead({ order_status: "expired", payment_status: "paid" })).toBe(true);
    expect(paidButDead({ order_status: "completed", payment_status: "paid" })).toBe(false);
  });
});

test.describe("search filter", () => {
  test("digits search order number and phone; long digit strings only phone", () => {
    expect(buildSearchFilter("1005")).toBe("order_number.eq.1005,phone_digits.ilike.*1005*");
    expect(buildSearchFilter("050-123 4567")).toBe("phone_digits.ilike.*0501234567*");
    expect(buildSearchFilter("#1005")).toBe("order_number.eq.1005,phone_digits.ilike.*1005*");
  });
  test("text searches name and street", () => {
    expect(buildSearchFilter("לוי")).toBe("first_name.ilike.*לוי*,last_name.ilike.*לוי*,street.ilike.*לוי*");
  });
  test("grammar characters can never reach the filter", () => {
    const filter = buildSearchFilter('a,b),or(id.eq.1*"')!;
    expect(filter).not.toMatch(/[()"]/);
    expect(filter.split(",")).toHaveLength(3); // still exactly the three fixed terms
    expect(buildSearchFilter("   ")).toBeNull();
    expect(buildSearchFilter("(),*")).toBeNull();
  });
});

test.describe("time and money", () => {
  test("Israel start of day, summer and winter (UTC+3 / UTC+2), from any moment of the day", () => {
    expect(israelStartOfDay(new Date("2026-09-20T10:00:00+03:00"))).toBe("2026-09-19T21:00:00.000Z");
    expect(israelStartOfDay(new Date("2026-09-20T00:30:00+03:00"))).toBe("2026-09-19T21:00:00.000Z");
    expect(israelStartOfDay(new Date("2026-09-20T23:59:00+03:00"))).toBe("2026-09-19T21:00:00.000Z");
    expect(israelStartOfDay(new Date("2026-01-15T12:00:00+02:00"))).toBe("2026-01-14T22:00:00.000Z");
    // 21:30 UTC on the 19th is already the 20th in Israel
    expect(israelStartOfDay(new Date("2026-09-19T21:30:00Z"))).toBe("2026-09-19T21:00:00.000Z");
  });
  test("date inputs become Israel day boundaries", () => {
    expect(israelDateToIso("2026-09-20")).toBe("2026-09-19T21:00:00.000Z");
    expect(israelDateToIso("2026-09-20", true)).toBe("2026-09-20T21:00:00.000Z");
    expect(israelDateToIso("")).toBeNull();
    expect(israelDateToIso("20/09/2026")).toBeNull();
  });
  test("age labels and shekel formatting", () => {
    const now = Date.parse("2026-09-20T10:00:00Z");
    expect(formatAge("2026-09-20T09:59:40Z", now)).toBe("עכשיו");
    expect(formatAge("2026-09-20T09:55:00Z", now)).toBe("לפני 5 דק׳");
    expect(formatAge("2026-09-20T08:00:00Z", now)).toBe("לפני 2 שעות");
    expect(formatAge("2026-09-17T10:00:00Z", now)).toBe("לפני 3 ימים");
    expect(formatShekel(13500)).toContain("135");
    expect(formatShekel(13550)).toContain("135.5");
  });
});

test.describe("errors and routes", () => {
  test("database errors become specific messages", () => {
    expect(describeError({ message: "STALE_STATUS: preparing" })).toMatchObject({ kind: "stale", current: "preparing" });
    expect(describeError({ message: "REASON_REQUIRED" }).kind).toBe("reason-required");
    expect(describeError({ message: "INVALID_TRANSITION: confirmed -> completed" }).kind).toBe("invalid-transition");
    expect(describeError({ code: "42501", message: "NOT_AUTHORIZED" }).kind).toBe("permission");
    expect(describeError({ code: "PGRST202", message: "Could not find the function public.transition_order" }).kind).toBe("setup-needed");
    expect(describeError({ code: "", message: "Failed to fetch" }).kind).toBe("network");
    expect(describeError({ message: "boom" }).kind).toBe("unknown");
  });
  test("orders paths", () => {
    expect(parseOrdersPath("/admin/orders")).toEqual({ view: "board" });
    expect(parseOrdersPath("/admin/orders/history")).toEqual({ view: "history" });
    expect(parseOrdersPath("/admin/orders/1005")).toEqual({ view: "order", number: 1005 });
    expect(parseOrdersPath("/admin/orders/abc")).toEqual({ view: "none" });
    expect(parseOrdersPath("/admin/products")).toEqual({ view: "none" });
    expect(isOrdersPath("/admin/orders/1005/extra")).toBe(false);
  });
});

import { test, expect } from "@playwright/test";
import {
  buildPayrollCsv,
  centsToInput,
  currentMonth,
  formatShekels,
  monthLabel,
  parsePayroll,
  parseShekels,
  payrollFileName,
  pendingRows,
  remainingCents,
  shiftMonth,
  type CourierPayroll,
  type PayrollRow,
} from "../../../src/admin/couriers/couriersModel";
import { failPaysCourier, FAIL_REASONS, isOpenStop, parseHistory, shortDate } from "../../../src/admin/courier/courierModel";

const row = (over: Partial<PayrollRow> = {}): PayrollRow => ({
  order_id: "o1", order_number: 1001, outcome: "delivered", reason: null, pay_cents: 1200, fee_cents: 2000,
  happened_at: "2026-09-12T15:30:00.000Z", run_date: "2026-09-12", departure_time: "18:00:00", address: "הרצל 12", ...over,
});
const courier = (over: Partial<CourierPayroll> = {}): CourierPayroll => ({
  courier_id: "c1", name: "דני השליח", phone: "0501234567", email: "d@x.test", active: true, rate_override_cents: null, rate_cents: 1200,
  delivered: 1, failed: 1, pending: 1, runs: 1, days: 1, pay_cents: 1200, paid_cents: 500, rows: [row(), row({ order_id: "o2", order_number: 1002, outcome: "failed", reason: "הכתובת לא נמצאה", pay_cents: null })], payouts: [], ...over,
});

test.describe("courier pay model", () => {
  test("months are Israel's, and move forward and back across a year", () => {
    expect(currentMonth(new Date("2026-09-20T10:00:00+03:00"))).toBe("2026-09-01");
    // 00:30 on the 1st in Israel is still the previous day in UTC — the month must be Israel's
    expect(currentMonth(new Date("2026-10-01T00:30:00+03:00"))).toBe("2026-10-01");
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-09-01", 0)).toBe("2026-09-01");
    expect(monthLabel("2026-09-01")).toBe("ספטמבר 2026");
  });

  test("amounts: shekels in, agorot out; anything else is refused", () => {
    expect(parseShekels("12")).toBe(1200);
    expect(parseShekels("12.5")).toBe(1250);
    expect(parseShekels("12,50")).toBe(1250);
    expect(parseShekels("₪ 20")).toBe(2000);
    expect(parseShekels("0")).toBe(0);
    for (const bad of ["", "abc", "-5", "1.234", "1e3", "12 ₪ 5"]) expect(parseShekels(bad)).toBeNull();
    expect(centsToInput(1250)).toBe("12.5");
    expect(centsToInput(1200)).toBe("12");
    expect(formatShekels(1200)).toBe("₪12");
    expect(formatShekels(1250)).toBe("₪12.50");
  });

  test("what is left, and the failed deliveries waiting for a decision", () => {
    expect(remainingCents(courier())).toBe(700);
    expect(remainingCents(courier({ paid_cents: 1500 }))).toBe(-300);
    expect(pendingRows(courier()).map((r) => r.order_number)).toEqual([1002]);
    expect(pendingRows(courier({ rows: [row()] }))).toEqual([]);
    // a failed delivery that was decided as "pay nothing" is not pending
    expect(pendingRows(courier({ rows: [row({ outcome: "failed", pay_cents: 0 })] }))).toEqual([]);
  });

  test("the payroll answer is checked before it reaches the screen", () => {
    const ok = parsePayroll({ month: "2026-09-01", default_rate_cents: 1200, couriers: [{ ...courier(), payouts: [{ id: 1, amount_cents: 500, note: null, created_at: "2026-09-30T09:00:00Z" }] }] });
    expect(ok?.couriers[0].payouts[0].amount_cents).toBe(500);
    expect(ok?.couriers[0].rows[1].pay_cents).toBeNull();
    expect(parsePayroll({ month: "2026-09-01", couriers: "no" })).toBeNull();
    expect(parsePayroll({ month: "2026-09-01", default_rate_cents: 0, couriers: [{ ...courier(), rows: [{ order_id: "x", order_number: 1, outcome: "weird" }] }] })).toBeNull();
    expect(parsePayroll(null)).toBeNull();
  });

  test("the CSV: BOM, CRLF, English headers, quoted cells, totals, and a spreadsheet formula can never run", () => {
    const csv = buildPayrollCsv(courier({ rows: [row({ address: "=HYPERLINK(\"x\")" }), row({ order_id: "o2", order_number: 1002, outcome: "failed", reason: "הכתובת לא נמצאה", pay_cents: null })] }));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe('"date","order_number","run_departure","address","outcome","reason","courier_pay_ils","customer_delivery_fee_ils"');
    expect(lines[1]).toContain('"2026-09-12","1001","18:00"');
    expect(lines[1]).toContain("\"'=HYPERLINK("); // neutralised
    expect(lines[2]).toContain('"failed","הכתובת לא נמצאה",""'); // undecided pay is empty, not 0
    expect(lines.at(-3)).toBe('"","","","","","TOTAL","12.00",""');
    expect(lines.at(-2)).toBe('"","","","","","PAID","5.00",""');
    expect(lines.at(-1)).toBe('"","","","","","LEFT","7.00",""');
  });

  test("the file name carries the month and the courier, safely", () => {
    expect(payrollFileName({ name: "דני השליח" }, "2026-09-01")).toBe("balagan-courier-pay-2026-09-דני-השליח.csv");
    expect(payrollFileName({ name: "../../x" }, "2026-09-01")).toBe("balagan-courier-pay-2026-09-x.csv");
    expect(payrollFileName({ name: "!!!" }, "2026-09-01")).toBe("balagan-courier-pay-2026-09-courier.csv");
  });
});

test.describe("what a failed delivery pays (the courier's reason)", () => {
  test("a clear customer reason is paid; the rest waits for the owner", () => {
    expect(failPaysCourier("הלקוח לא היה בבית / לא ענה")).toBe(true);
    expect(failPaysCourier("לא הוצגה תעודה מזהה")).toBe(true);
    expect(failPaysCourier("מקבל המשלוח מתחת לגיל 18")).toBe(true);
    expect(failPaysCourier("הלקוח סירב לקבל")).toBe(true);
    expect(failPaysCourier("הכתובת לא נמצאה")).toBeNull();
    expect(failPaysCourier("אחר")).toBeNull();
    expect(failPaysCourier("משהו שהשליח הקליד")).toBeNull();
    // every reason offered on the courier's screen has a decision
    for (const r of FAIL_REASONS) expect([true, null]).toContain(failPaysCourier(r));
  });

  test("a stop is still open until it is delivered or failed", () => {
    expect(isOpenStop({ order_status: "ready_for_dispatch" })).toBe(true);
    expect(isOpenStop({ order_status: "out_for_delivery" })).toBe(true);
    expect(isOpenStop({ order_status: "completed" })).toBe(false);
    expect(isOpenStop({ order_status: "delivery_failed" })).toBe(false);
  });
});

test.describe("a courier's own history (migration 0019)", () => {
  const good = {
    month: "2026-09-01", delivered: 1, failed: 1, runs: 1, days: 1,
    run_list: [{ run_id: "r1", run_date: "2026-09-20", departure_time: "18:00:00", departed_at: "2026-09-20T14:55:00Z", finished_at: "2026-09-20T15:40:00Z",
      stops: [{ order_number: 1202, outcome: "delivered", reason: null, at: "2026-09-20T15:10:00Z" }, { order_number: 1201, outcome: "failed", reason: "לא הוצגה תעודה מזהה", at: "2026-09-20T15:40:00Z" }] }],
  };

  test("the answer is checked, and carries only what the screen shows", () => {
    const h = parseHistory(good);
    expect(h?.delivered).toBe(1);
    expect(h?.run_list[0].stops.map((s) => s.order_number)).toEqual([1202, 1201]);
    expect(h?.run_list[0].stops[1].reason).toBe("לא הוצגה תעודה מזהה");
    // anything unknown (a customer field that should never be there) is dropped, never passed through
    const sneaky = parseHistory({ ...good, run_list: [{ ...good.run_list[0], stops: [{ ...good.run_list[0].stops[0], phone: "050-123-4567", street: "הרצל" }] }] });
    expect(JSON.stringify(sneaky)).not.toContain("050-123-4567");
    expect(JSON.stringify(sneaky)).not.toContain("הרצל");
    expect(parseHistory(null)).toBeNull();
    expect(parseHistory({ month: "2026-09-01", run_list: "no" })).toBeNull();
    expect(parseHistory({ ...good, run_list: [{ ...good.run_list[0], stops: [{ order_number: 1, outcome: "weird" }] }] })).toBeNull();
  });

  test("short dates", () => {
    expect(shortDate("2026-09-20")).toBe("20.9");
    expect(shortDate("2026-10-03")).toBe("3.10");
    expect(shortDate("bad")).toBe("bad");
  });
});

import { test, expect } from "@playwright/test";
import {
  advanceAction,
  backAction,
  canCancel,
  cancelHoldsStock,
  deliveryContext,
  departureLabel,
  needsStockReturn,
  statusLabel,
} from "../../../src/admin/orders/orderModel";
import { NO_COURIER_WARNING_MS, runDepartureAt, runDepartureLabel, runsNeedingAttention, telHref, type RunRow } from "../../../src/admin/orders/runModel";
import { describeError } from "../../../src/admin/orders/ordersErrors";
import {
  amountToCollectCents,
  callHref,
  canDepart,
  canRelease,
  parseMyRuns,
  parseOpenRuns,
  runProgress,
  stopAddress,
  stopDetails,
  wazeHref,
  type MyRun,
  type Stop,
} from "../../../src/admin/courier/courierModel";
import { firstAvailableSlotId, formatDepartureTime, isWindowRequired, parseDeliverySlots, slotLabel, departureNote } from "../../../src/storefront/lib/deliveryWindows";
import {
  newWindowDraft,
  parseAdvanceHours,
  toWindowDrafts,
  toWindowFields,
  validateWindows,
} from "../../../src/admin/settings/deliveryWindowsModel";
import { customerStatusLabel, isOpenOrderStatus } from "../../../src/order/orderStatusText";

test.describe("order model with delivery windows (migration 0017)", () => {
  test("a windowed order passes through ready_for_dispatch; the courier takes it from there", () => {
    expect(advanceAction("preparing", "delivery", { windowed: true })?.to).toBe("ready_for_dispatch");
    expect(advanceAction("preparing", "delivery", { windowed: true })?.label).toBe("מוכנה למשלוח");
    expect(advanceAction("ready_for_dispatch", "delivery", { windowed: true })).toBeNull();
    expect(advanceAction("out_for_delivery", "delivery", { windowed: true, inRun: true })).toBeNull();
  });

  test("an order without a window keeps the old lifecycle", () => {
    expect(advanceAction("preparing", "delivery")?.to).toBe("out_for_delivery");
    expect(advanceAction("out_for_delivery", "delivery")?.to).toBe("completed");
    expect(advanceAction("preparing", "delivery", deliveryContext({ delivery_window_id: null, delivery_run_id: null }))?.to).toBe("out_for_delivery");
  });

  test("pickup is unaffected", () => {
    expect(advanceAction("preparing", "pickup", { windowed: true })?.to).toBe("ready_for_pickup");
    expect(advanceAction("ready_for_pickup", "pickup")?.to).toBe("completed");
  });

  test("ready_for_dispatch can go back to preparing and be cancelled (stock is restored at once)", () => {
    expect(backAction("ready_for_dispatch", "staff")?.to).toBe("preparing");
    expect(canCancel("ready_for_dispatch")).toBe(true);
    expect(cancelHoldsStock("ready_for_dispatch")).toBe(false);
    expect(cancelHoldsStock("out_for_delivery")).toBe(true);
  });

  test("delivery_failed is final and waits for the goods to be confirmed back", () => {
    expect(advanceAction("delivery_failed")).toBeNull();
    expect(backAction("delivery_failed", "owner")).toBeNull();
    expect(canCancel("delivery_failed")).toBe(false);
    expect(needsStockReturn({ order_status: "delivery_failed", stock_return_status: "pending_return" })).toBe(true);
    expect(needsStockReturn({ order_status: "delivery_failed", stock_return_status: "restored" })).toBe(false);
    expect(statusLabel("delivery_failed")).toBe("לא נמסרה");
    expect(statusLabel("ready_for_dispatch")).toBe("מוכנה למשלוח");
  });

  test("departure label for the board", () => {
    expect(departureLabel({ delivery_departure_time: "18:00:00" })).toBe("יציאה ב-18:00");
    expect(departureLabel({ delivery_departure_time: null })).toBeNull();
    expect(departureLabel({})).toBeNull();
  });

  test("the new database refusals are explained in Hebrew", () => {
    expect(describeError({ code: "P0001", message: "ALREADY_CLAIMED" }).kind).toBe("run-taken");
    expect(describeError({ code: "P0001", message: "RUN_ALREADY_DEPARTED" }).kind).toBe("run-departed");
    expect(describeError({ code: "P0001", message: "USE_DELIVERY_RUN" }).kind).toBe("use-run");
    expect(describeError({ code: "P0001", message: "ID_CHECK_REQUIRED" }).kind).toBe("id-check");
    expect(describeError({ code: "P0001", message: "RUN_EMPTY" }).kind).toBe("run-empty");
    expect(describeError({ code: "P0001", message: "RUN_NOT_CLAIMED" }).kind).toBe("run-not-claimed");
    expect(describeError({ code: "P0001", message: "STALE_STATUS: delivery_failed" })).toMatchObject({ kind: "stale", current: "delivery_failed" });
    expect(describeError({ code: "P0001", message: "ALREADY_CLAIMED" }).message).toContain("שליח אחר");
  });
});

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "r1",
  run_date: "2026-09-20",
  status: "open",
  courier_name: null,
  courier_phone: null,
  claimed_at: null,
  departed_at: null,
  delivery_windows: { departure_time: "18:00:00" },
  ...over,
});

test.describe("runs on the board", () => {
  const due = runDepartureAt(run())!;

  test("the departure instant is Israel's 18:00 on that date", () => {
    // 2026-09-20 18:00 Asia/Jerusalem (UTC+3 in September) = 15:00 UTC
    expect(new Date(due).toISOString()).toBe("2026-09-20T15:00:00.000Z");
    expect(runDepartureLabel(run())).toBe("18:00");
    expect(runDepartureAt(run({ delivery_windows: null }))).toBeNull();
  });

  test("a claimed run that has not left once it is due is flagged — never released automatically", () => {
    const claimed = run({ status: "claimed", courier_name: "דני", courier_phone: "0501234567" });
    expect(runsNeedingAttention([claimed], due - 60_000)).toEqual([]);
    const late = runsNeedingAttention([claimed], due + 60_000);
    expect(late).toHaveLength(1);
    expect(late[0].kind).toBe("late");
    expect(late[0].message).toContain("דני");
  });

  test("an unclaimed run is flagged half an hour before it is due", () => {
    const open = run();
    expect(runsNeedingAttention([open], due - NO_COURIER_WARNING_MS - 1000)).toEqual([]);
    expect(runsNeedingAttention([open], due - NO_COURIER_WARNING_MS + 1000)[0].kind).toBe("no-courier");
  });

  test("a run on the road is never flagged", () => {
    expect(runsNeedingAttention([run({ status: "departed" })], due + 3_600_000)).toEqual([]);
  });

  test("telHref keeps only digits and a leading plus", () => {
    expect(telHref("050-123-4567")).toBe("tel:0501234567");
    expect(telHref("+972 50 123 4567")).toBe("tel:+972501234567");
  });
});

const stop = (over: Partial<Stop> = {}): Stop => ({
  order_id: "o1",
  order_number: 1001,
  order_status: "ready_for_dispatch",
  first_name: "דנה",
  last_name: "לוי",
  phone: "050-123-4567",
  city: "נתיבות",
  street: "הרצל",
  house_number: "12",
  entrance: null,
  floor: "2",
  apartment: "5",
  intercom_code: "1234",
  notes: null,
  payment_method: "card",
  payment_status: "paid",
  total_cents: 13500,
  failed_reason: null,
  ...over,
});
const myRun = (over: Partial<MyRun> = {}): MyRun => ({
  id: "r1",
  status: "claimed",
  run_date: "2026-09-20",
  departure_time: "18:00:00",
  claimed_at: null,
  departed_at: null,
  stops: [stop()],
  ...over,
});

test.describe("courier model", () => {
  test("links: call, Waze with the full address", () => {
    expect(callHref("050-123-4567")).toBe("tel:0501234567");
    const waze = wazeHref(stop());
    expect(waze.startsWith("https://waze.com/ul?q=")).toBe(true);
    expect(decodeURIComponent(waze)).toContain("הרצל 12, נתיבות");
    expect(waze.endsWith("&navigate=yes")).toBe(true);
    expect(stopAddress(stop())).toBe("הרצל 12");
    expect(stopDetails(stop())).toEqual(["קומה 2", "דירה 5", "קוד אינטרקום 1234"]);
  });

  test("the depart button needs a claimed run with a packed order; release only before departure", () => {
    expect(canDepart(myRun())).toBe(true);
    expect(canDepart(myRun({ stops: [stop({ order_status: "completed" })] }))).toBe(false);
    expect(canDepart(myRun({ status: "departed" }))).toBe(false);
    expect(canRelease(myRun())).toBe(true);
    expect(canRelease(myRun({ status: "departed" }))).toBe(false);
  });

  test("progress counts delivered, failed and what is left", () => {
    const progress = runProgress(
      myRun({ status: "departed", stops: [stop({ order_status: "completed" }), stop({ order_status: "delivery_failed" }), stop({ order_status: "out_for_delivery" })] })
    );
    expect(progress).toEqual({ total: 3, delivered: 1, failed: 1, remaining: 1 });
  });

  test("only an unpaid cash order is collected at the door", () => {
    expect(amountToCollectCents(stop({ payment_method: "cash", payment_status: "pending" }))).toBe(13500);
    expect(amountToCollectCents(stop({ payment_method: "cash", payment_status: "paid" }))).toBe(0);
    expect(amountToCollectCents(stop())).toBe(0);
  });

  test("the RPC answers are checked before they reach the screen", () => {
    expect(parseOpenRuns([{ id: "r", run_date: "2026-09-20", departure_time: "18:00:00", order_count: 2, streets: ["הרצל", 3] }])).toEqual([
      { id: "r", run_date: "2026-09-20", departure_time: "18:00:00", order_count: 2, streets: ["הרצל"] },
    ]);
    expect(parseOpenRuns([{ id: "r" }])).toBeNull();
    expect(parseOpenRuns({})).toBeNull();
    const ok = parseMyRuns([{ ...myRun(), stops: [stop()] }]);
    expect(ok?.[0].stops[0].street).toBe("הרצל");
    expect(parseMyRuns([{ ...myRun(), status: "cancelled" }])).toBeNull();
    expect(parseMyRuns([{ ...myRun(), stops: [{ ...stop(), order_status: "pending" }] }])).toBeNull();
  });
});

test.describe("delivery windows on the customer side", () => {
  const slots = [
    { id: "a", departureTime: "13:00:00", available: false },
    { id: "b", departureTime: "18:00:00", available: true },
  ];

  test("labels, default choice and when a window is required", () => {
    expect(formatDepartureTime("18:00:00")).toBe("18:00");
    expect(slotLabel(slots[1])).toBe("יציאה ב-18:00");
    expect(firstAvailableSlotId(slots)).toBe("b");
    expect(firstAvailableSlotId([slots[0]])).toBeNull();
    expect(isWindowRequired(null)).toBe(false);
    expect(isWindowRequired([])).toBe(false);
    expect(isWindowRequired(slots)).toBe(true);
    expect(departureNote("18:00:00")).toBe("משלוח יוצא ב-18:00");
    expect(departureNote(null)).toBeNull();
  });

  test("get_delivery_slots() is parsed strictly and sorted by departure", () => {
    expect(parseDeliverySlots([{ id: "b", departure_time: "18:00:00", available: true }, { id: "a", departure_time: "13:00:00", available: false }])?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(parseDeliverySlots([{ id: "a", departure_time: "13:00:00" }])).toBeNull();
    expect(parseDeliverySlots("nope")).toBeNull();
  });

  test("customer wording for the new statuses", () => {
    expect(customerStatusLabel("ready_for_dispatch")).toBe("מוכנה, ממתינה ליציאה");
    expect(customerStatusLabel("delivery_failed")).toBe("לא נמסרה");
    expect(isOpenOrderStatus("ready_for_dispatch")).toBe(true);
    expect(isOpenOrderStatus("delivery_failed")).toBe(false);
  });
});

test.describe("delivery windows editor (admin settings)", () => {
  test("advance hours: a whole number from 1 to 24", () => {
    expect(parseAdvanceHours("4")).toBe(4);
    expect(parseAdvanceHours(" 24 ")).toBe(24);
    for (const bad of ["0", "25", "-1", "2.5", "", "abc"]) expect(parseAdvanceHours(bad)).toBeNull();
  });

  const draft = (over = {}) => ({ ...newWindowDraft(), departure: "18:00", cutoff: "17:00", ...over });

  test("a valid set of windows passes; the checks mirror the database", () => {
    expect(validateWindows([], "4")).toBeNull();
    expect(validateWindows([draft(), draft({ departure: "21:00", cutoff: "20:00", capacity: "8" })], "4")).toBeNull();
    expect(validateWindows([draft({ departure: "" })], "4")).toContain("שעת יציאה");
    expect(validateWindows([draft({ cutoff: "" })], "4")).toContain("סגירה");
    expect(validateWindows([draft({ cutoff: "19:00" })], "4")).toContain("אחרי שעת היציאה");
    expect(validateWindows([draft({ capacity: "0" })], "4")).toContain("קיבולת");
    expect(validateWindows([draft({ capacity: "x" })], "4")).toContain("קיבולת");
    expect(validateWindows([draft(), draft()], "4")).toContain("כבר יש חלון");
    expect(validateWindows([draft()], "99")).toContain("שעות מראש");
  });

  test("drafts round-trip to the payload (empty capacity = unlimited)", () => {
    const drafts = toWindowDrafts([{ id: "w1", departure_time: "18:00:00", order_cutoff_time: "17:00:00", capacity: null, is_active: true }]);
    expect(drafts[0]).toMatchObject({ id: "w1", departure: "18:00", cutoff: "17:00", capacity: "", active: true });
    expect(toWindowFields(drafts[0])).toEqual({ departure_time: "18:00", order_cutoff_time: "17:00", capacity: null, is_active: true });
    expect(toWindowFields({ ...drafts[0], capacity: " 8 ", active: false })).toEqual({ departure_time: "18:00", order_cutoff_time: "17:00", capacity: 8, is_active: false });
    expect(newWindowDraft().key).not.toBe(newWindowDraft().key);
  });
});

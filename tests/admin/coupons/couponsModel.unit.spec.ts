import { test, expect } from "@playwright/test";
import {
  addressKey, afterDispatchReleases, couponStatus, describeCoupon, duplicateForm, EMPTY_FORM, EMPTY_USAGE, endsAtToLastDay, formFromCoupon,
  formatPhoneLocal, formatUsage, isoToIsraelDate, sharedAddressKeys, summarizeUsage, toPayload, validateForm,
  type CouponFormValues, type CouponRow, type RedemptionRow,
} from "../../../src/admin/coupons/couponsModel";
import { describeError } from "../../../src/admin/coupons/couponsErrors";

const base: CouponRow = {
  id: "c1", code: "CLUB20", title: "הנחת מועדון", internal_note: null, discount_type: "percent", discount_value: 20, max_discount_cents: 3000,
  min_subtotal_cents: 10000, starts_at: null, ends_at: null, is_active: true, max_total_redemptions: 100, max_per_member: 1, first_order_only: false,
  archived_at: null, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
};
const NOW = Date.parse("2026-10-02T12:00:00Z");

test("status is derived from the coupon and how much of it was used", () => {
  const used = (n: number) => ({ ...EMPTY_USAGE, active: n, redeemed: n });
  expect(couponStatus(base, used(3), NOW)).toBe("active");
  expect(couponStatus({ ...base, is_active: false }, used(0), NOW)).toBe("disabled");
  expect(couponStatus({ ...base, archived_at: "2026-10-01T00:00:00Z", is_active: false }, used(0), NOW), "archived wins").toBe("archived");
  expect(couponStatus({ ...base, starts_at: "2026-10-03T00:00:00Z" }, used(0), NOW)).toBe("scheduled");
  expect(couponStatus({ ...base, ends_at: "2026-10-02T11:59:00Z" }, used(0), NOW)).toBe("expired");
  expect(couponStatus({ ...base, ends_at: "2026-10-02T12:00:00Z" }, used(0), NOW), "the end instant itself is already over").toBe("expired");
  expect(couponStatus(base, used(100), NOW)).toBe("exhausted");
  expect(couponStatus({ ...base, max_total_redemptions: null }, used(5000), NOW), "no total limit never runs out").toBe("active");
});

test("usage counts a reserved card hold, and shows released ones separately", () => {
  const usage = summarizeUsage([
    { coupon_id: "c1", status: "redeemed" }, { coupon_id: "c1", status: "reserved" }, { coupon_id: "c1", status: "released" }, { coupon_id: "c2", status: "redeemed" },
  ]);
  expect(usage.get("c1")).toEqual({ active: 2, redeemed: 1, reserved: 1, released: 1 });
  expect(usage.get("c2")).toEqual({ active: 1, redeemed: 1, reserved: 0, released: 0 });
  expect(formatUsage(base, usage.get("c1")!)).toBe("2 / 100 · שוחררו 1");
  expect(formatUsage({ max_total_redemptions: null }, EMPTY_USAGE)).toBe("0");
});

test("a coupon reads back as one sentence, both limits independently", () => {
  expect(describeCoupon(base)).toBe("20% הנחה (עד ₪30), בהזמנה מעל ₪100 · עד 100 שימושים · עד 1 לחבר");
  expect(describeCoupon({ ...base, discount_type: "fixed", discount_value: 2500, max_discount_cents: null, min_subtotal_cents: 0, max_total_redemptions: 500, max_per_member: 3 }))
    .toBe("₪25 הנחה · עד 500 שימושים · עד 3 לחבר");
  expect(describeCoupon({ ...base, discount_type: "free_delivery", discount_value: null, max_discount_cents: null, min_subtotal_cents: 0, max_total_redemptions: null, max_per_member: null, first_order_only: true }))
    .toBe("משלוח חינם · ללא הגבלת שימושים כוללת · ללא הגבלה לחבר · הזמנה ראשונה בלבד");
});

test("dates are Israel calendar days; the end date is inclusive (stored as the start of the next day)", () => {
  expect(isoToIsraelDate("2026-10-01T21:30:00Z"), "00:30 Israel time on the 2nd").toBe("2026-10-02");
  expect(isoToIsraelDate(null)).toBe("");
  const form: CouponFormValues = { ...EMPTY_FORM, code: "WEEKEND10", title: "סופ״ש", percent: "10", startsOn: "2026-10-02", endsOn: "2026-10-04" };
  const body = toPayload(form, { mode: "create" });
  expect(body.starts_at).toBe("2026-10-01T21:00:00.000Z"); // Israel midnight at +03:00 (summer time, still in force on 2 Oct 2026)
  expect(body.ends_at, "the start of the 5th = the end of the 4th").toBe("2026-10-04T21:00:00.000Z");
  expect(endsAtToLastDay(body.ends_at as string), "...and it round-trips to the day the owner typed").toBe("2026-10-04");
});

test("the form: a typed code is normalized and judged; Hebrew, format and duplicates are named", () => {
  const ok = { ...EMPTY_FORM, code: " weekend 10 ", title: "x", percent: "10" };
  expect(validateForm(ok, { mode: "create", takenCodes: [] })).toEqual([]);
  expect(toPayload(ok, { mode: "create" }).code).toBe("WEEKEND10");
  expect(validateForm({ ...ok, code: "" }, { mode: "create", takenCodes: [] })).toContain("code-empty");
  expect(validateForm({ ...ok, code: "קוד123" }, { mode: "create", takenCodes: [] })).toContain("code-hebrew");
  expect(validateForm({ ...ok, code: "AB" }, { mode: "create", takenCodes: [] })).toContain("code-format");
  expect(validateForm({ ...ok, code: "club 20" }, { mode: "create", takenCodes: ["CLUB20"] }), "a taken code is found after normalization").toContain("code-taken");
  expect(validateForm({ ...ok, code: "" }, { mode: "edit", takenCodes: [] }), "an existing coupon's code is not re-checked").toEqual([]);
});

test("the form: amounts, percent, dates and both limits", () => {
  const v = (patch: Partial<CouponFormValues>) => validateForm({ ...EMPTY_FORM, code: "ABC", title: "x", percent: "10", ...patch }, { mode: "create", takenCodes: [] });
  expect(v({ percent: "0" })).toContain("percent");
  expect(v({ percent: "101" })).toContain("percent");
  expect(v({ percent: "10.5" })).toContain("percent");
  expect(v({ discountType: "fixed", fixedShekel: "" })).toContain("fixed");
  expect(v({ discountType: "fixed", fixedShekel: "0" })).toContain("fixed");
  expect(v({ discountType: "fixed", fixedShekel: "25" })).toEqual([]);
  expect(v({ discountType: "free_delivery", percent: "" })).toEqual([]);
  expect(v({ maxDiscountShekel: "0" })).toContain("max-discount");
  expect(v({ minSubtotalShekel: "-5" })).toContain("min-subtotal");
  expect(v({ startsOn: "2026-10-05", endsOn: "2026-10-04" })).toContain("dates");
  expect(v({ startsOn: "2026-10-04", endsOn: "2026-10-04" }), "one single day is fine").toEqual([]);
  expect(v({ maxTotal: "0" })).toContain("max-total");
  expect(v({ maxPerMember: "1.5" })).toContain("max-per-member");
  expect(v({ maxTotal: "", maxPerMember: "" }), "empty = unlimited").toEqual([]);
  expect(v({ title: "   " })).toContain("title");
});

test("the request body: both limits come straight from the form, nothing is hard-coded to one use", () => {
  const body = toPayload({ ...EMPTY_FORM, code: "CLUB20", title: " הנחה ", percent: "20", maxDiscountShekel: "30", minSubtotalShekel: "100", maxTotal: "500", maxPerMember: "3", firstOrderOnly: true }, { mode: "create" });
  expect(body).toMatchObject({
    code: "CLUB20", title: "הנחה", discount_type: "percent", discount_value: 20, max_discount_cents: 3000, min_subtotal_cents: 10000,
    max_total_redemptions: 500, max_per_member: 3, first_order_only: true, is_active: true, starts_at: null, ends_at: null,
  });
  const unlimited = toPayload({ ...EMPTY_FORM, code: "CLUB20", title: "x", percent: "20", maxTotal: "", maxPerMember: "" }, { mode: "create" });
  expect(unlimited.max_total_redemptions).toBeNull();
  expect(unlimited.max_per_member).toBeNull();
  expect(toPayload({ ...EMPTY_FORM, code: "FREE", title: "x", discountType: "free_delivery" }, { mode: "create" })).toMatchObject({ discount_type: "free_delivery", discount_value: null, max_discount_cents: null });
  expect(toPayload({ ...EMPTY_FORM, code: "FIX", title: "x", discountType: "fixed", fixedShekel: "12.5" }, { mode: "create" })).toMatchObject({ discount_value: 1250 });
});

test("editing a used coupon never sends the locked fields (the database would refuse them)", () => {
  const form = formFromCoupon(base);
  const body = toPayload({ ...form, title: "חדש", maxPerMember: "2" }, { mode: "edit", financialLocked: true });
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("discount_type");
  expect(body).not.toHaveProperty("discount_value");
  expect(body).not.toHaveProperty("max_discount_cents");
  expect(body).toMatchObject({ title: "חדש", max_per_member: 2 });
  expect(validateForm({ ...form, percent: "" }, { mode: "edit", takenCodes: [], financialLocked: true }), "locked values are not re-validated").toEqual([]);
});

test("the form round-trips an existing coupon, and a duplicate starts without a code and inactive", () => {
  const form = formFromCoupon({ ...base, starts_at: "2026-10-01T21:00:00Z", ends_at: "2026-10-04T21:00:00Z" });
  expect(form).toMatchObject({ code: "CLUB20", percent: "20", maxDiscountShekel: "30", minSubtotalShekel: "100", maxTotal: "100", maxPerMember: "1", startsOn: "2026-10-02", endsOn: "2026-10-04" });
  const copy = duplicateForm(base);
  expect(copy).toMatchObject({ code: "", title: "הנחת מועדון (עותק)", isActive: false, percent: "20" });
});

test("the usage list hints at several phones behind one door, and at repeated after-dispatch cancellations", () => {
  const order = (street: string, apartment: string | null) => ({ order_number: 1, order_status: "completed", street, house_number: "5", apartment, total_cents: 1 });
  const row = (id: string, phone: string, o: RedemptionRow["orders"], extra: Partial<RedemptionRow> = {}): RedemptionRow => ({
    id, coupon_id: "c1", order_id: id, phone_e164: phone, discount_cents: 100, status: "redeemed", reserved_at: "2026-10-01T00:00:00Z", redeemed_at: "2026-10-01T00:00:00Z",
    released_at: null, released_reason: null, orders: o, ...extra,
  });
  const rows = [row("1", "+972501111111", order("הרצל", "3")), row("2", "+972502222222", order(" הרצל ", "3")), row("3", "+972503333333", order("בן גוריון", null)),
    row("4", "+972504444444", order("הרצל", "3"), { status: "released", released_reason: "order_cancelled_after_dispatch", released_at: "2026-10-02T00:00:00Z" })];
  const shared = sharedAddressKeys(rows);
  expect(shared.has(addressKey(order("הרצל", "3")!))).toBe(true);
  expect(shared.has(addressKey(order("בן גוריון", null)!))).toBe(false);
  expect(shared.size, "a released use does not count as a second phone").toBe(1);
  expect(afterDispatchReleases([...rows, row("5", "+972504444444", order("x", null), { status: "released", released_reason: "order_cancelled_after_dispatch", released_at: "z" })]).get("+972504444444")).toBe(2);
  expect(formatPhoneLocal("+972501234567")).toBe("050-123-4567");
});

test("database errors become one readable Hebrew message", () => {
  expect(describeError({ code: "23505", message: 'duplicate key value violates unique constraint "coupons_code_key"' }).kind).toBe("duplicate-code");
  expect(describeError({ code: "P0001", message: "COUPON_LOCKED" }).kind).toBe("locked");
  expect(describeError({ code: "P0001", message: "CODE_LOCKED" }).kind).toBe("locked");
  expect(describeError({ code: "23514", message: 'violates check constraint "coupons_code_format"' }).kind).toBe("invalid");
  expect(describeError({ code: "42501", message: "new row violates row-level security policy" }).kind).toBe("permission");
  expect(describeError({ code: "PGRST205", message: "Could not find the table 'public.coupons' in the schema cache" }).kind).toBe("setup-needed");
  expect(describeError({ code: "", message: "TypeError: Failed to fetch" }).kind).toBe("network");
  expect(describeError({ code: "XX", message: "?" }).kind).toBe("unknown");
});

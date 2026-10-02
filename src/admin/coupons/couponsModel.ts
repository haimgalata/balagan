/**
 * The owner's coupon screen, as pure functions (no React, no network): what a coupon's state is, how it reads in a
 * sentence, the form's validation, and the request body it turns into. The database (migration 0014) enforces every
 * rule independently — these only make the owner's mistakes visible before they reach it.
 */
import { COUPON_CODE_PATTERN, containsHebrew, normalizeCouponCode } from "@/storefront/lib/couponCode";
import { israelDateToIso, israelStartOfDay } from "@/admin/orders/orderModel";

export type DiscountType = "percent" | "fixed" | "free_delivery";

export interface CouponRow {
  id: string;
  code: string;
  title: string;
  internal_note: string | null;
  discount_type: DiscountType;
  discount_value: number | null;
  max_discount_cents: number | null;
  min_subtotal_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  max_total_redemptions: number | null;
  max_per_member: number | null;
  first_order_only: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RedemptionStatus = "reserved" | "redeemed" | "released";

export interface RedemptionRow {
  id: string;
  coupon_id: string;
  order_id: string;
  phone_e164: string;
  discount_cents: number;
  status: RedemptionStatus;
  reserved_at: string;
  redeemed_at: string | null;
  released_at: string | null;
  released_reason: string | null;
  orders?: { order_number: number; order_status: string; street: string; house_number: string; apartment: string | null; total_cents: number } | null;
}

export interface CouponEventRow {
  id: number;
  kind: "created" | "updated" | "enabled" | "disabled" | "archived" | "restored";
  changes: Record<string, { from: unknown; to: unknown }> | null;
  actor_label: string;
  created_at: string;
}

/** What has been used of a coupon right now (a reserved card hold counts until it is released). */
export interface CouponUsage {
  active: number; // redeemed + reserved
  redeemed: number;
  reserved: number;
  released: number;
}

export const EMPTY_USAGE: CouponUsage = { active: 0, redeemed: 0, reserved: 0, released: 0 };

export function summarizeUsage(rows: readonly Pick<RedemptionRow, "coupon_id" | "status">[]): Map<string, CouponUsage> {
  const out = new Map<string, CouponUsage>();
  for (const r of rows) {
    const u = out.get(r.coupon_id) ?? { ...EMPTY_USAGE };
    u[r.status] += 1;
    if (r.status !== "released") u.active += 1;
    out.set(r.coupon_id, u);
  }
  return out;
}

// ---------------------------------------------------------------- state

export type CouponStatus = "active" | "scheduled" | "expired" | "disabled" | "exhausted" | "archived";

export const STATUS_LABEL: Record<CouponStatus, string> = {
  active: "פעיל",
  scheduled: "מתוזמן",
  expired: "פג תוקף",
  disabled: "מושבת",
  exhausted: "מוצה",
  archived: "בארכיון",
};

export function couponStatus(c: CouponRow, usage: CouponUsage, now: number = Date.now()): CouponStatus {
  if (c.archived_at) return "archived";
  if (!c.is_active) return "disabled";
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return "scheduled";
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return "expired";
  if (c.max_total_redemptions !== null && usage.active >= c.max_total_redemptions) return "exhausted";
  return "active";
}

// ---------------------------------------------------------------- reading it

const shekel = (cents: number): string => `₪${(cents / 100).toLocaleString("he-IL", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** One line the owner can read back and recognize: "20% הנחה (עד ₪30), בהזמנה מעל ₪100 · עד 100 שימושים · עד 1 לחבר". */
export function describeCoupon(c: Pick<CouponRow, "discount_type" | "discount_value" | "max_discount_cents" | "min_subtotal_cents" | "max_total_redemptions" | "max_per_member" | "first_order_only">): string {
  const parts: string[] = [];
  if (c.discount_type === "percent") {
    parts.push(`${c.discount_value ?? "?"}% הנחה${c.max_discount_cents ? ` (עד ${shekel(c.max_discount_cents)})` : ""}`);
  } else if (c.discount_type === "fixed") {
    parts.push(`${c.discount_value === null ? "?" : shekel(c.discount_value)} הנחה`);
  } else {
    parts.push("משלוח חינם");
  }
  if (c.min_subtotal_cents > 0) parts[0] += `, בהזמנה מעל ${shekel(c.min_subtotal_cents)}`;
  parts.push(c.max_total_redemptions === null ? "ללא הגבלת שימושים כוללת" : `עד ${c.max_total_redemptions} שימושים`);
  parts.push(c.max_per_member === null ? "ללא הגבלה לחבר" : `עד ${c.max_per_member} לחבר`);
  if (c.first_order_only) parts.push("הזמנה ראשונה בלבד");
  return parts.join(" · ");
}

export const formatUsage = (c: Pick<CouponRow, "max_total_redemptions">, u: CouponUsage): string =>
  `${u.active}${c.max_total_redemptions === null ? "" : ` / ${c.max_total_redemptions}`}${u.released > 0 ? ` · שוחררו ${u.released}` : ""}`;

// ---------------------------------------------------------------- dates (Israel)

/** An ISO instant as the Israel calendar date `YYYY-MM-DD` ("" for null). */
export function isoToIsraelDate(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** `ends_at` is stored as the START of the day after the last valid day, so the owner's "until" date is the day before it. */
export function endsAtToLastDay(iso: string | null): string {
  return iso ? isoToIsraelDate(new Date(new Date(iso).getTime() - 60_000).toISOString()) : "";
}

export const todayInIsrael = (now: Date = new Date()): string => isoToIsraelDate(israelStartOfDay(now));

// ---------------------------------------------------------------- the form

export interface CouponFormValues {
  code: string;
  title: string;
  internalNote: string;
  discountType: DiscountType;
  percent: string;
  fixedShekel: string;
  maxDiscountShekel: string;
  minSubtotalShekel: string;
  startsOn: string; // YYYY-MM-DD, Israel
  endsOn: string; // YYYY-MM-DD, Israel, inclusive
  maxTotal: string;
  maxPerMember: string;
  firstOrderOnly: boolean;
  isActive: boolean;
}

export const EMPTY_FORM: CouponFormValues = {
  code: "",
  title: "",
  internalNote: "",
  discountType: "percent",
  percent: "",
  fixedShekel: "",
  maxDiscountShekel: "",
  minSubtotalShekel: "",
  startsOn: "",
  endsOn: "",
  maxTotal: "",
  maxPerMember: "1", // a sensible starting point the owner can change — never a fixed rule
  firstOrderOnly: false,
  isActive: true,
};

const centsToShekelText = (cents: number | null): string => (cents === null ? "" : String(cents / 100));

export function formFromCoupon(c: CouponRow): CouponFormValues {
  return {
    code: c.code,
    title: c.title,
    internalNote: c.internal_note ?? "",
    discountType: c.discount_type,
    percent: c.discount_type === "percent" && c.discount_value !== null ? String(c.discount_value) : "",
    fixedShekel: c.discount_type === "fixed" ? centsToShekelText(c.discount_value) : "",
    maxDiscountShekel: centsToShekelText(c.max_discount_cents),
    minSubtotalShekel: c.min_subtotal_cents > 0 ? centsToShekelText(c.min_subtotal_cents) : "",
    startsOn: isoToIsraelDate(c.starts_at),
    endsOn: endsAtToLastDay(c.ends_at),
    maxTotal: c.max_total_redemptions === null ? "" : String(c.max_total_redemptions),
    maxPerMember: c.max_per_member === null ? "" : String(c.max_per_member),
    firstOrderOnly: c.first_order_only,
    isActive: c.is_active,
  };
}

/** A copy for "duplicate": same terms, no code (it must be new), inactive until the owner turns it on. */
export const duplicateForm = (c: CouponRow): CouponFormValues => ({ ...formFromCoupon(c), code: "", title: `${c.title} (עותק)`, isActive: false });

export type FormProblem =
  | "code-empty" | "code-format" | "code-hebrew" | "code-taken"
  | "title" | "percent" | "fixed" | "max-discount" | "min-subtotal" | "dates" | "max-total" | "max-per-member";

export const PROBLEM_MESSAGES: Record<FormProblem, string> = {
  "code-empty": "יש להזין קוד קופון.",
  "code-format": "קוד קופון: אותיות אנגליות, ספרות, - ו-_ בלבד, 3 עד 24 תווים.",
  "code-hebrew": "קוד קופון נכתב באותיות אנגליות ובספרות בלבד (בלי עברית).",
  "code-taken": "קוד זה כבר קיים (גם קופון בארכיון שומר את הקוד שלו).",
  title: "יש להזין שם לקופון (עד 80 תווים).",
  percent: "אחוז ההנחה חייב להיות מספר שלם בין 1 ל-100.",
  fixed: "סכום ההנחה חייב להיות גדול מ-0.",
  "max-discount": "תקרת ההנחה חייבת להיות גדולה מ-0 (או ריקה).",
  "min-subtotal": "מינימום ההזמנה חייב להיות 0 או יותר.",
  dates: "תאריך הסיום חייב להיות אחרי תאריך ההתחלה.",
  "max-total": "מגבלת השימושים הכוללת חייבת להיות מספר שלם גדול מ-0 (או ריקה = ללא הגבלה).",
  "max-per-member": "מגבלת השימושים לחבר חייבת להיות מספר שלם גדול מ-0 (או ריקה = ללא הגבלה).",
};

const isPositiveInt = (text: string): boolean => /^\d+$/.test(text.trim()) && Number(text) >= 1;
const isMoney = (text: string): boolean => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0;
const toCents = (text: string): number => Math.round(Number(text) * 100);

/** Every problem with the form, keyed by field-ish problem name. `takenCodes` are normalized codes that already exist (archived ones too). */
export function validateForm(v: CouponFormValues, opts: { mode: "create" | "edit"; takenCodes: readonly string[]; financialLocked?: boolean }): FormProblem[] {
  const problems: FormProblem[] = [];
  if (opts.mode === "create") {
    const code = normalizeCouponCode(v.code);
    if (code === "") problems.push("code-empty");
    else if (containsHebrew(code)) problems.push("code-hebrew");
    else if (!COUPON_CODE_PATTERN.test(code)) problems.push("code-format");
    else if (opts.takenCodes.includes(code)) problems.push("code-taken");
  }
  if (v.title.trim() === "" || v.title.trim().length > 80) problems.push("title");
  if (!opts.financialLocked) {
    if (v.discountType === "percent") {
      if (!/^\d+$/.test(v.percent.trim()) || Number(v.percent) < 1 || Number(v.percent) > 100) problems.push("percent");
      if (v.maxDiscountShekel.trim() !== "" && !(isMoney(v.maxDiscountShekel) && toCents(v.maxDiscountShekel) > 0)) problems.push("max-discount");
    } else if (v.discountType === "fixed") {
      if (!(isMoney(v.fixedShekel) && toCents(v.fixedShekel) >= 1)) problems.push("fixed");
    }
  }
  if (v.minSubtotalShekel.trim() !== "" && !isMoney(v.minSubtotalShekel)) problems.push("min-subtotal");
  if (v.startsOn && v.endsOn && israelDateToIso(v.startsOn) !== null && israelDateToIso(v.endsOn, true) !== null
      && new Date(israelDateToIso(v.startsOn)!).getTime() >= new Date(israelDateToIso(v.endsOn, true)!).getTime()) problems.push("dates");
  if (v.maxTotal.trim() !== "" && !isPositiveInt(v.maxTotal)) problems.push("max-total");
  if (v.maxPerMember.trim() !== "" && !isPositiveInt(v.maxPerMember)) problems.push("max-per-member");
  return problems;
}

/** The body for an insert (`create`) or an update. With `financialLocked` the code/type/value are left out — the database refuses to change them once used. */
export function toPayload(v: CouponFormValues, opts: { mode: "create" | "edit"; financialLocked?: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: v.title.trim(),
    internal_note: v.internalNote.trim() === "" ? null : v.internalNote.trim(),
    min_subtotal_cents: v.minSubtotalShekel.trim() === "" ? 0 : toCents(v.minSubtotalShekel),
    starts_at: v.startsOn ? israelDateToIso(v.startsOn) : null,
    ends_at: v.endsOn ? israelDateToIso(v.endsOn, true) : null,
    max_total_redemptions: v.maxTotal.trim() === "" ? null : Number(v.maxTotal),
    max_per_member: v.maxPerMember.trim() === "" ? null : Number(v.maxPerMember),
    first_order_only: v.firstOrderOnly,
    is_active: v.isActive,
  };
  if (opts.mode === "create") body.code = normalizeCouponCode(v.code);
  if (!opts.financialLocked) {
    body.discount_type = v.discountType;
    body.discount_value = v.discountType === "percent" ? Number(v.percent) : v.discountType === "fixed" ? toCents(v.fixedShekel) : null;
    body.max_discount_cents = v.discountType === "percent" && v.maxDiscountShekel.trim() !== "" ? toCents(v.maxDiscountShekel) : null;
  }
  return body;
}

// ---------------------------------------------------------------- reading the usage list

/** A delivery address reduced to what makes two orders "the same door" (case/space-insensitive). */
export const addressKey = (o: NonNullable<RedemptionRow["orders"]>): string =>
  [o.street, o.house_number, o.apartment ?? ""].map((p) => p.trim().toLowerCase().replace(/\s+/g, " ")).join("|");

/** Address keys on which MORE THAN ONE phone redeemed this coupon (a hint for the owner, never a block). */
export function sharedAddressKeys(rows: readonly RedemptionRow[]): Set<string> {
  const phonesByAddress = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.orders || r.status === "released") continue;
    const key = addressKey(r.orders);
    const phones = phonesByAddress.get(key) ?? new Set<string>();
    phones.add(r.phone_e164);
    phonesByAddress.set(key, phones);
  }
  return new Set([...phonesByAddress].filter(([, phones]) => phones.size > 1).map(([key]) => key));
}

/** How many times this phone's redemptions were released after the order had already left for delivery. */
export function afterDispatchReleases(rows: readonly RedemptionRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) if (r.released_reason === "order_cancelled_after_dispatch") out.set(r.phone_e164, (out.get(r.phone_e164) ?? 0) + 1);
  return out;
}

export const RELEASE_LABEL: Record<string, string> = {
  order_cancelled_before_dispatch: "ההזמנה בוטלה לפני יציאה למשלוח",
  order_cancelled_after_dispatch: "ההזמנה בוטלה אחרי יציאה למשלוח",
  reservation_expired: "ההמתנה לתשלום פגה",
  payment_failed: "התשלום נכשל",
};

export const REDEMPTION_LABEL: Record<RedemptionStatus, string> = { reserved: "שמור (ממתין לתשלום)", redeemed: "מומש", released: "שוחרר" };

export const EVENT_LABEL: Record<CouponEventRow["kind"], string> = {
  created: "נוצר", updated: "עודכן", enabled: "הופעל", disabled: "הושבת", archived: "הועבר לארכיון", restored: "שוחזר מהארכיון",
};

export const CHANGE_FIELD_LABEL: Record<string, string> = {
  title: "שם", internal_note: "הערה פנימית", discount_type: "סוג הנחה", discount_value: "ערך ההנחה", max_discount_cents: "תקרת הנחה (אג׳)",
  min_subtotal_cents: "מינימום הזמנה (אג׳)", starts_at: "התחלה", ends_at: "סיום", is_active: "פעיל", max_total_redemptions: "מגבלת שימושים כוללת",
  max_per_member: "מגבלה לחבר", first_order_only: "הזמנה ראשונה בלבד", archived_at: "ארכיון",
};

/** Phone as the owner reads it: +972501234567 -> 050-123-4567. */
export function formatPhoneLocal(e164: string): string {
  const m = /^\+9725(\d)(\d{3})(\d{4})$/.exec(e164);
  return m ? `05${m[1]}-${m[2]}-${m[3]}` : e164;
}

// ---------------------------------------------------------------- parsing what the database returned

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCoupons(value: unknown): CouponRow[] | null {
  if (!Array.isArray(value)) return null;
  const out: CouponRow[] = [];
  for (const v of value) {
    if (!isObj(v) || typeof v.id !== "string" || typeof v.code !== "string" || typeof v.title !== "string" || typeof v.discount_type !== "string") return null;
    out.push(v as unknown as CouponRow);
  }
  return out;
}

export function parseRedemptions(value: unknown): RedemptionRow[] | null {
  if (!Array.isArray(value)) return null;
  const out: RedemptionRow[] = [];
  for (const v of value) {
    if (!isObj(v) || typeof v.id !== "string" || typeof v.coupon_id !== "string" || typeof v.status !== "string") return null;
    out.push(v as unknown as RedemptionRow);
  }
  return out;
}

export function parseEvents(value: unknown): CouponEventRow[] | null {
  if (!Array.isArray(value)) return null;
  const out: CouponEventRow[] = [];
  for (const v of value) {
    if (!isObj(v) || typeof v.kind !== "string" || typeof v.actor_label !== "string") return null;
    out.push(v as unknown as CouponEventRow);
  }
  return out;
}

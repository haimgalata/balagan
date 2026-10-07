/**
 * Pure order-management model: statuses, labels, which moves are offered to whom, search-filter building and
 * small formatters. No React, no Supabase — unit-tested directly. The DATABASE is what actually enforces the
 * transition rules (`transition_order()`, migrations 0010/0015); this only decides what the screen offers.
 *
 * Two lifecycles (migration 0015): delivery  confirmed -> preparing -> out_for_delivery -> completed
 *                                   pickup    confirmed -> preparing -> ready_for_pickup -> completed
 */
import type { AdminRole } from "@/admin/useAdminSession";

export type OrderStatus = "pending" | "confirmed" | "preparing" | "out_for_delivery" | "ready_for_pickup" | "completed" | "cancelled" | "expired";
export type FulfillmentMethod = "delivery" | "pickup";
export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled";
export type PaymentMethod = "cash" | "card";
export type StockReturnStatus = "none" | "restored" | "pending_return" | "written_off";

export interface OrderItemRow {
  id: number;
  product_id: string | null;
  product_name_snapshot: string;
  product_brand_snapshot: string | null;
  option: "unit" | "package";
  option_label_snapshot: string;
  unit_price_cents: number;
  quantity: number;
  base_units: number;
  line_total_cents: number;
}

export interface OrderEventRow {
  id: number;
  kind: "created" | "status" | "payment" | "stock_return";
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_label: string;
  actor_role: AdminRole | null;
  created_at: string;
}

export interface OrderRow {
  id: string;
  order_number: number;
  payment_method: PaymentMethod;
  /** Missing only on rows read before migration 0015 = delivery. */
  fulfillment_method?: FulfillmentMethod;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  /** NULL for a pickup order. */
  city: string | null;
  street: string | null;
  house_number: string | null;
  entrance: string | null;
  floor: string | null;
  apartment: string | null;
  intercom_code: string | null;
  delivery_notes: string | null;
  subtotal_cents: number;
  delivery_fee_cents: number;
  discount_cents: number;
  /** The coupon applied to this order (permanent snapshot), if any. */
  coupon_code_snapshot?: string | null;
  total_cents: number;
  created_at: string;
  confirmed_at: string | null;
  status_changed_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  stock_return_status: StockReturnStatus;
  order_items?: OrderItemRow[];
  order_status_events?: OrderEventRow[];
}

/** Statuses that are still "in the shop's hands" — the Active board's lanes. */
export const ACTIVE_STATUSES = ["confirmed", "preparing", "out_for_delivery", "ready_for_pickup"] as const;
export const FINISHED_STATUSES = ["completed", "cancelled", "expired"] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export const isActive = (status: OrderStatus): status is ActiveStatus => (ACTIVE_STATUSES as readonly string[]).includes(status);

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "ממתינה לתשלום",
  confirmed: "חדשה",
  preparing: "בהכנה",
  out_for_delivery: "בדרך ללקוח",
  ready_for_pickup: "מוכנה לאיסוף",
  completed: "נמסרה",
  cancelled: "בוטלה",
  expired: "פג תוקף",
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: "טרם שולם",
  paid: "שולם",
  failed: "נכשל",
  cancelled: "בוטל",
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { cash: "מזומן", card: "כרטיס אשראי" };

export const STOCK_RETURN_LABEL: Record<StockReturnStatus, string> = {
  none: "",
  restored: "המלאי הוחזר",
  pending_return: "ממתין להחזרת המוצרים למלאי",
  written_off: "המוצרים לא הוחזרו (נמחקו מהמלאי)",
};

export const isPickup = (o: Pick<OrderRow, "fulfillment_method">): boolean => o.fulfillment_method === "pickup";

/** The status in words for THIS order: a finished pickup order was collected ("נאספה"), not delivered. */
export function statusLabel(status: OrderStatus, fulfillment: FulfillmentMethod = "delivery"): string {
  if (status === "completed" && fulfillment === "pickup") return "נאספה";
  return STATUS_LABEL[status];
}

/** The step before "completed" for each way of receiving an order. */
const lastStep = (fulfillment: FulfillmentMethod): OrderStatus => (fulfillment === "pickup" ? "ready_for_pickup" : "out_for_delivery");

/** What the "main" button does for an active order, or null when there's nothing to advance. */
export interface AdvanceAction {
  to: OrderStatus;
  label: string;
}
export function advanceAction(status: OrderStatus, fulfillment: FulfillmentMethod = "delivery"): AdvanceAction | null {
  const pickup = fulfillment === "pickup";
  switch (status) {
    case "confirmed":
      return { to: "preparing", label: "התחל הכנה" };
    case "preparing":
      return pickup ? { to: "ready_for_pickup", label: "מוכנה לאיסוף" } : { to: "out_for_delivery", label: "יצאה למשלוח" };
    case "out_for_delivery":
      return pickup ? null : { to: "completed", label: "נמסרה" };
    case "ready_for_pickup":
      return pickup ? { to: "completed", label: "נאספה" } : null;
    default:
      return null;
  }
}

/** One step back, when allowed (mis-tap recovery). Reopening a completed order is owner-only. */
export function backAction(status: OrderStatus, role: AdminRole, fulfillment: FulfillmentMethod = "delivery"): AdvanceAction | null {
  switch (status) {
    case "preparing":
      return { to: "confirmed", label: "חזרה ל״חדשה״" };
    case "out_for_delivery":
    case "ready_for_pickup":
      return status === lastStep(fulfillment) ? { to: "preparing", label: "חזרה להכנה" } : null;
    case "completed":
      return role === "owner" ? { to: lastStep(fulfillment), label: "פתיחה מחדש" } : null;
    default:
      return null;
  }
}

export const canCancel = (status: OrderStatus): boolean => isActive(status);

/** True when cancelling now keeps the stock out of inventory until the goods are confirmed back (a pickup order never
 * left the store, so cancelling it while "ready" restores stock at once). */
export const cancelHoldsStock = (status: OrderStatus): boolean => status === "out_for_delivery";

export const CANCEL_REASONS = ["הלקוח ביטל", "מוצר חסר במלאי", "הלקוח לא ענה / לא נמצא", "כתובת לא תקינה / מחוץ לאזור", "אחר"] as const;
export const PICKUP_CANCEL_REASONS = ["הלקוח ביטל", "מוצר חסר במלאי", "הלקוח לא הגיע לאסוף", "אחר"] as const;
export const cancelReasons = (fulfillment: FulfillmentMethod = "delivery"): readonly string[] =>
  fulfillment === "pickup" ? PICKUP_CANCEL_REASONS : CANCEL_REASONS;
export const OTHER_REASON = "אחר";

// ---- search ---------------------------------------------------------------------------------------------------

/**
 * PostgREST `or=` filter for the free-text search box, or null for an empty search.
 * Digits (a phone number or an order number) match order_number / phone_digits; anything else matches name and
 * street. The text is reduced to safe characters first — a filter string is a tiny grammar, and a comma or
 * parenthesis typed into the box must never be able to alter it.
 */
export function buildSearchFilter(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const digits = text.replace(/[\s\-().+#]/g, "");
  if (/^\d+$/.test(digits)) {
    const parts = [`phone_digits.ilike.*${digits}*`];
    if (digits.length <= 9) parts.unshift(`order_number.eq.${Number(digits)}`);
    return parts.join(",");
  }
  const safe = text.replace(/[^\p{L}\p{N} '"׳״-]/gu, " ").replace(/["]/g, "").replace(/\s+/g, " ").trim();
  if (safe === "") return null;
  return [`first_name.ilike.*${safe}*`, `last_name.ilike.*${safe}*`, `street.ilike.*${safe}*`].join(",");
}

// ---- time / money ---------------------------------------------------------------------------------------------

/** The instant Israel's current calendar day began (Asia/Jerusalem), as ISO — the "today" of "finished today". */
export function israelStartOfDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const israelWallAsUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  const offsetMs = israelWallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(n("year"), n("month") - 1, n("day")) - offsetMs).toISOString();
}

/** A `YYYY-MM-DD` date input value as the start of that day in Israel (ISO), or the start of the NEXT day when `endOfDay`. */
export function israelDateToIso(date: string, endOfDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d + (endOfDay ? 1 : 0), 12));
  return israelStartOfDay(noon);
}

export const formatShekel = (cents: number): string =>
  `₪${(cents / 100).toLocaleString("he-IL", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });

/** "לפני 5 דק׳" / "לפני 2 שעות" / "לפני 3 ימים". */
export function formatAge(fromIso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} ${hours === 1 ? "שעה" : "שעות"}`;
  const days = Math.floor(hours / 24);
  return `לפני ${days} ${days === 1 ? "יום" : "ימים"}`;
}

/** An unhandled order waiting this long is flagged red. */
export const STALE_NEW_ORDER_MS = 10 * 60_000;
/** An order still open after this long is almost certainly forgotten (e.g. yesterday's). */
export const FORGOTTEN_ORDER_MS = 12 * 60 * 60_000;

export const fullName = (o: Pick<OrderRow, "first_name" | "last_name">): string => `${o.first_name} ${o.last_name}`.trim();

export function addressLine(o: Pick<OrderRow, "street" | "house_number" | "city" | "fulfillment_method">): string {
  if (o.fulfillment_method === "pickup") return "איסוף עצמי מהחנות";
  return `${o.street ?? ""} ${o.house_number ?? ""}, ${o.city ?? ""}`;
}

/** Entrance / floor / apartment / intercom, only the ones present. */
export function addressDetails(o: Pick<OrderRow, "entrance" | "floor" | "apartment" | "intercom_code">): string[] {
  return [
    o.entrance ? `כניסה ${o.entrance}` : null,
    o.floor ? `קומה ${o.floor}` : null,
    o.apartment ? `דירה ${o.apartment}` : null,
    o.intercom_code ? `קוד אינטרקום ${o.intercom_code}` : null,
  ].filter((x): x is string => x !== null);
}

/** Order kinds the board treats specially. */
export const needsStockReturn = (o: Pick<OrderRow, "order_status" | "stock_return_status">): boolean =>
  o.order_status === "cancelled" && o.stock_return_status === "pending_return";

/** Paid money with no order behind it (expired/cancelled after paying) — the "needs manual attention" signal from 0009. */
export const paidButDead = (o: Pick<OrderRow, "order_status" | "payment_status">): boolean =>
  o.payment_status === "paid" && (o.order_status === "expired" || o.order_status === "cancelled");

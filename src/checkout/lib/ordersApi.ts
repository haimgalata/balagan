/**
 * Creates a real order via `create_order()` (supabase/migrations/0009_orders.sql) — one plain `fetch`, no
 * client library, same pattern as catalogApi.ts/stockApi.ts (this file must stay free of
 * `@supabase/supabase-js` so the customer bundle does too).
 *
 * The RPC re-validates everything server-side (prices, stock, minimum order, required fields, age/terms) —
 * this client only shapes the payload and translates the RPC's outcome; it never decides whether an order
 * is allowed.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";
import type { PurchaseOption } from "@/storefront/types";
import { describeCouponReason, isCouponErrorCode } from "@/checkout/lib/couponMessages";
import type { FulfillmentMethod } from "@/storefront/lib/fulfillment";

export type PaymentMethod = "cash" | "card";

export interface OrderItemPayload {
  productId: string;
  option: PurchaseOption;
  quantity: number;
}

export interface OrderCustomerPayload {
  /** Pickup orders carry no address (the database ignores one if sent). Missing = delivery, as before migration 0015. */
  fulfillmentMethod?: FulfillmentMethod;
  /** Delivery only, and only once the owner has defined windows (migration 0017): the departure slot the customer chose. */
  deliveryWindowId?: string | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercomCode: string;
  notes: string;
  ageConfirmed: boolean;
  termsAccepted: boolean;
}

export interface CreateOrderResult {
  orderId: string;
  orderNumber: number;
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: PaymentMethod;
  fulfillmentMethod: FulfillmentMethod;
  totalCents: number;
  /** What a club coupon took off (0 when none). */
  discountCents: number;
  paymentAttemptId: string | null;
}

/** `code` is the RPC's raised error token (e.g. "INSUFFICIENT_STOCK", "BELOW_MINIMUM_ORDER") when known,
 * or a generic fallback for a network/shape failure. See `describeOrderError` for the Hebrew message. */
export class OrderCreationError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

function toRpcPayload(items: OrderItemPayload[], paymentMethod: PaymentMethod, customer: OrderCustomerPayload, couponCode?: string) {
  const pickup = customer.fulfillmentMethod === "pickup";
  return {
    fulfillment_method: pickup ? "pickup" : "delivery",
    ...(!pickup && customer.deliveryWindowId ? { delivery_window_id: customer.deliveryWindowId } : {}),
    // only the CODE is sent: the database validates it for the caller's own identity and prices it itself
    ...(couponCode ? { coupon_code: couponCode } : {}),
    items: items.map((item) => ({ product_id: item.productId, option: item.option, quantity: item.quantity })),
    payment_method: paymentMethod,
    customer: {
      first_name: customer.firstName,
      last_name: customer.lastName,
      phone: customer.phone,
      email: customer.email || null,
      city: pickup ? null : customer.city,
      street: pickup ? null : customer.street,
      house_number: pickup ? null : customer.houseNumber,
      entrance: (!pickup && customer.entrance) || null,
      floor: (!pickup && customer.floor) || null,
      apartment: (!pickup && customer.apartment) || null,
      intercom_code: (!pickup && customer.intercomCode) || null,
      notes: customer.notes || null,
      age_confirmed: customer.ageConfirmed,
      terms_accepted: customer.termsAccepted,
    },
  };
}

function extractErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string") return null;
  const match = /^([A-Z_]+)/.exec(message);
  return match ? match[1] : message;
}

interface RpcCreateOrderResult {
  order_id: string;
  order_number: number;
  order_status: string;
  payment_status: string;
  payment_method: string;
  fulfillment_method?: string;
  total_cents: number;
  discount_cents?: number;
  payment_attempt_id: string | null;
}

function isRpcCreateOrderResult(value: unknown): value is RpcCreateOrderResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.order_id === "string" &&
    typeof v.order_number === "number" &&
    typeof v.order_status === "string" &&
    typeof v.payment_status === "string" &&
    typeof v.payment_method === "string" &&
    typeof v.total_cents === "number"
  );
}

export async function createOrder(
  config: CatalogConfig,
  items: OrderItemPayload[],
  paymentMethod: PaymentMethod,
  customer: OrderCustomerPayload,
  idempotencyKey: string,
  /**
   * A signed-in club member's bearer token. With it the request runs as that member, so the DATABASE attaches the
   * order to their account (migration 0012's trigger reads auth.uid()); a customer id is never sent in the body.
   * Without it (guests, or anyone whose profile couldn't be loaded) the request is anonymous, exactly as before.
   */
  memberAccessToken?: string,
  /** A club coupon code (members only — the database refuses it for anyone else). */
  couponCode?: string
): Promise<CreateOrderResult> {
  if (config.source !== "supabase") {
    // Static/offline mode has no live database to write to.
    throw new OrderCreationError("STATIC_MODE_UNAVAILABLE");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/create_order`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        ...(memberAccessToken
          ? { Authorization: `Bearer ${memberAccessToken}` }
          : config.anonKey.startsWith("eyJ")
            ? { Authorization: `Bearer ${config.anonKey}` }
            : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_payload: toRpcPayload(items, paymentMethod, customer, couponCode),
        p_idempotency_key: idempotencyKey,
      }),
      signal: controller.signal,
    });

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new OrderCreationError(extractErrorCode(body) ?? `HTTP_${response.status}`);
    }
    if (!isRpcCreateOrderResult(body)) {
      throw new OrderCreationError("UNEXPECTED_RESPONSE");
    }

    return {
      orderId: body.order_id,
      orderNumber: body.order_number,
      orderStatus: body.order_status,
      paymentStatus: body.payment_status,
      paymentMethod: body.payment_method as PaymentMethod,
      fulfillmentMethod: body.fulfillment_method === "pickup" ? "pickup" : "delivery",
      totalCents: body.total_cents,
      discountCents: typeof body.discount_cents === "number" ? body.discount_cents : 0,
      paymentAttemptId: body.payment_attempt_id,
    };
  } catch (error) {
    if (error instanceof OrderCreationError) throw error;
    throw new OrderCreationError("NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INSUFFICIENT_STOCK: "אחד או יותר מהמוצרים בסל אינו זמין יותר בכמות המבוקשת. אפשר לעדכן את הכמות בסל ולנסות שוב.",
  OUT_OF_STOCK: "אחד או יותר מהמוצרים בסל אזל. אפשר להסיר אותו מהסל ולנסות שוב.",
  PRODUCT_UNAVAILABLE: "אחד או יותר מהמוצרים בסל כבר אינו זמין. אפשר לעדכן את הסל ולנסות שוב.",
  BELOW_MINIMUM_ORDER: "סכום ההזמנה נמוך ממינימום ההזמנה.",
  UNSUPPORTED_CITY: "משלוח זמין כרגע רק בעיר נתיבות.",
  AGE_NOT_CONFIRMED: "יש לאשר את הצהרת הגיל כדי להמשיך.",
  TERMS_NOT_ACCEPTED: "יש לאשר את התקנון כדי להמשיך.",
  STATIC_MODE_UNAVAILABLE: "לא ניתן להשלים הזמנה במצב זה.",
  ORDERS_CLOSED: "ההזמנות באתר סגורות כרגע. אפשר לנסות שוב בשעות ההזמנה.",
  FULFILLMENT_UNAVAILABLE: "אופן קבלת ההזמנה השתנה בינתיים. רעננו את הדף ונסו שוב.",
  PAYMENT_METHOD_UNAVAILABLE: "אופן התשלום שנבחר אינו זמין כרגע. רעננו את הדף ונסו שוב.",
  WINDOW_REQUIRED: "יש לבחור חלון משלוח.",
  WINDOW_UNAVAILABLE: "חלון המשלוח שנבחר כבר אינו זמין (ההזמנה אליו נסגרה). אפשר לבחור חלון אחר.",
  WINDOW_FULL: "חלון המשלוח שנבחר התמלא. אפשר לבחור חלון אחר.",
};

/** Hebrew message for an order-creation failure; falls back to a generic retry message for anything not
 * explicitly mapped (a network error, an unexpected response shape, or a validation gap that shouldn't
 * happen given the form's own checks but must still fail safely if it ever does). */
export function describeOrderError(code: string): string {
  if (isCouponErrorCode(code)) return describeCouponReason(code);
  return ERROR_MESSAGES[code] ?? "לא ניתן להשלים את ההזמנה כרגע. בדקו את החיבור ונסו שוב.";
}

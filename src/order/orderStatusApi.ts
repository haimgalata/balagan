/**
 * Reads one order's status via `get_order_status()` (migrations 0009/0015) — one plain `fetch`, no client library,
 * same pattern as catalogApi.ts. The answer has no personal data: number, statuses, payment/fulfillment method, total.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";
import type { CustomerFulfillment } from "@/order/orderStatusText";

export interface PublicOrderStatus {
  orderNumber: number;
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentMethod: CustomerFulfillment;
  totalCents: number;
}

const REQUEST_TIMEOUT_MS = 8000;

export function parsePublicOrderStatus(value: unknown): PublicOrderStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.order_number !== "number" || typeof v.order_status !== "string" || typeof v.payment_status !== "string"
    || typeof v.payment_method !== "string" || typeof v.total_cents !== "number") return null;
  return {
    orderNumber: v.order_number,
    orderStatus: v.order_status,
    paymentStatus: v.payment_status,
    paymentMethod: v.payment_method,
    fulfillmentMethod: v.fulfillment_method === "pickup" ? "pickup" : "delivery",
    totalCents: v.total_cents,
  };
}

/** The order's status, `null` when no such order exists; throws on a network/server failure. */
export async function fetchOrderStatus(config: CatalogConfig, orderId: string): Promise<PublicOrderStatus | null> {
  if (config.source !== "supabase") throw new Error("no database in this mode");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_order_status`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        ...(config.anonKey.startsWith("eyJ") ? { Authorization: `Bearer ${config.anonKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_order_id: orderId }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`order status request failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (body === null) return null;
    const status = parsePublicOrderStatus(body);
    if (!status) throw new Error("order status response has an unexpected shape");
    return status;
  } finally {
    window.clearTimeout(timer);
  }
}

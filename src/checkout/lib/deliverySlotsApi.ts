/**
 * Today's delivery windows with a yes/no each, from the public RPC `get_delivery_slots()` (migration 0017) —
 * one plain `fetch`, no client library (the customer bundle stays free of supabase-js). It never carries a
 * capacity or an order count; the database still decides when an order is created.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";
import { parseDeliverySlots, type DeliverySlot } from "@/storefront/lib/deliveryWindows";

const REQUEST_TIMEOUT_MS = 8000;

export async function fetchDeliverySlots(config: CatalogConfig): Promise<DeliverySlot[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_delivery_slots`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        ...(config.anonKey.startsWith("eyJ") ? { Authorization: `Bearer ${config.anonKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`delivery slots request failed: HTTP ${response.status}`);
    const slots = parseDeliverySlots(await response.json());
    if (!slots) throw new Error("delivery slots response has an unexpected shape");
    return slots;
  } finally {
    window.clearTimeout(timer);
  }
}

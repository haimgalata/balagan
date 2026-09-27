/**
 * Reads the public business settings (physical-store hours, online-order hours, minimum order, delivery
 * fee, manual pause) from Supabase.
 *
 * Same architecture as `catalogApi.ts`: the storefront has NO access to the database tables — anonymous
 * visitors can only call the whitelisted RPC `get_business_settings()` (see
 * supabase/migrations/0008_business_settings.sql). One plain `fetch`, no client library, only the public
 * anon key. Whatever comes back is validated structurally before it can reach the UI or the cache.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";

export interface RpcHour {
  day_of_week: number; // 0 (Sunday) .. 6 (Saturday)
  is_open: boolean;
  open_time: string | null; // "HH:MM:SS", null when closed
  close_time: string | null;
}
export interface RpcBusinessSettings {
  store_hours: RpcHour[]; // always 7 entries
  order_hours: RpcHour[]; // always 7 entries
  min_order_cents: number;
  delivery_fee_cents: number;
  orders_paused: boolean;
}

// ---------------------------------------------------------------- validation
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function isHour(v: unknown): v is RpcHour {
  return isObj(v) && isNum(v.day_of_week) && typeof v.is_open === "boolean" && isStrOrNull(v.open_time) && isStrOrNull(v.close_time);
}
function isWeek(v: unknown): v is RpcHour[] {
  return Array.isArray(v) && v.length === 7 && v.every(isHour);
}

/** Returns the settings if (and only if) they have the exact expected shape, else null. */
export function parseRpcBusinessSettings(value: unknown): RpcBusinessSettings | null {
  if (!isObj(value)) return null;
  if (!isWeek(value.store_hours) || !isWeek(value.order_hours)) return null;
  if (!isNum(value.min_order_cents) || !isNum(value.delivery_fee_cents) || typeof value.orders_paused !== "boolean") return null;
  return value as unknown as RpcBusinessSettings;
}

// ---------------------------------------------------------------------- fetch
const REQUEST_TIMEOUT_MS = 8000;

export async function fetchBusinessSettings(config: CatalogConfig): Promise<RpcBusinessSettings> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_business_settings`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        ...(config.anonKey.startsWith("eyJ") ? { Authorization: `Bearer ${config.anonKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`business settings request failed: HTTP ${response.status}`);
    const settings = parseRpcBusinessSettings(await response.json());
    if (!settings) throw new Error("business settings response has an unexpected shape");
    return settings;
  } finally {
    window.clearTimeout(timer);
  }
}

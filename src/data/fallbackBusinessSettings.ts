/**
 * Offline fallback for the storefront's business settings — used exactly like `fallbackCatalog.ts`: when
 * `VITE_CATALOG_SOURCE=static`, or when the live `get_business_settings()` RPC can't be reached and there's
 * no cache yet either. Hand-maintained (unlike the generated `fallbackCatalog.ts`) since it's tiny — these
 * are the same placeholder values `src/data/businessHours.ts` and `src/data/deliveryInfo.ts` used to hold
 * before both moved into the database (supabase/migrations/0008_business_settings.sql).
 */
import type { RpcBusinessSettings, RpcHour } from "@/lib/businessSettingsApi";

const PLACEHOLDER_WEEK: RpcHour[] = [
  { day_of_week: 0, is_open: true, open_time: "09:00", close_time: "23:00" }, // ראשון
  { day_of_week: 1, is_open: true, open_time: "09:00", close_time: "23:00" }, // שני
  { day_of_week: 2, is_open: true, open_time: "09:00", close_time: "23:00" }, // שלישי
  { day_of_week: 3, is_open: true, open_time: "09:00", close_time: "23:00" }, // רביעי
  { day_of_week: 4, is_open: true, open_time: "09:00", close_time: "23:00" }, // חמישי
  { day_of_week: 5, is_open: true, open_time: "09:00", close_time: "16:00" }, // שישי
  { day_of_week: 6, is_open: false, open_time: null, close_time: null }, // שבת
];

export const fallbackBusinessSettings: RpcBusinessSettings = {
  store_hours: PLACEHOLDER_WEEK,
  order_hours: PLACEHOLDER_WEEK,
  min_order_cents: 5000,
  delivery_fee_cents: 1500,
  orders_paused: false,
};

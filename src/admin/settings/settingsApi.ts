import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type AdminError, type RawApiError } from "@/admin/settings/settingsErrors";

/**
 * Reads and writes for the Business Settings screen. Everything goes through the signed-in admin's own
 * session, so Row Level Security decides what is allowed (see supabase/migrations/0008_business_settings.sql —
 * only an admin can read or change these tables); this file only shapes the requests and turns failures into
 * messages. Every function resolves — it never throws.
 */
export type ScheduleType = "store" | "orders";

export interface BusinessHourRow {
  day_of_week: number; // 0 (Sunday) .. 6 (Saturday) — matches JS Date#getDay()
  is_open: boolean;
  /** Postgres `time`, e.g. "09:00:00"; null when the day is closed. */
  open_time: string | null;
  close_time: string | null;
}

export interface BusinessSettingsRow {
  min_order_cents: number;
  delivery_fee_cents: number;
  orders_paused: boolean;
  // Migration 0015 — undefined until it has been applied (the screen then asks for it).
  pickup_enabled?: boolean;
  delivery_enabled?: boolean;
  cash_enabled?: boolean;
  card_enabled?: boolean;
  store_address_text?: string | null;
  // Migration 0016 — owner-only cost settings, never part of get_business_settings().
  vat_percent?: number | string;
  low_margin_percent?: number | string;
}

export interface BusinessSettingsData {
  /** always exactly 7 rows, ordered by day_of_week */
  storeHours: BusinessHourRow[];
  /** always exactly 7 rows, ordered by day_of_week */
  orderHours: BusinessHourRow[];
  settings: BusinessSettingsRow;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AdminError };

const fail = (error: RawApiError): { ok: false; error: AdminError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: AdminError } =>
  fail({ code: "", message: e instanceof Error ? e.message : String(e) });

const HOUR_COLUMNS = "day_of_week,is_open,open_time,close_time";

export async function loadBusinessSettingsData(client: SupabaseClient): Promise<ApiResult<BusinessSettingsData>> {
  try {
    const [hours, settings] = await Promise.all([
      client.from("business_hours").select(`schedule_type,${HOUR_COLUMNS}`).order("day_of_week"),
      client.from("business_settings").select("*").eq("id", 1).single(),
    ]);
    const error = hours.error ?? settings.error;
    if (error) return fail(error);

    const rows = (hours.data ?? []) as (BusinessHourRow & { schedule_type: ScheduleType })[];
    return {
      ok: true,
      data: {
        storeHours: rows.filter((r) => r.schedule_type === "store"),
        orderHours: rows.filter((r) => r.schedule_type === "orders"),
        settings: settings.data as BusinessSettingsRow,
      },
    };
  } catch (e) {
    return unexpected(e);
  }
}

async function write(run: () => PromiseLike<{ error: RawApiError | null }>): Promise<ApiResult<null>> {
  try {
    const { error } = await run();
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

/** Saves one day of one schedule. Callers batch all 7 days of a schedule together (see BusinessSettingsPage). */
export const updateBusinessHourDay = (
  client: SupabaseClient,
  scheduleType: ScheduleType,
  dayOfWeek: number,
  fields: Pick<BusinessHourRow, "is_open" | "open_time" | "close_time">
) => write(() => client.from("business_hours").update(fields).eq("schedule_type", scheduleType).eq("day_of_week", dayOfWeek));

/** The singleton settings row (min order / delivery fee / manual pause) — there is always exactly one, id = 1. */
export const updateBusinessSettings = (client: SupabaseClient, fields: Partial<BusinessSettingsRow>) =>
  write(() => client.from("business_settings").update(fields).eq("id", 1));

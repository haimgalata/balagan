import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type OrderError, type RawApiError } from "@/admin/orders/ordersErrors";
import { parsePayroll, type Payroll } from "@/admin/couriers/couriersModel";

/**
 * Reads and writes of the owner's courier-pay screen (migration 0018). Everything is an owner-only function (or the owner's
 * own settings row): the database re-checks who is asking; nothing here reads a pay table directly (there is no such access).
 * Every function resolves — none throws.
 */
export type PayResult<T> = { ok: true; data: T } | { ok: false; error: OrderError };

const MESSAGES: [RegExp, string][] = [
  [/INVALID_AMOUNT/, "הסכום שהוזן אינו תקין."],
  [/NOT_A_COURIER/, "החשבון הזה אינו שליח."],
  [/NO_PAY_RECORD/, "לא נמצא תיעוד תשלום להזמנה הזו."],
];

function fail(error: RawApiError): { ok: false; error: OrderError } {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  const known = MESSAGES.find(([pattern]) => pattern.test(text));
  if (known) return { ok: false, error: { kind: "unknown", message: known[1] } };
  const described = describeError(error);
  // a database without migration 0018 says so instead of failing in silence
  if (described.kind === "setup-needed") return { ok: false, error: { ...described, message: "חסר עדכון במסד הנתונים: יש להריץ את supabase/migrations/0018_courier_pay.sql ואז לרענן את העמוד." } };
  return { ok: false, error: described };
}
const unexpected = (e: unknown): { ok: false; error: OrderError } => fail({ code: "", message: e instanceof Error ? e.message : String(e) });

async function call(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<PayResult<null>> {
  try {
    const { error } = await client.rpc(fn, args);
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

export async function loadPayroll(client: SupabaseClient, month: string): Promise<PayResult<Payroll>> {
  try {
    const { data, error } = await client.rpc("admin_courier_payroll", { p_month: month });
    if (error) return fail(error);
    const payroll = parsePayroll(data);
    return payroll ? { ok: true, data: payroll } : fail({ code: "", message: "unexpected response" });
  } catch (e) {
    return unexpected(e);
  }
}

/** The default amount a courier earns per delivery (his own rate, if set, overrides it). */
export async function setDefaultRate(client: SupabaseClient, cents: number): Promise<PayResult<null>> {
  try {
    const { error } = await client.from("business_settings").update({ courier_pay_cents: cents }).eq("id", 1);
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

/** One courier's own rate; `null` clears it (back to the default). Applies to deliveries closed from now on. */
export const setCourierRate = (client: SupabaseClient, courierId: string, cents: number | null) =>
  call(client, "admin_set_courier_rate", { p_user_id: courierId, p_cents: cents });

/** What one delivery pays — the owner's decision on a failed delivery, or a correction. */
export const setOrderPay = (client: SupabaseClient, orderId: string, cents: number) => call(client, "admin_set_courier_pay", { p_order_id: orderId, p_pay_cents: cents });

export const recordPayout = (client: SupabaseClient, courierId: string, month: string, cents: number, note: string) =>
  call(client, "admin_record_courier_payout", { p_courier_id: courierId, p_month: month, p_amount_cents: cents, p_note: note.trim() || null });

export const deletePayout = (client: SupabaseClient, id: number) => call(client, "admin_delete_courier_payout", { p_id: id });

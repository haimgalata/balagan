import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type OrderError, type RawApiError } from "@/admin/orders/ordersErrors";
import { parseMyRuns, parseOpenRuns, type MyRun, type OpenRun } from "@/admin/courier/courierModel";

/**
 * The courier's calls (migration 0017) — RPC only; the database checks who the caller is on every one of them and shows
 * customer details only for a run the caller has claimed. Every function resolves, none throws.
 */
export type CourierResult<T> = { ok: true; data: T } | { ok: false; error: OrderError };

const fail = (error: RawApiError): { ok: false; error: OrderError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: OrderError } => fail({ code: "", message: e instanceof Error ? e.message : String(e) });
const badShape = (): { ok: false; error: OrderError } => fail({ code: "", message: "unexpected response" });

export async function loadOpenRuns(client: SupabaseClient): Promise<CourierResult<OpenRun[]>> {
  try {
    const { data, error } = await client.rpc("courier_list_open_runs");
    if (error) return fail(error);
    const runs = parseOpenRuns(data);
    return runs ? { ok: true, data: runs } : badShape();
  } catch (e) {
    return unexpected(e);
  }
}

export async function loadMyRuns(client: SupabaseClient): Promise<CourierResult<MyRun[]>> {
  try {
    const { data, error } = await client.rpc("courier_my_runs");
    if (error) return fail(error);
    const runs = parseMyRuns(data);
    return runs ? { ok: true, data: runs } : badShape();
  } catch (e) {
    return unexpected(e);
  }
}

async function call(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<CourierResult<{ changed: boolean }>> {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error) return fail(error);
    return { ok: true, data: { changed: (data as { changed?: boolean } | null)?.changed !== false } };
  } catch (e) {
    return unexpected(e);
  }
}

export const claimRun = (client: SupabaseClient, runId: string) => call(client, "claim_delivery_run", { p_run_id: runId });
export const releaseRun = (client: SupabaseClient, runId: string) => call(client, "release_delivery_run", { p_run_id: runId });
export const departRun = (client: SupabaseClient, runId: string) => call(client, "depart_delivery_run", { p_run_id: runId });
export const completeStop = (client: SupabaseClient, orderId: string, idChecked: boolean) =>
  call(client, "complete_delivery_stop", { p_order_id: orderId, p_id_checked: idChecked });
/** `pay`: true = the customer's fault (the courier is paid), false = not paid, null = the owner decides (migration 0018). */
export const failStop = (client: SupabaseClient, orderId: string, reason: string, pay: boolean | null = null) =>
  call(client, "fail_delivery_stop", { p_order_id: orderId, p_reason: reason, p_pay: pay });

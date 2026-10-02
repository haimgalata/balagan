import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type OrderError, type RawApiError } from "@/admin/orders/ordersErrors";
import {
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  buildSearchFilter,
  israelDateToIso,
  type OrderRow,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from "@/admin/orders/orderModel";

/**
 * Reads and actions for order management. Everything runs as the signed-in back-office user, so Row Level
 * Security decides what is visible (owner: everything; staff: open orders + the last 7 days) and the
 * `transition_order()` / `resolve_stock_return()` functions decide what may change (supabase/migrations/
 * 0010_order_management.sql). There is deliberately NO direct table write anywhere in here. Every function
 * resolves — it never throws.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: OrderError };

const fail = (error: RawApiError): { ok: false; error: OrderError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: OrderError } =>
  fail({ code: "", message: e instanceof Error ? e.message : String(e) });

const ORDER_COLUMNS =
  "id,order_number,payment_method,order_status,payment_status,first_name,last_name,phone,email,city,street,house_number," +
  "entrance,floor,apartment,intercom_code,delivery_notes,subtotal_cents,delivery_fee_cents,discount_cents,coupon_code_snapshot,total_cents," +
  "created_at,confirmed_at,status_changed_at,completed_at,cancelled_at,cancel_reason,stock_return_status";
const ITEM_COLUMNS =
  "id,product_id,product_name_snapshot,product_brand_snapshot,option,option_label_snapshot,unit_price_cents,quantity,base_units,line_total_cents";
const EVENT_COLUMNS = "id,kind,from_value,to_value,reason,actor_label,actor_role,created_at";

const WITH_ITEMS = `${ORDER_COLUMNS},order_items(${ITEM_COLUMNS})`;
const WITH_DETAIL = `${WITH_ITEMS},order_status_events(${EVENT_COLUMNS})`;

// ---- the Active board ---------------------------------------------------------------------------------------

export interface BoardData {
  /** confirmed / preparing / out_for_delivery, oldest first */
  active: OrderRow[];
  /** completed / cancelled / expired since Israel's start of today, newest first */
  finishedToday: OrderRow[];
  /** cancelled while out for delivery whose goods are not yet confirmed back (any age) */
  awaitingReturn: OrderRow[];
}

export async function loadBoard(client: SupabaseClient, startOfTodayIso: string): Promise<ApiResult<BoardData>> {
  try {
    const [active, finished, returns] = await Promise.all([
      client.from("orders").select(WITH_ITEMS).in("order_status", [...ACTIVE_STATUSES]).order("created_at", { ascending: true }),
      client.from("orders").select(WITH_ITEMS).in("order_status", [...FINISHED_STATUSES]).gte("status_changed_at", startOfTodayIso).order("status_changed_at", { ascending: false }),
      client.from("orders").select(WITH_ITEMS).eq("stock_return_status", "pending_return").order("created_at", { ascending: true }),
    ]);
    const error = active.error ?? finished.error ?? returns.error;
    if (error) return fail(error);
    return {
      ok: true,
      data: {
        active: (active.data ?? []) as unknown as OrderRow[],
        finishedToday: (finished.data ?? []) as unknown as OrderRow[],
        awaitingReturn: (returns.data ?? []) as unknown as OrderRow[],
      },
    };
  } catch (e) {
    return unexpected(e);
  }
}

// ---- one order (drawer / deep link) -------------------------------------------------------------------------

export async function loadOrderDetail(client: SupabaseClient, key: { id: string } | { number: number }): Promise<ApiResult<OrderRow | null>> {
  try {
    const query = client.from("orders").select(WITH_DETAIL);
    const { data, error } = await ("id" in key ? query.eq("id", key.id) : query.eq("order_number", key.number))
      .order("created_at", { referencedTable: "order_status_events", ascending: true })
      .order("id", { referencedTable: "order_status_events", ascending: true })
      .maybeSingle();
    if (error) return fail(error);
    return { ok: true, data: (data as unknown as OrderRow | null) ?? null };
  } catch (e) {
    return unexpected(e);
  }
}

// ---- history / search ---------------------------------------------------------------------------------------

export const HISTORY_PAGE_SIZE = 25;

export interface HistoryFilters {
  text: string;
  status: OrderStatus | "";
  paymentMethod: PaymentMethod | "";
  paymentStatus: PaymentStatus | "";
  /** `YYYY-MM-DD` (Israel), inclusive */
  fromDate: string;
  toDate: string;
  page: number;
}

export const EMPTY_FILTERS: HistoryFilters = { text: "", status: "", paymentMethod: "", paymentStatus: "", fromDate: "", toDate: "", page: 0 };

export interface HistoryPage {
  rows: OrderRow[];
  total: number;
}

export async function searchOrders(client: SupabaseClient, f: HistoryFilters): Promise<ApiResult<HistoryPage>> {
  try {
    const from = f.page * HISTORY_PAGE_SIZE;
    let query = client
      .from("orders")
      .select(ORDER_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + HISTORY_PAGE_SIZE - 1);

    const search = buildSearchFilter(f.text);
    if (search) query = query.or(search);
    if (f.status) query = query.eq("order_status", f.status);
    if (f.paymentMethod) query = query.eq("payment_method", f.paymentMethod);
    if (f.paymentStatus) query = query.eq("payment_status", f.paymentStatus);
    const fromIso = israelDateToIso(f.fromDate);
    const toIso = israelDateToIso(f.toDate, true);
    if (fromIso) query = query.gte("created_at", fromIso);
    if (toIso) query = query.lt("created_at", toIso);

    const { data, error, count } = await query;
    if (error) return fail(error);
    return { ok: true, data: { rows: (data ?? []) as unknown as OrderRow[], total: count ?? 0 } };
  } catch (e) {
    return unexpected(e);
  }
}

// ---- actions (RPC only) -------------------------------------------------------------------------------------

export async function transitionOrder(
  client: SupabaseClient,
  orderId: string,
  expectedStatus: OrderStatus,
  toStatus: OrderStatus,
  reason?: string
): Promise<ApiResult<{ changed: boolean }>> {
  try {
    const { data, error } = await client.rpc("transition_order", {
      p_order_id: orderId,
      p_expected_status: expectedStatus,
      p_to_status: toStatus,
      p_reason: reason ?? null,
    });
    if (error) return fail(error);
    return { ok: true, data: { changed: (data as { changed?: boolean } | null)?.changed !== false } };
  } catch (e) {
    return unexpected(e);
  }
}

export async function resolveStockReturn(client: SupabaseClient, orderId: string, outcome: "returned" | "written_off"): Promise<ApiResult<{ changed: boolean }>> {
  try {
    const { data, error } = await client.rpc("resolve_stock_return", { p_order_id: orderId, p_outcome: outcome });
    if (error) return fail(error);
    return { ok: true, data: { changed: (data as { changed?: boolean } | null)?.changed !== false } };
  } catch (e) {
    return unexpected(e);
  }
}

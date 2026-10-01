import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type AdminError, type RawApiError } from "@/admin/customers/customersErrors";
import {
  parseAudience, parseCustomerList, parseStats,
  type AudienceKind, type AudienceRow, type CustomerList, type CustomerStats, type MarketingFilter,
} from "@/admin/customers/customersModel";

/**
 * The owner's customer functions (supabase/migrations/0013_customer_admin.sql). There is deliberately NO table access
 * here: the owner reads customer data only through these SECURITY DEFINER functions, each of which re-checks that the
 * caller is the owner. Every function resolves — it never throws.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AdminError };

const fail = (error: RawApiError): { ok: false; error: AdminError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: AdminError } => fail({ code: "", message: e instanceof Error ? e.message : String(e) });
const malformed = (): { ok: false; error: AdminError } => fail({ code: "", message: "unexpected response" });

export async function loadCustomerStats(client: SupabaseClient): Promise<ApiResult<CustomerStats>> {
  try {
    const { data, error } = await client.rpc("admin_customer_stats");
    if (error) return fail(error);
    const stats = parseStats(data);
    return stats ? { ok: true, data: stats } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

export interface ListParams {
  search: string;
  marketing: MarketingFilter;
  page: number; // 0-based
  pageSize: number;
}

export async function listCustomers(client: SupabaseClient, params: ListParams): Promise<ApiResult<CustomerList>> {
  try {
    const { data, error } = await client.rpc("admin_list_customers", {
      p_search: params.search.trim() === "" ? null : params.search.trim(),
      p_marketing: params.marketing,
      p_limit: params.pageSize,
      p_offset: params.page * params.pageSize,
    });
    if (error) return fail(error);
    const list = parseCustomerList(data);
    return list ? { ok: true, data: list } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

/** Fetches an audience AND records the export (who, what, how many) in the database's export log. */
export async function exportAudience(client: SupabaseClient, kind: AudienceKind): Promise<ApiResult<AudienceRow[]>> {
  try {
    const { data, error } = await client.rpc("admin_export_audience", { p_kind: kind });
    if (error) return fail(error);
    const rows = parseAudience(data);
    return rows ? { ok: true, data: rows } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

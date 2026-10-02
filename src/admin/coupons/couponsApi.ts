import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type AdminError, type RawApiError } from "@/admin/coupons/couponsErrors";
import {
  parseCoupons, parseEvents, parseRedemptions, summarizeUsage,
  type CouponEventRow, type CouponRow, type CouponUsage, type RedemptionRow,
} from "@/admin/coupons/couponsModel";

/**
 * The owner's coupon tables (supabase/migrations/0014_coupons.sql), straight through Row Level Security: only the
 * owner can read or write them (staff, members and anonymous visitors get nothing), and there is deliberately no
 * delete — a coupon is archived, never removed. Every function resolves — it never throws.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AdminError };

const fail = (error: RawApiError): { ok: false; error: AdminError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: AdminError } => fail({ code: "", message: e instanceof Error ? e.message : String(e) });
const malformed = (): { ok: false; error: AdminError } => fail({ code: "", message: "unexpected response" });

export interface CouponListData {
  coupons: CouponRow[];
  usage: Map<string, CouponUsage>;
}

export async function listCoupons(client: SupabaseClient): Promise<ApiResult<CouponListData>> {
  try {
    const [coupons, redemptions] = await Promise.all([
      client.from("coupons").select("*").order("created_at", { ascending: false }),
      client.from("coupon_redemptions").select("coupon_id,status"),
    ]);
    if (coupons.error) return fail(coupons.error);
    if (redemptions.error) return fail(redemptions.error);
    const rows = parseCoupons(coupons.data);
    const used = parseRedemptions((redemptions.data ?? []).map((r: Record<string, unknown>, i: number) => ({ id: String(i), ...r })));
    return rows && used ? { ok: true, data: { coupons: rows, usage: summarizeUsage(used) } } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

export async function createCoupon(client: SupabaseClient, body: Record<string, unknown>): Promise<ApiResult<CouponRow>> {
  try {
    const { data, error } = await client.from("coupons").insert(body).select("*").single();
    if (error) return fail(error);
    const rows = parseCoupons([data]);
    return rows ? { ok: true, data: rows[0] } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

export async function updateCoupon(client: SupabaseClient, id: string, body: Record<string, unknown>): Promise<ApiResult<CouponRow>> {
  try {
    const { data, error } = await client.from("coupons").update(body).eq("id", id).select("*").single();
    if (error) return fail(error);
    const rows = parseCoupons([data]);
    return rows ? { ok: true, data: rows[0] } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

export const setCouponActive = (client: SupabaseClient, id: string, isActive: boolean) => updateCoupon(client, id, { is_active: isActive });
/** Archive (hide, keep everything) or restore. A coupon is never deleted. */
export const setCouponArchived = (client: SupabaseClient, id: string, archived: boolean) =>
  updateCoupon(client, id, { archived_at: archived ? new Date().toISOString() : null });

const REDEMPTION_COLUMNS =
  "id,coupon_id,order_id,phone_e164,discount_cents,status,reserved_at,redeemed_at,released_at,released_reason," +
  "orders(order_number,order_status,street,house_number,apartment,total_cents)";

export async function loadRedemptions(client: SupabaseClient, couponId: string): Promise<ApiResult<RedemptionRow[]>> {
  try {
    const { data, error } = await client.from("coupon_redemptions").select(REDEMPTION_COLUMNS).eq("coupon_id", couponId).order("reserved_at", { ascending: false }).limit(500);
    if (error) return fail(error);
    const rows = parseRedemptions(data);
    return rows ? { ok: true, data: rows } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

export async function loadEvents(client: SupabaseClient, couponId: string): Promise<ApiResult<CouponEventRow[]>> {
  try {
    const { data, error } = await client.from("coupon_events").select("id,kind,changes,actor_label,created_at").eq("coupon_id", couponId).order("id", { ascending: false }).limit(100);
    if (error) return fail(error);
    const rows = parseEvents(data);
    return rows ? { ok: true, data: rows } : malformed();
  } catch (e) {
    return unexpected(e);
  }
}

// ---- the owner's public sentence for guests (business_settings.club_offer_text) -------------------------------------

export async function loadClubOfferText(client: SupabaseClient): Promise<ApiResult<string>> {
  try {
    const { data, error } = await client.from("business_settings").select("club_offer_text").eq("id", 1).single();
    if (error) return fail(error);
    const text = (data as { club_offer_text?: unknown } | null)?.club_offer_text;
    return { ok: true, data: typeof text === "string" ? text : "" };
  } catch (e) {
    return unexpected(e);
  }
}

export async function saveClubOfferText(client: SupabaseClient, text: string): Promise<ApiResult<string>> {
  try {
    const value = text.trim() === "" ? null : text.trim();
    const { data, error } = await client.from("business_settings").update({ club_offer_text: value }).eq("id", 1).select("club_offer_text").single();
    if (error) return fail(error);
    const saved = (data as { club_offer_text?: unknown } | null)?.club_offer_text;
    return { ok: true, data: typeof saved === "string" ? saved : "" };
  } catch (e) {
    return unexpected(e);
  }
}

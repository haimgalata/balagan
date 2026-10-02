/**
 * The checkout's "apply coupon" request: `preview_coupon()` (supabase/migrations/0014_coupons.sql), one plain `fetch`
 * with the member's bearer token — same pattern as ordersApi.ts, no client library in the customer bundle.
 *
 * The answer is INFORMATIONAL (it shows the customer what they will save). It decides nothing: `create_order()` validates
 * and prices the coupon again, for the caller's own identity, and is the only thing that can grant a discount.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";
import type { CouponDiscountType } from "@/checkout/couponTypes";

export type CouponPreview =
  | { valid: true; code: string; title: string; discountType: CouponDiscountType; discountCents: number }
  | { valid: false; reason: string; minSubtotalCents: number | null };

export class CouponApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const TYPES: readonly string[] = ["percent", "fixed", "free_delivery"];

export async function previewCoupon(config: CatalogConfig, accessToken: string, code: string, subtotalCents: number): Promise<CouponPreview> {
  if (config.source !== "supabase") throw new CouponApiError("STATIC_MODE_UNAVAILABLE");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/preview_coupon`, {
      method: "POST",
      headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_code: code, p_subtotal_cents: subtotalCents }),
      signal: controller.signal,
    });
    if (response.status === 401) throw new CouponApiError("UNAUTHENTICATED");
    if (!response.ok) throw new CouponApiError(`HTTP_${response.status}`);
    const body: unknown = await response.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new CouponApiError("UNEXPECTED_RESPONSE");
    const v = body as Record<string, unknown>;
    if (v.valid === true) {
      if (typeof v.code !== "string" || typeof v.title !== "string" || typeof v.discount_type !== "string" || !TYPES.includes(v.discount_type) || typeof v.discount_cents !== "number") {
        throw new CouponApiError("UNEXPECTED_RESPONSE");
      }
      return { valid: true, code: v.code, title: v.title, discountType: v.discount_type as CouponDiscountType, discountCents: v.discount_cents };
    }
    if (typeof v.reason !== "string") throw new CouponApiError("UNEXPECTED_RESPONSE");
    return { valid: false, reason: v.reason, minSubtotalCents: typeof v.min_subtotal_cents === "number" ? v.min_subtotal_cents : null };
  } catch (error) {
    if (error instanceof CouponApiError) throw error;
    throw new CouponApiError("NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

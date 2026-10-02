import { useCallback, useEffect, useRef, useState } from "react";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { normalizeCouponCode } from "@/storefront/lib/couponCode";
import { describeCouponReason } from "@/checkout/lib/couponMessages";
import { previewCoupon, type CouponPreview } from "@/checkout/lib/couponApi";
import type { AppliedCoupon, CouponController } from "@/checkout/couponTypes";

const config = getCatalogConfig();
const CHECK_FAILED = "לא הצלחנו לבדוק את הקופון כרגע. נסו שוב.";

interface Options {
  /** The order's items total (before delivery) — what the database prices the coupon against. */
  subtotalCents: number;
  isMember: boolean;
  /** A fresh member token, or null when there isn't one. */
  getToken: () => Promise<string | null>;
}

const toApplied = (r: Extract<CouponPreview, { valid: true }>): AppliedCoupon => ({
  code: r.code,
  title: r.title,
  discountType: r.discountType,
  discountCents: r.discountCents,
});

/**
 * The customer side of a coupon: apply (preview), keep the shown discount in step with the cart, re-check right before
 * the order is placed, and drop it — with the reason — the moment the database stops accepting it. Nothing here grants
 * anything; `create_order()` re-validates the code for the caller's own identity.
 */
export function useCoupon({ subtotalCents, isMember, getToken }: Options): CouponController {
  const [applied, setApplied] = useState<AppliedCoupon | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const subtotalRef = useRef(subtotalCents);
  subtotalRef.current = subtotalCents;

  const check = useCallback(async (code: string): Promise<CouponPreview> => {
    const token = await tokenRef.current();
    if (!token) return { valid: false, reason: "COUPON_MEMBERS_ONLY", minSubtotalCents: null };
    return previewCoupon(config, token, code, subtotalRef.current);
  }, []);

  const apply = useCallback(
    async (rawCode: string) => {
      const code = normalizeCouponCode(rawCode);
      if (code === "") {
        setMessage("הקלידו קוד קופון.");
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        const result = await check(code);
        if (result.valid) setApplied(toApplied(result));
        else setMessage(describeCouponReason(result.reason, result.minSubtotalCents));
      } catch {
        setMessage(CHECK_FAILED);
      } finally {
        setBusy(false);
      }
    },
    [check]
  );

  const remove = useCallback(() => {
    setApplied(null);
    setMessage(null);
  }, []);

  const confirm = useCallback(async (): Promise<boolean> => {
    const current = appliedRef.current;
    if (!current) return true;
    try {
      const result = await check(current.code);
      if (result.valid) {
        setApplied(toApplied(result));
        return true;
      }
      setApplied(null);
      setMessage(describeCouponReason(result.reason, result.minSubtotalCents));
      return false;
    } catch {
      setMessage(CHECK_FAILED); // fail closed: never place an order on an unverified coupon
      return false;
    }
  }, [check]);

  const rejectFromServer = useCallback((code: string) => {
    setApplied(null);
    setMessage(describeCouponReason(code));
  }, []);

  // The cart changed (quantity, removed line): the coupon's value may too — or it may stop applying (minimum order).
  useEffect(() => {
    const current = appliedRef.current;
    if (!current) return;
    let cancelled = false;
    void check(current.code)
      .then((result) => {
        if (cancelled) return;
        if (result.valid) setApplied(toApplied(result));
        else {
          setApplied(null);
          setMessage(describeCouponReason(result.reason, result.minSubtotalCents));
        }
      })
      .catch(() => {
        /* keep what is shown; confirm() re-checks before the order is placed and fails closed */
      });
    return () => {
      cancelled = true;
    };
  }, [subtotalCents, check]);

  // Signing out (or losing the session) takes the coupon with it.
  useEffect(() => {
    if (!isMember && appliedRef.current) {
      setApplied(null);
      setMessage(null);
    }
  }, [isMember]);

  return { enabled: true, applied, busy, message, apply, remove, confirm, rejectFromServer };
}

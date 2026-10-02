/** Shapes shared by checkout and the coupon box. No club or network code in here (see club.tsx for why that matters). */
export type CouponDiscountType = "percent" | "fixed" | "free_delivery";

export interface AppliedCoupon {
  code: string;
  title: string;
  discountType: CouponDiscountType;
  /** What the database says this coupon takes off right now (for free delivery: the delivery fee). Informational: create_order recomputes. */
  discountCents: number;
}

export interface CouponController {
  /** The build has a club login, so coupons exist at all. */
  enabled: boolean;
  applied: AppliedCoupon | null;
  busy: boolean;
  /** The last refusal / drop explanation, if any. */
  message: string | null;
  apply: (rawCode: string) => Promise<void>;
  remove: () => void;
  /** Re-checks the applied coupon right now (before submitting). Resolves true when there is none or it is still valid. */
  confirm: () => Promise<boolean>;
  /** The server refused the coupon while creating the order: drop it and say why. */
  rejectFromServer: (code: string) => void;
}

export const NO_COUPON: CouponController = {
  enabled: false,
  applied: null,
  busy: false,
  message: null,
  apply: async () => {},
  remove: () => {},
  confirm: async () => true,
  rejectFromServer: () => {},
};

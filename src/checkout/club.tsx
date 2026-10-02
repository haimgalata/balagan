import type { ReactNode } from "react";
import { CustomerSessionProvider, useCustomerSession } from "@/account/CustomerSessionContext";
import { CheckoutIdentity } from "@/checkout/CheckoutIdentity";
import { useMemberAddresses, type MemberAddressesState } from "@/checkout/useMemberAddresses";
import { CouponBox } from "@/checkout/CouponBox";
import { useCoupon } from "@/checkout/useCoupon";
import { NO_COUPON, type CouponController } from "@/checkout/couponTypes";

/**
 * The ONLY seam between checkout and the club login. `__CUSTOMER_AUTH__` is a compile-time constant (vite.config.ts),
 * so in a build with the login "off" (production today) every export below collapses to a no-op and the whole
 * account module is tree-shaken out of the checkout chunk — checkout is then exactly the guest checkout it has
 * always been. (tests/admin/auth/bundle.unit.spec.ts fails the build if any account code leaks into such a build.)
 * Checkout code must import club functionality from HERE, never from `@/account/*` directly.
 */
type ClubSession = ReturnType<typeof useCustomerSession>;

const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;
const NoIdentity = (_props: { open?: boolean; onOpenChange?: (open: boolean) => void }) => null;
const NoCouponBox = (_props: { coupon: CouponController; offerText: string | null; onJoin: () => void }) => null;
const useNoCoupon = (_options: { subtotalCents: number; isMember: boolean; getToken: () => Promise<string | null> }): CouponController => NO_COUPON;
const noAddresses = (): MemberAddressesState => ({ status: "idle", addresses: [] });

export const ClubProvider = __CUSTOMER_AUTH__ === "off" ? Passthrough : CustomerSessionProvider;

/** The club session, or null when this build has no club login. (A constant choice: hook order never changes.) */
export const useClub: () => ClubSession | null = __CUSTOMER_AUTH__ === "off" ? () => null : useCustomerSession;

/** The "sign in / join the club — or continue as a guest" card above the details form. */
export const ClubIdentity = __CUSTOMER_AUTH__ === "off" ? NoIdentity : CheckoutIdentity;

/** The signed-in member's saved delivery addresses. */
export const useClubAddresses: (accessToken: string | null) => MemberAddressesState = __CUSTOMER_AUTH__ === "off" ? noAddresses : useMemberAddresses;

/** Coupons are a club benefit, so they exist only in builds with a club login: otherwise there is no box and `useClubCoupon` is the inert NO_COUPON. */
export const ClubCouponBox = __CUSTOMER_AUTH__ === "off" ? NoCouponBox : CouponBox;
export const useClubCoupon = __CUSTOMER_AUTH__ === "off" ? useNoCoupon : useCoupon;

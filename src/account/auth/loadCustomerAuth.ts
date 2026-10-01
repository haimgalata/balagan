import { CustomerAuthError, type CustomerAuth } from "@/account/types";

/**
 * The login adapter this build was made with. `__CUSTOMER_AUTH__` is a compile-time constant (vite.config.ts), so
 * the branches below that don't apply are removed from the bundle. A real SMS/OTP adapter becomes one more
 * branch here (and one more value of the constant) — nothing else in the account code changes.
 */
export async function loadCustomerAuth(): Promise<CustomerAuth> {
  if (__CUSTOMER_AUTH__ === "mock") {
    const { createMockAuth } = await import("@/account/auth/mockAuth");
    return createMockAuth();
  }
  throw new CustomerAuthError("NOT_CONFIGURED");
}

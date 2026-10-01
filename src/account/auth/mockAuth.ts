/**
 * TEST-ONLY login adapter: "as if OTP verification already succeeded". It exists so the whole club flow after
 * login (join, profile, checkout, account area) can be built and tested before an SMS provider is chosen.
 *
 * It is only reachable when the build is made with VITE_CUSTOMER_AUTH=mock (e2e dev servers); a normal build
 * drops it entirely — tests/admin/auth/bundle.unit.spec.ts fails the build if its marker appears in any chunk.
 * Any code "123456" verifies. The session it hands out is `mock-customer-token.<phone>`, which the e2e stubs of the member
 * RPCs understand; it means nothing to a real database.
 */
import { CustomerAuthError, type CustomerAuth, type CustomerSession } from "@/account/types";
import { isIsraeliMobile, normalizeIsraeliPhone } from "@/storefront/lib/phone";

export const MOCK_OTP_CODE = "123456";
export const MOCK_AUTH_STORAGE_KEY = "balagan-customer-auth";
/** Also the marker tests/admin/auth/bundle.unit.spec.ts looks for to prove the mock never ships in a normal build. */
export const MOCK_TOKEN_PREFIX = "mock-customer-token.";

function readStored(): CustomerSession | null {
  try {
    const raw = window.localStorage.getItem(MOCK_AUTH_STORAGE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { accessToken, phoneE164 } = value as Record<string, unknown>;
    return typeof accessToken === "string" && typeof phoneE164 === "string" ? { accessToken, phoneE164 } : null;
  } catch {
    return null;
  }
}

export function createMockAuth(): CustomerAuth {
  return {
    kind: "mock",
    async sendCode(phoneE164) {
      if (!isIsraeliMobile(normalizeIsraeliPhone(phoneE164))) throw new CustomerAuthError("INVALID_PHONE");
    },
    async verifyCode(phoneE164, code) {
      if (code !== MOCK_OTP_CODE) throw new CustomerAuthError("INVALID_CODE");
      const session: CustomerSession = { accessToken: MOCK_TOKEN_PREFIX + phoneE164, phoneE164 };
      try {
        window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session));
      } catch {
        /* storage unavailable: the session just won't survive a reload */
      }
      return session;
    },
    async getSession() {
      return readStored();
    },
    async signOut() {
      try {
        window.localStorage.removeItem(MOCK_AUTH_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

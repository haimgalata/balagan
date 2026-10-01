import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { isIsraeliMobile, normalizeIsraeliPhone } from "@/storefront/lib/phone";
import { loadCustomerAuth } from "@/account/auth/loadCustomerAuth";
import { getMyCustomer, joinClub, MemberApiError } from "@/account/memberApi";
import { writeMemberHint } from "@/account/memberHint";
import { CustomerAuthError, type CustomerAuth, type CustomerProfile, type CustomerSession, type JoinClubInput } from "@/account/types";

/**
 * Who the visitor is right now, as far as the club is concerned:
 *   loading     — restoring a stored session
 *   guest       — nobody signed in (the default; ordering as a guest always works)
 *   needs-join  — phone verified, but not a member yet (shows the one mandatory confirmation)
 *   member      — verified phone + club profile
 *   error       — verified, but the profile could not be loaded (network): retry, never pretend to be a member
 *   unavailable — this build has no login adapter
 */
export type CustomerState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "unavailable" }
  | { status: "needs-join"; session: CustomerSession }
  | { status: "member"; session: CustomerSession; profile: CustomerProfile }
  | { status: "error"; session: CustomerSession; code: string };

interface CustomerSessionValue {
  state: CustomerState;
  /** Validates the number (Israeli mobile only), asks the login adapter to send a code, returns the E.164 number. */
  sendCode: (rawPhone: string) => Promise<string>;
  /** Completes the login; resolves to the resulting state's status ("member" or "needs-join"). */
  verifyCode: (phoneE164: string, code: string) => Promise<void>;
  join: (input: JoinClubInput) => Promise<void>;
  retry: () => Promise<void>;
  /** Re-reads the profile (e.g. after an order taught it the member's name) and refreshes the header hint. */
  refreshProfile: () => Promise<void>;
  /** A current bearer token for the signed-in member (restored/refreshed by the login adapter), or null. */
  getAccessToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const CustomerSessionContext = createContext<CustomerSessionValue | null>(null);

export function CustomerSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomerState>({ status: "loading" });
  const authRef = useRef<CustomerAuth | null>(null);
  const config = useMemo(() => getCatalogConfig(), []);

  /** Loads the profile for a session and moves the state accordingly. Says what happened, so a caller (the login) can react. */
  const resolve = useCallback(
    async (session: CustomerSession): Promise<"member" | "needs-join" | "error" | "signed-out"> => {
      try {
        const profile = await getMyCustomer(config, session.accessToken);
        if (profile) {
          writeMemberHint({ firstName: profile.firstName });
          setState({ status: "member", session, profile });
          return "member";
        }
        writeMemberHint(null);
        setState({ status: "needs-join", session });
        return "needs-join";
      } catch (error) {
        const code = error instanceof MemberApiError ? error.code : "NETWORK_ERROR";
        if (code === "UNAUTHENTICATED") {
          // the stored session is no longer accepted: forget it rather than show a broken signed-in state
          await authRef.current?.signOut();
          writeMemberHint(null);
          setState({ status: "guest" });
          return "signed-out";
        }
        setState({ status: "error", session, code });
        return "error";
      }
    },
    [config]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await loadCustomerAuth();
        if (cancelled) return;
        authRef.current = auth;
        const session = await auth.getSession();
        if (cancelled) return;
        if (session) await resolve(session);
        else {
          writeMemberHint(null); // a hint without a session is stale
          setState({ status: "guest" });
        }
      } catch (error) {
        if (!cancelled) setState({ status: error instanceof CustomerAuthError && error.code === "NOT_CONFIGURED" ? "unavailable" : "guest" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolve]);

  const requireAuth = (): CustomerAuth => {
    if (!authRef.current) throw new CustomerAuthError("NOT_CONFIGURED");
    return authRef.current;
  };

  const value = useMemo<CustomerSessionValue>(
    () => ({
      state,
      async sendCode(rawPhone) {
        const e164 = normalizeIsraeliPhone(rawPhone);
        if (!isIsraeliMobile(e164)) throw new CustomerAuthError("INVALID_PHONE");
        await requireAuth().sendCode(e164);
        return e164;
      },
      async verifyCode(phoneE164, code) {
        const session = await requireAuth().verifyCode(phoneE164, code.trim());
        // A code that verifies but whose session the database then refuses must NOT look like success (the form would
        // otherwise wait forever): tell the login form so it can say so and let the person try again.
        if ((await resolve(session)) === "signed-out") throw new CustomerAuthError("NETWORK");
      },
      async join(input) {
        if (state.status !== "needs-join") return;
        const profile = await joinClub(config, state.session.accessToken, input);
        writeMemberHint({ firstName: profile.firstName });
        setState({ status: "member", session: state.session, profile });
      },
      async retry() {
        if (state.status === "error") await resolve(state.session);
      },
      async refreshProfile() {
        if (state.status !== "member") return;
        try {
          const profile = await getMyCustomer(config, state.session.accessToken);
          if (profile) {
            writeMemberHint({ firstName: profile.firstName });
            setState({ status: "member", session: state.session, profile });
          }
        } catch {
          // best effort: the member stays signed in with what we already have
        }
      },
      async getAccessToken() {
        try {
          return (await authRef.current?.getSession())?.accessToken ?? null;
        } catch {
          return null;
        }
      },
      async signOut() {
        await authRef.current?.signOut();
        writeMemberHint(null);
        setState({ status: "guest" });
      },
    }),
    [state, config, resolve]
  );

  return <CustomerSessionContext.Provider value={value}>{children}</CustomerSessionContext.Provider>;
}

export function useCustomerSession(): CustomerSessionValue {
  const value = useContext(CustomerSessionContext);
  if (!value) throw new Error("useCustomerSession must be used inside <CustomerSessionProvider>");
  return value;
}

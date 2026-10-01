import { useCallback, useRef } from "react";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { MemberApiError } from "@/account/memberApi";

/**
 * Runs one request as the signed-in member with a CURRENT token (the login adapter refreshes it if needed). If there is
 * no valid session any more — or the database says so — the member is signed out and the caller gets an
 * `UNAUTHENTICATED` error, so a half-dead session can never sit on screen pretending to work.
 *
 * The returned function is stable across renders (it reads the latest session functions through a ref), so effects can
 * depend on it without re-running every time the profile refreshes.
 */
export function useMemberRun() {
  const { getAccessToken, signOut } = useCustomerSession();
  const latest = useRef({ getAccessToken, signOut });
  latest.current = { getAccessToken, signOut };

  return useCallback(async function run<T>(request: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await latest.current.getAccessToken();
    if (!token) {
      await latest.current.signOut();
      throw new MemberApiError("UNAUTHENTICATED");
    }
    try {
      return await request(token);
    } catch (error) {
      if (error instanceof MemberApiError && error.code === "UNAUTHENTICATED") await latest.current.signOut();
      throw error;
    }
  }, []);
}

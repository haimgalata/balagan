import { useCallback, useEffect, useRef, useState } from "react";
import { isAuthRetryableFetchError, type AuthError, type SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient, getAdminConfig } from "@/admin/adminClient";
import { ADMIN_STORAGE_KEY, IDLE_CHECK_MS, IDLE_LOGOUT_MS, type SignedOutNotice } from "@/admin/adminConfig";

const config = getAdminConfig();

export type AdminSessionState =
  | { status: "loading" }
  /** VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. */
  | { status: "unconfigured" }
  | { status: "signedOut"; notice: SignedOutNotice | null }
  /** Signed in, but we could not confirm admin status (e.g. no connection). The session is kept. */
  | { status: "error" }
  | { status: "admin"; email: string; role: AdminRole; courier: boolean };

/**
 * 'owner' = full admin; 'staff' = order handling only; 'courier' = delivery runs only (migration 0017).
 * Drives the screen; the database enforces it.
 */
export type AdminRole = "owner" | "staff" | "courier";

export type SignInFailure = "invalid-credentials" | "network" | "too-many-attempts" | "not-authorized" | "unknown";
export type SignInResult = { ok: true } | { ok: false; reason: SignInFailure };

type Verdict = { kind: "ok"; role: AdminRole; courier: boolean } | { kind: "not-admin" } | { kind: "error" };

const isRole = (value: unknown): value is AdminRole => value === "owner" || value === "staff" || value === "courier";

/**
 * Asks the database who the signed-in user is (`get_my_access()`: the role from the `admin_users` allow-list plus
 * whether this account also drives delivery runs). A database that has not applied migration 0017 yet answers with
 * the older `get_my_role()` instead. This only drives what the screen shows — every read and write is
 * independently enforced by Row Level Security / the order RPCs, so a tampered browser gains nothing.
 */
async function verifyAdmin(client: SupabaseClient): Promise<Verdict> {
  const access = await client.rpc("get_my_access");
  if (!access.error) {
    const data = access.data as { role?: unknown; courier?: unknown } | null;
    return isRole(data?.role) ? { kind: "ok", role: data.role, courier: data.courier === true || data.role === "courier" } : { kind: "not-admin" };
  }
  if (access.error.code !== "PGRST202") return { kind: "error" };
  const { data, error } = await client.rpc("get_my_role");
  if (error) return { kind: "error" };
  return data === "owner" || data === "staff" ? { kind: "ok", role: data, courier: false } : { kind: "not-admin" };
}

/** Ends the session everywhere (server-side revoke) and makes sure nothing stays in localStorage. */
async function clearSession(client: SupabaseClient): Promise<void> {
  try {
    await client.auth.signOut();
  } catch {
    // network problems must not leave the user signed in locally
  }
  try {
    window.localStorage.removeItem(ADMIN_STORAGE_KEY);
  } catch {
    // storage unavailable
  }
}

function classifySignInError(error: AuthError): SignInFailure {
  if (isAuthRetryableFetchError(error)) return "network";
  if (error.status === 429) return "too-many-attempts";
  if (error.status === 400 || error.status === 401 || error.code === "invalid_credentials") return "invalid-credentials";
  return "unknown";
}

/**
 * Login state for the admin area.
 *
 *  - On load: restores a saved session, then confirms with `is_admin()`. A logged-in user who is NOT an
 *    admin is signed out immediately and told the account isn't authorized.
 *  - `signIn` / `signOut`: email + password login; logout revokes the session on the server too.
 *  - Idle logout: after `IDLE_LOGOUT_MS` (60 min) without a click, key or touch, an OWNER is signed out. The
 *    shared STAFF account is exempt — it sits on the order terminal all day, where nobody "clicks" while orders
 *    arrive, and it can only handle orders (enforced by the database), so leaving it signed in is safe. A COURIER
 *    (a phone in a pocket on the road) is exempt for the same reason.
 */
export function useAdminSession() {
  const client = config ? getAdminClient(config) : null;
  const [state, setState] = useState<AdminSessionState>(client ? { status: "loading" } : { status: "unconfigured" });
  const alive = useRef(true);

  const establish = useCallback(async () => {
    if (!client) return;
    const { data } = await client.auth.getSession();
    if (!alive.current) return;
    if (!data.session) {
      setState({ status: "signedOut", notice: null });
      return;
    }
    const verdict = await verifyAdmin(client);
    if (!alive.current) return;
    if (verdict.kind === "ok") {
      setState({ status: "admin", email: data.session.user.email ?? "", role: verdict.role, courier: verdict.courier });
    } else if (verdict.kind === "not-admin") {
      await clearSession(client);
      if (alive.current) setState({ status: "signedOut", notice: "not-authorized" });
    } else {
      setState({ status: "error" });
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    if (!client) return;
    void establish();
    // Another tab signing out, or a refresh token that can no longer be renewed, ends the session here too.
    // (Only state updates in this callback — never call Supabase from inside it.)
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setState((current) => (current.status === "signedOut" ? current : { status: "signedOut", notice: null }));
      }
    });
    return () => {
      alive.current = false;
      data.subscription.unsubscribe();
    };
  }, [client, establish]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      if (!client) return { ok: false, reason: "unknown" };
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) return { ok: false, reason: classifySignInError(error) };

      const verdict = await verifyAdmin(client);
      if (verdict.kind === "ok") {
        setState({ status: "admin", email: data.user.email ?? email.trim(), role: verdict.role, courier: verdict.courier });
        return { ok: true };
      }
      await clearSession(client); // never keep a non-admin (or unverifiable) session around
      if (verdict.kind === "not-admin") {
        setState({ status: "signedOut", notice: "not-authorized" });
        return { ok: false, reason: "not-authorized" };
      }
      return { ok: false, reason: "network" };
    },
    [client]
  );

  const signOut = useCallback(
    async (notice: SignedOutNotice | null = null) => {
      if (!client) return;
      await clearSession(client);
      if (alive.current) setState({ status: "signedOut", notice });
    },
    [client]
  );

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void establish();
  }, [establish]);

  // Idle logout (owner only) — wall-clock based, so it also fires after the computer slept.
  const idleRole = state.status === "admin" ? state.role : null;
  useEffect(() => {
    if (idleRole !== "owner") return;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true, capture: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity >= IDLE_LOGOUT_MS) void signOut("idle");
    }, IDLE_CHECK_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
      window.clearInterval(timer);
    };
  }, [idleRole, signOut]);

  return { state, client, signIn, signOut, retry };
}

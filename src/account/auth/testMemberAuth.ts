/**
 * DEV-SERVER-ONLY login adapter for hand-testing the club flow against the REAL Supabase project with ONE dedicated
 * test member (email + password), without an SMS provider and without enabling public sign-ups.
 *
 * Only reachable with VITE_CUSTOMER_AUTH=realtest (`npm run dev:club:real`). vite.config.ts refuses that value in a
 * production build, so none of this (nor the "auth/v1" string) can ship. The "code" the login screen asks for is this
 * account's PASSWORD — typed by the tester, never stored in env or the bundle. The session is a real Supabase JWT, so
 * `auth.uid()` in the database is the member and every club RPC / RLS rule is exercised for real.
 *
 * Guard rails: this computer or a private network only (devHost.ts); only the email in VITE_TEST_MEMBER_EMAIL; the account must carry the phone the tester
 * typed; an owner/staff account is refused (a back-office user is never a "customer"). `grant_type=password` can't
 * create users, so sign-ups stay off.
 */
import { CustomerAuthError, type CustomerAuth, type CustomerSession } from "@/account/types";
import { isIsraeliMobile, normalizeIsraeliPhone } from "@/storefront/lib/phone";
import { isDevHost } from "@/account/auth/devHost";

/** Present only in a realtest dev build; tests/admin/auth/bundle.unit.spec.ts and `npm run check:prod` fail if it is found in anything deployable. */
export const DEV_ONLY_MARKER = "BALAGAN_DEV_ONLY_REALTEST";

export const TEST_MEMBER_STORAGE_KEY = "balagan-customer-auth";

interface Stored extends CustomerSession {
  refreshToken: string;
  expiresAt: number; // epoch seconds
}

const url = () => (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const headers = () => ({ apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "", "Content-Type": "application/json" });

/** This computer or a private network (a phone on the home Wi-Fi) — never a public address. See devHost.ts. */
function assertLocal(): void {
  if (!isDevHost(window.location.hostname)) throw new CustomerAuthError("NOT_CONFIGURED");
}

function read(): Stored | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(TEST_MEMBER_STORAGE_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    return typeof v.accessToken === "string" && typeof v.phoneE164 === "string" && typeof v.refreshToken === "string" && typeof v.expiresAt === "number"
      ? (v as unknown as Stored)
      : null;
  } catch {
    return null;
  }
}

function write(session: Stored | null): void {
  try {
    if (session) window.localStorage.setItem(TEST_MEMBER_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(TEST_MEMBER_STORAGE_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

async function tokenRequest(grant: "password" | "refresh_token", body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${url()}/auth/v1/token?grant_type=${grant}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch {
    throw new CustomerAuthError("NETWORK");
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 429) throw new CustomerAuthError("TOO_MANY_REQUESTS");
  if (!response.ok || !json || typeof json.access_token !== "string") throw new CustomerAuthError("INVALID_CODE");
  return json;
}

function toStored(json: Record<string, unknown>): Stored {
  const user = (json.user ?? {}) as Record<string, unknown>;
  const rawPhone = typeof user.phone === "string" ? user.phone : "";
  const phoneE164 = normalizeIsraeliPhone(rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`);
  if (!isIsraeliMobile(phoneE164)) throw new CustomerAuthError("INVALID_PHONE");
  return {
    accessToken: json.access_token as string,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : "",
    expiresAt: typeof json.expires_at === "number" ? json.expires_at : Math.floor(Date.now() / 1000) + 3000,
    phoneE164,
  };
}

async function isBackOffice(accessToken: string): Promise<boolean> {
  const response = await fetch(`${url()}/rest/v1/rpc/get_my_role`, {
    method: "POST",
    headers: { ...headers(), Authorization: `Bearer ${accessToken}` },
    body: "{}",
  });
  if (!response.ok) return true; // can't prove it's a plain member -> refuse
  const role: unknown = await response.json().catch(() => "error");
  return role !== null;
}

export function createTestMemberAuth(): CustomerAuth {
  console.warn(`[${DEV_ONLY_MARKER}] real-database test login active: one dedicated test member, password over plain http on a private network. Never deploy this build.`);
  return {
    kind: "realtest",
    async sendCode(phoneE164) {
      assertLocal();
      if (!isIsraeliMobile(normalizeIsraeliPhone(phoneE164))) throw new CustomerAuthError("INVALID_PHONE");
    },
    async verifyCode(phoneE164, password) {
      assertLocal();
      const email = (import.meta.env.VITE_TEST_MEMBER_EMAIL ?? "").trim();
      if (email === "") throw new CustomerAuthError("NOT_CONFIGURED");
      const stored = toStored(await tokenRequest("password", { email, password }));
      if (stored.phoneE164 !== normalizeIsraeliPhone(phoneE164) || (await isBackOffice(stored.accessToken))) {
        throw new CustomerAuthError("INVALID_CODE");
      }
      write(stored);
      return { accessToken: stored.accessToken, phoneE164: stored.phoneE164 };
    },
    async getSession() {
      assertLocal();
      let stored = read();
      if (!stored) return null;
      if (stored.expiresAt - 60 <= Date.now() / 1000) {
        try {
          stored = toStored(await tokenRequest("refresh_token", { refresh_token: stored.refreshToken }));
          write(stored);
        } catch {
          write(null);
          return null;
        }
      }
      return { accessToken: stored.accessToken, phoneE164: stored.phoneE164 };
    },
    async signOut() {
      write(null);
    },
  };
}

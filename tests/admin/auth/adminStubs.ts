import type { Page, Route } from "@playwright/test";

/** Host the "supabase" Playwright variant is built against (see playwright.config.ts). */
const HOST = /stub\.supabase\.test/;
export const ADMIN_STORAGE_KEY = "balagan-admin-auth";
/** Same fixed instant the shared fixture pins the page clock to. */
export const FIXED_NOW_MS = Date.parse("2026-09-20T10:00:00+03:00");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "content-range",
};

export interface StubUser {
  email: string;
  password: string;
  id: string;
  /** what is_admin() answers for this user (the real one reads the admin_users allow-list) */
  isAdmin: boolean;
  /** what get_my_role() answers; defaults to 'owner' when isAdmin, otherwise null (not in the allow-list) */
  role?: "owner" | "staff" | null;
}

export const ADMIN_USER: StubUser = { email: "owner@example.test", password: "correct-horse-battery", id: "00000000-0000-0000-0000-00000000000a", isAdmin: true };
/** The shared order-terminal account: in the allow-list as 'staff' — is_admin() (owner-only) is false for it. */
export const STAFF_USER: StubUser = { email: "terminal@example.test", password: "terminal-password-1", id: "00000000-0000-0000-0000-00000000000c", isAdmin: false, role: "staff" };
export const roleOf = (user: StubUser): "owner" | "staff" | null => user.role !== undefined ? user.role : user.isAdmin ? "owner" : null;
export const PLAIN_USER: StubUser = { email: "someone@example.test", password: "another-password-1", id: "00000000-0000-0000-0000-00000000000b", isAdmin: false };

export interface StubOptions {
  users?: StubUser[];
  counts?: { categories: number; subcategories: number; products: number };
  /** make the password login fail: a dead network, or HTTP 429 */
  loginFailure?: "network" | 429 | null;
  /** refresh-token requests are rejected (an expired/revoked session) */
  refreshFails?: boolean;
  loginDelayMs?: number;
  /**
   * Plug-in handler for data requests (tables, RPCs). Called after the auth endpoints; return true when it
   * handled the request. Used by the categories tests to stand in for the database's admin tables and functions.
   */
  extra?: (context: StubRequestContext) => Promise<boolean> | boolean;
}

/** What a plug-in handler (see `StubOptions.extra`) receives for each request to the fake Supabase. */
export interface StubRequestContext {
  route: Route;
  method: string;
  url: URL;
  /** parsed JSON body, or null */
  body: unknown;
  /** raw request headers (lower-case names) */
  headers: Record<string, string>;
  /** the signed-in user from the bearer token, or null (anonymous key) */
  user: StubUser | null;
  json: (status: number, body: unknown, extraHeaders?: Record<string, string>) => Promise<void>;
}

export interface StubCall {
  method: string;
  path: string;
  /** user id inside the bearer JWT, or null for the anonymous key */
  sub: string | null;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const fakeJwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.stub-signature`;
const subOf = (authorization: string | undefined): string | null => {
  const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return (JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
};

/** What supabase-js stores after a login (and accepts back on reload). */
export function sessionFor(user: StubUser, expiresAtSeconds = Math.floor(FIXED_NOW_MS / 1000) + 3600) {
  return {
    access_token: fakeJwt({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp: expiresAtSeconds }),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAtSeconds,
    refresh_token: `refresh-${user.id}`,
    user: {
      id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
      app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
    },
  };
}

/** Pre-loads a saved session into localStorage before the page starts (as if the admin had logged in earlier). */
export async function seedSession(page: Page, session: unknown): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [ADMIN_STORAGE_KEY, JSON.stringify(session)] as const);
}

/**
 * Fakes the parts of Supabase the admin talks to, inside the browser: password login, refresh, logout,
 * `is_admin()` and the admin-only tables. The tables answer only for a user whose is_admin() is true — a
 * stand-in for Row Level Security — so a test that shows numbers has really been "let in".
 */
export async function stubSupabase(page: Page, options: StubOptions = {}) {
  const users = options.users ?? [ADMIN_USER, PLAIN_USER];
  const counts = options.counts ?? { categories: 2, subcategories: 32, products: 141 };
  const calls: StubCall[] = [];
  const byId = (id: string | null) => users.find((user) => user.id === id) ?? null;

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(HOST, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });

    const sub = subOf(request.headers()["authorization"]);
    calls.push({ method: request.method(), path: url.pathname, sub });

    // ---- password login / refresh
    if (url.pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        if (options.loginDelayMs) await new Promise((resolve) => setTimeout(resolve, options.loginDelayMs));
        if (options.loginFailure === "network") return route.abort("connectionrefused");
        if (options.loginFailure === 429) return json(route, 429, { code: "over_request_rate_limit", error_code: "over_request_rate_limit", msg: "Too many requests" });
        const body = JSON.parse(request.postData() ?? "{}") as { email?: string; password?: string };
        const user = users.find((u) => u.email === body.email && u.password === body.password);
        if (!user) return json(route, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return json(route, 200, sessionFor(user));
      }
      if (grant === "refresh_token") {
        if (options.refreshFails) return json(route, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
        const user = users.find((u) => `refresh-${u.id}` === (JSON.parse(request.postData() ?? "{}") as { refresh_token?: string }).refresh_token);
        return user ? json(route, 200, sessionFor(user)) : json(route, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      }
    }
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname === "/auth/v1/user") {
      const user = byId(sub);
      return user ? json(route, 200, sessionFor(user).user) : json(route, 401, { code: 401, msg: "invalid JWT" });
    }

    // ---- plug-in handler (fake tables / RPCs for a specific test suite)
    if (options.extra) {
      let body: unknown = null;
      try { body = request.postData() ? JSON.parse(request.postData()!) : null; } catch { body = null; }
      const handled = await options.extra({ route, method: request.method(), url, body, headers: request.headers(), user: byId(sub), json: (status, payload, extraHeaders) => route.fulfill({ status, headers: { ...CORS, ...extraHeaders }, contentType: "application/json", body: payload === null ? "" : JSON.stringify(payload) }) });
      if (handled) return;
    }

    // ---- get_my_role(): what the admin app asks after every login / reload
    if (url.pathname === "/rest/v1/rpc/get_my_role") {
      const user = byId(sub);
      if (!user) return json(route, 401, { code: "42501", message: "permission denied for function get_my_role" });
      return json(route, 200, roleOf(user));
    }

    // ---- is_admin()
    if (url.pathname === "/rest/v1/rpc/is_admin") {
      const user = byId(sub);
      if (!user) return json(route, 401, { code: "42501", message: "permission denied for function is_admin" }); // anon may not call it
      return json(route, 200, user.isAdmin);
    }

    // ---- admin-only tables (RLS stand-in: only an admin sees any rows)
    const table = /^\/rest\/v1\/(categories|subcategories|products)$/.exec(url.pathname)?.[1] as keyof typeof counts | undefined;
    if (table) {
      const user = byId(sub);
      if (!user) return json(route, 401, { code: "42501", message: `permission denied for table ${table}` });
      const n = user.isAdmin ? counts[table] : 0;
      return route.fulfill({ status: 200, headers: { ...CORS, "content-range": n === 0 ? "*/0" : `0-0/${n}` }, contentType: "application/json", body: "[]" });
    }

    return route.fulfill({ status: 404, headers: CORS, body: "" });
  });

  return {
    calls,
    /** requests that reached the given path */
    to: (path: string) => calls.filter((call) => call.path === path),
    tableCalls: () => calls.filter((call) => /^\/rest\/v1\/(categories|subcategories|products)$/.test(call.path)),
  };
}

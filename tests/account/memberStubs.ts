import type { Page, Route } from "@playwright/test";

/**
 * A small stateful stand-in for the member endpoints of migration 0012, served to the "account" build (stubbed database
 * host + the test-only mock login): get_my_customer / join_club, the member's own rows of customer_addresses and
 * customers, get_my_orders, set_marketing_consent, delete_my_account. It enforces the rules that matter to the UI the way
 * the database does: no join without BOTH confirmations; the phone comes from the token (like auth.users.phone), never
 * from a request body; a member can only touch their own rows; a duplicate address is a 409.
 */
const MOCK_TOKEN_PREFIX = "mock-customer-token.";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, prefer",
  "access-control-allow-methods": "*",
};

export interface FakeAddress {
  id: string;
  street: string;
  house_number: string;
  entrance?: string | null;
  floor?: string | null;
  apartment?: string | null;
  intercom_code?: string | null;
  notes?: string | null;
}

export interface FakeOrder {
  id: string;
  order_number: number;
  order_status: string;
  created_at?: string;
  total_cents?: number;
  street?: string;
  house_number?: string;
  items: { product_id: string | null; name: string; option: "unit" | "package"; option_label?: string; quantity: number; unit_price_cents?: number }[];
}

export interface FakeProfile {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  /** the terms version the member has accepted (null = none yet) */
  terms_version?: string | null;
  /** saved delivery addresses, most recently used first */
  addresses?: FakeAddress[];
  orders?: FakeOrder[];
  /** current marketing consent (default: given, both channels — that is what joining records) */
  marketing?: boolean;
  marketing_channels?: string[];
}

export interface MemberStubs {
  /** phone (E.164) -> profile, i.e. who is already a member. */
  members: Map<string, FakeProfile>;
  /** the p_payload of every join_club call, in order */
  joinPayloads: Record<string, unknown>[];
  /** every get_my_customer call, with the bearer token it carried */
  profileCalls: string[];
  /** every read of customer_addresses, with the bearer token it carried */
  addressCalls: string[];
  /** bodies of PATCH customers (profile edits) */
  profilePatches: Record<string, unknown>[];
  /** arguments of every set_marketing_consent call */
  consentCalls: Record<string, unknown>[];
  /** how many times delete_my_account was called */
  deleteAccountCalls: number;
  /** make get_my_customer fail with a server error (to test the retry path) */
  failProfile: boolean;
  /** make get_my_orders fail with a server error */
  failOrders: boolean;
}

export async function stubMemberRpc(page: Page, seed: Record<string, FakeProfile> = {}): Promise<MemberStubs> {
  const state: MemberStubs = {
    // deep copy: a test that edits a member (addresses, consent…) must never leak into the next test through a shared fixture
    members: new Map(Object.entries(structuredClone(seed))),
    joinPayloads: [],
    profileCalls: [],
    addressCalls: [],
    profilePatches: [],
    consentCalls: [],
    deleteAccountCalls: 0,
    failProfile: false,
    failOrders: false,
  };
  let addressSeq = 100;

  const profileJson = (phone: string) => {
    const p = state.members.get(phone)!;
    return {
      id: "00000000-0000-0000-0000-0000000000aa",
      phone,
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      email: p.email ?? null,
      joined_at: "2026-09-20T07:00:00Z",
      terms_version: p.terms_version ?? null,
      terms_accepted_at: p.terms_version ? "2026-09-20T07:00:00Z" : null,
      age_21_confirmed_at: "2026-09-20T07:00:00Z",
      marketing: p.marketing ?? true,
      marketing_channels: p.marketing === false ? [] : (p.marketing_channels ?? ["sms", "email"]),
    };
  };
  const phoneOf = (route: Route): string | null => {
    const auth = route.request().headers()["authorization"] ?? "";
    const token = auth.replace(/^Bearer /, "");
    return token.startsWith(MOCK_TOKEN_PREFIX) ? token.slice(MOCK_TOKEN_PREFIX.length) : null;
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
  const preflight = (route: Route) => route.request().method() === "OPTIONS";
  const bodyOf = (route: Route) => JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;

  await page.route("**/rest/v1/rpc/get_my_customer", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    state.profileCalls.push(route.request().headers()["authorization"] ?? "");
    if (!phone) return json(route, 401, { message: "JWT expired" });
    if (state.failProfile) return json(route, 500, { message: "boom" });
    return json(route, 200, state.members.has(phone) ? profileJson(phone) : null);
  });

  // The member's own saved addresses (row-level security: only their rows).
  await page.route("**/rest/v1/customer_addresses*", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    if (!phone) return json(route, 401, { message: "JWT expired" });
    const member = state.members.get(phone);
    if (!member) return json(route, 200, []);
    const list = (member.addresses ??= []);
    const method = route.request().method();
    const idFilter = /[?&]id=eq\.([^&]+)/.exec(route.request().url())?.[1];

    if (method === "GET") {
      state.addressCalls.push(route.request().headers()["authorization"] ?? "");
      return json(route, 200, list.map((a) => ({ entrance: null, floor: null, apartment: null, intercom_code: null, notes: null, ...a })));
    }
    if (method === "POST") {
      const body = bodyOf(route) as Record<string, string | null>;
      const key = (a: { street: string; house_number: string; apartment?: string | null }) => `${a.street}|${a.house_number}|${a.apartment ?? ""}`;
      if (list.some((a) => key(a) === key({ street: body.street!, house_number: body.house_number!, apartment: body.apartment }))) {
        return json(route, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
      }
      addressSeq += 1;
      const created = { id: `a${addressSeq}`, street: body.street!, house_number: body.house_number!, entrance: body.entrance, floor: body.floor, apartment: body.apartment, intercom_code: body.intercom_code, notes: body.notes } as FakeAddress;
      list.unshift(created); // a new address is the most recently used
      while (list.length > 5) list.pop();
      return json(route, 201, [created]);
    }
    if (method === "PATCH" && idFilter) {
      const index = list.findIndex((a) => a.id === idFilter);
      if (index < 0) return json(route, 200, []);
      const body = bodyOf(route);
      const [row] = list.splice(index, 1);
      Object.assign(row, body);
      if ("last_used_at" in body) list.unshift(row); // touched -> becomes the default
      else list.splice(index, 0, row);
      delete (row as Record<string, unknown>).last_used_at;
      return json(route, 200, [row]);
    }
    if (method === "DELETE" && idFilter) {
      const index = list.findIndex((a) => a.id === idFilter);
      if (index >= 0) list.splice(index, 1);
      return route.fulfill({ status: 204, headers: CORS });
    }
    return json(route, 400, { message: "unsupported in stub" });
  });

  // The member's own profile row (the database lets them edit only name + e-mail).
  await page.route("**/rest/v1/customers*", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    if (!phone) return json(route, 401, { message: "JWT expired" });
    const member = state.members.get(phone);
    if (!member || route.request().method() !== "PATCH") return json(route, 200, []);
    const body = bodyOf(route);
    state.profilePatches.push(body);
    for (const key of Object.keys(body)) {
      if (!["first_name", "last_name", "email"].includes(key)) return json(route, 403, { code: "42501", message: "permission denied for table customers" });
    }
    Object.assign(member, body);
    return json(route, 200, [profileJson(phone)]);
  });

  await page.route("**/rest/v1/rpc/get_my_orders", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    if (!phone) return json(route, 401, { message: "JWT expired" });
    if (state.failOrders) return json(route, 500, { message: "boom" });
    const orders = state.members.get(phone)?.orders ?? [];
    return json(
      route,
      200,
      orders.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        order_status: o.order_status,
        payment_method: "cash",
        payment_status: "pending",
        created_at: o.created_at ?? "2026-09-19T21:30:00Z",
        subtotal_cents: 50000,
        delivery_fee_cents: 1500,
        total_cents: o.total_cents ?? 51500,
        city: "נתיבות",
        street: o.street ?? "הרצל",
        house_number: o.house_number ?? "12",
        entrance: null,
        floor: null,
        apartment: null,
        items: o.items.map((i) => ({
          product_id: i.product_id,
          name: i.name,
          brand: null,
          option: i.option,
          option_label: i.option_label ?? (i.option === "unit" ? "יחידה" : "פקט"),
          quantity: i.quantity,
          unit_price_cents: i.unit_price_cents ?? 1000,
          line_total_cents: (i.unit_price_cents ?? 1000) * i.quantity,
        })),
      }))
    );
  });

  await page.route("**/rest/v1/rpc/set_marketing_consent", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    const member = phone ? state.members.get(phone) : undefined;
    if (!phone || !member) return json(route, 403, { message: "NOT_A_MEMBER" });
    const body = bodyOf(route);
    state.consentCalls.push(body);
    member.marketing = body.p_granted === true;
    member.marketing_channels = Array.isArray(body.p_channels) ? (body.p_channels as string[]) : [];
    return json(route, 200, profileJson(phone));
  });

  await page.route("**/rest/v1/rpc/delete_my_account", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    if (!phone) return json(route, 401, { message: "JWT expired" });
    state.deleteAccountCalls += 1;
    state.members.delete(phone);
    return route.fulfill({ status: 204, headers: CORS });
  });

  await page.route("**/rest/v1/rpc/join_club", async (route) => {
    if (preflight(route)) return route.fulfill({ status: 204, headers: CORS });
    const phone = phoneOf(route);
    if (!phone) return json(route, 401, { message: "JWT expired" });
    const payload = (bodyOf(route) as { p_payload?: Record<string, unknown> }).p_payload ?? {};
    state.joinPayloads.push(payload);
    if (!state.members.has(phone)) {
      if (payload.age_21_confirmed !== true) return json(route, 400, { message: "AGE_21_REQUIRED" });
      if (payload.marketing_consent !== true) return json(route, 400, { message: "MARKETING_CONSENT_REQUIRED" });
      state.members.set(phone, {});
    }
    return json(route, 200, { ...profileJson(phone), created: true, claimed_orders: 0 });
  });

  return state;
}

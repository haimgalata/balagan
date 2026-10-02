/**
 * The member RPCs of migration 0012 (get_my_customer / join_club) — plain `fetch` with the member's bearer
 * token, no client library (same pattern as ordersApi.ts, and the customer bundle must stay free of
 * `@supabase/supabase-js`). The database decides everything; this only shapes requests and translates errors.
 */
import type { CatalogConfig } from "@/storefront/lib/catalogApi";
import type { AddressInput, CustomerProfile, JoinClubInput, MyOrder, MyOrderItem, ProfileInput, SavedAddress } from "@/account/types";

export class MemberApiError extends Error {
  /** The RPC's raised token (e.g. "AGE_21_REQUIRED"), "UNAUTHENTICATED", "NETWORK_ERROR" or "HTTP_<status>". */
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

function extractErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string") return null;
  const match = /^([A-Z0-9_]+)/.exec(message);
  return match ? match[1] : null;
}

async function rpc(config: CatalogConfig, name: string, accessToken: string, args: Record<string, unknown>): Promise<unknown> {
  if (config.source !== "supabase") throw new MemberApiError("STATIC_MODE_UNAVAILABLE");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 401) throw new MemberApiError("UNAUTHENTICATED");
    if (!response.ok) throw new MemberApiError(extractErrorCode(body) ?? `HTTP_${response.status}`);
    return body;
  } catch (error) {
    if (error instanceof MemberApiError) throw error;
    throw new MemberApiError("NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toProfile(value: unknown): CustomerProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.phone !== "string") return null;
  return {
    id: v.id,
    phone: v.phone,
    firstName: str(v.first_name),
    lastName: str(v.last_name),
    email: str(v.email),
    joinedAt: str(v.joined_at) ?? "",
    termsVersion: str(v.terms_version),
    termsAcceptedAt: str(v.terms_accepted_at),
    age21ConfirmedAt: str(v.age_21_confirmed_at),
    marketing: v.marketing === true,
    marketingChannels: Array.isArray(v.marketing_channels) ? v.marketing_channels.filter((c): c is string => typeof c === "string") : [],
  };
}

/** The signed-in customer's club profile, or null if they are not (or no longer) a member. */
export async function getMyCustomer(config: CatalogConfig, accessToken: string): Promise<CustomerProfile | null> {
  const body = await rpc(config, "get_my_customer", accessToken, {});
  if (body === null) return null;
  const profile = toProfile(body);
  if (!profile) throw new MemberApiError("UNEXPECTED_RESPONSE");
  return profile;
}

/** Registers the signed-in customer as a club member (idempotent for someone who already is one). */
export async function joinClub(config: CatalogConfig, accessToken: string, input: JoinClubInput): Promise<CustomerProfile> {
  const body = await rpc(config, "join_club", accessToken, {
    p_payload: {
      age_21_confirmed: input.age21Confirmed,
      marketing_consent: input.marketingConsent,
      wording_version: input.wordingVersion,
      channels: input.channels,
      source: input.source ?? "registration",
    },
  });
  const profile = toProfile(body);
  if (!profile) throw new MemberApiError("UNEXPECTED_RESPONSE");
  return profile;
}

/**
 * The member's saved addresses, newest-used first — read straight from `customer_addresses` (row-level security
 * returns only the caller's own rows; the database keeps them deduplicated and capped at 5).
 */
export async function getMyAddresses(config: CatalogConfig, accessToken: string): Promise<SavedAddress[]> {
  if (config.source !== "supabase") return [];
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/customer_addresses?select=id,street,house_number,entrance,floor,apartment,intercom_code,notes&order=last_used_at.desc&limit=5`,
      { headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}` }, signal: controller.signal }
    );
    if (response.status === 401) throw new MemberApiError("UNAUTHENTICATED");
    if (!response.ok) throw new MemberApiError(`HTTP_${response.status}`);
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new MemberApiError("UNEXPECTED_RESPONSE");
    return body.flatMap((row): SavedAddress[] => {
      if (typeof row !== "object" || row === null) return [];
      const r = row as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.street !== "string" || typeof r.house_number !== "string") return [];
      return [{
        id: r.id,
        street: r.street,
        houseNumber: r.house_number,
        entrance: str(r.entrance) ?? "",
        floor: str(r.floor) ?? "",
        apartment: str(r.apartment) ?? "",
        intercomCode: str(r.intercom_code) ?? "",
        notes: str(r.notes) ?? "",
      }];
    });
  } catch (error) {
    if (error instanceof MemberApiError) throw error;
    throw new MemberApiError("NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the personal area (/account)

/** A write/read on a table the member owns through row-level security (customers, customer_addresses). */
async function rest(config: CatalogConfig, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, accessToken: string, body?: unknown): Promise<unknown> {
  if (config.source !== "supabase") throw new MemberApiError("STATIC_MODE_UNAVAILABLE");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method === "POST" || method === "PATCH" ? { Prefer: "return=representation" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const parsed: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 401) throw new MemberApiError("UNAUTHENTICATED");
    if (!response.ok) throw new MemberApiError(extractErrorCode(parsed) ?? `HTTP_${response.status}`);
    return parsed;
  } catch (error) {
    if (error instanceof MemberApiError) throw error;
    throw new MemberApiError("NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toOrderItem(value: unknown): MyOrderItem | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || (v.option !== "unit" && v.option !== "package")) return null;
  return {
    productId: str(v.product_id),
    name: v.name,
    brand: str(v.brand),
    option: v.option,
    optionLabel: str(v.option_label) ?? "",
    quantity: num(v.quantity),
    unitPriceCents: num(v.unit_price_cents),
    lineTotalCents: num(v.line_total_cents),
  };
}

function toOrder(value: unknown): MyOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.order_number !== "number" || typeof v.order_status !== "string") return null;
  return {
    id: v.id,
    orderNumber: v.order_number,
    status: v.order_status,
    paymentMethod: str(v.payment_method) ?? "cash",
    paymentStatus: str(v.payment_status) ?? "pending",
    createdAt: str(v.created_at) ?? "",
    subtotalCents: num(v.subtotal_cents),
    deliveryFeeCents: num(v.delivery_fee_cents),
    discountCents: num(v.discount_cents),
    couponCode: str(v.coupon_code),
    totalCents: num(v.total_cents),
    street: str(v.street) ?? "",
    houseNumber: str(v.house_number) ?? "",
    entrance: str(v.entrance) ?? "",
    floor: str(v.floor) ?? "",
    apartment: str(v.apartment) ?? "",
    items: Array.isArray(v.items) ? v.items.flatMap((item) => toOrderItem(item) ?? []) : [],
  };
}

/** The member's own orders, newest first (get_my_orders(): a column-whitelisting RPC — the table API is closed to members). */
export async function getMyOrders(config: CatalogConfig, accessToken: string, limit = 20): Promise<MyOrder[]> {
  const body = await rpc(config, "get_my_orders", accessToken, { p_limit: limit });
  if (!Array.isArray(body)) throw new MemberApiError("UNEXPECTED_RESPONSE");
  return body.flatMap((order) => toOrder(order) ?? []);
}

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

function addressBody(input: AddressInput) {
  return {
    street: input.street.trim(),
    house_number: input.houseNumber.trim(),
    entrance: orNull(input.entrance),
    floor: orNull(input.floor),
    apartment: orNull(input.apartment),
    intercom_code: orNull(input.intercomCode),
    notes: orNull(input.notes),
  };
}

export async function addAddress(config: CatalogConfig, accessToken: string, customerId: string, input: AddressInput): Promise<void> {
  await rest(config, "POST", "customer_addresses", accessToken, { customer_id: customerId, ...addressBody(input) });
}

export async function updateAddress(config: CatalogConfig, accessToken: string, id: string, input: AddressInput): Promise<void> {
  await rest(config, "PATCH", `customer_addresses?id=eq.${encodeURIComponent(id)}`, accessToken, addressBody(input));
}

/** "Most recently used" IS the default address, so making one the default just touches it. */
export async function makeDefaultAddress(config: CatalogConfig, accessToken: string, id: string): Promise<void> {
  await rest(config, "PATCH", `customer_addresses?id=eq.${encodeURIComponent(id)}`, accessToken, { last_used_at: new Date().toISOString() });
}

export async function deleteAddress(config: CatalogConfig, accessToken: string, id: string): Promise<void> {
  await rest(config, "DELETE", `customer_addresses?id=eq.${encodeURIComponent(id)}`, accessToken);
}

/** Name and e-mail only: the database grants the member no write access to their phone, terms record or status. */
export async function updateMyProfile(config: CatalogConfig, accessToken: string, customerId: string, input: ProfileInput): Promise<void> {
  await rest(config, "PATCH", `customers?id=eq.${encodeURIComponent(customerId)}`, accessToken, {
    first_name: orNull(input.firstName),
    last_name: orNull(input.lastName),
    email: orNull(input.email),
  });
}

/** Marketing opt-in / opt-out. Withdrawing never deletes the account. */
export async function setMarketingConsent(config: CatalogConfig, accessToken: string, granted: boolean, channels: ("sms" | "email")[]): Promise<void> {
  await rpc(config, "set_marketing_consent", accessToken, { p_granted: granted, p_channels: granted ? channels : null, p_wording_version: "v1" });
}

/** Right to erasure as far as accounting allows (see delete_my_account() in migration 0012). */
export async function deleteMyAccount(config: CatalogConfig, accessToken: string): Promise<void> {
  await rpc(config, "delete_my_account", accessToken, {});
}

const ERROR_MESSAGES: Record<string, string> = {
  HTTP_409: "הכתובת הזו כבר שמורה אצלכם.",
  HTTP_400: "אחד הפרטים שהוזנו אינו תקין. בדקו ונסו שוב.",
  INVALID_EMAIL: "כתובת האימייל אינה תקינה.",
  AGE_21_REQUIRED: "יש לאשר שאתם מעל גיל 21 כדי להצטרף למועדון.",
  MARKETING_CONSENT_REQUIRED: "ההצטרפות למועדון דורשת הסכמה לקבלת דיוור שיווקי. אפשר להזמין גם בלי להירשם, כאורח.",
  MOBILE_REQUIRED: "להצטרפות למועדון נדרש מספר טלפון נייד.",
  PHONE_ALREADY_REGISTERED: "מספר הטלפון הזה כבר רשום במועדון. נסו להתחבר שוב.",
  UNAUTHENTICATED: "ההתחברות פגה. נא להתחבר שוב.",
  NETWORK_ERROR: "לא הצלחנו להתחבר לשרת. בדקו את החיבור ונסו שוב.",
};

export function describeMemberError(code: string): string {
  return ERROR_MESSAGES[code] ?? "משהו השתבש. נסו שוב בעוד רגע.";
}

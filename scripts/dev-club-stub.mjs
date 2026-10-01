#!/usr/bin/env node
/**
 * A tiny LOCAL fake of the Supabase endpoints the club flow talks to — for MANUAL testing in the browser while the real
 * SMS/OTP login does not exist yet. Started together with the app by `npm run dev:club` (scripts/dev-club.mjs).
 *
 * Why it exists: the test-only mock login hands out a fake token (`mock-customer-token.<phone>`). A real Supabase project
 * (rightly) rejects it, so the mock can only work against a stand-in like this one. Nothing here ever reaches your real
 * project; all state is in memory and starts fresh every time.
 *
 * Who is a member:
 *   050-111-2222  an EXISTING member (דנה כהן, two saved addresses, two past orders, terms accepted) -> straight in
 *   any other valid Israeli MOBILE (05X-XXXXXXX) -> a NEW phone: you get the one mandatory confirmation, then you are a member
 * Mock one-time code for everyone: 123456
 *
 * Implements: get_storefront_catalog, check_stock_availability, create_order, and the member endpoints of migration 0012
 * (get_my_customer, join_club, get_my_orders, set_marketing_consent, delete_my_account, customer_addresses, customers).
 * Plain Node, no dependencies.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.STUB_PORT ?? 5199);
const TOKEN_PREFIX = "mock-customer-token.";
const DELIVERY_FEE_CENTS = 1500;

// ---------------------------------------------------------------- catalog (same rules as the seed / test fixtures)
const baseline = JSON.parse(readFileSync(resolve(ROOT, "tests/baseline/catalog.json"), "utf8"));
const byId = new Map(baseline.products.map((p) => [p.id, p]));
const catalog = {
  categories: baseline.categories.map((c) => ({
    id: c.id, slug: c.slug, name_he: c.name, name_en: null,
    subcategories: c.subcategories.map((s) => ({ id: s.id, slug: s.slug, name_he: s.name, name_en: null })),
  })),
  products: baseline.categories.flatMap((c) => c.subcategories.flatMap((s) => s.productIds)).map((id) => {
    const p = byId.get(id);
    return {
      id: p.id, category: p.category, subcategory: p.subcategory, name_he: p.name, name_en: null, brand: p.brand,
      description: p.description, image_path: null,
      unit: { price: p.unitPrice, sale_price: null, in_stock: p.inStock },
      package: { label: "פקט", unit_count: 10, price: p.oldPackRegular, sale_price: p.oldPackPrice, in_stock: p.inStock },
    };
  }),
};
const productById = new Map(catalog.products.map((p) => [p.id, p]));

// ---------------------------------------------------------------- in-memory "database"
let seq = 0;
const newId = (prefix) => `${prefix}-${(++seq).toString(16).padStart(8, "0")}`;
const members = new Map(); // e164 -> member
let orderNumber = 1002; // the seeded demo orders are #1001 and #1002; new ones continue after them

function makeMember(phone, extra = {}) {
  return {
    id: newId("00000000-0000-4000-8000"), phone, first_name: null, last_name: null, email: null,
    joined_at: new Date().toISOString(), terms_version: null, terms_accepted_at: null, age_21_confirmed_at: new Date().toISOString(),
    marketing: true, marketing_channels: ["sms", "email"], addresses: [], orders: [], ...extra,
  };
}
members.set("+972501112222", makeMember("+972501112222", {
  first_name: "דנה", last_name: "כהן", email: "dana@example.test", terms_version: "v1", terms_accepted_at: new Date().toISOString(),
  addresses: [
    { id: "addr-1", street: "הרצל", house_number: "12", entrance: null, floor: "2", apartment: "5", intercom_code: "77", notes: "להתקשר לפני" },
    { id: "addr-2", street: "בן גוריון", house_number: "10", entrance: "ב", floor: null, apartment: null, intercom_code: null, notes: null },
  ],
  orders: [
    { id: "ord-2", order_number: 1002, order_status: "out_for_delivery", payment_method: "cash", payment_status: "pending", created_at: new Date(Date.now() - 3600e3).toISOString(), subtotal_cents: 50000, delivery_fee_cents: DELIVERY_FEE_CENTS, total_cents: 51500, city: "נתיבות", street: "הרצל", house_number: "12", entrance: null, floor: "2", apartment: "5", items: [{ product_id: "1", name: byId.get("1")?.name ?? "מוצר", brand: null, option: "package", option_label: "פקט", quantity: 1, unit_price_cents: 50000, line_total_cents: 50000 }] },
    { id: "ord-1", order_number: 1001, order_status: "completed", payment_method: "cash", payment_status: "paid", created_at: new Date(Date.now() - 9 * 86400e3).toISOString(), subtotal_cents: 50000, delivery_fee_cents: DELIVERY_FEE_CENTS, total_cents: 51500, city: "נתיבות", street: "בן גוריון", house_number: "10", entrance: "ב", floor: null, apartment: null, items: [{ product_id: "1", name: byId.get("1")?.name ?? "מוצר", brand: null, option: "package", option_label: "פקט", quantity: 1, unit_price_cents: 50000, line_total_cents: 50000 }] },
  ],
}));

// ---------------------------------------------------------------- http
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, prefer",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const log = (...a) => console.log(`[club-stub] ${a.join(" ")}`);

function profileJson(m) {
  return {
    id: m.id, phone: m.phone, first_name: m.first_name, last_name: m.last_name, email: m.email, joined_at: m.joined_at,
    terms_version: m.terms_version, terms_accepted_at: m.terms_accepted_at, age_21_confirmed_at: m.age_21_confirmed_at,
    marketing: m.marketing, marketing_channels: m.marketing ? m.marketing_channels : [],
  };
}
const phoneOf = (req) => {
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer /, "");
  return token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : null;
};
const sameAddress = (a, b) => ["street", "house_number", "apartment"].every((k) => (a[k] ?? "") === (b[k] ?? ""));

function touchAddress(member, a) {
  const found = member.addresses.find((x) => sameAddress(x, a));
  if (found) {
    Object.assign(found, a);
    member.addresses.splice(member.addresses.indexOf(found), 1);
    member.addresses.unshift(found);
  } else {
    member.addresses.unshift({ id: newId("addr"), ...a });
    member.addresses.length = Math.min(member.addresses.length, 5);
  }
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (status, json) => {
      res.writeHead(status, { ...CORS, "content-type": "application/json" });
      res.end(json === undefined || json === null ? (status === 204 ? "" : "null") : JSON.stringify(json));
    };
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, "http://localhost");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { message: "bad json" }); }
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const phone = phoneOf(req);
    const member = phone ? members.get(phone) : undefined;
    log(req.method, path, phone ? `(${phone})` : "(anon)");

    // ----- public catalog / cart / checkout
    if (path === "rpc/get_storefront_catalog") return send(200, catalog);
    if (path === "rpc/get_business_settings") return send(404, { code: "PGRST202", message: "not implemented in the dev stub" }); // the app uses its bundled hours
    if (path === "rpc/check_stock_availability") return send(200, (body.p_items ?? []).map((i) => ({ product_id: i.product_id, available: true })));

    if (path === "rpc/create_order") {
      const p = body.p_payload ?? {}, c = p.customer ?? {};
      if (!Array.isArray(p.items) || p.items.length === 0) return send(400, { message: "EMPTY_ORDER" });
      if (c.age_confirmed !== true) return send(400, { message: "AGE_NOT_CONFIRMED" });
      if (c.terms_accepted !== true) return send(400, { message: "TERMS_NOT_ACCEPTED" });
      if (c.city !== "נתיבות") return send(400, { message: "UNSUPPORTED_CITY" });
      const items = [];
      for (const i of p.items) {
        const prod = productById.get(i.product_id);
        if (!prod) return send(400, { message: `PRODUCT_UNAVAILABLE: ${i.product_id}` });
        const opt = i.option === "package" ? prod.package : prod.unit;
        const price = Math.round((opt.sale_price ?? opt.price) * 100);
        items.push({ product_id: prod.id, name: prod.name_he, brand: prod.brand, option: i.option, option_label: i.option === "package" ? prod.package.label : "יחידה", quantity: i.quantity, unit_price_cents: price, line_total_cents: price * i.quantity });
      }
      const subtotal = items.reduce((s, i) => s + i.line_total_cents, 0);
      const order = {
        id: newId("ord"), order_number: ++orderNumber, order_status: "confirmed", payment_method: "cash", payment_status: "pending",
        created_at: new Date().toISOString(), subtotal_cents: subtotal, delivery_fee_cents: DELIVERY_FEE_CENTS, total_cents: subtotal + DELIVERY_FEE_CENTS,
        city: c.city, street: c.street, house_number: c.house_number, entrance: c.entrance ?? null, floor: c.floor ?? null, apartment: c.apartment ?? null, items,
      };
      if (member) {
        // what migration 0012's triggers do: attach the order to the member, learn their name/e-mail, remember the address + terms
        member.orders.unshift(order);
        member.first_name ||= c.first_name; member.last_name ||= c.last_name; member.email ||= c.email ?? null;
        member.terms_version = "v1"; member.terms_accepted_at ||= new Date().toISOString();
        touchAddress(member, { street: c.street, house_number: c.house_number, entrance: c.entrance ?? null, floor: c.floor ?? null, apartment: c.apartment ?? null, intercom_code: c.intercom_code ?? null, notes: c.notes ?? null });
        log("order", order.order_number, "attached to member", phone);
      } else log("order", order.order_number, "GUEST order", `${c.first_name} ${c.last_name}`, c.phone);
      return send(200, { order_id: order.id, order_number: order.order_number, order_status: "confirmed", payment_status: "pending", payment_method: "cash", total_cents: order.total_cents, payment_attempt_id: null });
    }

    // ----- everything below needs a (mock) logged-in session
    const needsLogin = path.startsWith("rpc/get_my_") || ["rpc/join_club", "rpc/claim_guest_orders", "rpc/set_marketing_consent", "rpc/delete_my_account"].includes(path) || path.startsWith("customer_addresses") || path.startsWith("customers");
    if (needsLogin && !phone) return send(401, { message: "JWT invalid (the dev stub only accepts the mock login)" });

    if (path === "rpc/get_my_customer") return send(200, member ? profileJson(member) : null);
    if (path === "rpc/get_my_orders") return send(200, member ? member.orders.slice(0, body.p_limit ?? 20) : []);
    if (path === "rpc/claim_guest_orders") return send(200, 0);

    if (path === "rpc/join_club") {
      if (member) return send(200, { ...profileJson(member), created: false, claimed_orders: 0 });
      const p = body.p_payload ?? {};
      if (p.age_21_confirmed !== true) return send(400, { message: "AGE_21_REQUIRED" });
      if (p.marketing_consent !== true) return send(400, { message: "MARKETING_CONSENT_REQUIRED" });
      const m = makeMember(phone, { marketing_channels: Array.isArray(p.channels) && p.channels.length ? p.channels : ["sms", "email"] });
      members.set(phone, m);
      log("NEW MEMBER", phone);
      return send(200, { ...profileJson(m), created: true, claimed_orders: 0 });
    }
    if (path === "rpc/set_marketing_consent") {
      if (!member) return send(403, { message: "NOT_A_MEMBER" });
      member.marketing = body.p_granted === true;
      member.marketing_channels = Array.isArray(body.p_channels) ? body.p_channels : [];
      return send(200, profileJson(member));
    }
    if (path === "rpc/delete_my_account") { members.delete(phone); log("ACCOUNT DELETED", phone); return send(204, null); }

    if (path.startsWith("customers")) {
      if (!member || req.method !== "PATCH") return send(200, []);
      for (const k of Object.keys(body)) if (!["first_name", "last_name", "email"].includes(k)) return send(403, { code: "42501", message: "permission denied for table customers" });
      Object.assign(member, body);
      return send(200, [profileJson(member)]);
    }

    if (path.startsWith("customer_addresses")) {
      if (!member) return send(200, []);
      const list = member.addresses;
      const id = /[?&]id=eq\.([^&]+)/.exec(req.url)?.[1];
      if (req.method === "GET") return send(200, list.map((a) => ({ entrance: null, floor: null, apartment: null, intercom_code: null, notes: null, ...a })));
      if (req.method === "POST") {
        if (list.some((a) => sameAddress(a, body))) return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
        const created = { id: newId("addr"), street: body.street, house_number: body.house_number, entrance: body.entrance ?? null, floor: body.floor ?? null, apartment: body.apartment ?? null, intercom_code: body.intercom_code ?? null, notes: body.notes ?? null };
        list.unshift(created); list.length = Math.min(list.length, 5);
        return send(201, [created]);
      }
      if (req.method === "PATCH" && id) {
        const i = list.findIndex((a) => a.id === id);
        if (i < 0) return send(200, []);
        const [row] = list.splice(i, 1);
        const { last_used_at, ...fields } = body;
        Object.assign(row, fields);
        if (last_used_at) list.unshift(row); else list.splice(i, 0, row);
        return send(200, [row]);
      }
      if (req.method === "DELETE" && id) { const i = list.findIndex((a) => a.id === id); if (i >= 0) list.splice(i, 1); return send(204, null); }
    }

    return send(404, { message: `the dev stub does not implement ${req.method} ${path}` });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  (existing member: 050-111-2222; mock code: 123456)`);
});

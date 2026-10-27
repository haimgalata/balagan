#!/usr/bin/env node
/**
 * Balagan — live security test for the Supabase project (plan §D, step 1).
 *
 * Proves, against the REAL project, that the admin area is protected by the
 * database (RLS + grants + storage policies), not by hiding a route:
 *
 *   anon             -> can ONLY call get_storefront_catalog(); everything else denied
 *   non-admin user   -> logged in but not in admin_users: no reads, no writes, no self-promotion
 *   admin            -> full CRUD; constraints reject bad prices/packages; storage works
 *
 * Also covers the admin "Categories" support added by migration 0005 (the reorder / product-count
 * functions, the slug lock), the admin "Products" support added by migration 0006 (shared inventory —
 * one stock_base_units count plus independent unit_available/package_available switches — and the
 * per-(category,subcategory) product reorder function), the cart's shared-stock quantity check added by
 * migration 0007 (check_stock_availability — never leaks the raw stock count, hidden products, or whether a
 * product exists), the Business Settings support added by migration 0008 (get_business_settings() —
 * physical-store hours, online-order hours, min order, delivery fee, manual pause), and the Orders support
 * added by migration 0009: anon/authenticated get NO direct table access to orders/order_items/
 * payment_attempts/payment_events (everything goes through create_order()/get_order_status()); create_order()
 * re-validates every field server-side and is idempotent; release_expired_order() is unreachable by anyone
 * over the API; expire_stale_orders() is authenticated-but-admin-gated; and — the one genuinely new trust
 * tier in this project — confirm_payment() is proven unreachable not just by anon and a non-admin user but
 * by the ADMIN token too, since it is granted only to service_role, which this script never uses. If a
 * migration has not been applied yet, its section reports a SKIP (exit code 2) instead of failing.
 *
 * Club (migrations 0011-0013): the "Club" section proves that an ordinary logged-in user (USER_*) — the permission
 * surface every future club member has — can reach nothing admin and nothing of anyone else's: every club/order table is
 * closed, nothing can be written (not even self-made membership), join_club() needs BOTH mandatory confirmations, the
 * owner's customer functions are owner-only (not staff, not anon), the internal helpers are unreachable even for the owner,
 * and the owner has no direct table access to customer data. With MEMBER_* it also runs a REAL member's lifecycle (join, an
 * order attached by the database, whitelisted order history, safe-column edits only, isolation, consent withdrawal and
 * re-grant, deletion) and deletes the test member again. Without USER_* the club group is SKIPPED (exit 2), never "passed".
 *
 * Zero dependencies (plain fetch, Node >= 18). Uses ONLY the public anon key plus
 * test-account passwords supplied through the environment — never the
 * service-role key. Nothing secret is printed.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_ANON_KEY="eyJ..."
 *   $env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."
 *   $env:USER_EMAIL="..."; $env:USER_PASSWORD="..."      # a normal user that is NOT in admin_users
 *   $env:STAFF_EMAIL="..."; $env:STAFF_PASSWORD="..."    # (optional, migration 0010) a user in admin_users with role 'staff'
 *   $env:COURIER_EMAIL="..."; $env:COURIER_PASSWORD="..." # (optional, migration 0017) a user in admin_users with role 'courier'
 *   $env:MEMBER_EMAIL="..."; $env:MEMBER_PASSWORD="..."  # (optional, migrations 0011-0013) a DEDICATED test user for the club-member lifecycle:
 *                                                         #   not in admin_users, with a verified Israeli mobile number set on auth.users, e.g. in the
 *                                                         #   SQL editor: update auth.users set phone='9725XXXXXXXX', phone_confirmed_at=now() where email='...';
 *   node scripts/security-test.mjs [--check-signup | --signups-enabled]
 *
 *   --signups-enabled  for use AFTER public sign-ups are switched on (phone login for club members): instead of expecting
 *                   self-registration to be refused, it self-registers a throwaway e-mail user and proves it has NO power
 *                   (not an admin, sees no tables, cannot use any admin/owner function, cannot become a member). It leaves
 *                   one unconfirmed throwaway user behind (this script has no service-role key by design): delete it in
 *                   Authentication -> Users. Mutually exclusive with --check-signup.
 *
 *   --check-signup  also tries to self-register a throwaway user against
 *                   /auth/v1/signup and expects it to be REFUSED (proves public
 *                   sign-ups are disabled). Opt-in because if sign-ups were
 *                   enabled it would create an unconfirmed junk user.
 *
 * Side effects: inserts a few rows tagged "zz-security-probe" (hidden category,
 * subcategory, product with explicit ids 900000001-900000009, one tiny image),
 * then deletes them in a `finally`. Explicit ids mean the product_id_seq
 * sequence is never consumed. If cleanup ever fails, the script prints the
 * SQL to remove leftovers.
 *
 * Exit code: 0 = all passed and nothing skipped, 1 = a check failed,
 *            2 = all executed checks passed but a group was skipped (NOT fully verified).
 */
import { randomUUID } from "node:crypto";

const env = (k) => (process.env[k] ?? "").trim();
const URL_ = env("SUPABASE_URL").replace(/\/+$/, "");
const ANON = env("SUPABASE_ANON_KEY");
const ADMIN_EMAIL = env("ADMIN_EMAIL"), ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const USER_EMAIL = env("USER_EMAIL"), USER_PASSWORD = process.env.USER_PASSWORD ?? "";
const STAFF_EMAIL = env("STAFF_EMAIL"), STAFF_PASSWORD = process.env.STAFF_PASSWORD ?? "";
const COURIER_EMAIL = env("COURIER_EMAIL"), COURIER_PASSWORD = process.env.COURIER_PASSWORD ?? "";
const MEMBER_EMAIL = env("MEMBER_EMAIL"), MEMBER_PASSWORD = process.env.MEMBER_PASSWORD ?? "";
const CHECK_SIGNUP = process.argv.includes("--check-signup");
const SIGNUPS_ENABLED = process.argv.includes("--signups-enabled");
if (CHECK_SIGNUP && SIGNUPS_ENABLED) {
  console.error("Use EITHER --check-signup (sign-ups must be refused) OR --signups-enabled (sign-ups are on: prove a stranger has no power), not both.");
  process.exit(1);
}

if (!URL_ || !ANON || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Missing env. Required: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD (and USER_EMAIL/USER_PASSWORD for the non-admin checks).");
  process.exit(1);
}

// ---------------------------------------------------------------- tiny harness
let passed = 0;
const failed = [];
const skipped = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed.push(name); console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- http helpers
async function call(method, url, { token = ANON, body, headers = {}, raw } = {}) {
  // Legacy anon keys are JWTs (eyJ...) and are sent as Bearer too. New-style publishable keys
  // (sb_publishable_...) are NOT JWTs: they go in the `apikey` header only.
  const bearer = token === ANON && !ANON.startsWith("eyJ") ? {} : { Authorization: `Bearer ${token}` };
  const res = await fetch(url, {
    method,
    headers: { apikey: ANON, ...bearer, ...headers, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}
const rest = (method, path, opts = {}) =>
  call(method, `${URL_}/rest/v1/${path}`, { ...opts, headers: { Prefer: "return=representation", ...(opts.headers ?? {}) } });
const rpc = (name, token, args = {}) => call("POST", `${URL_}/rest/v1/rpc/${name}`, { token, body: args });
const pgCode = (r) => r.json?.code ?? "";

/** PostgREST "permission denied" / RLS violation: 401 (anon) or 403 (authenticated), SQLSTATE 42501. */
const isDenied = (r) => (r.status === 401 || r.status === 403);
/** RLS hides rows instead of raising: 200 with an empty array (or 0 rows changed). */
const isEmpty = (r) => r.status === 200 && Array.isArray(r.json) && r.json.length === 0;
const deniedOrEmpty = (r) => isDenied(r) || isEmpty(r);

async function signIn(email, password) {
  const r = await call("POST", `${URL_}/auth/v1/token?grant_type=password`, { body: { email, password } });
  if (r.status !== 200 || !r.json?.access_token) return { error: `sign-in failed for ${email} (HTTP ${r.status}: ${r.json?.msg ?? r.json?.error_description ?? r.json?.error ?? "unknown"})` };
  return { token: r.json.access_token, userId: r.json.user?.id };
}

const storagePath = (p) => `${URL_}/storage/v1/object/product-images/${p}`;
const storageDenied = (r) => [400, 401, 403].includes(r.status) && /(security|unauthori[sz]ed|forbidden|403|denied|not allowed)/i.test(r.text);
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
const upload = (p, token, bytes, type) => call("POST", storagePath(p), { token, raw: bytes, headers: { "Content-Type": type, "x-upsert": "false" } });

// probe fixtures (explicit ids => the product_id_seq sequence is never touched)
const CAT = randomUUID(), SUB = randomUUID();
const OTHER_CAT = randomUUID(), OTHER_SUB = randomUUID(), SUB2 = randomUUID();
const PID = "900000001", PID_BAD = "900000002", PID2 = "900000003", PID_ORDER = "900000004";
const IMG = `products/${PID}/probe.png`;
const BARCODE = "ZZ-SECURITY-PROBE-1";
const PRIVATE_KEYS = /"(barcode|stock_base_units|track_stock|unit_available|package_available|unit_in_stock|package_in_stock|is_visible|sort_order|created_at|updated_at|user_id)"\s*:/;
/** order snapshot fields that must NEVER appear in get_order_status()'s narrow response. */
const ORDER_PII_KEYS = /"(first_name|last_name|phone|email|street|house_number|entrance|floor|apartment|intercom_code|delivery_notes|customer_id|idempotency_key)"\s*:/;

let adminToken = "", userToken = "", userId = "", staffToken = "", courierToken = "";
const orderIds = []; // probe orders created during the run (order_items/payment_attempts/payment_events cascade-delete with them)
// Migration 0015 refuses orders outside the 'orders' schedule / while paused, and per disabled method. The probe orders
// below must work at any hour, so while the test runs ordering is opened (all methods on, today's order hours
// 00:00-23:59, pause off) and EXACTLY the original values are put back in cleanup(). The live site therefore accepts
// orders around the clock for the minute or so the test takes — run it when that is acceptable.
let ordersOpenedFor0015 = null;
// Migration 0017: once the owner has defined delivery windows a delivery order must pick one (and may be refused by cut-off /
// capacity). The probe orders carry no window, so every active window is switched off for the run and exactly these ids are
// switched back on in cleanup().
let windowsPausedFor0017 = [];
const created = { product: false, product2: false, productOrder: false, sub: false, cat: false, otherCat: false, otherSub: false, image: false };

async function cleanup() {
  section("Cleanup");
  const res = [];
  if (ordersOpenedFor0015) {
    const { settings, hours } = ordersOpenedFor0015;
    const s1 = await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: settings });
    const s2 = await rest("PATCH", `business_hours?schedule_type=eq.orders&day_of_week=eq.${hours.day_of_week}`, { token: adminToken,
      body: { is_open: hours.is_open, open_time: hours.open_time, close_time: hours.close_time } });
    res.push(["ordering settings restored (0015)", s1.status < 300 && s2.status < 300]);
    if (s1.status >= 300 || s2.status >= 300) console.log(`  RESTORE BY HAND in /admin/settings: ${JSON.stringify(ordersOpenedFor0015)}`);
  }
  if (windowsPausedFor0017.length) {
    const w = await rest("PATCH", `delivery_windows?id=in.(${windowsPausedFor0017.join(",")})`, { token: adminToken, body: { is_active: true } });
    res.push(["delivery windows switched back on (0017)", w.status < 300]);
    if (w.status >= 300) console.log(`  SWITCH THESE WINDOWS BACK ON by hand in /admin/settings: ${windowsPausedFor0017.join(", ")}`);
  }
  // orders first (order_items/payment_attempts/payment_events cascade with them) — deleted before the
  // products they reference, even though order_items.product_id would only be SET NULL, not blocked.
  // Since migration 0010 NOBODY can delete an order through the API (orders are history). On a project that
  // has it, probe orders still open are CANCELLED instead (so they leave the live order board and any stock
  // goes back); whatever remains is listed below for removal in the SQL editor.
  if (orderIds.length) {
    await rest("DELETE", `orders?id=in.(${orderIds.join(",")})`, { token: adminToken });
    const open = await rest("GET", `orders?id=in.(${orderIds.join(",")})&order_status=in.(confirmed,preparing,ready_for_dispatch,out_for_delivery,ready_for_pickup)&select=id,order_status`, { token: adminToken });
    for (const o of open.json ?? []) await rpc("transition_order", adminToken, { p_order_id: o.id, p_expected_status: o.order_status, p_to_status: "cancelled", p_reason: "zz-security-probe cleanup" });
  }
  if (created.image) res.push(["storage object", (await call("DELETE", `${URL_}/storage/v1/object/product-images`, { token: adminToken, body: { prefixes: [IMG] } })).status < 300]);
  res.push(["products", (await rest("DELETE", `products?id=in.(${PID},${PID_BAD},${PID2},${PID_ORDER})`, { token: adminToken })).status < 300]);
  res.push(["subcategories", (await rest("DELETE", `subcategories?id=in.(${SUB},${SUB2},${OTHER_SUB})`, { token: adminToken })).status < 300]);
  res.push(["categories", (await rest("DELETE", `categories?id=in.(${CAT},${OTHER_CAT})`, { token: adminToken })).status < 300]);
  const left = await rest("GET", `products?id=in.(${PID},${PID_BAD},${PID2},${PID_ORDER})&select=id`, { token: adminToken });
  const leftCat = await rest("GET", `categories?slug=like.zz-security-probe*&select=id`, { token: adminToken });
  const leftOrders = orderIds.length ? await rest("GET", `orders?id=in.(${orderIds.join(",")})&select=id`, { token: adminToken }) : { json: [] };
  const clean = left.json?.length === 0 && leftCat.json?.length === 0 && leftOrders.json?.length === 0;
  const onlyOrdersLeft = left.json?.length === 0 && leftCat.json?.length === 0 && leftOrders.json?.length > 0;
  console.log(`  probe rows removed: ${clean ? "yes" : onlyOrdersLeft ? "all except the probe ORDERS (expected since 0010: orders can't be deleted through the API — they are cancelled and off the board). Remove with:" : "NO — remove manually:"}`);
  if (!clean) {
    if (orderIds.length) console.log(`    delete from public.orders where id in (${orderIds.map((id) => `'${id}'`).join(",")});`);
    console.log("    delete from public.products where id in ('900000001','900000002','900000003','900000004');\n    delete from public.subcategories where slug like 'zz-security-probe%';\n    delete from public.categories where slug like 'zz-security-probe%';\n    (and delete the object products/900000001/probe.png from bucket product-images)");
  }
}

// ---------------------------------------------------------------- club probes (migrations 0011-0013)
const MEMBER_RPCS = ["get_my_customer", "get_my_orders", "claim_guest_orders", "join_club", "set_marketing_consent", "delete_my_account"];
const OWNER_CUSTOMER_FNS = [
  ["admin_customer_stats", {}],
  ["admin_list_customers", {}],
  ["admin_export_audience", { p_kind: "suppression" }],
];
/** Columns a customer must NEVER get back from get_my_orders() (internal / staff-only / identifying). */
const MY_ORDERS_FORBIDDEN_KEYS = ["cancel_reason", "stock_return_status", "idempotency_key", "customer_id", "phone_digits", "phone_e164", "actor_label", "actor_id", "status_changed_at"];

const refused = (r) => r.status >= 400;
/** What to print when a check on a READ fails: the status and the row count only — never the body, which on a live project could be real customer data. */
const brief = (r) => `HTTP ${r.status}${Array.isArray(r.json) ? ` (${r.json.length} rows)` : ""}`;

/**
 * Part 1 — what an ORDINARY logged-in user (USER_EMAIL: logged in, not in admin_users, NOT a club member) can and
 * cannot do. This is the permission surface every future club member has, so it is THE gate before public
 * sign-ups are enabled: once phone login is on, "authenticated" stops meaning "back-office".
 * Needs only USER_EMAIL / USER_PASSWORD (no phone number). Returns true if it ran.
 */
async function clubPlainUserChecks() {
  if (!userToken) {
    skipped.push("club permissions (set USER_EMAIL / USER_PASSWORD: an ordinary non-admin user WITHOUT a phone number and NOT a club member)");
    section("Club permissions  --  SKIPPED (set USER_EMAIL / USER_PASSWORD)");
    return false;
  }
  const probe = await rpc("get_my_customer", userToken);
  if (probe.status === 404 || pgCode(probe) === "PGRST202") {
    skipped.push("club permissions (apply supabase/migrations/0011-0013, then re-run)");
    section("Club permissions  --  SKIPPED: migration 0012 is not applied yet");
    return false;
  }
  section("Club (migrations 0011-0013) — an ordinary logged-in user: nothing admin, nothing of anyone else's");
  let r;
  check("(fixture) USER is not a club member (use a plain user: no phone number, never joined)", probe.status === 200 && probe.json === null, `HTTP ${probe.status} ${probe.text.slice(0, 100)}`);

  // -- every table that holds club / order data is closed to them
  for (const t of ["customers", "customer_consents", "customer_addresses", "customer_exports", "orders", "order_items", "order_status_events", "admin_users"]) {
    r = await rest("GET", `${t}?select=*&limit=1`, { token: userToken });
    check(`ordinary user sees nothing in ${t}`, deniedOrEmpty(r), brief(r));
  }
  // -- ...and nothing can be written, including pretending to be a member
  for (const [n, method, path, body] of [
    ["make themselves a member (INSERT customers)", "POST", "customers", { id: userId, phone_e164: "+972501234567" }],
    ["write a consent record", "POST", "customer_consents", { customer_id: userId, kind: "marketing", granted: true, wording_version: "v1", source: "account" }],
    ["save an address without being a member", "POST", "customer_addresses", { customer_id: userId, street: "הרצל", house_number: "1" }],
    ["write the export log", "POST", "customer_exports", { actor_label: "x", kind: "sms", row_count: 0 }],
    ["edit a customer profile", "PATCH", `customers?id=eq.${userId}`, { first_name: "x" }],
    ["delete addresses", "DELETE", `customer_addresses?customer_id=eq.${userId}`, undefined],
    ["delete consents", "DELETE", `customer_consents?customer_id=eq.${userId}`, undefined],
    ["rewrite an order's owner", "PATCH", "orders?customer_id=is.null", { customer_id: userId }],
  ]) {
    r = await rest(method, path, { token: userToken, body });
    check(`ordinary user cannot ${n}`, refused(r) || isEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }

  // -- the member RPCs: harmless for a non-member, and joining needs BOTH mandatory confirmations
  r = await rpc("get_my_orders", userToken, { p_limit: 50 });
  check("get_my_orders() is an empty list for a non-member", r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("claim_guest_orders", userToken);
  check("claim_guest_orders() claims nothing for a non-member", r.status === 200 && r.json === 0, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("join_club", userToken, { p_payload: {} });
  check("join_club() refuses without the 21+ confirmation", refused(r) && /AGE_21_REQUIRED/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("join_club", userToken, { p_payload: { age_21_confirmed: true } });
  check("join_club() refuses without the marketing consent", refused(r) && /MARKETING_CONSENT_REQUIRED/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("join_club", userToken, { p_payload: { age_21_confirmed: true, marketing_consent: "yes" } });
  check("join_club() accepts only a real true (not a truthy string)", refused(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("set_marketing_consent", userToken, { p_granted: true });
  check("set_marketing_consent() is refused for a non-member", refused(r) && /NOT_A_MEMBER|permission denied/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("get_my_customer", userToken);
  check("...and none of that made them a member", r.status === 200 && r.json === null, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

  // -- anonymous visitors cannot touch any member function
  for (const fn of MEMBER_RPCS) {
    r = await rpc(fn, ANON, fn === "join_club" ? { p_payload: {} } : fn === "set_marketing_consent" ? { p_granted: true } : {});
    check(`anon cannot call ${fn}()`, refused(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }

  // -- the owner's customer tools are OWNER-only: not anon, not an ordinary user, not staff
  for (const [fn, args] of OWNER_CUSTOMER_FNS) {
    for (const [who, token] of [["anon", ANON], ["an ordinary logged-in user", userToken], ...(staffToken ? [["staff", staffToken]] : [])]) {
      r = await rpc(fn, token, args);
      check(`${who} cannot call ${fn}()`, refused(r) && !Array.isArray(r.json) && !/"members"|"rows"/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
  }

  // -- internal helpers are not reachable through the API at all (even for the owner)
  for (const [fn, args] of [
    ["customer_marketing_state", {}],
    ["customers_filtered", { p_term: null, p_marketing: "all" }],
    ["customer_apply_order", { p_order_id: randomUUID() }],
    ["normalize_il_phone", { p_raw: "0501234567" }],
  ]) {
    for (const [who, token] of [["an ordinary user", userToken], ["the owner", adminToken]]) {
      r = await rpc(fn, token, args);
      check(`${who} cannot call the internal ${fn}()`, refused(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
  }

  // -- the owner reaches customer data ONLY through the audited functions, never the tables
  for (const t of ["customers", "customer_consents", "customer_addresses", "customer_exports"]) {
    r = await rest("GET", `${t}?select=*&limit=1`, { token: adminToken });
    check(`the owner has no direct table access to ${t}`, deniedOrEmpty(r), brief(r));
  }
  // -- the owner's functions work and answer in the shape the screen expects (counts only: no personal data is read here)
  r = await rpc("admin_customer_stats", adminToken);
  check("the owner's admin_customer_stats() answers with counts", r.status === 200 && typeof r.json?.members === "number" && typeof r.json?.withdrawn === "number" && typeof r.json?.last_exports === "object", `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  r = await rpc("admin_list_customers", adminToken, { p_limit: 1 });
  check("admin_list_customers() answers { total, rows } and never more than asked", r.status === 200 && typeof r.json?.total === "number" && Array.isArray(r.json?.rows) && r.json.rows.length <= 1, `HTTP ${r.status}`);
  check("...its rows hold no address or consent text", (r.json?.rows ?? []).every((row) => !("street" in row) && !("terms_version" in row) && !("deleted_at" in row)));
  r = await rpc("admin_list_customers", adminToken, { p_marketing: "everyone" });
  check("an unknown filter is refused", refused(r) && /INVALID_FILTER/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await rpc("admin_export_audience", adminToken, { p_kind: "everyone" });
  check("an unknown export kind is refused (and nothing is exported or logged)", refused(r) && /INVALID_KIND/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  return true;
}

/**
 * Part 2 (optional) — the full lifecycle of a REAL club member, against the live project. Needs a dedicated test user
 * (MEMBER_EMAIL / MEMBER_PASSWORD) that is NOT in admin_users and has a verified Israeli MOBILE number on the auth user —
 * join_club() reads the phone from auth.users, never from the request. Create it in the SQL editor, e.g.:
 *     update auth.users set phone = '9725XXXXXXXX', phone_confirmed_at = now() where email = 'zz-member-probe@example.test';
 * The test joins it, places a probe order, checks isolation, withdraws and re-grants marketing, and finally DELETES the
 * account (delete_my_account: profile + addresses removed, the probe order kept but unlinked, only the phone stays on the
 * emptied row as a suppression record — the next run simply re-joins). Called from inside the orders section, where the
 * hidden probe product and the order helpers exist.
 */
async function clubMemberChecks({ createOrder, orderPayload }) {
  if (!MEMBER_EMAIL || !MEMBER_PASSWORD) {
    skipped.push("club member lifecycle (set MEMBER_EMAIL / MEMBER_PASSWORD: a dedicated non-admin test user with a verified mobile phone set on auth.users)");
    section("Club member lifecycle  --  SKIPPED (set MEMBER_EMAIL / MEMBER_PASSWORD)");
    return;
  }
  const probe = await rpc("get_my_customer", userToken || ANON);
  if (probe.status === 404 || pgCode(probe) === "PGRST202") return; // migration 0012 missing — reported by the plain-user part
  const m = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  if (m.error) { check("(fixture) club member test user signs in", false, m.error); return; }
  const mt = m.token, mid = m.userId;
  section("Club member lifecycle — a real member against the live project (the test user is deleted again at the end)");
  let r;
  const placed = []; // this run's probe orders placed as / next to the member
  const myOrder = async (id) => (await rest("GET", `orders?id=eq.${id}&select=id,customer_id`, { token: adminToken })).json?.[0];

  try {
    // ---- joining
    const existing = (await rpc("get_my_customer", mt)).json;
    if (existing === null) {
      r = await rpc("join_club", mt, { p_payload: { wording_version: "v1" } });
      check("a fresh member cannot join without the confirmations", refused(r) && /AGE_21_REQUIRED/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("join_club", mt, { p_payload: { age_21_confirmed: true, wording_version: "v1" } });
      check("...nor with only the 21+ confirmation", refused(r) && /MARKETING_CONSENT_REQUIRED/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("join_club", mt, { p_payload: { age_21_confirmed: true, marketing_consent: true, wording_version: "v1", channels: ["sms", "email"], phone: "+972500000000" } });
      check("joining with both confirmations works", r.status === 200 && r.json?.created === true, `HTTP ${r.status}`);
      check("...the phone comes from the login (auth.users), NOT from the request (a phone sent in the body is ignored)", /^\+9725\d{8}$/.test(r.json?.phone ?? "") && r.json?.phone !== "+972500000000", `phone: ${(r.json?.phone ?? "").replace(/\d(?=\d{3})/g, "*")}`);
    } else {
      console.log("  note  the test user was already a member (a previous run did not finish) — continuing with it");
    }
    r = await rpc("join_club", mt, { p_payload: {} });
    check("joining again is harmless and needs no confirmation", r.status === 200 && r.json?.created === false, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const profile = (await rpc("get_my_customer", mt)).json;
    check("get_my_customer(): a member with the consent on record", profile?.marketing === true && typeof profile?.age_21_confirmed_at === "string", JSON.stringify(profile ? { ...profile, phone: "***", id: "***" } : null));

    // ---- an order placed as a member is attached by the DATABASE; the probe stock is topped up first (earlier sections used it)
    await rest("PATCH", `products?id=eq.${PID_ORDER}`, { token: adminToken, body: { stock_base_units: 50 } });
    r = await createOrder(mt, orderPayload({}, { street: "הרצל", house_number: "1" }), randomUUID());
    const oid = r.json?.order_id;
    if (oid) { orderIds.push(oid); placed.push(oid); }
    check("(fixture) the member places a probe order", r.status === 200 && typeof oid === "string", `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    check("the order is attached to the member by the database", (await myOrder(oid))?.customer_id === mid);
    r = await createOrder(ANON, orderPayload({}, { customer_id: mid }), randomUUID());
    const sneakyId = r.json?.order_id;
    if (sneakyId) { orderIds.push(sneakyId); placed.push(sneakyId); }
    check("a customer_id smuggled into a guest order is ignored", r.status === 200 && (await myOrder(sneakyId))?.customer_id === null, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("GET", "customer_addresses?select=street,house_number", { token: mt });
    check("the delivery address was saved automatically by the order", Array.isArray(r.json) && r.json.some((a) => a.street === "הרצל" && a.house_number === "1"), `HTTP ${r.status} ${r.text.slice(0, 120)}`);

    // ---- a member sees their orders ONLY through the whitelisted function
    r = await rpc("get_my_orders", mt, { p_limit: 20 });
    const mine = Array.isArray(r.json) ? r.json.find((o) => o.id === oid) : undefined;
    check("get_my_orders() lists the member's order, with its items", !!mine && Array.isArray(mine.items) && mine.items.length === 1 && mine.order_status === "confirmed", brief(r));
    check("...and none of the internal fields (cancel reason, stock state, idempotency key, customer id, staff names)",
      !!mine && MY_ORDERS_FORBIDDEN_KEYS.every((k) => !(k in mine)), mine ? Object.keys(mine).join(",") : "");
    check("...the sneaky guest order is not theirs", Array.isArray(r.json) && !r.json.some((o) => o.id === sneakyId));
    for (const t of ["orders", "order_items", "order_status_events"]) {
      r = await rest("GET", `${t}?select=*&limit=1`, { token: mt });
      check(`the member cannot read ${t} through the table API`, deniedOrEmpty(r), brief(r));
    }
    r = await rpc("transition_order", mt, { p_order_id: oid, p_expected_status: "confirmed", p_to_status: "cancelled", p_reason: "x" });
    check("the member cannot move or cancel orders (back-office only)", refused(r) && /NOT_AUTHORIZED|permission denied/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    for (const [fn, args] of OWNER_CUSTOMER_FNS) {
      r = await rpc(fn, mt, args);
      check(`the member cannot call the owner's ${fn}()`, refused(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // ---- their own profile: editable only in the safe columns
    r = await rest("GET", "customers?select=id", { token: mt });
    check("the member reads exactly their own profile row", Array.isArray(r.json) && r.json.length === 1 && r.json[0].id === mid, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("PATCH", `customers?id=eq.${mid}`, { token: mt, body: { first_name: "zz-probe" } });
    check("...they can edit their name", r.status === 200 && r.json?.[0]?.first_name === "zz-probe", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    for (const [n, body] of [["phone number", { phone_e164: "+972500000001" }], ["terms record", { terms_version: "v9" }], ["deleted flag", { deleted_at: new Date().toISOString() }], ["join date", { joined_at: "2000-01-01T00:00:00Z" }]]) {
      r = await rest("PATCH", `customers?id=eq.${mid}`, { token: mt, body });
      check(`...but not their ${n}`, refused(r) || isEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    r = await rest("POST", "customer_consents", { token: mt, body: { customer_id: mid, kind: "marketing", granted: true, wording_version: "v9", source: "account" } });
    check("the member cannot write consent records directly (only the functions do)", refused(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("PATCH", `customer_consents?customer_id=eq.${mid}`, { token: mt, body: { granted: false } });
    check("...nor rewrite history", refused(r) || isEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // ---- isolation: nobody else — not another user, not the owner — can reach this member's data through the tables
    if (userToken) {
      for (const [t, col] of [["customers", "id"], ["customer_addresses", "customer_id"], ["customer_consents", "customer_id"]]) {
        r = await rest("GET", `${t}?${col}=eq.${mid}&select=*`, { token: userToken });
        check(`another logged-in user cannot read the member's ${t}`, deniedOrEmpty(r), brief(r));
      }
      r = await rest("PATCH", `customers?id=eq.${mid}`, { token: userToken, body: { first_name: "hijack" } });
      check("another user cannot edit the member's profile", refused(r) || isEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("get_my_orders", userToken, { p_limit: 50 });
      check("another user's get_my_orders() does not include the member's order", Array.isArray(r.json) && !r.json.some((o) => o.id === oid), `HTTP ${r.status}`);
    }
    for (const t of ["customers", "customer_addresses", "customer_consents"]) {
      r = await rest("GET", `${t}?select=*&limit=1`, { token: adminToken });
      check(`the owner still has no table access to the member's ${t}`, deniedOrEmpty(r), brief(r));
    }

    // ---- consent: withdrawn through the function, visible to the owner's numbers, re-grantable
    const before = (await rpc("admin_customer_stats", adminToken)).json;
    r = await rpc("set_marketing_consent", mt, { p_granted: false });
    check("withdrawing marketing consent works and keeps the account", r.status === 200 && r.json?.marketing === false && r.json?.id === mid, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const after = (await rpc("admin_customer_stats", adminToken)).json;
    check("the owner's numbers move: one fewer reachable by SMS, one more withdrawn", after?.withdrawn === (before?.withdrawn ?? 0) + 1 && after?.marketing_sms === (before?.marketing_sms ?? 0) - 1, JSON.stringify({ before: before?.withdrawn, after: after?.withdrawn }));
    r = await rpc("set_marketing_consent", mt, { p_granted: true, p_channels: ["sms"] });
    check("granting it again records the chosen channel", r.status === 200 && r.json?.marketing === true && JSON.stringify(r.json?.marketing_channels) === '["sms"]', `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("GET", "customer_consents?select=kind,granted&order=id", { token: mt });
    // The history is append-only and survives delete + re-join (same account id), so earlier runs' entries are still
    // there: this run's join / withdraw / re-grant are the LAST three marketing entries.
    check("the member can read their own consent history (append-only: age, marketing on, off, on)",
      Array.isArray(r.json) && r.json.filter((c) => c.kind === "marketing").map((c) => c.granted).slice(-3).join() === "true,false,true", `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  } finally {
    // ---- the right to be forgotten — and leave the test user as it was found
    r = await rpc("delete_my_account", mt);
    check("delete_my_account() succeeds", r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const gone = await rpc("get_my_customer", mt);
    check("...afterwards they are no longer a member and see no orders or addresses",
      gone.json === null && (await rpc("get_my_orders", mt)).json?.length === 0 && (await rest("GET", "customer_addresses?select=id", { token: mt })).json?.length === 0, `HTTP ${gone.status} ${gone.text.slice(0, 100)}`);
    const kept = placed.length ? await rest("GET", `orders?id=in.(${placed.join(",")})&select=id,customer_id`, { token: adminToken }) : { json: [] };
    check("their past orders are kept for accounting but no longer linked to the account", placed.length > 0 && Array.isArray(kept.json) && kept.json.length === placed.length && kept.json.every((o) => o.customer_id === null), JSON.stringify(kept.json));
  }
}

/**
 * Coupons (migration 0014) — read-only / refusal probes, nothing persists. Coupons are a member-only benefit: the tables are
 * the owner's alone, the apply-coupon RPC refuses everyone who is not an active member WITHOUT revealing which codes exist,
 * and nobody but the order functions writes redemptions. (The full eligibility / limits / lifecycle matrix runs in-process in
 * scripts/verify-order-management.mjs; here we prove the live project's permissions match.)
 */
async function couponChecks() {
  let r = await rest("GET", "coupons?select=id&limit=1", { token: adminToken });
  if (r.status === 404 || pgCode(r) === "PGRST205" || pgCode(r) === "42P01") {
    skipped.push("coupons (apply supabase/migrations/0014_coupons.sql, then re-run)");
    section("Coupons  --  SKIPPED: migration 0014 is not applied yet");
    return;
  }
  section("Coupons (migration 0014) — owner-only tables, member-only redemption");
  check("the owner can read the coupon tables", r.status === 200
    && (await rest("GET", "coupon_redemptions?select=id&limit=1", { token: adminToken })).status === 200
    && (await rest("GET", "coupon_events?select=id&limit=1", { token: adminToken })).status === 200);
  const who = [["anon", ANON], ...(userToken ? [["an ordinary logged-in user", userToken]] : []), ...(staffToken ? [["staff", staffToken]] : [])];
  for (const [name, token] of who) {
    for (const t of ["coupons", "coupon_redemptions", "coupon_events", "coupon_attempts"]) {
      r = await rest("GET", `${t}?select=*&limit=1`, { token });
      check(`${name} sees nothing in ${t}`, deniedOrEmpty(r), brief(r));
    }
    r = await rest("POST", "coupons", { token, body: { code: "ZZPROBE1", title: "x", discount_type: "percent", discount_value: 99 } });
    check(`${name} cannot create a coupon`, refused(r), brief(r));
    r = await rest("PATCH", "coupons?code=eq.ZZPROBE1", { token, body: { is_active: false } });
    check(`${name} cannot edit a coupon`, refused(r) || isEmpty(r), brief(r));
    r = await rest("POST", "coupon_redemptions", { token, body: { coupon_id: randomUUID(), order_id: randomUUID(), phone_e164: "+972500000000", discount_cents: 1, status: "redeemed" } });
    check(`${name} cannot write a redemption`, refused(r), brief(r));
  }
  r = await rest("DELETE", `coupons?id=eq.${randomUUID()}`, { token: adminToken });
  check("even the owner cannot delete a coupon (archive only)", refused(r), brief(r));
  r = await rpc("preview_coupon", ANON, { p_code: "ZZPROBE1", p_subtotal_cents: 10000 });
  check("anon cannot call preview_coupon()", refused(r), brief(r));
  if (userToken) {
    for (const code of ["ZZPROBE1", "NO-SUCH-CODE"]) {
      r = await rpc("preview_coupon", userToken, { p_code: code, p_subtotal_cents: 10000 });
      check(`a non-member gets COUPON_MEMBERS_ONLY for "${code}" (no hint whether the code exists)`, r.status === 200 && r.json?.valid === false && r.json?.reason === "COUPON_MEMBERS_ONLY", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  r = await rpc("normalize_coupon_code", ANON, { p_raw: "x" });
  check("the internal helpers are not callable by anon", refused(r), brief(r));
  r = await rpc("coupon_evaluate", userToken || ANON, { p_code: "x", p_subtotal_cents: 1, p_delivery_fee_cents: 0, p_lock: false });
  check("coupon_evaluate() is not reachable through the API", refused(r), brief(r));
  r = await call("POST", `${URL_}/rest/v1/rpc/get_business_settings`, { body: {} });
  check("the public settings expose club_offer_text (plain text or null) and nothing about coupons", r.status === 200 && "club_offer_text" in (r.json ?? {})
    && !/coupon/i.test(JSON.stringify(Object.keys(r.json ?? {}))), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
}

/**
 * Costs and barcodes (migration 0016) — read-only / refusal probes, nothing persists. Purchase costs, the supplier
 * dictionary and the carton-barcode blocklist are the owner's alone; staff, ordinary users and anonymous visitors see and
 * write nothing, and neither the public catalog nor the public settings carry a cost or the VAT setting.
 */
async function costChecks() {
  let r = await rest("GET", "product_costs?select=product_id&limit=1", { token: adminToken });
  if (r.status === 404 || pgCode(r) === "PGRST205" || pgCode(r) === "42P01") {
    skipped.push("costs (apply supabase/migrations/0016_costs.sql, then re-run)");
    section("Costs  --  SKIPPED: migration 0016 is not applied yet");
    return;
  }
  section("Costs and barcodes (migration 0016) — owner only");
  const TABLES = ["suppliers", "product_costs", "cost_history", "supplier_items", "barcode_blocklist"];
  let ownerReads = r.status === 200;
  for (const t of TABLES.slice(1)) ownerReads = ownerReads && (await rest("GET", `${t}?select=*&limit=1`, { token: adminToken })).status === 200;
  check("the owner can read every costs table", ownerReads);
  r = await rpc("admin_cost_overview", adminToken);
  check("the owner gets admin_cost_overview()", r.status === 200 && Array.isArray(r.json?.products), brief(r));
  r = await rest("POST", "product_costs", { token: adminToken, body: { product_id: "1", unit_cost_ex_vat: 1 } });
  check("even the owner writes costs only through admin_set_product_cost() (no direct insert)", refused(r), brief(r));
  r = await rest("DELETE", "cost_history?id=eq.-1", { token: adminToken });
  check("the cost history cannot be deleted through the API", refused(r) || isEmpty(r), brief(r));

  const who = [["anon", ANON], ...(userToken ? [["an ordinary logged-in user", userToken]] : []), ...(staffToken ? [["staff", staffToken]] : [])];
  for (const [name, token] of who) {
    for (const t of TABLES) {
      r = await rest("GET", `${t}?select=*&limit=1`, { token });
      check(`${name} sees nothing in ${t}`, deniedOrEmpty(r), brief(r));
    }
    r = await rpc("admin_cost_overview", token);
    check(`${name} cannot call admin_cost_overview()`, refused(r), brief(r));
    r = await rpc("admin_set_product_cost", token, { p_product_id: "1", p_supplier_id: null, p_cost_ex_vat: 1 });
    check(`${name} cannot set a cost`, refused(r), brief(r));
    r = await rest("POST", "barcode_blocklist", { token, body: { barcode: "0000000000000", note: "probe" } });
    check(`${name} cannot add to the barcode blocklist`, refused(r), brief(r));
    r = await rest("POST", "supplier_items", { token, body: { supplier_id: "dubek", supplier_code: "ZZPROBE", product_id: "1", units_per_supplier_unit: 10 } });
    check(`${name} cannot write the supplier dictionary`, refused(r), brief(r));
  }
  r = await call("POST", `${URL_}/rest/v1/rpc/get_business_settings`, { body: {} });
  check("the public settings carry neither the VAT nor the low-margin setting", r.status === 200 && !("vat_percent" in (r.json ?? {})) && !("low_margin_percent" in (r.json ?? {})), `HTTP ${r.status}`);
  r = await call("POST", `${URL_}/rest/v1/rpc/get_storefront_catalog`, { body: {} });
  check("the public catalog carries no cost, supplier, barcode or review note", r.status === 200 && !/unit_cost|supplier|review_note|barcode/.test(r.text), `HTTP ${r.status}`);
}

/**
 * Part 2d — delivery windows and the courier (migration 0017). Windows are the owner's; runs are read by back office only; a
 * courier has no table access at all and only the courier_* RPCs, which show customer details solely for a run he claimed.
 * Needs COURIER_EMAIL / COURIER_PASSWORD (a user inserted into admin_users with role 'courier') for the courier half.
 */
async function deliveryChecks() {
  let r = await rest("GET", "delivery_windows?select=id&limit=1", { token: adminToken });
  if (r.status === 404 || pgCode(r) === "PGRST205" || pgCode(r) === "42P01") {
    skipped.push("delivery (apply supabase/migrations/0017_delivery.sql, then re-run)");
    section("Delivery  --  SKIPPED: migration 0017 is not applied yet");
    return;
  }
  section("Delivery windows, runs and the courier (migration 0017)");
  check("the owner can read the windows and the runs", r.status === 200 && (await rest("GET", "delivery_runs?select=id&limit=1", { token: adminToken })).status === 200);
  const who = [["anon", ANON], ...(userToken ? [["an ordinary logged-in user", userToken]] : []), ...(courierToken ? [["a courier", courierToken]] : [])];
  for (const [name, token] of who) {
    for (const t of ["delivery_windows", "delivery_runs", "delivery_run_events"]) {
      r = await rest("GET", `${t}?select=*&limit=1`, { token });
      check(`${name} sees nothing in ${t}`, deniedOrEmpty(r), brief(r));
    }
    r = await rest("POST", "delivery_windows", { token, body: { departure_time: "23:00", order_cutoff_time: "22:00" } });
    check(`${name} cannot create a delivery window`, refused(r), brief(r));
    r = await rpc("claim_delivery_run", token, { p_run_id: randomUUID() });
    check(`${name} cannot claim a run`, name === "a courier" ? r.status >= 400 && /RUN_NOT_FOUND/.test(r.text) : refused(r), brief(r));
  }
  if (staffToken) {
    r = await rest("POST", "delivery_windows", { token: staffToken, body: { departure_time: "23:00", order_cutoff_time: "22:00" } });
    check("staff cannot create a delivery window (owner-only)", refused(r), brief(r));
    r = await rpc("courier_list_open_runs", staffToken);
    check("staff (not a courier) cannot use the courier screens", refused(r), brief(r));
  }
  r = await rpc("get_delivery_slots", ANON);
  check("anyone can read get_delivery_slots(), and it never carries a capacity or an order count", r.status === 200 && Array.isArray(r.json) && !/capacity|order_count/.test(r.text), brief(r));
  r = await call("POST", `${URL_}/rest/v1/rpc/get_business_settings`, { body: {} });
  check("the public settings list windows without a capacity", r.status === 200 && !/capacity/.test(JSON.stringify(r.json?.delivery_windows ?? [])), `HTTP ${r.status}`);

  if (!courierToken) {
    skipped.push("courier role checks (set COURIER_EMAIL / COURIER_PASSWORD: a user in admin_users with role 'courier')");
    section("Courier role  --  SKIPPED (set COURIER_EMAIL / COURIER_PASSWORD)");
    return;
  }
  section("Courier role — delivery runs only");
  r = await rpc("get_my_access", courierToken);
  check("get_my_access() says courier", r.status === 200 && r.json?.role === "courier" && r.json?.courier === true, brief(r));
  r = await rpc("is_staff", courierToken);
  check("is_staff() is FALSE for a courier", r.status === 200 && r.json === false, brief(r));
  r = await rpc("is_admin", courierToken);
  check("is_admin() is FALSE for a courier", r.status === 200 && r.json === false, brief(r));
  for (const t of ["orders", "order_items", "order_status_events", "categories", "products", "business_settings", "payment_attempts", "customers"]) {
    r = await rest("GET", `${t}?select=*&limit=1`, { token: courierToken });
    check(`a courier sees nothing in ${t}`, deniedOrEmpty(r), brief(r));
  }
  r = await rpc("transition_order", courierToken, { p_order_id: randomUUID(), p_expected_status: "confirmed", p_to_status: "preparing", p_reason: null });
  check("a courier cannot move orders with transition_order()", r.status >= 400 && /NOT_AUTHORIZED|permission denied/i.test(r.text), brief(r));
  r = await rpc("resolve_stock_return", courierToken, { p_order_id: randomUUID(), p_outcome: "returned" });
  check("a courier cannot confirm a stock return", r.status >= 400 && /NOT_AUTHORIZED|permission denied/i.test(r.text), brief(r));
  r = await rpc("courier_list_open_runs", courierToken);
  check("a courier CAN list open runs, and the list carries no customer details", r.status === 200 && Array.isArray(r.json) && !ORDER_PII_KEYS.test(r.text), brief(r));
  r = await rpc("courier_my_runs", courierToken);
  check("a courier CAN read his own runs", r.status === 200 && Array.isArray(r.json), brief(r));
  r = await rpc("complete_delivery_stop", courierToken, { p_order_id: randomUUID(), p_id_checked: true });
  check("a courier cannot complete a stop that is not in a run of his", r.status >= 400 && /ORDER_NOT_FOUND|NOT_AUTHORIZED/.test(r.text), brief(r));
  r = await rpc("fail_delivery_stop", courierToken, { p_order_id: randomUUID(), p_reason: "x" });
  check("...nor fail one", r.status >= 400 && /ORDER_NOT_FOUND|NOT_AUTHORIZED/.test(r.text), brief(r));
}

/**
 * Part 2e — what each courier is owed (migration 0018). Owner only, end to end: the pay tables are closed to the API (not even the
 * owner reads them directly), and the five admin_* functions refuse everyone who is not the owner.
 */
async function courierPayChecks() {
  let r = await rpc("admin_courier_payroll", adminToken, { p_month: new Date().toISOString().slice(0, 7) + "-01" });
  if (r.status === 404 || pgCode(r) === "PGRST202") {
    skipped.push("courier pay (apply supabase/migrations/0018_courier_pay.sql, then re-run)");
    section("Courier pay  --  SKIPPED: migration 0018 is not applied yet");
    return;
  }
  section("Courier pay (migration 0018) — owner only");
  check("the owner gets the payroll", r.status === 200 && Array.isArray(r.json?.couriers) && typeof r.json?.default_rate_cents === "number", brief(r));
  const month = new Date().toISOString().slice(0, 7) + "-01";
  for (const t of ["delivery_pay", "courier_payouts"]) {
    r = await rest("GET", `${t}?select=*&limit=1`, { token: adminToken });
    check(`even the owner cannot read ${t} through the table API (only through the payroll function)`, deniedOrEmpty(r), brief(r));
  }
  const who = [["anon", ANON], ...(userToken ? [["an ordinary logged-in user", userToken]] : []), ...(staffToken ? [["staff", staffToken]] : []), ...(courierToken ? [["a courier", courierToken]] : [])];
  for (const [name, token] of who) {
    r = await rpc("admin_courier_payroll", token, { p_month: month });
    check(`${name} cannot read the payroll`, refused(r), brief(r));
    r = await rpc("admin_set_courier_pay", token, { p_order_id: randomUUID(), p_pay_cents: 99999 });
    check(`${name} cannot set what a delivery pays`, refused(r), brief(r));
    r = await rpc("admin_set_courier_rate", token, { p_user_id: randomUUID(), p_cents: 99999 });
    check(`${name} cannot set a courier's rate`, refused(r), brief(r));
    r = await rpc("admin_record_courier_payout", token, { p_courier_id: randomUUID(), p_month: month, p_amount_cents: 100, p_note: null });
    check(`${name} cannot record a payout`, refused(r), brief(r));
    r = await rest("PATCH", "business_settings?id=eq.1", { token, body: { courier_pay_cents: 99999 } });
    check(`${name} cannot change the default rate`, deniedOrEmpty(r) || refused(r), brief(r));
  }
  r = await rpc("admin_set_courier_pay", adminToken, { p_order_id: randomUUID(), p_pay_cents: 100 });
  check("the owner setting the pay of an order that has none is refused (NO_PAY_RECORD)", r.status >= 400 && /NO_PAY_RECORD/.test(r.text), brief(r));
  r = await rpc("admin_set_courier_rate", adminToken, { p_user_id: randomUUID(), p_cents: 100 });
  check("...and a rate for someone who is not a courier (NOT_A_COURIER)", r.status >= 400 && /NOT_A_COURIER/.test(r.text), brief(r));
  r = await call("POST", `${URL_}/rest/v1/rpc/get_business_settings`, { body: {} });
  check("the public settings carry no courier rate", r.status === 200 && !/courier_pay|pay_per/.test(r.text), `HTTP ${r.status}`);
}

/**
 * Part 3 (opt-in: --signups-enabled) — for AFTER public sign-ups are switched on. Instead of expecting self-registration
 * to be refused, proves a freshly self-registered user has no power at all. NOTE: it creates a throwaway, unconfirmed
 * user that this script cannot delete (no service-role key, by design) — remove it in Authentication -> Users.
 */
async function signupsEnabledChecks() {
  section("Public sign-ups are ON: a self-registered user has no power");
  const email = `zz-security-probe-${Date.now()}@example.invalid`;
  const r = await call("POST", `${URL_}/auth/v1/signup`, { body: { email, password: randomUUID() + "Aa1!" } });
  const token = r.json?.access_token;
  if (!token) {
    check("an e-mail sign-up does not log the stranger in (confirmation required, or sign-up refused)", r.status >= 200 && r.status < 500, `HTTP ${r.status}`);
    console.log(`  note  throwaway user ${email} may exist (unconfirmed) — delete it in Authentication -> Users`);
    return;
  }
  console.log(`  note  throwaway user ${email} WAS logged in immediately (e-mail confirmation is OFF) — delete it in Authentication -> Users`);
  let x;
  x = await rpc("is_admin", token);
  check("a self-registered user is not an admin", x.json === false, `HTTP ${x.status} ${x.text.slice(0, 80)}`);
  x = await rpc("get_my_role", token);
  check("...has no back-office role", x.json === null, `HTTP ${x.status} ${x.text.slice(0, 80)}`);
  for (const t of ["categories", "products", "business_settings", "orders", "order_items", "order_status_events", "payment_attempts", "customers", "customer_consents", "customer_addresses", "customer_exports", "admin_users"]) {
    x = await rest("GET", `${t}?select=*&limit=1`, { token });
    check(`...and sees nothing in ${t}`, deniedOrEmpty(x), brief(x));
  }
  for (const [fn, args] of [...OWNER_CUSTOMER_FNS, ["expire_stale_orders", {}], ["admin_product_counts", {}]]) {
    x = await rpc(fn, token, args);
    check(`...cannot use ${fn}()`, refused(x) || (Array.isArray(x.json) && x.json.length === 0), `HTTP ${x.status} ${x.text.slice(0, 100)}`);
  }
  x = await rest("POST", "customers", { token, body: { id: r.json?.user?.id, phone_e164: "+972501234567" } });
  check("...cannot make themselves a club member by writing the table", refused(x), `HTTP ${x.status} ${x.text.slice(0, 100)}`);
  x = await rpc("join_club", token, { p_payload: { age_21_confirmed: true, marketing_consent: true } });
  check("...and join_club() refuses an e-mail-only account (a verified MOBILE number is required)", refused(x) && /MOBILE_REQUIRED/.test(x.text), `HTTP ${x.status} ${x.text.slice(0, 100)}`);
}

async function main() {
  // ------------------------------------------------------------------ sign-ins
  const a = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (a.error) { console.error(a.error); process.exit(1); }
  adminToken = a.token;
  if (USER_EMAIL && USER_PASSWORD) {
    const u = await signIn(USER_EMAIL, USER_PASSWORD);
    if (u.error) { console.error(u.error); process.exit(1); }
    userToken = u.token; userId = u.userId;
  }
  if (STAFF_EMAIL && STAFF_PASSWORD) {
    const st = await signIn(STAFF_EMAIL, STAFF_PASSWORD);
    if (st.error) { console.error(st.error); process.exit(1); }
    staffToken = st.token;
  }

  // ------------------------------------- 0015: open ordering for the probe orders (restored in cleanup)
  const s0015 = await rest("GET", "business_settings?id=eq.1&select=orders_paused,pickup_enabled,delivery_enabled,cash_enabled,card_enabled", { token: adminToken });
  if (s0015.status === 200 && s0015.json?.[0]) {
    const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short" }).format(new Date()));
    const h = await rest("GET", `business_hours?schedule_type=eq.orders&day_of_week=eq.${today}&select=day_of_week,is_open,open_time,close_time`, { token: adminToken });
    if (h.json?.[0]) {
      ordersOpenedFor0015 = { settings: s0015.json[0], hours: h.json[0] };
      await rest("PATCH", "business_settings?id=eq.1", { token: adminToken,
        body: { orders_paused: false, delivery_enabled: true, cash_enabled: true, card_enabled: true } });
      await rest("PATCH", `business_hours?schedule_type=eq.orders&day_of_week=eq.${today}`, { token: adminToken,
        body: { is_open: true, open_time: "00:00", close_time: "23:59:59" } });
    }
  }

  // ------------------------------------- 0017: no active delivery window while the probe orders are placed (restored in cleanup)
  const win0017 = await rest("GET", "delivery_windows?is_active=eq.true&select=id", { token: adminToken });
  if (win0017.status === 200 && (win0017.json ?? []).length) {
    windowsPausedFor0017 = win0017.json.map((w) => w.id);
    await rest("PATCH", `delivery_windows?id=in.(${windowsPausedFor0017.join(",")})`, { token: adminToken, body: { is_active: false } });
  }
  if (COURIER_EMAIL && COURIER_PASSWORD) {
    const c = await signIn(COURIER_EMAIL, COURIER_PASSWORD);
    if (c.error) { console.error(c.error); process.exit(1); }
    courierToken = c.token;
  }

  // ------------------------------------------------------- 0. admin sets up probes
  section("Admin: create probe rows (hidden), prove admin access works");
  check("admin is_admin() = true", (await rpc("is_admin", adminToken)).json === true);
  let r = await rest("POST", "categories", { token: adminToken, body: { id: CAT, slug: "zz-security-probe", name_he: "בדיקת אבטחה", is_visible: false, sort_order: 9999 } });
  created.cat = r.status === 201; check("admin can INSERT category", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  if (!created.cat) throw new Error("cannot continue without the probe category");
  r = await rest("POST", "subcategories", { token: adminToken, body: { id: SUB, category_id: CAT, slug: "zz-security-probe", name_he: "תת בדיקה", is_visible: false } });
  created.sub = r.status === 201; check("admin can INSERT subcategory", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  r = await rest("POST", "products", { token: adminToken, body: {
    id: PID, category_id: CAT, subcategory_id: SUB, name_he: "מוצר בדיקת אבטחה", brand: "ZZ", barcode: BARCODE,
    unit_price: 10, unit_sale_enabled: true, unit_sale_price: 8, track_stock: true, stock_base_units: 7,
    package_enabled: true, package_label: "מארז", package_unit_count: 6, package_price: 55, package_sale_enabled: true, package_sale_price: 50,
    is_visible: false } });
  created.product = r.status === 201; check("admin can INSERT product (unit sale + package + own sale)", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  check("admin can SELECT hidden product incl. barcode + shared stock", (await rest("GET", `products?id=eq.${PID}&select=barcode,stock_base_units`, { token: adminToken })).json?.[0]?.barcode === BARCODE);
  check("admin sees own admin_users row (guard query works)", (await rest("GET", "admin_users?select=user_id", { token: adminToken })).json?.length === 1);

  // -------------------------------------------------------------------- 1. anon
  section("Anonymous visitor (anon key only)");
  for (const t of ["categories", "subcategories", "products", "admin_users"]) {
    r = await rest("GET", `${t}?select=*&limit=1`);
    check(`anon cannot SELECT ${t}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }
  for (const [n, method, path, body] of [
    ["INSERT categories", "POST", "categories", { slug: "zz-anon", name_he: "x" }],
    ["INSERT subcategories", "POST", "subcategories", { category_id: CAT, slug: "zz-anon", name_he: "x" }],
    ["INSERT products", "POST", "products", { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 1 }],
    ["INSERT admin_users", "POST", "admin_users", { user_id: randomUUID() }],
    ["UPDATE products", "PATCH", `products?id=eq.${PID}`, { unit_price: 1 }],
    ["DELETE products", "DELETE", `products?id=eq.${PID}`, undefined],
    ["UPDATE categories", "PATCH", `categories?id=eq.${CAT}`, { name_he: "hacked" }],
    ["DELETE categories", "DELETE", `categories?id=eq.${CAT}`, undefined],
  ]) { r = await rest(method, path, { body }); check(`anon cannot ${n}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
  check("probe product unchanged after anon attempts", Number((await rest("GET", `products?id=eq.${PID}&select=unit_price`, { token: adminToken })).json?.[0]?.unit_price) === 10);
  r = await rpc("is_admin", ANON);
  check("anon cannot call is_admin()", isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await upload(`products/${PID}/anon.png`, ANON, PNG, "image/png");
  check("anon cannot upload to product-images", storageDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { body: { prefix: "", limit: 10 } });
  check("anon cannot LIST the image bucket", isDenied(r) || (r.status === 200 && Array.isArray(r.json) && r.json.length === 0), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

  const anonCat = await rpc("get_storefront_catalog", ANON);
  check("anon CAN call get_storefront_catalog()", anonCat.status === 200 && Array.isArray(anonCat.json?.categories) && Array.isArray(anonCat.json?.products), `HTTP ${anonCat.status}`);
  check("catalog excludes the hidden probe product/category", !anonCat.text.includes(PID) && !anonCat.text.includes("zz-security-probe"));
  check("catalog leaks no private fields (barcode, stock, availability, visibility, sort, timestamps)", !PRIVATE_KEYS.test(anonCat.text) && !anonCat.text.includes(BARCODE));

  // ------------------------------------------------------------- 2. non-admin user
  if (!userToken) {
    skipped.push("non-admin user group");
    section("Logged-in NON-admin user  --  SKIPPED (set USER_EMAIL / USER_PASSWORD: create a normal user under Authentication -> Users; do NOT add it to admin_users)");
  } else {
    section("Logged-in user who is NOT an admin");
    check("non-admin is_admin() = false", (await rpc("is_admin", userToken)).json === false);
    for (const t of ["categories", "subcategories", "products", "admin_users"]) {
      r = await rest("GET", `${t}?select=*`, { token: userToken });
      check(`non-admin sees 0 rows of ${t}`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    for (const [n, method, path, body] of [
      ["INSERT categories", "POST", "categories", { slug: "zz-user", name_he: "x" }],
      ["INSERT subcategories", "POST", "subcategories", { category_id: CAT, slug: "zz-user", name_he: "x" }],
      ["INSERT products", "POST", "products", { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 1 }],
      // random uuid on purpose (see note above): a real id could actually promote the test user if grants were broken
      ["INSERT INTO admin_users (self-promotion attempt)", "POST", "admin_users", { user_id: randomUUID() }],
    ]) { r = await rest(method, path, { token: userToken, body }); check(`non-admin cannot ${n}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    for (const [n, method, path, body] of [
      ["UPDATE products", "PATCH", `products?id=eq.${PID}`, { unit_price: 1 }],
      ["DELETE products", "DELETE", `products?id=eq.${PID}`, undefined],
      ["UPDATE categories", "PATCH", `categories?id=eq.${CAT}`, { name_he: "hacked" }],
      ["DELETE subcategories", "DELETE", `subcategories?id=eq.${SUB}`, undefined],
    ]) { r = await rest(method, path, { token: userToken, body }); check(`non-admin ${n} changes nothing`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    check("probe product unchanged after non-admin attempts", Number((await rest("GET", `products?id=eq.${PID}&select=unit_price,name_he`, { token: adminToken })).json?.[0]?.unit_price) === 10);
    r = await upload(`products/${PID}/user.png`, userToken, PNG, "image/png");
    check("non-admin cannot upload to product-images", storageDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { token: userToken, body: { prefix: "", limit: 10 } });
    check("non-admin cannot LIST the image bucket", isDenied(r) || (r.status === 200 && Array.isArray(r.json) && r.json.length === 0), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const userCat = await rpc("get_storefront_catalog", userToken);
    check("non-admin gets exactly the public catalog (nothing extra)", userCat.status === 200 && JSON.stringify(userCat.json) === JSON.stringify(anonCat.json));
  }

  // ------------------------------------------------------------ 3. DB constraints
  section("Admin: database constraints reject bad data");
  const bad = async (name, body, code) => {
    const x = await rest("POST", "products", { token: adminToken, body: { id: PID_BAD, category_id: CAT, name_he: "x", unit_price: 10, ...body } });
    check(name, x.status >= 400 && pgCode(x) === code, `expected ${code}, got HTTP ${x.status} ${x.text.slice(0, 120)}`);
    if (x.status < 300) await rest("DELETE", `products?id=eq.${PID_BAD}`, { token: adminToken });
  };
  await bad("unit sale enabled without a sale price", { unit_sale_enabled: true }, "23514");
  await bad("unit sale price not lower than regular", { unit_sale_enabled: true, unit_sale_price: 10 }, "23514");
  await bad("negative unit price", { unit_price: -1 }, "23514");
  await bad("negative stock", { stock_base_units: -1 }, "23514");
  await bad("package enabled without label", { package_enabled: true, package_unit_count: 10, package_price: 90 }, "23514");
  await bad("package enabled without unit count", { package_enabled: true, package_label: "פקט", package_price: 90 }, "23514");
  await bad("package enabled without price", { package_enabled: true, package_label: "פקט", package_unit_count: 10 }, "23514");
  await bad("package unit count of 1", { package_enabled: true, package_label: "פקט", package_unit_count: 1, package_price: 90 }, "23514");
  await bad("package sale without a package", { package_sale_enabled: true, package_sale_price: 5 }, "23514");
  await bad("package sale not lower than package price", { package_enabled: true, package_label: "פקט", package_unit_count: 10, package_price: 90, package_sale_enabled: true, package_sale_price: 90 }, "23514");
  await bad("non-numeric product id", { id: "abc" }, "23514");
  await bad("image_path that is a URL", { image_path: "https://evil.example/x.png" }, "23514");
  await bad("duplicate barcode", { barcode: BARCODE }, "23505");
  // a REAL subcategory that belongs to ANOTHER category must be refused (composite FK)
  r = await rest("POST", "categories", { token: adminToken, body: { id: OTHER_CAT, slug: "zz-security-probe-2", name_he: "אחר", is_visible: false } });
  created.otherCat = r.status === 201;
  r = await rest("POST", "subcategories", { token: adminToken, body: { id: OTHER_SUB, category_id: OTHER_CAT, slug: "zz-security-probe-2", name_he: "אחר", is_visible: false } });
  created.otherSub = r.status === 201;
  check("(fixture) second probe category + subcategory created", created.otherCat && created.otherSub, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  if (created.otherSub) await bad("product pointing at a subcategory of a different category", { subcategory_id: OTHER_SUB }, "23503");
  r = await rest("DELETE", `categories?id=eq.${CAT}`, { token: adminToken });
  check("cannot delete a category that still has products", r.status >= 400 && ["23001", "23503"].includes(pgCode(r)), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  // NOTE: random uuid (never a real user id) — if grants were ever wrong, the foreign key
  // would reject this row instead of the test accidentally promoting a real account.
  r = await rest("POST", "admin_users", { token: adminToken, body: { user_id: randomUUID() } });
  check("even the admin cannot write admin_users through the API", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

  // ------------------------------------- 3b. admin Categories support (migration 0005)
  const probe0005 = await rpc("admin_product_counts", adminToken);
  if (probe0005.status === 404 || pgCode(probe0005) === "PGRST202") {
    skipped.push("admin Categories support (apply supabase/migrations/0005_admin_categories.sql, then re-run)");
    section("Admin Categories support (0005)  --  SKIPPED: migration 0005 is not applied yet");
  } else {
    section("Admin Categories support (migration 0005)");
    const denied404 = (x) => isDenied(x) || x.status === 404; // anon may get 401/403 (or 404 if the function is not visible to it)
    for (const [name, args] of [
      ["admin_reorder_categories", { p_ids: [CAT] }],
      ["admin_reorder_subcategories", { p_category_id: CAT, p_ids: [SUB] }],
      ["admin_product_counts", {}],
    ]) {
      r = await rpc(name, ANON, args);
      check(`anon cannot call ${name}()`, denied404(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // admin: product counts (incl. hidden) — grouped, one query
    check("admin_product_counts() returns grouped counts", probe0005.status === 200 && Array.isArray(probe0005.json) && probe0005.json.length > 0, `HTTP ${probe0005.status}`);
    const total = (probe0005.json ?? []).reduce((n, row) => n + Number(row.product_count), 0);
    check("counts cover every product, hidden ones included (>= 141 seeded + the hidden probe)", total >= 142, `total ${total}`);

    // admin: slug lock (names stay editable, the slug does not)
    r = await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { slug: "zz-security-probe-renamed" } });
    check("the slug of a category cannot be changed after creation", r.status >= 400 && /slug cannot be changed/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    r = await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { slug: "zz-renamed" } });
    check("the slug of a subcategory cannot be changed after creation", r.status >= 400 && /slug cannot be changed/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    r = await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { name_he: "שם חדש לבדיקה", name_en: "Probe" } });
    check("names of a category can still be edited", r.status === 200 && r.json?.[0]?.name_he === "שם חדש לבדיקה", `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // admin: reorder — proven on the hidden PROBE subcategories only (real ordering is never touched)
    r = await rest("POST", "subcategories", { token: adminToken, body: { id: SUB2, category_id: CAT, slug: "zz-security-probe-b", name_he: "תת בדיקה ב", is_visible: false, sort_order: 20 } });
    check("(fixture) second probe subcategory created", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { sort_order: 10 } });
    const order = async () => (await rest("GET", `subcategories?category_id=eq.${CAT}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json?.map((row) => row.id);
    check("probe order before: [SUB, SUB2]", JSON.stringify(await order()) === JSON.stringify([SUB, SUB2]));

    r = await rpc("admin_reorder_subcategories", adminToken, { p_category_id: CAT, p_ids: [SUB2, SUB] });
    check("admin can reorder subcategories atomically", r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    check("...the new order is stored (10, 20, ...)", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));
    const rows = (await rest("GET", `subcategories?category_id=eq.${CAT}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json ?? [];
    check("...as sort_order 10 and 20", rows.map((row) => row.sort_order).join() === "10,20");

    for (const [name, args] of [
      ["missing one", { p_category_id: CAT, p_ids: [SUB2] }],
      ["duplicate", { p_category_id: CAT, p_ids: [SUB2, SUB, SUB] }],
      ["another category's subcategory", { p_category_id: CAT, p_ids: [SUB2, OTHER_SUB] }],
      ["empty list", { p_category_id: CAT, p_ids: [] }],
    ]) {
      r = await rpc("admin_reorder_subcategories", adminToken, args);
      check(`a bad subcategory list is rejected: ${name}`, r.status >= 400, `HTTP ${r.status}`);
    }
    check("...and the order is unchanged after all rejected lists", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));

    r = await rpc("admin_reorder_categories", adminToken, { p_ids: [CAT] }); // not ALL categories
    check("a category list that is not exactly the existing categories is rejected", r.status >= 400 && /exactly the existing/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // non-admin: sees nothing, changes nothing
    if (userToken) {
      r = await rpc("admin_product_counts", userToken);
      check("a non-admin gets no product counts (RLS)", r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("admin_reorder_subcategories", userToken, { p_category_id: CAT, p_ids: [SUB, SUB2] });
      check("a non-admin's reorder is rejected", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      check("...and changed nothing", JSON.stringify(await order()) === JSON.stringify([SUB2, SUB]));
      r = await rpc("admin_reorder_categories", userToken, { p_ids: [CAT] });
      check("a non-admin's category reorder is rejected", r.status >= 400, `HTTP ${r.status}`);
    }
  }

  // ------------------------------------------- 3c. admin Products support (migration 0006)
  const probe0006 = await rpc("admin_reorder_products", adminToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID] });
  if (probe0006.status === 404 || pgCode(probe0006) === "PGRST202") {
    skipped.push("admin Products support (apply supabase/migrations/0006_admin_products.sql, then re-run)");
    section("Admin Products support (0006)  --  SKIPPED: migration 0006 is not applied yet");
  } else {
    section("Admin Products support (migration 0006)");
    check("admin can reorder a single-product group (fixture call above succeeded)", probe0006.status < 300, `HTTP ${probe0006.status} ${probe0006.text.slice(0, 100)}`);

    r = await rpc("admin_reorder_products", ANON, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID] });
    check("anon cannot call admin_reorder_products()", isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // a second probe product in the SAME (category, subcategory) group, to reorder against
    r = await rest("POST", "products", { token: adminToken, body: { id: PID2, category_id: CAT, subcategory_id: SUB, name_he: "מוצר בדיקת אבטחה 2", unit_price: 5, is_visible: false, sort_order: 20 } });
    created.product2 = r.status === 201; check("(fixture) second probe product created", r.status === 201, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    const productOrder = async () =>
      (await rest("GET", `products?category_id=eq.${CAT}&subcategory_id=eq.${SUB}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json?.map((row) => row.id);
    check("probe order before: [PID, PID2]", JSON.stringify(await productOrder()) === JSON.stringify([PID, PID2]));

    r = await rpc("admin_reorder_products", adminToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2, PID] });
    check("admin can reorder products atomically", r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    check("...the new order is stored (10, 20)", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));
    const prows = (await rest("GET", `products?category_id=eq.${CAT}&subcategory_id=eq.${SUB}&select=id,sort_order&order=sort_order.asc`, { token: adminToken })).json ?? [];
    check("...as sort_order 10 and 20", prows.map((row) => row.sort_order).join() === "10,20");

    for (const [name, args] of [
      ["missing one", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2] }],
      ["duplicate", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID2, PID, PID] }],
      ["empty list", { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [] }],
      // a product that is not in THIS (category, subcategory) group at all — proves cross-group isolation
      ["a product outside this group", { p_category_id: CAT, p_subcategory_id: OTHER_SUB, p_ids: [PID2, PID] }],
    ]) {
      r = await rpc("admin_reorder_products", adminToken, args);
      check(`a bad product list is rejected: ${name}`, r.status >= 400, `HTTP ${r.status}`);
    }
    check("...and the order is unchanged after all rejected lists", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));

    if (userToken) {
      r = await rpc("admin_reorder_products", userToken, { p_category_id: CAT, p_subcategory_id: SUB, p_ids: [PID, PID2] });
      check("a non-admin's product reorder is rejected", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      check("...and changed nothing", JSON.stringify(await productOrder()) === JSON.stringify([PID2, PID]));
    }
  }

  // -------------------------------------------------- 4. RPC shape when made public
  section("Public catalog output (probe made visible, then hidden again)");
  for (const [t, id] of [["categories", CAT], ["subcategories", SUB], ["products", PID]]) await rest("PATCH", `${t}?id=eq.${id}`, { token: adminToken, body: { is_visible: true } });
  const live = await rpc("get_storefront_catalog", ANON);
  const p = live.json?.products?.find((x) => x.id === PID);
  check("visible probe appears in the public catalog", !!p);
  check("unit: price 10, sale 8 shown, in_stock true (shared pool has 7, package needs 6)", p?.unit?.price === 10 && p?.unit?.sale_price === 8 && p?.unit?.in_stock === true, JSON.stringify(p?.unit));
  check("package: label מארז, count 6, price 55, sale 50, in_stock true (7 >= 6)", p?.package?.label === "מארז" && p?.package?.unit_count === 6 && p?.package?.price === 55 && p?.package?.sale_price === 50 && p?.package?.in_stock === true, JSON.stringify(p?.package));
  check("public payload still leaks no private fields", !PRIVATE_KEYS.test(live.text) && !live.text.includes(BARCODE));

  // shared inventory: draining the ONE pool below the package's unit count affects BOTH options together
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { unit_sale_enabled: false, package_sale_enabled: false, stock_base_units: 3 } });
  const low = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("sales disabled => sale_price hidden; 3 base units < package of 6 => unit still in stock, package NOT (shared pool, not independent counters)",
    low?.unit?.sale_price === null && low?.package?.sale_price === null && low?.unit?.in_stock === true && low?.package?.in_stock === false, JSON.stringify(low));

  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { stock_base_units: 0 } });
  const off = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("0 base units => BOTH unit and package out of stock (the same shared count drives both)",
    off?.unit?.in_stock === false && off?.package?.in_stock === false, JSON.stringify(off));

  // manual "sell this option right now" switches stay independent of the stock count
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { stock_base_units: 7, unit_available: false } });
  const manualOff = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("manually disabling the UNIT (with plenty of stock) hides only the unit, package unaffected",
    manualOff?.unit?.in_stock === false && manualOff?.package?.in_stock === true, JSON.stringify(manualOff));
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { unit_available: true, package_available: false } });
  const manualOff2 = (await rpc("get_storefront_catalog", ANON)).json?.products?.find((x) => x.id === PID);
  check("manually disabling the PACKAGE (with plenty of stock) hides only the package, unit unaffected",
    manualOff2?.unit?.in_stock === true && manualOff2?.package?.in_stock === false, JSON.stringify(manualOff2));
  await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { package_available: true } });

  for (const [t, id] of [["products", PID], ["subcategories", SUB], ["categories", CAT]]) await rest("PATCH", `${t}?id=eq.${id}`, { token: adminToken, body: { is_visible: false } });
  check("hidden again => gone from public catalog", !(await rpc("get_storefront_catalog", ANON)).text.includes(PID));

  // --------------------------------------------------------------------- 5. storage
  section("Image bucket");
  r = await upload(IMG, adminToken, PNG, "image/png");
  created.image = r.status === 200; check("admin can upload a PNG", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  if (created.image) {
    r = await call("GET", `${URL_}/storage/v1/object/public/product-images/${IMG}`, { headers: {} });
    check("image is publicly fetchable by URL (no login)", r.status === 200);
    r = await call("POST", `${URL_}/storage/v1/object/list/product-images`, { token: adminToken, body: { prefix: `products/${PID}`, limit: 10 } });
    check("admin can list the bucket", r.status === 200 && Array.isArray(r.json) && r.json.some((o) => o.name === "probe.png"), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
  }
  r = await upload(`products/${PID}/notes.txt`, adminToken, Buffer.from("hello"), "text/plain");
  check("bucket rejects non-image file types", r.status >= 400, `HTTP ${r.status}`);
  r = await upload(`products/${PID}/big.png`, adminToken, Buffer.alloc(2 * 1024 * 1024 + 1024, 1), "image/png");
  check("bucket rejects files over 2 MB", r.status >= 400, `HTTP ${r.status}`);

  // ------------------------------------------------- 5b. cart stock availability check (migration 0007)
  const probe0007 = await rpc("check_stock_availability", ANON, { p_items: [] });
  if (probe0007.status === 404 || pgCode(probe0007) === "PGRST202") {
    skipped.push("cart stock availability check (apply supabase/migrations/0007_stock_availability.sql, then re-run)");
    section("Cart stock availability check (0007)  --  SKIPPED: migration 0007 is not applied yet");
  } else {
    section("Cart stock availability check (migration 0007)");
    check("empty request => empty result", probe0007.status === 200 && JSON.stringify(probe0007.json) === "[]", `HTTP ${probe0007.status} ${probe0007.text.slice(0, 100)}`);

    // section 4 left the probe product AND its category AND its subcategory all hidden. Visibility is a chain
    // (product AND category AND subcategory must all be visible — see get_storefront_catalog()'s own rule),
    // so each level is exercised on its own rather than flipping all three at once.
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("product + category + subcategory all hidden => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: true } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: true } });
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("category + subcategory now visible, but the PRODUCT itself still hidden => still NOT available (existence never revealed)", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { is_visible: true } }); // now everything in the chain is visible
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 7 }] });
    check("everything visible, shared stock is 7: requesting exactly 7 => available", r.json?.[0]?.available === true, JSON.stringify(r.json));
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 8 }] });
    check("requesting 8 (one over) => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));

    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: false } });
    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("product itself visible, but its CATEGORY hidden => NOT available", r.json?.[0]?.available === false, JSON.stringify(r.json));
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: true } }); // restore for the checks below

    r = await rpc("check_stock_availability", ANON, { p_items: [{ product_id: PID, base_units: 3 }, { product_id: "does-not-exist", base_units: 1 }] });
    check("batched: independent results per product, unknown id => NOT available",
      r.json?.[0]?.product_id === PID && r.json?.[0]?.available === true && r.json?.[1]?.available === false, JSON.stringify(r.json));

    check("response never leaks the raw stock count or track_stock", !PRIVATE_KEYS.test(r.text));
    check("response has only product_id/available keys per item", Object.keys(r.json?.[0] ?? {}).sort().join(",") === "available,product_id");

    r = await rpc("check_stock_availability", userToken || ANON, { p_items: [{ product_id: PID, base_units: 1 }] });
    check("a logged-in non-admin gets the same public answer as anon (nothing extra)", r.status === 200 && typeof r.json?.[0]?.available === "boolean");

    // restore exactly as section 4 left it: product, subcategory and category all hidden
    await rest("PATCH", `products?id=eq.${PID}`, { token: adminToken, body: { is_visible: false } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: false } });
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: false } });
  }

  // ------------------------------------------------- 5c. business settings (migration 0008)
  const probe0008 = await rpc("get_business_settings", ANON);
  if (probe0008.status === 404 || pgCode(probe0008) === "PGRST202") {
    skipped.push("business settings (apply supabase/migrations/0008_business_settings.sql, then re-run)");
    section("Business Settings (0008)  --  SKIPPED: migration 0008 is not applied yet");
  } else {
    section("Business Settings (migration 0008)");
    check("anon CAN call get_business_settings()", probe0008.status === 200 && Array.isArray(probe0008.json?.store_hours) && Array.isArray(probe0008.json?.order_hours), `HTTP ${probe0008.status}`);
    check("store_hours and order_hours each have all 7 days", probe0008.json?.store_hours?.length === 7 && probe0008.json?.order_hours?.length === 7);
    check("min_order_cents/delivery_fee_cents are numbers, orders_paused is boolean",
      typeof probe0008.json?.min_order_cents === "number" && typeof probe0008.json?.delivery_fee_cents === "number" && typeof probe0008.json?.orders_paused === "boolean");
    check("no extra/private fields leak (e.g. updated_at)", !/"updated_at"\s*:/.test(probe0008.text));

    for (const t of ["business_hours", "business_settings"]) {
      r = await rest("GET", `${t}?select=*&limit=1`);
      check(`anon cannot SELECT ${t} directly`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    r = await rest("PATCH", "business_settings?id=eq.1", { body: { orders_paused: true } });
    check("anon cannot UPDATE business_settings", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { body: { is_open: false } });
    check("anon cannot UPDATE business_hours", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    if (userToken) {
      r = await rest("GET", "business_settings?select=*", { token: userToken });
      check("non-admin sees 0 rows of business_settings", deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("PATCH", "business_settings?id=eq.1", { token: userToken, body: { orders_paused: true } });
      check("non-admin cannot UPDATE business_settings", deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // admin: this table is REAL singleton config, not a throwaway probe row — save the original values and
    // restore them exactly afterward (a local try/finally, same spirit as section 5's visibility restores).
    const origSettings = (await rest("GET", "business_settings?select=min_order_cents,delivery_fee_cents,orders_paused", { token: adminToken })).json?.[0];
    const origStoreSunday = (await rest("GET", "business_hours?schedule_type=eq.store&day_of_week=eq.0&select=is_open,open_time,close_time", { token: adminToken })).json?.[0];
    check("(fixture) admin can read the real business_settings/business_hours rows", !!origSettings && !!origStoreSunday, JSON.stringify({ origSettings, origStoreSunday }));
    try {
      r = await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: { orders_paused: true, min_order_cents: 6000 } });
      check("admin can UPDATE business_settings", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      const afterPause = await rpc("get_business_settings", ANON);
      check("the manual pause + min order are reflected in the public RPC immediately", afterPause.json?.orders_paused === true && afterPause.json?.min_order_cents === 6000, JSON.stringify(afterPause.json));

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: false, open_time: null, close_time: null } });
      check("admin can UPDATE business_hours (close a day)", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      const afterClosed = await rpc("get_business_settings", ANON);
      check("the closed day is reflected in the public RPC", afterClosed.json?.store_hours?.find((d) => d.day_of_week === 0)?.is_open === false, JSON.stringify(afterClosed.json?.store_hours));

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: true, open_time: "09:00", close_time: "10:00" } });
      check("admin can re-open a day with valid hours", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

      r = await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: { is_open: true, open_time: null, close_time: null } });
      check("marking a day open with no times is rejected (check constraint)", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: { min_order_cents: -1 } });
      check("negative min_order_cents is rejected (check constraint)", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rest("POST", "business_settings", { token: adminToken, body: { id: 2 } });
      check("a second business_settings row is rejected — singleton", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

      if (userToken) {
        r = await rpc("get_business_settings", userToken);
        check("a logged-in non-admin gets the same public answer as anon (nothing extra)", r.status === 200 && typeof r.json?.orders_paused === "boolean");
      }
    } finally {
      // restore exactly as it was before this section touched the real config
      if (origSettings) await rest("PATCH", "business_settings?id=eq.1", { token: adminToken, body: origSettings });
      if (origStoreSunday) await rest("PATCH", "business_hours?schedule_type=eq.store&day_of_week=eq.0", { token: adminToken, body: origStoreSunday });
      const restored = await rpc("get_business_settings", ANON);
      check("business settings restored to their original values after the probe",
        restored.json?.min_order_cents === origSettings?.min_order_cents && restored.json?.orders_paused === origSettings?.orders_paused, JSON.stringify(restored.json));
    }
  }

  // ------------------------------------------------------------- 5d. orders (migration 0009)
  const probe0009 = await rpc("create_order", ANON, { p_payload: {}, p_idempotency_key: randomUUID() });
  if (probe0009.status === 404 || pgCode(probe0009) === "PGRST202") {
    skipped.push("orders (apply supabase/migrations/0009_orders.sql, then re-run)");
    section("Orders (0009)  --  SKIPPED: migration 0009 is not applied yet");
  } else {
    section("Orders — access control for orders/order_items/payment_attempts/payment_events (migration 0009)");
    check("(fixture) create_order() exists and rejects an empty payload (no row created)", probe0009.status >= 400, `HTTP ${probe0009.status} ${probe0009.text.slice(0, 120)}`);

    // a dedicated, hidden probe product — priced comfortably above the REAL min_order_cents (restored by
    // section 5c's finally above) so these probe orders are never accidentally refused as too small.
    const bs = await rpc("get_business_settings", ANON);
    const probePrice = Math.max(999, (bs.json?.min_order_cents ?? 0) / 100 + 50);
    r = await rest("POST", "products", { token: adminToken, body: {
      id: PID_ORDER, category_id: CAT, subcategory_id: SUB, name_he: "מוצר בדיקת הזמנות", brand: "ZZ",
      unit_price: probePrice, track_stock: true, stock_base_units: 5, is_visible: false } });
    created.productOrder = r.status === 201;
    check("(fixture) probe order-product created (hidden, track_stock, 5 units)", created.productOrder, `HTTP ${r.status} ${r.text.slice(0, 120)}`);

    const baseCustomer = {
      first_name: "בדיקה", last_name: "אבטחה", phone: "0501234567", email: null,
      city: "נתיבות", street: "הרצל", house_number: "1",
      entrance: null, floor: null, apartment: null, intercom_code: null, notes: null,
      age_confirmed: true, terms_accepted: true,
    };
    const orderPayload = (overrides = {}, customerOverrides = {}) => ({
      items: [{ product_id: PID_ORDER, option: "unit", quantity: 1 }],
      payment_method: "cash",
      ...overrides,
      customer: { ...baseCustomer, ...customerOverrides },
    });
    const createOrder = (token, payload, key) => rpc("create_order", token, { p_payload: payload, p_idempotency_key: key });
    const noRowFor = async (key) => (await rest("GET", `orders?idempotency_key=eq.${key}&select=id`, { token: adminToken })).json?.length === 0;

    // a fully hidden product (chain not visible) can't be ordered at all — same rule as the catalog/stock check
    let key = randomUUID();
    r = await createOrder(ANON, orderPayload(), key);
    check("create_order() refuses a hidden product", r.status >= 400 && /^PRODUCT_UNAVAILABLE/.test(r.json?.message ?? ""), `HTTP ${r.status} ${r.text.slice(0, 150)}`);
    check("...and created no order row", await noRowFor(key));

    // make the probe visible for the rest of this section (restored to hidden at the end)
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: true } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: true } });
    await rest("PATCH", `products?id=eq.${PID_ORDER}`, { token: adminToken, body: { is_visible: true } });

    // server-side validation guards — every one of these must be enforced regardless of what the frontend
    // already checks, since this RPC is the only thing standing between a crafted request and a real order.
    const badOrder = async (name, payload, codePattern) => {
      const k = randomUUID();
      const x = await createOrder(ANON, payload, k);
      check(`create_order() rejects: ${name}`, x.status >= 400 && codePattern.test(x.json?.message ?? ""), `HTTP ${x.status} ${x.text.slice(0, 150)}`);
      check(`...and created no order row (${name})`, await noRowFor(k));
    };
    r = await createOrder(ANON, orderPayload(), null);
    check("create_order() rejects a null idempotency key", r.status >= 400 && /^MISSING_IDEMPOTENCY_KEY/.test(r.json?.message ?? ""), `HTTP ${r.status} ${r.text.slice(0, 150)}`);
    await badOrder("empty items array", orderPayload({ items: [] }), /^EMPTY_ORDER/);
    await badOrder("invalid payment method", orderPayload({ payment_method: "bitcoin" }), /^INVALID_PAYMENT_METHOD/);
    await badOrder("missing first/last name", orderPayload({}, { first_name: "" }), /^MISSING_NAME/);
    await badOrder("missing phone", orderPayload({}, { phone: "" }), /^MISSING_PHONE/);
    await badOrder("delivery outside Netivot", orderPayload({}, { city: "תל אביב" }), /^UNSUPPORTED_CITY/);
    await badOrder("missing street/house number", orderPayload({}, { street: "" }), /^MISSING_ADDRESS/);
    await badOrder("age not confirmed", orderPayload({}, { age_confirmed: false }), /^AGE_NOT_CONFIRMED/);
    await badOrder("terms not accepted", orderPayload({}, { terms_accepted: false }), /^TERMS_NOT_ACCEPTED/);
    await badOrder("unknown product id", orderPayload({ items: [{ product_id: "zz-does-not-exist", option: "unit", quantity: 1 }] }), /^PRODUCT_UNAVAILABLE/);

    // ---- a real cash order: anon CAN call create_order(), and it does exactly what it should ----
    const cashKey = randomUUID();
    const cash = await createOrder(ANON, orderPayload(), cashKey);
    check("anon CAN call create_order() and place a real (cash) order", cash.status === 200 && typeof cash.json?.order_id === "string", `HTTP ${cash.status} ${cash.text.slice(0, 150)}`);
    check("cash order comes back confirmed, payment pending, no payment_attempt_id",
      cash.json?.order_status === "confirmed" && cash.json?.payment_status === "pending" && cash.json?.payment_method === "cash" && cash.json?.payment_attempt_id === null,
      JSON.stringify(cash.json));
    check("cash order total = probe price + real delivery fee", cash.json?.total_cents === Math.round(probePrice * 100) + (bs.json?.delivery_fee_cents ?? 0), JSON.stringify({ cash: cash.json, deliveryFee: bs.json?.delivery_fee_cents }));
    if (cash.json?.order_id) orderIds.push(cash.json.order_id);
    const stockAfterCash = await rest("GET", `products?id=eq.${PID_ORDER}&select=stock_base_units,stock_reserved_units`, { token: adminToken });
    check("stock was permanently deducted for the cash order (5 -> 4)", stockAfterCash.json?.[0]?.stock_base_units === 4 && stockAfterCash.json?.[0]?.stock_reserved_units === 0, JSON.stringify(stockAfterCash.json));

    // idempotency: the SAME key returns the SAME order, never a second one
    const cashRetry = await createOrder(ANON, orderPayload(), cashKey);
    check("a repeat call with the same idempotency key returns the SAME order (double-click / refresh safe)",
      cashRetry.status === 200 && cashRetry.json?.order_id === cash.json?.order_id, JSON.stringify(cashRetry.json));
    const dupeCount = await rest("GET", `orders?idempotency_key=eq.${cashKey}&select=id`, { token: adminToken });
    check("...and only ONE order row exists for that key", dupeCount.json?.length === 1, JSON.stringify(dupeCount.json));

    // a non-admin authenticated user can ALSO call create_order() — this is a guest/customer RPC, not admin-only
    if (userToken) {
      const uKey = randomUUID();
      r = await createOrder(userToken, orderPayload({ items: [] }), uKey); // a rejection still proves it's reachable, without spending more probe stock
      check("a logged-in non-admin can also reach create_order() (business rejection, not a permission denial)", r.status >= 400 && /^EMPTY_ORDER/.test(r.json?.message ?? ""), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    }

    // ---- a real card order: to exercise payment_attempts/payment_events RLS below ----
    const cardKey = randomUUID();
    const card = await createOrder(ANON, orderPayload({ payment_method: "card" }), cardKey);
    check("anon CAN place a card order — reserved, not deducted, with a payment_attempt_id", card.status === 200 && typeof card.json?.payment_attempt_id === "string", `HTTP ${card.status} ${card.text.slice(0, 150)}`);
    check("card order is pending/pending", card.json?.order_status === "pending" && card.json?.payment_status === "pending", JSON.stringify(card.json));
    if (card.json?.order_id) orderIds.push(card.json.order_id);
    const stockAfterCard = await rest("GET", `products?id=eq.${PID_ORDER}&select=stock_base_units,stock_reserved_units`, { token: adminToken });
    check("stock was RESERVED for the card order, base units untouched (4/0 -> 4/1)", stockAfterCard.json?.[0]?.stock_base_units === 4 && stockAfterCard.json?.[0]?.stock_reserved_units === 1, JSON.stringify(stockAfterCard.json));

    // ---- table access: orders / order_items / payment_attempts / payment_events ----
    for (const t of ["orders", "order_items", "payment_attempts", "payment_events"]) {
      r = await rest("GET", `${t}?select=*&limit=1`);
      check(`anon cannot SELECT ${t}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    for (const [n, method, path, body] of [
      ["INSERT orders", "POST", "orders", { payment_method: "cash", idempotency_key: randomUUID(), first_name: "x", last_name: "x", phone: "x", city: "נתיבות", street: "x", house_number: "1", age_confirmed_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), subtotal_cents: 0, delivery_fee_cents: 0, total_cents: 0 }],
      ["UPDATE orders", "PATCH", `orders?id=eq.${cash.json?.order_id}`, { order_status: "cancelled" }],
      ["DELETE orders", "DELETE", `orders?id=eq.${cash.json?.order_id}`, undefined],
      ["INSERT order_items", "POST", "order_items", { order_id: cash.json?.order_id, product_name_snapshot: "x", option: "unit", option_label_snapshot: "x", unit_price_cents: 1, regular_price_cents: 1, quantity: 1, base_units: 1, line_total_cents: 1 }],
      ["INSERT payment_attempts", "POST", "payment_attempts", { order_id: card.json?.order_id, amount_cents: 1 }],
    ]) { r = await rest(method, path, { body }); check(`anon cannot ${n}`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    check("probe cash order unchanged after anon attempts", (await rest("GET", `orders?id=eq.${cash.json?.order_id}&select=order_status`, { token: adminToken })).json?.[0]?.order_status === "confirmed");

    if (userToken) {
      for (const t of ["orders", "order_items", "payment_attempts", "payment_events"]) {
        r = await rest("GET", `${t}?select=*`, { token: userToken });
        check(`non-admin sees 0 rows of ${t} (customer_id is null on every order — the self-select policy matches nobody yet)`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      }
      for (const [n, method, path, body] of [
        ["UPDATE orders", "PATCH", `orders?id=eq.${cash.json?.order_id}`, { order_status: "cancelled" }],
        ["DELETE orders", "DELETE", `orders?id=eq.${cash.json?.order_id}`, undefined],
      ]) { r = await rest(method, path, { token: userToken, body }); check(`non-admin ${n} changes nothing`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
    }

    r = await rest("GET", `orders?id=eq.${cash.json?.order_id}&select=id,first_name,phone,total_cents`, { token: adminToken });
    check("admin CAN read the full order, including the customer snapshot", r.json?.[0]?.first_name === "בדיקה" && r.json?.[0]?.phone === "0501234567", JSON.stringify(r.json));
    r = await rest("GET", `order_items?order_id=eq.${cash.json?.order_id}&select=*`, { token: adminToken });
    check("admin CAN read the order's line items", r.json?.length === 1 && r.json?.[0]?.product_id === PID_ORDER, JSON.stringify(r.json));
    r = await rest("GET", `payment_attempts?order_id=eq.${card.json?.order_id}&select=*`, { token: adminToken });
    check("admin CAN read the card order's payment attempt", r.json?.length === 1 && r.json?.[0]?.status === "created", JSON.stringify(r.json));

    // ---- get_order_status(): narrow, PII-free, anon-callable ----
    r = await rpc("get_order_status", ANON, { p_order_id: cash.json?.order_id });
    check("anon CAN call get_order_status()", r.status === 200 && r.json?.order_number === cash.json?.order_number, JSON.stringify(r.json));
    check("...status only: no PII, no address, no idempotency_key leaks out", !ORDER_PII_KEYS.test(r.text), r.text);
    // fulfillment_method since migration 0015 (the order-tracking page); without 0015 the old five fields
    const narrow = Object.keys(r.json ?? {}).sort().join(",");
    check("...response has exactly the narrow field set",
      narrow === "delivery_departure_time,fulfillment_method,order_number,order_status,payment_method,payment_status,total_cents"
      || narrow === "fulfillment_method,order_number,order_status,payment_method,payment_status,total_cents"
      || narrow === "order_number,order_status,payment_method,payment_status,total_cents", narrow);
    r = await rpc("get_order_status", ANON, { p_order_id: randomUUID() });
    check("get_order_status() for a nonexistent order returns null, not an error or a hint either way", r.status === 200 && r.json === null, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

    // ---- release_expired_order(): internal only — unreachable by ANYONE over the API, admin included ----
    for (const [who, token] of [["anon", ANON], ["non-admin", userToken], ["admin", adminToken]]) {
      if (!token) continue;
      r = await rpc("release_expired_order", token, { p_order_id: card.json?.order_id });
      check(`${who} cannot call release_expired_order() (no grant to anyone — internal use only)`, isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }

    // ---- expire_stale_orders(): reachable by authenticated, but gated on is_admin() inside the function ----
    r = await rpc("expire_stale_orders", ANON);
    check("anon cannot call expire_stale_orders()", isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    if (userToken) {
      r = await rpc("expire_stale_orders", userToken);
      check("non-admin's expire_stale_orders() is refused (not authorized, from inside the function)", r.status >= 400 && /not authorized/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    r = await rpc("expire_stale_orders", adminToken);
    check("admin CAN call expire_stale_orders()", r.status === 200 && typeof r.json === "number", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    check("...and it did NOT touch our still-fresh card order (reserved_until is 30 min out)", (await rest("GET", `orders?id=eq.${card.json?.order_id}&select=order_status`, { token: adminToken })).json?.[0]?.order_status === "pending");

    // ---- confirm_payment(): the one function granted ONLY to service_role — proven unreachable by anon,
    // a non-admin, AND the admin's own token (is_admin() is a completely different thing from service_role) ----
    const confirmArgs = { p_payment_attempt_id: card.json?.payment_attempt_id, p_provider_event_id: `zz-probe-${randomUUID()}`, p_outcome: "failed" };
    for (const [who, token] of [["anon", ANON], ["non-admin", userToken], ["admin (is_admin() = true, but NOT service_role)", adminToken]]) {
      if (!token) continue;
      r = await rpc("confirm_payment", token, confirmArgs);
      check(`${who} cannot call confirm_payment()`, isDenied(r) || r.status === 404, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    }
    check("...and the card order's payment_attempt is untouched (still 'created')", (await rest("GET", `payment_attempts?order_id=eq.${card.json?.order_id}&select=status`, { token: adminToken })).json?.[0]?.status === "created");

    // ================================================================= 5e. order management (migration 0010)
    const probe0010 = await rpc("get_my_role", adminToken);
    if (probe0010.status === 404 || pgCode(probe0010) === "PGRST202") {
      skipped.push("order management (apply supabase/migrations/0010_order_management.sql, then re-run)");
      section("Order management (0010)  --  SKIPPED: migration 0010 is not applied yet");
    } else {
      section("Order management — roles, audited transitions, history (migration 0010)");
      const stockOf = async () => (await rest("GET", `products?id=eq.${PID_ORDER}&select=stock_base_units`, { token: adminToken })).json?.[0]?.stock_base_units;
      const orderOf = async (id) => (await rest("GET", `orders?id=eq.${id}&select=order_status,payment_status,stock_return_status,cancel_reason`, { token: adminToken })).json?.[0];
      const transition = (token, id, expected, to, reason) => rpc("transition_order", token, { p_order_id: id, p_expected_status: expected, p_to_status: to, p_reason: reason ?? null });
      const oid = cash.json?.order_id;

      check("get_my_role() is 'owner' for the admin", probe0010.status === 200 && probe0010.json === "owner", `HTTP ${probe0010.status} ${probe0010.text.slice(0, 80)}`);
      r = await rpc("get_my_role", ANON);
      check("anon cannot call get_my_role()", isDenied(r), `HTTP ${r.status}`);
      if (userToken) {
        r = await rpc("get_my_role", userToken);
        check("a non-admin user gets no role (null)", r.status === 200 && r.json === null, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
      }
      r = await rpc("is_admin", adminToken);
      check("is_admin() is still true for the owner", r.status === 200 && r.json === true, `HTTP ${r.status} ${r.text.slice(0, 80)}`);

      // -- orders can no longer be written through the table API by ANYONE, admin included
      for (const [n, method, path, body] of [
        ["UPDATE orders (status)", "PATCH", `orders?id=eq.${oid}`, { order_status: "completed" }],
        ["UPDATE orders (cancel_reason)", "PATCH", `orders?id=eq.${oid}`, { cancel_reason: "x" }],
        ["DELETE orders", "DELETE", `orders?id=eq.${oid}`, undefined],
        ["INSERT order_items", "POST", "order_items", { order_id: oid, product_name_snapshot: "x", option: "unit", option_label_snapshot: "x", unit_price_cents: 1, regular_price_cents: 1, quantity: 1, base_units: 1, line_total_cents: 1 }],
        ["DELETE order_items", "DELETE", `order_items?order_id=eq.${oid}`, undefined],
        ["INSERT order_status_events", "POST", "order_status_events", { order_id: oid, kind: "status", to_value: "x", actor_label: "x" }],
        ["DELETE order_status_events", "DELETE", `order_status_events?order_id=eq.${oid}`, undefined],
      ]) { r = await rest(method, path, { token: adminToken, body }); check(`the admin cannot ${n} directly (order changes go through transition_order() only)`, isDenied(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
      check("...and the probe order is untouched", (await orderOf(oid))?.order_status === "confirmed" && (await orderOf(oid))?.cancel_reason === null);

      // -- who may call the transition functions at all
      r = await transition(ANON, oid, "confirmed", "preparing");
      check("anon cannot call transition_order()", isDenied(r), `HTTP ${r.status}`);
      r = await rpc("resolve_stock_return", ANON, { p_order_id: oid, p_outcome: "returned" });
      check("anon cannot call resolve_stock_return()", isDenied(r), `HTTP ${r.status}`);
      if (userToken) {
        r = await transition(userToken, oid, "confirmed", "preparing");
        check("a logged-in non-admin is refused by transition_order() (NOT_AUTHORIZED)", r.status >= 400 && /NOT_AUTHORIZED|permission denied/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        r = await rest("GET", "order_status_events?select=*", { token: userToken });
        check("a non-admin sees no order history rows", deniedOrEmpty(r), `HTTP ${r.status}`);
      }
      r = await rest("GET", "order_status_events?select=*", {});
      check("anon cannot read order_status_events", isDenied(r), `HTTP ${r.status}`);
      check("...and the probe order is still untouched", (await orderOf(oid))?.order_status === "confirmed");

      // -- the transition rules, as the owner
      r = await transition(adminToken, oid, "preparing", "out_for_delivery");
      check("a stale expected status is refused (STALE_STATUS: confirmed)", r.status >= 400 && /STALE_STATUS: confirmed/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await transition(adminToken, oid, "confirmed", "completed");
      check("skipping a step is refused (INVALID_TRANSITION)", r.status >= 400 && /INVALID_TRANSITION/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await transition(adminToken, oid, "confirmed", "preparing");
      check("confirmed -> preparing works", r.status === 200 && r.json?.order_status === "preparing" && r.json?.changed === true, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await transition(adminToken, oid, "confirmed", "preparing");
      check("repeating the same move is an idempotent no-op", r.status === 200 && r.json?.changed === false, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await transition(adminToken, oid, "preparing", "cancelled", "  ");
      check("cancelling without a reason is refused (REASON_REQUIRED)", r.status >= 400 && /REASON_REQUIRED/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      const stockBefore = await stockOf();
      r = await transition(adminToken, oid, "preparing", "cancelled", "zz-security-probe: cancel before dispatch");
      const afterCancel = await orderOf(oid);
      check("cancel before dispatch: restored, cash payment cancelled, reason kept",
        r.status === 200 && afterCancel?.order_status === "cancelled" && afterCancel?.stock_return_status === "restored" && afterCancel?.payment_status === "cancelled" && /before dispatch/.test(afterCancel?.cancel_reason ?? ""), `HTTP ${r.status} ${JSON.stringify(afterCancel)}`);
      check("...and the probe product's stock came back (+1)", (await stockOf()) === stockBefore + 1, `before ${stockBefore}, after ${await stockOf()}`);
      r = await transition(adminToken, oid, "preparing", "cancelled", "again");
      check("a second cancel is a no-op — stock is NOT restored twice", r.status === 200 && r.json?.changed === false && (await stockOf()) === stockBefore + 1);
      r = await transition(adminToken, oid, "cancelled", "confirmed");
      check("a cancelled order cannot be reopened", r.status >= 400 && /INVALID_TRANSITION/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await transition(adminToken, card.json?.order_id, "pending", "preparing");
      check("a card order still awaiting payment cannot be moved by transition_order()", r.status >= 400 && /INVALID_TRANSITION/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
      r = await rpc("resolve_stock_return", adminToken, { p_order_id: oid, p_outcome: "written_off" });
      check("resolve_stock_return() refuses an order that has nothing pending", r.status >= 400 && /STALE_STATUS/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);

      // -- history: written by a trigger, readable by the owner, attributed
      r = await rest("GET", `order_status_events?order_id=eq.${oid}&select=kind,from_value,to_value,actor_label,actor_role,reason&order=id`, { token: adminToken });
      check("the owner reads the order's full timeline (created, status moves, payment, stock return)",
        Array.isArray(r.json) && r.json.some((e) => e.kind === "created" && e.actor_label === "customer") && r.json.some((e) => e.kind === "status" && e.to_value === "preparing" && e.actor_role === "owner")
        && r.json.some((e) => e.kind === "status" && e.to_value === "cancelled" && /before dispatch/.test(e.reason ?? "")) && r.json.some((e) => e.kind === "stock_return" && e.to_value === "restored"), r.text.slice(0, 200));

      // -- staff (optional: needs STAFF_EMAIL / STAFF_PASSWORD, a user inserted into admin_users with role 'staff')
      if (!staffToken) {
        skipped.push("staff role checks (set STAFF_EMAIL / STAFF_PASSWORD: a user in admin_users with role 'staff')");
        section("Staff role  --  SKIPPED (set STAFF_EMAIL / STAFF_PASSWORD)");
      } else {
        section("Staff role — order handling only");
        r = await rpc("get_my_role", staffToken);
        check("get_my_role() is 'staff'", r.status === 200 && r.json === "staff", `HTTP ${r.status} ${r.text.slice(0, 80)}`);
        r = await rpc("is_admin", staffToken);
        check("is_admin() is FALSE for staff (owner-only)", r.status === 200 && r.json === false, `HTTP ${r.status} ${r.text.slice(0, 80)}`);

        for (const t of ["categories", "subcategories", "products", "business_hours", "business_settings", "payment_attempts", "payment_events"]) {
          r = await rest("GET", `${t}?select=*&limit=1`, { token: staffToken });
          check(`staff sees 0 rows of ${t}`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        }
        const pausedBefore = (await rest("GET", "business_settings?select=orders_paused", { token: adminToken })).json?.[0]?.orders_paused;
        for (const [n, method, path, body] of [
          ["UPDATE products", "PATCH", `products?id=eq.${PID_ORDER}`, { unit_price: 1 }],
          ["UPDATE business_settings (orders_paused)", "PATCH", "business_settings?id=eq.1", { orders_paused: true }],
          ["INSERT admin_users (self-promotion)", "POST", "admin_users", { user_id: randomUUID(), role: "owner" }],
          ["UPDATE admin_users (self-promotion)", "PATCH", "admin_users?role=eq.staff", { role: "owner" }],
          ["UPDATE orders directly", "PATCH", `orders?id=eq.${cash.json?.order_id}`, { order_status: "completed" }],
          ["DELETE orders", "DELETE", `orders?id=eq.${cash.json?.order_id}`, undefined],
        ]) { r = await rest(method, path, { token: staffToken, body }); check(`staff cannot ${n}`, deniedOrEmpty(r), `HTTP ${r.status} ${r.text.slice(0, 100)}`); }
        check("...and orders_paused is unchanged", (await rest("GET", "business_settings?select=orders_paused", { token: adminToken })).json?.[0]?.orders_paused === pausedBefore);
        r = await rpc("expire_stale_orders", staffToken);
        check("staff cannot call the owner-only expire_stale_orders()", r.status >= 400, `HTTP ${r.status} ${r.text.slice(0, 100)}`);

        // a fresh probe order for staff to handle end to end
        const sOrder = await createOrder(ANON, orderPayload(), randomUUID());
        const sid = sOrder.json?.order_id;
        if (sid) orderIds.push(sid);
        check("(fixture) a fresh probe order for staff to handle", sOrder.status === 200 && typeof sid === "string", `HTTP ${sOrder.status} ${sOrder.text.slice(0, 100)}`);
        r = await rest("GET", `orders?id=eq.${sid}&select=id,first_name,phone`, { token: staffToken });
        check("staff CAN read an open order (with the delivery details they need)", r.json?.length === 1 && r.json?.[0]?.first_name === "בדיקה", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        r = await rest("GET", `order_items?order_id=eq.${sid}&select=id`, { token: staffToken });
        check("...and its items", r.json?.length === 1, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        for (const [from, to] of [["confirmed", "preparing"], ["preparing", "out_for_delivery"]]) {
          r = await transition(staffToken, sid, from, to);
          check(`staff CAN move ${from} -> ${to}`, r.status === 200 && r.json?.order_status === to, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        }
        r = await transition(staffToken, sid, "out_for_delivery", "completed");
        check("staff CAN complete it — a cash order becomes paid", r.status === 200 && r.json?.payment_status === "paid", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        r = await transition(staffToken, sid, "completed", "out_for_delivery");
        check("staff CANNOT reopen a completed order (owner-only)", r.status >= 400 && /INVALID_TRANSITION/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        r = await transition(adminToken, sid, "completed", "out_for_delivery");
        check("the OWNER can reopen it; a cash order goes back to unpaid", r.status === 200 && (await orderOf(sid))?.payment_status === "pending", `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        const before = await stockOf();
        r = await transition(staffToken, sid, "out_for_delivery", "cancelled", "zz-security-probe: cancel after dispatch");
        check("staff cancel AFTER dispatch: stock is HELD (pending_return), not restored", r.status === 200 && (await orderOf(sid))?.stock_return_status === "pending_return" && (await stockOf()) === before, `HTTP ${r.status} ${JSON.stringify(await orderOf(sid))}`);
        r = await rest("GET", `orders?id=eq.${sid}&select=id`, { token: staffToken });
        check("staff still see it while its stock is unresolved", r.json?.length === 1);
        r = await rpc("resolve_stock_return", staffToken, { p_order_id: sid, p_outcome: "written_off" });
        check("staff cannot WRITE OFF stock (owner-only)", r.status >= 400 && /NOT_AUTHORIZED|permission denied/i.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        check("...nothing changed", (await orderOf(sid))?.stock_return_status === "pending_return" && (await stockOf()) === before);
        r = await rpc("resolve_stock_return", staffToken, { p_order_id: sid, p_outcome: "returned" });
        check("staff CAN confirm the goods are back: stock restored (+1)", r.status === 200 && (await orderOf(sid))?.stock_return_status === "restored" && (await stockOf()) === before + 1, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
        r = await rpc("resolve_stock_return", staffToken, { p_order_id: sid, p_outcome: "returned" });
        check("confirming again is a no-op (no double restock)", r.status === 200 && r.json?.changed === false && (await stockOf()) === before + 1);
        r = await rest("GET", `order_status_events?order_id=eq.${sid}&select=actor_label,actor_role,to_value`, { token: staffToken });
        check("staff can read the timeline, attributed to the staff account", r.json?.some((e) => e.actor_role === "staff") === true, r.text.slice(0, 200));
      }
    }

    await clubMemberChecks({ createOrder, orderPayload });

    // restore the probe category/subcategory to hidden (PID_ORDER itself is deleted entirely in cleanup)
    await rest("PATCH", `categories?id=eq.${CAT}`, { token: adminToken, body: { is_visible: false } });
    await rest("PATCH", `subcategories?id=eq.${SUB}`, { token: adminToken, body: { is_visible: false } });
  }

  // ------------------------------------------------------------------- 5f. club (migrations 0011-0013)
  await clubPlainUserChecks();

  // ------------------------------------------------------------------- 5g. coupons (migration 0014)
  await couponChecks();
  await costChecks();
  await deliveryChecks();
  await courierPayChecks();

  // ------------------------------------------------------------------- 6. sign-ups
  if (SIGNUPS_ENABLED) {
    await signupsEnabledChecks();
  } else if (CHECK_SIGNUP) {
    section("Public sign-up must be refused");
    r = await call("POST", `${URL_}/auth/v1/signup`, { body: { email: `zz-security-probe-${Date.now()}@example.invalid`, password: randomUUID() + "Aa1!" } });
    check("self-registration is refused", r.status >= 400, `HTTP ${r.status} — if this was 200 a junk user was created: delete it and DISABLE sign-ups (Authentication -> Sign In / Providers)`);
  } else {
    skipped.push("sign-up check (run with --check-signup while sign-ups are OFF, or with --signups-enabled once they are ON)");
  }
}

try { await main(); }
catch (e) { failed.push(`aborted: ${e.message}`); console.log(`\nABORTED: ${e.message}`); }
finally { if (adminToken) await cleanup(); }

console.log(`\n=== ${passed} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ""} ===`);
if (failed.length) { console.log("Failed:\n" + failed.map((f) => "  - " + f).join("\n")); process.exit(1); }
if (skipped.length) { console.log("NOT FULLY VERIFIED — skipped:\n" + skipped.map((s) => "  - " + s).join("\n")); process.exit(2); }
console.log("All security checks passed.");

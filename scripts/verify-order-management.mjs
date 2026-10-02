#!/usr/bin/env node
/**
 * Replays supabase/migrations 0001..0010 on a real in-process Postgres (PGlite/WASM) behind a small
 * Supabase-style shim (anon/authenticated/service_role roles, auth.uid(), default table grants) and checks the
 * order-management rules of migration 0010: roles, the transition map, stale/idempotent transitions, restock
 * exactly once, cancel-after-dispatch stock return, cash -> paid, status history, and that staff/anon/plain
 * users can only do what the database allows them to.
 *
 * Not part of `npm run build`/CI (needs `npm i --no-save @electric-sql/pglite`). Run: node scripts/verify-order-management.mjs
 * Storage (0003) and the seed are skipped — they don't matter here.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const db = new PGlite();
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
};

const OWNER = randomUUID(), STAFF = randomUUID(), PLAIN = randomUUID();
const MEM1 = randomUUID(), MEM2 = randomUUID(), LAND = randomUUID(), DUP = randomUUID();

// ---- Supabase-style shim ---------------------------------------------------------------------------------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, phone text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant select on auth.users to authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);
const file = (n) => readFileSync(new URL(`../supabase/migrations/${n}`, import.meta.url), "utf8");
const MIGRATIONS = ["0001_schema.sql", "0002_rls.sql", "0004_rpc.sql", "0005_admin_categories.sql", "0006_admin_products.sql",
  "0007_stock_availability.sql", "0008_business_settings.sql", "0009_orders.sql"];
for (const m of MIGRATIONS) await db.exec(file(m));

// An existing project: an owner already in admin_users BEFORE 0010 (no role column at that time in prod;
// here 0002 already adds it, so simulate the pre-0010 state by inserting through the default).
await db.exec(`
  insert into auth.users (id, email) values ('${OWNER}','owner@x.test'), ('${STAFF}','staff@x.test'), ('${PLAIN}','plain@x.test');
  insert into auth.users (id, phone) values ('${MEM1}','972501112222'), ('${MEM2}','972503334444'), ('${LAND}','97289945190'), ('${DUP}','972501112222');
  insert into public.admin_users (user_id) values ('${OWNER}');
`);
await db.exec(file("0010_order_management.sql"));
await db.exec(file("0010_order_management.sql")); // re-runnable
await db.exec(file("0011_customer_security_hardening.sql"));
await db.exec(file("0011_customer_security_hardening.sql")); // re-runnable
await db.exec(file("0012_customers.sql"));
await db.exec(file("0012_customers.sql")); // re-runnable
await db.exec(file("0013_customer_admin.sql"));
await db.exec(file("0013_customer_admin.sql")); // re-runnable
await db.exec(file("0014_coupons.sql"));
await db.exec(file("0014_coupons.sql")); // re-runnable
await db.exec(file("0002_rls.sql"));               // re-running 0002 must not widen is_admin()
await db.exec(`insert into public.admin_users (user_id, role) values ('${STAFF}', 'staff');`);

// ---- helpers -----------------------------------------------------------------------------------------------
async function as(role, uid, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false); set role ${role};`);
  try {
    return { ok: true, rows: (await db.query(sql, params)).rows };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  } finally {
    await db.exec("reset role");
  }
}
const asOwner = (sql, p) => as("authenticated", OWNER, sql, p);
const asStaff = (sql, p) => as("authenticated", STAFF, sql, p);
const asPlain = (sql, p) => as("authenticated", PLAIN, sql, p);
const asAnon = (sql, p) => as("anon", null, sql, p);
const asMem1 = (sql, p) => as("authenticated", MEM1, sql, p);
const asMem2 = (sql, p) => as("authenticated", MEM2, sql, p);
const su = async (sql, p) => (await db.query(sql, p)).rows;

// ---- fixtures ----------------------------------------------------------------------------------------------
await su(`insert into public.categories (id, slug, name_he) values ('00000000-0000-0000-0000-0000000000c1','c','קט')`);
await su(`insert into public.products (id, category_id, name_he, unit_price, track_stock, stock_base_units, package_enabled, package_label, package_unit_count, package_price)
          values ('901','00000000-0000-0000-0000-0000000000c1','מוצר',100,true,10,true,'מארז',5,450),
                 ('902','00000000-0000-0000-0000-0000000000c1','ללא מעקב',60,false,0,false,null,null,null)`);
await su(`update public.business_settings set min_order_cents = 0, delivery_fee_cents = 1500 where id = 1`);

const customer = { first_name: "א", last_name: "ב", phone: "050-123-4567", city: "נתיבות", street: "הרצל", house_number: "1", age_confirmed: true, terms_accepted: true };
async function newOrder(items = [{ product_id: "901", option: "unit", quantity: 2 }], method = "cash") {
  const r = await asAnon(`select public.create_order($1::jsonb, $2::uuid) as o`, [JSON.stringify({ items, payment_method: method, customer }), randomUUID()]);
  if (!r.ok) throw new Error(r.error);
  return r.rows[0].o;
}
const stock = async (id = "901") => (await su(`select stock_base_units s from public.products where id=$1`, [id]))[0].s;
const order = async (id) => (await su(`select * from public.orders where id=$1`, [id]))[0];
const tr = (who, id, exp, to, reason = null) => who(`select public.transition_order($1::uuid,$2,$3,$4) as r`, [id, exp, to, reason]);

// ---- roles ---------------------------------------------------------------------------------------------------
console.log("\nRoles");
check("existing admin row defaulted to owner", (await su(`select role from public.admin_users where user_id=$1`, [OWNER]))[0].role === "owner");
check("owner: is_admin/is_staff true, role owner", (await asOwner(`select public.is_admin() a, public.is_staff() s, public.get_my_role() r`)).rows[0].r === "owner");
const sr = (await asStaff(`select public.is_admin() a, public.is_staff() s, public.get_my_role() r`)).rows[0];
check("staff: is_admin false (even after re-running 0002), is_staff true, role staff", sr.a === false && sr.s === true && sr.r === "staff");
const pr = (await asPlain(`select public.is_admin() a, public.is_staff() s, public.get_my_role() r`)).rows[0];
check("plain user: nothing, role null", pr.a === false && pr.s === false && pr.r === null);
check("role check constraint rejects junk", !(await su(`select 1`)) || (await db.query(`insert into public.admin_users (user_id, role) values ('${randomUUID()}','boss')`).then(() => false, () => true)));

console.log("\nStaff cannot touch owner-only data");
for (const t of ["categories", "products", "business_settings", "payment_attempts", "payment_events"]) {
  const r = await asStaff(`select * from public.${t}`);
  check(`staff sees 0 rows of ${t}`, r.ok ? r.rows.length === 0 : true, r.error);
}
check("staff cannot update products", (await asStaff(`update public.products set unit_price = 1 returning id`)).rows?.length === 0 || !(await asStaff(`update public.products set unit_price = 1`)).ok);
check("staff cannot update business_settings", ((await asStaff(`update business_settings set orders_paused = true returning id`)).rows ?? []).length === 0);
check("staff cannot write admin_users", !(await asStaff(`insert into public.admin_users (user_id) values ('${PLAIN}')`)).ok);
check("staff cannot self-promote", ((await asStaff(`update public.admin_users set role='owner' where user_id='${STAFF}' returning 1`)).rows ?? []).length === 0);
check("owner still reads/writes the catalog", (await asOwner(`select id from public.products`)).rows.length === 2);

// ---- direct order writes are closed ----------------------------------------------------------------------------
console.log("\nDirect order access");
const o1 = await newOrder();
check("cash order created: confirmed, stock 10 -> 8", o1.order_status === "confirmed" && (await stock()) === 8);
for (const [who, name] of [[asOwner, "owner"], [asStaff, "staff"], [asPlain, "plain"], [asAnon, "anon"]]) {
  const u = await who(`update public.orders set order_status='completed' where id='${o1.order_id}' returning id`);
  const d = await who(`delete from public.orders where id='${o1.order_id}' returning id`);
  const i = await who(`insert into public.orders (payment_method) values ('cash')`);
  check(`${name} cannot UPDATE/DELETE/INSERT orders directly`, !u.ok && !d.ok && !i.ok, JSON.stringify({ u, d, i }));
}
check("still confirmed after those attempts", (await order(o1.order_id)).order_status === "confirmed");
check("owner reads orders + items + events", (await asOwner(`select id from public.orders`)).rows.length === 1 && (await asOwner(`select 1 from public.order_items`)).rows.length === 1 && (await asOwner(`select 1 from public.order_status_events`)).rows.length >= 1);
check("staff reads the active order, its items and events", (await asStaff(`select id from public.orders`)).rows.length === 1 && (await asStaff(`select 1 from public.order_items`)).rows.length === 1 && (await asStaff(`select 1 from public.order_status_events`)).rows.length >= 1);
check("plain user reads nothing", (await asPlain(`select id from public.orders`)).rows.length === 0 && (await asPlain(`select 1 from public.order_status_events`)).rows.length === 0);
check("anon denied on orders/events", !(await asAnon(`select id from public.orders`)).ok && !(await asAnon(`select 1 from public.order_status_events`)).ok);
check("plain user cannot call transition_order", !(await tr(asPlain, o1.order_id, "confirmed", "preparing")).ok);
check("anon cannot call transition_order", !(await tr(asAnon, o1.order_id, "confirmed", "preparing")).ok);

// ---- lifecycle ---------------------------------------------------------------------------------------------------
console.log("\nLifecycle");
let r = await tr(asStaff, o1.order_id, "confirmed", "preparing");
check("staff: confirmed -> preparing", r.ok && r.rows[0].r.order_status === "preparing" && r.rows[0].r.changed === true, r.error);
r = await tr(asStaff, o1.order_id, "confirmed", "preparing");
check("repeat of the same move is an idempotent no-op", r.ok && r.rows[0].r.changed === false, r.error);
r = await tr(asOwner, o1.order_id, "confirmed", "out_for_delivery");
check("stale expected status is refused with STALE_STATUS", !r.ok && /STALE_STATUS: preparing/.test(r.error), r.error);
r = await tr(asStaff, o1.order_id, "preparing", "completed");
check("cannot skip a step", !r.ok && /INVALID_TRANSITION/.test(r.error), r.error);
r = await tr(asStaff, o1.order_id, "preparing", "confirmed");
check("staff can step back one (preparing -> confirmed)", r.ok, r.error);
await tr(asStaff, o1.order_id, "confirmed", "preparing");
r = await tr(asStaff, o1.order_id, "preparing", "out_for_delivery");
check("preparing -> out_for_delivery", r.ok, r.error);
r = await tr(asStaff, o1.order_id, "out_for_delivery", "completed");
check("out_for_delivery -> completed; cash marked paid", r.ok && r.rows[0].r.payment_status === "paid", r.error);
let row = await order(o1.order_id);
check("completed_at set, stock unchanged (8)", row.completed_at !== null && (await stock()) === 8);
r = await tr(asStaff, o1.order_id, "completed", "out_for_delivery");
check("staff CANNOT reopen a completed order", !r.ok && /INVALID_TRANSITION/.test(r.error), r.error);
r = await tr(asOwner, o1.order_id, "completed", "out_for_delivery");
row = await order(o1.order_id);
check("owner can reopen; cash goes back to unpaid, completed_at cleared", r.ok && row.payment_status === "pending" && row.completed_at === null, r.error);
r = await tr(asStaff, o1.order_id, "out_for_delivery", "preparing");
check("staff step back out_for_delivery -> preparing", r.ok, r.error);

console.log("\nCancel before dispatch (auto restock)");
r = await tr(asStaff, o1.order_id, "preparing", "cancelled", "   ");
check("cancel needs a non-blank reason", !r.ok && /REASON_REQUIRED/.test(r.error), r.error);
check("...and nothing changed", (await order(o1.order_id)).order_status === "preparing" && (await stock()) === 8);
r = await tr(asStaff, o1.order_id, "preparing", "cancelled", "הלקוח ביטל");
row = await order(o1.order_id);
check("staff cancels with a reason: stock restored 8 -> 10, restored, payment cancelled",
  r.ok && (await stock()) === 10 && row.stock_return_status === "restored" && row.payment_status === "cancelled" && row.cancel_reason === "הלקוח ביטל", r.error);
r = await tr(asStaff, o1.order_id, "preparing", "cancelled", "again");
check("second cancel is a no-op: stock NOT restored twice", r.ok && r.rows[0].r.changed === false && (await stock()) === 10);
r = await tr(asOwner, o1.order_id, "cancelled", "confirmed");
check("a cancelled order cannot be reopened", !r.ok && /INVALID_TRANSITION/.test(r.error), r.error);

console.log("\nCancel after dispatch (stock held until returned)");
const o2 = await newOrder([{ product_id: "901", option: "package", quantity: 1 }, { product_id: "902", option: "unit", quantity: 3 }]);
check("package order deducts 5 base units (10 -> 5)", (await stock()) === 5);
for (const [a, b] of [["confirmed", "preparing"], ["preparing", "out_for_delivery"]]) await tr(asStaff, o2.order_id, a, b);
r = await tr(asStaff, o2.order_id, "out_for_delivery", "cancelled", "אף אחד לא פתח");
row = await order(o2.order_id);
check("cancelled out_for_delivery: pending_return, stock NOT restored", r.ok && row.stock_return_status === "pending_return" && (await stock()) === 5, r.error);
check("staff still sees it (pending_return) regardless of age", (await asStaff(`select 1 from public.orders where id='${o2.order_id}'`)).rows.length === 1);
r = await asStaff(`select public.resolve_stock_return($1::uuid,'written_off')`, [o2.order_id]);
check("staff cannot write off stock", !r.ok, r.error);
r = await asPlain(`select public.resolve_stock_return($1::uuid,'returned')`, [o2.order_id]);
check("plain user cannot resolve", !r.ok);
r = await asStaff(`select public.resolve_stock_return($1::uuid,'returned') as r`, [o2.order_id]);
check("staff confirms return: stock 5 -> 10 (untracked p2 untouched)", r.ok && (await stock()) === 10 && (await stock("902")) === 0, r.error);
r = await asStaff(`select public.resolve_stock_return($1::uuid,'returned') as r`, [o2.order_id]);
check("confirming again is a no-op (no double restock)", r.ok && (await stock()) === 10, r.error);
r = await asOwner(`select public.resolve_stock_return($1::uuid,'written_off')`, [o2.order_id]);
check("cannot flip an already-resolved return", !r.ok, r.error);

const o3 = await newOrder();
for (const [a, b] of [["confirmed", "preparing"], ["preparing", "out_for_delivery"]]) await tr(asStaff, o3.order_id, a, b);
await tr(asStaff, o3.order_id, "out_for_delivery", "cancelled", "x");
r = await asOwner(`select public.resolve_stock_return($1::uuid,'written_off') as r`, [o3.order_id]);
check("owner can write off: no restock", r.ok && (await stock()) === 8 && (await order(o3.order_id)).stock_return_status === "written_off", r.error);

console.log("\nHistory");
const ev = await su(`select kind, from_value, to_value, actor_label, actor_role, reason from public.order_status_events where order_id=$1 order by id`, [o1.order_id]);
check("timeline starts with 'created' by the customer", ev[0].kind === "created" && ev[0].actor_label === "customer");
check("status events carry actor email + role", ev.some((e) => e.kind === "status" && e.to_value === "preparing" && e.actor_label === "staff@x.test" && e.actor_role === "staff"));
check("owner's reopen is attributed to the owner", ev.some((e) => e.kind === "status" && e.from_value === "completed" && e.actor_label === "owner@x.test" && e.actor_role === "owner"));
check("cancel reason recorded on the event", ev.some((e) => e.to_value === "cancelled" && e.reason === "הלקוח ביטל"));
check("payment change recorded (pending->paid)", ev.some((e) => e.kind === "payment" && e.to_value === "paid"));
check("stock_return change recorded", (await su(`select 1 from public.order_status_events where order_id=$1 and kind='stock_return' and to_value='restored'`, [o2.order_id])).length === 1);
check("events cannot be written via the API", !(await asOwner(`insert into public.order_status_events (order_id, kind, to_value, actor_label) values ('${o1.order_id}','status','x','x')`)).ok
  && !(await asStaff(`delete from public.order_status_events`)).ok);

console.log("\nStaff visibility window");
const old = await newOrder();
await tr(asStaff, old.order_id, "confirmed", "preparing");
await tr(asStaff, old.order_id, "preparing", "out_for_delivery");
await tr(asStaff, old.order_id, "out_for_delivery", "completed");
check("finished today: staff can see it", (await asStaff(`select 1 from public.orders where id='${old.order_id}'`)).rows.length === 1);
await su(`update public.orders set status_changed_at = now() - interval '8 days' where id=$1`, [old.order_id]);
check("finished 8 days ago: staff cannot see it (or its items/events)",
  (await asStaff(`select 1 from public.orders where id='${old.order_id}'`)).rows.length === 0
  && (await asStaff(`select 1 from public.order_items where order_id='${old.order_id}'`)).rows.length === 0
  && (await asStaff(`select 1 from public.order_status_events where order_id='${old.order_id}'`)).rows.length === 0);
check("...but the owner still can", (await asOwner(`select 1 from public.orders where id='${old.order_id}'`)).rows.length === 1);
const stale = await newOrder();
await su(`update public.orders set status_changed_at = now() - interval '30 days', created_at = now() - interval '30 days' where id=$1`, [stale.order_id]);
check("an ancient order still open (confirmed) stays visible to staff", (await asStaff(`select 1 from public.orders where id='${stale.order_id}'`)).rows.length === 1);
check("phone search by digits works", (await asStaff(`select 1 from public.orders where phone_digits like '%0501234567%'`)).rows.length >= 1);

console.log("\nLegacy behaviour still intact");
const card = await newOrder([{ product_id: "901", option: "unit", quantity: 1 }], "card");
check("card order still pending/reserved, invisible to the board statuses", card.order_status === "pending");
check("card 'pending' cannot be moved by transition_order", !(await tr(asStaff, card.order_id, "pending", "preparing")).ok);
check("owner-only expire_stale_orders still callable by owner, not staff", (await asOwner(`select public.expire_stale_orders()`)).ok && !(await asStaff(`select public.expire_stale_orders()`)).ok);
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`); // the webhook runs as service_role: no user
await su(`select public.confirm_payment((select id from public.payment_attempts limit 1), 'evt-1', 'succeeded')`);
check("confirm_payment still confirms a card order (-> shows on the board as new)", (await order(card.order_id)).order_status === "confirmed" && (await order(card.order_id)).payment_status === "paid");
check("its history has a system-attributed status event", (await su(`select 1 from public.order_status_events where order_id=$1 and kind='status' and to_value='confirmed' and actor_label='system'`, [card.order_id])).length === 1);

// ---- a logged-in CUSTOMER (migration 0011) -------------------------------------------------------------------------
// Public phone sign-up will make `authenticated` mean "any member". A customer who even OWNS an order must still
// see nothing through the table API, and nothing admin anywhere.
console.log("\nA logged-in customer (not in admin_users) who owns an order");
const mine = await newOrder();
await su(`update public.orders set customer_id = $1 where id = $2`, [PLAIN, mine.order_id]); // as create_order will do for members
check("customer cannot read their own order through the table API (column-whitelisting RPC only)",
  (await asPlain(`select id from public.orders`)).rows.length === 0 && (await asPlain(`select 1 from public.order_items`)).rows.length === 0);
check("customer cannot read status events (staff e-mails / internal reasons)", (await asPlain(`select 1 from public.order_status_events`)).rows.length === 0);
check("the customer policies on orders/order_items are gone",
  (await su(`select 1 from pg_policies where schemaname='public' and policyname in ('orders_customer_select_own','order_items_customer_select_own')`)).length === 0);
check("status events are readable only with is_staff() (policy body)",
  (await su(`select qual from pg_policies where policyname='order_status_events_select'`))[0].qual.includes("is_staff"));
check("owner and staff still read events after the change",
  (await asOwner(`select 1 from public.order_status_events where order_id='${mine.order_id}'`)).rows.length >= 1
  && (await asStaff(`select 1 from public.order_status_events where order_id='${mine.order_id}'`)).rows.length >= 1);
for (const [who, name] of [[asPlain, "customer"]]) {
  const u = await who(`update public.orders set order_status='completed' where id='${mine.order_id}' returning id`);
  const d = await who(`delete from public.orders where id='${mine.order_id}' returning id`);
  check(`${name} cannot UPDATE/DELETE their own order`, !u.ok && !d.ok);
}

console.log("\nEvery table: a customer sees nothing and writes nothing");
const tables = (await su(`select tablename from pg_tables where schemaname='public' order by 1`)).map((t) => t.tablename);
// Tables meant to be readable by anyone logged in: none today. (Add a name here only after a deliberate review.)
const READABLE_BY_ANY_LOGIN = [];
for (const t of tables) {
  const read = await asPlain(`select * from public.${t} limit 1`);
  const leaked = read.ok && read.rows.length > 0 && !READABLE_BY_ANY_LOGIN.includes(t);
  const ins = await asPlain(`insert into public.${t} default values`);
  const upd = await asPlain(`update public.${t} set ${(await su(`select column_name c from information_schema.columns where table_schema='public' and table_name=$1 limit 1`, [t]))[0].c} = null returning 1`);
  const del = await asPlain(`delete from public.${t} returning 1`);
  check(`${t}: customer read=${read.ok ? read.rows.length : "denied"} write=${ins.ok ? "ALLOWED" : "denied"}`,
    !leaked && !ins.ok && (!upd.ok || upd.rows.length === 0) && (!del.ok || del.rows.length === 0), JSON.stringify({ read, ins, upd, del }));
}

console.log("\nEvery function a customer can execute is known and self-guarded");
const execFns = (await su(`
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, p.proname as name, p.prosecdef as definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`));
// Reviewed list (docs/CUSTOMER_PERMISSIONS_AUDIT.md). A NEW function showing up here fails the check on purpose:
// someone has to decide whether a customer may call it.
const PUBLIC_BY_DESIGN = ["get_storefront_catalog", "check_stock_availability", "get_business_settings", "create_order", "get_order_status"];
const GUARDED_ADMIN = ["is_admin", "is_staff", "get_my_role", "expire_stale_orders", "transition_order", "resolve_stock_return",
  "admin_reorder_categories", "admin_reorder_subcategories", "admin_reorder_products", "admin_product_counts",
  // owner's customer tools (0013): each re-checks is_admin() (owner only) inside itself
  "admin_customer_stats", "admin_list_customers", "admin_export_audience"];
// Member-facing (0012): each reads auth.uid() itself, returns only the caller's own data, and is revoked from anon.
const MEMBER_RPCS = ["get_my_customer", "claim_guest_orders", "join_club", "get_my_orders", "set_marketing_consent", "delete_my_account",
  // coupons (0014): checks the caller's own membership itself, refuses everyone else; revoked from anon
  "preview_coupon"];
// Pure, side-effect-free helpers that must stay callable because a table CHECK runs them with the caller's privileges.
const PURE_HELPERS = ["normalize_coupon_code"];
const known = new Set([...PUBLIC_BY_DESIGN, ...GUARDED_ADMIN, ...MEMBER_RPCS, ...PURE_HELPERS]);
const unknown = execFns.filter((f) => !known.has(f.name));
check("no unreviewed function is executable by logged-in users", unknown.length === 0, unknown.map((f) => f.sig).join(", "));
check("customer: is_admin/is_staff false, role null", (() => pr.a === false && pr.s === false && pr.r === null)());
check("customer cannot transition / resolve / expire", !(await tr(asPlain, mine.order_id, "confirmed", "preparing")).ok
  && !(await asPlain(`select public.resolve_stock_return('${mine.order_id}','returned')`)).ok
  && !(await asPlain(`select public.expire_stale_orders()`)).ok);
const catIds = (await su(`select id from public.categories`)).map((c) => c.id);
const sortBefore = JSON.stringify(await su(`select id, sort_order from public.categories order by id`));
const reorder = await asPlain(`select public.admin_reorder_categories($1::uuid[])`, [catIds]);
check("customer cannot reorder categories (RLS hides them; sort order unchanged)",
  (!reorder.ok) && JSON.stringify(await su(`select id, sort_order from public.categories order by id`)) === sortBefore);
check("customer sees no product counts", ((await asPlain(`select * from public.admin_product_counts()`)).rows ?? []).length === 0);
check("customer cannot change catalog rows", ((await asPlain(`update public.products set unit_price = 1 returning id`)).rows ?? []).length === 0);

// ---- Balagan Club (migration 0012) ------------------------------------------------------------------------------
console.log("\nPhone normalization");
const norm = async (v) => (await su(`select public.normalize_il_phone($1) as p`, [v]))[0].p;
check("050-123-4567 -> +972501234567", (await norm("050-123-4567")) === "+972501234567");
check("+972 50 123 4567 / 972501234567 / 00972501234567 / +972(0)50… all agree",
  (await Promise.all(["+972 50 123 4567", "972501234567", "00972501234567", "+972(0)501234567"].map(norm))).every((p) => p === "+972501234567"));
check("landline 08-994-5190 -> +97289945190", (await norm("08-994-5190")) === "+97289945190");
check("junk / too short / wrong prefix -> null", [null, "", "abc", "12345", "0123456789", "+1 202 555 0100"].every(async (v) => true)
  && (await Promise.all([null, "", "abc", "12345", "0123456789", "+12025550100"].map(norm))).every((p) => p === null));
check("orders.phone_e164 is generated from the free-text phone", (await su(`select phone_e164 from public.orders where id=$1`, [o1.order_id]))[0].phone_e164 === "+972501234567");

console.log("\nJoining the club");
const guestPhoneCustomer = { ...customer, phone: "050-111-2222", first_name: "דנה", last_name: "כהן", street: "הרצל", house_number: "5", apartment: "3", email: "dana@x.test" };
async function place(who, cust = customer, items = [{ product_id: "902", option: "unit", quantity: 1 }]) {
  const r = await who(`select public.create_order($1::jsonb, $2::uuid) as o`, [JSON.stringify({ items, payment_method: "cash", customer: cust }), randomUUID()]);
  if (!r.ok) throw new Error(r.error);
  return r.rows[0].o;
}
const guestOld = await place(asAnon, guestPhoneCustomer);
check("a guest order has no customer", (await order(guestOld.order_id)).customer_id === null);

const joinPayload = { age_21_confirmed: true, marketing_consent: true, wording_version: "v1", channels: ["sms", "email"] };
const J = (who, p) => who(`select public.join_club($1::jsonb) as j`, [JSON.stringify(p)]);
check("anon cannot join", !(await J(asAnon, joinPayload)).ok);
check("join refused without the 21+ confirmation", /AGE_21_REQUIRED/.test((await J(asMem1, { ...joinPayload, age_21_confirmed: false })).error ?? ""));
check("join refused without the marketing consent", /MARKETING_CONSENT_REQUIRED/.test((await J(asMem1, { marketing_consent: false, age_21_confirmed: true })).error ?? ""));
check("join refused with an empty payload", !(await J(asMem1, {})).ok);
check("nothing was created by the refused attempts", (await su(`select count(*)::int n from public.customers`))[0].n === 0);
check("a landline login cannot become a member (MOBILE_REQUIRED)", /MOBILE_REQUIRED/.test((await J(asAs(LAND), joinPayload)).error ?? ""));
function asAs(uid) { return (sql, p) => as("authenticated", uid, sql, p); }
check("a member's profile before joining is null", (await asMem1(`select public.get_my_customer() as c`)).rows[0].c === null);

const j1 = await J(asMem1, { ...joinPayload, phone: "0509999999", first_name: "" });
check("join succeeds; phone comes from auth.users, not the payload", j1.ok && j1.rows[0].j.phone === "+972501112222" && j1.rows[0].j.created === true, j1.error);
check("marketing consent + channels + 21+ recorded", j1.rows[0].j.marketing === true && j1.rows[0].j.marketing_channels.length === 2 && j1.rows[0].j.age_21_confirmed_at !== null);
check("the earlier guest order with the same verified phone was claimed", j1.rows[0].j.claimed_orders === 1 && (await order(guestOld.order_id)).customer_id === MEM1);
check("claiming taught the profile: name, email and the address", j1.rows[0].j.first_name === "דנה" && j1.rows[0].j.email === "dana@x.test"
  && (await su(`select 1 from public.customer_addresses where customer_id=$1 and street='הרצל' and house_number='5'`, [MEM1])).length === 1);
check("a different guest's orders (other phone) were NOT claimed", (await order(o1.order_id)).customer_id === null);
const j1b = await J(asMem1, {});
check("joining again is idempotent and needs no checkbox", j1b.ok && j1b.rows[0].j.created === false);
check("another login cannot take the same phone", /PHONE_ALREADY_REGISTERED/.test((await J(asAs(DUP), joinPayload)).error ?? ""));
check("consent history: 21+ and marketing at registration, then the terms accepted on the claimed order",
  (await su(`select kind from public.customer_consents where customer_id=$1 order by id`, [MEM1])).map((r) => r.kind).join() === "age_21,marketing,terms");

console.log("\nMembers ordering");
const m2 = await J(asMem2, { ...joinPayload, first_name: "יוסי", last_name: "לוי" });
check("a second member joins", m2.ok && m2.rows[0].j.phone === "+972503334444");
const memOrder = await place(asMem1, { ...guestPhoneCustomer, phone: "052-000-0000", notes: "קומה שנייה" });
check("a member's order is attached by the database (not by the payload)", (await order(memOrder.order_id)).customer_id === MEM1);
check("a non-member logged-in user's order stays a guest order", (await order((await place(asPlain)).order_id)).customer_id === null);
const sneaky = await place(asAnon, { ...customer, customer_id: MEM1 });
check("a client-sent customer_id is ignored", (await order(sneaky.order_id)).customer_id === null);
check("same address again is de-duplicated (still 1)", (await su(`select count(*)::int n from public.customer_addresses where customer_id=$1`, [MEM1]))[0].n === 1);
await place(asMem1, { ...guestPhoneCustomer, street: "בן גוריון", house_number: "10", apartment: null });
check("a new address is saved automatically and becomes the default (most recent)",
  (await su(`select street from public.customer_addresses where customer_id=$1 order by last_used_at desc limit 1`, [MEM1]))[0].street === "בן גוריון");
for (const n of [11, 12, 13, 14, 15]) await place(asMem1, { ...guestPhoneCustomer, street: "בן גוריון", house_number: String(n), apartment: null });
check("saved addresses are capped at 5", (await su(`select count(*)::int n from public.customer_addresses where customer_id=$1`, [MEM1]))[0].n === 5);
check("order history: member orders show actor 'customer', not a uuid",
  (await su(`select actor_label, actor_id from public.order_status_events where order_id=$1 and kind='created'`, [memOrder.order_id]))[0].actor_label === "customer"
  && (await su(`select actor_id from public.order_status_events where order_id=$1 and kind='created'`, [memOrder.order_id]))[0].actor_id === null);
check("last_order_at and terms version were recorded", (await su(`select last_order_at, terms_version from public.customers where id=$1`, [MEM1]))[0].terms_version === "v1");

console.log("\nMy orders (column-whitelisted RPC)");
const mine1 = (await asMem1(`select public.get_my_orders(50) as o`)).rows[0].o;
check("member sees only their own orders, newest first, with items", mine1.length >= 8 && mine1.every((x) => Array.isArray(x.items)) && mine1[0].order_number >= mine1[mine1.length - 1].order_number);
check("no internal columns leak (cancel reason, stock state, idempotency key, phone digits, actor)",
  mine1.every((x) => !("cancel_reason" in x) && !("stock_return_status" in x) && !("idempotency_key" in x) && !("customer_id" in x) && !("phone_digits" in x) && !("actor_label" in x)));
check("the other member sees none of them", (await asMem2(`select jsonb_array_length(public.get_my_orders(50)) n`)).rows[0].n === 0);
check("anon and a plain non-member get nothing / are refused", !(await asAnon(`select public.get_my_orders()`)).ok && (await asAs(LAND)(`select jsonb_array_length(public.get_my_orders()) n`)).rows[0].n === 0);
check("the table API stays closed to members", (await asMem1(`select 1 from public.orders`)).rows.length === 0 && (await asMem1(`select 1 from public.order_items`)).rows.length === 0 && (await asMem1(`select 1 from public.order_status_events`)).rows.length === 0);

console.log("\nMember data isolation");
check("a member reads only their own profile / addresses / consents",
  (await asMem1(`select id from public.customers`)).rows.length === 1 && (await asMem1(`select id from public.customers`)).rows[0].id === MEM1
  && (await asMem2(`select 1 from public.customer_addresses where customer_id='${MEM1}'`)).rows.length === 0
  && (await asMem2(`select 1 from public.customer_consents where customer_id='${MEM1}'`)).rows.length === 0);
check("a member cannot edit another member or their own phone/terms/deleted_at",
  ((await asMem2(`update public.customers set first_name='x' where id='${MEM1}' returning 1`)).rows ?? []).length === 0
  && !(await asMem1(`update public.customers set phone_e164='+972509999999' where id='${MEM1}'`)).ok
  && !(await asMem1(`update public.customers set terms_version='zzz' where id='${MEM1}'`)).ok
  && !(await asMem1(`update public.customers set deleted_at=now() where id='${MEM1}'`)).ok);
check("a member can edit their own name/e-mail", (await asMem1(`update public.customers set first_name='דנה2', email='d@x.test' where id='${MEM1}' returning 1`)).rows.length === 1);
check("a bad e-mail is rejected by the database", !(await asMem1(`update public.customers set email='nope' where id='${MEM1}'`)).ok);
check("nobody can insert/delete customers or write consents through the API",
  !(await asMem1(`insert into public.customers (id, phone_e164) values ('${randomUUID()}','+972501234000')`)).ok
  && !(await asMem1(`delete from public.customers where id='${MEM1}'`)).ok
  && !(await asMem1(`insert into public.customer_consents (customer_id, kind, granted, wording_version, source) values ('${MEM1}','marketing',true,'v9','account')`)).ok
  && !(await asMem1(`update public.customer_consents set granted=false`)).ok
  && !(await asMem1(`delete from public.customer_consents`)).ok);
check("owner/staff have no customer-table access yet (admin screen is a later, separate step)",
  (await asOwner(`select 1 from public.customers`)).rows.length === 0 && (await asStaff(`select 1 from public.customer_addresses`)).rows.length === 0);
const ownAddr = (await asMem1(`insert into public.customer_addresses (customer_id, street, house_number) values ('${MEM1}','ויצמן','1') returning id`));
check("a member can add their own address, not one for someone else, not another city",
  ownAddr.ok && !(await asMem1(`insert into public.customer_addresses (customer_id, street, house_number) values ('${MEM2}','x','1')`)).ok
  && !(await asMem1(`insert into public.customer_addresses (customer_id, city, street, house_number) values ('${MEM1}','תל אביב','x','1')`)).ok);
check("a member can edit/delete only their own address", (await asMem1(`update public.customer_addresses set intercom_code='12' where id='${ownAddr.rows[0].id}' returning 1`)).rows.length === 1
  && ((await asMem2(`delete from public.customer_addresses where id='${ownAddr.rows[0].id}' returning 1`)).rows ?? []).length === 0
  && (await asMem1(`delete from public.customer_addresses where id='${ownAddr.rows[0].id}' returning 1`)).rows.length === 1);

console.log("\nMarketing consent and account deletion");
const w = await asMem1(`select public.set_marketing_consent(false) as c`);
check("withdrawing marketing keeps the account", w.ok && w.rows[0].c.marketing === false && w.rows[0].c.id === MEM1);
check("history is append-only: grant then withdraw both on record", (await su(`select granted from public.customer_consents where customer_id=$1 and kind='marketing' order by id`, [MEM1])).map((r) => r.granted).join() === "true,false");
const rg = await asMem1(`select public.set_marketing_consent(true, array['sms']) as c`);
check("re-granting records the chosen channels", rg.rows[0].c.marketing === true && rg.rows[0].c.marketing_channels.join() === "sms");
check("a non-member cannot set consent", !(await asPlain(`select public.set_marketing_consent(true)`)).ok);
const countBefore = (await su(`select count(*)::int n from public.orders where phone_e164='+972501112222'`))[0].n;
await asMem1(`select public.delete_my_account()`);
check("delete_my_account: profile blanked, addresses gone, marketing withdrawn, phone kept only as suppression",
  (await su(`select first_name, email, deleted_at is not null as gone, phone_e164 from public.customers where id=$1`, [MEM1]))[0].first_name === null
  && (await su(`select 1 from public.customer_addresses where customer_id=$1`, [MEM1])).length === 0
  && (await su(`select granted from public.customer_consents where customer_id=$1 and kind='marketing' order by id desc limit 1`, [MEM1]))[0].granted === false
  && (await su(`select phone_e164 from public.customers where id=$1`, [MEM1]))[0].phone_e164 === "+972501112222");
check("orders survive (accounting) but are unlinked from the account", (await su(`select count(*)::int n from public.orders where customer_id=$1`, [MEM1]))[0].n === 0
  && (await su(`select count(*)::int n from public.orders where phone_e164='+972501112222'`))[0].n === countBefore);
check("a deleted member is no longer a member and sees no orders", (await asMem1(`select public.get_my_customer() as c`)).rows[0].c === null
  && (await asMem1(`select jsonb_array_length(public.get_my_orders()) n`)).rows[0].n === 0);
check("a deleted member's next order is a guest order", (await order((await place(asMem1)).order_id)).customer_id === null);
const rejoin = await J(asMem1, joinPayload);
check("rejoining needs the mandatory confirmation again and re-claims their history", rejoin.ok && rejoin.rows[0].j.created === true && rejoin.rows[0].j.claimed_orders >= 1);

// ---- the owner's customer tools (migration 0013) ----------------------------------------------------------------
console.log("\nOwner customer tools");
// Fresh, isolated members so the numbers below don't depend on what earlier sections left behind.
const mk = async (phone, name, email) => {
  const id = randomUUID();
  await su(`insert into auth.users (id, phone) values ($1, $2)`, [id, phone]);
  const who = (sql, p) => as("authenticated", id, sql, p);
  const j = await J(who, { ...joinPayload, first_name: name, last_name: "בדיקה", email });
  if (!j.ok) throw new Error(j.error);
  return { id, who };
};
const before = (await asOwner(`select public.admin_customer_stats() as s`)).rows[0].s;

const mSms = await mk("972521000001", "שרה", null);                // consents to both, but has NO e-mail on file
const mBoth = await mk("972521000002", "בני", "beni@x.test");      // both channels + e-mail
const mMail = await mk("972521000003", "מיכל", "michal@x.test");   // e-mail channel only
await mMail.who(`select public.set_marketing_consent(true, array['email'])`);
const mOut = await mk("972521000004", "אורן", "oren@x.test");      // withdrew marketing
await mOut.who(`select public.set_marketing_consent(false)`);
const mGone = await mk("972521000005", "גדעון", "gid@x.test");     // deleted the account
await mGone.who(`select public.delete_my_account()`);

const stats = (await asOwner(`select public.admin_customer_stats() as s`)).rows[0].s;
const d = (k) => stats[k] - before[k];
check("stats: 4 new live members (the deleted one is not a member), 1 deleted", d("members") === 4 && d("deleted") === 1, JSON.stringify(stats));
check("stats: reachable by SMS = sarah+beni, by e-mail = beni+michal (an e-mail address on file is required), 1 withdrawn",
  d("marketing_sms") === 2 && d("marketing_email") === 2 && d("withdrawn") === 1, JSON.stringify(stats));

console.log("\nOnly the OWNER may use them");
const asLand = asAs(LAND);
for (const [who, name] of [[asStaff, "staff"], [asPlain, "a plain logged-in user"], [mBoth.who, "a club member"], [asAnon, "anon"]]) {
  const r1 = await who(`select public.admin_customer_stats()`);
  const r2 = await who(`select public.admin_list_customers()`);
  const r3 = await who(`select public.admin_export_audience('sms')`);
  check(`${name} is refused all three`, !r1.ok && !r2.ok && !r3.ok, JSON.stringify([r1.error, r2.error, r3.error]));
}
check("...and nothing was logged by those refusals", (await su(`select count(*)::int n from public.customer_exports`))[0].n === 0);
check("the owner still has NO direct table access to customer data (only through the functions)",
  (await asOwner(`select 1 from public.customers`)).rows.length === 0 && (await asOwner(`select 1 from public.customer_consents`)).rows.length === 0
  && (await asOwner(`select 1 from public.customer_addresses`)).rows.length === 0 && !(await asOwner(`select 1 from public.customer_exports`)).ok);
check("the internal helpers are not callable through the API",
  !(await asOwner(`select * from public.customer_marketing_state()`)).ok && !(await asOwner(`select * from public.customers_filtered(null, 'all')`)).ok);

console.log("\nMember list");
const list = async (args = []) => (await asOwner(`select public.admin_list_customers($1, $2, $3, $4) as r`, [args[0] ?? null, args[1] ?? "all", args[2] ?? 50, args[3] ?? 0])).rows[0].r;
const all = await list();
check("the list has live members only, newest first, with the expected fields",
  all.rows.every((r) => r.id !== mGone.id) && all.rows.some((r) => r.id === mSms.id) && all.total === all.rows.length
  && all.rows.every((r, i) => i === 0 || r.joined_at <= all.rows[i - 1].joined_at)
  && ["id", "phone", "first_name", "last_name", "email", "joined_at", "last_order_at", "orders_count", "marketing", "marketing_channels", "marketing_changed_at"].every((k) => k in all.rows[0]));
check("no address, consent text or internal ids leak into list rows", all.rows.every((r) => !("street" in r) && !("terms_version" in r) && !("deleted_at" in r)));
check("search by local phone '052-1000002' finds exactly that member", (await list(["052-1000002"])).rows.map((r) => r.id).join() === mBoth.id);
check("search by name and by e-mail", (await list(["מיכל"])).rows.map((r) => r.id).join() === mMail.id && (await list(["oren@"])).rows.map((r) => r.id).join() === mOut.id);
check("a LIKE wildcard in the search is plain text, not a match-all", (await list(["%"])).total === 0 && (await list(["_"])).total === 0);
check("a very short digit string is not treated as a phone match", (await list(["05"])).total === 0);
check("filter consenting / sms / email / withdrawn",
  (await list([null, "withdrawn"])).rows.map((r) => r.id).join() === mOut.id
  && (await list(["בדיקה", "email"])).rows.map((r) => r.id).sort().join() === [mBoth.id, mMail.id].sort().join()
  && (await list(["בדיקה", "sms"])).rows.map((r) => r.id).sort().join() === [mBoth.id, mSms.id].sort().join()
  && (await list(["בדיקה", "consenting"])).total === 3);
check("an unknown filter is refused", !(await asOwner(`select public.admin_list_customers(null, 'everyone')`)).ok);
const page1 = await list([null, "all", 2, 0]), page2 = await list([null, "all", 2, 2]);
check("pagination: total is the whole count, pages don't overlap, limit is clamped to 100",
  page1.rows.length === 2 && page1.total === all.total && page2.rows[0].id !== page1.rows[0].id && page2.rows[0].id !== page1.rows[1].id
  && (await list([null, "all", 100000, 0])).rows.length <= 100 && (await list([null, "all", -5, -5])).rows.length === 1);
check("orders_count reflects linked orders (the first member has placed several)", (await list(["111-2222"])).rows[0].orders_count >= 1);

console.log("\nExports");
const exp = async (kind) => (await asOwner(`select public.admin_export_audience($1) as r`, [kind])).rows[0].r;
const sms = await exp("sms");
const smsPhones = sms.map((r) => r.phone);
check("SMS audience: consenting members with the SMS channel — not the withdrawn, not the deleted, not an e-mail-only member",
  smsPhones.includes("+972521000001") && smsPhones.includes("+972521000002") && !smsPhones.includes("+972521000003")
  && !smsPhones.includes("+972521000004") && !smsPhones.includes("+972521000005"));
check("every audience row carries the proof of consent (when, which wording)", sms.every((r) => r.consent_at && r.wording_version === "v1"));
const mail = await exp("email");
check("e-mail audience: consenting members with the e-mail channel AND an address — sarah (no address) is not in it",
  mail.map((r) => r.email).sort().join() === ["beni@x.test", "michal@x.test"].concat(mail.map((r) => r.email).filter((e) => !["beni@x.test", "michal@x.test"].includes(e))).sort().join()
  && mail.some((r) => r.email === "beni@x.test") && mail.some((r) => r.email === "michal@x.test") && !mail.some((r) => r.phone === "+972521000001") && mail.every((r) => r.email));
const sup = await exp("suppression");
check("suppression list: the withdrawn (phone + e-mail) and the deleted (phone only), with the reason",
  sup.some((r) => r.phone === "+972521000004" && r.reason === "withdrawn" && r.email === "oren@x.test")
  && sup.some((r) => r.phone === "+972521000005" && r.reason === "deleted" && r.email === null)
  && !sup.some((r) => r.phone === "+972521000002"));
check("an unknown export kind is refused", !(await asOwner(`select public.admin_export_audience('everyone')`)).ok);
const logged = await su(`select actor_label, kind, row_count from public.customer_exports order by id`);
check("every export is logged with who, what and how many — and refused ones are not",
  logged.length === 3 && logged.map((l) => l.kind).join() === "sms,email,suppression" && logged.every((l) => l.actor_label === "owner@x.test")
  && logged[0].row_count === sms.length && logged[1].row_count === mail.length && logged[2].row_count === sup.length);
check("the log shows up in the stats as the last export", (await asOwner(`select public.admin_customer_stats() as s`)).rows[0].s.last_exports.sms.count === sms.length);
check("withdrawing consent removes someone from the next export",
  await (async () => { await mBoth.who(`select public.set_marketing_consent(false)`); return !(await exp("sms")).some((r) => r.phone === "+972521000002") && (await exp("suppression")).some((r) => r.phone === "+972521000002"); })());

// ---- coupons (migration 0014) ---------------------------------------------------------------------------------------
console.log("\nCoupons: code normalization (pinned to src/storefront/lib/couponCode.ts by tests/account/couponCode.unit.spec.ts)");
const nc = async (v) => (await su(`select public.normalize_coupon_code($1) as c`, [v]))[0].c;
check("case, spaces, full-width, invisible bidi marks, NBSP are all removed/folded; 0/O and 1/I are NOT folded",
  (await nc(" club 20 ")) === "CLUB20" && (await nc("ｃｌｕｂ２０")) === "CLUB20" && (await nc("CLUB‏20‎")) === "CLUB20"
  && (await nc("‫welcome-25‬")) === "WELCOME-25" && (await nc("a b")) === "AB" && (await nc("0O1I")) === "0O1I" && (await nc(null)) === "");

let cpn = 0;
const mkCoupon = async (o = {}) => {
  const c = { code: `T${++cpn}X`, title: "בדיקה", discount_type: "percent", discount_value: 20, max_discount_cents: null, min_subtotal_cents: 0,
    starts_at: null, ends_at: null, is_active: true, max_total_redemptions: null, max_per_member: null, first_order_only: false, ...o };
  return (await su(`insert into public.coupons (code,title,discount_type,discount_value,max_discount_cents,min_subtotal_cents,starts_at,ends_at,is_active,max_total_redemptions,max_per_member,first_order_only)
                    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, code`, Object.values(c)))[0];
};
const ITEMS = [{ product_id: "902", option: "unit", quantity: 2 }];            // subtotal 12000, delivery fee 1500
const placeC = (who, code, { items = ITEMS, method = "cash", cust = customer, key = randomUUID(), extra = {} } = {}) =>
  who(`select public.create_order($1::jsonb, $2::uuid) as o`, [JSON.stringify({ items, payment_method: method, customer: cust, ...(code ? { coupon_code: code } : {}), ...extra }), key]);
const okC = async (who, code, opts) => { const r = await placeC(who, code, opts); if (!r.ok) throw new Error(`${code}: ${r.error}`); return r.rows[0].o; };
const refused = (r, token) => !r.ok && new RegExp(`^${token}`).test(r.error);
const redemption = async (orderId) => (await su(`select * from public.coupon_redemptions where order_id=$1`, [orderId]))[0];
const mc = async (phone, name) => mk(phone, name, null);

console.log("\nCoupons: who may use them (decided by the database, at order time)");
await su(`insert into public.products (id, category_id, name_he, unit_price, unit_sale_enabled, unit_sale_price, track_stock, stock_base_units)
          values ('903','00000000-0000-0000-0000-0000000000c1','במבצע',100,true,80,false,0)`);
const elig = await mkCoupon({ code: "ELIG" });
const cA = await mc("972522000001", "אבי"), cB = await mc("972522000002", "בני"), cC = await mc("972522000003", "גיל");
const stock901 = await stock();
const ordersBefore = (await su(`select count(*)::int n from public.orders`))[0].n;
const guestTry = await placeC(asAnon, "ELIG", { items: [{ product_id: "901", option: "unit", quantity: 1 }, ...ITEMS] });
check("a GUEST cannot redeem: COUPON_MEMBERS_ONLY, no order, stock untouched (whole transaction rolled back)",
  refused(guestTry, "COUPON_MEMBERS_ONLY") && (await stock()) === stock901 && (await su(`select count(*)::int n from public.orders`))[0].n === ordersBefore, guestTry.error);
check("a logged-in user who is not a member cannot", refused(await placeC(asPlain, "ELIG"), "COUPON_MEMBERS_ONLY"));
check("an owner/staff token is not a customer either", refused(await placeC(asOwner, "ELIG"), "COUPON_MEMBERS_ONLY") && refused(await placeC(asStaff, "ELIG"), "COUPON_MEMBERS_ONLY"));
check("a non-member learns nothing about which codes exist (same answer for a made-up code)", refused(await placeC(asPlain, "NO-SUCH-CODE"), "COUPON_MEMBERS_ONLY") && refused(await placeC(asAnon, "NO-SUCH-CODE"), "COUPON_MEMBERS_ONLY"));
check("a member who deleted their account is refused (membership is checked live)", refused(await placeC(mGone.who, "ELIG"), "COUPON_MEMBERS_ONLY"));
check("an unknown code is COUPON_INVALID for a member; a blank code just means no coupon", refused(await placeC(cA.who, "NOPE"), "COUPON_INVALID") && (await placeC(cA.who, "   ")).ok);
const eo = await okC(cA.who, "ELIG");
const eRow = await order(eo.order_id);
check("an active member redeems: 20% of 12000 = 2400 off, delivery fee untouched, total 11100",
  eo.discount_cents === 2400 && eo.total_cents === 11100 && eRow.discount_cents === 2400 && eRow.subtotal_cents === 12000 && eRow.delivery_fee_cents === 1500 && eRow.total_cents === 11100);
check("the order is attached to the member and keeps a permanent snapshot of the coupon",
  eRow.customer_id === cA.id && eRow.coupon_code_snapshot === "ELIG" && eRow.coupon_id === elig.id && eRow.coupon_snapshot.discount_type === "percent" && eRow.coupon_snapshot.discount_value === 20);
const red = await redemption(eo.order_id);
check("a cash order's redemption is 'redeemed' at once, keyed to the member's verified phone",
  red.status === "redeemed" && red.redeemed_at && red.released_at === null && red.phone_e164 === "+972522000001" && red.customer_id === cA.id && red.discount_cents === 2400);
check("a code typed sloppily (lower case, spaces) still matches", (await okC(cB.who, " el ig ")).discount_cents === 2400);
const out = await mc("972522000009", "אורן");
await out.who(`select public.set_marketing_consent(false)`);
check("a member who WITHDREW marketing consent is still eligible (club membership, not consent, decides)", (await okC(out.who, "ELIG")).discount_cents === 2400);
check("a client-sent discount/total/coupon_id is ignored", await (async () => {
  const o = await okC(asAnon, null, { extra: { discount_cents: 99999, total_cents: 1, coupon_id: elig.id } });
  const r = await order(o.order_id);
  return r.discount_cents === 0 && r.total_cents === 13500 && r.coupon_id === null;
})());
check("an order without a coupon is unchanged (discount 0, total = subtotal + fee)", (await okC(cC.who, null)).discount_cents === 0);
check("staff can see the coupon and the reduced total on the order they handle",
  (await asStaff(`select coupon_code_snapshot c, discount_cents d, total_cents t from public.orders where id='${eo.order_id}'`)).rows[0].t === 11100);

console.log("\nCoupons: rules");
const tryC = async (opts, who = cA.who) => { const c = await mkCoupon(opts); return placeC(who, c.code); };
const day = 86400e3;
check("disabled coupon", refused(await tryC({ is_active: false }), "COUPON_DISABLED"));
check("not started yet", refused(await tryC({ starts_at: new Date(Date.now() + day).toISOString() }), "COUPON_NOT_STARTED"));
check("expired", refused(await tryC({ ends_at: new Date(Date.now() - 1000).toISOString() }), "COUPON_EXPIRED"));
const minR = await tryC({ min_subtotal_cents: 20000 });
check("minimum order: refused with the amount", refused(minR, "COUPON_MIN_ORDER: 20000"), minR.error);
const arch = await mkCoupon({}); await su(`update public.coupons set archived_at = now() where id=$1`, [arch.id]);
check("archived coupon behaves as unknown", refused(await placeC(cA.who, arch.code), "COUPON_INVALID"));
check("a window that is open now works", (await tryC({ starts_at: new Date(Date.now() - day).toISOString(), ends_at: new Date(Date.now() + day).toISOString() })).ok);
const cap = await mkCoupon({ discount_value: 50, max_discount_cents: 1000 });
check("percent coupon respects the maximum discount (50% of 12000 capped at 1000)", (await okC(cA.who, cap.code)).discount_cents === 1000);
const fixBig = await mkCoupon({ discount_type: "fixed", discount_value: 500000 });
const fb = await okC(cA.who, fixBig.code);
check("fixed coupon larger than the subtotal is clamped: discount 12000, total = delivery fee 1500", fb.discount_cents === 12000 && fb.total_cents === 1500);
const fix = await mkCoupon({ discount_type: "fixed", discount_value: 1000 });
check("fixed coupon: 1000 off", (await okC(cA.who, fix.code)).discount_cents === 1000);
const free = await mkCoupon({ discount_type: "free_delivery", discount_value: null });
const fo = await okC(cA.who, free.code);
const foRow = await order(fo.order_id);
check("free delivery: discount equals the fee, the order still records the fee that was waived, total = subtotal",
  fo.discount_cents === 1500 && fo.total_cents === 12000 && foRow.delivery_fee_cents === 1500 && foRow.discount_cents === 1500);
await su(`update public.business_settings set delivery_fee_cents = 0 where id = 1`);
check("free delivery with a 0 fee gives no benefit and is refused (a use is never burned for nothing)", refused(await placeC(cA.who, free.code), "COUPON_NO_BENEFIT"));
await su(`update public.business_settings set delivery_fee_cents = 1500 where id = 1`);
const stack = await mkCoupon({});
const so = await okC(cA.who, stack.code, { items: [{ product_id: "903", option: "unit", quantity: 1 }] });
check("a coupon applies on top of an item already on sale (80 -> 20% of 8000 = 1600)", so.discount_cents === 1600);
check("BELOW_MINIMUM_ORDER still looks at the subtotal before the discount", await (async () => {
  await su(`update public.business_settings set min_order_cents = 12000 where id = 1`);
  const ok = (await placeC(cA.who, elig.code)).ok;
  const below = refused(await placeC(cA.who, elig.code, { items: [{ product_id: "902", option: "unit", quantity: 1 }] }), "BELOW_MINIMUM_ORDER");
  await su(`update public.business_settings set min_order_cents = 0 where id = 1`);
  return ok && below;
})());

console.log("\nCoupons: independent usage limits");
const pm1 = await mkCoupon({ max_per_member: 1 });
const a1 = await okC(cA.who, pm1.code);
check("per-member limit 1: the same member is refused the second time", refused(await placeC(cA.who, pm1.code), "COUPON_ALREADY_USED"));
check("...but another member can still use it (no total limit)", (await placeC(cB.who, pm1.code)).ok && (await placeC(cC.who, pm1.code)).ok);
const pm3 = await mkCoupon({ max_per_member: 3 });
for (let i = 0; i < 3; i++) await okC(cA.who, pm3.code);
check("per-member limit 3 (not hard-coded to 1): three uses, the fourth is refused", refused(await placeC(cA.who, pm3.code), "COUPON_ALREADY_USED"));
const tot2 = await mkCoupon({ max_total_redemptions: 2 });
const t1 = await okC(cA.who, tot2.code); const t2 = await okC(cB.who, tot2.code);
check("total limit 2 (no per-member limit): the third customer is refused COUPON_EXHAUSTED", refused(await placeC(cC.who, tot2.code), "COUPON_EXHAUSTED"));
check("with no per-member limit the same member may use it until the total runs out", (await placeC(cA.who, tot2.code)).error?.startsWith("COUPON_EXHAUSTED") === true);
const both = await mkCoupon({ max_total_redemptions: 100, max_per_member: 1 });
check("both limits together (100 total, 1 per member): second use by one member refused, others fine",
  (await placeC(cA.who, both.code)).ok && refused(await placeC(cA.who, both.code), "COUPON_ALREADY_USED") && (await placeC(cB.who, both.code)).ok);

console.log("\nCoupons: first order only");
const fst = await mkCoupon({ code: "WELCOME25", first_order_only: true });
const cF = await mc("972522000005", "פנינה");
const f1 = await okC(cF.who, "WELCOME25");
check("a member with no earlier order can use a first-order coupon", f1.discount_cents === 2400);
check("...but not on a second order (any live earlier order counts)", refused(await placeC(cF.who, "WELCOME25"), "COUPON_FIRST_ORDER_ONLY"));
const guestFirst = await okC(asAnon, null, { cust: { ...customer, phone: "052-200-0007" } });
const cG = await mc("972522000007", "גלית");
check("a guest order placed earlier with the same phone counts (the join claimed it)", (await order(guestFirst.order_id)).customer_id === cG.id
  && refused(await placeC(cG.who, "WELCOME25"), "COUPON_FIRST_ORDER_ONLY"));
await su(`select set_config('request.jwt.claim.sub','',false)`);
await tr(asStaff, f1.order_id, "confirmed", "cancelled", "בדיקה");
check("a cancelled earlier order does not count", (await placeC(cF.who, "WELCOME25")).ok);

console.log("\nCoupons: cancelling gives the use back, history is kept");
const canc = await mkCoupon({ max_total_redemptions: 1 });
const c1 = await okC(cA.who, canc.code);
check("the only use is taken", refused(await placeC(cB.who, canc.code), "COUPON_EXHAUSTED"));
const st0 = await stock();
const c1t = await tr(asStaff, c1.order_id, "confirmed", "cancelled", "ביטול");
const r1 = await redemption(c1.order_id);
check("cancelled before dispatch: released with the reason, history kept (redeemed_at and released_at both set)",
  c1t.ok && r1.status === "released" && r1.released_reason === "order_cancelled_before_dispatch" && r1.redeemed_at && r1.released_at && r1.reserved_at);
const c2 = await okC(cB.who, canc.code);
check("the quota came back: another member can now use the coupon", c2.discount_cents === 2400);
for (const [a, b] of [["confirmed", "preparing"], ["preparing", "out_for_delivery"]]) await tr(asStaff, c2.order_id, a, b);
await tr(asStaff, c2.order_id, "out_for_delivery", "cancelled", "אף אחד לא פתח");
check("cancelled after dispatch: released with its own reason", (await redemption(c2.order_id)).released_reason === "order_cancelled_after_dispatch");
check("the cancelled order keeps its discount and snapshot (history is not rewritten)", (await order(c2.order_id)).discount_cents === 2400 && (await order(c2.order_id)).coupon_code_snapshot === canc.code);
check("cancelling again does not double anything", (await tr(asStaff, c2.order_id, "out_for_delivery", "cancelled", "x")).ok && (await su(`select count(*)::int n from public.coupon_redemptions where order_id=$1`, [c2.order_id]))[0].n === 1);
check("the owner reopening a completed order and cancelling it also releases", await (async () => {
  const k = await mkCoupon({ max_total_redemptions: 1 });
  const o = await okC(cA.who, k.code);
  for (const [a, b] of [["confirmed", "preparing"], ["preparing", "out_for_delivery"], ["out_for_delivery", "completed"]]) await tr(asStaff, o.order_id, a, b);
  await tr(asOwner, o.order_id, "completed", "out_for_delivery");
  await tr(asStaff, o.order_id, "out_for_delivery", "cancelled", "בדיקה");
  return (await redemption(o.order_id)).status === "released" && (await placeC(cB.who, k.code)).ok;
})());

console.log("\nCoupons: card orders (reserve -> redeem / release)");
const cardC = await mkCoupon({ max_total_redemptions: 1 });
const stockR = async () => (await su(`select stock_reserved_units s from public.products where id='901'`))[0].s;
const reservedBefore = await stockR();
const k1 = await okC(cA.who, cardC.code, { method: "card", items: [{ product_id: "901", option: "unit", quantity: 1 }, ...ITEMS] });
const k1r = await redemption(k1.order_id);
check("a card order RESERVES the coupon use; the payment attempt is for the discounted total",
  k1.order_status === "pending" && k1r.status === "reserved" && k1r.redeemed_at === null && k1.discount_cents === 4400 && k1.total_cents === 22000 + 1500 - 4400
  && Number((await su(`select amount_cents from public.payment_attempts where order_id=$1`, [k1.order_id]))[0].amount_cents) === k1.total_cents, JSON.stringify([k1, k1r]));
check("a live reservation holds the quota (second member refused)", refused(await placeC(cB.who, cardC.code, { method: "card" }), "COUPON_EXHAUSTED"));
await su(`update public.orders set reserved_until = now() - interval '1 minute' where id=$1`, [k1.order_id]);
const k2 = await okC(cB.who, cardC.code, { method: "card" });
check("an abandoned hold (past reserved_until, sweep not run) no longer holds the quota", k2.order_status === "pending");
await su(`select public.release_expired_order($1)`, [k1.order_id]);
const k1x = await redemption(k1.order_id);
check("the expiry sweep releases it: expired order, redemption released 'reservation_expired', stock reservation back",
  (await order(k1.order_id)).order_status === "expired" && k1x.status === "released" && k1x.released_reason === "reservation_expired" && (await stockR()) === reservedBefore);
await su(`select set_config('request.jwt.claim.sub','',false)`);
const attempt = async (orderId) => (await su(`select id from public.payment_attempts where order_id=$1`, [orderId]))[0].id;
await su(`select public.confirm_payment($1::uuid, 'evt-k2', 'failed')`, [await attempt(k2.order_id)]);
check("a failed payment releases the reservation ('payment_failed')", (await redemption(k2.order_id)).status === "released" && (await redemption(k2.order_id)).released_reason === "payment_failed");
const k3 = await okC(cC.who, cardC.code, { method: "card" });
await su(`select public.confirm_payment($1::uuid, 'evt-k3', 'succeeded')`, [await attempt(k3.order_id)]);
check("a successful payment redeems it and confirms the order", (await redemption(k3.order_id)).status === "redeemed" && (await order(k3.order_id)).order_status === "confirmed");
await su(`select public.confirm_payment($1::uuid, 'evt-k1', 'succeeded')`, [await attempt(k1.order_id)]);
const k1late = await redemption(k1.order_id);
check("a LATE paid webhook for an expired order is honored (the customer really paid the discounted amount) and the release history stays",
  k1late.status === "redeemed" && k1late.released_reason === "reservation_expired" && (await order(k1.order_id)).payment_status === "paid");
check("a repeated webhook changes nothing", (await su(`select public.confirm_payment($1::uuid, 'evt-k1', 'succeeded') as r`, [await attempt(k1.order_id)]))[0].r.already_processed === true);

console.log("\nCoupons: retries and races");
const idem = await mkCoupon({ max_per_member: 1 });
const key = randomUUID();
const i1 = await okC(cA.who, idem.code, { key }), i2 = await okC(cA.who, idem.code, { key });
check("a retried request (same idempotency key) returns the SAME order with its discount and creates no second redemption",
  i1.order_id === i2.order_id && i2.discount_cents === i1.discount_cents && i1.discount_cents > 0
  && (await su(`select count(*)::int n from public.coupon_redemptions where coupon_id=$1`, [idem.id]))[0].n === 1);
check("one redemption per order is enforced by the database", !(await db.query(`insert into public.coupon_redemptions (coupon_id, order_id, phone_e164, discount_cents, status) values ($1,$2,'+972500000000',5,'reserved')`, [idem.id, i1.order_id]).then(() => true, () => false)));
check("the orders table cannot be made inconsistent (coupon without snapshot / discount without coupon)",
  !(await db.query(`update public.orders set coupon_id = null where id=$1`, [i1.order_id]).then(() => true, () => false))
  && !(await db.query(`update public.orders set discount_cents = 5 where id=$1`, [guestFirst.order_id]).then(() => true, () => false)));

console.log("\nCoupons: per-member limit follows the verified PHONE (not the account id)");
const phoneC = await mkCoupon({ max_per_member: 1 });
const cX = await mc("972522000011", "אילן");
const x1 = await okC(cX.who, phoneC.code);
await su(`delete from public.customers where id=$1`, [cX.id]);
const xr = await redemption(x1.order_id);
check("deleting the customer row keeps the ledger (customer_id nulled, phone kept)", xr.customer_id === null && xr.phone_e164 === "+972522000011");
const cY = await mc("972522000011", "אילן שוב");
check("a brand-new account with the same phone is still counted: COUPON_ALREADY_USED", refused(await placeC(cY.who, phoneC.code), "COUPON_ALREADY_USED"));
check("a coupon with redemptions cannot be deleted (history stays trustworthy)", !(await db.query(`delete from public.coupons where id=$1`, [phoneC.id]).then(() => true, () => false)));

console.log("\nCoupons: the owner's table access, locks and audit trail");
const ownIns = await asOwner(`insert into public.coupons (code,title,discount_type,discount_value) values ('OWNER1','בעלים','percent',10) returning id`);
check("the owner can create a coupon through the table API", ownIns.ok, ownIns.error);
for (const [who, name] of [[asStaff, "staff"], [asPlain, "a plain user"], [cA.who, "a club member"], [asAnon, "anon"]]) {
  const rd = await who(`select 1 from public.coupons`), rr = await who(`select 1 from public.coupon_redemptions`), re = await who(`select 1 from public.coupon_events`);
  const wr = await who(`insert into public.coupons (code,title,discount_type,discount_value) values ('HACK1','x','percent',99)`);
  const att = await who(`select 1 from public.coupon_attempts`);
  check(`${name} cannot read coupons / redemptions / events, cannot create or read attempts`,
    (!rd.ok || rd.rows.length === 0) && (!rr.ok || rr.rows.length === 0) && (!re.ok || re.rows.length === 0) && !wr.ok && !att.ok, JSON.stringify({ rd: rd.rows?.length, rr: rr.rows?.length, wr: wr.error }));
}
check("the owner reads redemptions and events but cannot write or delete them or delete a coupon",
  (await asOwner(`select 1 from public.coupon_redemptions`)).rows.length > 5 && (await asOwner(`select 1 from public.coupon_events`)).rows.length > 0
  && !(await asOwner(`update public.coupon_redemptions set status='released' where true`)).ok
  && !(await asOwner(`delete from public.coupon_events`)).ok && !(await asOwner(`delete from public.coupons where code='OWNER1'`)).ok);
const badInserts = [["lower-case code", `'abc','x','percent',10`], ["too short", `'AB','x','percent',10`], ["Hebrew in the code", `'קוד123','x','percent',10`],
  ["percent above 100", `'BAD1','x','percent',101`], ["percent below 1", `'BAD2','x','percent',0`], ["free delivery with a value", `'BAD3','x','free_delivery',5`],
  ["fixed without a value", `'BAD4','x','fixed',null`], ["blank title", `'BAD5',' ','percent',10`]];
for (const [name, vals] of badInserts) check(`the database rejects: ${name}`, !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value) values (${vals})`)).ok);
check("the database rejects: duplicate code, cap on a fixed coupon, zero limits, start after end",
  !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value) values ('ELIG','x','percent',5)`)).ok
  && !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value,max_discount_cents) values ('BAD6','x','fixed',100,100)`)).ok
  && !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value,max_total_redemptions) values ('BAD7','x','percent',5,0)`)).ok
  && !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value,max_per_member) values ('BAD8','x','percent',5,0)`)).ok
  && !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value,starts_at,ends_at) values ('BAD9','x','percent',5, now() + interval '2 days', now() + interval '1 day')`)).ok);
check("the code can never be edited", /CODE_LOCKED/.test((await asOwner(`update public.coupons set code='ELIG2' where code='ELIG'`)).error ?? ""));
check("after the first redemption the discount type/value are locked, but limits/dates/active/title still editable",
  /COUPON_LOCKED/.test((await asOwner(`update public.coupons set discount_value=50 where code='ELIG'`)).error ?? "")
  && /COUPON_LOCKED/.test((await asOwner(`update public.coupons set discount_type='fixed', discount_value=100 where code='ELIG'`)).error ?? "")
  && (await asOwner(`update public.coupons set max_per_member=5, title='כותרת חדשה' where code='ELIG' returning 1`)).rows.length === 1);
check("before any redemption the value is still editable", (await asOwner(`update public.coupons set discount_value=15 where code='OWNER1' returning 1`)).rows.length === 1);
await asOwner(`update public.coupons set is_active=false where code='OWNER1'`);
await asOwner(`update public.coupons set is_active=true where code='OWNER1'`);
await asOwner(`update public.coupons set archived_at=now() where code='OWNER1'`);
const evs = await su(`select kind, actor_label, changes from public.coupon_events where code='OWNER1' order by id`);
check("audit trail: created / updated / disabled / enabled / archived, each with who and before-after",
  evs.map((e) => e.kind).join() === "created,updated,disabled,enabled,archived" && evs.every((e) => e.actor_label === "owner@x.test")
  && evs[1].changes.discount_value.from === 10 && evs[1].changes.discount_value.to === 15);
check("an archived code stays reserved (cannot be re-created)", !(await asOwner(`insert into public.coupon_events (coupon_id, code, kind, actor_label) values (gen_random_uuid(),'x','created','x')`)).ok
  && !(await asOwner(`insert into public.coupons (code,title,discount_type,discount_value) values ('OWNER1','again','percent',10)`)).ok);

console.log("\nCoupons: preview_coupon (the checkout's apply button)");
const pv = (who, code, sub = 12000) => who(`select public.preview_coupon($1,$2) as p`, [code, sub]);
const pvOk = (await pv(cA.who, "ELIG")).rows[0].p;
check("a member gets a valid preview with the discount (informational): 20% of 12000", pvOk.valid === true && pvOk.discount_cents === 2400 && pvOk.code === "ELIG", JSON.stringify(pvOk));
check("anon cannot call it at all; a non-member gets COUPON_MEMBERS_ONLY (and nothing about the code)",
  !(await pv(asAnon, "ELIG")).ok && (await pv(asPlain, "ELIG")).rows[0].p.reason === "COUPON_MEMBERS_ONLY" && (await pv(asPlain, "NOPE")).rows[0].p.reason === "COUPON_MEMBERS_ONLY");
check("refusals come back as data: unknown, min order (with the amount)",
  (await pv(cA.who, "NOPE")).rows[0].p.reason === "COUPON_INVALID"
  && (await (async () => { const c = await mkCoupon({ min_subtotal_cents: 30000 }); const p = (await pv(cB.who, c.code)).rows[0].p; return p.reason === "COUPON_MIN_ORDER" && p.min_subtotal_cents === 30000; })()));
check("a preview never creates a redemption", await (async () => { const n0 = (await su(`select count(*)::int n from public.coupon_redemptions`))[0].n; await pv(cA.who, "ELIG"); return (await su(`select count(*)::int n from public.coupon_redemptions`))[0].n === n0; })());
const cT = await mc("972522000020", "טל");
for (let i = 0; i < 10; i++) await pv(cT.who, `GUESS${i}`);
check("guessing is throttled: after 10 wrong codes even the right one is refused for a while",
  (await pv(cT.who, "ELIG")).rows[0].p.reason === "COUPON_TOO_MANY_ATTEMPTS" && (await pv(cA.who, "ELIG")).rows[0].p.valid === true);

console.log("\nCoupons: what customers and the storefront see");
const myOrders = (await cA.who(`select public.get_my_orders(50) as o`)).rows[0].o;
const mineE = myOrders.find((x) => x.id === eo.order_id);
check("get_my_orders shows the discount and the coupon code, and still no internal columns",
  mineE.discount_cents === 2400 && mineE.coupon_code === "ELIG" && mineE.total_cents === 11100 && myOrders.every((x) => !("coupon_id" in x) && !("coupon_snapshot" in x) && !("cancel_reason" in x) && !("customer_id" in x)));
const pubSettings = async () => (await asAnon(`select public.get_business_settings() as s`)).rows[0].s;
check("the public settings carry club_offer_text (null until the owner sets it)", "club_offer_text" in (await pubSettings()) && (await pubSettings()).club_offer_text === null);
check("only the owner sets it; it is plain text up to 120 chars, never empty",
  (await asOwner(`update public.business_settings set club_offer_text='חברי מועדון: 10% הנחה' where id=1 returning 1`)).rows.length === 1
  && (await pubSettings()).club_offer_text === "חברי מועדון: 10% הנחה"
  && ((await asStaff(`update public.business_settings set club_offer_text='x' where id=1 returning 1`)).rows ?? []).length === 0
  && !(await asOwner(`update public.business_settings set club_offer_text='   ' where id=1`)).ok
  && !(await asOwner(`update public.business_settings set club_offer_text='${"א".repeat(121)}' where id=1`)).ok
  && (await asOwner(`update public.business_settings set club_offer_text=null where id=1 returning 1`)).rows.length === 1);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

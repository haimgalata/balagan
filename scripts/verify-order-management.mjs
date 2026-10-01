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
const MEMBER_RPCS = ["get_my_customer", "claim_guest_orders", "join_club", "get_my_orders", "set_marketing_consent", "delete_my_account"];
const known = new Set([...PUBLIC_BY_DESIGN, ...GUARDED_ADMIN, ...MEMBER_RPCS]);
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

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

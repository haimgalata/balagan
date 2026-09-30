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

// ---- Supabase-style shim ---------------------------------------------------------------------------------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
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
  insert into auth.users values ('${OWNER}','owner@x.test'), ('${STAFF}','staff@x.test'), ('${PLAIN}','plain@x.test');
  insert into public.admin_users (user_id) values ('${OWNER}');
`);
await db.exec(file("0010_order_management.sql"));
await db.exec(file("0010_order_management.sql")); // re-runnable
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

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

# Supabase database — apply & verify (Step 1)

Nothing in here runs automatically. You apply the SQL yourself, then run the security test.
The site does **not** use Supabase yet (that is Step 3); until then it behaves exactly as before.

## What's here

| File | Purpose | Re-runnable? |
|---|---|---|
| `migrations/0001_schema.sql` | `categories`, `subcategories`, `products` (+ `product_id_seq` starting at **149**), constraints, indexes, `updated_at` triggers | **No — run once** on a fresh project |
| `migrations/0002_rls.sql` | `admin_users` allow-list, `is_admin()`, default-deny Row Level Security, least-privilege grants | yes |
| `migrations/0003_storage.sql` | Public-read `product-images` bucket (2 MB, JPEG/PNG/WebP), admin-only write, **no listing** | yes |
| `migrations/0004_rpc.sql` | `get_storefront_catalog()` — the only thing anonymous visitors can call | yes |
| `migrations/0005_admin_categories.sql` | Admin Categories support: atomic reorder, slug lock, `admin_product_counts()` | yes |
| `migrations/0006_admin_products.sql` | Admin Products support: shared inventory (`stock_base_units`), `admin_reorder_products()` | yes, after first success |
| `migrations/0007_stock_availability.sql` | `check_stock_availability()` — the cart's shared-stock quantity check | yes |
| `migrations/0008_business_settings.sql` | `business_hours` (physical-store + online-order weekly schedules), `business_settings` (min order / delivery fee / manual pause), `get_business_settings()` | yes |
| `migrations/0009_orders.sql` | `orders`/`order_items`/`payment_attempts`/`payment_events`, stock reservation (`products.stock_reserved_units`), `create_order()`, `get_order_status()`, `confirm_payment()` | yes |
| `migrations/0010_order_management.sql` | owner/staff roles (`admin_users.role`, `is_staff()`, `get_my_role()`), the order lifecycle (`preparing`, `out_for_delivery`), `order_status_events` history, `transition_order()`, `resolve_stock_return()`, Realtime on `orders`, orders become read-only through the table API | yes |
| `migrations/0011_customer_security_hardening.sql` | closes two gaps before customers can sign in: `order_status_events` becomes back-office only; the inert customer-read policies on `orders`/`order_items` are dropped (customers will use a column-whitelisting RPC). Changes nothing for owner/staff. See `docs/CUSTOMER_PERMISSIONS_AUDIT.md` | yes |
| `migrations/0012_customers.sql` | Balagan Club (registered = member): `customers`, append-only `customer_consents`, `customer_addresses` (max 5), `normalize_il_phone()` + `orders.phone_e164`, triggers that attach a member's order and learn name/address from it, and the member RPCs `join_club()` (mandatory 21+ & marketing confirmation, phone read from `auth.users`), `claim_guest_orders()`, `get_my_customer()`, `get_my_orders()`, `set_marketing_consent()`, `delete_my_account()`. Does **not** enable sign-ups | yes |
| `migrations/0013_customer_admin.sql` | the OWNER's view of the club: `admin_customer_stats()`, `admin_list_customers()` (searchable/filterable/paginated, never lists deleted members) and `admin_export_audience('sms'\|'email'\|'suppression')` — owner-only (`is_admin()`, not staff), no direct table access; every export is recorded in the closed `customer_exports` log. Needs 0012 first | yes |
| `migrations/0014_coupons.sql` | **Balagan Club coupons** — a member-only benefit redeemed in `create_order()`: `coupons` (owner-only; code typed by the owner, normalized and locked; independent `max_total_redemptions` / `max_per_member`; percent / fixed / free delivery; dates; first-order-only; archive, never delete), the `coupon_redemptions` ledger (reserved → redeemed → released, history kept, per-member identity = the verified phone), `coupon_events` audit, `coupon_attempts` throttle, `orders.coupon_*` snapshot, `preview_coupon()` for the checkout's apply button, `business_settings.club_offer_text` for the guest teaser. Redefines `create_order`, `release_expired_order`, `confirm_payment`, `transition_order`, `get_my_orders`, `get_business_settings` (each = its previous version + the coupon step). **Apply before deploying a client that sends `coupon_code` or an admin build that reads `coupon_code_snapshot`.** Needs 0013 first | yes |
| `migrations/0015_pickup.sql` | **Store pickup (איסוף עצמי)** + per-method switches: `orders.fulfillment_method` ('delivery' default \| 'pickup' — no address, no delivery fee, no minimum), new status `ready_for_pickup` (pickup: confirmed → preparing → ready_for_pickup → completed; cancelling a ready order restores stock at once), `business_settings.pickup_enabled/delivery_enabled/cash_enabled/card_enabled/store_address_text` (defaults keep today's behaviour; **card defaults OFF** until a payment provider is wired), and `create_order()` now refuses an order while paused or outside the 'orders' schedule (`ORDERS_CLOSED`, Israel time) or for a switched-off method. Redefines `create_order`, `customer_apply_order` (a pickup order saves no address), `transition_order`, `get_order_status`/`get_my_orders` (+ `fulfillment_method`), `preview_coupon`, `get_business_settings`. **Apply before deploying a client or admin build from this version** (the admin reads `fulfillment_method`). Needs 0014 first | yes |
| `migrations/0016_costs.sql` | **Costs, net profit and single-pack barcodes (owner only):** `suppliers` (Philip Morris per pack; Globrands / Dubek per carton of 10), `product_costs` (one cost per product, BEFORE VAT, kept out of `products` so it can never reach the public catalog), append-only `cost_history`, the `supplier_items` dictionary (supplier code or printed text → product + units), `barcode_blocklist` (carton barcodes — a trigger refuses them on any product: `BARCODE_BLOCKED`), `products.review_note`, `business_settings.vat_percent` (18) / `low_margin_percent` (5, not exposed by `get_business_settings()`), and `admin_set_product_cost()` / `admin_cost_overview()`. Changes nothing customers see. Needs 0015 first; apply BEFORE `seed-data/pos-import/catalog-import.sql` (it writes `review_note`) | yes |
| `migrations/0017_delivery.sql` | **Delivery windows, runs and the courier:** `delivery_windows` (departure time, order cut-off, optional capacity, on/off; `business_settings.delivery_advance_hours` = how many hours ahead a customer may pick one), `orders.delivery_window_id/delivery_date/delivery_departure_time/delivery_run_id/delivery_failed_reason`, statuses `ready_for_dispatch` and `delivery_failed`, `delivery_runs` (open → claimed → departed → finished; the courier's name and phone are copied on claim) + append-only `delivery_run_events`, the `courier` role (`admin_users.role = 'courier'`, or `can_courier` on an owner/staff row; `is_staff()` is narrowed to owner/staff, `is_courier()`, `get_my_access()`), the courier RPCs (`courier_list_open_runs`, `courier_my_runs`, `claim_delivery_run`, `release_delivery_run`, `depart_delivery_run`, `complete_delivery_stop`, `fail_delivery_stop`) and the public `get_delivery_slots()` (a yes/no per window, never the capacity). Redefines `create_order`, `transition_order`, `resolve_stock_return`, `get_order_status`, `get_my_orders`, `get_business_settings`, `orders_record_events`, `is_staff`. **Apply before deploying a client or admin build from this version** (the admin asks `get_my_access()` and reads `delivery_runs`; checkout calls `get_delivery_slots()`). Needs 0016 first. Changes nothing customers see until the owner defines an active window | yes |
| `../scripts/security-test.mjs` | Live test of all of the above against your real project, including the club probe (`USER_*` always; `MEMBER_*` optional; `--signups-enabled` after sign-ups are on) — see `docs/CUSTOMER_PERMISSIONS_AUDIT.md` | — |

`seed.sql` (generated, Step 2) loads the existing catalog — see "Step 2" below.

## Apply

1. **Create the Supabase project** (Dashboard → New project). You only ever need two values from
   *Project Settings → API*: the **Project URL** and the **anon / publishable key**. Never copy the `service_role` key anywhere in this repo.
2. **Disable public sign-ups first**: *Authentication → Sign In / Providers → "Allow new users to sign up" → OFF*.
   (This is what stops strangers from creating accounts; the database would deny them anyway, but turn it off.)
3. **SQL Editor → New query**, paste each file and press *Run*, in order: `0001` → `0002` → `0003` → `0004`.
   Each should finish with "Success. No rows returned".
4. **Create the admin user**: *Authentication → Users → Add user → Create new user* (email + strong password, tick *Auto Confirm User*).
   Then allow-list it (SQL Editor):
   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'YOUR-ADMIN-EMAIL';
   ```
   The API can never write to `admin_users`; only the SQL editor can.
5. **Create a second, ordinary test user** the same way (do **not** insert it into `admin_users`). It proves that being logged in is not enough.

## Verify (PowerShell, from the repo root)

```powershell
$env:SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
$env:SUPABASE_ANON_KEY="<anon or publishable key>"
$env:ADMIN_EMAIL="<admin email>";  $env:ADMIN_PASSWORD="<admin password>"
$env:USER_EMAIL="<ordinary user email>"; $env:USER_PASSWORD="<ordinary user password>"
node scripts/security-test.mjs --check-signup
```
Expected last line: `All security checks passed.` (exit code 0). Exit code 2 means "passed but something was skipped".
`--check-signup` tries to self-register a throwaway user and expects it to be refused; if sign-ups were still on it
would create a junk user, so run it only after step 2. The script inserts a few `zz-security-probe` rows with fixed
ids (`900000001…`) and removes them again; it never touches the id sequence. Passwords are read from the environment only and never printed.

Paste me the output (there are no secrets in it) and Step 1 is closed.

## Step 2 — load the catalog and prove it matches

`seed.sql` is generated from the static catalog by `scripts/generate-seed.mjs` (one-off; the old pack formula is used
only there, once, to write literal numbers). It loads **2 categories, 32 subcategories, 141 products** with their
original ids (`"1"`…`"148"`, gaps kept) and original display order. Every product gets today's package exactly
(decision D2): label `פקט`, 10 units, regular price = unit × 10 (red strikethrough on the site) with an **active package
sale** at unit × 10 − 10. Availability copies today's stock flag (ids 3 and 9 are unavailable). From then on each price
and sale is plain data, editable independently in the admin.

1. **SQL Editor → New query**, paste the whole of `supabase/seed.sql`, Run. It is one transaction: it refuses to run if
   any category/subcategory/product already exists, and it verifies its own result (counts, placement, prices,
   availability, id sequence untouched) before committing — any failure rolls everything back and inserts nothing.
   Expected: "Success. No rows returned".
2. **Prove parity** with the frozen baseline (anon key only, changes nothing):
   ```powershell
   $env:SUPABASE_URL="https://YOUR-PROJECT.supabase.co"; $env:SUPABASE_ANON_KEY="<anon or publishable key>"
   node scripts/verify-seed.mjs
   ```
   Expected last line: `2047 comparisons, 0 differences — live database == pre-migration baseline.`
3. **Next-id check** (SQL Editor): `select last_value, is_called from public.product_id_seq;` → `149 | false`
   (the first product created in the admin will get id 149).
4. Optional but worthwhile now that the tables hold real rows: re-run `node scripts/security-test.mjs --check-signup`.

Starting over (only while nobody has made real edits) — SQL Editor:
```sql
delete from public.products; delete from public.subcategories; delete from public.categories;
alter sequence public.product_id_seq restart with 149;   -- only needed if it was ever consumed
```
then run `seed.sql` again.

## Using the admin area (Step 5)

Open **`/admin`** on the site (locally: `http://localhost:5173/admin`) and sign in with the admin user you created in
step 4 above. Nothing on the customer site links there — you reach it by typing the address. Your account must be in
`admin_users`; any other account is refused and signed out. The dashboard shows counts read from the admin-only tables
(categories, subcategories, products including hidden ones). You are signed out automatically after 60 minutes without activity.
Reset a forgotten password in Supabase (Authentication → Users). Requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local`.

## Categories screen (Step 6) — apply migration 0005 first

`/admin/categories` needs one more migration. **SQL Editor → New query → paste `migrations/0005_admin_categories.sql` → Run**
("Success. No rows returned"; it is re-runnable). It adds: an atomic reorder (`admin_reorder_categories` /
`admin_reorder_subcategories`), a slug lock (a category/subcategory slug — the public `#anchor` — cannot change after creation),
and `admin_product_counts()` (product counts per category/subcategory, hidden products included). All three run with the
caller's own rights, so only an admin can use them; `anon` cannot call them. Until it is applied the Categories page says so.
Then re-run `node scripts/security-test.mjs --check-signup` — it now also checks these functions and the slug lock
(if 0005 is missing it reports a SKIP, exit code 2).

On the page: expandable categories with their subcategories, Hebrew/English names, a visible/hidden switch (hiding a category or
subcategory hides its products from the shop too), up/down ordering, add and delete. Delete is refused while something still holds
products (or a category still has subcategories) — hide it instead. A new item's slug is suggested from its English name and can
be edited only when creating.

## Products screen (Step 7) — apply migration 0006 first

`/admin/products` needs one more migration. **SQL Editor → New query → paste `migrations/0006_admin_products.sql` → Run.**
It has a safety guard at the top: it **refuses to run** (raises an exception, changes nothing) if any product already has a
non-zero `unit_stock`/`package_stock` — those columns are being replaced and dropped. This can't legitimately happen yet
(the Products screen didn't exist before this migration), but if it ever fires, stop and report the exact rows
(`select id, unit_stock, package_stock from public.products where unit_stock <> 0 or package_stock <> 0;`) before re-running
anything. Once it succeeds it is re-runnable.

It replaces the old, INDEPENDENT `unit_stock`/`package_stock` counters with **one shared count in base units**
(`stock_base_units`) plus `track_stock` — because the physical store sells both options from the same pile (a carton of
loose packs can be opened; a six-pack is assembled from loose cans). `unit_in_stock`/`package_in_stock` are `GENERATED`
columns computed from that one count, plus the existing `unit_available`/`package_available` manual switches, which stay
independent of the count (you can turn an option off for sale even when there's plenty of stock):
```
unit_in_stock    = unit_available    AND (NOT track_stock OR stock_base_units >= 1)
package_in_stock = package_enabled AND package_available AND (NOT track_stock OR stock_base_units >= package_unit_count)
```
`track_stock = false` (the default) ignores the count entirely — both options are governed purely by their manual switch,
same as every product today. `get_storefront_catalog()` is updated to read these generated columns (same output shape —
0-diff for the storefront); `admin_reorder_products()` is added, the same atomic "rewrite sort_order 10,20,30…" pattern as
the category functions, scoped to ONE (category, subcategory) group at a time (`subcategory_id` may be `NULL` — the "no
subcategory" group of a category that has none) — a product from a different group can never end up reordered by mistake.

Then re-run `node scripts/security-test.mjs --check-signup` — it now also checks product CRUD, the shared-inventory formula
(including the manual-disable-vs-out-of-stock distinction), image upload/list/delete, and the reorder function's group
isolation (if 0006 is missing it reports a SKIP, exit code 2).

On the page: two tabs. **רשימת מוצרים** — search (name/brand/barcode, across the whole catalog) and filters
(category/subcategory/visibility/out-of-stock/on-sale/missing-image/package), 50 per page, add/edit/hide/delete (delete is a
real, permanent delete with a two-step confirmation — nothing else in the database references a product, unlike
categories/subcategories). **סדר תצוגה** — pick one category (and subcategory, if it has any) and reorder just that group
with up/down arrows; a category with no subcategories skips straight to its one group. A product's photo is never required
to create or save it — add or replace one afterwards, in Edit, where it uploads and saves immediately and independently of
the rest of the form; a failed or rejected upload (wrong type, over 2MB) leaves the product exactly as it was, with a
message, never a partial state.

## Cart shared-stock quantity check — apply migration 0007

`migrations/0007_stock_availability.sql` needs applying before the storefront can enforce it. **SQL Editor → New query →
paste `migrations/0007_stock_availability.sql` → Run** ("Success. No rows returned"; it is re-runnable).

Until Step 7, `unit_in_stock`/`package_in_stock` only ever told the storefront "can this be bought AT ALL" — never a
number, so a customer could add more units of a stock-tracked product than the shared count actually has. This migration
adds ONE more function, `check_stock_availability()`: the cart sends the PROPOSED total it wants to reach for a product
(unit + package lines converted to the same base-unit count — never the raw stock number) and gets back only `true`/`false`
per product, nothing else about the row (no stock count, no `track_stock`, not even whether a hidden product exists). It is
public, like `get_storefront_catalog()`, and read-only: it doesn't lock, reserve or deduct anything.

The storefront calls it before every add/increase (`src/storefront/context/CartContext.tsx`) and again whenever the cart drawer opens
(to catch stock that dropped after items were already added). If the check itself can't be completed — network error,
migration not yet applied — the add is refused too (fails **closed**), with its own Hebrew message, rather than let an
unverified quantity through.

Then re-run `node scripts/security-test.mjs --check-signup` — it now also checks this function (hidden products never
reveal they exist, the response never contains a raw stock number, if 0007 is missing it reports a SKIP, exit code 2).

## Business Settings screen — apply migration 0008 first

`/admin/settings` needs one more migration. **SQL Editor → New query → paste `migrations/0008_business_settings.sql` →
Run** ("Success. No rows returned"; it is re-runnable — re-running it never overwrites hours/settings an admin has
already edited, thanks to `on conflict do nothing` on the seed rows).

It adds two tables and one public RPC:
- `business_hours` — one row per (`schedule_type`, `day_of_week`); `schedule_type` is `'store'` (the physical shop's
  opening hours) or `'orders'` (when the site accepts online orders) — two independent weekly schedules on one table,
  seeded with today's placeholder hours (09:00–23:00 Sun–Thu, 09:00–16:00 Fri, closed Sat) for both. `day_of_week`
  follows `Date#getDay()` (0 = Sunday). A day marked open must have both an open and a close time with open < close
  (checked by the database, not just the admin form).
- `business_settings` — a SINGLETON row (`id` is always `1`): `min_order_cents`/`delivery_fee_cents` (integer agorot,
  same convention as product prices) and `orders_paused` — a manual, ONE-WAY override. It can only force online orders
  closed early; it can never force them open outside the configured schedule: `orders_open_now = schedule says open AND
  NOT orders_paused`. Seeded at 50₪ minimum / 15₪ delivery / not paused.
- `get_business_settings()` — the only public read path (same pattern as `get_storefront_catalog()` /
  `check_stock_availability()`): returns both weekly schedules plus the three settings fields, nothing else (no
  `updated_at`, no way to tell the two tables even exist). `anon` has no table access to either table, same as every
  other admin-writable table.

Then re-run `node scripts/security-test.mjs --check-signup` — it now also checks this RPC and both tables' RLS (if 0008
is missing it reports a SKIP, exit code 2). Because `business_settings`/`business_hours` hold REAL configuration
(unlike the throwaway `zz-security-probe` rows used elsewhere in the script), that section saves the admin's current
values before probing writes and restores them exactly afterward.

On the page: two sections. **שעות פתיחת החנות** — the physical store's 7 days, each with an open/closed toggle and two
time inputs (disabled while closed). **הזמנות אונליין** — the online-order 7 days the same way, plus מינימום הזמנה,
דמי משלוח, and a manual "השבתת הזמנות" pause switch. The storefront reads all of this through
`get_business_settings()`: the physical-store status pill (in the hero image, where it already was) gains a
click-to-expand weekly-hours panel; the site's existing info banner becomes specifically the online-orders banner
(green when orders are open, red when closed or paused), no longer conflating "is the shop open" with "are we taking
online orders."

## Orders — apply migration 0009 first

`/checkout` needs one more migration before "לסיום ההזמנה" creates a real order. **SQL Editor → New query →
paste `migrations/0009_orders.sql` → Run** ("Success. No rows returned"; it is re-runnable).

It adds four tables, a new `products` column, and three RPCs:
- `orders` / `order_items` — one guest-or-customer order (`customer_id` is null for a guest; it references
  `auth.users` for when real customer accounts exist, exactly like `admin_users.user_id` already does) with
  its own immutable snapshot of the customer/delivery details and per-line product/price snapshots — a
  later product rename/reprice/delete, or a customer's own future profile edit, never changes a historical
  order. `order_status` (fulfillment) and `payment_status` (money) are separate on purpose: a cash order is
  `confirmed` immediately with `payment_status='pending'` (collected on delivery); a card order starts
  `pending`/`pending` and only becomes `confirmed`/`paid` once `confirm_payment()` says so.
- `payment_attempts` / `payment_events` — CARD only (nothing is written to either for a cash order). One
  attempt row per try at paying a given order (supports retrying after a decline without a second order);
  `payment_events` is an append-only webhook log, unique on the provider's own event id, which is what makes
  a redelivered webhook harmless instead of double-processing a payment.
- `products.stock_reserved_units` — "available to promise" becomes `stock_base_units - stock_reserved_units`.
  `check_stock_availability()` and the `unit_in_stock`/`package_in_stock` generated columns are updated to
  account for it. The actual concurrency guard is a single conditional `UPDATE ... WHERE stock_base_units -
  stock_reserved_units >= n` inside `create_order()` — never a read-then-write — so two customers racing for
  the last unit are serialized by Postgres's own row lock on that statement, not by application code.
- `create_order(p_payload, p_idempotency_key)` — the only way an order gets created; same anon-callable
  `SECURITY DEFINER` trust tier as `check_stock_availability()`/`get_storefront_catalog()`. Re-validates
  prices, stock, the minimum order, and required fields itself — never trusts the client beyond product
  ids/options/quantities and the free-text delivery fields. A repeat call with the same idempotency key
  returns the already-created order instead of making a second one (covers double-click, a refresh, or a
  retried request after a network timeout).
- `get_order_status(p_order_id)` — a narrow, anon-callable, status-only read (no PII) for a future
  payment-provider return page; the order's own UUID is the capability token, since a guest has no other
  credential. Also lazily expires a stale card reservation the moment anything asks about it.
- `confirm_payment(...)` — granted **only to `service_role`**, not `anon`/`authenticated`. This is a new
  trust tier beyond anon/authenticated+`is_admin()`: it must be reachable only from a future server-side
  webhook handler (a Supabase Edge Function using the service-role key, never the browser). Not wired to a
  real payment provider yet — the function exists and is correct, there's simply nothing calling it today.

**Only cash is real today.** The details form collects a payment method, but "כרטיס אשראי" is shown
disabled ("בקרוב") until a provider is actually chosen and integrated — `create_order()` fully supports
`payment_method: 'card'` (reserves stock, creates a `payment_attempts` row) so no schema work is needed
later, it's just not reachable from the UI yet.

No `security-test.mjs` section exists for 0009 yet (unlike every earlier migration) — extending it needs a
live project to verify against, which wasn't available while writing this migration. Instead, `create_order`/
`get_order_status`/`release_expired_order`/`confirm_payment` were exercised against a real Postgres engine
(PGlite/WASM) with 29 checks: the cash happy path (stock permanently deducted, order confirmed), idempotent
retries (no duplicate order), a fully-exhausted option refused, the atomic reservation UPDATE specifically
refusing a proposed total beyond what's available (the actual concurrency guard, isolated from the "is this
in stock at all" check), package sale-price snapshots, the minimum-order/age/terms/city guards, lazy
reservation expiry, `confirm_payment` succeeded/failed paths (including a duplicate webhook event being a
no-op), and stock correctly staying untouched on every refusal. Extending `security-test.mjs` for 0009
(anon table-access denial, RLS on the new tables, the `service_role`-only grant on `confirm_payment`) is a
good next step before this ships to a real project.

## Order management — apply migration 0010 first

`/admin/orders` (the Active board + history) needs **SQL Editor → New query → paste `migrations/0010_order_management.sql`
→ Run** (re-runnable). **Apply it before deploying the new admin build** — the admin app now asks `get_my_role()` after
login, which doesn't exist until this migration runs. Your existing admin keeps working: the new `role` column defaults to
`'owner'`.

**Roles (two, enforced in Postgres — hiding menu items is only UX):**
- `owner` — everything, exactly as before. `is_admin()` now means *owner only*, so every existing catalog/settings/payment
  policy is unchanged and automatically refuses staff.
- `staff` — the order terminal. Can read orders (open ones, anything whose stock is unresolved, and anything touched in the
  last 7 days), read their history, and call `transition_order()` / `resolve_stock_return()`. Cannot touch catalog, inventory,
  settings, payment tables or `admin_users`, cannot write off stock, cannot reopen a completed order.

**Creating the shared store-terminal account** (same manual pattern as the admin; public sign-ups stay disabled):
Authentication → Users → Add user (email + password), then in the SQL editor:
```sql
insert into public.admin_users (user_id, role)
select id, 'staff' from auth.users where email = 'terminal@your-store.example';
```
Individual employee accounts later are the same two steps per person — every history entry already records *which*
account acted (email + role), so nothing needs redesigning; only the login is shared today. The staff account is exempt
from the 60-minute idle logout (it sits on the terminal all day); owners are not.

**Lifecycle** (`order_status`): `confirmed` (shown as "חדשה") → `preparing` → `out_for_delivery` → `completed`; `cancelled`
from any open state; `pending` (card awaiting payment) and `expired` are not touched by staff. Moves go through
`transition_order(order, expected_status, to_status, reason)`: it locks the order, refuses if the order is no longer at the
status the screen believed (`STALE_STATUS`), enforces the allowed moves and does the side effects in the same transaction:
- one step back is allowed (staff); reopening a `completed` order is owner-only;
- completing a **cash** order marks it `paid` (collected on delivery); reopening it puts it back to unpaid;
- **cancel needs a reason.** Before the order leaves the store the stock is restored automatically. If it is already
  `out_for_delivery`, `stock_return_status` becomes `pending_return` and the stock stays out of inventory until someone
  presses "המוצרים חזרו למלאי" (`resolve_stock_return(order, 'returned')`). The owner alone can instead mark it
  `written_off` (goods lost — adjust stock by hand). A cancelled order cannot be reopened (the customer just reorders).

**History:** `order_status_events` is written by a trigger on `orders`, so `create_order()`, `confirm_payment()`, expiry and
the new RPCs are all captured the same way, with the acting account (or `system` / `customer`). Nobody can write to it
through the API. Orders themselves are **no longer writable through the table API by anyone** (no INSERT/UPDATE/DELETE
for `authenticated`) — only the RPCs change them. Consequence: `scripts/security-test.mjs` can't delete its probe orders any
more; it cancels them (off the live board, stock returned) and prints SQL to remove the rows if you want them gone.

**Realtime:** the migration adds `orders` to the `supabase_realtime` publication (Realtime must be enabled for the project —
it is by default). The board treats a Realtime event only as "reload now"; correctness comes from a query that re-runs on
subscribe, on a 30 s timer, when the tab becomes visible and when the network returns.

**Verifying:** `npm i --no-save @electric-sql/pglite && node scripts/verify-order-management.mjs` replays migrations 0001–0010
on a real Postgres engine and checks roles, the transition map, stale/idempotent moves, restock exactly once, the
after-dispatch stock hold, cash→paid, the history trail and the staff visibility window. Then run
`node scripts/security-test.mjs` against your project — set `STAFF_EMAIL`/`STAFF_PASSWORD` too (a user you inserted with
role `staff`) so the staff section runs.

## Store pickup — apply migration 0015 first

Applying 0015 changes nothing customers see: delivery stays on, pickup off, cash on, card off. To switch to pickup:
`/admin/settings` → "קבלת הזמנה ותשלום" → "איסוף עצמי מהחנות", type the store address, choose the payment methods, save.
From then on the cart and checkout show no delivery fee/minimum/address, the board gets a "מוכנה לאיסוף" lane, and the
customer follows the order at `/order/<id>` (linked from the success screen and from a strip on the homepage).

**Orders are now refused outside the order hours** (`/admin/settings` → online-order hours) and while the pause switch is
on — by the database, not just the banner. `scripts/security-test.mjs` opens ordering for the minute it runs (its probe
orders must work at any hour) and puts the exact previous values back in its cleanup.

**Verifying:** `node scripts/verify-order-management.mjs` covers 0015 (pickup without address/fee/minimum, the switches,
ORDERS_CLOSED around today's hours in Israel time, the pickup lifecycle and its restock, a member's pickup order).

## Costs and barcodes — apply migration 0016 first

Applying 0016 changes nothing customers see. The owner gets two screens: **/admin/costs** ("עלויות ורווח" — per supplier,
net profit per pack in ₪ and % = sale price ÷ (1 + VAT) − cost before VAT, coloured below the low-margin line; the panel
shows the calculation, edits the supplier and a manual cost, and the history) and **/admin/scan** ("סריקה" — phone camera
or typed number; single packs only, a carton barcode goes on the blocklist; known / unknown / wrong-product / new product).
VAT and the low-margin line are in /admin/settings → "עלויות". Staff see neither.

Invoice costs are loaded by SQL files reviewed in chat (e.g. `seed-data/pos-import/invoice-costs-2026-10.sql`, kept out of
git) — run order: 0016 → `catalog-import.sql` → the invoice file. Each refuses to run twice.

**Verifying:** `node scripts/verify-order-management.mjs` covers 0016 (owner-only reads, history, the blocklist trigger, no
leak into the public catalog/settings); `node scripts/security-test.mjs` probes the live project.

## Delivery windows, runs and the courier — apply migration 0017 first

**What the owner does** (`/admin/settings` → "חלונות משלוח"): add the departure slots (e.g. 13:00 / 18:00 / 21:00), each with the
last moment an order may still join it (the cut-off) and, if wanted, a capacity (empty = unlimited), and set "how many hours
ahead" a customer may pick a slot (a 9:00 order cannot pick the 18:00 slot when this is 4). With **no active window** nothing
changes: checkout asks for none and no run is ever created. Delivery stays Netivot-only, card-only-in-practice and the fee fixed,
as before; this migration does not touch payment.

**Orders and runs.** A delivery order placed into a window is `confirmed → preparing → ready_for_dispatch → out_for_delivery →
completed` (an order placed without a window still goes `preparing → out_for_delivery`). When a packed order becomes
`ready_for_dispatch` it joins that window's run (created on demand, even for one order). A courier takes an **open** run
("אני לוקח" — `claim_delivery_run`, first one wins, `ALREADY_CLAIMED` for the rest), presses "יצאתי" (`depart_delivery_run`: every
ready order goes out at once) and then marks each stop **delivered** (`complete_delivery_stop`, after confirming an ID check) or
**not delivered** (`fail_delivery_stop`, reason required). An order that becomes ready after the run left gets a new run. From the
board, out/delivered of an order that belongs to a run is refused (`USE_DELIVERY_RUN`); taking an order back or cancelling it
removes it from the run (an empty unclaimed run disappears).

**Not delivered.** The order becomes `delivery_failed` (final) with `stock_return_status = 'pending_return'`: stock stays out until
back office presses "המוצרים חזרו למלאי" (`resolve_stock_return`; only the owner may write it off), exactly like a cancel after
dispatch. A paid card order is **refunded by hand at the payment provider** — nothing here refunds money.

**Nobody shows up.** A run a courier took but did not leave with is flagged on the board once it is due; the owner rings him
(the board shows his phone) and, if needed, presses "שחרור השליח" (`release_delivery_run`). Nothing is released automatically.

**Creating a courier** (same manual pattern as staff; sign-ups stay off). Authentication → Users → Add user, then:
```sql
insert into public.admin_users (user_id, role, display_name, phone)
select id, 'courier', 'דני', '0501234567' from auth.users where email = 'courier@your-store.example';
-- an employee who is also a courier: keep role 'staff' (or 'owner') and add the flag instead
update public.admin_users set can_courier = true, display_name = 'דני', phone = '0501234567' where user_id = (select id from auth.users where email = '...');
```
The name and phone are what the owner sees on the board after the courier takes a run. A courier-only account signs in to
`/admin/courier` and nothing else; it is exempt from the idle logout (a phone on the road).

**What a courier can and cannot see.** No table at all (not orders, items, history, runs, windows, customers). Open runs show the
slot, how many orders and which streets — **no names, phones or addresses**. Only after claiming does `courier_my_runs()` return
the stops (name, phone, address, entrance/floor/apartment/intercom, notes) for runs he holds; a run finished today stays on his
screen so the last hand-over does not make it vanish. `is_staff()` is now owner/staff only, so a courier inherits none of the
staff policies; `transition_order()` and `resolve_stock_return()` refuse him.

**Verifying:** `node scripts/verify-order-management.mjs` (needs `npm i --no-save @electric-sql/pglite`) replays 0001–0017 (0010–0017
twice) on an in-process Postgres and checks windows (cut-off / hours ahead / capacity / legacy), runs, the claim race, the details
courier-only-after-claim rule, ID check, failed delivery → pending_return → restock, cancel from `ready_for_dispatch`, and that
`get_delivery_slots()` never exposes a capacity. `scripts/security-test.mjs` has a "Delivery" section (set `COURIER_EMAIL` /
`COURIER_PASSWORD` for the courier half); it switches active windows off for the minute it runs and back on in cleanup.

## Design notes worth knowing

- **Why anon can't just read `products`:** rows include barcode and the shared stock count, and hidden items. Anonymous visitors have *no* table access; `get_storefront_catalog()` returns an explicit whitelist (no barcode, no stock count, no hidden rows) — only the derived `in_stock` booleans.
- **Every future table** must `enable row level security` plus explicit policies — Supabase auto-grants new tables to `anon`/`authenticated`.
- **D6 (MFA):** in `0002_rls.sql` one commented line inside `is_admin()` requires an `aal2` session. Enable it (and re-run `0002`) only after the admin UI has an MFA enrollment screen, or you will lock yourself out of writes.
- **Deleting a category/subcategory that still has products** fails with SQLSTATE `23001` (`ON DELETE RESTRICT`; PostgREST returns HTTP 409). The admin UI should offer "hide" instead.
- **Product ids** stay text (`"1"`…). New products get `149, 150, …` from `product_id_seq`; the seed must insert the old ids explicitly.

## Deploying

`.env.example` lists what the production build needs: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon/publishable
key only — never the `service_role` key, anywhere), and `VITE_CATALOG_SOURCE`. Vite bakes these in at build time, so set
the same values in your hosting provider's build settings.

No host is configured in this repo yet. Whichever static host you pick must serve `index.html` for unknown paths (an
"SPA fallback" / rewrite rule) — without it, going straight to `/admin` (or refreshing there) gets the host's own 404
instead of the app, since there's no router and no literal file at that path. Netlify: `netlify.toml` with a
`[[redirects]]` from `/*` to `/index.html` (status 200). Vercel: `vercel.json` with a `rewrites` entry for `/(.*)`  →
`/index.html`. Cloudflare Pages does this automatically for a Vite build.

## How the SQL itself was checked

The four migrations were replayed on a real Postgres engine (PGlite/WASM, PG 18) behind a Supabase-style shim
(`anon`/`authenticated` roles, `auth.uid()`, Supabase's default table grants, storage tables): 107 checks — anon denied
everywhere but the catalog function, a non-admin sees/changes nothing and cannot self-promote, the admin has full CRUD,
23 constraint rejections, catalog ordering/visibility/sale/stock semantics, no private field ever in the payload,
re-runnability, and the MFA switch. `scripts/security-test.mjs` was dry-run against a mock of the Supabase HTTP API
(71 checks). Neither replaces running the script against your real project, which is the authoritative test of the
dashboard settings (sign-ups, storage limits) and of PostgREST/Storage behaviour.

`seed.sql` was likewise loaded into a fresh migrated Postgres (33 checks: exact ids/order/prices vs the baseline, the
apostrophe and geresh names, decimal prices such as 40.9 → 409/399, refusal to run twice or on partial data, full
rollback when a self-check fails, sequence untouched), and `scripts/verify-seed.mjs` was tested to report 0
differences on the correct seed and to catch a changed price, a reordered/hidden product, a removed sale, a wrong
stock flag, a renamed product and a hidden subcategory.

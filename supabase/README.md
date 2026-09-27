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
| `../scripts/security-test.mjs` | Live test of all of the above against your real project | — |

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

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

## Design notes worth knowing

- **Why anon can't just read `products`:** rows include barcode and stock counters, and hidden items. Anonymous visitors have *no* table access; `get_storefront_catalog()` returns an explicit whitelist (no barcode, no stock counts, no hidden rows).
- **Every future table** must `enable row level security` plus explicit policies — Supabase auto-grants new tables to `anon`/`authenticated`.
- **D6 (MFA):** in `0002_rls.sql` one commented line inside `is_admin()` requires an `aal2` session. Enable it (and re-run `0002`) only after the admin UI has an MFA enrollment screen, or you will lock yourself out of writes.
- **Deleting a category/subcategory that still has products** fails with SQLSTATE `23001` (`ON DELETE RESTRICT`; PostgREST returns HTTP 409). The admin UI should offer "hide" instead.
- **Product ids** stay text (`"1"`…). New products get `149, 150, …` from `product_id_seq`; the seed must insert the old ids explicitly.

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

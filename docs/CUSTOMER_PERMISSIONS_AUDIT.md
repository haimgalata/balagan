# Customer permissions audit (gate before public sign-ups)

**Status:** database side done and verified in-process (PGlite). **Public sign-ups stay OFF** until the real-project
check at the bottom has been run and the owner has reviewed this page.

## Why
Today `authenticated` effectively means "back-office user". Phone login for club members makes it mean "any member".
Authorization never depended on being logged in (it is the `admin_users` allow-list via `is_admin()`/`is_staff()`),
but every policy, grant and function reachable as `authenticated` had to be re-read with a customer in mind.

## What was checked (migrations 0001–0010)
| Surface | Result |
|---|---|
| Tables `categories`, `subcategories`, `products`, `business_hours`, `business_settings`, `payment_attempts`, `payment_events` | All `for all to authenticated` policies gated on `is_admin()` (owner). Customer: 0 rows, no writes. OK |
| `admin_users` | Select-own-row only, no write policy. A customer has no row → sees nothing. OK |
| `orders`, `order_items` writes | `authenticated` has no INSERT/UPDATE/DELETE since 0010. OK |
| `orders` / `order_items` reads | Owner/staff policies OK. **Finding 2:** inert `*_customer_select_own` policies would expose internal columns. Fixed in 0011 |
| `order_status_events` | **Finding 1:** visible to anyone who can read the order → would leak `actor_label`/`actor_id` (staff e-mails) and internal reasons to customers. Fixed in 0011 |
| Storage `product-images` | Insert/update/delete/select policies all `is_admin()`. Public read is by URL only (no list). OK |
| SECURITY DEFINER functions executable by `authenticated` | `transition_order`, `resolve_stock_return` check `get_my_role()`; `expire_stale_orders` checks `is_admin()`; `is_admin`/`is_staff`/`get_my_role` reveal only the caller's own status; `release_expired_order`, `confirm_payment`, trigger functions are revoked. OK |
| SECURITY INVOKER admin functions (`admin_reorder_*`, `admin_product_counts`) | Protected by the RLS above; a customer's call fails / returns nothing. OK |
| Public-by-design RPCs (`get_storefront_catalog`, `get_business_settings`, `check_stock_availability`, `create_order`, `get_order_status`) | Unchanged; whitelisted outputs, no PII (`get_order_status` takes the order uuid as a capability). OK |
| Realtime on `orders` | Streams rows the subscriber's RLS allows; with Finding 2 fixed a customer receives nothing. OK |
| Sequences | `product_id_seq` usage is granted to `authenticated` but sequences are not reachable through the API. Note only |

## Decision recorded
Customers will read their own orders **only** through a column-whitelisting RPC (`get_my_orders()`, migration 0012),
never through the table API — the same pattern as the public catalog. This replaces the earlier plan to reuse the
`orders_customer_select_own` policy.

## Migration 0012 (club data layer) — what a member can and cannot do
Verified by the same script (≈60 extra checks): a member reads/edits only their own profile (name, e-mail — not phone, terms
or `deleted_at`), addresses and consent history; cannot insert/delete customers or write consents through the API (only the
RPCs do); sees orders only via `get_my_orders()` (no cancel reason, stock state, idempotency key or actor data); owner and staff
have **no** customer-table access yet (an owner screen comes later through its own reviewed policy). The member phone is read
from `auth.users.phone`, never from a payload; a client-sent `customer_id` on `create_order` is ignored (set by trigger).

## Migration 0013 (owner's customer tools) — owner only, audited
The owner reads customer data only through three SECURITY DEFINER functions (`admin_customer_stats`, `admin_list_customers`,
`admin_export_audience`), each re-checking `is_admin()` — **staff, plain logged-in users, club members and anon are all refused**
(tested). Their two helpers (`customer_marketing_state`, `customers_filtered`) are not callable through the API. The
`customer_exports` log is closed to the API entirely (RLS on, no policy, no grants). Search text is matched as plain text
(LIKE wildcards escaped); lists never include deleted members; an audience contains only members whose LATEST consent covers
the channel. The reviewed-function list in the verify script now includes the three functions, so a new one cannot appear unnoticed.

## Guard against regressions
`scripts/verify-order-management.mjs` now (a) gives a customer an order and asserts they see no order/item/event rows,
(b) sweeps **every table in `public`** as a plain logged-in user (reads 0 rows, no writes), and (c) lists every
function `authenticated` can execute and **fails if a function appears that is not on the reviewed list**, so a future
migration cannot silently expose something to members. Without 0011 the script reports 7 failures; with it, all pass.

## Remaining before sign-ups are enabled
1. Apply `0011_customer_security_hardening.sql` then `0012_customers.sql` to the live project (SQL Editor; both re-runnable; neither enables sign-ups).
2. Extend `scripts/security-test.mjs` with a plain logged-in probe user (HTTP-level equivalent of the sweep above) and
   replace the `--check-signup` expectation; run it against the live project. *(not done yet)*
3. Update `supabase/README.md` step 2 ("sign-ups OFF") only at the moment sign-ups are turned on.
4. Rate limits / captcha plan for SMS before a real provider is connected.

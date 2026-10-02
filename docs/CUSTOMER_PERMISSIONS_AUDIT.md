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

## Migration 0014 (coupons) — member-only, decided by the database
- Eligibility = an ACTIVE club member (`customers` row, not soft-deleted, `id = auth.uid()`), evaluated inside `create_order()` at order time. Marketing consent is not consulted (withdrawing it keeps the membership and the benefit). A guest, a verified-but-not-joined login, a deleted member and an owner/staff token all get `COUPON_MEMBERS_ONLY` — and they get it BEFORE the code is even looked up, so a non-member cannot probe which codes exist.
- Tables `coupons`, `coupon_redemptions`, `coupon_events`: owner-only (`is_admin()`), staff/members/anon read nothing; `coupon_attempts`: closed (no grant, no policy). No DELETE grant on `coupons` — a coupon is archived. Redemptions are written only by the order functions (SECURITY DEFINER); the owner cannot edit or delete them. The code is immutable; type/value lock after the first redemption.
- New functions executable by `authenticated`: `preview_coupon()` (guards itself; revoked from anon; informational only — never grants anything) and `normalize_coupon_code()` (pure; must stay executable because the `coupons_code_format` CHECK runs it with the caller's privileges). Both are on the reviewed list in `scripts/verify-order-management.mjs`. The internal helpers (`coupon_active_member`, `coupon_evaluate`, `release_coupon_for_order`, `redeem_coupon_for_order`, the triggers) are revoked from every API role.
- The client never sends an amount: `create_order` takes only `coupon_code`, locks the coupon row (`FOR UPDATE`) and prices it itself; the order stores `discount_cents` plus a snapshot of the coupon as applied. A coupon refusal rolls the whole order back, stock included.
- Known limitation: the failed-guess throttle lives in `preview_coupon()`; a refusal inside `create_order()` rolls its transaction back and so cannot leave a counter row behind. Guessing through `create_order` is bounded by needing a complete, valid order payload per try — use non-guessable codes for valuable coupons.
- Verified in-process (PGlite, `scripts/verify-order-management.mjs`, "Coupons: …" sections): the eligibility matrix, every refusal token, both limits independently, first-order-only, release on cancel / expiry / failed payment with history kept, unswept card holds not counting, late payment honored, idempotent retry, phone-keyed per-member limit surviving account deletion, locks, audit trail, the preview throttle, the `get_my_orders` whitelist.

## Guard against regressions
`scripts/verify-order-management.mjs` now (a) gives a customer an order and asserts they see no order/item/event rows,
(b) sweeps **every table in `public`** as a plain logged-in user (reads 0 rows, no writes), and (c) lists every
function `authenticated` can execute and **fails if a function appears that is not on the reviewed list**, so a future
migration cannot silently expose something to members. Without 0011 the script reports 7 failures; with it, all pass.

## The live probe (scripts/security-test.mjs, "Club" section)
HTTP-level equivalent of the sweep above, run against the real project with the anon key plus test-account passwords:
- **Always (needs `USER_EMAIL`/`USER_PASSWORD`: an ordinary non-admin user, no phone, never joined):** every club/order table is
  closed to them, nothing can be written (not even self-made membership), `join_club()` needs both mandatory confirmations
  (and a truthy string is not "true"), anon cannot call any member function, the owner's customer functions refuse anon / an
  ordinary user / staff, the internal helpers are unreachable even for the owner, and the owner has no direct table access
  to customer data. Without `USER_*` this group is reported as SKIPPED (exit 2), never as passed.
- **Optional (`MEMBER_EMAIL`/`MEMBER_PASSWORD`: a dedicated test user with a verified mobile number on `auth.users`):** a real
  member's lifecycle — join (the phone comes from the login, not the request), an order attached by the database, the
  whitelisted order history, safe-column edits only, isolation from another user and from the owner, consent withdrawal
  and re-grant visible in the owner's numbers, and finally `delete_my_account()` (the test user is cleaned up again).
- **`--signups-enabled` (after sign-ups are switched on):** a self-registered stranger has no power at all.
Failure messages never echo response bodies (a live response could hold real customer data). The probe's own logic was
verified against a PostgREST-style emulator over the real migrations (99 checks pass; without `0011` it fails exactly the three
"member reads orders/items/events through the table API" checks).

## Remaining before sign-ups are enabled
1. ~~Apply `0011`, `0012`, `0013` to the live project~~ — **done** (owner, in order; the existing live tests passed afterwards).
2. ~~Write the live customer probe~~ — **done** (section above). **Run it against the live project and get it green** (with at
   least `USER_*`; `MEMBER_*` is recommended).
3. Real SMS/OTP provider (one adapter + one loader branch), a **rate-limit / captcha plan for SMS sending** (once sign-ups
   are open anyone can trigger paid messages), terms + privacy pages, and legal review of the consent wording.
4. Only then enable public sign-ups; then update `supabase/README.md` step 2 ("sign-ups OFF") and run
   `node scripts/security-test.mjs --signups-enabled` (+ the normal run) once more, followed by a final end-to-end test
   with a real phone.

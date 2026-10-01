-- =============================================================================
-- 0011_customer_security_hardening.sql — close two gaps BEFORE customers can sign in
-- =============================================================================
-- Run after 0010. Re-runnable. Safe to apply on its own (changes nothing for owner/staff).
--
-- Why: until now `authenticated` meant "back-office user" in practice (public sign-ups are OFF and every policy
-- is gated on is_admin()/is_staff()). Phone login for club members will make `authenticated` mean "any member",
-- so every policy that read as "any logged-in user who can see the order" has to be re-checked. Audit result
-- (see docs/CUSTOMER_PERMISSIONS_AUDIT.md): everything else is already owner/staff gated; two things are not.
--
--   1. order_status_events_select
--        "can read the event if they can read the order" — fine while only staff could read orders. Once a
--        customer can read their own order it would also hand them actor_label / actor_id (staff e-mail
--        addresses) and the internal reasons. -> back-office only.
--
--   2. orders_customer_select_own / order_items_customer_select_own  (0009, inert until now)
--        A row policy cannot hide columns, so a customer reading their own order through the table API (or a
--        Realtime postgres_changes subscription, which streams the same row) would also receive internal
--        columns: cancel_reason (a staff note), stock_return_status, idempotency_key, payment internals.
--        -> dropped. Customers will read their orders ONLY through a column-whitelisting RPC
--        (get_my_orders(), next migration), the same pattern the storefront already uses for the catalog.
--        Nothing in the app used these policies (customer_id is always null today).
-- =============================================================================

-- ---------- 1. status events: back-office only ----------------------------------------------------
drop policy if exists order_status_events_select on public.order_status_events;
create policy order_status_events_select on public.order_status_events
  for select to authenticated
  using (
    (select public.is_staff())
    -- Same visibility as the order itself (owner: all; staff: open + last 7 days). The subquery runs under
    -- the caller's own RLS on orders.
    and exists (select 1 from public.orders o where o.id = order_status_events.order_id)
  );

-- ---------- 2. no direct customer reads of orders / items ------------------------------------------
drop policy if exists orders_customer_select_own      on public.orders;
drop policy if exists order_items_customer_select_own on public.order_items;

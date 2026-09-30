-- =============================================================================
-- 0010_order_management.sql — staff/owner roles, order lifecycle, status history, audited transitions
-- =============================================================================
-- Run after 0009. Re-runnable.
--
-- What this adds (see supabase/README.md "Order management" for the full design):
--
--   1. Roles.       admin_users gets a `role` ('owner' | 'staff', default 'owner' so the existing admin is
--                    untouched). is_admin() now means OWNER ONLY (same name, so every existing catalog/settings/
--                    payment policy keeps working and automatically denies staff). New is_staff() = any
--                    back-office user; get_my_role() tells the UI which one the caller is (UI only — the
--                    database enforces everything).
--   2. Lifecycle.   order_status gains `preparing` and `out_for_delivery`:
--                      confirmed (UI: new) -> preparing -> out_for_delivery -> completed   (+ cancelled from any)
--                    plus per-order timestamps and a stock-return state for orders cancelled after dispatch.
--   3. History.     order_status_events — append-only log of every status / payment / stock-return change,
--                    written by a TRIGGER on orders, so create_order(), confirm_payment(), expiry and the new
--                    RPCs are all captured uniformly, with the acting user (or 'system').
--   4. Transitions. transition_order() is the ONLY way an order's status changes from the client. It locks the
--                    row, checks the caller's expected status (two devices can't silently overwrite each
--                    other), enforces the allowed-transition map + role rules, and performs the side effects
--                    (restock on cancel, cash marked paid on completion) in the same transaction.
--                    resolve_stock_return() settles a cancelled-after-dispatch order once the goods are back.
--   5. Security.    Direct INSERT/UPDATE/DELETE on orders/order_items is REVOKED from `authenticated`
--                    (previously an admin could rewrite or delete an order with no history and no stock effect).
--                    Owners read everything; staff read active orders, anything unresolved-stock, and anything
--                    touched in the last 7 days. Realtime is enabled for orders (RLS still filters events).
-- =============================================================================

-- ---------- 1. roles ------------------------------------------------------------
alter table public.admin_users add column if not exists role text not null default 'owner';
alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check check (role in ('owner', 'staff'));

-- Owner only. (0002 carries the same definition so re-running 0002 later can never widen it.)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.user_id = (select auth.uid())
      and au.role = 'owner'
    -- and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Any back-office user: owner or staff.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au where au.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- 'owner' | 'staff' | null. Drives what the admin UI shows; never what is allowed.
create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select au.role from public.admin_users au where au.user_id = (select auth.uid());
$$;
revoke all on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated;

-- ---------- 2. order lifecycle columns -----------------------------------------
alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (order_status in ('pending', 'confirmed', 'preparing', 'out_for_delivery', 'expired', 'cancelled', 'completed'));

alter table public.orders add column if not exists status_changed_at timestamptz;
update public.orders set status_changed_at = coalesce(confirmed_at, created_at) where status_changed_at is null;
alter table public.orders alter column status_changed_at set default now();
alter table public.orders alter column status_changed_at set not null;

alter table public.orders add column if not exists completed_at  timestamptz;
alter table public.orders add column if not exists cancelled_at  timestamptz;
alter table public.orders add column if not exists cancel_reason text;

-- Only meaningful for a cancelled order:
--   'none'            — not cancelled (or nothing to give back)
--   'restored'        — stock was returned to inventory (automatically, if cancelled before leaving the store)
--   'pending_return'  — cancelled while out for delivery: stock is NOT returned until someone confirms the
--                       goods are physically back (resolve_stock_return)
--   'written_off'     — the goods did not come back; nothing was restocked (owner decision)
alter table public.orders add column if not exists stock_return_status text not null default 'none';
alter table public.orders drop constraint if exists orders_stock_return_status_check;
alter table public.orders add constraint orders_stock_return_status_check
  check (stock_return_status in ('none', 'restored', 'pending_return', 'written_off'));

alter table public.orders drop constraint if exists orders_cancel_reason_present;
alter table public.orders add constraint orders_cancel_reason_present
  check (order_status <> 'cancelled' or nullif(btrim(coalesce(cancel_reason, '')), '') is not null) not valid;

-- Digits-only phone, so a staff search for "0501234567" finds "050-123-4567".
alter table public.orders add column if not exists phone_digits text
  generated always as (regexp_replace(phone, '[^0-9]', '', 'g')) stored;

create index if not exists orders_active_idx on public.orders (created_at)
  where order_status in ('confirmed', 'preparing', 'out_for_delivery');
create index if not exists orders_created_at_idx on public.orders (created_at desc, id desc);
create index if not exists orders_status_changed_idx on public.orders (status_changed_at desc);
create index if not exists orders_phone_digits_idx on public.orders (phone_digits);
create index if not exists orders_stock_return_pending_idx on public.orders (created_at)
  where stock_return_status = 'pending_return';

-- Any status change stamps status_changed_at, whichever code path made it.
create or replace function public.orders_stamp_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.order_status is distinct from old.order_status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.orders_stamp_status_change() from public, anon, authenticated;

drop trigger if exists orders_stamp_status_change on public.orders;
create trigger orders_stamp_status_change before update on public.orders
  for each row execute function public.orders_stamp_status_change();

-- ---------- 3. status history ---------------------------------------------------
create table if not exists public.order_status_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  kind         text not null check (kind in ('created', 'status', 'payment', 'stock_return')),
  from_value   text,
  to_value     text not null,
  reason       text,
  -- No FK on purpose: removing an employee's login must not erase or null out who did what.
  actor_id     uuid,
  actor_label  text not null,   -- the actor's email at the time, or 'system' / 'customer'
  actor_role   text,            -- 'owner' | 'staff' | null
  created_at   timestamptz not null default now()
);
create index if not exists order_status_events_order_idx on public.order_status_events (order_id, created_at, id);

create or replace function public.orders_record_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_label text;
  v_role  text;
begin
  if v_uid is not null then
    select coalesce(u.email, v_uid::text), au.role
      into v_label, v_role
      from auth.users u
      left join public.admin_users au on au.user_id = u.id
      where u.id = v_uid;
  end if;

  if tg_op = 'INSERT' then
    insert into public.order_status_events (order_id, kind, to_value, actor_id, actor_label, actor_role)
    values (new.id, 'created', new.order_status, v_uid, coalesce(v_label, 'customer'), v_role);
    return new;
  end if;

  v_label := coalesce(v_label, 'system');

  if new.order_status is distinct from old.order_status then
    insert into public.order_status_events (order_id, kind, from_value, to_value, reason, actor_id, actor_label, actor_role)
    values (new.id, 'status', old.order_status, new.order_status,
            case when new.order_status = 'cancelled' then new.cancel_reason end, v_uid, v_label, v_role);
  end if;
  if new.payment_status is distinct from old.payment_status then
    insert into public.order_status_events (order_id, kind, from_value, to_value, actor_id, actor_label, actor_role)
    values (new.id, 'payment', old.payment_status, new.payment_status, v_uid, v_label, v_role);
  end if;
  if new.stock_return_status is distinct from old.stock_return_status then
    insert into public.order_status_events (order_id, kind, from_value, to_value, actor_id, actor_label, actor_role)
    values (new.id, 'stock_return', old.stock_return_status, new.stock_return_status, v_uid, v_label, v_role);
  end if;
  return new;
end;
$$;
revoke all on function public.orders_record_events() from public, anon, authenticated;

drop trigger if exists orders_record_events on public.orders;
create trigger orders_record_events after insert or update on public.orders
  for each row execute function public.orders_record_events();

-- Orders that pre-date this migration get a 'created' event so every order has a timeline start.
insert into public.order_status_events (order_id, kind, to_value, actor_label, created_at)
select o.id, 'created', case when o.payment_method = 'cash' then 'confirmed' else 'pending' end, 'customer', o.created_at
from public.orders o
where not exists (select 1 from public.order_status_events e where e.order_id = o.id);

-- ---------- 4. privileges + RLS -------------------------------------------------
revoke all on table public.order_status_events from public, anon, authenticated;
grant select on table public.order_status_events to authenticated;
alter table public.order_status_events enable row level security;

-- From here on the client can only READ orders/order_items; every change is an RPC.
revoke insert, update, delete, truncate, references, trigger on table public.orders      from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.order_items from authenticated;
revoke usage, select on sequence public.order_number_seq from authenticated;

drop policy if exists orders_admin_all on public.orders;

drop policy if exists orders_owner_select on public.orders;
create policy orders_owner_select on public.orders
  for select to authenticated
  using ((select public.is_admin()));

-- Staff: everything still open, anything whose goods are still out, and anything touched in the last 7 days
-- (that window is what makes "search by phone / order number" work for a customer calling about today's order).
drop policy if exists orders_staff_select on public.orders;
create policy orders_staff_select on public.orders
  for select to authenticated
  using (
    (select public.is_staff())
    and (
      order_status in ('confirmed', 'preparing', 'out_for_delivery')
      or stock_return_status = 'pending_return'
      or status_changed_at >= now() - interval '7 days'
    )
  );

drop policy if exists order_items_admin_all on public.order_items;
drop policy if exists order_items_staff_select on public.order_items;
-- The subquery runs under the caller's own RLS on orders, so items follow exactly the same visibility.
create policy order_items_staff_select on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id));

drop policy if exists order_status_events_select on public.order_status_events;
create policy order_status_events_select on public.order_status_events
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_status_events.order_id));

-- ---------- 5. Realtime ---------------------------------------------------------
-- Only `orders` (items are immutable after creation and fetched on demand). Realtime evaluates the RLS
-- policies above per subscriber, so a non-back-office session receives nothing.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
     ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end;
$$;

-- ---------- 6. transition_order() ------------------------------------------------
-- Internal: give an order's stock back. Only products that track stock; a deleted product (null id) is skipped.
create or replace function public.restock_order_items(p_order_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products p
     set stock_base_units = p.stock_base_units + i.units
    from (
      select product_id, sum(base_units)::int as units
      from public.order_items
      where order_id = p_order_id and product_id is not null
      group by product_id
    ) i
   where p.id = i.product_id and p.track_stock;
$$;
revoke all on function public.restock_order_items(uuid) from public, anon, authenticated;

-- p_expected_status is what the caller's screen believed the status was. If the order has moved on, nothing
-- changes and STALE_STATUS comes back (unless it is already at the requested status — then it is a no-op).
--   forward   confirmed -> preparing -> out_for_delivery -> completed
--   back      one step (preparing->confirmed, out_for_delivery->preparing); completed->out_for_delivery is OWNER only
--   cancel    from confirmed / preparing / out_for_delivery, reason REQUIRED
--             before dispatch  -> stock restored immediately
--             out_for_delivery -> stock_return_status = 'pending_return' (restored only by resolve_stock_return)
--   completing a CASH order marks it paid (collected on delivery); reopening it puts it back to pending.
create or replace function public.transition_order(
  p_order_id        uuid,
  p_expected_status text,
  p_to_status       text,
  p_reason          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text := public.get_my_role();
  v_order  public.orders;
  v_from   text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_stock  text;
begin
  if v_role is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_to_status not in ('confirmed', 'preparing', 'out_for_delivery', 'completed', 'cancelled') then
    raise exception 'INVALID_STATUS: %', p_to_status;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  v_from := v_order.order_status;

  -- Someone (maybe this same device, retrying) already got it there: harmless no-op.
  if v_from = p_to_status then
    return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
      'order_status', v_from, 'payment_status', v_order.payment_status,
      'stock_return_status', v_order.stock_return_status, 'changed', false);
  end if;
  if v_from is distinct from p_expected_status then
    raise exception 'STALE_STATUS: %', v_from;
  end if;

  if not (
       (v_from = 'confirmed'        and p_to_status in ('preparing', 'cancelled'))
    or (v_from = 'preparing'        and p_to_status in ('out_for_delivery', 'confirmed', 'cancelled'))
    or (v_from = 'out_for_delivery' and p_to_status in ('completed', 'preparing', 'cancelled'))
    or (v_from = 'completed'        and p_to_status = 'out_for_delivery' and v_role = 'owner')
  ) then
    raise exception 'INVALID_TRANSITION: % -> %', v_from, p_to_status;
  end if;

  v_stock := v_order.stock_return_status;
  if p_to_status = 'cancelled' then
    if v_reason is null then
      raise exception 'REASON_REQUIRED';
    end if;
    if v_from = 'out_for_delivery' then
      v_stock := 'pending_return';
    else
      perform public.restock_order_items(v_order.id);
      v_stock := 'restored';
    end if;
  end if;

  update public.orders
     set order_status = p_to_status,
         completed_at = case when p_to_status = 'completed' then now()
                             when v_from = 'completed' then null
                             else completed_at end,
         cancelled_at = case when p_to_status = 'cancelled' then now() else cancelled_at end,
         cancel_reason = case when p_to_status = 'cancelled' then v_reason else cancel_reason end,
         stock_return_status = v_stock,
         payment_status = case
           when p_to_status = 'completed' and payment_method = 'cash' and payment_status = 'pending' then 'paid'
           when v_from = 'completed'      and payment_method = 'cash' and payment_status = 'paid'    then 'pending'
           when p_to_status = 'cancelled' and payment_status = 'pending' then 'cancelled'
           else payment_status end
   where id = v_order.id
  returning * into v_order;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
    'order_status', v_order.order_status, 'payment_status', v_order.payment_status,
    'stock_return_status', v_order.stock_return_status, 'changed', true);
end;
$$;
revoke all on function public.transition_order(uuid, text, text, text) from public, anon;
grant execute on function public.transition_order(uuid, text, text, text) to authenticated;

-- ---------- 7. resolve_stock_return() --------------------------------------------
-- For an order cancelled while out for delivery. 'returned' (staff or owner): the goods are physically back ->
-- restock. 'written_off' (owner only): they are not coming back -> no restock; the owner adjusts stock by hand.
-- Idempotent for a repeat of the same outcome; a different outcome after resolution is refused.
create or replace function public.resolve_stock_return(p_order_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := public.get_my_role();
  v_order public.orders;
  v_target text;
begin
  if v_role is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_outcome not in ('returned', 'written_off') then
    raise exception 'INVALID_OUTCOME: %', p_outcome;
  end if;
  if p_outcome = 'written_off' and v_role <> 'owner' then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  v_target := case when p_outcome = 'returned' then 'restored' else 'written_off' end;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.stock_return_status = v_target then
    return jsonb_build_object('order_id', v_order.id, 'stock_return_status', v_target, 'changed', false);
  end if;
  if v_order.order_status <> 'cancelled' or v_order.stock_return_status <> 'pending_return' then
    raise exception 'STALE_STATUS: %', v_order.stock_return_status;
  end if;

  if p_outcome = 'returned' then
    perform public.restock_order_items(v_order.id);
  end if;
  update public.orders set stock_return_status = v_target where id = v_order.id;

  return jsonb_build_object('order_id', v_order.id, 'stock_return_status', v_target, 'changed', true);
end;
$$;
revoke all on function public.resolve_stock_return(uuid, text) from public, anon;
grant execute on function public.resolve_stock_return(uuid, text) to authenticated;

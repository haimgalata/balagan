-- =============================================================================
-- 0017_delivery.sql — delivery windows, delivery runs and the courier role
-- =============================================================================
-- Run after 0016. Re-runnable. Apply it BEFORE deploying a client that sends `delivery_window_id` or calls
-- get_my_access()/courier_* (create_order keeps working for an old client while NO active window exists).
--
-- Applying it changes NOTHING the customer sees by itself: until the owner defines an active window in
-- /admin/settings, create_order() does not ask for one and no run is ever created.
--
--   delivery_windows            the owner's departure slots (e.g. 13:00 / 18:00 / 21:00): departure_time,
--                               order_cutoff_time (the last moment an order may still join that slot) and an OPTIONAL
--                               capacity (NULL = unlimited). business_settings.delivery_advance_hours = how many hours
--                               ahead of departure a customer may pick a slot (a 9:00 order cannot pick the 18:00 slot).
--   orders                      + delivery_window_id / delivery_date / delivery_departure_time (snapshot) /
--                               delivery_run_id / delivery_failed_reason; new statuses
--                                 ready_for_dispatch   packed, waiting for the courier (delivery only)
--                                 delivery_failed      could not be handed over; stock waits in 'pending_return'
--                               delivery: confirmed -> preparing -> ready_for_dispatch -> out_for_delivery -> completed
--                               (an order WITHOUT a window — legacy — may still go preparing -> out_for_delivery).
--   delivery_runs               one run per (window, date) that has not left yet: open -> claimed (a courier took it)
--                               -> departed -> finished. Orders join the open run when they become ready_for_dispatch;
--                               an order that becomes ready after the run left gets a NEW run. The courier's name and
--                               phone are copied onto the run when it is claimed (the owner dials from the board).
--   delivery_run_events         append-only: who claimed / released / departed / finished.
--   courier role                admin_users.role 'courier', or can_courier = true on an owner/staff row (one person may
--                               hold both jobs). is_staff() is narrowed to owner/staff — a courier is NOT staff.
--                               A courier has no table access at all: only the courier_* RPCs below, and they show
--                               customer details only for runs the courier has claimed.
--   RPCs                        courier_list_open_runs, courier_my_runs, claim_delivery_run, release_delivery_run,
--                               depart_delivery_run, complete_delivery_stop, fail_delivery_stop, get_my_access,
--                               get_delivery_slots (public: a boolean per window, never the capacity).
--   Redefined                   create_order (0015), transition_order (0015), resolve_stock_return (0010),
--                               get_order_status / get_my_orders / get_business_settings (0015),
--                               orders_record_events (0012), is_staff (0010).
--
-- Refunds are NOT handled here: a delivery_failed card order is refunded by hand at the payment provider.
-- =============================================================================

-- ---------- 1. roles -------------------------------------------------------------------------------------
alter table public.admin_users add column if not exists display_name text;
alter table public.admin_users add column if not exists phone        text;
alter table public.admin_users add column if not exists can_courier  boolean not null default false;

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check check (role in ('owner', 'staff', 'courier'));

-- Back-office = owner or staff. (0010's version matched ANY admin_users row; a courier must not inherit that.)
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = (select auth.uid()) and au.role in ('owner', 'staff')
  );
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

create or replace function public.is_courier()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = (select auth.uid()) and (au.role = 'courier' or au.can_courier)
  );
$$;
revoke all on function public.is_courier() from public, anon;
grant execute on function public.is_courier() to authenticated;

-- What the admin UI should offer: {"role": "owner"|"staff"|"courier"|null, "courier": boolean}. UX only.
create or replace function public.get_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role', (select au.role from public.admin_users au where au.user_id = (select auth.uid())),
    'courier', public.is_courier()
  );
$$;
revoke all on function public.get_my_access() from public, anon;
grant execute on function public.get_my_access() to authenticated;

-- ---------- 2. delivery windows --------------------------------------------------------------------------
alter table public.business_settings add column if not exists delivery_advance_hours smallint not null default 4;
alter table public.business_settings drop constraint if exists business_settings_delivery_advance_hours_check;
alter table public.business_settings add constraint business_settings_delivery_advance_hours_check
  check (delivery_advance_hours between 1 and 24);

create table if not exists public.delivery_windows (
  id                 uuid primary key default gen_random_uuid(),
  departure_time     time not null,
  order_cutoff_time  time not null,
  capacity           integer,
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  constraint delivery_windows_cutoff_before_departure check (order_cutoff_time <= departure_time),
  constraint delivery_windows_capacity_positive check (capacity is null or capacity > 0)
);

revoke all on table public.delivery_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.delivery_windows to authenticated;
alter table public.delivery_windows enable row level security;
drop policy if exists delivery_windows_admin_all on public.delivery_windows;
create policy delivery_windows_admin_all on public.delivery_windows
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------- 3. delivery runs -----------------------------------------------------------------------------
create table if not exists public.delivery_runs (
  id             uuid primary key default gen_random_uuid(),
  window_id      uuid not null references public.delivery_windows (id) on delete restrict,
  run_date       date not null,
  status         text not null default 'open' check (status in ('open', 'claimed', 'departed', 'finished')),
  courier_id     uuid,
  courier_name   text,
  courier_phone  text,
  claimed_at     timestamptz,
  departed_at    timestamptz,
  created_at     timestamptz not null default now()
);
-- One run per (window, day) that has not left yet.
create unique index if not exists delivery_runs_live_idx on public.delivery_runs (window_id, run_date)
  where status in ('open', 'claimed');
create index if not exists delivery_runs_courier_idx on public.delivery_runs (courier_id) where status in ('claimed', 'departed');

create table if not exists public.delivery_run_events (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references public.delivery_runs (id) on delete cascade,
  kind        text not null check (kind in ('claimed', 'released', 'departed', 'finished')),
  actor_id    uuid,
  actor_label text not null,
  created_at  timestamptz not null default now()
);
create index if not exists delivery_run_events_run_idx on public.delivery_run_events (run_id, id);

revoke all on table public.delivery_runs, public.delivery_run_events from public, anon, authenticated;
grant select on table public.delivery_runs, public.delivery_run_events to authenticated;
alter table public.delivery_runs enable row level security;
alter table public.delivery_run_events enable row level security;
drop policy if exists delivery_runs_staff_select on public.delivery_runs;
create policy delivery_runs_staff_select on public.delivery_runs
  for select to authenticated using ((select public.is_staff()));
drop policy if exists delivery_run_events_staff_select on public.delivery_run_events;
create policy delivery_run_events_staff_select on public.delivery_run_events
  for select to authenticated using ((select public.is_staff()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'delivery_runs'
     ) then
    alter publication supabase_realtime add table public.delivery_runs;
  end if;
end;
$$;

-- ---------- 4. orders: window / run columns, new statuses ------------------------------------------------
alter table public.orders add column if not exists delivery_window_id       uuid references public.delivery_windows (id) on delete set null;
alter table public.orders add column if not exists delivery_date            date;
alter table public.orders add column if not exists delivery_departure_time  time;
alter table public.orders add column if not exists delivery_run_id          uuid references public.delivery_runs (id) on delete set null;
alter table public.orders add column if not exists delivery_failed_reason   text;
create index if not exists orders_delivery_run_idx on public.orders (delivery_run_id) where delivery_run_id is not null;
create index if not exists orders_delivery_window_idx on public.orders (delivery_window_id, delivery_date) where delivery_window_id is not null;

alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (order_status in ('pending', 'confirmed', 'preparing', 'ready_for_dispatch', 'out_for_delivery', 'ready_for_pickup',
                          'delivery_failed', 'expired', 'cancelled', 'completed'));

drop index if exists public.orders_active_idx;
create index orders_active_idx on public.orders (created_at)
  where order_status in ('confirmed', 'preparing', 'ready_for_dispatch', 'out_for_delivery', 'ready_for_pickup');

drop policy if exists orders_staff_select on public.orders;
create policy orders_staff_select on public.orders
  for select to authenticated
  using (
    (select public.is_staff())
    and (
      order_status in ('confirmed', 'preparing', 'ready_for_dispatch', 'out_for_delivery', 'ready_for_pickup')
      or stock_return_status = 'pending_return'
      or status_changed_at >= now() - interval '7 days'
    )
  );

-- History: a delivery_failed change carries the courier's reason, like a cancel carries its reason.
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
      join public.admin_users au on au.user_id = u.id
      where u.id = v_uid;
  end if;

  if tg_op = 'INSERT' then
    insert into public.order_status_events (order_id, kind, to_value, actor_id, actor_label, actor_role)
    values (new.id, 'created', new.order_status, case when v_label is not null then v_uid end, coalesce(v_label, 'customer'), v_role);
    return new;
  end if;

  v_label := coalesce(v_label, 'system');

  if new.order_status is distinct from old.order_status then
    insert into public.order_status_events (order_id, kind, from_value, to_value, reason, actor_id, actor_label, actor_role)
    values (new.id, 'status', old.order_status, new.order_status,
            case when new.order_status = 'cancelled' then new.cancel_reason
                 when new.order_status = 'delivery_failed' then new.delivery_failed_reason end,
            v_uid, v_label, v_role);
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

-- ---------- 5. window rules (internal) -------------------------------------------------------------------
-- NULL when the window may take another order right now, else 'WINDOW_UNAVAILABLE' | 'WINDOW_FULL'. Israel time.
-- p_lock serialises concurrent orders on a window that has a capacity (create_order passes true).
create or replace function public.delivery_window_check(p_window_id uuid, p_lock boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w       public.delivery_windows;
  v_now     timestamp := now() at time zone 'Asia/Jerusalem';
  v_advance integer;
  v_taken   integer;
begin
  if p_lock then
    select * into v_w from public.delivery_windows where id = p_window_id for update;
  else
    select * into v_w from public.delivery_windows where id = p_window_id;
  end if;
  if not found or not v_w.is_active then
    return 'WINDOW_UNAVAILABLE';
  end if;
  if v_now::time >= v_w.order_cutoff_time then
    return 'WINDOW_UNAVAILABLE';
  end if;
  select s.delivery_advance_hours into v_advance from public.business_settings s where s.id = 1;
  if (v_now::date + v_w.departure_time) - v_now > make_interval(hours => coalesce(v_advance, 4)) then
    return 'WINDOW_UNAVAILABLE';
  end if;
  if v_w.capacity is not null then
    select count(*) into v_taken
      from public.orders o
     where o.delivery_window_id = v_w.id
       and o.delivery_date = v_now::date
       and o.order_status not in ('cancelled', 'expired');
    if v_taken >= v_w.capacity then
      return 'WINDOW_FULL';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.delivery_window_check(uuid, boolean) from public, anon, authenticated;

-- Public: today's active slots with a yes/no. Never the capacity or the number of orders.
create or replace function public.get_delivery_slots()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id,
           'departure_time', w.departure_time,
           'available', public.delivery_window_check(w.id) is null
         ) order by w.departure_time, w.sort_order), '[]'::jsonb)
    from public.delivery_windows w
   where w.is_active;
$$;
revoke all on function public.get_delivery_slots() from public;
grant execute on function public.get_delivery_slots() to anon, authenticated;

-- ---------- 6. run bookkeeping (internal) ----------------------------------------------------------------
create or replace function public.delivery_run_log(p_run_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_label text;
begin
  if v_uid is not null then
    select coalesce(u.email, v_uid::text) into v_label from auth.users u where u.id = v_uid;
  end if;
  insert into public.delivery_run_events (run_id, kind, actor_id, actor_label)
  values (p_run_id, p_kind, v_uid, coalesce(v_label, 'system'));
end;
$$;
revoke all on function public.delivery_run_log(uuid, text) from public, anon, authenticated;

-- A run with nothing left to hand over: an unclaimed one disappears, any other is finished.
create or replace function public.delivery_run_refresh(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
begin
  if p_run_id is null then
    return;
  end if;
  select * into v_run from public.delivery_runs where id = p_run_id for update;
  if not found or v_run.status = 'finished' then
    return;
  end if;
  if exists (select 1 from public.orders o
              where o.delivery_run_id = p_run_id and o.order_status in ('ready_for_dispatch', 'out_for_delivery')) then
    return;
  end if;
  if v_run.status = 'open' then
    delete from public.delivery_runs where id = p_run_id;
  else
    update public.delivery_runs set status = 'finished' where id = p_run_id;
    perform public.delivery_run_log(p_run_id, 'finished');
  end if;
end;
$$;
revoke all on function public.delivery_run_refresh(uuid) from public, anon, authenticated;

-- An order that became ready_for_dispatch joins its window's live run (created on demand).
create or replace function public.delivery_run_attach(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_run   uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.delivery_window_id is null or v_order.delivery_date is null then
    return;
  end if;
  select id into v_run from public.delivery_runs
   where window_id = v_order.delivery_window_id and run_date = v_order.delivery_date and status in ('open', 'claimed')
   for update;
  if v_run is null then
    insert into public.delivery_runs (window_id, run_date)
    values (v_order.delivery_window_id, v_order.delivery_date)
    returning id into v_run;
  end if;
  update public.orders set delivery_run_id = v_run where id = p_order_id;
end;
$$;
revoke all on function public.delivery_run_attach(uuid) from public, anon, authenticated;

-- ---------- 7. create_order(): 0015 + the delivery window ------------------------------------------------
create or replace function public.create_order(p_payload jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing        record;
  v_items           jsonb;
  v_customer        jsonb;
  v_payment_method  text;
  v_fulfillment     text;
  v_settings        record;
  v_subtotal        integer := 0;
  v_delivery_fee    integer;
  v_discount        integer := 0;
  v_total           integer;
  v_order_id        uuid;
  v_order_number    bigint;
  v_order_status    text;
  v_reserved_until  timestamptz;
  v_now             timestamptz := now();
  v_item            jsonb;
  v_product         record;
  v_quantity        integer;
  v_base_units      integer;
  v_unit_price      integer;
  v_regular_price   integer;
  v_option_label    text;
  v_line_total      integer;
  v_updated         integer;
  v_lines           jsonb := '[]'::jsonb;
  v_payment_attempt_id uuid;
  v_coupon_code     text;
  v_coupon          jsonb;
  v_window_id       uuid;
  v_window_time     time;
  v_window_check    text;
begin
  if p_idempotency_key is null then
    raise exception 'MISSING_IDEMPOTENCY_KEY';
  end if;

  -- A retry of an order that already exists always gets its answer back, even if orders closed in between.
  select id, order_number, order_status, payment_status, payment_method, total_cents, discount_cents, fulfillment_method,
         (select pa.id from public.payment_attempts pa where pa.order_id = o.id order by pa.created_at desc limit 1) as payment_attempt_id
    into v_existing
    from public.orders o
    where o.idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'order_id', v_existing.id,
      'order_number', v_existing.order_number,
      'order_status', v_existing.order_status,
      'payment_status', v_existing.payment_status,
      'payment_method', v_existing.payment_method,
      'fulfillment_method', v_existing.fulfillment_method,
      'total_cents', v_existing.total_cents,
      'discount_cents', v_existing.discount_cents,
      'payment_attempt_id', v_existing.payment_attempt_id
    );
  end if;

  v_items := p_payload -> 'items';
  v_customer := p_payload -> 'customer';
  v_payment_method := p_payload ->> 'payment_method';
  v_fulfillment := coalesce(nullif(p_payload ->> 'fulfillment_method', ''), 'delivery');
  v_coupon_code := nullif(btrim(coalesce(p_payload ->> 'coupon_code', '')), '');

  select min_order_cents, delivery_fee_cents, pickup_enabled, delivery_enabled, cash_enabled, card_enabled
    into v_settings
    from public.business_settings where id = 1;

  if v_payment_method not in ('cash', 'card') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;
  if v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'INVALID_FULFILLMENT_METHOD';
  end if;
  if not public.orders_accepting_now() then
    raise exception 'ORDERS_CLOSED';
  end if;
  if (v_fulfillment = 'pickup' and not coalesce(v_settings.pickup_enabled, false))
     or (v_fulfillment = 'delivery' and not coalesce(v_settings.delivery_enabled, true)) then
    raise exception 'FULFILLMENT_UNAVAILABLE';
  end if;
  if (v_payment_method = 'cash' and not coalesce(v_settings.cash_enabled, true))
     or (v_payment_method = 'card' and not coalesce(v_settings.card_enabled, false)) then
    raise exception 'PAYMENT_METHOD_UNAVAILABLE';
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  if coalesce(btrim(v_customer ->> 'first_name'), '') = '' or coalesce(btrim(v_customer ->> 'last_name'), '') = '' then
    raise exception 'MISSING_NAME';
  end if;
  if coalesce(btrim(v_customer ->> 'phone'), '') = '' then
    raise exception 'MISSING_PHONE';
  end if;
  if v_fulfillment = 'delivery' then
    -- Delivery is Netivot-only today (see src/checkout/data/netivotStreets.ts) — enforced here too, not just
    -- in the frontend's locked field, because this RPC must never trust the client alone.
    if coalesce(v_customer ->> 'city', '') is distinct from 'נתיבות' then
      raise exception 'UNSUPPORTED_CITY';
    end if;
    if coalesce(btrim(v_customer ->> 'street'), '') = '' or coalesce(btrim(v_customer ->> 'house_number'), '') = '' then
      raise exception 'MISSING_ADDRESS';
    end if;

    -- Delivery window. Required only once the owner has defined at least one active window (an old client keeps
    -- working until then). Capacity and cut-off are decided here, in Israel time.
    if exists (select 1 from public.delivery_windows w where w.is_active) then
      begin
        v_window_id := nullif(btrim(coalesce(p_payload ->> 'delivery_window_id', '')), '')::uuid;
      exception when others then
        raise exception 'WINDOW_UNAVAILABLE';
      end;
      if v_window_id is null then
        raise exception 'WINDOW_REQUIRED';
      end if;
      v_window_check := public.delivery_window_check(v_window_id, true);
      if v_window_check is not null then
        raise exception '%', v_window_check;
      end if;
      select w.departure_time into v_window_time from public.delivery_windows w where w.id = v_window_id;
    end if;
  end if;
  if (v_customer ->> 'age_confirmed')::boolean is not true then
    raise exception 'AGE_NOT_CONFIRMED';
  end if;
  if (v_customer ->> 'terms_accepted')::boolean is not true then
    raise exception 'TERMS_NOT_ACCEPTED';
  end if;

  for v_item in select * from jsonb_array_elements(v_items)
  loop
    select p.id, p.unit_price, p.unit_sale_enabled, p.unit_sale_price, p.unit_in_stock,
           p.package_enabled, p.package_label, p.package_unit_count, p.package_price,
           p.package_sale_enabled, p.package_sale_price, p.package_in_stock,
           p.track_stock, p.name_he, p.brand
      into v_product
      from public.products p
      join public.categories c on c.id = p.category_id
      left join public.subcategories s on s.id = p.subcategory_id
      where p.id = v_item ->> 'product_id'
        and p.is_visible and c.is_visible and (p.subcategory_id is null or s.is_visible);

    if not found then
      raise exception 'PRODUCT_UNAVAILABLE: %', v_item ->> 'product_id';
    end if;

    v_quantity := greatest((v_item ->> 'quantity')::int, 0);
    if v_quantity = 0 then
      raise exception 'INVALID_QUANTITY: %', v_product.id;
    end if;

    if (v_item ->> 'option') = 'unit' then
      if not v_product.unit_in_stock then
        raise exception 'OUT_OF_STOCK: %', v_product.id;
      end if;
      v_base_units := v_quantity;
      v_regular_price := round(v_product.unit_price * 100)::int;
      v_unit_price := v_regular_price;
      if v_product.unit_sale_enabled and v_product.unit_sale_price is not null and v_product.unit_sale_price < v_product.unit_price then
        v_unit_price := round(v_product.unit_sale_price * 100)::int;
      end if;
      v_option_label := 'יחידה';
    elsif (v_item ->> 'option') = 'package' then
      if not v_product.package_enabled or not v_product.package_in_stock then
        raise exception 'OUT_OF_STOCK: %', v_product.id;
      end if;
      v_base_units := v_product.package_unit_count * v_quantity;
      v_regular_price := round(v_product.package_price * 100)::int;
      v_unit_price := v_regular_price;
      if v_product.package_sale_enabled and v_product.package_sale_price is not null and v_product.package_sale_price < v_product.package_price then
        v_unit_price := round(v_product.package_sale_price * 100)::int;
      end if;
      v_option_label := v_product.package_label;
    else
      raise exception 'INVALID_OPTION: %', v_item ->> 'option';
    end if;

    if v_product.track_stock then
      if v_payment_method = 'cash' then
        update public.products
           set stock_base_units = stock_base_units - v_base_units
         where id = v_product.id
           and stock_base_units - stock_reserved_units >= v_base_units;
      else
        update public.products
           set stock_reserved_units = stock_reserved_units + v_base_units
         where id = v_product.id
           and stock_base_units - stock_reserved_units >= v_base_units;
      end if;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'INSUFFICIENT_STOCK: %', v_product.id;
      end if;
    end if;

    v_line_total := v_unit_price * v_quantity;
    v_subtotal := v_subtotal + v_line_total;

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id,
      'product_name_snapshot', v_product.name_he,
      'product_brand_snapshot', v_product.brand,
      'option', v_item ->> 'option',
      'option_label_snapshot', v_option_label,
      'unit_price_cents', v_unit_price,
      'regular_price_cents', v_regular_price,
      'quantity', v_quantity,
      'base_units', v_base_units,
      'line_total_cents', v_line_total
    );
  end loop;

  -- Pickup: no delivery fee and no minimum order (the minimum exists because of the delivery cost).
  if v_fulfillment = 'pickup' then
    v_delivery_fee := 0;
  else
    v_delivery_fee := coalesce(v_settings.delivery_fee_cents, 0);
    if v_subtotal < coalesce(v_settings.min_order_cents, 0) then
      raise exception 'BELOW_MINIMUM_ORDER';
    end if;
  end if;

  -- Coupon: validated and priced HERE, by the database, for the caller's own identity (auth.uid()). Any refusal
  -- raises a COUPON_* token and rolls back the whole order, stock included. (Free delivery on a pickup order has
  -- no benefit -> COUPON_NO_BENEFIT.)
  if v_coupon_code is not null then
    v_coupon := public.coupon_evaluate(v_coupon_code, v_subtotal, v_delivery_fee, true);
    v_discount := (v_coupon ->> 'discount_cents')::integer;
  end if;
  v_total := v_subtotal + v_delivery_fee - v_discount;

  if v_payment_method = 'cash' then
    v_order_status := 'confirmed';
    v_reserved_until := null;
  else
    v_order_status := 'pending';
    v_reserved_until := v_now + interval '30 minutes';
  end if;

  insert into public.orders (
    idempotency_key, payment_method, fulfillment_method, order_status, payment_status,
    first_name, last_name, phone, email, city, street, house_number,
    entrance, floor, apartment, intercom_code, delivery_notes,
    age_confirmed_at, terms_accepted_at, terms_version,
    subtotal_cents, delivery_fee_cents, discount_cents, total_cents, currency,
    coupon_id, coupon_code_snapshot, coupon_snapshot,
    delivery_window_id, delivery_date, delivery_departure_time,
    reserved_until, confirmed_at
  ) values (
    p_idempotency_key, v_payment_method, v_fulfillment, v_order_status, 'pending',
    btrim(v_customer ->> 'first_name'), btrim(v_customer ->> 'last_name'), btrim(v_customer ->> 'phone'),
    nullif(btrim(v_customer ->> 'email'), ''),
    case when v_fulfillment = 'delivery' then v_customer ->> 'city' end,
    case when v_fulfillment = 'delivery' then v_customer ->> 'street' end,
    case when v_fulfillment = 'delivery' then v_customer ->> 'house_number' end,
    case when v_fulfillment = 'delivery' then nullif(btrim(v_customer ->> 'entrance'), '') end,
    case when v_fulfillment = 'delivery' then nullif(btrim(v_customer ->> 'floor'), '') end,
    case when v_fulfillment = 'delivery' then nullif(btrim(v_customer ->> 'apartment'), '') end,
    case when v_fulfillment = 'delivery' then nullif(btrim(v_customer ->> 'intercom_code'), '') end,
    nullif(btrim(v_customer ->> 'notes'), ''),
    v_now, v_now, 'v1',
    v_subtotal, v_delivery_fee, v_discount, v_total, 'ILS',
    (v_coupon ->> 'coupon_id')::uuid, v_coupon ->> 'code', v_coupon -> 'snapshot',
    v_window_id, case when v_window_id is not null then (v_now at time zone 'Asia/Jerusalem')::date end, v_window_time,
    v_reserved_until, case when v_order_status = 'confirmed' then v_now end
  )
  returning id, order_number into v_order_id, v_order_number;

  insert into public.order_items (
    order_id, product_id, product_name_snapshot, product_brand_snapshot, option, option_label_snapshot,
    unit_price_cents, regular_price_cents, quantity, base_units, line_total_cents
  )
  select
    v_order_id, l ->> 'product_id', l ->> 'product_name_snapshot', l ->> 'product_brand_snapshot',
    l ->> 'option', l ->> 'option_label_snapshot',
    (l ->> 'unit_price_cents')::int, (l ->> 'regular_price_cents')::int, (l ->> 'quantity')::int,
    (l ->> 'base_units')::int, (l ->> 'line_total_cents')::int
  from jsonb_array_elements(v_lines) as l;

  if v_coupon is not null then
    insert into public.coupon_redemptions (coupon_id, order_id, phone_e164, customer_id, discount_cents, status, reserved_at, redeemed_at)
    values ((v_coupon ->> 'coupon_id')::uuid, v_order_id, v_coupon ->> 'phone_e164', (v_coupon ->> 'customer_id')::uuid,
            v_discount, case when v_payment_method = 'cash' then 'redeemed' else 'reserved' end, v_now,
            case when v_payment_method = 'cash' then v_now end);
  end if;

  if v_payment_method = 'card' then
    insert into public.payment_attempts (order_id, amount_cents)
    values (v_order_id, v_total)
    returning id into v_payment_attempt_id;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'order_status', v_order_status,
    'payment_status', 'pending',
    'payment_method', v_payment_method,
    'fulfillment_method', v_fulfillment,
    'total_cents', v_total,
    'discount_cents', v_discount,
    'payment_attempt_id', v_payment_attempt_id
  );
end;
$$;

revoke all on function public.create_order(jsonb, uuid) from public;
grant execute on function public.create_order(jsonb, uuid) to anon, authenticated;

-- ---------- 8. transition_order(): 0015 + ready_for_dispatch and the run guard ---------------------------
--   delivery  confirmed -> preparing -> ready_for_dispatch -> out_for_delivery -> completed
--             an order without a window (legacy) may skip ready_for_dispatch; an order WITH a window may not.
--   out_for_delivery / completed of an order that belongs to a run happen only through the run RPCs
--   (depart_delivery_run, complete_delivery_stop) -> USE_DELIVERY_RUN here. Going back / cancelling is allowed and
--   takes the order out of its run.
--   Cancel: stock is held (pending_return) only once the goods left (out_for_delivery); from ready_for_dispatch the
--   goods are still in the store, so stock is restored at once.
--   The courier role is NOT back-office: v_role must be owner or staff.
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
  v_last   text;   -- the step before completed for this order's method
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_stock  text;
  v_run    uuid;
  v_delivery boolean;
begin
  if v_role is null or v_role not in ('owner', 'staff') then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_to_status not in ('confirmed', 'preparing', 'ready_for_dispatch', 'out_for_delivery', 'ready_for_pickup', 'completed', 'cancelled') then
    raise exception 'INVALID_STATUS: %', p_to_status;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  v_from := v_order.order_status;
  v_delivery := v_order.fulfillment_method <> 'pickup';
  v_last := case when v_delivery then 'out_for_delivery' else 'ready_for_pickup' end;

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
       (v_from = 'confirmed' and p_to_status in ('preparing', 'cancelled'))
    or (v_from = 'preparing' and (
          p_to_status in ('confirmed', 'cancelled')
          or (not v_delivery and p_to_status = 'ready_for_pickup')
          or (v_delivery and p_to_status = 'ready_for_dispatch')
          or (v_delivery and p_to_status = 'out_for_delivery' and v_order.delivery_window_id is null)))
    or (v_from = 'ready_for_dispatch' and v_delivery and p_to_status in ('out_for_delivery', 'preparing', 'cancelled'))
    or (v_from = v_last and p_to_status in ('completed', 'preparing', 'cancelled'))
    or (v_from = 'completed' and p_to_status = v_last and v_role = 'owner')
  ) then
    raise exception 'INVALID_TRANSITION: % -> %', v_from, p_to_status;
  end if;

  if v_order.delivery_run_id is not null
     and ((v_from = 'ready_for_dispatch' and p_to_status = 'out_for_delivery')
          or (v_from = 'out_for_delivery' and p_to_status = 'completed')) then
    raise exception 'USE_DELIVERY_RUN';
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
    -- a genuinely cancelled order gives its coupon use back (the redemption row keeps its history)
    perform public.release_coupon_for_order(
      v_order.id,
      case when v_from = 'out_for_delivery' then 'order_cancelled_after_dispatch' else 'order_cancelled_before_dispatch' end);
  end if;

  v_run := v_order.delivery_run_id;

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
           else payment_status end,
         delivery_run_id = case when p_to_status in ('confirmed', 'preparing', 'cancelled') then null else delivery_run_id end
   where id = v_order.id
  returning * into v_order;

  if p_to_status = 'ready_for_dispatch' then
    perform public.delivery_run_attach(v_order.id);
  elsif v_run is not null and p_to_status in ('confirmed', 'preparing', 'cancelled') then
    perform public.delivery_run_refresh(v_run);
  end if;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
    'order_status', v_order.order_status, 'payment_status', v_order.payment_status,
    'stock_return_status', v_order.stock_return_status, 'changed', true);
end;
$$;
revoke all on function public.transition_order(uuid, text, text, text) from public, anon;
grant execute on function public.transition_order(uuid, text, text, text) to authenticated;

-- ---------- 9. resolve_stock_return(): 0010, also for a delivery that could not be handed over -------------
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
  if v_role is null or v_role not in ('owner', 'staff') then
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
  if v_order.order_status not in ('cancelled', 'delivery_failed') or v_order.stock_return_status <> 'pending_return' then
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

-- ---------- 10. courier RPCs -----------------------------------------------------------------------------
-- Every one of these checks the caller itself. A courier sees customer details ONLY for a run they have claimed.
create or replace function public.delivery_assert_courier()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_courier() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.delivery_assert_courier() from public, anon, authenticated;

-- Open runs a courier may take: no personal data — the slot, how many orders, and which streets.
create or replace function public.courier_list_open_runs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.delivery_assert_courier();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id,
             'run_date', r.run_date,
             'departure_time', w.departure_time,
             'order_count', (select count(*) from public.orders o
                              where o.delivery_run_id = r.id and o.order_status = 'ready_for_dispatch'),
             'streets', (select coalesce(jsonb_agg(distinct o.street), '[]'::jsonb) from public.orders o
                          where o.delivery_run_id = r.id and o.order_status = 'ready_for_dispatch')
           ) order by r.run_date, w.departure_time)
      from public.delivery_runs r
      join public.delivery_windows w on w.id = r.window_id
     where r.status = 'open'
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.courier_list_open_runs() from public, anon;
grant execute on function public.courier_list_open_runs() to authenticated;

-- The courier's own runs (claimed, on the road, or finished today) with the stops, sorted by street then house number.
create or replace function public.courier_my_runs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.delivery_assert_courier();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id,
             'status', r.status,
             'run_date', r.run_date,
             'departure_time', w.departure_time,
             'claimed_at', r.claimed_at,
             'departed_at', r.departed_at,
             'stops', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'order_id', o.id,
                        'order_number', o.order_number,
                        'order_status', o.order_status,
                        'first_name', o.first_name,
                        'last_name', o.last_name,
                        'phone', o.phone,
                        'city', o.city,
                        'street', o.street,
                        'house_number', o.house_number,
                        'entrance', o.entrance,
                        'floor', o.floor,
                        'apartment', o.apartment,
                        'intercom_code', o.intercom_code,
                        'notes', o.delivery_notes,
                        'payment_method', o.payment_method,
                        'payment_status', o.payment_status,
                        'total_cents', o.total_cents,
                        'failed_reason', o.delivery_failed_reason
                      ) order by lower(o.street),
                                 nullif(regexp_replace(coalesce(o.house_number, ''), '\D', '', 'g'), '')::int nulls last,
                                 o.order_number), '[]'::jsonb)
                 from public.orders o
                where o.delivery_run_id = r.id
                  and o.order_status in ('ready_for_dispatch', 'out_for_delivery', 'completed', 'delivery_failed'))
           ) order by r.run_date, w.departure_time)
      from public.delivery_runs r
      join public.delivery_windows w on w.id = r.window_id
     where r.courier_id = (select auth.uid())
       and (r.status in ('claimed', 'departed')
            -- a run finished today stays on screen, so the last hand-over does not make the whole run vanish
            or (r.status = 'finished' and r.run_date = (now() at time zone 'Asia/Jerusalem')::date))
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.courier_my_runs() from public, anon;
grant execute on function public.courier_my_runs() to authenticated;

create or replace function public.claim_delivery_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run   public.delivery_runs;
  v_uid   uuid := (select auth.uid());
  v_name  text;
  v_phone text;
begin
  perform public.delivery_assert_courier();
  select * into v_run from public.delivery_runs where id = p_run_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND';
  end if;
  if v_run.courier_id = v_uid and v_run.status in ('claimed', 'departed') then
    return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'changed', false);
  end if;
  if v_run.status <> 'open' then
    raise exception 'ALREADY_CLAIMED';
  end if;
  select coalesce(nullif(btrim(au.display_name), ''), u.email, 'שליח'), au.phone
    into v_name, v_phone
    from public.admin_users au join auth.users u on u.id = au.user_id
   where au.user_id = v_uid;
  update public.delivery_runs
     set status = 'claimed', courier_id = v_uid, courier_name = v_name, courier_phone = v_phone, claimed_at = now()
   where id = v_run.id;
  perform public.delivery_run_log(v_run.id, 'claimed');
  return jsonb_build_object('run_id', v_run.id, 'status', 'claimed', 'changed', true);
end;
$$;
revoke all on function public.claim_delivery_run(uuid) from public, anon;
grant execute on function public.claim_delivery_run(uuid) to authenticated;

-- The courier lets go of a run that has not left; the owner or staff may release anybody's (a courier who did not
-- show up). Never after departure.
create or replace function public.release_delivery_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run  public.delivery_runs;
  v_uid  uuid := (select auth.uid());
  v_role text := public.get_my_role();
begin
  if not (public.is_courier() or v_role in ('owner', 'staff')) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into v_run from public.delivery_runs where id = p_run_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND';
  end if;
  if v_run.status = 'open' then
    return jsonb_build_object('run_id', v_run.id, 'status', 'open', 'changed', false);
  end if;
  if v_run.status <> 'claimed' then
    raise exception 'RUN_ALREADY_DEPARTED';
  end if;
  if v_run.courier_id is distinct from v_uid and v_role not in ('owner', 'staff') then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.delivery_runs
     set status = 'open', courier_id = null, courier_name = null, courier_phone = null, claimed_at = null
   where id = v_run.id;
  perform public.delivery_run_log(v_run.id, 'released');
  return jsonb_build_object('run_id', v_run.id, 'status', 'open', 'changed', true);
end;
$$;
revoke all on function public.release_delivery_run(uuid) from public, anon;
grant execute on function public.release_delivery_run(uuid) to authenticated;

-- "יצאתי": every ready order of the run goes out for delivery at once.
create or replace function public.depart_delivery_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run  public.delivery_runs;
  v_uid  uuid := (select auth.uid());
  v_role text := public.get_my_role();
  v_n    integer;
begin
  if not (public.is_courier() or v_role in ('owner', 'staff')) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into v_run from public.delivery_runs where id = p_run_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND';
  end if;
  if v_run.status = 'departed' then
    return jsonb_build_object('run_id', v_run.id, 'status', 'departed', 'changed', false);
  end if;
  if v_run.status <> 'claimed' then
    raise exception 'RUN_NOT_CLAIMED';
  end if;
  if v_run.courier_id is distinct from v_uid and v_role not in ('owner', 'staff') then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.orders set order_status = 'out_for_delivery'
   where delivery_run_id = v_run.id and order_status = 'ready_for_dispatch';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'RUN_EMPTY';
  end if;
  update public.delivery_runs set status = 'departed', departed_at = now() where id = v_run.id;
  perform public.delivery_run_log(v_run.id, 'departed');
  return jsonb_build_object('run_id', v_run.id, 'status', 'departed', 'changed', true, 'orders', v_n);
end;
$$;
revoke all on function public.depart_delivery_run(uuid) from public, anon;
grant execute on function public.depart_delivery_run(uuid) to authenticated;

-- Shared by complete/fail: the order must be on the road in a run the caller drives (or the caller is back-office).
create or replace function public.delivery_stop_lock(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_run   public.delivery_runs;
  v_uid   uuid := (select auth.uid());
  v_role  text := public.get_my_role();
begin
  if not (public.is_courier() or v_role in ('owner', 'staff')) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.delivery_run_id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  select * into v_run from public.delivery_runs where id = v_order.delivery_run_id;
  if v_run.courier_id is distinct from v_uid and v_role not in ('owner', 'staff') then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return v_order;
end;
$$;
revoke all on function public.delivery_stop_lock(uuid) from public, anon, authenticated;

create or replace function public.complete_delivery_stop(p_order_id uuid, p_id_checked boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  v_order := public.delivery_stop_lock(p_order_id);
  if v_order.order_status = 'completed' then
    return jsonb_build_object('order_id', v_order.id, 'order_status', 'completed', 'changed', false);
  end if;
  if v_order.order_status <> 'out_for_delivery' then
    raise exception 'STALE_STATUS: %', v_order.order_status;
  end if;
  if p_id_checked is not true then
    raise exception 'ID_CHECK_REQUIRED';
  end if;
  update public.orders
     set order_status = 'completed',
         completed_at = now(),
         payment_status = case when payment_method = 'cash' and payment_status = 'pending' then 'paid' else payment_status end
   where id = v_order.id;
  perform public.delivery_run_refresh(v_order.delivery_run_id);
  return jsonb_build_object('order_id', v_order.id, 'order_status', 'completed', 'changed', true);
end;
$$;
revoke all on function public.complete_delivery_stop(uuid, boolean) from public, anon;
grant execute on function public.complete_delivery_stop(uuid, boolean) to authenticated;

-- Could not hand it over (no ID, nobody home, ...): the goods are on their way back -> stock waits in pending_return
-- until someone confirms they are physically in the store (resolve_stock_return). The coupon use is given back.
create or replace function public.fail_delivery_stop(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order  public.orders;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_order := public.delivery_stop_lock(p_order_id);
  if v_order.order_status = 'delivery_failed' then
    return jsonb_build_object('order_id', v_order.id, 'order_status', 'delivery_failed', 'changed', false);
  end if;
  if v_order.order_status <> 'out_for_delivery' then
    raise exception 'STALE_STATUS: %', v_order.order_status;
  end if;
  if v_reason is null then
    raise exception 'REASON_REQUIRED';
  end if;
  perform public.release_coupon_for_order(v_order.id, 'order_cancelled_after_dispatch');
  update public.orders
     set order_status = 'delivery_failed',
         delivery_failed_reason = v_reason,
         stock_return_status = 'pending_return'
   where id = v_order.id;
  perform public.delivery_run_refresh(v_order.delivery_run_id);
  return jsonb_build_object('order_id', v_order.id, 'order_status', 'delivery_failed', 'changed', true);
end;
$$;
revoke all on function public.fail_delivery_stop(uuid, text) from public, anon;
grant execute on function public.fail_delivery_stop(uuid, text) to authenticated;

-- ---------- 11. public reads: + the window ---------------------------------------------------------------
create or replace function public.get_order_status(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select id, order_number, order_status, payment_status, payment_method, fulfillment_method, total_cents, reserved_until,
         delivery_departure_time
    into v_order
    from public.orders
    where id = p_order_id;

  if not found then
    return null;
  end if;

  if v_order.order_status = 'pending' and v_order.payment_method = 'card'
     and v_order.reserved_until is not null and v_order.reserved_until < now() then
    perform public.release_expired_order(v_order.id);
    select order_status, payment_status into v_order.order_status, v_order.payment_status
      from public.orders where id = v_order.id;
  end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'order_status', v_order.order_status,
    'payment_status', v_order.payment_status,
    'payment_method', v_order.payment_method,
    'fulfillment_method', v_order.fulfillment_method,
    'total_cents', v_order.total_cents,
    'delivery_departure_time', v_order.delivery_departure_time
  );
end;
$$;
revoke all on function public.get_order_status(uuid) from public;
grant execute on function public.get_order_status(uuid) to anon, authenticated;

create or replace function public.get_my_orders(p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'order_status', o.order_status,
    'payment_method', o.payment_method,
    'payment_status', o.payment_status,
    'fulfillment_method', o.fulfillment_method,
    'delivery_departure_time', o.delivery_departure_time,
    'created_at', o.created_at,
    'subtotal_cents', o.subtotal_cents,
    'delivery_fee_cents', o.delivery_fee_cents,
    'discount_cents', o.discount_cents,
    'coupon_code', o.coupon_code_snapshot,
    'total_cents', o.total_cents,
    'city', o.city, 'street', o.street, 'house_number', o.house_number,
    'entrance', o.entrance, 'floor', o.floor, 'apartment', o.apartment,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                 'product_id', i.product_id,
                 'name', i.product_name_snapshot,
                 'brand', i.product_brand_snapshot,
                 'option', i.option,
                 'option_label', i.option_label_snapshot,
                 'quantity', i.quantity,
                 'unit_price_cents', i.unit_price_cents,
                 'line_total_cents', i.line_total_cents
               ) order by i.id), '[]'::jsonb)
              from public.order_items i where i.order_id = o.id)
  ) order by o.created_at desc), '[]'::jsonb)
  from (
    select * from public.orders
     where customer_id = (select auth.uid())
     order by created_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 50)
  ) o;
$$;
revoke all on function public.get_my_orders(integer) from public, anon;
grant execute on function public.get_my_orders(integer) to authenticated;

create or replace function public.get_business_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'store_hours', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'day_of_week', h.day_of_week,
          'is_open',     h.is_open,
          'open_time',   h.open_time,
          'close_time',  h.close_time
        )
        order by h.day_of_week
      )
      from public.business_hours h
      where h.schedule_type = 'store'
    ), '[]'::jsonb),
    'order_hours', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'day_of_week', h.day_of_week,
          'is_open',     h.is_open,
          'open_time',   h.open_time,
          'close_time',  h.close_time
        )
        order by h.day_of_week
      )
      from public.business_hours h
      where h.schedule_type = 'orders'
    ), '[]'::jsonb),
    'min_order_cents',    coalesce((select s.min_order_cents    from public.business_settings s where s.id = 1), 0),
    'delivery_fee_cents', coalesce((select s.delivery_fee_cents from public.business_settings s where s.id = 1), 0),
    'orders_paused',      coalesce((select s.orders_paused      from public.business_settings s where s.id = 1), false),
    'club_offer_text',    (select s.club_offer_text from public.business_settings s where s.id = 1),
    'pickup_enabled',     coalesce((select s.pickup_enabled     from public.business_settings s where s.id = 1), false),
    'delivery_enabled',   coalesce((select s.delivery_enabled   from public.business_settings s where s.id = 1), true),
    'cash_enabled',       coalesce((select s.cash_enabled       from public.business_settings s where s.id = 1), true),
    'card_enabled',       coalesce((select s.card_enabled       from public.business_settings s where s.id = 1), false),
    'store_address_text', (select s.store_address_text from public.business_settings s where s.id = 1),
    'delivery_advance_hours', coalesce((select s.delivery_advance_hours from public.business_settings s where s.id = 1), 4),
    'delivery_windows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',                w.id,
          'departure_time',    w.departure_time,
          'order_cutoff_time', w.order_cutoff_time
        )
        order by w.departure_time, w.sort_order
      )
      from public.delivery_windows w
      where w.is_active
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.get_business_settings() from public;
grant execute on function public.get_business_settings() to anon, authenticated;

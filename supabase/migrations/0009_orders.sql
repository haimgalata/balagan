-- =============================================================================
-- 0009_orders.sql — orders, order_items, payment attempts/events; stock reservation
-- =============================================================================
-- Run after 0008. Re-runnable.
--
-- This is the first migration that lets a checkout actually become a real order. One order model
-- serves both guest and (future) authenticated customers: `customer_id` is null for a guest, and every
-- order carries its OWN immutable snapshot of the customer/delivery details regardless of `customer_id` —
-- a later profile edit must never rewrite history. `order_status` (fulfillment) and `payment_status`
-- (money) are kept deliberately separate — see the design doc — because cash and card orders share one
-- lifecycle but differ in what gates `confirmed`.
--
--   orders            — one row per order. Created by create_order() the moment the customer commits to
--                        an order (after details + payment method), for BOTH cash and card — never
--                        earlier (on details alone) and, for card, never deferred until payment succeeds
--                        (that would leave nothing to hand the payment provider as a merchant reference).
--                        Cash orders start `confirmed`/stock already deducted; card orders start
--                        `pending`/stock only *reserved*, resolved later by confirm_payment().
--   order_items       — per-line snapshot (name, option, prices, quantity) so a later product rename/
--                        reprice/delete never changes a historical order. Doubles as the stock-reservation
--                        ledger: releasing a reservation means walking an order's items and giving back
--                        `base_units` per product — no separate reservations table is needed.
--   payment_attempts  — CARD only. One row per attempt at paying a given order (supports retries after a
--                        failed attempt without creating a second order). Its own `id` — not the order id —
--                        is what gets sent to a payment provider as the merchant reference.
--   payment_events    — append-only webhook log, unique on the provider's own event id. This is what makes
--                        a redelivered webhook a harmless no-op instead of double-processing a payment.
--
-- Stock: `products.stock_reserved_units` (new) makes "available to promise" = stock_base_units -
-- stock_reserved_units. The race-safe operation is always a SINGLE conditional UPDATE
-- (`set x = x + n where stock_base_units - stock_reserved_units >= n`), never a SELECT-then-UPDATE —
-- Postgres's own row lock on that UPDATE is what decides who gets the last unit under concurrency.
-- check_stock_availability() and the unit_in_stock/package_in_stock generated columns are updated to
-- account for it, or Task 1's existing cart/checkout UX would show stock as available when it's actually
-- all reserved by pending card payments.
--
-- Security: same model as every table so far — RLS on, zero policies for `anon` (every anonymous write
-- goes through create_order(), a SECURITY DEFINER RPC, exactly like check_stock_availability()/
-- get_storefront_catalog()). New this migration: confirm_payment() is SECURITY DEFINER but granted ONLY
-- to `service_role` — it must be reachable only from a server-side webhook handler (a future Supabase
-- Edge Function), never from the browser. Also new: `orders`/`order_items` get an extra, currently-inert
-- policy letting an authenticated user read their OWN orders (customer_id = auth.uid()) — unused until
-- customer accounts exist, but costs nothing to add now and means "my orders" needs no schema change later.
-- =============================================================================

-- ---------- 1. stock reservation ---------------------------------------------
alter table public.products
  add column if not exists stock_reserved_units integer not null default 0;

alter table public.products drop constraint if exists products_stock_reserved_units_nonneg;
alter table public.products add constraint products_stock_reserved_units_nonneg check (stock_reserved_units >= 0);

alter table public.products drop constraint if exists products_stock_reserved_within_base;
alter table public.products add constraint products_stock_reserved_within_base check (stock_reserved_units <= stock_base_units);

alter table public.products drop column if exists unit_in_stock;
alter table public.products drop column if exists package_in_stock;
alter table public.products
  add column unit_in_stock boolean generated always as (
    unit_available and (not track_stock or stock_base_units - stock_reserved_units >= 1)
  ) stored,
  add column package_in_stock boolean generated always as (
    package_enabled and package_available
    and (not track_stock or stock_base_units - stock_reserved_units >= package_unit_count)
  ) stored;

-- available = NOT track_stock OR (stock_base_units - stock_reserved_units) >= base_units. Same contract as
-- before (boolean-only, no reservation, no pool size ever leaves this function) — the only change is
-- subtracting reserved stock, so this stays honest once card orders start reserving.
create or replace function public.check_stock_availability(p_items jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', item ->> 'product_id',
        'available', coalesce((
          select not p.track_stock or (p.stock_base_units - p.stock_reserved_units) >= greatest((item ->> 'base_units')::int, 0)
          from public.products p
          join public.categories c on c.id = p.category_id
          left join public.subcategories s on s.id = p.subcategory_id
          where p.id = item ->> 'product_id'
            and p.is_visible
            and c.is_visible
            and (p.subcategory_id is null or s.is_visible)
        ), false)
      )
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(p_items) as item;
$$;

revoke all on function public.check_stock_availability(jsonb) from public;
grant execute on function public.check_stock_availability(jsonb) to anon, authenticated;

-- ---------- 2. orders ----------------------------------------------------------
-- order_number is the human-friendly identifier (admin lists, phone calls); orders.id (uuid) is the
-- external reference used in URLs/payment provider fields — deliberately NOT sequential/guessable like
-- products.id, because an order carries a name and address (unlike the public catalog) and is looked up
-- via a return URL that must not be probeable.
create sequence if not exists public.order_number_seq as bigint start with 1001 minvalue 1001;

create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     bigint not null unique default nextval('public.order_number_seq'),
  idempotency_key  uuid not null unique,

  customer_id      uuid references auth.users (id) on delete set null,

  payment_method   text not null check (payment_method in ('cash', 'card')),
  order_status     text not null default 'pending'
    check (order_status in ('pending', 'confirmed', 'expired', 'cancelled', 'completed')),
  payment_status   text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'failed', 'cancelled')),

  -- ----- immutable customer/delivery snapshot — never re-read from a profile later -----
  first_name       text not null,
  last_name        text not null,
  phone            text not null,
  email            text,
  city             text not null,
  street           text not null,
  house_number     text not null,
  entrance         text,
  floor            text,
  apartment        text,
  intercom_code    text,
  delivery_notes   text,

  age_confirmed_at   timestamptz not null,
  terms_accepted_at  timestamptz not null,
  terms_version      text not null default 'v1',

  -- ----- totals, integer agorot (matches the rest of the catalog) -----
  subtotal_cents      integer not null check (subtotal_cents >= 0),
  delivery_fee_cents  integer not null check (delivery_fee_cents >= 0),
  discount_cents      integer not null default 0 check (discount_cents >= 0),
  total_cents         integer not null check (total_cents >= 0),
  currency            text not null default 'ILS',

  reserved_until   timestamptz,  -- card only: the reservation window; always null for cash

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,

  constraint orders_total_matches check (total_cents = subtotal_cents + delivery_fee_cents - discount_cents),
  constraint orders_names_not_blank check (btrim(first_name) <> '' and btrim(last_name) <> ''),
  constraint orders_phone_not_blank check (btrim(phone) <> ''),
  constraint orders_email_format check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint orders_reserved_until_card_only check (payment_method = 'card' or reserved_until is null)
);
create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_status_idx on public.orders (order_status, created_at);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------- 3. order_items ------------------------------------------------------
-- product_id is nullable + ON DELETE SET NULL (not RESTRICT, unlike every other FK to products) precisely
-- so the admin's real product-delete can proceed without breaking a historical order — the snapshot
-- columns are what make the row still meaningful once the product itself is gone.
create table if not exists public.order_items (
  id                       bigint generated always as identity primary key,
  order_id                 uuid not null references public.orders (id) on delete cascade,
  product_id               text references public.products (id) on delete set null,

  product_name_snapshot    text not null,
  product_brand_snapshot   text,
  option                   text not null check (option in ('unit', 'package')),
  option_label_snapshot    text not null,

  unit_price_cents      integer not null check (unit_price_cents >= 0),
  regular_price_cents   integer not null check (regular_price_cents >= 0),
  quantity               integer not null check (quantity > 0),
  base_units             integer not null check (base_units > 0),
  line_total_cents       integer not null check (line_total_cents >= 0),

  created_at  timestamptz not null default now(),

  constraint order_items_line_total_matches check (line_total_cents = unit_price_cents * quantity)
);
create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists order_items_product_id_idx on public.order_items (product_id);

-- ---------- 4. payment_attempts / payment_events (card only) --------------------
create table if not exists public.payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  provider            text not null default 'unset',
  provider_reference  text,
  amount_cents        integer not null check (amount_cents >= 0),
  status              text not null default 'created'
    check (status in ('created', 'redirected', 'succeeded', 'failed', 'expired')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index if not exists payment_attempts_order_id_idx on public.payment_attempts (order_id);
create unique index if not exists payment_attempts_provider_reference_key
  on public.payment_attempts (provider_reference) where provider_reference is not null;

create table if not exists public.payment_events (
  id                   bigint generated always as identity primary key,
  payment_attempt_id   uuid not null references public.payment_attempts (id) on delete cascade,
  provider_event_id    text not null,
  payload              jsonb,
  received_at          timestamptz not null default now(),
  constraint payment_events_provider_event_unique unique (provider_event_id)
);
create index if not exists payment_events_attempt_id_idx on public.payment_events (payment_attempt_id);

-- ---------- 5. privileges + RLS (same recipe as every table, see 0002) ----------
revoke all on table public.orders, public.order_items, public.payment_attempts, public.payment_events
  from public, anon, authenticated;
revoke all on sequence public.order_number_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.orders           to authenticated;
grant select, insert, update, delete on table public.order_items      to authenticated;
grant select, insert, update, delete on table public.payment_attempts to authenticated;
grant select, insert, update, delete on table public.payment_events   to authenticated;
grant usage, select on sequence public.order_number_seq to authenticated;

alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_events   enable row level security;

drop policy if exists orders_admin_all on public.orders;
create policy orders_admin_all on public.orders
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Unused until customer accounts exist (customer_id is always null today, so this never matches anyone) —
-- added now so a future "my orders" screen needs zero schema changes.
drop policy if exists orders_customer_select_own on public.orders;
create policy orders_customer_select_own on public.orders
  for select to authenticated
  using (customer_id = (select auth.uid()));

drop policy if exists order_items_admin_all on public.order_items;
create policy order_items_admin_all on public.order_items
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists order_items_customer_select_own on public.order_items;
create policy order_items_customer_select_own on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.customer_id = (select auth.uid())
  ));

-- More sensitive than orders (provider references) — admin-only, no customer self-select; a customer only
-- ever sees payment status through their order, never these tables directly.
drop policy if exists payment_attempts_admin_all on public.payment_attempts;
create policy payment_attempts_admin_all on public.payment_attempts
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists payment_events_admin_all on public.payment_events;
create policy payment_events_admin_all on public.payment_events
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- (No policy is created for `anon` on any of the four tables => anon is denied everything at the table
-- level; every anonymous interaction goes through create_order()/get_order_status() below.)

-- ---------- 6. create_order(): the only way an order gets created ---------------
-- SECURITY DEFINER, callable by anon (guests) and authenticated alike — same trust tier as
-- check_stock_availability()/get_storefront_catalog(). Re-validates EVERYTHING server-side (prices, stock,
-- minimum order, required fields, age/terms) — never trusts what the client sends beyond product ids/
-- options/quantities and the free-text delivery fields. Idempotent on (p_idempotency_key): a repeat call
-- with the same key returns the already-created order instead of making a second one (double-click,
-- refresh, or a retried request after a network timeout all land here safely).
--
--   p_payload = {
--     "items": [{ "product_id": "1", "option": "unit"|"package", "quantity": 2 }, ...],
--     "payment_method": "cash" | "card",
--     "customer": {
--       "first_name", "last_name", "phone", "email", "city", "street", "house_number",
--       "entrance", "floor", "apartment", "intercom_code", "notes",
--       "age_confirmed": bool, "terms_accepted": bool
--     }
--   }
--
-- Stock: for each line, if the product tracks stock, ONE conditional UPDATE either reserves (card) or
-- permanently deducts (cash) base_units — `set x = x + n where stock_base_units - stock_reserved_units >=
-- n`. Zero rows affected => raises, rolling back the whole order (including any earlier lines' stock
-- changes in this same call) — this single statement, not the informational read before it, is what
-- actually arbitrates concurrent buyers of the last unit.
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
  v_settings        record;
  v_subtotal        integer := 0;
  v_delivery_fee    integer;
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
begin
  if p_idempotency_key is null then
    raise exception 'MISSING_IDEMPOTENCY_KEY';
  end if;

  select id, order_number, order_status, payment_status, payment_method, total_cents,
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
      'total_cents', v_existing.total_cents,
      'payment_attempt_id', v_existing.payment_attempt_id
    );
  end if;

  v_items := p_payload -> 'items';
  v_customer := p_payload -> 'customer';
  v_payment_method := p_payload ->> 'payment_method';

  if v_payment_method not in ('cash', 'card') then
    raise exception 'INVALID_PAYMENT_METHOD';
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
  -- Delivery is Netivot-only today (see src/checkout/data/netivotStreets.ts) — enforced here too, not just
  -- in the frontend's locked field, because this RPC must never trust the client alone.
  if coalesce(v_customer ->> 'city', '') is distinct from 'נתיבות' then
    raise exception 'UNSUPPORTED_CITY';
  end if;
  if coalesce(btrim(v_customer ->> 'street'), '') = '' or coalesce(btrim(v_customer ->> 'house_number'), '') = '' then
    raise exception 'MISSING_ADDRESS';
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

  select min_order_cents, delivery_fee_cents into v_settings from public.business_settings where id = 1;
  v_delivery_fee := coalesce(v_settings.delivery_fee_cents, 0);
  v_total := v_subtotal + v_delivery_fee;

  if v_subtotal < coalesce(v_settings.min_order_cents, 0) then
    raise exception 'BELOW_MINIMUM_ORDER';
  end if;

  if v_payment_method = 'cash' then
    v_order_status := 'confirmed';
    v_reserved_until := null;
  else
    v_order_status := 'pending';
    v_reserved_until := v_now + interval '30 minutes';
  end if;

  insert into public.orders (
    idempotency_key, payment_method, order_status, payment_status,
    first_name, last_name, phone, email, city, street, house_number,
    entrance, floor, apartment, intercom_code, delivery_notes,
    age_confirmed_at, terms_accepted_at, terms_version,
    subtotal_cents, delivery_fee_cents, discount_cents, total_cents, currency,
    reserved_until, confirmed_at
  ) values (
    p_idempotency_key, v_payment_method, v_order_status, 'pending',
    btrim(v_customer ->> 'first_name'), btrim(v_customer ->> 'last_name'), btrim(v_customer ->> 'phone'),
    nullif(btrim(v_customer ->> 'email'), ''), v_customer ->> 'city', v_customer ->> 'street', v_customer ->> 'house_number',
    nullif(btrim(v_customer ->> 'entrance'), ''), nullif(btrim(v_customer ->> 'floor'), ''),
    nullif(btrim(v_customer ->> 'apartment'), ''), nullif(btrim(v_customer ->> 'intercom_code'), ''),
    nullif(btrim(v_customer ->> 'notes'), ''),
    v_now, v_now, 'v1',
    v_subtotal, v_delivery_fee, 0, v_total, 'ILS',
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
    'total_cents', v_total,
    'payment_attempt_id', v_payment_attempt_id
  );
end;
$$;

revoke all on function public.create_order(jsonb, uuid) from public;
grant execute on function public.create_order(jsonb, uuid) to anon, authenticated;

-- ---------- 7. get_order_status(): narrow read for the return page / resume ----
-- The order's own UUID is the capability token for this read (a guest has no other credential) — status
-- only, no PII, no address, no payment provider details. Lazily expires a stale card reservation the
-- moment anything asks about it, instead of relying solely on a scheduled sweep.
create or replace function public.get_order_status(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select id, order_number, order_status, payment_status, payment_method, total_cents, reserved_until
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
    'total_cents', v_order.total_cents
  );
end;
$$;

revoke all on function public.get_order_status(uuid) from public;
grant execute on function public.get_order_status(uuid) to anon, authenticated;

-- ---------- 8. reservation release + expiry sweep -------------------------------
-- Internal (not exposed to anon/authenticated): releases one card order's stock reservation and marks it
-- expired. Idempotent — a no-op if the order isn't a still-pending card order (already resolved by a
-- webhook or a previous call). order_items IS the reservation ledger: walking it and giving back
-- base_units per product is all that's needed, no separate reservations table.
create or replace function public.release_expired_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
begin
  update public.orders
     set order_status = 'expired', payment_status = 'failed'
   where id = p_order_id
     and order_status = 'pending'
     and payment_method = 'card';

  if not found then
    return;
  end if;

  for v_item in
    select product_id, base_units from public.order_items
    where order_id = p_order_id and product_id is not null
  loop
    update public.products
       set stock_reserved_units = greatest(stock_reserved_units - v_item.base_units, 0)
     where id = v_item.product_id;
  end loop;
end;
$$;

revoke all on function public.release_expired_order(uuid) from public, anon, authenticated;

-- Proactive bulk sweep — NOT wired to a schedule yet (deliberately deferred; the lazy check above is what
-- actually keeps behavior correct for now). Exists so a scheduled trigger (pg_cron / a scheduled Edge
-- Function) can be pointed at it later with no further schema work, and so an admin can run it manually.
create or replace function public.expire_stale_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  for v_order in
    select id from public.orders
    where order_status = 'pending' and payment_method = 'card'
      and reserved_until is not null and reserved_until < now()
  loop
    perform public.release_expired_order(v_order.id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_orders() from public, anon;
grant execute on function public.expire_stale_orders() to authenticated;

-- ---------- 9. confirm_payment(): webhook-only, not reachable from the browser --
-- SECURITY DEFINER but granted ONLY to service_role — a new trust tier beyond anon/authenticated+is_admin():
-- this must be callable only from a server-side webhook handler (a future Supabase Edge Function using the
-- service_role key, which per this project's existing hard rule never ships to the client). The return URL
-- must NEVER be what confirms a payment — only this function, driven by a provider-signed webhook, does.
--
-- Idempotent twice over: `payment_events.provider_event_id` is unique (a redelivered webhook is a no-op,
-- including its stock/status side effects), and an already-resolved payment_attempt is a no-op too (a
-- second, different event for a final attempt). On success, stock is deducted with a floor of 0 rather than
-- unconditionally — if the order's reservation was already released by a very late webhook arriving after
-- expiry, this still marks payment_status='paid' (the charge is real, never hide that) without corrupting
-- stock; the resulting paid-but-not-confirmed order is itself the "needs manual attention" signal, with no
-- extra status required.
create or replace function public.confirm_payment(
  p_payment_attempt_id uuid,
  p_provider_event_id  text,
  p_outcome            text,
  p_provider_reference text default null,
  p_payload            jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt   public.payment_attempts;
  v_event_id  bigint;
  v_order_id  uuid;
  v_item      record;
begin
  if p_outcome not in ('succeeded', 'failed') then
    raise exception 'INVALID_OUTCOME';
  end if;

  insert into public.payment_events (payment_attempt_id, provider_event_id, payload)
  values (p_payment_attempt_id, p_provider_event_id, p_payload)
  on conflict (provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select order_id into v_order_id from public.payment_attempts where id = p_payment_attempt_id;
    return jsonb_build_object('already_processed', true, 'order_id', v_order_id);
  end if;

  select * into v_attempt from public.payment_attempts where id = p_payment_attempt_id;
  if not found then
    raise exception 'UNKNOWN_PAYMENT_ATTEMPT';
  end if;

  if v_attempt.status in ('succeeded', 'failed') then
    return jsonb_build_object('already_processed', true, 'order_id', v_attempt.order_id);
  end if;

  update public.payment_attempts
     set status = p_outcome,
         provider_reference = coalesce(p_provider_reference, provider_reference),
         resolved_at = now()
   where id = v_attempt.id;

  if p_outcome = 'succeeded' then
    for v_item in
      select oi.product_id, oi.base_units from public.order_items oi
      where oi.order_id = v_attempt.order_id and oi.product_id is not null
    loop
      update public.products
         set stock_base_units = greatest(stock_base_units - v_item.base_units, 0),
             stock_reserved_units = greatest(stock_reserved_units - v_item.base_units, 0)
       where id = v_item.product_id;
    end loop;

    update public.orders
       set payment_status = 'paid',
           order_status = case when order_status = 'expired' then order_status else 'confirmed' end,
           confirmed_at = coalesce(confirmed_at, now())
     where id = v_attempt.order_id;
  else
    for v_item in
      select oi.product_id, oi.base_units from public.order_items oi
      where oi.order_id = v_attempt.order_id and oi.product_id is not null
    loop
      update public.products
         set stock_reserved_units = greatest(stock_reserved_units - v_item.base_units, 0)
       where id = v_item.product_id;
    end loop;

    update public.orders
       set payment_status = 'failed'
     where id = v_attempt.order_id and order_status <> 'confirmed';
  end if;

  return jsonb_build_object('already_processed', false, 'order_id', v_attempt.order_id, 'outcome', p_outcome);
end;
$$;

revoke all on function public.confirm_payment(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_payment(uuid, text, text, text, jsonb) to service_role;

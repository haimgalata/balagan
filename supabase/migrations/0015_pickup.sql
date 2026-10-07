-- =============================================================================
-- 0015_pickup.sql — store pickup (איסוף עצמי), per-method on/off switches, server-side "orders open" check
-- =============================================================================
-- Run after 0014. Re-runnable. Apply it BEFORE deploying a client that sends `fulfillment_method` (create_order
-- treats a missing one as 'delivery', so the old client keeps working).
--
-- Applying it changes NOTHING the customer sees by itself: the defaults keep today's behaviour (delivery on,
-- pickup off, cash on, card off). The owner flips the switches in /admin/settings.
--
--   orders.fulfillment_method   'delivery' (default, every existing order) | 'pickup'. A pickup order has no address
--                               (city/street/house_number are NULL), no delivery fee and no minimum order.
--   order_status 'ready_for_pickup'
--                               the pickup counterpart of out_for_delivery:
--                                 delivery: confirmed -> preparing -> out_for_delivery -> completed
--                                 pickup:   confirmed -> preparing -> ready_for_pickup -> completed
--                               Cancelling a ready_for_pickup order restores stock AUTOMATICALLY (the goods never left
--                               the store) — unlike out_for_delivery, which waits for resolve_stock_return().
--   business_settings           pickup_enabled / delivery_enabled (at least one stays on), cash_enabled / card_enabled,
--                               store_address_text (shown to pickup customers). All exposed by get_business_settings().
--                               card_enabled defaults to OFF: no payment provider is wired yet, and until one is, a
--                               card order would only hold stock for 30 minutes and never get paid.
--   create_order()              0014 + the method switches + pickup rules + ORDERS_CLOSED: refuses an order while
--                               orders_paused is on or outside the 'orders' weekly schedule (Asia/Jerusalem) — the
--                               storefront banner was the only thing enforcing that before.
--   customer_apply_order()      a member's pickup order teaches the profile but saves no address.
--   transition_order()          the two lifecycles above; out_for_delivery only for delivery, ready_for_pickup only for pickup.
--   get_order_status()          + fulfillment_method (the order-tracking page). Still no personal data.
--   get_my_orders()             + fulfillment_method.
--   preview_coupon()            a free-delivery coupon has no benefit when delivery is off.
-- =============================================================================

-- ---------- 1. orders: fulfillment method, nullable address, new status ----------------------------------
alter table public.orders add column if not exists fulfillment_method text not null default 'delivery';
alter table public.orders drop constraint if exists orders_fulfillment_method_check;
alter table public.orders add constraint orders_fulfillment_method_check
  check (fulfillment_method in ('delivery', 'pickup'));

alter table public.orders alter column city drop not null;
alter table public.orders alter column street drop not null;
alter table public.orders alter column house_number drop not null;
alter table public.orders drop constraint if exists orders_delivery_has_address;
alter table public.orders add constraint orders_delivery_has_address check (
  fulfillment_method <> 'delivery'
  or (city is not null and nullif(btrim(coalesce(street, '')), '') is not null and nullif(btrim(coalesce(house_number, '')), '') is not null)
);
alter table public.orders drop constraint if exists orders_pickup_no_delivery_fee;
alter table public.orders add constraint orders_pickup_no_delivery_fee
  check (fulfillment_method <> 'pickup' or delivery_fee_cents = 0);

alter table public.orders drop constraint if exists orders_order_status_check;
alter table public.orders add constraint orders_order_status_check
  check (order_status in ('pending', 'confirmed', 'preparing', 'out_for_delivery', 'ready_for_pickup', 'expired', 'cancelled', 'completed'));

drop index if exists public.orders_active_idx;
create index orders_active_idx on public.orders (created_at)
  where order_status in ('confirmed', 'preparing', 'out_for_delivery', 'ready_for_pickup');

-- Staff visibility (0010) — a ready_for_pickup order is still open.
drop policy if exists orders_staff_select on public.orders;
create policy orders_staff_select on public.orders
  for select to authenticated
  using (
    (select public.is_staff())
    and (
      order_status in ('confirmed', 'preparing', 'out_for_delivery', 'ready_for_pickup')
      or stock_return_status = 'pending_return'
      or status_changed_at >= now() - interval '7 days'
    )
  );

-- ---------- 2. business_settings: switches + store address ----------------------------------------------
alter table public.business_settings add column if not exists pickup_enabled     boolean not null default false;
alter table public.business_settings add column if not exists delivery_enabled   boolean not null default true;
alter table public.business_settings add column if not exists cash_enabled       boolean not null default true;
alter table public.business_settings add column if not exists card_enabled       boolean not null default false;
alter table public.business_settings add column if not exists store_address_text text;

alter table public.business_settings drop constraint if exists business_settings_some_fulfillment;
alter table public.business_settings add constraint business_settings_some_fulfillment
  check (pickup_enabled or delivery_enabled);
alter table public.business_settings drop constraint if exists business_settings_store_address_format;
alter table public.business_settings add constraint business_settings_store_address_format
  check (store_address_text is null or (btrim(store_address_text) <> '' and char_length(store_address_text) <= 120));

-- ---------- 3. orders_accepting_now(): the 'orders' schedule + the manual pause, in Israel time ----------
-- Same rule as the storefront's useOrderStatus(): open_time <= now < close_time on today's row, AND NOT orders_paused.
create or replace function public.orders_accepting_now()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not coalesce((select s.orders_paused from public.business_settings s where s.id = 1), false)
     and exists (
       select 1
         from public.business_hours h,
              lateral (select (now() at time zone 'Asia/Jerusalem') as local_now) t
        where h.schedule_type = 'orders'
          and h.is_open
          and h.day_of_week = extract(dow from t.local_now)::int
          and t.local_now::time >= h.open_time
          and t.local_now::time <  h.close_time
     );
$$;
revoke all on function public.orders_accepting_now() from public, anon, authenticated;

-- ---------- 4. create_order(): 0014 + fulfillment method, method switches, ORDERS_CLOSED ----------------
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

-- ---------- 5. customer_apply_order(): 0012, but a pickup order saves no address -------------------------
create or replace function public.customer_apply_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o       public.orders;
  c       public.customers;
  v_match uuid;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or o.customer_id is null then
    return;
  end if;
  select * into c from public.customers where id = o.customer_id and deleted_at is null;
  if not found then
    return;
  end if;

  update public.customers set
    first_name        = coalesce(nullif(btrim(first_name), ''), o.first_name),
    last_name         = coalesce(nullif(btrim(last_name), ''), o.last_name),
    email             = coalesce(email, o.email),
    last_order_at     = greatest(coalesce(last_order_at, o.created_at), o.created_at),
    terms_version     = case when terms_accepted_at is null or o.created_at > terms_accepted_at then o.terms_version else terms_version end,
    terms_accepted_at = case when terms_accepted_at is null or o.created_at > terms_accepted_at then o.terms_accepted_at else terms_accepted_at end
  where id = c.id;

  if c.terms_accepted_at is null or o.created_at > c.terms_accepted_at then
    insert into public.customer_consents (customer_id, kind, granted, wording_version, source, created_at)
    values (c.id, 'terms', true, o.terms_version, 'checkout', o.terms_accepted_at);
  end if;

  if o.fulfillment_method <> 'delivery' then
    return;
  end if;

  select a.id into v_match
    from public.customer_addresses a
   where a.customer_id = c.id
     and lower(btrim(a.street)) = lower(btrim(o.street))
     and lower(btrim(a.house_number)) = lower(btrim(o.house_number))
     and coalesce(lower(btrim(a.entrance)), '') = coalesce(lower(btrim(o.entrance)), '')
     and coalesce(lower(btrim(a.floor)), '') = coalesce(lower(btrim(o.floor)), '')
     and coalesce(lower(btrim(a.apartment)), '') = coalesce(lower(btrim(o.apartment)), '');

  if v_match is null then
    insert into public.customer_addresses (customer_id, city, street, house_number, entrance, floor, apartment, intercom_code, notes, last_used_at)
    values (c.id, o.city, btrim(o.street), btrim(o.house_number), o.entrance, o.floor, o.apartment, o.intercom_code, o.delivery_notes, o.created_at);
  else
    update public.customer_addresses
       set last_used_at = o.created_at, intercom_code = o.intercom_code, notes = o.delivery_notes
     where id = v_match and last_used_at <= o.created_at;
  end if;
end;
$$;
revoke all on function public.customer_apply_order(uuid) from public, anon, authenticated;

-- ---------- 6. transition_order(): 0014 + the pickup lifecycle -------------------------------------------
--   delivery  confirmed -> preparing -> out_for_delivery -> completed   (cancel while out: pending_return)
--   pickup    confirmed -> preparing -> ready_for_pickup -> completed   (cancel while ready: stock restored at once)
--   back      one step; reopening completed is OWNER only (to the method's own previous status)
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
begin
  if v_role is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_to_status not in ('confirmed', 'preparing', 'out_for_delivery', 'ready_for_pickup', 'completed', 'cancelled') then
    raise exception 'INVALID_STATUS: %', p_to_status;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  v_from := v_order.order_status;
  v_last := case when v_order.fulfillment_method = 'pickup' then 'ready_for_pickup' else 'out_for_delivery' end;

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
    or (v_from = 'preparing' and (p_to_status = v_last or p_to_status in ('confirmed', 'cancelled')))
    or (v_from = v_last      and p_to_status in ('completed', 'preparing', 'cancelled'))
    or (v_from = 'completed' and p_to_status = v_last and v_role = 'owner')
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
    -- a genuinely cancelled order gives its coupon use back (the redemption row keeps its history)
    perform public.release_coupon_for_order(
      v_order.id,
      case when v_from = 'out_for_delivery' then 'order_cancelled_after_dispatch' else 'order_cancelled_before_dispatch' end);
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

-- ---------- 7. get_order_status(): 0009 + fulfillment_method --------------------------------------------
-- The order's own UUID is the capability token for this read (a guest has no other credential) — status
-- only, no PII, no address, no payment provider details.
create or replace function public.get_order_status(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select id, order_number, order_status, payment_status, payment_method, fulfillment_method, total_cents, reserved_until
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
    'total_cents', v_order.total_cents
  );
end;
$$;
revoke all on function public.get_order_status(uuid) from public;
grant execute on function public.get_order_status(uuid) to anon, authenticated;

-- ---------- 8. get_my_orders(): 0014 + fulfillment_method ------------------------------------------------
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

-- ---------- 9. preview_coupon(): 0014, but the fee it previews against is 0 when delivery is off ----------
create or replace function public.preview_coupon(p_code text, p_subtotal_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_fee     integer;
  v_eval    jsonb;
  v_reason  text;
begin
  if v_uid is null or p_subtotal_cents is null or p_subtotal_cents < 0 then
    return jsonb_build_object('valid', false, 'reason', 'COUPON_MEMBERS_ONLY');
  end if;

  if (select count(*) from public.coupon_attempts a where a.customer_id = v_uid and a.created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('valid', false, 'reason', 'COUPON_TOO_MANY_ATTEMPTS');
  end if;

  select case when s.delivery_enabled then coalesce(s.delivery_fee_cents, 0) else 0 end
    into v_fee from public.business_settings s where s.id = 1;
  begin
    v_eval := public.coupon_evaluate(p_code, p_subtotal_cents, coalesce(v_fee, 0), false);
  exception when others then
    v_reason := split_part(sqlerrm, ':', 1);
    if v_reason not like 'COUPON\_%' then
      raise;
    end if;
    if v_reason = 'COUPON_INVALID' then
      delete from public.coupon_attempts where created_at < now() - interval '1 day';
      insert into public.coupon_attempts (customer_id) values (v_uid);
    end if;
    return jsonb_build_object(
      'valid', false, 'reason', v_reason,
      'min_subtotal_cents', case when v_reason = 'COUPON_MIN_ORDER' then nullif(btrim(split_part(sqlerrm, ':', 2)), '')::integer end);
  end;

  return jsonb_build_object(
    'valid', true,
    'code', v_eval ->> 'code',
    'title', v_eval ->> 'title',
    'discount_type', v_eval ->> 'discount_type',
    'discount_cents', (v_eval ->> 'discount_cents')::integer);
end;
$$;
revoke all on function public.preview_coupon(text, integer) from public, anon;
grant execute on function public.preview_coupon(text, integer) to authenticated;

-- ---------- 10. get_business_settings(): 0014 + the switches and the store address ----------------------
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
    'store_address_text', (select s.store_address_text from public.business_settings s where s.id = 1)
  );
$$;
revoke all on function public.get_business_settings() from public;
grant execute on function public.get_business_settings() to anon, authenticated;

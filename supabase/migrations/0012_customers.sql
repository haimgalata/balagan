-- =============================================================================
-- 0012_customers.sql — Balagan Club: customer profile, consents, saved addresses, "my orders"
-- =============================================================================
-- Run after 0011. Re-runnable. Does NOT enable sign-ups and changes nothing about guest checkout.
--
-- Model: registered customer == club member. A member is a verified phone (auth.users.phone, set by Supabase
-- phone-OTP) + a `customers` row. Joining requires ONE mandatory confirmation (21+ and written-marketing
-- consent), enforced in join_club() and recorded as separate append-only facts in customer_consents.
-- Guests are untouched: they have no row anywhere except their own immutable order snapshot.
--
-- Trust rules (never relaxed):
--   * a member's phone comes ONLY from auth.users.phone (OTP-verified) — never from client input;
--   * customers read their own orders ONLY through get_my_orders() (column whitelist), never the table API;
--   * orders.customer_id is set by a trigger from auth.uid(), never from the create_order() payload.
-- =============================================================================

-- ---------- 1. phone normalization -----------------------------------------------------------------
-- '050-123-4567' / '+972 50 123 4567' / '972501234567' / '00972501234567' / '+972 (0)50…' -> '+972501234567'.
-- NULL when it is not a valid Israeli number (mobile 05x, landline 02/03/04/08/09, VoIP 07x).
create or replace function public.normalize_il_phone(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  with a as (
    select regexp_replace(coalesce(p_raw, ''), '[^0-9+]', '', 'g') as s
  ), b as (
    select case
             when s ~ '^(\+|00)?972' then
               '0' || regexp_replace(regexp_replace(s, '[^0-9]', '', 'g'), '^(00)?972(0)?', '')
             else regexp_replace(s, '[^0-9]', '', 'g')
           end as d
    from a
  )
  select case when d ~ '^0(5[0-9]{8}|[2-489][0-9]{7}|7[0-9]{8})$' then '+972' || substr(d, 2) end
  from b;
$$;
revoke all on function public.normalize_il_phone(text) from public, anon, authenticated;

-- orders: a canonical phone next to the free-text one (SMS-ready later; links guest orders to a verified phone).
alter table public.orders add column if not exists phone_e164 text
  generated always as (public.normalize_il_phone(phone)) stored;
create index if not exists orders_phone_e164_guest_idx on public.orders (phone_e164) where customer_id is null;

-- ---------- 2. tables ------------------------------------------------------------------------------
create table if not exists public.customers (
  id                uuid primary key references auth.users (id) on delete cascade,
  -- Mobile only (club identity is an SMS-capable number). Kept even after account deletion as a
  -- marketing-suppression record (see delete_my_account()).
  phone_e164        text not null unique check (phone_e164 ~ '^\+9725[0-9]{8}$'),
  first_name        text,
  last_name         text,
  email             text,
  joined_at         timestamptz not null default now(),
  last_order_at     timestamptz,
  terms_version     text,
  terms_accepted_at timestamptz,
  deleted_at        timestamptz,
  constraint customers_email_format check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Append-only proof of what the customer agreed to, when, in which wording, through which door.
create table if not exists public.customer_consents (
  id              bigint generated always as identity primary key,
  customer_id     uuid not null references public.customers (id) on delete cascade,
  kind            text not null check (kind in ('age_21', 'marketing', 'terms')),
  granted         boolean not null,
  channels        text[],                       -- marketing only: subset of {sms,email}
  wording_version text not null,
  source          text not null check (source in ('registration', 'account', 'checkout')),
  created_at      timestamptz not null default now(),
  constraint customer_consents_channels_valid check (channels is null or channels <@ array['sms', 'email'])
);
create index if not exists customer_consents_latest_idx on public.customer_consents (customer_id, kind, id desc);

-- "Default" address = the most recently used one (no flag to keep in sync). Capped at 5 by trigger.
create table if not exists public.customer_addresses (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers (id) on delete cascade,
  city          text not null default 'נתיבות' check (city = 'נתיבות'),
  street        text not null check (btrim(street) <> ''),
  house_number  text not null check (btrim(house_number) <> ''),
  entrance      text,
  floor         text,
  apartment     text,
  intercom_code text,
  notes         text,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create unique index if not exists customer_addresses_dedupe on public.customer_addresses (
  customer_id, lower(btrim(street)), lower(btrim(house_number)),
  coalesce(lower(btrim(entrance)), ''), coalesce(lower(btrim(floor)), ''), coalesce(lower(btrim(apartment)), '')
);

create or replace function public.customer_addresses_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.customer_addresses a
   where a.customer_id = new.customer_id
     and a.id not in (
       select x.id from public.customer_addresses x
        where x.customer_id = new.customer_id
        order by x.last_used_at desc, x.created_at desc limit 5
     );
  return null;
end;
$$;
revoke all on function public.customer_addresses_cap() from public, anon, authenticated;
drop trigger if exists customer_addresses_cap on public.customer_addresses;
create trigger customer_addresses_cap after insert on public.customer_addresses
  for each row execute function public.customer_addresses_cap();

-- ---------- 3. privileges + RLS --------------------------------------------------------------------
revoke all on table public.customers, public.customer_consents, public.customer_addresses from public, anon, authenticated;
grant select on public.customers to authenticated;
grant update (first_name, last_name, email) on public.customers to authenticated;   -- not phone, not terms, not deleted_at
grant select on public.customer_consents to authenticated;                          -- written only by the RPCs below
grant select, insert, delete on public.customer_addresses to authenticated;
grant update (street, house_number, entrance, floor, apartment, intercom_code, notes, last_used_at)
  on public.customer_addresses to authenticated;

alter table public.customers          enable row level security;
alter table public.customer_consents  enable row level security;
alter table public.customer_addresses enable row level security;

drop policy if exists customers_select_own on public.customers;
create policy customers_select_own on public.customers
  for select to authenticated using (id = (select auth.uid()) and deleted_at is null);

drop policy if exists customers_update_own on public.customers;
create policy customers_update_own on public.customers
  for update to authenticated
  using (id = (select auth.uid()) and deleted_at is null)
  with check (id = (select auth.uid()) and deleted_at is null);

drop policy if exists customer_consents_select_own on public.customer_consents;
create policy customer_consents_select_own on public.customer_consents
  for select to authenticated using (customer_id = (select auth.uid()));

drop policy if exists customer_addresses_own on public.customer_addresses;
create policy customer_addresses_own on public.customer_addresses
  for all to authenticated
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

-- ---------- 4. orders <-> customers -----------------------------------------------------------------
-- (a) A member's order is attached to them by the DATABASE (create_order() itself is unchanged).
create or replace function public.orders_attach_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.customer_id is null and (select auth.uid()) is not null then
    select c.id into new.customer_id
      from public.customers c
     where c.id = (select auth.uid()) and c.deleted_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.orders_attach_customer() from public, anon, authenticated;
drop trigger if exists orders_attach_customer on public.orders;
create trigger orders_attach_customer before insert on public.orders
  for each row execute function public.orders_attach_customer();

-- (b) "Collect naturally while ordering": an order teaches the profile what it doesn't know yet
-- (name/e-mail), remembers the address (deduped, most recently used first) and the accepted terms version.
-- Idempotent — also used when guest orders are claimed.
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

create or replace function public.orders_after_insert_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.customer_id is not null then
    perform public.customer_apply_order(new.id);
  end if;
  return null;
end;
$$;
revoke all on function public.orders_after_insert_customer() from public, anon, authenticated;
drop trigger if exists orders_after_insert_customer on public.orders;
create trigger orders_after_insert_customer after insert on public.orders
  for each row execute function public.orders_after_insert_customer();

-- (c) History attribution: a customer placing an order is 'customer', never a member's uuid. Only back-office
-- accounts (admin_users) get a named actor. Otherwise identical to 0010.
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

-- ---------- 5. RPCs (all SECURITY DEFINER, logged-in only) ------------------------------------------
-- The caller's club profile, or NULL if they are not (or no longer) a member. This is how the client knows
-- whether a freshly OTP-verified session still has to go through join_club().
create or replace function public.get_my_customer()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'phone', c.phone_e164,
    'first_name', c.first_name,
    'last_name', c.last_name,
    'email', c.email,
    'joined_at', c.joined_at,
    'terms_version', c.terms_version,
    'terms_accepted_at', c.terms_accepted_at,
    'age_21_confirmed_at', (select m.created_at from public.customer_consents m
                             where m.customer_id = c.id and m.kind = 'age_21' and m.granted order by m.id desc limit 1),
    'marketing', coalesce((select m.granted from public.customer_consents m
                            where m.customer_id = c.id and m.kind = 'marketing' order by m.id desc limit 1), false),
    'marketing_channels', coalesce((select m.channels from public.customer_consents m
                            where m.customer_id = c.id and m.kind = 'marketing' order by m.id desc limit 1), '{}'::text[])
  )
  from public.customers c
  where c.id = (select auth.uid()) and c.deleted_at is null;
$$;

-- Links earlier GUEST orders to a member — only those whose phone equals the OTP-verified one. Returns how many.
create or replace function public.claim_guest_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_e164 text;
  v_n    integer;
  r      record;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  select c.phone_e164 into v_e164 from public.customers c where c.id = v_uid and c.deleted_at is null;
  if v_e164 is null then
    return 0;
  end if;

  update public.orders set customer_id = v_uid where customer_id is null and phone_e164 = v_e164;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    -- Let the 5 most recent orders teach the profile (oldest first, so the newest address ends up "default").
    for r in
      select x.id from (
        select id, created_at from public.orders where customer_id = v_uid order by created_at desc limit 5
      ) x order by x.created_at asc
    loop
      perform public.customer_apply_order(r.id);
    end loop;
  end if;
  return v_n;
end;
$$;

-- p_payload = { "age_21_confirmed": true, "marketing_consent": true, "wording_version": "v1",
--               "channels": ["sms","email"], "first_name"?, "last_name"?, "email"?, "source"? }
-- Idempotent for an existing member (no checkbox needed again). The phone is read from auth.users.
create or replace function public.join_club(p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_phone    text;
  v_e164     text;
  v_existing public.customers;
  v_wording  text := coalesce(nullif(btrim(p_payload ->> 'wording_version'), ''), 'v1');
  v_source   text := coalesce(nullif(btrim(p_payload ->> 'source'), ''), 'registration');
  v_channels text[];
  v_claimed  integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into v_existing from public.customers where id = v_uid;
  if found and v_existing.deleted_at is null then
    v_claimed := public.claim_guest_orders();
    return coalesce(public.get_my_customer(), '{}'::jsonb) || jsonb_build_object('created', false, 'claimed_orders', v_claimed);
  end if;

  if coalesce(p_payload ->> 'age_21_confirmed', '') <> 'true' then
    raise exception 'AGE_21_REQUIRED';
  end if;
  if coalesce(p_payload ->> 'marketing_consent', '') <> 'true' then
    raise exception 'MARKETING_CONSENT_REQUIRED';
  end if;
  if v_source not in ('registration', 'account', 'checkout') then
    raise exception 'INVALID_SOURCE';
  end if;

  select coalesce(array_agg(distinct x), '{}'::text[]) into v_channels
    from jsonb_array_elements_text(
           case when jsonb_typeof(p_payload -> 'channels') = 'array' then p_payload -> 'channels' else '[]'::jsonb end
         ) as t(x)
   where x in ('sms', 'email');
  if cardinality(v_channels) = 0 then
    v_channels := array['sms', 'email'];
  end if;

  select u.phone into v_phone from auth.users u where u.id = v_uid;
  v_e164 := public.normalize_il_phone(v_phone);
  if v_e164 is null or v_e164 !~ '^\+9725[0-9]{8}$' then
    raise exception 'MOBILE_REQUIRED';
  end if;

  begin
    insert into public.customers (id, phone_e164, first_name, last_name, email)
    values (v_uid, v_e164, nullif(btrim(p_payload ->> 'first_name'), ''), nullif(btrim(p_payload ->> 'last_name'), ''),
            nullif(btrim(p_payload ->> 'email'), ''))
    on conflict (id) do update
      set phone_e164 = excluded.phone_e164, joined_at = now(), deleted_at = null,
          first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
          terms_version = null, terms_accepted_at = null;
  exception
    when unique_violation then raise exception 'PHONE_ALREADY_REGISTERED';
    when check_violation then raise exception 'INVALID_EMAIL';
  end;

  insert into public.customer_consents (customer_id, kind, granted, wording_version, source)
  values (v_uid, 'age_21', true, v_wording, v_source);
  insert into public.customer_consents (customer_id, kind, granted, channels, wording_version, source)
  values (v_uid, 'marketing', true, v_channels, v_wording, v_source);

  v_claimed := public.claim_guest_orders();
  return coalesce(public.get_my_customer(), '{}'::jsonb) || jsonb_build_object('created', true, 'claimed_orders', v_claimed);
end;
$$;

-- The member's own orders, column-whitelisted: no cancel reason, stock state, idempotency key, staff/actor data.
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
    'created_at', o.created_at,
    'subtotal_cents', o.subtotal_cents,
    'delivery_fee_cents', o.delivery_fee_cents,
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

-- Marketing opt-in / opt-out from the account screen. Withdrawal never deletes the account.
create or replace function public.set_marketing_consent(
  p_granted boolean,
  p_channels text[] default null,
  p_wording_version text default 'v1'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_channels text[];
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_granted is null then
    raise exception 'INVALID_ARGUMENT';
  end if;
  if not exists (select 1 from public.customers where id = v_uid and deleted_at is null) then
    raise exception 'NOT_A_MEMBER' using errcode = '42501';
  end if;

  if p_granted then
    select coalesce(array_agg(distinct x), '{}'::text[]) into v_channels
      from unnest(coalesce(p_channels, array['sms', 'email'])) as t(x) where x in ('sms', 'email');
    if cardinality(v_channels) = 0 then
      v_channels := array['sms', 'email'];
    end if;
  end if;

  insert into public.customer_consents (customer_id, kind, granted, channels, wording_version, source)
  values (v_uid, 'marketing', p_granted, v_channels, coalesce(nullif(btrim(p_wording_version), ''), 'v1'), 'account');

  return public.get_my_customer();
end;
$$;

-- Right to erasure, as far as accounting allows: personal profile + saved addresses removed, past orders keep
-- their own snapshot (retention) but are unlinked from the account, marketing is withdrawn. The phone number is
-- deliberately KEPT on the (now empty) row as a suppression record so a later import can never re-market it.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where id = v_uid and deleted_at is null) then
    return;
  end if;

  delete from public.customer_addresses where customer_id = v_uid;
  update public.orders set customer_id = null where customer_id = v_uid;
  update public.customers
     set first_name = null, last_name = null, email = null, last_order_at = null,
         terms_version = null, terms_accepted_at = null, deleted_at = now()
   where id = v_uid;
  insert into public.customer_consents (customer_id, kind, granted, channels, wording_version, source)
  values (v_uid, 'marketing', false, null, 'v1', 'account');
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_my_customer()', 'public.claim_guest_orders()', 'public.join_club(jsonb)',
    'public.get_my_orders(integer)', 'public.set_marketing_consent(boolean, text[], text)', 'public.delete_my_account()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

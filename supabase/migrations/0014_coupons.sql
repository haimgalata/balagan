-- =============================================================================
-- 0014_coupons.sql — Balagan Club coupons (a MEMBER-ONLY benefit, redeemed in create_order)
-- =============================================================================
-- Run after 0013. Re-runnable. Apply it BEFORE deploying a client that sends `coupon_code`
-- (create_order tolerates a missing code, so the old client keeps working).
--
-- Model (see the coupon design plan):
--   coupons              what the owner configures. The code is typed by the owner, normalized and LOCKED after creation.
--                        Two independent limits: max_total_redemptions and max_per_member (NULL = unlimited).
--   coupon_redemptions   the ledger: one row per order that used a coupon (order_id is unique -> one coupon per order).
--                        reserved (card, while the order is pending) -> redeemed (cash at once / card once paid) -> released
--                        (cancelled / failed / expired). Timestamps are never cleared, so history survives a release.
--                        The per-member identity is the verified PHONE (not the uuid): it survives delete + re-join.
--   orders.coupon_*      permanent snapshot of what was applied; editing/disabling a coupon never changes past orders.
--   coupon_events        append-only audit of every change to a coupon (who / what / before-after).
--   coupon_attempts      failed code guesses per member (throttle for preview_coupon).
--
-- Trust rules (never relaxed):
--   * eligibility is decided HERE, inside create_order, at the moment of the order: auth.uid() must be an ACTIVE club
--     member (a customers row that is not soft-deleted). Marketing consent is deliberately NOT consulted.
--   * the client sends only `coupon_code`; any client-sent discount / total is ignored;
--   * the coupon row is locked (FOR UPDATE) inside the order transaction, so two checkouts racing for the last use
--     (or one member in two tabs) are serialized and everything rolls back together with stock;
--   * a non-member always gets COUPON_MEMBERS_ONLY whatever the code — codes cannot be probed by guests.
-- =============================================================================

-- ---------- 1. code normalization ------------------------------------------------------------------
-- NFKC, then drop spaces and invisible / bidi marks (common when a code is pasted next to Hebrew), then upper-case.
-- Pinned to src/storefront/lib/couponCode.ts by identical examples (tests/account/couponCode.unit.spec.ts).
create or replace function public.normalize_coupon_code(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(
    normalize(coalesce(p_raw, ''), NFKC),
    E'[[:space:]​-‏‪-‮⁦-⁩﻿]', '', 'g'));
$$;
-- Pure and harmless, but it must stay executable by `authenticated`: the owner inserts coupons through the table API
-- and the coupons_code_format CHECK runs it with the caller's privileges.
revoke all on function public.normalize_coupon_code(text) from public, anon;
grant execute on function public.normalize_coupon_code(text) to authenticated;

-- ---------- 2. tables --------------------------------------------------------------------------------
create table if not exists public.coupons (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null,
  title                 text not null,
  internal_note         text,
  discount_type         text not null check (discount_type in ('percent', 'fixed', 'free_delivery')),
  discount_value        integer,                 -- percent 1..100, or agorot; NULL for free_delivery
  max_discount_cents    integer,                 -- cap, percent coupons only
  min_subtotal_cents    integer not null default 0,
  starts_at             timestamptz,
  ends_at               timestamptz,
  is_active             boolean not null default true,
  max_total_redemptions integer,                 -- NULL = unlimited
  max_per_member        integer,                 -- NULL = unlimited
  first_order_only      boolean not null default false,
  audience              text not null default 'members',
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid,
  updated_at            timestamptz not null default now(),
  updated_by            uuid,
  constraint coupons_code_format check (code = public.normalize_coupon_code(code) and code ~ '^[A-Z0-9_-]{3,24}$'),
  constraint coupons_title_ok check (btrim(title) <> '' and length(title) <= 80),
  constraint coupons_note_ok check (internal_note is null or length(internal_note) <= 500),
  constraint coupons_value_matches_type check (
       (discount_type = 'percent'       and discount_value is not null and discount_value between 1 and 100)
    or (discount_type = 'fixed'         and discount_value is not null and discount_value >= 1)
    or (discount_type = 'free_delivery' and discount_value is null)
  ),
  constraint coupons_cap_percent_only check (max_discount_cents is null or (discount_type = 'percent' and max_discount_cents > 0)),
  constraint coupons_min_ok check (min_subtotal_cents >= 0),
  constraint coupons_dates_ordered check (starts_at is null or ends_at is null or starts_at < ends_at),
  constraint coupons_total_limit_ok check (max_total_redemptions is null or max_total_redemptions > 0),
  constraint coupons_member_limit_ok check (max_per_member is null or max_per_member > 0),
  constraint coupons_audience_ok check (audience = 'members')
);
-- One normalized code ever: archived codes stay reserved so a retired code is never silently reused.
create unique index if not exists coupons_code_key on public.coupons (code);

create table if not exists public.coupon_redemptions (
  id              uuid primary key default gen_random_uuid(),
  coupon_id       uuid not null references public.coupons (id) on delete restrict,
  order_id        uuid not null unique references public.orders (id) on delete restrict,
  phone_e164      text not null,
  customer_id     uuid references public.customers (id) on delete set null,
  discount_cents  integer not null check (discount_cents > 0),
  status          text not null check (status in ('reserved', 'redeemed', 'released')),
  reserved_at     timestamptz not null default now(),
  redeemed_at     timestamptz,
  released_at     timestamptz,
  released_reason text check (released_reason in
    ('order_cancelled_before_dispatch', 'order_cancelled_after_dispatch', 'reservation_expired', 'payment_failed')),
  constraint coupon_redemptions_state check (
       (status = 'reserved' and redeemed_at is null and released_at is null)
    or (status = 'redeemed' and redeemed_at is not null)
    or (status = 'released' and released_at is not null and released_reason is not null)
  )
);
create index if not exists coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, status);
create index if not exists coupon_redemptions_phone_idx  on public.coupon_redemptions (coupon_id, phone_e164);

-- What the order permanently remembers (discount_cents already existed since 0009).
alter table public.orders add column if not exists coupon_id uuid references public.coupons (id) on delete restrict;
alter table public.orders add column if not exists coupon_code_snapshot text;
alter table public.orders add column if not exists coupon_snapshot jsonb;
alter table public.orders drop constraint if exists orders_coupon_consistent;
alter table public.orders add constraint orders_coupon_consistent
  check ((coupon_id is null) = (coupon_code_snapshot is null) and (coupon_id is not null or discount_cents = 0));

create table if not exists public.coupon_events (
  id          bigint generated always as identity primary key,
  coupon_id   uuid not null,                       -- no FK on purpose: the trail outlives anything
  code        text not null,
  kind        text not null check (kind in ('created', 'updated', 'enabled', 'disabled', 'archived', 'restored')),
  changes     jsonb,
  actor_id    uuid,
  actor_label text not null,
  created_at  timestamptz not null default now()
);
create index if not exists coupon_events_coupon_idx on public.coupon_events (coupon_id, id desc);

create table if not exists public.coupon_attempts (
  id          bigint generated always as identity primary key,
  customer_id uuid not null,
  created_at  timestamptz not null default now()
);
create index if not exists coupon_attempts_customer_idx on public.coupon_attempts (customer_id, created_at desc);

-- The owner's one public sentence for guests (shown, locked, in checkout). Plain text, never derived from coupons.
alter table public.business_settings add column if not exists club_offer_text text;
alter table public.business_settings drop constraint if exists business_settings_club_offer_text_ok;
alter table public.business_settings add constraint business_settings_club_offer_text_ok
  check (club_offer_text is null or (btrim(club_offer_text) <> '' and length(club_offer_text) <= 120));

-- ---------- 3. triggers on coupons -------------------------------------------------------------------
create or replace function public.coupons_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := (select auth.uid());
  else
    if new.code is distinct from old.code then
      raise exception 'CODE_LOCKED';
    end if;
    if (new.discount_type is distinct from old.discount_type or new.discount_value is distinct from old.discount_value)
       and exists (select 1 from public.coupon_redemptions r where r.coupon_id = old.id) then
      raise exception 'COUPON_LOCKED';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;
revoke all on function public.coupons_before_write() from public, anon, authenticated;
drop trigger if exists coupons_before_write on public.coupons;
create trigger coupons_before_write before insert or update on public.coupons
  for each row execute function public.coupons_before_write();

create or replace function public.coupons_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_label   text := 'system';
  v_changes jsonb;
  v_kind    text;
begin
  if v_uid is not null then
    select coalesce(u.email, v_uid::text) into v_label from auth.users u where u.id = v_uid;
    v_label := coalesce(v_label, v_uid::text);
  end if;

  if tg_op = 'INSERT' then
    insert into public.coupon_events (coupon_id, code, kind, changes, actor_id, actor_label)
    values (new.id, new.code, 'created', to_jsonb(new), v_uid, v_label);
    return null;
  end if;

  select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
    into v_changes
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o on o.key = n.key
   where n.value is distinct from o.value and n.key not in ('updated_at', 'updated_by');
  if v_changes is null then
    return null;
  end if;

  v_kind := case
    when v_changes ? 'archived_at' and new.archived_at is not null then 'archived'
    when v_changes ? 'archived_at' then 'restored'
    when v_changes ? 'is_active' and (select count(*) from jsonb_object_keys(v_changes)) = 1 and new.is_active then 'enabled'
    when v_changes ? 'is_active' and (select count(*) from jsonb_object_keys(v_changes)) = 1 then 'disabled'
    else 'updated' end;
  insert into public.coupon_events (coupon_id, code, kind, changes, actor_id, actor_label)
  values (new.id, new.code, v_kind, v_changes, v_uid, v_label);
  return null;
end;
$$;
revoke all on function public.coupons_record_event() from public, anon, authenticated;
drop trigger if exists coupons_record_event on public.coupons;
create trigger coupons_record_event after insert or update on public.coupons
  for each row execute function public.coupons_record_event();

-- ---------- 4. privileges + RLS -----------------------------------------------------------------------
revoke all on table public.coupons, public.coupon_redemptions, public.coupon_events, public.coupon_attempts
  from public, anon, authenticated;
grant select, insert, update on public.coupons to authenticated;      -- no DELETE: coupons are archived, never removed
grant select on public.coupon_redemptions to authenticated;           -- written only by the order functions below
grant select on public.coupon_events to authenticated;                -- written only by the trigger

alter table public.coupons            enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.coupon_events      enable row level security;
alter table public.coupon_attempts    enable row level security;      -- no policy, no grant: functions only

drop policy if exists coupons_owner_all on public.coupons;
create policy coupons_owner_all on public.coupons
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists coupon_redemptions_owner_select on public.coupon_redemptions;
create policy coupon_redemptions_owner_select on public.coupon_redemptions
  for select to authenticated using ((select public.is_admin()));

drop policy if exists coupon_events_owner_select on public.coupon_events;
create policy coupon_events_owner_select on public.coupon_events
  for select to authenticated using ((select public.is_admin()));

-- ---------- 5. membership + evaluation (internal) ---------------------------------------------------
-- The ONE definition of "active club member" for coupons: a customers row for auth.uid() that is not soft-deleted.
create or replace function public.coupon_active_member()
returns table (customer_id uuid, phone_e164 text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.phone_e164 from public.customers c
   where c.id = (select auth.uid()) and c.deleted_at is null;
$$;
revoke all on function public.coupon_active_member() from public, anon, authenticated;

-- Validates a code for the current caller and computes the discount. Raises a COUPON_* token on any refusal.
-- p_lock = true (create_order): the coupon row is locked FOR UPDATE until the order's transaction ends.
create or replace function public.coupon_evaluate(p_code text, p_subtotal_cents integer, p_delivery_fee_cents integer, p_lock boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member   record;
  v_code     text := public.normalize_coupon_code(p_code);
  v_c        public.coupons;
  v_total    integer;
  v_member_n integer;
  v_discount integer;
begin
  -- Membership first: a guest / not-yet-member / ex-member learns nothing about which codes exist.
  select * into v_member from public.coupon_active_member();
  if not found then
    raise exception 'COUPON_MEMBERS_ONLY';
  end if;

  if v_code = '' then
    raise exception 'COUPON_INVALID';
  end if;
  if p_lock then
    select * into v_c from public.coupons where code = v_code for update;
  else
    select * into v_c from public.coupons where code = v_code;
  end if;
  if not found or v_c.archived_at is not null then
    raise exception 'COUPON_INVALID';
  end if;
  if not v_c.is_active then
    raise exception 'COUPON_DISABLED';
  end if;
  if v_c.starts_at is not null and v_c.starts_at > now() then
    raise exception 'COUPON_NOT_STARTED';
  end if;
  if v_c.ends_at is not null and v_c.ends_at <= now() then
    raise exception 'COUPON_EXPIRED';
  end if;
  if p_subtotal_cents < v_c.min_subtotal_cents then
    raise exception 'COUPON_MIN_ORDER: %', v_c.min_subtotal_cents;
  end if;

  if v_c.first_order_only and exists (
       select 1 from public.orders o
        where (o.customer_id = v_member.customer_id or o.phone_e164 = v_member.phone_e164)
          and o.order_status not in ('cancelled', 'expired')
     ) then
    raise exception 'COUPON_FIRST_ORDER_ONLY';
  end if;

  -- A use counts while redeemed, or reserved AND the card order's hold has not run out (the sweep is not scheduled,
  -- so an abandoned card order must not keep a slot).
  select count(*),
         count(*) filter (where r.phone_e164 = v_member.phone_e164)
    into v_total, v_member_n
    from public.coupon_redemptions r
    join public.orders o on o.id = r.order_id
   where r.coupon_id = v_c.id
     and (r.status = 'redeemed' or (r.status = 'reserved' and o.reserved_until > now()));
  if v_c.max_total_redemptions is not null and v_total >= v_c.max_total_redemptions then
    raise exception 'COUPON_EXHAUSTED';
  end if;
  if v_c.max_per_member is not null and v_member_n >= v_c.max_per_member then
    raise exception 'COUPON_ALREADY_USED';
  end if;

  if v_c.discount_type = 'percent' then
    v_discount := ((p_subtotal_cents::bigint * v_c.discount_value) / 100)::integer;
    if v_c.max_discount_cents is not null then
      v_discount := least(v_discount, v_c.max_discount_cents);
    end if;
    v_discount := least(v_discount, p_subtotal_cents);
  elsif v_c.discount_type = 'fixed' then
    v_discount := least(v_c.discount_value, p_subtotal_cents);
  else
    v_discount := greatest(p_delivery_fee_cents, 0);
  end if;
  if v_discount <= 0 then
    raise exception 'COUPON_NO_BENEFIT';
  end if;

  return jsonb_build_object(
    'coupon_id', v_c.id,
    'code', v_c.code,
    'title', v_c.title,
    'discount_type', v_c.discount_type,
    'discount_cents', v_discount,
    'customer_id', v_member.customer_id,
    'phone_e164', v_member.phone_e164,
    'snapshot', jsonb_build_object(
      'title', v_c.title, 'discount_type', v_c.discount_type, 'discount_value', v_c.discount_value,
      'max_discount_cents', v_c.max_discount_cents, 'min_subtotal_cents', v_c.min_subtotal_cents,
      'first_order_only', v_c.first_order_only)
  );
end;
$$;
revoke all on function public.coupon_evaluate(text, integer, integer, boolean) from public, anon, authenticated;

-- ---------- 6. preview_coupon(): the checkout's "apply" button (informational) -----------------------
-- The client-sent subtotal is NOT trusted for anything but this preview; create_order recomputes everything.
-- Never raises for an ordinary refusal (so a failed guess is recorded and committed): returns {valid:false, reason}.
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

  select coalesce(s.delivery_fee_cents, 0) into v_fee from public.business_settings s where s.id = 1;
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

-- ---------- 7. redemption lifecycle helpers (internal) ------------------------------------------------
create or replace function public.release_coupon_for_order(p_order_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.coupon_redemptions
     set status = 'released', released_at = now(), released_reason = p_reason
   where order_id = p_order_id and status in ('reserved', 'redeemed');
$$;
revoke all on function public.release_coupon_for_order(uuid, text) from public, anon, authenticated;

-- A paid card order consumes its coupon. Also honors a LATE payment for an order whose hold already lapsed (the
-- customer really paid the discounted amount) — never for a cancelled order.
create or replace function public.redeem_coupon_for_order(p_order_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.coupon_redemptions
     set status = 'redeemed', redeemed_at = now()
   where order_id = p_order_id
     and (status = 'reserved' or (status = 'released' and released_reason in ('reservation_expired', 'payment_failed')));
$$;
revoke all on function public.redeem_coupon_for_order(uuid) from public, anon, authenticated;

-- ---------- 8. create_order(): 0009 + coupon -------------------------------------------------------------
-- Identical to 0009 except: an optional p_payload.coupon_code is validated/priced after the lines (BELOW_MINIMUM_ORDER
-- still looks at the subtotal before any discount), the discount/snapshot go on the order, the redemption row is
-- written in the same transaction (redeemed for cash, reserved for card), and the result carries discount_cents.
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

  select id, order_number, order_status, payment_status, payment_method, total_cents, discount_cents,
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
      'discount_cents', v_existing.discount_cents,
      'payment_attempt_id', v_existing.payment_attempt_id
    );
  end if;

  v_items := p_payload -> 'items';
  v_customer := p_payload -> 'customer';
  v_payment_method := p_payload ->> 'payment_method';
  v_coupon_code := nullif(btrim(coalesce(p_payload ->> 'coupon_code', '')), '');

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

  if v_subtotal < coalesce(v_settings.min_order_cents, 0) then
    raise exception 'BELOW_MINIMUM_ORDER';
  end if;

  -- Coupon: validated and priced HERE, by the database, for the caller's own identity (auth.uid()). Any refusal
  -- raises a COUPON_* token and rolls back the whole order, stock included.
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
    idempotency_key, payment_method, order_status, payment_status,
    first_name, last_name, phone, email, city, street, house_number,
    entrance, floor, apartment, intercom_code, delivery_notes,
    age_confirmed_at, terms_accepted_at, terms_version,
    subtotal_cents, delivery_fee_cents, discount_cents, total_cents, currency,
    coupon_id, coupon_code_snapshot, coupon_snapshot,
    reserved_until, confirmed_at
  ) values (
    p_idempotency_key, v_payment_method, v_order_status, 'pending',
    btrim(v_customer ->> 'first_name'), btrim(v_customer ->> 'last_name'), btrim(v_customer ->> 'phone'),
    nullif(btrim(v_customer ->> 'email'), ''), v_customer ->> 'city', v_customer ->> 'street', v_customer ->> 'house_number',
    nullif(btrim(v_customer ->> 'entrance'), ''), nullif(btrim(v_customer ->> 'floor'), ''),
    nullif(btrim(v_customer ->> 'apartment'), ''), nullif(btrim(v_customer ->> 'intercom_code'), ''),
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
    'total_cents', v_total,
    'discount_cents', v_discount,
    'payment_attempt_id', v_payment_attempt_id
  );
end;
$$;

revoke all on function public.create_order(jsonb, uuid) from public;
grant execute on function public.create_order(jsonb, uuid) to anon, authenticated;

-- ---------- 9. release_expired_order(): 0009 + release the coupon use ----------------------------------
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

  perform public.release_coupon_for_order(p_order_id, 'reservation_expired');
end;
$$;
revoke all on function public.release_expired_order(uuid) from public, anon, authenticated;

-- ---------- 10. confirm_payment(): 0009 + redeem / release the coupon use -----------------------------
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

    perform public.redeem_coupon_for_order(v_attempt.order_id);
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

    perform public.release_coupon_for_order(v_attempt.order_id, 'payment_failed');
  end if;

  return jsonb_build_object('already_processed', false, 'order_id', v_attempt.order_id, 'outcome', p_outcome);
end;
$$;

revoke all on function public.confirm_payment(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_payment(uuid, text, text, text, jsonb) to service_role;

-- ---------- 11. transition_order(): 0010 + release the coupon use on cancel ---------------------------
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

-- ---------- 12. get_my_orders(): 0012 + the discount and the coupon code ------------------------------
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

-- ---------- 13. get_business_settings(): 0008 + the owner's public club-offer sentence ----------------
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
    'club_offer_text',    (select s.club_offer_text from public.business_settings s where s.id = 1)
  );
$$;
revoke all on function public.get_business_settings() from public;
grant execute on function public.get_business_settings() to anon, authenticated;

-- =============================================================================
-- 0008_business_settings.sql — physical-store hours, online-order hours/settings, get_business_settings()
-- =============================================================================
-- Run after 0007. Re-runnable.
--
-- Physical-store opening hours and online-order availability were static placeholder values in the frontend
-- (src/data/businessHours.ts, src/data/deliveryInfo.ts) with no admin control and no distinction between the
-- two (the storefront's info banner conflated "is the physical shop open" with "are we taking online orders").
-- This migration makes both admin-editable and moves them into the database as the storefront's source of
-- truth, while keeping them two clearly separate concepts:
--
--   business_hours    — one row per (schedule_type, day_of_week). schedule_type is either 'store' (the
--                        physical shop's opening hours) or 'orders' (when the site accepts online orders) —
--                        two independent weekly schedules sharing one table/RLS/RPC surface rather than
--                        doubling it. day_of_week follows JS Date#getDay() (0 = Sunday ... 6 = Saturday), the
--                        same convention the frontend already used.
--   business_settings — a SINGLETON row (id is always 1): minimum order amount, delivery fee (both in
--                        integer agorot, matching the rest of the catalog's pricing convention), and
--                        orders_paused — a manual, ONE-WAY override that can only force online orders closed
--                        early; it can never force them open outside the configured schedule (approved
--                        interaction model: orders_open_now = schedule_says_open(now) AND NOT orders_paused).
--
-- Same security model as every other admin-writable table (see 0002): RLS on, zero policies for anon, one
-- is_admin()-gated policy per table. The storefront (anonymous visitors) never gets table access — it reads
-- through get_business_settings() below, the same whitelisted-RPC pattern as get_storefront_catalog() (0004)
-- and check_stock_availability() (0007).
-- =============================================================================

-- ---------- business_hours ---------------------------------------------------
create table if not exists public.business_hours (
  schedule_type text     not null check (schedule_type in ('store', 'orders')),
  day_of_week   smallint not null check (day_of_week between 0 and 6),
  is_open       boolean  not null default true,
  open_time     time,
  close_time    time,
  primary key (schedule_type, day_of_week),
  constraint business_hours_times_when_open check (
    not is_open or (open_time is not null and close_time is not null and open_time < close_time)
  )
);

-- ---------- business_settings (singleton) ------------------------------------
create table if not exists public.business_settings (
  id                 smallint primary key default 1 check (id = 1),
  min_order_cents    integer not null default 0 check (min_order_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  orders_paused      boolean not null default false,
  updated_at         timestamptz not null default now()
);

drop trigger if exists business_settings_set_updated_at on public.business_settings;
create trigger business_settings_set_updated_at before update on public.business_settings
  for each row execute function public.set_updated_at();

-- ---------- seed (today's placeholder schedule; on conflict do nothing — never overwrites an admin's edits
-- on a re-run) ----------------------------------------------------------------
insert into public.business_hours (schedule_type, day_of_week, is_open, open_time, close_time)
values
  ('store', 0, true,  '09:00', '23:00'), ('store', 1, true,  '09:00', '23:00'), ('store', 2, true,  '09:00', '23:00'),
  ('store', 3, true,  '09:00', '23:00'), ('store', 4, true,  '09:00', '23:00'), ('store', 5, true,  '09:00', '16:00'),
  ('store', 6, false, null,     null),
  ('orders', 0, true,  '09:00', '23:00'), ('orders', 1, true,  '09:00', '23:00'), ('orders', 2, true,  '09:00', '23:00'),
  ('orders', 3, true,  '09:00', '23:00'), ('orders', 4, true,  '09:00', '23:00'), ('orders', 5, true,  '09:00', '16:00'),
  ('orders', 6, false, null,     null)
on conflict (schedule_type, day_of_week) do nothing;

insert into public.business_settings (id, min_order_cents, delivery_fee_cents, orders_paused)
values (1, 5000, 1500, false)
on conflict (id) do nothing;

-- ---------- privileges + RLS (same 4-step recipe as every admin-writable table, see 0002) -------------------
revoke all on table public.business_hours, public.business_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.business_hours    to authenticated;
grant select, insert, update, delete on table public.business_settings to authenticated;

alter table public.business_hours    enable row level security;
alter table public.business_settings enable row level security;

drop policy if exists business_hours_admin_all on public.business_hours;
create policy business_hours_admin_all on public.business_hours
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists business_settings_admin_all on public.business_settings;
create policy business_settings_admin_all on public.business_settings
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- (No policy is created for `anon` on either table => anon is denied everything; see get_business_settings() below.)

-- ---------- get_business_settings(): the ONLY public read path ---------------
-- Whitelist: both weekly schedules (day_of_week/is_open/open_time/close_time) and the three business_settings
-- fields the storefront actually needs. Nothing else about business_settings (e.g. updated_at) leaves here.
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
    'orders_paused',      coalesce((select s.orders_paused      from public.business_settings s where s.id = 1), false)
  );
$$;

-- Callable by the public storefront (and logged-in users), same as get_storefront_catalog() / check_stock_availability().
revoke all on function public.get_business_settings() from public;
grant execute on function public.get_business_settings() to anon, authenticated;

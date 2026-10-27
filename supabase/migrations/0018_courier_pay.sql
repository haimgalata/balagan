-- =============================================================================
-- 0018_courier_pay.sql — what each courier is owed (owner only)
-- =============================================================================
-- Run after 0017. Re-runnable. Apply it BEFORE deploying an admin build that has the "שכר שליחים" screen or a courier
-- screen that sends `p_pay` to fail_delivery_stop() (an older client keeps working: p_pay defaults to "owner decides").
--
-- The owner pays a courier a rate of his OWN choosing per delivery (not the customer's delivery fee): one default in
-- business_settings, optionally overridden per courier in admin_users. The amount is FROZEN on the delivery when the courier
-- closes the stop, so changing a rate later never rewrites a past month.
--
--   delivery_pay             one row per handed-over / failed delivery: which courier (the run's), the outcome, the failure
--                            reason and the pay_cents frozen at that moment. NULL pay_cents on a failed delivery = the courier
--                            gave a reason that is not clearly the customer's fault ("address not found", "other") and the
--                            owner has not decided yet. Nobody can read it through the API — not staff, not a courier; the
--                            owner reads it only through admin_courier_payroll().
--   courier_payouts         what the owner recorded as already paid to a courier for a month (so the screen can show the rest).
--   business_settings.courier_pay_cents / admin_users.pay_per_delivery_cents   the default and the per-courier override.
--   complete_delivery_stop  0017 + writes the delivery_pay row (the run's courier is credited even if back office closed the stop).
--   fail_delivery_stop      0017 + p_pay: true = pay the rate (the customer's fault: not home, no ID, under 18, refused),
--                           false = no pay, NULL = the owner decides later. Replaces the 2-argument version.
--   owner RPCs              admin_courier_payroll(month), admin_set_courier_pay(order, cents), admin_set_courier_rate(user, cents),
--                           admin_record_courier_payout(...), admin_delete_courier_payout(id) — each re-checks is_admin().
-- =============================================================================

-- ---------- 1. rates --------------------------------------------------------------------------------------
alter table public.business_settings add column if not exists courier_pay_cents integer not null default 0;
alter table public.business_settings drop constraint if exists business_settings_courier_pay_cents_check;
alter table public.business_settings add constraint business_settings_courier_pay_cents_check check (courier_pay_cents >= 0);

alter table public.admin_users add column if not exists pay_per_delivery_cents integer;
alter table public.admin_users drop constraint if exists admin_users_pay_per_delivery_cents_check;
alter table public.admin_users add constraint admin_users_pay_per_delivery_cents_check check (pay_per_delivery_cents is null or pay_per_delivery_cents >= 0);

-- ---------- 2. the frozen pay per delivery and the payouts --------------------------------------------------
create table if not exists public.delivery_pay (
  order_id    uuid primary key references public.orders (id) on delete cascade,
  run_id      uuid references public.delivery_runs (id) on delete set null,
  -- No FK on purpose: removing a courier's login must not erase what he was owed.
  courier_id  uuid not null,
  outcome     text not null check (outcome in ('delivered', 'failed')),
  reason      text,
  pay_cents   integer check (pay_cents is null or pay_cents >= 0),
  happened_at timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid
);
create index if not exists delivery_pay_courier_idx on public.delivery_pay (courier_id, happened_at);

create table if not exists public.courier_payouts (
  id           bigint generated always as identity primary key,
  courier_id   uuid not null,
  month        date not null check (month = date_trunc('month', month)::date),
  amount_cents integer not null check (amount_cents > 0),
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists courier_payouts_courier_idx on public.courier_payouts (courier_id, month);

-- Closed to the API: no grants, RLS on with no policy. Only the SECURITY DEFINER functions below touch them.
revoke all on table public.delivery_pay, public.courier_payouts from public, anon, authenticated;
alter table public.delivery_pay enable row level security;
alter table public.courier_payouts enable row level security;

-- The rate a courier earns per delivery right now: his own override, else the default (internal).
create or replace function public.courier_rate_cents(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select au.pay_per_delivery_cents from public.admin_users au where au.user_id = p_courier_id),
    (select s.courier_pay_cents from public.business_settings s where s.id = 1),
    0);
$$;
revoke all on function public.courier_rate_cents(uuid) from public, anon, authenticated;

-- ---------- 3. complete / fail a stop: 0017 + the frozen pay -----------------------------------------------
create or replace function public.complete_delivery_stop(p_order_id uuid, p_id_checked boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_courier uuid;
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
  select r.courier_id into v_courier from public.delivery_runs r where r.id = v_order.delivery_run_id;
  if v_courier is not null then
    insert into public.delivery_pay (order_id, run_id, courier_id, outcome, pay_cents)
    values (v_order.id, v_order.delivery_run_id, v_courier, 'delivered', public.courier_rate_cents(v_courier))
    on conflict (order_id) do update
      set outcome = 'delivered', reason = null, pay_cents = excluded.pay_cents, happened_at = now(), decided_at = null, decided_by = null;
  end if;
  perform public.delivery_run_refresh(v_order.delivery_run_id);
  return jsonb_build_object('order_id', v_order.id, 'order_status', 'completed', 'changed', true);
end;
$$;
revoke all on function public.complete_delivery_stop(uuid, boolean) from public, anon;
grant execute on function public.complete_delivery_stop(uuid, boolean) to authenticated;

drop function if exists public.fail_delivery_stop(uuid, text);
create or replace function public.fail_delivery_stop(p_order_id uuid, p_reason text, p_pay boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_courier uuid;
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
  select r.courier_id into v_courier from public.delivery_runs r where r.id = v_order.delivery_run_id;
  if v_courier is not null then
    insert into public.delivery_pay (order_id, run_id, courier_id, outcome, reason, pay_cents)
    values (v_order.id, v_order.delivery_run_id, v_courier, 'failed', v_reason,
            case when p_pay is true then public.courier_rate_cents(v_courier) when p_pay is false then 0 else null end)
    on conflict (order_id) do update
      set outcome = 'failed', reason = excluded.reason, pay_cents = excluded.pay_cents, happened_at = now(), decided_at = null, decided_by = null;
  end if;
  perform public.delivery_run_refresh(v_order.delivery_run_id);
  return jsonb_build_object('order_id', v_order.id, 'order_status', 'delivery_failed', 'changed', true);
end;
$$;
revoke all on function public.fail_delivery_stop(uuid, text, boolean) from public, anon;
grant execute on function public.fail_delivery_stop(uuid, text, boolean) to authenticated;

-- ---------- 4. the owner's view and controls (is_admin() only) ----------------------------------------------
create or replace function public.admin_courier_payroll(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Jerusalem')::date))::date;
  v_to   date;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  v_to := (v_from + interval '1 month')::date;

  return (
    with month_pay as (
      select dp.*, o.order_number, o.delivery_fee_cents, o.street, o.house_number, r.run_date, w.departure_time
        from public.delivery_pay dp
        join public.orders o on o.id = dp.order_id
        left join public.delivery_runs r on r.id = dp.run_id
        left join public.delivery_windows w on w.id = r.window_id
       where (dp.happened_at at time zone 'Asia/Jerusalem') >= v_from
         and (dp.happened_at at time zone 'Asia/Jerusalem') <  v_to
    ),
    ids as (
      select au.user_id as id from public.admin_users au where au.role = 'courier' or au.can_courier
      union select mp.courier_id from month_pay mp
      union select cp.courier_id from public.courier_payouts cp where cp.month = v_from
    ),
    couriers as (
      select jsonb_build_object(
        'courier_id', ids.id,
        'name', coalesce(nullif(btrim(au.display_name), ''), u.email, 'שליח'),
        'phone', au.phone,
        'email', u.email,
        'active', coalesce(au.role = 'courier' or au.can_courier, false),
        'rate_override_cents', au.pay_per_delivery_cents,
        'rate_cents', public.courier_rate_cents(ids.id),
        'delivered', (select count(*) from month_pay mp where mp.courier_id = ids.id and mp.outcome = 'delivered'),
        'failed', (select count(*) from month_pay mp where mp.courier_id = ids.id and mp.outcome = 'failed'),
        'pending', (select count(*) from month_pay mp where mp.courier_id = ids.id and mp.outcome = 'failed' and mp.pay_cents is null),
        'runs', (select count(distinct mp.run_id) from month_pay mp where mp.courier_id = ids.id),
        'days', (select count(distinct (mp.happened_at at time zone 'Asia/Jerusalem')::date) from month_pay mp where mp.courier_id = ids.id),
        'pay_cents', (select coalesce(sum(mp.pay_cents), 0) from month_pay mp where mp.courier_id = ids.id),
        'paid_cents', (select coalesce(sum(cp.amount_cents), 0) from public.courier_payouts cp where cp.courier_id = ids.id and cp.month = v_from),
        'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                    'order_id', mp.order_id,
                    'order_number', mp.order_number,
                    'outcome', mp.outcome,
                    'reason', mp.reason,
                    'pay_cents', mp.pay_cents,
                    'fee_cents', mp.delivery_fee_cents,
                    'happened_at', mp.happened_at,
                    'run_date', mp.run_date,
                    'departure_time', mp.departure_time,
                    'address', btrim(coalesce(mp.street, '') || ' ' || coalesce(mp.house_number, ''))
                  ) order by mp.happened_at), '[]'::jsonb)
                 from month_pay mp where mp.courier_id = ids.id),
        'payouts', (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', cp.id, 'amount_cents', cp.amount_cents, 'note', cp.note, 'created_at', cp.created_at
                    ) order by cp.created_at), '[]'::jsonb)
                   from public.courier_payouts cp where cp.courier_id = ids.id and cp.month = v_from)
      ) as c
      from ids
      left join public.admin_users au on au.user_id = ids.id
      left join auth.users u on u.id = ids.id
    )
    select jsonb_build_object(
      'month', v_from,
      'default_rate_cents', coalesce((select s.courier_pay_cents from public.business_settings s where s.id = 1), 0),
      'couriers', coalesce((select jsonb_agg(c order by c ->> 'name') from couriers), '[]'::jsonb)
    )
  );
end;
$$;
revoke all on function public.admin_courier_payroll(date) from public, anon;
grant execute on function public.admin_courier_payroll(date) to authenticated;

-- The owner decides (or corrects) what one delivery pays — e.g. a failed delivery that was left undecided.
create or replace function public.admin_set_courier_pay(p_order_id uuid, p_pay_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_pay_cents is null or p_pay_cents < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  update public.delivery_pay
     set pay_cents = p_pay_cents, decided_at = now(), decided_by = (select auth.uid())
   where order_id = p_order_id;
  if not found then
    raise exception 'NO_PAY_RECORD';
  end if;
  return jsonb_build_object('order_id', p_order_id, 'pay_cents', p_pay_cents);
end;
$$;
revoke all on function public.admin_set_courier_pay(uuid, integer) from public, anon;
grant execute on function public.admin_set_courier_pay(uuid, integer) to authenticated;

-- A courier's own rate (NULL = back to the default). Applies to deliveries closed from now on; past ones keep what they got.
create or replace function public.admin_set_courier_rate(p_user_id uuid, p_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_cents is not null and p_cents < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  update public.admin_users set pay_per_delivery_cents = p_cents where user_id = p_user_id and (role = 'courier' or can_courier);
  if not found then
    raise exception 'NOT_A_COURIER';
  end if;
  return jsonb_build_object('user_id', p_user_id, 'rate_cents', public.courier_rate_cents(p_user_id));
end;
$$;
revoke all on function public.admin_set_courier_rate(uuid, integer) from public, anon;
grant execute on function public.admin_set_courier_rate(uuid, integer) to authenticated;

create or replace function public.admin_record_courier_payout(p_courier_id uuid, p_month date, p_amount_cents integer, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_month is null then
    raise exception 'INVALID_AMOUNT';
  end if;
  insert into public.courier_payouts (courier_id, month, amount_cents, note, created_by)
  values (p_courier_id, date_trunc('month', p_month)::date, p_amount_cents, nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.admin_record_courier_payout(uuid, date, integer, text) from public, anon;
grant execute on function public.admin_record_courier_payout(uuid, date, integer, text) to authenticated;

create or replace function public.admin_delete_courier_payout(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  delete from public.courier_payouts where id = p_id;
  return jsonb_build_object('id', p_id, 'deleted', found);
end;
$$;
revoke all on function public.admin_delete_courier_payout(bigint) from public, anon;
grant execute on function public.admin_delete_courier_payout(bigint) to authenticated;

-- =============================================================================
-- 0019_courier_history.sql — a courier's own history (numbers only)
-- =============================================================================
-- Run after 0018. Re-runnable. Apply it BEFORE deploying a courier screen that has "ההיסטוריה שלי".
--
-- courier_my_history(month) answers a courier with what HE did in a month: totals (delivered / failed / runs / days worked) and,
-- per run, the slot, when it left and finished, and one line per stop — the order NUMBER, delivered or not, and the failure reason.
-- It deliberately carries NO customer detail (no name, phone, address, items) and NO money (no rate, no pay, no payouts): a courier
-- sees customer details only while he holds a live run, and the owner alone sees pay (0018). Only the caller's own rows are read
-- (auth.uid()); a courier can never ask about somebody else.
-- =============================================================================

create or replace function public.courier_my_history(p_month date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_from date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Jerusalem')::date))::date;
  v_to   date;
begin
  perform public.delivery_assert_courier();
  v_to := (v_from + interval '1 month')::date;

  return (
    with mine as (
      select dp.order_id, dp.run_id, dp.outcome, dp.reason, dp.happened_at, o.order_number
        from public.delivery_pay dp
        join public.orders o on o.id = dp.order_id
       where dp.courier_id = v_uid
         and (dp.happened_at at time zone 'Asia/Jerusalem') >= v_from
         and (dp.happened_at at time zone 'Asia/Jerusalem') <  v_to
    ),
    runs as (
      select r.id, r.run_date, w.departure_time, r.departed_at,
             max(m.happened_at) as finished_at,
             jsonb_agg(jsonb_build_object(
               'order_number', m.order_number, 'outcome', m.outcome, 'reason', m.reason, 'at', m.happened_at
             ) order by m.happened_at, m.order_number) as stops
        from mine m
        join public.delivery_runs r on r.id = m.run_id
        left join public.delivery_windows w on w.id = r.window_id
       group by r.id, r.run_date, w.departure_time, r.departed_at
    )
    select jsonb_build_object(
      'month', v_from,
      'delivered', (select count(*) from mine where outcome = 'delivered'),
      'failed', (select count(*) from mine where outcome = 'failed'),
      'runs', (select count(*) from runs),
      'days', (select count(distinct (happened_at at time zone 'Asia/Jerusalem')::date) from mine),
      'run_list', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'run_id', id, 'run_date', run_date, 'departure_time', departure_time,
                 'departed_at', departed_at, 'finished_at', finished_at, 'stops', stops
               ) order by run_date desc, departed_at desc nulls last)
          from runs), '[]'::jsonb)
    )
  );
end;
$$;
revoke all on function public.courier_my_history(date) from public, anon;
grant execute on function public.courier_my_history(date) to authenticated;

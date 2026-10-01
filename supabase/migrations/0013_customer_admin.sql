-- =============================================================================
-- 0013_customer_admin.sql — the OWNER's view of the club: member list, counts, and an audited audience export
-- =============================================================================
-- Run after 0012. Re-runnable. Changes nothing for guests, members or order handling.
--
-- Access model (see docs/CUSTOMER_PERMISSIONS_AUDIT.md): the owner gets NO direct access to customers /
-- customer_consents / customer_addresses through the table API. Everything below is a SECURITY DEFINER function that
-- re-checks is_admin() (owner only — NOT staff) inside itself and returns exactly the columns the screen needs.
--
--   admin_customer_stats()             headline numbers (members, who can be reached by SMS / e-mail, withdrawn, deleted)
--   admin_list_customers(...)          searchable, filterable, paginated member list (never includes deleted members)
--   admin_export_audience(kind)        the people who may lawfully receive marketing ('sms' | 'email'), or the
--                                      do-not-contact list ('suppression'). EVERY call is logged in customer_exports.
--
-- "May receive marketing" means: not deleted AND the member's LATEST marketing consent is granted AND includes that
-- channel (e-mail also needs an e-mail address on file). Withdrawn and deleted members never appear in an audience;
-- they appear in the suppression list so an outside mailing tool can be kept clean.
-- =============================================================================

-- ---------- 1. export log (append-only, closed to the API) -------------------------------------------
create table if not exists public.customer_exports (
  id          bigint generated always as identity primary key,
  actor_id    uuid,                                   -- no FK on purpose: removing a login must not erase who exported what
  actor_label text not null,                          -- the owner's e-mail at the time
  kind        text not null check (kind in ('sms', 'email', 'suppression')),
  row_count   integer not null check (row_count >= 0),
  created_at  timestamptz not null default now()
);
revoke all on table public.customer_exports from public, anon, authenticated;
alter table public.customer_exports enable row level security;   -- no policy: only the functions below write or read it

-- ---------- 2. internal helpers (not callable through the API) ----------------------------------------
-- The latest marketing consent per member (consents are append-only; the newest row is the current answer).
create or replace function public.customer_marketing_state()
returns table (customer_id uuid, granted boolean, channels text[], changed_at timestamptz, wording_version text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (m.customer_id)
         m.customer_id, m.granted, coalesce(m.channels, '{}'::text[]), m.created_at, m.wording_version
    from public.customer_consents m
   where m.kind = 'marketing'
   order by m.customer_id, m.id desc;
$$;
revoke all on function public.customer_marketing_state() from public, anon, authenticated;

-- Members (never deleted ones) matching a search term and a marketing filter. The term is matched as plain text:
-- LIKE wildcards in it are escaped, and the digits of a phone number match inside the E.164 number.
create or replace function public.customers_filtered(p_term text, p_marketing text)
returns table (
  id uuid, phone_e164 text, first_name text, last_name text, email text, joined_at timestamptz, last_order_at timestamptz,
  marketing boolean, marketing_channels text[], marketing_changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term   text := nullif(btrim(coalesce(p_term, '')), '');
  v_like   text := '%' || replace(replace(replace(coalesce(nullif(btrim(coalesce(p_term, '')), ''), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits text := regexp_replace(regexp_replace(coalesce(p_term, ''), '[^0-9]', '', 'g'), '^0+', '');
begin
  return query
    select c.id, c.phone_e164, c.first_name, c.last_name, c.email, c.joined_at, c.last_order_at,
           coalesce(ms.granted, false), coalesce(ms.channels, '{}'::text[]), ms.changed_at
      from public.customers c
      left join public.customer_marketing_state() ms on ms.customer_id = c.id
     where c.deleted_at is null
       and (
         v_term is null
         or c.first_name ilike v_like escape '\'
         or c.last_name  ilike v_like escape '\'
         or c.email      ilike v_like escape '\'
         or (length(v_digits) >= 3 and c.phone_e164 like '%' || v_digits || '%')
       )
       and case p_marketing
             when 'all'        then true
             when 'consenting' then coalesce(ms.granted, false)
             when 'sms'        then coalesce(ms.granted, false) and 'sms' = any(ms.channels)
             when 'email'      then coalesce(ms.granted, false) and 'email' = any(ms.channels) and c.email is not null   -- same rule as the stats and the export: no address, no e-mail
             when 'withdrawn'  then ms.granted = false
           end;
end;
$$;
revoke all on function public.customers_filtered(text, text) from public, anon, authenticated;

-- ---------- 3. the owner's functions --------------------------------------------------------------------
create or replace function public.admin_customer_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_stats jsonb;
begin
  if not (select public.is_admin()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'members',         count(*) filter (where c.deleted_at is null),
           'joined_30d',      count(*) filter (where c.deleted_at is null and c.joined_at >= now() - interval '30 days'),
           'with_orders',     count(*) filter (where c.deleted_at is null and c.last_order_at is not null),
           'marketing_sms',   count(*) filter (where c.deleted_at is null and coalesce(ms.granted, false) and 'sms' = any(ms.channels)),
           'marketing_email', count(*) filter (where c.deleted_at is null and coalesce(ms.granted, false) and 'email' = any(ms.channels) and c.email is not null),
           'withdrawn',       count(*) filter (where c.deleted_at is null and ms.granted = false),
           'deleted',         count(*) filter (where c.deleted_at is not null)
         )
    into v_stats
    from public.customers c
    left join public.customer_marketing_state() ms on ms.customer_id = c.id;

  return v_stats || jsonb_build_object('last_exports', coalesce((
    select jsonb_object_agg(x.kind, jsonb_build_object('at', x.created_at, 'count', x.row_count))
      from (select distinct on (e.kind) e.kind, e.created_at, e.row_count
              from public.customer_exports e order by e.kind, e.id desc) x
  ), '{}'::jsonb));
end;
$$;

-- p_marketing: 'all' | 'consenting' | 'sms' | 'email' | 'withdrawn'.  Returns { "total": n, "rows": [...] }.
create or replace function public.admin_list_customers(
  p_search    text    default null,
  p_marketing text    default 'all',
  p_limit     integer default 50,
  p_offset    integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total  integer;
  v_rows   jsonb;
begin
  if not (select public.is_admin()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_marketing is null or p_marketing not in ('all', 'consenting', 'sms', 'email', 'withdrawn') then
    raise exception 'INVALID_FILTER';
  end if;

  select count(*) into v_total from public.customers_filtered(p_search, p_marketing);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'phone', p.phone_e164,
           'first_name', p.first_name,
           'last_name', p.last_name,
           'email', p.email,
           'joined_at', p.joined_at,
           'last_order_at', p.last_order_at,
           'orders_count', (select count(*) from public.orders o where o.customer_id = p.id),
           'marketing', p.marketing,
           'marketing_channels', p.marketing_channels,
           'marketing_changed_at', p.marketing_changed_at
         ) order by p.joined_at desc, p.id), '[]'::jsonb)
    into v_rows
    from (
      select * from public.customers_filtered(p_search, p_marketing) f
       order by f.joined_at desc, f.id
       limit v_limit offset v_offset
    ) p;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- p_kind: 'sms' | 'email' (people who may receive marketing on that channel) | 'suppression' (never contact).
-- Returns the rows as a JSON array and records WHO exported WHAT and HOW MANY in customer_exports.
create or replace function public.admin_export_audience(p_kind text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_label text;
  v_rows  jsonb;
begin
  if not (select public.is_admin()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('sms', 'email', 'suppression') then
    raise exception 'INVALID_KIND';
  end if;

  if p_kind = 'sms' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'phone', c.phone_e164, 'first_name', c.first_name, 'last_name', c.last_name,
             'consent_at', ms.changed_at, 'wording_version', ms.wording_version
           ) order by c.joined_at, c.id), '[]'::jsonb)
      into v_rows
      from public.customers c
      join public.customer_marketing_state() ms on ms.customer_id = c.id
     where c.deleted_at is null and ms.granted and 'sms' = any(ms.channels);

  elsif p_kind = 'email' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', c.email, 'first_name', c.first_name, 'last_name', c.last_name, 'phone', c.phone_e164,
             'consent_at', ms.changed_at, 'wording_version', ms.wording_version
           ) order by c.joined_at, c.id), '[]'::jsonb)
      into v_rows
      from public.customers c
      join public.customer_marketing_state() ms on ms.customer_id = c.id
     where c.deleted_at is null and c.email is not null and ms.granted and 'email' = any(ms.channels);

  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'phone', s.phone, 'email', s.email, 'reason', s.reason, 'at', s.at
           ) order by s.at, s.phone), '[]'::jsonb)
      into v_rows
      from (
        select c.phone_e164 as phone, c.email, 'withdrawn'::text as reason, ms.changed_at as at
          from public.customers c
          join public.customer_marketing_state() ms on ms.customer_id = c.id
         where c.deleted_at is null and ms.granted = false
        union all
        select c.phone_e164, null::text, 'deleted'::text, c.deleted_at
          from public.customers c
         where c.deleted_at is not null
      ) s;
  end if;

  select coalesce(u.email, v_uid::text) into v_label from auth.users u where u.id = v_uid;
  insert into public.customer_exports (actor_id, actor_label, kind, row_count)
  values (v_uid, coalesce(v_label, 'owner'), p_kind, jsonb_array_length(v_rows));

  return v_rows;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.admin_customer_stats()', 'public.admin_list_customers(text, text, integer, integer)', 'public.admin_export_audience(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- =============================================================================
-- 0002_rls.sql — admin allow-list, default-deny Row Level Security, grants
-- =============================================================================
-- Run after 0001. Re-runnable.
--
-- Security model (why the admin area is really private):
--   1. Authentication  = Supabase Auth (public sign-ups must be DISABLED in the
--                        dashboard; the admin user is created manually).
--   2. Authorization   = a row in public.admin_users. Being logged in is NOT
--                        enough: a normal authenticated user gets no access.
--   3. Data protection = RLS is ON for every table and there are NO policies for
--                        the `anon` role at all. Only is_admin() users can read
--                        or write. The public storefront reads the catalog only
--                        through the whitelisted function in 0004
--                        (get_storefront_catalog), never from the tables, so
--                        hidden products, barcodes and stock counts stay private.
--   The /admin route in the frontend is UX only; none of this depends on it.
--
-- NOTE for the future: Supabase auto-grants privileges on NEW tables in `public`
-- to anon/authenticated. Every table you add later MUST get `enable row level
-- security` (and explicit policies), exactly as done below.
-- =============================================================================

-- ---------- admin allow-list -------------------------------------------------
create table if not exists public.admin_users (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Add the (single) admin manually, in the SQL editor, after creating the user in
-- Authentication -> Users. There is deliberately NO client-side way to write here:
--   insert into public.admin_users (user_id)
--   select id from auth.users where email = 'admin@example.com';

-- ---------- is_admin() -------------------------------------------------------
-- SECURITY DEFINER so it can read admin_users regardless of the caller's own
-- privileges; search_path is pinned and everything is schema-qualified.
-- D6 (MFA) switch: to REQUIRE a second factor for every admin action, uncomment the
-- `and ... aal2` line below and re-run this file. (The admin UI then needs an MFA
-- enrollment screen before that line is enabled.)
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
    -- and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- table privileges (defense in depth, on top of RLS) ---------------
-- Start from nothing, then grant only what the admin UI needs. RLS does not
-- restrict TRUNCATE/REFERENCES/TRIGGER, so never grant those to API roles.
revoke all on table public.categories, public.subcategories, public.products, public.admin_users
  from public, anon, authenticated;
revoke all on sequence public.product_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.categories    to authenticated;
grant select, insert, update, delete on table public.subcategories to authenticated;
grant select, insert, update, delete on table public.products      to authenticated;
grant select                          on table public.admin_users   to authenticated;
-- default value of products.id calls nextval() as the inserting role:
grant usage, select on sequence public.product_id_seq to authenticated;

-- ---------- Row Level Security ----------------------------------------------
alter table public.categories    enable row level security;
alter table public.subcategories enable row level security;
alter table public.products      enable row level security;
alter table public.admin_users   enable row level security;

-- Admin-only, all commands. `(select ...)` lets Postgres evaluate is_admin() once
-- per statement instead of once per row.
drop policy if exists categories_admin_all on public.categories;
create policy categories_admin_all on public.categories
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists subcategories_admin_all on public.subcategories;
create policy subcategories_admin_all on public.subcategories
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists products_admin_all on public.products;
create policy products_admin_all on public.products
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- A logged-in user may see ONLY their own allow-list row (lets the admin UI check
-- "am I an admin?"). No insert/update/delete policy exists => nobody can change
-- the allow-list through the API; only the SQL editor / service role can.
drop policy if exists admin_users_select_self on public.admin_users;
create policy admin_users_select_self on public.admin_users
  for select to authenticated
  using (user_id = (select auth.uid()));

-- (No policy is created for `anon` on any table => anon is denied everything.)

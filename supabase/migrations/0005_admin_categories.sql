-- =============================================================================
-- 0005_admin_categories.sql — support for the admin "Categories" screen
-- =============================================================================
-- Run after 0004. Re-runnable.
--
--   1. Slug lock      — a category / subcategory slug can no longer be changed once created.
--                       The slug is the public `#anchor` (#cigarettes, #cigarettes-marlboro) used in links
--                       and bookmarks. The admin screen shows it read-only; this trigger is the safety net
--                       behind the screen, so it cannot be changed by accident even through the API.
--                       (A deliberate change is still possible from the SQL editor:
--                        `alter table public.categories disable trigger categories_slug_immutable;`)
--   2. Atomic reorder — admin_reorder_categories / admin_reorder_subcategories rewrite the whole display
--                       order (10, 20, 30, ...) in ONE transaction, so a failure can never leave a
--                       half-changed order. The list must be exactly the existing rows.
--   3. Product counts — admin_product_counts() returns how many products (including hidden ones) each
--                       category / subcategory holds, in one grouped query (scales past the API's
--                       per-request row limit). Used to explain why something can't be deleted.
--
-- Security: every function here is SECURITY INVOKER, i.e. it runs with the CALLER's rights, so Row Level
-- Security (0002) still decides everything — only an admin can read or change these tables. Execute is
-- revoked from `anon` (Supabase grants it by default) and granted to `authenticated` only. A logged-in
-- non-admin can call them but sees no rows, so the reorder functions reject the request and change nothing.
-- =============================================================================

-- ---------- 1. slug lock ----------------------------------------------------
create or replace function public.prevent_slug_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'slug cannot be changed after creation (it is the public #anchor)'
      using hint = 'Create a new one and move the products, or change it deliberately in the SQL editor.';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_slug_change() from public, anon, authenticated;

drop trigger if exists categories_slug_immutable on public.categories;
create trigger categories_slug_immutable
  before update of slug on public.categories
  for each row execute function public.prevent_slug_change();

drop trigger if exists subcategories_slug_immutable on public.subcategories;
create trigger subcategories_slug_immutable
  before update of slug on public.subcategories
  for each row execute function public.prevent_slug_change();

-- ---------- 2. atomic reorder -----------------------------------------------
create or replace function public.admin_reorder_categories(p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'the list of categories is empty';
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    raise exception 'the list of categories contains duplicates';
  end if;
  if cardinality(p_ids) <> (select count(*) from public.categories)
     or exists (select 1 from unnest(p_ids) as x where not exists (select 1 from public.categories c where c.id = x)) then
    raise exception 'the list must be exactly the existing categories (reload and try again)';
  end if;

  update public.categories c
     set sort_order = t.ord * 10
    from unnest(p_ids) with ordinality as t(id, ord)
   where c.id = t.id;
end;
$$;

create or replace function public.admin_reorder_subcategories(p_category_id uuid, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'the list of subcategories is empty';
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    raise exception 'the list of subcategories contains duplicates';
  end if;
  if cardinality(p_ids) <> (select count(*) from public.subcategories s where s.category_id = p_category_id)
     or exists (
       select 1 from unnest(p_ids) as x
        where not exists (select 1 from public.subcategories s where s.id = x and s.category_id = p_category_id)
     ) then
    raise exception 'the list must be exactly the existing subcategories of this category (reload and try again)';
  end if;

  update public.subcategories s
     set sort_order = t.ord * 10
    from unnest(p_ids) with ordinality as t(id, ord)
   where s.id = t.id and s.category_id = p_category_id;
end;
$$;

revoke all on function public.admin_reorder_categories(uuid[]) from public, anon;
revoke all on function public.admin_reorder_subcategories(uuid, uuid[]) from public, anon;
grant execute on function public.admin_reorder_categories(uuid[]) to authenticated;
grant execute on function public.admin_reorder_subcategories(uuid, uuid[]) to authenticated;

-- ---------- 3. product counts -----------------------------------------------
create or replace function public.admin_product_counts()
returns table (category_id uuid, subcategory_id uuid, product_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.category_id, p.subcategory_id, count(*)
    from public.products p
   group by p.category_id, p.subcategory_id;
$$;

revoke all on function public.admin_product_counts() from public, anon;
grant execute on function public.admin_product_counts() to authenticated;

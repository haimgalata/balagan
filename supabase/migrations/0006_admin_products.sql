-- =============================================================================
-- 0006_admin_products.sql — shared inventory + support for the admin "Products" screen
-- =============================================================================
-- Run after 0005. Re-runnable, EXCEPT the safety guard right below: if it fires, STOP and report the
-- numbers before re-running anything (see its comment).
--
--   1. Shared inventory — replaces the old, INDEPENDENT unit_stock / package_stock counters with ONE
--      shared count in base units (stock_base_units), because the physical store sells the two options
--      from the same pile (a carton of loose packs can be opened; a six-pack is assembled from loose
--      cans). unit_in_stock / package_in_stock become GENERATED (STORED) columns computed from that one
--      count plus two manual "sell this option right now" switches that stay independent of the count:
--
--        unit_in_stock    = unit_available    AND (NOT track_stock OR stock_base_units >= 1)
--        package_in_stock = package_enabled AND package_available AND
--                            (NOT track_stock OR stock_base_units >= package_unit_count)
--
--      track_stock = false (the default) ignores the count entirely — both options are governed purely
--      by their manual switch, exactly like every product today. Being generated columns, both the public
--      catalog (below) and the admin's own filters read the SAME computed value; the formula lives in
--      exactly one place.
--   2. get_storefront_catalog() — unchanged output shape, now reads the generated columns instead of
--      recomputing the old per-option formula. Must stay byte-identical for every existing product
--      (tests/catalog's baseline, and scripts/verify-seed.mjs, both check this).
--   3. admin_reorder_products() — same atomic "rewrite sort_order 10,20,30..." pattern as 0005's category
--      reorder functions, scoped to ONE (category_id, subcategory_id) group at a time (subcategory_id may
--      be NULL — the "no subcategory" group of a category that allows one). The list must be exactly that
--      group's current products, so moving one category/subcategory's products can never reorder another's.
--
-- Security: admin_reorder_products is SECURITY INVOKER, like 0005's functions — Row Level Security (0002)
-- still decides everything. Execute is revoked from anon and granted to authenticated only.
-- =============================================================================

-- ---------- safety guard: refuse to touch real stock data blindly ------------
-- Nobody could have set unit_stock/package_stock through the admin (the Products screen doesn't exist
-- until this migration ships), so both are expected to be 0 for every product. If this ever fires, STOP:
-- report the exact rows (`select id, unit_stock, package_stock from public.products where unit_stock <> 0
-- or package_stock <> 0`) before deciding how to carry them into stock_base_units.
do $$
declare n int;
begin
  select count(*) into n from public.products where unit_stock <> 0 or package_stock <> 0;
  if n > 0 then
    raise exception 'STOP: % product(s) have a non-zero unit_stock/package_stock — report the exact rows before continuing (see the comment above this check)', n;
  end if;
end $$;

-- ---------- 1. shared inventory -----------------------------------------------
alter table public.products
  add column if not exists track_stock      boolean not null default false,
  add column if not exists stock_base_units integer not null default 0;

alter table public.products drop constraint if exists products_stock_base_units_nonneg;
alter table public.products add constraint products_stock_base_units_nonneg check (stock_base_units >= 0);

alter table public.products drop constraint if exists products_unit_stock_nonneg;
alter table public.products drop constraint if exists products_package_stock_nonneg;
alter table public.products drop column if exists unit_track_stock;
alter table public.products drop column if exists unit_stock;
alter table public.products drop column if exists package_track_stock;
alter table public.products drop column if exists package_stock;

alter table public.products drop column if exists unit_in_stock;
alter table public.products drop column if exists package_in_stock;
alter table public.products
  add column unit_in_stock boolean generated always as (
    unit_available and (not track_stock or stock_base_units >= 1)
  ) stored,
  add column package_in_stock boolean generated always as (
    -- package_enabled guards package_unit_count being null: when it is false the whole
    -- expression is false regardless (three-valued logic: false AND anything = false),
    -- so this never errors on a product without a package.
    package_enabled and package_available and (not track_stock or stock_base_units >= package_unit_count)
  ) stored;

-- ---------- 2. get_storefront_catalog(): read the generated columns ----------
create or replace function public.get_storefront_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',      coalesce(c.legacy_id, c.id::text),
          'slug',    c.slug,
          'name_he', c.name_he,
          'name_en', c.name_en,
          'subcategories', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id',      coalesce(s.legacy_id, s.id::text),
                'slug',    s.slug,
                'name_he', s.name_he,
                'name_en', s.name_en
              )
              order by s.sort_order, s.slug
            )
            from public.subcategories s
            where s.category_id = c.id and s.is_visible
          ), '[]'::jsonb)
        )
        order by c.sort_order, c.slug
      )
      from public.categories c
      where c.is_visible
    ), '[]'::jsonb),

    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',          p.id,
          'category',    c.slug,
          'subcategory', s.slug,
          'name_he',     p.name_he,
          'name_en',     p.name_en,
          'brand',       p.brand,
          'description', p.description,
          'image_path',  p.image_path,
          'unit', jsonb_build_object(
            'price', p.unit_price,
            'sale_price',
              case when p.unit_sale_enabled
                    and p.unit_sale_price is not null
                    and p.unit_sale_price < p.unit_price
                   then p.unit_sale_price end,
            'in_stock', p.unit_in_stock
          ),
          'package',
            case when p.package_enabled then
              jsonb_build_object(
                'label',      p.package_label,
                'unit_count', p.package_unit_count,
                'price',      p.package_price,
                'sale_price',
                  case when p.package_sale_enabled
                        and p.package_sale_price is not null
                        and p.package_sale_price < p.package_price
                       then p.package_sale_price end,
                'in_stock', p.package_in_stock
              )
            end
        )
        order by c.sort_order, c.slug, s.sort_order nulls last, s.slug, p.sort_order, length(p.id), p.id
      )
      from public.products p
      join public.categories c on c.id = p.category_id
      left join public.subcategories s on s.id = p.subcategory_id
      where p.is_visible
        and c.is_visible
        and (p.subcategory_id is null or s.is_visible)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_storefront_catalog() from public;
grant execute on function public.get_storefront_catalog() to anon, authenticated;

-- ---------- 3. atomic reorder, scoped to one (category, subcategory) group ---
create or replace function public.admin_reorder_products(p_category_id uuid, p_subcategory_id uuid, p_ids text[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'the list of products is empty';
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    raise exception 'the list of products contains duplicates';
  end if;
  if cardinality(p_ids) <> (
       select count(*) from public.products p
        where p.category_id = p_category_id and p.subcategory_id is not distinct from p_subcategory_id
     )
     or exists (
       select 1 from unnest(p_ids) as x
        where not exists (
          select 1 from public.products p
           where p.id = x and p.category_id = p_category_id and p.subcategory_id is not distinct from p_subcategory_id
        )
     ) then
    raise exception 'the list must be exactly the existing products of this category/subcategory group (reload and try again)';
  end if;

  update public.products p
     set sort_order = t.ord * 10
    from unnest(p_ids) with ordinality as t(id, ord)
   where p.id = t.id;
end;
$$;

revoke all on function public.admin_reorder_products(uuid, uuid, text[]) from public, anon;
grant execute on function public.admin_reorder_products(uuid, uuid, text[]) to authenticated;

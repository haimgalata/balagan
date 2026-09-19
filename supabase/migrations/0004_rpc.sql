-- =============================================================================
-- 0004_rpc.sql — get_storefront_catalog(): the ONLY public read path
-- =============================================================================
-- Run after 0003. Re-runnable.
--
-- The storefront (anonymous visitors) has no access to the tables. It calls this
-- one function, which returns everything the customer-facing site needs in a
-- single round trip, already in display order:
--
--   { "categories": [ { id, slug, name_he, name_en,
--                       subcategories: [ { id, slug, name_he, name_en } ] } ],
--     "products":   [ { id, category, subcategory, name_he, name_en, brand,
--                       description, image_path,
--                       unit:    { price, sale_price|null, in_stock },
--                       package: null | { label, unit_count, price,
--                                         sale_price|null, in_stock } } ] }
--
-- Explicit WHITELIST — these never leave the database through this function:
--   barcode, stock counters (*_stock), *_track_stock, *_available (folded into
--   in_stock), is_visible, sort_order, timestamps, legacy ids of hidden rows, and
--   anything belonging to a hidden product / category / subcategory.
--
-- Rules baked in:
--   * a product is listed only if it, its category and (when set) its subcategory
--     are all visible;
--   * sale_price is non-null only when that option's sale is enabled (and lower
--     than the regular price);
--   * package is null unless package_enabled;
--   * in_stock (per option) = available switch AND (stock not tracked OR stock > 0);
--   * order = category, subcategory, product sort_order, then numeric id — the same
--     order the static catalog renders in today (see tests/baseline/catalog.json).
--
-- SECURITY DEFINER runs as the function owner (bypassing RLS) — that is intended,
-- and safe because the output is the whitelist above. search_path is pinned to
-- empty and every reference is schema-qualified.
-- =============================================================================

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
            'in_stock', (p.unit_available and (not p.unit_track_stock or p.unit_stock > 0))
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
                'in_stock', (p.package_available and (not p.package_track_stock or p.package_stock > 0))
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

-- Callable by the public storefront (and logged-in users), nothing else.
revoke all on function public.get_storefront_catalog() from public;
grant execute on function public.get_storefront_catalog() to anon, authenticated;

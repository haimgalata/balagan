-- =============================================================================
-- 0007_stock_availability.sql — check_stock_availability(): cart-quantity vs. shared stock
-- =============================================================================
-- Run after 0006. Re-runnable.
--
-- Step 7's shared inventory (0006) exposes only unit_in_stock / package_in_stock — "can this option be
-- bought AT ALL" — never a number, so the storefront had no way to know whether a requested QUANTITY still
-- fits the shared stock_base_units pool. This function answers exactly that, for one or more products at
-- once, without ever exposing the pool size, track_stock, or anything else about a product:
--
--   input:  [{ "product_id": "12", "base_units": 7 }, ...]   -- base_units = the PROPOSED total for that
--                                                                product across ALL its cart lines (units +
--                                                                packages, converted to base units), computed
--                                                                by the caller — never the raw stock number
--   output: [{ "product_id": "12", "available": true }, ...]
--
-- available = NOT track_stock OR stock_base_units >= base_units (product not found, hidden, or its
-- category/subcategory hidden => false). Nothing else about the row is returned. This deliberately does NOT
-- re-check unit_available / package_available — that stays exactly as get_storefront_catalog() already
-- computes it (the option-level gate); this is purely the additional, shared-pool QUANTITY question, layered
-- on top of it. It is a UX safeguard, not a reservation or a security boundary: nothing here locks or
-- deducts stock, and a future real order-processing system must still revalidate everything server-side.
-- =============================================================================

create or replace function public.check_stock_availability(p_items jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', item ->> 'product_id',
        'available', coalesce((
          select not p.track_stock or p.stock_base_units >= greatest((item ->> 'base_units')::int, 0)
          from public.products p
          join public.categories c on c.id = p.category_id
          left join public.subcategories s on s.id = p.subcategory_id
          where p.id = item ->> 'product_id'
            and p.is_visible
            and c.is_visible
            and (p.subcategory_id is null or s.is_visible)
        ), false)
      )
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(p_items) as item;
$$;

-- Callable by the public storefront (and logged-in users), same as get_storefront_catalog().
revoke all on function public.check_stock_availability(jsonb) from public;
grant execute on function public.check_stock_availability(jsonb) to anon, authenticated;

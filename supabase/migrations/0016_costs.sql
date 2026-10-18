-- =============================================================================
-- 0016_costs.sql — suppliers, purchase costs, net profit, single-pack barcodes (OWNER ONLY)
-- =============================================================================
-- Run after 0015. Re-runnable. Changes nothing customers see.
--
-- First scope (owner decisions, Oct 2026): cigarettes, three suppliers (Philip Morris, Globrands, Dubek), costs taken
-- from supplier invoices, barcodes ONLY for the single pack (never the carton — a carton barcode at the till would
-- sell a carton at the pack price), only the owner scans or sees costs.
--
--   suppliers         who the store buys from + how their invoices price cigarettes ('pack' or 'carton' of N).
--   product_costs     the CURRENT cost of one unit (pack), BEFORE VAT, as on the invoice. A separate table — not a
--                     column on products — so a cost can never leak through anything that reads products.
--   cost_history      every cost ever recorded (invoice line or manual edit), append-only: shows price rises.
--   supplier_items    the "dictionary": supplier code (or, for a supplier without codes, the text printed on the
--                     invoice) -> product + how many units one supplier unit holds. Matched once, recognised after.
--   barcode_blocklist carton barcodes the owner marked "not a single pack": scanning one again warns instead of saving.
--   products.review_note   a short "needs a look" note (e.g. price not from the POS, created while scanning). Admin only.
--   business_settings.vat_percent / low_margin_percent   VAT used to compute net profit, and the "low profit" line.
--
-- Net profit per unit = sale price / (1 + VAT) - cost before VAT   (e.g. 42 / 1.18 - 33.46 = 2.13 ₪, 6%).
-- None of this is exposed by get_storefront_catalog() / get_business_settings() / create_order().
-- =============================================================================

-- ---------- 1. tables ---------------------------------------------------------------------------------
create table if not exists public.suppliers (
  id          text primary key check (id ~ '^[a-z0-9-]+$'),
  name        text not null check (btrim(name) <> ''),
  price_unit  text not null default 'carton' check (price_unit in ('pack', 'carton')),
  carton_size integer not null default 10 check (carton_size > 0),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.suppliers (id, name, price_unit, carton_size, sort_order) values
  ('philip-morris', 'פיליפ מוריס', 'pack', 10, 10),
  ('globrands', 'גלוברנדס', 'carton', 10, 20),
  ('dubek', 'דובק', 'carton', 10, 30)
on conflict (id) do nothing;

create table if not exists public.product_costs (
  product_id       text primary key references public.products (id) on delete cascade,
  supplier_id      text references public.suppliers (id) on delete set null,
  unit_cost_ex_vat numeric(10,2) check (unit_cost_ex_vat is null or unit_cost_ex_vat >= 0),
  source           text check (source is null or source in ('invoice', 'manual')),
  updated_at       timestamptz not null default now()
);
create index if not exists product_costs_supplier_idx on public.product_costs (supplier_id);

create table if not exists public.cost_history (
  id               bigint generated always as identity primary key,
  product_id       text not null references public.products (id) on delete cascade,
  supplier_id      text references public.suppliers (id) on delete set null,
  unit_cost_ex_vat numeric(10,2) not null check (unit_cost_ex_vat >= 0),
  source           text not null check (source in ('invoice', 'manual')),
  invoice_number   text,
  invoice_date     date,
  quantity_units   integer,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid()
);
create index if not exists cost_history_product_idx on public.cost_history (product_id, created_at desc, id desc);
create unique index if not exists cost_history_invoice_line_key
  on public.cost_history (supplier_id, invoice_number, product_id) where invoice_number is not null;

create table if not exists public.supplier_items (
  id                      bigint generated always as identity primary key,
  supplier_id             text not null references public.suppliers (id) on delete cascade,
  supplier_code           text,
  supplier_text           text,
  product_id              text not null references public.products (id) on delete cascade,
  units_per_supplier_unit integer not null default 1 check (units_per_supplier_unit > 0),
  created_at              timestamptz not null default now(),
  constraint supplier_items_key_present check (nullif(btrim(coalesce(supplier_code, supplier_text, '')), '') is not null)
);
create unique index if not exists supplier_items_code_key on public.supplier_items (supplier_id, supplier_code) where supplier_code is not null;
create unique index if not exists supplier_items_text_key on public.supplier_items (supplier_id, supplier_text) where supplier_code is null;

create table if not exists public.barcode_blocklist (
  barcode    text primary key check (btrim(barcode) <> '' and barcode = btrim(barcode)),
  note       text,
  created_at timestamptz not null default now()
);

alter table public.products add column if not exists review_note text;
alter table public.products drop constraint if exists products_review_note_ok;
alter table public.products add constraint products_review_note_ok
  check (review_note is null or (btrim(review_note) <> '' and char_length(review_note) <= 120));

alter table public.business_settings add column if not exists vat_percent numeric(5,2) not null default 18;
alter table public.business_settings add column if not exists low_margin_percent numeric(5,2) not null default 5;
alter table public.business_settings drop constraint if exists business_settings_cost_settings_ok;
alter table public.business_settings add constraint business_settings_cost_settings_ok
  check (vat_percent >= 0 and vat_percent < 100 and low_margin_percent >= 0 and low_margin_percent < 100);

-- a barcode on the blocklist can never be saved as a product's barcode
create or replace function public.products_barcode_not_blocked()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.barcode is not null and exists (select 1 from public.barcode_blocklist b where b.barcode = new.barcode) then
    raise exception 'BARCODE_BLOCKED' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.products_barcode_not_blocked() from public, anon, authenticated;
drop trigger if exists products_barcode_not_blocked on public.products;
create trigger products_barcode_not_blocked before insert or update of barcode on public.products
  for each row execute function public.products_barcode_not_blocked();

-- ---------- 2. privileges + RLS (owner only, the coupons pattern) ---------------------------------
revoke all on table public.suppliers, public.product_costs, public.cost_history, public.supplier_items, public.barcode_blocklist
  from public, anon, authenticated;
grant select on public.suppliers to authenticated;
grant select on public.product_costs to authenticated;          -- written only by admin_set_product_cost() / the SQL editor
grant select on public.cost_history to authenticated;           -- append-only, written by the same
grant select, insert, update, delete on public.supplier_items to authenticated;
grant select, insert, delete on public.barcode_blocklist to authenticated;

alter table public.suppliers         enable row level security;
alter table public.product_costs     enable row level security;
alter table public.cost_history      enable row level security;
alter table public.supplier_items    enable row level security;
alter table public.barcode_blocklist enable row level security;

drop policy if exists suppliers_owner on public.suppliers;
create policy suppliers_owner on public.suppliers for select to authenticated using ((select public.is_admin()));
drop policy if exists product_costs_owner on public.product_costs;
create policy product_costs_owner on public.product_costs for select to authenticated using ((select public.is_admin()));
drop policy if exists cost_history_owner on public.cost_history;
create policy cost_history_owner on public.cost_history for select to authenticated using ((select public.is_admin()));
drop policy if exists supplier_items_owner on public.supplier_items;
create policy supplier_items_owner on public.supplier_items for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists barcode_blocklist_owner on public.barcode_blocklist;
create policy barcode_blocklist_owner on public.barcode_blocklist for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------- 3. admin_set_product_cost(): manual cost / supplier change, always with a history row --------
-- p_cost_ex_vat null = keep the current cost (e.g. only the supplier changes).
create or replace function public.admin_set_product_cost(p_product_id text, p_supplier_id text, p_cost_ex_vat numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_costs;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'SUPPLIER_NOT_FOUND';
  end if;
  if p_cost_ex_vat is not null and (p_cost_ex_vat < 0 or p_cost_ex_vat > 100000) then
    raise exception 'INVALID_COST';
  end if;

  insert into public.product_costs as pc (product_id, supplier_id, unit_cost_ex_vat, source, updated_at)
  values (p_product_id, p_supplier_id, round(p_cost_ex_vat, 2), case when p_cost_ex_vat is not null then 'manual' end, now())
  on conflict (product_id) do update set
    supplier_id = excluded.supplier_id,
    unit_cost_ex_vat = coalesce(excluded.unit_cost_ex_vat, pc.unit_cost_ex_vat),
    source = case when excluded.unit_cost_ex_vat is not null then 'manual' else pc.source end,
    updated_at = case when excluded.unit_cost_ex_vat is not null then now() else pc.updated_at end
  returning * into v_row;

  if p_cost_ex_vat is not null then
    insert into public.cost_history (product_id, supplier_id, unit_cost_ex_vat, source)
    values (p_product_id, p_supplier_id, round(p_cost_ex_vat, 2), 'manual');
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.admin_set_product_cost(text, text, numeric) from public, anon;
grant execute on function public.admin_set_product_cost(text, text, numeric) to authenticated;

-- ---------- 4. admin_cost_overview(): the costs screen in one call --------------------------------
-- Every cigarette product, and every other product that has a cost: what it sells for NOW (the active unit sale price
-- when there is one), its supplier and cost, whether it has a barcode, and its review note.
create or replace function public.admin_cost_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings record;
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select vat_percent, low_margin_percent into v_settings from public.business_settings where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name_he,
      'category', c.slug,
      'subcategory', s.name_he,
      'is_visible', p.is_visible,
      'sale_price', case when p.unit_sale_enabled and p.unit_sale_price is not null and p.unit_sale_price < p.unit_price
                         then p.unit_sale_price else p.unit_price end,
      'has_barcode', p.barcode is not null,
      'review_note', p.review_note,
      'supplier_id', pc.supplier_id,
      'unit_cost_ex_vat', pc.unit_cost_ex_vat,
      'cost_source', pc.source,
      'cost_updated_at', case when pc.unit_cost_ex_vat is not null then pc.updated_at end,
      'previous_cost_ex_vat', (select h.unit_cost_ex_vat from public.cost_history h where h.product_id = p.id
                                order by h.created_at desc, h.id desc offset 1 limit 1)
    ) order by s.sort_order nulls last, p.name_he), '[]'::jsonb)
    into v_rows
    from public.products p
    join public.categories c on c.id = p.category_id
    left join public.subcategories s on s.id = p.subcategory_id
    left join public.product_costs pc on pc.product_id = p.id
   where c.slug = 'cigarettes' or pc.unit_cost_ex_vat is not null;

  return jsonb_build_object(
    'vat_percent', coalesce(v_settings.vat_percent, 18),
    'low_margin_percent', coalesce(v_settings.low_margin_percent, 5),
    'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order), '[]'::jsonb) from public.suppliers),
    'products', v_rows);
end;
$$;
revoke all on function public.admin_cost_overview() from public, anon;
grant execute on function public.admin_cost_overview() to authenticated;

-- =============================================================================
-- 0001_schema.sql — Balagan product database: tables, constraints, indexes
-- =============================================================================
-- Run ONCE, first, on a fresh Supabase project (SQL editor). Plain CREATE
-- statements on purpose: if a table already exists this fails loudly instead
-- of silently clobbering data. 0002-0004 are re-runnable.
--
-- Model (see the approved plan):
--   * one products row  = one storefront card
--   * a required UNIT option, plus at most ONE optional PACKAGE option
--     (custom label such as "מארז"/"פקט"/"שישייה", a unit count, its own
--     independently editable regular price)
--   * unit and package each have their own optional sale (price + enabled flag),
--     their own manual availability switch and their own optional stock counter.
--     Nothing links unit stock to package stock (business decision deferred).
--   * NO global pack-pricing formula exists anywhere in the schema.
--
-- Security: this file only creates structure. Row Level Security, grants and
-- the admin allow-list are in 0002; the public catalog function is in 0004.
-- =============================================================================

-- ---------- shared trigger: keep updated_at fresh ---------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- categories -------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,                       -- e.g. 'cat-cigarettes' (id used by the old static data)
  slug        text not null unique,              -- e.g. 'cigarettes'; used in URLs/anchors (#cigarettes)
  name_he     text not null,
  name_en     text,
  is_visible  boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_slug_format check (slug ~ '^[a-z0-9][a-z0-9&_-]*$'),
  constraint categories_name_he_not_blank check (btrim(name_he) <> '')
);

-- ---------- subcategories ----------------------------------------------------
create table public.subcategories (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,                      -- e.g. 'sub-marlboro'
  category_id  uuid not null references public.categories (id) on delete restrict,
  slug         text not null,                    -- unique PER CATEGORY (marlboro exists in both cigarettes and tobacco)
  name_he      text not null,
  name_en      text,
  is_visible   boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint subcategories_slug_per_category unique (category_id, slug),
  -- lets products reference (subcategory, category) together so a product can
  -- never point at a subcategory of a different category:
  constraint subcategories_id_category_key unique (id, category_id),
  constraint subcategories_slug_format check (slug ~ '^[a-z0-9][a-z0-9&_-]*$'),
  constraint subcategories_name_he_not_blank check (btrim(name_he) <> '')
);
create index subcategories_category_id_idx on public.subcategories (category_id);

-- ---------- products ---------------------------------------------------------
-- Ids stay TEXT: the existing catalog uses "1".."148" (with gaps) and customers'
-- saved carts reference them. The seed (step 2) inserts those ids verbatim; new
-- products get the next value of product_id_seq, which starts at 149.
create sequence public.product_id_seq as bigint start with 149 minvalue 149;

create table public.products (
  id              text primary key default (nextval('public.product_id_seq')::text),
  category_id     uuid not null references public.categories (id) on delete restrict,
  subcategory_id  uuid,

  name_he         text not null,
  name_en         text,
  brand           text,
  description     text,
  barcode         text,
  -- Storage object path inside bucket 'product-images' (NOT a URL). NULL => the
  -- storefront keeps using today's placeholder / category-art fallback.
  image_path      text,

  -- ----- UNIT option (required) -----
  unit_price         numeric(10,2) not null,
  unit_sale_enabled  boolean       not null default false,
  unit_sale_price    numeric(10,2),
  unit_available     boolean       not null default true,    -- manual "in stock" switch
  unit_track_stock   boolean       not null default false,   -- optional counter, manually maintained
  unit_stock         integer       not null default 0,

  -- ----- PACKAGE option (optional, at most one per product) -----
  package_enabled        boolean       not null default false,
  package_label          text,                               -- e.g. 'מארז', 'פקט', 'שישייה'
  package_unit_count     integer,                            -- descriptive; does NOT feed any price
  package_price          numeric(10,2),                      -- independently editable REGULAR package price
  package_sale_enabled   boolean       not null default false,
  package_sale_price     numeric(10,2),
  package_available      boolean       not null default true,
  package_track_stock    boolean       not null default false,
  package_stock          integer       not null default 0,

  is_visible      boolean     not null default true,         -- published on the storefront
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- a product's subcategory must belong to the product's own category
  constraint products_subcategory_matches_category
    foreign key (subcategory_id, category_id)
    references public.subcategories (id, category_id) on delete restrict,

  constraint products_id_numeric        check (id ~ '^[0-9]+$'),
  constraint products_name_he_not_blank check (btrim(name_he) <> ''),
  constraint products_barcode_clean     check (barcode is null or (btrim(barcode) <> '' and barcode = btrim(barcode))),
  constraint products_image_path_safe   check (image_path is null or image_path ~ '^products/[A-Za-z0-9._/-]+$'),

  constraint products_unit_price_nonneg check (unit_price >= 0),
  constraint products_unit_sale_price_nonneg check (unit_sale_price is null or unit_sale_price >= 0),
  constraint products_unit_sale_valid   check (
    not unit_sale_enabled or (unit_sale_price is not null and unit_sale_price < unit_price)
  ),
  constraint products_unit_stock_nonneg check (unit_stock >= 0),

  constraint products_package_count_min check (package_unit_count is null or package_unit_count > 1),
  constraint products_package_label_len check (package_label is null or char_length(package_label) <= 30),
  constraint products_package_price_nonneg check (package_price is null or package_price >= 0),
  constraint products_package_sale_price_nonneg check (package_sale_price is null or package_sale_price >= 0),
  constraint products_package_complete  check (
    not package_enabled or (
      package_label is not null and btrim(package_label) <> ''
      and package_unit_count is not null
      and package_price is not null
    )
  ),
  constraint products_package_sale_valid check (
    not package_sale_enabled or (
      package_enabled and package_sale_price is not null and package_sale_price < package_price
    )
  ),
  constraint products_package_stock_nonneg check (package_stock >= 0)
);

alter sequence public.product_id_seq owned by public.products.id;

create unique index products_barcode_key on public.products (barcode) where barcode is not null;
create index products_browse_idx on public.products (category_id, subcategory_id, sort_order);

-- ---------- updated_at triggers ----------------------------------------------
create trigger categories_set_updated_at    before update on public.categories
  for each row execute function public.set_updated_at();
create trigger subcategories_set_updated_at before update on public.subcategories
  for each row execute function public.set_updated_at();
create trigger products_set_updated_at      before update on public.products
  for each row execute function public.set_updated_at();

-- trigger functions are never meant to be called directly / exposed as RPC
revoke all on function public.set_updated_at() from public, anon, authenticated;

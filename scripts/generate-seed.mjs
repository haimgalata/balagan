/**
 * ONE-OFF seed generator (plan step 2): static catalog  ->  supabase/seed.sql
 *
 * Reads src/data/categories.ts + src/data/products.ts (Node >= 22.6 imports the
 * .ts files directly, no dependencies) and writes a single-transaction SQL file
 * that loads the catalog into the Supabase tables created by the migrations.
 *
 * This script is the ONLY place the old global pack rule (10 units, -₪10) is
 * used. It runs once to write literal per-row numbers; after that every
 * package price and sale is ordinary data the admin edits independently
 * (decision D2: regular package price = unit x 10 with an ACTIVE package sale at
 * unit x 10 - 10, which reproduces today's red strikethrough exactly).
 * It is not shipped to the storefront and is not meant to be re-run after launch.
 *
 * Run from the repo root:  node --no-warnings scripts/generate-seed.mjs
 * Output is deterministic (no timestamps).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { products } = await import(new URL("../src/data/products.ts", import.meta.url));
const { categories } = await import(new URL("../src/data/categories.ts", import.meta.url));
const pricing = await import(new URL("./legacy/old-pricing.mjs", import.meta.url));

// ---- the one-off migration rule (decision D2), in exact integer cents -----------
const UNITS_PER_PACKAGE = 10;
const PACKAGE_DISCOUNT_CENTS = 10 * 100;
const PACKAGE_LABEL = "פקט";
const cents = (n) => Math.round(n * 100);
const money = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

// ---- SQL literal helpers -----------------------------------------------------------
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const b = (v) => (v ? "true" : "false");
const subcategorySlugOf = (p) => p.subcategorySlug ?? p.brand.toLowerCase().replace(/\s+/g, "-"); // same as CategorySection

// ---- integrity checks BEFORE writing anything -------------------------------------------
const problems = [];
const catSlugs = new Set(categories.map((c) => c.slug));
const subKey = new Set(categories.flatMap((c) => c.subcategories.map((s) => `${c.slug}/${s.slug}`)));
const ids = new Set();
for (const p of products) {
  if (!/^[0-9]+$/.test(p.id)) problems.push(`non-numeric id ${p.id}`);
  if (ids.has(p.id)) problems.push(`duplicate id ${p.id}`);
  ids.add(p.id);
  if (!catSlugs.has(p.category)) problems.push(`product ${p.id}: unknown category ${p.category}`);
  if (!subKey.has(`${p.category}/${subcategorySlugOf(p)}`)) problems.push(`product ${p.id}: no subcategory ${p.category}/${subcategorySlugOf(p)}`);
  const u = cents(p.unitPrice);
  // exact-cent package values must equal what the OLD pricing.ts produced for the storefront
  if (Math.abs(((u * UNITS_PER_PACKAGE) / 100) - pricing.getRegularPackPrice(p.unitPrice)) > 1e-6) problems.push(`product ${p.id}: regular package differs from old pricing`);
  if (Math.abs(((u * UNITS_PER_PACKAGE - PACKAGE_DISCOUNT_CENTS) / 100) - pricing.getPackPrice(p.unitPrice)) > 1e-6) problems.push(`product ${p.id}: package sale differs from old pricing`);
  if (u * UNITS_PER_PACKAGE - PACKAGE_DISCOUNT_CENTS <= 0) problems.push(`product ${p.id}: package sale would be <= 0`);
}
if (Math.max(...[...ids].map(Number)) >= 149) problems.push("an existing id is >= 149 (would collide with product_id_seq)");
if (problems.length) { console.error("Refusing to generate:\n - " + problems.join("\n - ")); process.exit(1); }

// ---- expected numbers (also embedded as post-load assertions in the SQL) -----------
const perCategory = categories.map((c) => ({ slug: c.slug, n: products.filter((p) => p.category === c.slug).length }));
const unavailable = products.filter((p) => !p.inStock).map((p) => p.id);
const totals = { categories: categories.length, subcategories: subKey.size, products: products.length };

// ---- build SQL ------------------------------------------------------------------------------
const L = [];
const catRows = categories.map((c, i) => `  (${q(c.id)}, ${q(c.slug)}, ${q(c.name)}, ${(i + 1) * 10})`);
const subRows = categories.flatMap((c) =>
  c.subcategories.map((s, i) => `  (${q(c.slug)}, ${q(s.id)}, ${q(s.slug)}, ${q(s.name)}, ${(i + 1) * 10})`));
const prodRows = products.map((p, index) => {
  const u = cents(p.unitPrice);
  const regular = u * UNITS_PER_PACKAGE;
  const sale = regular - PACKAGE_DISCOUNT_CENTS;
  return `  (${q(p.id)}, ${q(p.category)}, ${q(subcategorySlugOf(p))}, ${q(p.name)}, ${q(p.brand)}, ${q(p.description ?? null)}, ` +
    `${money(u)}, ${money(regular)}, ${money(sale)}, ${b(p.inStock)}, ${index * 10})`;
});

L.push(`-- =============================================================================
-- seed.sql — loads the existing static catalog into Supabase (plan step 2)
-- =============================================================================
-- GENERATED by scripts/generate-seed.mjs from src/data/categories.ts and
-- src/data/products.ts (tag baseline/pre-product-management). Do not edit by hand;
-- regenerate instead. Run ONCE, in the SQL editor, AFTER migrations 0001-0004.
--
-- Contents: ${totals.categories} categories, ${totals.subcategories} subcategories, ${totals.products} products with their ORIGINAL ids
-- ("1".."148", gaps preserved) and display order (sort_order = position in products.ts x 10).
--
-- Per product (decision D2 — reproduces today's storefront exactly):
--   unit    : price as today, no sale, available = today's inStock
--   package : label '${PACKAGE_LABEL}', ${UNITS_PER_PACKAGE} units, regular price = unit x ${UNITS_PER_PACKAGE} (shown in red strikethrough),
--             ACTIVE package sale = unit x ${UNITS_PER_PACKAGE} - ${PACKAGE_DISCOUNT_CENTS / 100} (the price customers pay today), available = today's inStock
--   stock counters off, everything visible, no barcode / English name / image (yet)
-- These are plain literal values from now on: each package price and sale is
-- independently editable in the admin; nothing recomputes them.
--
-- Safety: one transaction (all-or-nothing). It REFUSES to run if any category,
-- subcategory or product already exists, and it verifies its own result before
-- committing (counts, placement, prices, availability, id sequence untouched).
-- Explicit ids do not consume product_id_seq, so the next new product gets 149.
-- =============================================================================

begin;

do $$
begin
  if exists (select 1 from public.products)
     or exists (select 1 from public.subcategories)
     or exists (select 1 from public.categories) then
    raise exception 'seed refused: categories/subcategories/products are not empty (this seed is for a fresh database)';
  end if;
end
$$;

insert into public.categories (legacy_id, slug, name_he, sort_order) values
${catRows.join(",\n")};

insert into public.subcategories (category_id, legacy_id, slug, name_he, sort_order)
select c.id, v.legacy_id, v.slug, v.name_he, v.sort_order
from (values
${subRows.join(",\n")}
) as v(category_slug, legacy_id, slug, name_he, sort_order)
join public.categories c on c.slug = v.category_slug;

insert into public.products (
  id, category_id, subcategory_id, name_he, brand, description,
  unit_price,
  package_enabled, package_label, package_unit_count, package_price,
  package_sale_enabled, package_sale_price,
  unit_available, package_available, sort_order
)
select
  v.id, c.id, s.id, v.name_he, v.brand, v.description,
  v.unit_price::numeric(10,2),
  true, '${PACKAGE_LABEL}', ${UNITS_PER_PACKAGE}, v.package_price::numeric(10,2),
  true, v.package_sale_price::numeric(10,2),
  v.in_stock, v.in_stock, v.sort_order
from (values
${prodRows.join(",\n")}
) as v(id, category_slug, subcategory_slug, name_he, brand, description, unit_price, package_price, package_sale_price, in_stock, sort_order)
join public.categories c on c.slug = v.category_slug
join public.subcategories s on s.category_id = c.id and s.slug = v.subcategory_slug;

-- ---- verify before committing: any failure raises and rolls EVERYTHING back --------
do $$
declare
  n_cat int; n_sub int; n_prod int; n_pkg int; n_unavail text; seq_last bigint; seq_called boolean;
begin
  select count(*) into n_cat  from public.categories;
  select count(*) into n_sub  from public.subcategories;
  select count(*) into n_prod from public.products;
  if n_cat <> ${totals.categories} or n_sub <> ${totals.subcategories} or n_prod <> ${totals.products} then
    raise exception 'seed check failed: expected ${totals.categories}/${totals.subcategories}/${totals.products} categories/subcategories/products, got %/%/%', n_cat, n_sub, n_prod;
  end if;
${perCategory.map((c) => `  if (select count(*) from public.products p join public.categories c on c.id = p.category_id where c.slug = ${q(c.slug)}) <> ${c.n} then
    raise exception 'seed check failed: category ${c.slug} should have ${c.n} products';
  end if;`).join("\n")}
  if exists (select 1 from public.products where subcategory_id is null) then
    raise exception 'seed check failed: a product has no subcategory';
  end if;
  select count(*) into n_pkg from public.products
   where package_enabled and package_sale_enabled and package_label = '${PACKAGE_LABEL}' and package_unit_count = ${UNITS_PER_PACKAGE}
     and package_price = unit_price * ${UNITS_PER_PACKAGE} and package_sale_price = package_price - ${PACKAGE_DISCOUNT_CENTS / 100}
     and not unit_sale_enabled;
  if n_pkg <> ${totals.products} then
    raise exception 'seed check failed: package/sale values wrong on % rows', ${totals.products} - n_pkg;
  end if;
  select string_agg(id, ',' order by id::int) into n_unavail from public.products where not unit_available or not package_available;
  if n_unavail is distinct from '${[...unavailable].sort((a, b2) => a - b2).join(",")}' then
    raise exception 'seed check failed: unavailable products are %, expected ${[...unavailable].sort((a, b2) => a - b2).join(",")}', n_unavail;
  end if;
  select last_value, is_called into seq_last, seq_called from public.product_id_seq;
  if seq_last <> 149 or seq_called then
    raise exception 'seed check failed: product_id_seq was consumed (last_value %, is_called %)', seq_last, seq_called;
  end if;
end
$$;

commit;
`);

const sql = L.join("\n");
const outPath = resolve(root, "supabase", "seed.sql");
writeFileSync(outPath, sql, "utf8");

console.log(`wrote ${outPath} (${sql.length} bytes, sha256 ${createHash("sha256").update(sql).digest("hex").slice(0, 16)}…)`);
console.log(`categories=${totals.categories} subcategories=${totals.subcategories} products=${totals.products} per-category=${perCategory.map((c) => `${c.slug}:${c.n}`).join(",")} unavailable=${unavailable.join(",")}`);
console.log("package values cross-checked against the OLD pricing.ts for every product: OK");

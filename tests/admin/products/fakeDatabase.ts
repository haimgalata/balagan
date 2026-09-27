import { baseline } from "../../catalog/fixtures";
import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the database's admin tables/functions/storage used by the products tests. Seeded
 * from the frozen baseline (2 categories, 32 subcategories, 141 products, each migrated with today's package
 * — see supabase/seed.sql) and mirrors the rules validated on a real Postgres engine (migrations 0001-0006):
 * shared inventory (unit_in_stock / package_in_stock are DERIVED, never stored, exactly like the real
 * generated columns), search/filter/pagination (Range header + content-range, server-side), the
 * per-(category,subcategory) atomic reorder, barcode uniqueness, and product-images upload/remove.
 *
 * Real-database behaviour is covered separately (the PGlite migration checks, scripts/security-test.mjs, and
 * the optional live spec).
 */
export interface FakeCategory {
  id: string;
  legacy_id: string | null;
  slug: string;
  name_he: string;
  name_en: string | null;
  is_visible: boolean;
  sort_order: number;
}
export interface FakeSubcategory extends FakeCategory {
  category_id: string;
}
export interface FakeProduct {
  id: string;
  category_id: string;
  subcategory_id: string | null;
  name_he: string;
  name_en: string | null;
  brand: string | null;
  description: string | null;
  barcode: string | null;
  image_path: string | null;
  is_visible: boolean;
  sort_order: number;
  unit_price: number;
  unit_sale_enabled: boolean;
  unit_sale_price: number | null;
  unit_available: boolean;
  package_enabled: boolean;
  package_label: string | null;
  package_unit_count: number | null;
  package_price: number | null;
  package_sale_enabled: boolean;
  package_sale_price: number | null;
  package_available: boolean;
  track_stock: boolean;
  stock_base_units: number;
}

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SLUG_FORMAT = /^[a-z0-9][a-z0-9&_-]*$/;
const pgError = (code: string, message: string, status: number, details: string | null = null) => ({ status, body: { code, message, details, hint: null } });

/** Same formula as the real generated columns (supabase/migrations/0006_admin_products.sql). */
function deriveStock(p: FakeProduct): { unit_in_stock: boolean; package_in_stock: boolean } {
  const unit_in_stock = p.unit_available && (!p.track_stock || p.stock_base_units >= 1);
  const package_in_stock = p.package_enabled && p.package_available && (!p.track_stock || p.stock_base_units >= (p.package_unit_count ?? Number.POSITIVE_INFINITY));
  return { unit_in_stock, package_in_stock };
}
const withDerived = (p: FakeProduct) => ({ ...p, ...deriveStock(p) });

export function createFakeDatabase() {
  // ---- seed: same categories/subcategories shape as tests/admin/categories/fakeDatabase.ts -------------
  const categories: FakeCategory[] = baseline.categories.map((c, i) => ({
    id: uuid("c0000000", i + 1), legacy_id: c.id, slug: c.slug, name_he: c.name, name_en: null, is_visible: true, sort_order: (i + 1) * 10,
  }));
  const subcategories: FakeSubcategory[] = [];
  baseline.categories.forEach((c, ci) =>
    c.subcategories.forEach((s, si) =>
      subcategories.push({ id: uuid("50000000", subcategories.length + 1), legacy_id: s.id, category_id: categories[ci].id, slug: s.slug, name_he: s.name, name_en: null, is_visible: true, sort_order: (si + 1) * 10 })
    )
  );
  // every product migrated exactly as scripts/generate-seed.mjs seeds the real database (decision D2)
  const products: FakeProduct[] = baseline.products.map((p) => {
    const category = categories.find((c) => c.slug === p.category)!;
    const sub = subcategories.find((s) => s.category_id === category.id && s.slug === p.subcategory)!;
    return {
      id: p.id, category_id: category.id, subcategory_id: sub.id,
      name_he: p.name, name_en: null, brand: p.brand, description: p.description, barcode: null, image_path: null,
      is_visible: true, sort_order: (p.position + 1) * 10,
      unit_price: p.unitPrice, unit_sale_enabled: false, unit_sale_price: null, unit_available: p.inStock,
      package_enabled: true, package_label: "פקט", package_unit_count: 10, package_price: p.oldPackRegular,
      package_sale_enabled: true, package_sale_price: p.oldPackPrice, package_available: p.inStock,
      track_stock: false, stock_base_units: 0,
    };
  });

  const state = { categories, subcategories, products };
  const log: string[] = [];
  let nextCategoryId = 1000;
  let nextProductId = 2000;
  let failNext: { status: number; body?: unknown } | "network" | null = null;
  let failAll: { status: number; body?: unknown } | null = null;
  const uploadedImages = new Set<string>();

  // ---- the public catalog, derived from the same state (mirrors get_storefront_catalog) ---------
  function catalog() {
    const byOrder = <T extends { sort_order: number; slug: string }>(a: T, b: T) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug);
    const visibleCategories = categories.filter((c) => c.is_visible).sort(byOrder);
    const subsOf = (cid: string) => subcategories.filter((s) => s.category_id === cid && s.is_visible).sort(byOrder);
    const ordered = visibleCategories.flatMap((c) =>
      subsOf(c.id).flatMap((s) => products.filter((p) => p.subcategory_id === s.id && p.is_visible).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).map((p) => ({ p, c, s })))
    );
    return {
      categories: visibleCategories.map((c) => ({
        id: c.legacy_id ?? c.id, slug: c.slug, name_he: c.name_he, name_en: c.name_en,
        subcategories: subsOf(c.id).map((s) => ({ id: s.legacy_id ?? s.id, slug: s.slug, name_he: s.name_he, name_en: s.name_en })),
      })),
      products: ordered.map(({ p, c, s }) => {
        const { unit_in_stock, package_in_stock } = deriveStock(p);
        return {
          id: p.id, category: c.slug, subcategory: s.slug, name_he: p.name_he, name_en: p.name_en, brand: p.brand,
          description: p.description, image_path: p.image_path,
          unit: { price: p.unit_price, sale_price: p.unit_sale_enabled && p.unit_sale_price !== null && p.unit_sale_price < p.unit_price ? p.unit_sale_price : null, in_stock: unit_in_stock },
          package: p.package_enabled
            ? { label: p.package_label, unit_count: p.package_unit_count, price: p.package_price, sale_price: p.package_sale_enabled && p.package_sale_price !== null && p.package_sale_price < (p.package_price ?? 0) ? p.package_sale_price : null, in_stock: package_in_stock }
            : undefined,
        };
      }),
    };
  }

  // ---- generic PostgREST subset ---------------------------------------------------------------
  function matchCondition(row: Record<string, unknown>, cond: string): boolean {
    const m = /^([a-z_]+)\.(ilike|eq)\.(.*)$/.exec(cond);
    if (!m) return false;
    const [, col, op, rawVal] = m;
    const val = row[col];
    if (op === "ilike") return typeof val === "string" && val.toLowerCase().includes(rawVal.replace(/^%|%$/g, "").toLowerCase());
    return String(val) === rawVal;
  }
  function applyFilters<T extends object>(rows: T[], url: URL): T[] {
    let out = rows;
    for (const group of url.searchParams.getAll("or")) {
      const conditions = group.replace(/^\(|\)$/g, "").split(",");
      out = out.filter((row) => conditions.some((c) => matchCondition(row as Record<string, unknown>, c)));
    }
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit", "offset", "or"].includes(key)) continue;
      const eq = /^eq\.(.*)$/.exec(value);
      if (eq) out = out.filter((row) => String((row as Record<string, unknown>)[key]) === eq[1]);
      if (/^is\.null$/.test(value)) out = out.filter((row) => (row as Record<string, unknown>)[key] == null);
    }
    return out;
  }
  function applyOrder<T extends object>(rows: T[], url: URL): T[] {
    const order = url.searchParams.get("order");
    if (!order) return rows;
    const keys = order.split(",").map((part) => { const [column, dir] = part.split("."); return { column, desc: dir === "desc" }; });
    return [...rows].sort((a, b) => {
      for (const { column, desc } of keys) {
        const av = (a as Record<string, unknown>)[column] as string | number, bv = (b as Record<string, unknown>)[column] as string | number;
        if (av === bv) continue;
        return (av < bv ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  function project<T extends object>(rows: T[], url: URL): Partial<T>[] {
    const select = url.searchParams.get("select");
    if (!select || select === "*") return rows;
    const columns = select.split(",");
    return rows.map((row) => Object.fromEntries(columns.map((c) => [c, (row as Record<string, unknown>)[c]])) as Partial<T>);
  }

  function validateCategoryLike(row: FakeCategory, others: FakeCategory[]) {
    if (row.name_he.trim() === "") return pgError("23514", 'new row violates check constraint "categories_name_he_not_blank"', 400);
    if (!SLUG_FORMAT.test(row.slug)) return pgError("23514", 'new row violates check constraint "categories_slug_format"', 400);
    if (others.some((o) => o.slug === row.slug)) return pgError("23505", 'duplicate key value violates unique constraint "categories_slug_key"', 409, `Key (slug)=(${row.slug}) already exists.`);
    return null;
  }
  function validateProductLike(row: FakeProduct, others: FakeProduct[]) {
    if (row.name_he.trim() === "") return pgError("23514", 'new row violates check constraint "products_name_he_not_blank"', 400);
    if (row.unit_price < 0) return pgError("23514", 'new row violates check constraint "products_unit_price_nonneg"', 400);
    if (row.unit_sale_enabled && (row.unit_sale_price === null || row.unit_sale_price >= row.unit_price)) return pgError("23514", 'new row violates check constraint "products_unit_sale_valid"', 400);
    if (row.package_enabled) {
      if (!row.package_label || row.package_label.trim() === "" || !row.package_unit_count || row.package_unit_count <= 1 || row.package_price === null)
        return pgError("23514", 'new row violates check constraint "products_package_complete"', 400);
      if (row.package_sale_enabled && (row.package_sale_price === null || row.package_sale_price >= row.package_price))
        return pgError("23514", 'new row violates check constraint "products_package_sale_valid"', 400);
    }
    if (row.track_stock && row.stock_base_units < 0) return pgError("23514", 'new row violates check constraint "products_stock_base_units_nonneg"', 400);
    if (row.barcode && others.some((o) => o.barcode === row.barcode)) return pgError("23505", 'duplicate key value violates unique constraint "products_barcode_key"', 409, `Key (barcode)=(${row.barcode}) already exists.`);
    const sub = row.subcategory_id ? subcategories.find((s) => s.id === row.subcategory_id) : null;
    if (row.subcategory_id && (!sub || sub.category_id !== row.category_id))
      return pgError("23503", 'insert or update on table "products" violates foreign key constraint "products_subcategory_matches_category"', 409);
    return null;
  }

  async function handle(ctx: StubRequestContext): Promise<boolean> {
    const { url, method, body, user, json } = ctx;
    const table = /^\/rest\/v1\/(categories|subcategories|products)$/.exec(url.pathname)?.[1] as "categories" | "subcategories" | "products" | undefined;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    const uploadPath = /^\/storage\/v1\/object\/product-images\/(.+)$/.exec(url.pathname)?.[1];
    const isRemoveCall = url.pathname === "/storage/v1/object/product-images" && method === "DELETE";
    if (!table && !rpc && !uploadPath && !isRemoveCall) return false;

    if (rpc === "get_storefront_catalog") { await json(200, catalog()); return true; }
    if (rpc === "is_admin") return false; // the base stub answers it

    if (failAll) { await json(failAll.status, failAll.body ?? { message: "boom" }); return true; }
    if (failNext) {
      const failure = failNext; failNext = null;
      if (failure === "network") { await ctx.route.abort("connectionrefused"); return true; }
      await json(failure.status, failure.body ?? { message: "boom" });
      return true;
    }

    const send = (r: { status: number; body: unknown }) => json(r.status, r.body);
    const isAdmin = user?.isAdmin === true;
    const preferReturn = /return=representation/.test(ctx.headers["prefer"] ?? "");
    const wantsObject = /vnd\.pgrst\.object/.test(ctx.headers["accept"] ?? "");
    const asBody = (rows: unknown[]) => (wantsObject ? rows[0] ?? null : rows);
    if (!user) { await send(pgError("42501", `permission denied for ${table ? "table " + table : rpc ? "function " + rpc : "storage"}`, 401)); return true; }

    // ---------------- storage (product-images) ----------------
    if (uploadPath) {
      if (!isAdmin) { await send(pgError("42501", "new row violates row-level security policy", 403)); return true; }
      uploadedImages.add(uploadPath);
      log.push(`upload: ${uploadPath}`);
      await json(200, { Key: `product-images/${uploadPath}` });
      return true;
    }
    if (isRemoveCall) {
      if (!isAdmin) { await send(pgError("42501", "new row violates row-level security policy", 403)); return true; }
      const prefixes = ((body as { prefixes?: string[] } | null)?.prefixes ?? []);
      for (const p of prefixes) uploadedImages.delete(p);
      log.push(`remove: ${prefixes.join(",")}`);
      await json(200, prefixes.map((name) => ({ name })));
      return true;
    }

    // ---------------- RPCs ----------------
    if (rpc === "admin_product_counts") {
      if (!isAdmin) { await json(200, []); return true; }
      const groups = new Map<string, { category_id: string; subcategory_id: string | null; product_count: number }>();
      for (const p of products) {
        const key = `${p.category_id}|${p.subcategory_id}`;
        const g = groups.get(key) ?? { category_id: p.category_id, subcategory_id: p.subcategory_id, product_count: 0 };
        g.product_count += 1; groups.set(key, g);
      }
      await json(200, [...groups.values()]); return true;
    }
    if (rpc === "admin_reorder_categories" || rpc === "admin_reorder_subcategories") {
      const args = (body ?? {}) as { p_ids?: string[]; p_category_id?: string };
      const ids = args.p_ids ?? [];
      const scope = rpc === "admin_reorder_categories" ? (isAdmin ? categories : []) : (isAdmin ? subcategories.filter((s) => s.category_id === args.p_category_id) : []);
      if (ids.length === 0 || new Set(ids).size !== ids.length || ids.length !== scope.length || ids.some((id) => !scope.some((row) => row.id === id))) {
        await send(pgError("P0001", "the list must be exactly the existing rows (reload and try again)", 400)); return true;
      }
      ids.forEach((id, i) => { scope.find((row) => row.id === id)!.sort_order = (i + 1) * 10; });
      await json(204 as number, null); return true;
    }
    if (rpc === "admin_reorder_products") {
      const args = (body ?? {}) as { p_ids?: string[]; p_category_id?: string; p_subcategory_id?: string | null };
      const ids = args.p_ids ?? [];
      const scope = isAdmin ? products.filter((p) => p.category_id === args.p_category_id && (p.subcategory_id ?? null) === (args.p_subcategory_id ?? null)) : [];
      if (ids.length === 0 || new Set(ids).size !== ids.length || ids.length !== scope.length || ids.some((id) => !scope.some((row) => row.id === id))) {
        await send(pgError("P0001", "the list must be exactly the existing products of this category/subcategory group (reload and try again)", 400)); return true;
      }
      ids.forEach((id, i) => { scope.find((row) => row.id === id)!.sort_order = (i + 1) * 10; });
      log.push(`reorder products: ${ids.join(",")}`);
      await json(204 as number, null); return true;
    }
    if (rpc) return false;

    // ---------------- tables ----------------
    const rowsOf = (): object[] => (table === "categories" ? categories : table === "subcategories" ? subcategories : table === "products" ? products.map(withDerived) : []);
    if (method === "GET" || method === "HEAD") {
      const visibleRows = isAdmin ? applyFilters(rowsOf(), url) : [];
      const total = visibleRows.length;
      const ordered = applyOrder(visibleRows, url);
      // .range(from, to) in this version of postgrest-js sends `offset`/`limit` QUERY PARAMS, not an HTTP Range header.
      const offsetParam = url.searchParams.get("offset");
      const limitParam = url.searchParams.get("limit");
      let page = ordered;
      let contentRange = total === 0 ? "*/0" : `0-${total - 1}/${total}`;
      if (offsetParam !== null || limitParam !== null) {
        const from = Number(offsetParam ?? 0);
        const limit = limitParam !== null ? Number(limitParam) : total - from;
        page = ordered.slice(from, from + limit);
        const end = Math.min(from + limit - 1, Math.max(total - 1, 0));
        contentRange = total === 0 ? "*/0" : `${Math.min(from, total)}-${Math.max(end, Math.min(from, total))}/${total}`;
      }
      const rows = project(page, url);
      await json(200, method === "HEAD" ? null : asBody(rows), { "content-range": contentRange });
      return true;
    }
    if (!isAdmin) { await send(method === "POST" ? pgError("42501", `new row violates row-level security policy for table "${table}"`, 403) : { status: 200, body: [] }); return true; }

    if (method === "POST") {
      const input = ((Array.isArray(body) ? body[0] : body) ?? {}) as Record<string, unknown>;
      if (table === "products") {
        const base: FakeProduct = {
          id: String(++nextProductId), category_id: "", subcategory_id: null, name_he: "", name_en: null, brand: null, description: null, barcode: null, image_path: null,
          is_visible: true, sort_order: 0, unit_price: 0, unit_sale_enabled: false, unit_sale_price: null, unit_available: true,
          package_enabled: false, package_label: null, package_unit_count: null, package_price: null, package_sale_enabled: false, package_sale_price: null, package_available: true,
          track_stock: false, stock_base_units: 0, ...input,
        };
        const problem = validateProductLike(base, products); if (problem) { await send(problem); return true; }
        products.push(base);
        log.push(`insert products: ${base.name_he}`);
        await json(201, preferReturn ? asBody([withDerived(base)]) : null); return true;
      }
      const base = { id: uuid("f0000000", ++nextCategoryId), legacy_id: null, name_en: null, is_visible: true, sort_order: 0, ...input } as FakeCategory & { category_id?: string };
      if (table === "categories") {
        const problem = validateCategoryLike(base, categories); if (problem) { await send(problem); return true; }
        categories.push(base);
      } else {
        const sub = base as FakeSubcategory;
        const parent = categories.find((c) => c.id === sub.category_id);
        if (!parent) { await send(pgError("23503", 'insert or update on table "subcategories" violates foreign key constraint "subcategories_category_id_fkey"', 409)); return true; }
        const problem = validateCategoryLike(sub, subcategories.filter((s) => s.category_id === sub.category_id)); if (problem) { await send(problem); return true; }
        subcategories.push(sub);
      }
      log.push(`insert ${table}: ${base.slug}`);
      await json(201, preferReturn ? asBody([base]) : null); return true;
    }
    if (method === "PATCH") {
      const targets = applyFilters(rowsOf(), url) as (FakeCategory | FakeProduct)[];
      const patch = (body ?? {}) as Record<string, unknown>;
      for (const targetDerived of targets) {
        if (table === "products") {
          const target = products.find((p) => p.id === targetDerived.id)!;
          const next = { ...target, ...patch } as FakeProduct;
          const problem = validateProductLike(next, products.filter((p) => p !== target)); if (problem) { await send(problem); return true; }
          Object.assign(target, patch);
        } else {
          const target = (table === "categories" ? categories : subcategories).find((r) => r.id === targetDerived.id)!;
          if ("slug" in patch && patch.slug !== target.slug) { await send(pgError("P0001", "slug cannot be changed after creation (it is the public #anchor)", 400)); return true; }
          const next = { ...target, ...patch } as FakeCategory;
          if (next.name_he.trim() === "") { await send(pgError("23514", 'new row violates check constraint "categories_name_he_not_blank"', 400)); return true; }
          Object.assign(target, patch);
        }
      }
      log.push(`update ${table}: ${JSON.stringify(patch)}`);
      const refreshed = table === "products" ? targets.map((t) => withDerived(products.find((p) => p.id === t.id)!)) : targets;
      await json(preferReturn ? 200 : 204, preferReturn ? asBody(refreshed) : null); return true;
    }
    if (method === "DELETE") {
      const targets = applyFilters(rowsOf(), url) as (FakeCategory | FakeProduct)[];
      if (table === "products") {
        for (const t of targets) { const i = products.findIndex((p) => p.id === t.id); if (i >= 0) products.splice(i, 1); }
        log.push(`delete products: ${targets.map((t) => t.id).join(",")}`);
        await json(204, null); return true;
      }
      for (const target of targets as FakeCategory[]) {
        const inUse = table === "categories"
          ? subcategories.some((s) => s.category_id === target.id) || products.some((p) => p.category_id === target.id)
          : products.some((p) => p.subcategory_id === target.id);
        if (inUse) { await send(pgError("23001", `update or delete on table "${table}" violates RESTRICT setting of foreign key constraint`, 409)); return true; }
      }
      const list = table === "categories" ? categories : subcategories;
      for (const target of targets as FakeCategory[]) list.splice(list.indexOf(target), 1);
      log.push(`delete ${table}: ${(targets as FakeCategory[]).map((t) => t.slug).join(",")}`);
      await json(204, null); return true;
    }
    return false;
  }

  return {
    state,
    log,
    handle,
    catalog,
    failNext(failure: NonNullable<typeof failNext>) { failNext = failure; },
    failAll(failure: { status: number; body?: unknown } | null) { failAll = failure; },
    uploadedImages,
    productsOfGroup: (categoryId: string, subcategoryId: string | null) =>
      products.filter((p) => p.category_id === categoryId && (p.subcategory_id ?? null) === subcategoryId).sort((a, b) => a.sort_order - b.sort_order),
  };
}

export type FakeDatabase = ReturnType<typeof createFakeDatabase>;

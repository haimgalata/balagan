import { baseline, buildRpcCatalog } from "../../catalog/fixtures";
import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the database's admin tables and functions, used by the categories tests. It is seeded
 * from the frozen baseline (2 categories, 32 subcategories, 141 products) and mirrors the rules that were validated
 * on a real Postgres engine (supabase/migrations 0001-0005): unique slugs, slug format, non-blank Hebrew name, the
 * slug lock, RESTRICTed deletes, atomic reorder that must list exactly the existing rows, admin-only access.
 *
 * It ALSO answers the public `get_storefront_catalog()` from the same state, so a test can change something in the
 * admin and then look at the real storefront. Real-database behaviour is covered separately (migration tests,
 * scripts/security-test.mjs, and the optional live spec).
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
interface FakeProduct {
  id: string;
  category_id: string;
  subcategory_id: string | null;
  position: number;
}

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SLUG_FORMAT = /^[a-z0-9][a-z0-9&_-]*$/;

/** PostgREST-shaped error response. */
const pgError = (code: string, message: string, status: number, details: string | null = null) => ({ status, body: { code, message, details, hint: null } });

export function createFakeDatabase(options: { migration0005?: boolean } = {}) {
  const migration0005 = options.migration0005 ?? true;
  // ---- seed ------------------------------------------------------------------------------
  const categories: FakeCategory[] = baseline.categories.map((c, i) => ({
    id: uuid("c0000000", i + 1), legacy_id: c.id, slug: c.slug, name_he: c.name, name_en: null, is_visible: true, sort_order: (i + 1) * 10,
  }));
  const subcategories: FakeSubcategory[] = [];
  baseline.categories.forEach((c, ci) =>
    c.subcategories.forEach((s, si) =>
      subcategories.push({ id: uuid("50000000", subcategories.length + 1), legacy_id: s.id, category_id: categories[ci].id, slug: s.slug, name_he: s.name, name_en: null, is_visible: true, sort_order: (si + 1) * 10 })
    )
  );
  const products: FakeProduct[] = baseline.products.map((p, position) => {
    const category = categories.find((c) => c.slug === p.category)!;
    const sub = subcategories.find((s) => s.category_id === category.id && s.slug === p.subcategory)!;
    return { id: p.id, category_id: category.id, subcategory_id: sub.id, position };
  });

  const state = { categories, subcategories, products };
  const log: string[] = [];
  let nextId = 1000;
  /** Make the next data request fail: an HTTP error, or a dropped connection. */
  let failNext: { status: number; body?: unknown } | "network" | null = null;
  /** Make EVERY data request fail until cleared (a one-shot failure is consumed by React StrictMode's double load in dev). */
  let failAll: { status: number; body?: unknown } | null = null;

  // ---- the public catalog, derived from the same state (mirrors get_storefront_catalog) ---------
  function catalog() {
    const template = buildRpcCatalog();
    const templateById = new Map((template.products as { id: string }[]).map((p) => [p.id, p as Record<string, unknown>]));
    const byOrder = <T extends { sort_order: number; slug: string }>(a: T, b: T) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug);
    const visibleCategories = categories.filter((c) => c.is_visible).sort(byOrder);
    const subsOf = (cid: string) => subcategories.filter((s) => s.category_id === cid && s.is_visible).sort(byOrder);
    const ordered = visibleCategories.flatMap((c) =>
      subsOf(c.id).flatMap((s) => products.filter((p) => p.subcategory_id === s.id).sort((a, b) => a.position - b.position).map((p) => ({ p, c, s })))
    );
    return {
      categories: visibleCategories.map((c) => ({
        id: c.legacy_id ?? c.id, slug: c.slug, name_he: c.name_he, name_en: c.name_en,
        subcategories: subsOf(c.id).map((s) => ({ id: s.legacy_id ?? s.id, slug: s.slug, name_he: s.name_he, name_en: s.name_en })),
      })),
      products: ordered.map(({ p, c, s }) => ({ ...templateById.get(p.id)!, category: c.slug, subcategory: s.slug })),
    };
  }

  // ---- generic PostgREST subset -------------------------------------------------------------
  function applyFilters<T extends object>(rows: T[], url: URL): T[] {
    let out = rows;
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      const eq = /^eq\.(.*)$/.exec(value);
      if (eq) out = out.filter((row) => String((row as Record<string, unknown>)[key]) === eq[1]);
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

  function validateCategoryLike(row: FakeCategory, others: FakeCategory[]): { status: number; body: unknown } | null {
    if (row.name_he.trim() === "") return pgError("23514", 'new row violates check constraint "categories_name_he_not_blank"', 400);
    if (!SLUG_FORMAT.test(row.slug)) return pgError("23514", 'new row violates check constraint "categories_slug_format"', 400);
    if (others.some((o) => o.slug === row.slug)) return pgError("23505", 'duplicate key value violates unique constraint "categories_slug_key"', 409, `Key (slug)=(${row.slug}) already exists.`);
    return null;
  }

  async function handle(ctx: StubRequestContext): Promise<boolean> {
    const { url, method, body, user, json } = ctx;
    const table = /^\/rest\/v1\/(categories|subcategories|products)$/.exec(url.pathname)?.[1] as "categories" | "subcategories" | "products" | undefined;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table && !rpc) return false;

    // the public catalog: anyone (anon key) may call it
    if (rpc === "get_storefront_catalog") { await json(200, catalog()); return true; }
    if (rpc === "is_admin") return false; // the base stub answers it

    // migration 0005 not applied: its functions do not exist (PostgREST answers 404 PGRST202)
    if (!migration0005 && rpc && /^admin_/.test(rpc)) {
      await json(404, { code: "PGRST202", message: `Could not find the function public.${rpc} in the schema cache`, details: null, hint: null });
      return true;
    }

    // failure injection (data requests only)
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
    if (!user) { await send(pgError("42501", `permission denied for ${table ? "table " + table : "function " + rpc}`, 401)); return true; }

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
      const noun = rpc === "admin_reorder_categories" ? "categories" : "subcategories";
      if (ids.length === 0) { await send(pgError("P0001", `the list of ${noun} is empty`, 400)); return true; }
      if (new Set(ids).size !== ids.length) { await send(pgError("P0001", `the list of ${noun} contains duplicates`, 400)); return true; }
      if (ids.length !== scope.length || ids.some((id) => !scope.some((row) => row.id === id))) {
        await send(pgError("P0001", `the list must be exactly the existing ${noun}${noun === "subcategories" ? " of this category" : ""} (reload and try again)`, 400)); return true;
      }
      ids.forEach((id, i) => { scope.find((row) => row.id === id)!.sort_order = (i + 1) * 10; });
      log.push(`reorder ${noun}: ${ids.join(",")}`);
      await json(204 as number, null); return true;
    }
    if (rpc) return false;

    // ---------------- tables ----------------
    const rowsOf = (): object[] => (table === "categories" ? categories : table === "subcategories" ? subcategories : products);
    if (method === "GET" || method === "HEAD") {
      const visibleRows = isAdmin ? applyFilters(rowsOf(), url) : [];
      const total = visibleRows.length;
      const rows = project(applyOrder(visibleRows, url), url);
      await json(200, method === "HEAD" ? null : asBody(rows), { "content-range": total === 0 ? "*/0" : `0-${total - 1}/${total}` });
      return true;
    }
    if (!isAdmin) { await send(method === "POST" ? pgError("42501", `new row violates row-level security policy for table "${table}"`, 403) : { status: 200, body: [] }); return true; }
    if (table === "products") { await send(pgError("42501", "products are not editable in this fake", 403)); return true; }

    if (method === "POST") {
      const input = ((Array.isArray(body) ? body[0] : body) ?? {}) as Record<string, unknown>;
      const base = { id: uuid("f0000000", ++nextId), legacy_id: null, name_en: null, is_visible: true, sort_order: 0, ...input } as FakeCategory & { category_id?: string };
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
      const targets = applyFilters(rowsOf(), url) as FakeCategory[];
      const patch = (body ?? {}) as Record<string, unknown>;
      for (const target of targets) {
        if ("slug" in patch && patch.slug !== target.slug) { await send(pgError("P0001", "slug cannot be changed after creation (it is the public #anchor)", 400)); return true; }
        const next = { ...target, ...patch } as FakeCategory;
        if (next.name_he.trim() === "") { await send(pgError("23514", 'new row violates check constraint "categories_name_he_not_blank"', 400)); return true; }
        Object.assign(target, patch);
      }
      log.push(`update ${table}: ${JSON.stringify(patch)}`);
      await json(preferReturn ? 200 : 204, preferReturn ? asBody(targets) : null); return true;
    }
    if (method === "DELETE") {
      const targets = applyFilters(rowsOf(), url) as FakeCategory[];
      for (const target of targets) {
        const inUse = table === "categories"
          ? subcategories.some((s) => s.category_id === target.id) || products.some((p) => p.category_id === target.id)
          : products.some((p) => p.subcategory_id === target.id);
        if (inUse) { await send(pgError("23001", `update or delete on table "${table}" violates RESTRICT setting of foreign key constraint`, 409)); return true; }
      }
      const list = rowsOf() as FakeCategory[];
      for (const target of targets) list.splice(list.indexOf(target), 1);
      log.push(`delete ${table}: ${targets.map((t) => t.slug).join(",")}`);
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
    /** categories in display order */
    categoriesInOrder: () => [...categories].sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug)),
    subcategoriesOf: (categorySlug: string) => {
      const category = categories.find((c) => c.slug === categorySlug)!;
      return subcategories.filter((s) => s.category_id === category.id).sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));
    },
  };
}

export type FakeDatabase = ReturnType<typeof createFakeDatabase>;

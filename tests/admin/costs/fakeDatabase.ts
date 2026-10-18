import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for migration 0016 (costs + barcodes), plugged into stubSupabase's `extra` hook: the
 * admin_cost_overview() / admin_set_product_cost() functions, cost_history, barcode_blocklist, and the parts of products /
 * categories the scan screen touches. Like the database it is owner only, keeps barcodes unique, and refuses a barcode
 * that is on the blocklist (the BARCODE_BLOCKED trigger).
 */
export interface FakeProduct {
  id: string;
  name_he: string;
  slug: "cigarettes" | "tobacco";
  subcategory: string | null;
  unit_price: number;
  unit_sale_enabled: boolean;
  unit_sale_price: number | null;
  barcode: string | null;
  is_visible: boolean;
  review_note: string | null;
  image_path: string | null;
  supplier_id: string | null;
  cost: number | null;
}

export interface FakeHistory {
  id: number;
  product_id: string;
  supplier_id: string | null;
  unit_cost_ex_vat: number;
  source: "invoice" | "manual";
  invoice_number: string | null;
  invoice_date: string | null;
  created_at: string;
}

export interface FakeCosts {
  products: FakeProduct[];
  history: FakeHistory[];
  blocklist: { barcode: string; note: string | null }[];
  setCalls: Record<string, unknown>[];
  inserts: Record<string, unknown>[];
  handle: (context: StubRequestContext) => Promise<boolean>;
}

export const SUPPLIERS = [
  { id: "philip-morris", name: "פיליפ מוריס" },
  { id: "globrands", name: "גלוברנדס" },
  { id: "dubek", name: "דובק" },
];
const SUBS = [
  { id: "sub-marlboro", name_he: "מרלבורו", sort_order: 10 },
  { id: "sub-winston", name_he: "ווינסטון", sort_order: 20 },
  { id: "sub-noblesse", name_he: "נובלס", sort_order: 30 },
];

const p = (over: Partial<FakeProduct> & Pick<FakeProduct, "id" | "name_he">): FakeProduct => ({
  slug: "cigarettes", subcategory: "מרלבורו", unit_price: 42, unit_sale_enabled: false, unit_sale_price: null, barcode: null, is_visible: true,
  review_note: null, image_path: null, supplier_id: "philip-morris", cost: null, ...over,
});

export function seedProducts(): FakeProduct[] {
  return [
    p({ id: "2", name_he: "מרלבורו גולד", cost: 33.46, barcode: "7290000000001" }),
    p({ id: "1", name_he: "מרלבורו אדום", cost: 33.46 }),
    p({ id: "46", name_he: "נקסט ריסס", unit_price: 33, cost: 30.5, review_note: "מחיר לא מהקופה" }), // 33/1.18 = 27.97 → a loss
    p({ id: "4", name_he: "ווינסטון כחול", subcategory: "ווינסטון", unit_price: 36, supplier_id: "globrands", cost: 31.86 }), // 30.51 - 31.86 → loss
    p({ id: "8", name_he: "ווינסטון לבן", subcategory: "ווינסטון", unit_price: 40, supplier_id: "globrands", cost: 32.5 }), // 33.90 - 32.5 = 1.40 · 4.1% → low
    p({ id: "119", name_he: "נובלס", subcategory: "נובלס", unit_price: 38, supplier_id: "dubek", cost: 29.26 }),
    p({ id: "300", name_he: "סיגריה בלי ספק", subcategory: null, supplier_id: null, cost: null }),
    p({ id: "65", name_he: "באלי לבן", slug: "tobacco", subcategory: null, unit_price: 120, supplier_id: "dubek", cost: 89.37 }),
  ];
}

export function createFakeCosts(): FakeCosts {
  let nextId = 900;
  const state: FakeCosts = {
    products: seedProducts(),
    history: [
      { id: 1, product_id: "2", supplier_id: "philip-morris", unit_cost_ex_vat: 32.9, source: "invoice", invoice_number: "0111000001", invoice_date: "2026-09-01", created_at: "2026-09-01T08:00:00Z" },
      { id: 2, product_id: "2", supplier_id: "philip-morris", unit_cost_ex_vat: 33.46, source: "invoice", invoice_number: "0111270741", invoice_date: "2026-10-15", created_at: "2026-10-15T08:00:00Z" },
    ],
    blocklist: [{ barcode: "7290000000999", note: "פקט" }],
    setCalls: [],
    inserts: [],
    handle: async (ctx) => {
      const path = ctx.url.pathname;
      const known = /^\/rest\/v1\/(rpc\/admin_cost_overview|rpc\/admin_set_product_cost|cost_history|barcode_blocklist|products|categories|business_settings)$/.exec(path)?.[1];
      if (!known) return false;
      if (!ctx.user?.isAdmin) {
        await ctx.json(403, { code: "42501", message: "NOT_AUTHORIZED" });
        return true;
      }
      const wantsObject = /vnd\.pgrst\.object/.test(ctx.headers["accept"] ?? "");
      const send = async (rows: unknown[], status = 200) => {
        if (wantsObject && rows.length === 0 && ctx.method === "GET" && !/maybe/.test(ctx.headers["accept"] ?? "")) {
          // supabase-js .maybeSingle() sends the object header too and treats PGRST116 as "no row"
          await ctx.json(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
          return;
        }
        await ctx.json(status, wantsObject ? (rows[0] ?? null) : rows);
      };
      const param = (name: string) => ctx.url.searchParams.get(name) ?? "";
      const eq = (name: string) => /^eq\.(.*)$/.exec(param(name))?.[1];
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const row = (x: FakeProduct) => ({
        id: x.id, name_he: x.name_he, unit_price: x.unit_price, unit_sale_enabled: x.unit_sale_enabled, unit_sale_price: x.unit_sale_price,
        image_path: x.image_path, barcode: x.barcode, is_visible: x.is_visible,
      });

      if (known === "business_settings") {
        await send([{ id: 1, vat_percent: 18, low_margin_percent: 5 }]);
        return true;
      }

      if (known === "rpc/admin_cost_overview") {
        const products = state.products
          .filter((x) => x.slug === "cigarettes" || x.cost !== null)
          .map((x) => {
            const h = state.history.filter((e) => e.product_id === x.id).sort((a, b) => b.id - a.id);
            return {
              id: x.id, name: x.name_he, category: x.slug, subcategory: x.subcategory, is_visible: x.is_visible,
              sale_price: x.unit_sale_enabled && x.unit_sale_price !== null ? x.unit_sale_price : x.unit_price, has_barcode: x.barcode !== null,
              review_note: x.review_note, supplier_id: x.supplier_id, unit_cost_ex_vat: x.cost, cost_source: x.cost === null ? null : h[0]?.source ?? "invoice",
              cost_updated_at: x.cost === null ? null : h[0]?.created_at ?? "2026-10-18T08:00:00Z", previous_cost_ex_vat: h[1]?.unit_cost_ex_vat ?? null,
            };
          });
        await ctx.json(200, { vat_percent: 18, low_margin_percent: 5, suppliers: SUPPLIERS, products });
        return true;
      }

      if (known === "rpc/admin_set_product_cost") {
        state.setCalls.push(body);
        const target = state.products.find((x) => x.id === body.p_product_id);
        if (!target) return void (await ctx.json(400, { code: "P0001", message: "PRODUCT_NOT_FOUND" })) || true;
        const cost = body.p_cost_ex_vat as number | null;
        if (cost !== null && (typeof cost !== "number" || cost < 0)) return void (await ctx.json(400, { code: "P0001", message: "INVALID_COST" })) || true;
        target.supplier_id = (body.p_supplier_id as string | null) ?? null;
        if (cost !== null) {
          target.cost = cost;
          state.history.push({ id: state.history.length + 1, product_id: target.id, supplier_id: target.supplier_id, unit_cost_ex_vat: cost, source: "manual", invoice_number: null, invoice_date: null, created_at: "2026-10-18T09:00:00Z" });
        }
        await ctx.json(200, { product_id: target.id });
        return true;
      }

      if (known === "cost_history") {
        const id = eq("product_id");
        await send(state.history.filter((e) => e.product_id === id).sort((a, b) => b.id - a.id));
        return true;
      }

      if (known === "barcode_blocklist") {
        if (ctx.method === "POST") {
          if (!state.blocklist.some((b) => b.barcode === body.barcode)) state.blocklist.push({ barcode: String(body.barcode), note: (body.note as string) ?? null });
          await ctx.json(201, []);
          return true;
        }
        await send(state.blocklist.filter((b) => b.barcode === eq("barcode")));
        return true;
      }

      if (known === "categories") {
        await send([{ id: "cat-cigarettes", subcategories: SUBS }]);
        return true;
      }

      // ---- products
      if (ctx.method === "GET") {
        let list = state.products;
        const barcode = eq("barcode");
        if (barcode !== undefined) list = list.filter((x) => x.barcode === barcode);
        const ilike = /^ilike\.(.*)$/.exec(param("name_he"))?.[1];
        if (ilike) {
          const term = ilike.replace(/[%*]/g, "");
          list = list.filter((x) => x.name_he.includes(term));
        }
        if (param("categories.slug") === "eq.cigarettes") list = list.filter((x) => x.slug === "cigarettes");
        await send(list.map(row));
        return true;
      }
      if (ctx.method === "PATCH") {
        const target = state.products.find((x) => x.id === eq("id"));
        if (!target) return void (await send([])) || true;
        if (typeof body.barcode === "string") {
          if (state.blocklist.some((b) => b.barcode === body.barcode)) return void (await ctx.json(400, { code: "23514", message: "BARCODE_BLOCKED" })) || true;
          if (state.products.some((x) => x !== target && x.barcode === body.barcode)) {
            return void (await ctx.json(409, { code: "23505", message: 'duplicate key value violates unique constraint "products_barcode_key"' })) || true;
          }
        }
        Object.assign(target, "barcode" in body ? { barcode: body.barcode } : {}, "review_note" in body ? { review_note: body.review_note } : {}, "image_path" in body ? { image_path: body.image_path } : {});
        await send([row(target)]);
        return true;
      }
      if (ctx.method === "POST") {
        state.inserts.push(body);
        const created = p({
          id: String(nextId++), name_he: String(body.name_he), subcategory: SUBS.find((s) => s.id === body.subcategory_id)?.name_he ?? null, unit_price: Number(body.unit_price),
          barcode: (body.barcode as string) ?? null, is_visible: body.is_visible === true, review_note: (body.review_note as string) ?? null, supplier_id: null, cost: null,
        });
        state.products.push(created);
        await send([{ id: created.id }], 201);
        return true;
      }
      await ctx.json(400, { message: "unsupported in stub" });
      return true;
    },
  };
  return state;
}

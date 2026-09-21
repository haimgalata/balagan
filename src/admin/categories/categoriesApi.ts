import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type AdminError, type RawApiError } from "@/admin/categories/categoryErrors";

/**
 * Reads and writes for the categories screen. Everything goes through the signed-in admin's own session, so Row
 * Level Security decides what is allowed (only an admin can read or change these tables); this file only shapes the
 * requests and turns failures into messages. Every function resolves — it never throws.
 */
export interface CategoryRow {
  id: string;
  slug: string;
  name_he: string;
  name_en: string | null;
  is_visible: boolean;
  sort_order: number;
}

export interface SubcategoryRow extends CategoryRow {
  category_id: string;
}

export interface CategoryData {
  /** in display order */
  categories: CategoryRow[];
  /** in display order (per category) */
  subcategories: SubcategoryRow[];
  /** products (hidden ones included) held by each category / subcategory */
  productsByCategory: Record<string, number>;
  productsBySubcategory: Record<string, number>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AdminError };

export interface EditableFields {
  name_he: string;
  name_en: string | null;
  is_visible: boolean;
}

const fail = (error: RawApiError): { ok: false; error: AdminError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: AdminError } =>
  fail({ code: "", message: e instanceof Error ? e.message : String(e) });

const CATEGORY_COLUMNS = "id,slug,name_he,name_en,is_visible,sort_order";
const SUBCATEGORY_COLUMNS = `${CATEGORY_COLUMNS},category_id`;

export async function loadCategoryData(client: SupabaseClient): Promise<ApiResult<CategoryData>> {
  try {
    const [categories, subcategories, counts] = await Promise.all([
      client.from("categories").select(CATEGORY_COLUMNS).order("sort_order").order("slug"),
      client.from("subcategories").select(SUBCATEGORY_COLUMNS).order("sort_order").order("slug"),
      client.rpc("admin_product_counts"),
    ]);
    const error = categories.error ?? subcategories.error ?? counts.error;
    if (error) return fail(error);

    const productsByCategory: Record<string, number> = {};
    const productsBySubcategory: Record<string, number> = {};
    for (const row of (counts.data ?? []) as { category_id: string; subcategory_id: string | null; product_count: number | string }[]) {
      const n = Number(row.product_count);
      productsByCategory[row.category_id] = (productsByCategory[row.category_id] ?? 0) + n;
      if (row.subcategory_id) productsBySubcategory[row.subcategory_id] = (productsBySubcategory[row.subcategory_id] ?? 0) + n;
    }
    return {
      ok: true,
      data: {
        categories: (categories.data ?? []) as CategoryRow[],
        subcategories: (subcategories.data ?? []) as SubcategoryRow[],
        productsByCategory,
        productsBySubcategory,
      },
    };
  } catch (e) {
    return unexpected(e);
  }
}

async function write(run: () => PromiseLike<{ error: RawApiError | null }>): Promise<ApiResult<null>> {
  try {
    const { error } = await run();
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

// ------------------------------------------------------------------ categories
/** `sort_order` MUST be sent explicitly (end of the list): the column default is 0, which would put the new row first. */
export const createCategory = (
  client: SupabaseClient,
  input: EditableFields & { slug: string; sort_order: number }
) => write(() => client.from("categories").insert(input));

export const updateCategory = (client: SupabaseClient, id: string, fields: Partial<EditableFields>) =>
  write(() => client.from("categories").update(fields).eq("id", id));

export const deleteCategory = (client: SupabaseClient, id: string) =>
  write(() => client.from("categories").delete().eq("id", id));

export const reorderCategories = (client: SupabaseClient, orderedIds: string[]) =>
  write(() => client.rpc("admin_reorder_categories", { p_ids: orderedIds }));

// --------------------------------------------------------------- subcategories
export const createSubcategory = (
  client: SupabaseClient,
  input: EditableFields & { slug: string; sort_order: number; category_id: string }
) => write(() => client.from("subcategories").insert(input));

export const updateSubcategory = (client: SupabaseClient, id: string, fields: Partial<EditableFields>) =>
  write(() => client.from("subcategories").update(fields).eq("id", id));

export const deleteSubcategory = (client: SupabaseClient, id: string) =>
  write(() => client.from("subcategories").delete().eq("id", id));

export const reorderSubcategories = (client: SupabaseClient, categoryId: string, orderedIds: string[]) =>
  write(() => client.rpc("admin_reorder_subcategories", { p_category_id: categoryId, p_ids: orderedIds }));

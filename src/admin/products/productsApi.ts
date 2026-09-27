import type { SupabaseClient } from "@supabase/supabase-js";
import { describeError, type AdminError, type RawApiError } from "@/admin/products/productErrors";
import { nextSortOrder } from "@/admin/categories/ordering";

/**
 * Reads and writes for the products screen (both tabs: the searchable list and the per-group ordering
 * view). Everything goes through the signed-in admin's own session, so Row Level Security decides what is
 * allowed; this file only shapes the requests and turns failures into messages. Every function resolves —
 * it never throws.
 */
export interface ProductRow {
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
  unit_in_stock: boolean;
  package_enabled: boolean;
  package_label: string | null;
  package_unit_count: number | null;
  package_price: number | null;
  package_sale_enabled: boolean;
  package_sale_price: number | null;
  package_available: boolean;
  package_in_stock: boolean;
  track_stock: boolean;
  stock_base_units: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AdminError };

const fail = (error: RawApiError): { ok: false; error: AdminError } => ({ ok: false, error: describeError(error) });
const unexpected = (e: unknown): { ok: false; error: AdminError } =>
  fail({ code: "", message: e instanceof Error ? e.message : String(e) });

const PRODUCT_COLUMNS =
  "id,category_id,subcategory_id,name_he,name_en,brand,description,barcode,image_path,is_visible,sort_order," +
  "unit_price,unit_sale_enabled,unit_sale_price,unit_available,unit_in_stock," +
  "package_enabled,package_label,package_unit_count,package_price,package_sale_enabled,package_sale_price,package_available,package_in_stock," +
  "track_stock,stock_base_units";

export const PAGE_SIZE = 50;

export interface ProductFilters {
  /** matched against name (he/en), brand and barcode — across the WHOLE catalog, not just the current page */
  search: string;
  categoryId: string | null;
  subcategoryId: string | null;
  visibility: "all" | "visible" | "hidden";
  /** neither the unit nor the package option is currently purchasable */
  outOfStock: boolean;
  onSale: boolean;
  missingImage: boolean;
  packageOnly: boolean;
}

export const EMPTY_FILTERS: ProductFilters = {
  search: "", categoryId: null, subcategoryId: null, visibility: "all",
  outOfStock: false, onSale: false, missingImage: false, packageOnly: false,
};

/**
 * One page of the FULL, filtered catalog (search/filter/count all happen in the database, never after
 * loading everything into the browser — see admin/products/ProductsPage.tsx for why).
 */
export async function listProducts(client: SupabaseClient, filters: ProductFilters, page: number): Promise<ApiResult<{ rows: ProductRow[]; total: number }>> {
  try {
    let query = client.from("products").select(PRODUCT_COLUMNS, { count: "exact" });
    const term = filters.search.trim().replace(/[%,()]/g, " ").trim();
    if (term) query = query.or(`name_he.ilike.%${term}%,name_en.ilike.%${term}%,brand.ilike.%${term}%,barcode.ilike.%${term}%`);
    if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
    if (filters.subcategoryId) query = query.eq("subcategory_id", filters.subcategoryId);
    if (filters.visibility !== "all") query = query.eq("is_visible", filters.visibility === "visible");
    if (filters.outOfStock) query = query.eq("unit_in_stock", false).eq("package_in_stock", false);
    if (filters.onSale) query = query.or("unit_sale_enabled.eq.true,package_sale_enabled.eq.true");
    if (filters.missingImage) query = query.is("image_path", null);
    if (filters.packageOnly) query = query.eq("package_enabled", true);

    const from = page * PAGE_SIZE;
    const { data, error, count } = await query.order("name_he", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) return fail(error);
    return { ok: true, data: { rows: (data ?? []) as unknown as ProductRow[], total: count ?? 0 } };
  } catch (e) {
    return unexpected(e);
  }
}

/** Every product of ONE (category, subcategory) group, in real storefront order — for the ordering tab. `subcategoryId: null` = the "no subcategory" group. */
export async function loadProductGroup(client: SupabaseClient, categoryId: string, subcategoryId: string | null): Promise<ApiResult<ProductRow[]>> {
  try {
    let query = client.from("products").select(PRODUCT_COLUMNS).eq("category_id", categoryId);
    query = subcategoryId === null ? query.is("subcategory_id", null) : query.eq("subcategory_id", subcategoryId);
    const { data, error } = await query.order("sort_order", { ascending: true }).order("id", { ascending: true });
    if (error) return fail(error);
    return { ok: true, data: (data ?? []) as unknown as ProductRow[] };
  } catch (e) {
    return unexpected(e);
  }
}

/** `sort_order` for a NEW product so it lands at the END of its (category, subcategory) group. */
export async function nextSortOrderInGroup(client: SupabaseClient, categoryId: string, subcategoryId: string | null): Promise<ApiResult<number>> {
  const group = await loadProductGroup(client, categoryId, subcategoryId);
  if (!group.ok) return group;
  return { ok: true, data: nextSortOrder(group.data.map((p) => p.sort_order)) };
}

async function write(run: () => PromiseLike<{ error: RawApiError | null }>): Promise<ApiResult<null>> {
  try {
    const { error } = await run();
    return error ? fail(error) : { ok: true, data: null };
  } catch (e) {
    return unexpected(e);
  }
}

/** Everything the form can set. `id` is chosen once at creation and never editable afterwards (like the rest of the catalog). */
export interface ProductWriteFields {
  category_id: string;
  subcategory_id: string | null;
  name_he: string;
  name_en: string | null;
  brand: string | null;
  description: string | null;
  barcode: string | null;
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
  is_visible: boolean;
}

/** Returns the new row's id — needed so a staged image (picked before the product existed) can be uploaded right after. */
export async function createProduct(client: SupabaseClient, input: ProductWriteFields & { sort_order: number }): Promise<ApiResult<{ id: string }>> {
  try {
    const { data, error } = await client.from("products").insert(input).select("id").single();
    if (error) return fail(error);
    return { ok: true, data: data as { id: string } };
  } catch (e) {
    return unexpected(e);
  }
}

// image_path is deliberately outside ProductWriteFields (the form never sets it — see ImageUploader), but an
// update DOES need to write it, right after a successful storage upload/removal.
export const updateProduct = (client: SupabaseClient, id: string, fields: Partial<ProductWriteFields> & { image_path?: string | null }) =>
  write(() => client.from("products").update(fields).eq("id", id));

export const deleteProduct = (client: SupabaseClient, id: string) => write(() => client.from("products").delete().eq("id", id));

export const reorderProducts = (client: SupabaseClient, categoryId: string, subcategoryId: string | null, orderedIds: string[]) =>
  write(() => client.rpc("admin_reorder_products", { p_category_id: categoryId, p_subcategory_id: subcategoryId, p_ids: orderedIds }));

// ------------------------------------------------------------------------------- image
const IMAGE_EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Public URL of a stored image (the bucket is public-read; no admin session needed to view it). */
export function productImageUrl(client: SupabaseClient, path: string): string {
  return client.storage.from("product-images").getPublicUrl(path).data.publicUrl;
}

/** Client-side mirror of the bucket's own limits (supabase/migrations/0003_storage.sql) — the server enforces them regardless. */
export function validateImageFile(file: File): AdminError | null {
  if (!(file.type in IMAGE_EXTENSION)) return { kind: "invalid-image", message: "יש להעלות קובץ JPEG, PNG או WebP בלבד." };
  if (file.size > MAX_IMAGE_BYTES) return { kind: "invalid-image", message: "התמונה גדולה מדי (עד 2MB)." };
  return null;
}

/**
 * A per-upload unique id for the storage filename — doesn't need to be cryptographically random, just
 * distinct. `crypto.randomUUID()` is restricted to secure contexts (https:/localhost), which made this throw
 * (as an unhandled rejection, since it ran before any try/catch) when an admin opened the dev server from a
 * phone over the LAN by plain-HTTP IP address; this has no such restriction.
 */
function uniqueImageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Uploads a new object under this product's folder and returns its path (does NOT touch products.image_path — the caller saves that separately). */
export async function uploadProductImage(client: SupabaseClient, productId: string, file: File): Promise<ApiResult<string>> {
  const invalid = validateImageFile(file);
  if (invalid) return { ok: false, error: invalid };
  const ext = IMAGE_EXTENSION[file.type];
  const path = `products/${productId}/${uniqueImageId()}.${ext}`;
  try {
    const { error } = await client.storage.from("product-images").upload(path, file, { contentType: file.type, upsert: false });
    if (error) return { ok: false, error: { kind: "invalid-image", message: `העלאת התמונה נכשלה: ${error.message}` } };
    return { ok: true, data: path };
  } catch (e) {
    return unexpected(e);
  }
}

/** Best-effort delete of a stored image object (e.g. after replacing it, or deleting the product). Never blocks the caller on failure. */
export async function removeProductImage(client: SupabaseClient, path: string): Promise<void> {
  try {
    await client.storage.from("product-images").remove([path]);
  } catch {
    /* an orphaned object is harmless; nothing else references it */
  }
}

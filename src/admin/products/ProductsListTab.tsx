import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChevronLeft, ChevronRight, Eye, EyeOff, ImageOff, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { CategoryRow, SubcategoryRow } from "@/admin/categories/categoriesApi";
import { ProductFormDrawer } from "@/admin/products/ProductFormDrawer";
import {
  PAGE_SIZE,
  createProduct,
  deleteProduct,
  nextSortOrderInGroup,
  productImageUrl,
  updateProduct,
  type ProductRow,
  type ProductWriteFields,
} from "@/admin/products/productsApi";
import type { AdminError } from "@/admin/products/productErrors";
import { useProductManager } from "@/admin/products/useProductManager";

interface ProductsListTabProps {
  client: SupabaseClient;
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
}

type FormTarget = { mode: "create" } | { mode: "edit"; row: ProductRow };

type OptionStatus = "available" | "manual-off" | "out-of-stock";
const optionStatus = (available: boolean, inStock: boolean): OptionStatus => (!available ? "manual-off" : inStock ? "available" : "out-of-stock");
const STATUS_LABEL: Record<OptionStatus, string> = { available: "זמין", "manual-off": "כבוי ידנית", "out-of-stock": "אזל מהמלאי" };
const STATUS_CLASS: Record<OptionStatus, string> = {
  available: "border-brand-gold/50 text-brand-gold",
  "manual-off": "border-brand-border text-brand-text-muted",
  "out-of-stock": "border-brand-danger/40 text-brand-danger",
};
function StatusChip({ label, status }: { label: string; status: OptionStatus }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[status]}`}>
      {label}: {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The products LIST tab: search + filters across the WHOLE catalog (server-side — see productsApi.listProducts),
 * 50 rows per page, find/add/edit/hide/delete. Reordering display order is a DIFFERENT tab
 * (ProductsOrderingTab) on purpose — a flat, filtered table mixes unrelated groups, so "up/down" here would
 * be meaningless (or dangerous) across category/subcategory boundaries.
 */
export function ProductsListTab({ client, categories, subcategories }: ProductsListTabProps) {
  const { rows, total, page, setPage, filters, updateFilters, status, loadError, busy, feedback, dismissFeedback, reload, run } = useProductManager(client);
  const [searchText, setSearchText] = useState("");
  const [form, setForm] = useState<FormTarget | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // debounce the search box; every OTHER filter applies immediately (see useProductManager.updateFilters — always resets to page 1)
  useEffect(() => {
    const id = setTimeout(() => {
      if (searchText !== filters.search) updateFilters({ search: searchText });
    }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const categoryFilterSubs = subcategories.filter((s) => s.category_id === filters.categoryId);
  const categoryOf = (id: string) => categories.find((c) => c.id === id)?.name_he ?? "?";
  const subcategoryOf = (id: string | null) => (id ? subcategories.find((s) => s.id === id)?.name_he ?? "?" : "—");

  const closeForm = () => setForm(null);
  const submitCreate = async (values: ProductWriteFields): Promise<AdminError | null> => {
    const sortResult = await nextSortOrderInGroup(client, values.category_id, values.subcategory_id);
    if (!sortResult.ok) return sortResult.error;
    const error = await run(() => createProduct(client, { ...values, sort_order: sortResult.data }), `המוצר "${values.name_he}" נוסף`);
    if (!error) closeForm();
    return error;
  };
  const submitEdit = async (id: string, values: ProductWriteFields): Promise<AdminError | null> => {
    const error = await run(() => updateProduct(client, id, values), "המוצר נשמר");
    if (!error) closeForm();
    return error;
  };
  const toggleVisible = (row: ProductRow) => void run(() => updateProduct(client, row.id, { is_visible: !row.is_visible }), row.is_visible ? `"${row.name_he}" הוסתר` : `"${row.name_he}" מוצג באתר`);
  const confirmDelete = (row: ProductRow) => {
    setConfirmDeleteId(null);
    void run(() => deleteProduct(client, row.id), `"${row.name_he}" נמחק`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-brand-text">רשימת מוצרים</h2>
        <Button onClick={() => setForm({ mode: "create" })} disabled={busy}>
          <Plus size={16} aria-hidden="true" />
          הוספת מוצר
        </Button>
      </div>

      <div aria-live="polite" className="mb-3 min-h-[2.5rem]">
        {feedback && (
          <p
            role={feedback.kind === "error" ? "alert" : "status"}
            className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
              feedback.kind === "error" ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger" : "border-brand-success/40 bg-brand-success/10 text-brand-success"
            }`}
          >
            <span>{feedback.message}</span>
            <button type="button" onClick={dismissFeedback} aria-label="סגור הודעה" className="rounded p-1 outline-none hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold">
              <X size={14} />
            </button>
          </p>
        )}
      </div>

      {/* ---- search + filters ---- */}
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-brand-text-muted" aria-hidden="true" />
          <input
            type="search"
            aria-label="חיפוש מוצרים"
            placeholder="חיפוש לפי שם, מותג או ברקוד — בכל הקטלוג"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full rounded-lg border border-brand-border bg-brand-bg py-2 ps-9 pe-3 text-sm text-brand-text outline-none focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="סינון לפי קטגוריה"
            value={filters.categoryId ?? ""}
            onChange={(e) => updateFilters({ categoryId: e.target.value === "" ? null : e.target.value, subcategoryId: null })}
            className="rounded-md border border-brand-border bg-brand-bg px-2 py-1.5 text-xs text-brand-text"
          >
            <option value="">כל הקטגוריות</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_he}
              </option>
            ))}
          </select>
          <select
            aria-label="סינון לפי תת־קטגוריה"
            value={filters.subcategoryId ?? ""}
            disabled={!filters.categoryId}
            onChange={(e) => updateFilters({ subcategoryId: e.target.value === "" ? null : e.target.value })}
            className="rounded-md border border-brand-border bg-brand-bg px-2 py-1.5 text-xs text-brand-text disabled:opacity-50"
          >
            <option value="">כל תתי־הקטגוריות</option>
            {categoryFilterSubs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name_he}
              </option>
            ))}
          </select>
          <select
            aria-label="סינון לפי הצגה"
            value={filters.visibility}
            onChange={(e) => updateFilters({ visibility: e.target.value as typeof filters.visibility })}
            className="rounded-md border border-brand-border bg-brand-bg px-2 py-1.5 text-xs text-brand-text"
          >
            <option value="all">מוצגים ומוסתרים</option>
            <option value="visible">מוצגים בלבד</option>
            <option value="hidden">מוסתרים בלבד</option>
          </select>
          {[
            { key: "outOfStock" as const, label: "אזל מלאי" },
            { key: "onSale" as const, label: "במבצע" },
            { key: "missingImage" as const, label: "בלי תמונה" },
            { key: "packageOnly" as const, label: "עם אריזה" },
          ].map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 rounded-md border border-brand-border px-2 py-1.5 text-xs text-brand-text">
              <input type="checkbox" checked={filters[key]} onChange={(e) => updateFilters({ [key]: e.target.checked })} className="h-3.5 w-3.5 accent-[rgb(var(--color-gold))]" />
              {label}
            </label>
          ))}
        </div>
      </div>

      {status === "loading" && !rows ? (
        <div role="status" className="flex items-center justify-center gap-2 py-16 text-brand-text-muted">
          <Loader2 size={22} className="animate-spin text-brand-gold" aria-hidden="true" />
          טוען מוצרים…
        </div>
      ) : status === "error" || !rows ? (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
          <p role="alert" className="mb-4 text-brand-danger">
            {loadError?.kind === "setup-needed" ? loadError.message : "לא ניתן לטעון את המוצרים כרגע."}
          </p>
          <Button onClick={reload}>נסו שוב</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-brand-border p-8 text-center text-brand-text-muted">לא נמצאו מוצרים מתאימים.</p>
      ) : (
        <>
          <ul data-testid="product-list" className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} data-testid="product-row" data-id={row.id} className="rounded-lg border border-brand-border bg-brand-bg-elevated p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-brand-border bg-brand-bg">
                    {row.image_path ? (
                      <img src={productImageUrl(client, row.image_path)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageOff size={16} className="text-brand-text-muted" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-brand-text">
                      {row.name_he} <span className="font-normal text-brand-text-muted">· {row.brand}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-brand-text-muted">
                      <span>
                        {categoryOf(row.category_id)} › {subcategoryOf(row.subcategory_id)}
                      </span>
                      <span dir="ltr">₪{row.unit_price}{row.unit_sale_enabled ? ` (מבצע ₪${row.unit_sale_price})` : ""}</span>
                      {row.package_enabled && (
                        <span dir="ltr">
                          {row.package_label} ₪{row.package_price}
                          {row.package_sale_enabled ? ` (מבצע ₪${row.package_sale_price})` : ""}
                        </span>
                      )}
                      {!row.is_visible && <span className="rounded bg-brand-bg px-1.5 py-0.5 text-brand-danger">מוסתר</span>}
                      <StatusChip label="יחידה" status={optionStatus(row.unit_available, row.unit_in_stock)} />
                      {row.package_enabled && <StatusChip label={row.package_label ?? "אריזה"} status={optionStatus(row.package_available, row.package_in_stock)} />}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.is_visible}
                      aria-label={`${row.name_he} — מוצג באתר`}
                      disabled={busy}
                      onClick={() => toggleVisible(row)}
                      className="rounded-md p-2 text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-40"
                    >
                      {row.is_visible ? <Eye size={16} /> : <EyeOff size={16} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`עריכה: ${row.name_he}`}
                      disabled={busy}
                      onClick={() => setForm({ mode: "edit", row })}
                      className="rounded-md p-2 text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-40"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label={`מחיקה: ${row.name_he}`}
                      disabled={busy}
                      onClick={() => setConfirmDeleteId(row.id)}
                      className="rounded-md p-2 text-brand-text-muted outline-none transition-colors hover:!text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-40"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {confirmDeleteId === row.id && (
                  <div role="group" aria-label={`אישור מחיקה: ${row.name_he}`} className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm">
                    <span className="flex-1 text-brand-text">למחוק את &quot;{row.name_he}&quot;? הפעולה אינה הפיכה.</span>
                    <Button size="sm" variant="secondary" onClick={() => confirmDelete(row)} disabled={busy} className="!border-brand-danger !text-brand-danger">
                      אישור מחיקה
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)} disabled={busy}>
                      ביטול
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-brand-text-muted">
            <span>
              {total === 0 ? "0 מוצרים" : `${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} מתוך ${total} מוצרים`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="העמוד הקודם"
                disabled={busy || page === 0}
                onClick={() => setPage(page - 1)}
                className="rounded-md p-1.5 outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-30"
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
              <span>
                עמוד {page + 1} מתוך {totalPages}
              </span>
              <button
                type="button"
                aria-label="העמוד הבא"
                disabled={busy || page + 1 >= totalPages}
                onClick={() => setPage(page + 1)}
                className="rounded-md p-1.5 outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-30"
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}

      <ProductFormDrawer
        open={form !== null}
        onClose={closeForm}
        mode={form?.mode ?? "create"}
        client={client}
        categories={categories}
        subcategories={subcategories}
        initial={form?.mode === "edit" ? form.row : undefined}
        presetCategoryId={filters.categoryId ?? undefined}
        onSubmit={(values) => (form?.mode === "edit" ? submitEdit(form.row.id, values) : submitCreate(values))}
        onSaveImage={form?.mode === "edit" ? (path) => run(() => updateProduct(client, form.row.id, { image_path: path }), path ? "התמונה עודכנה" : "התמונה הוסרה") : undefined}
      />
    </div>
  );
}

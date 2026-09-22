import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp, ImageOff, Loader2, X } from "lucide-react";
import type { CategoryRow, SubcategoryRow } from "@/admin/categories/categoriesApi";
import { productImageUrl } from "@/admin/products/productsApi";
import { useProductOrdering } from "@/admin/products/useProductOrdering";

interface ProductsOrderingTabProps {
  client: SupabaseClient;
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
}

const iconButton =
  "rounded-md p-2.5 text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:cursor-not-allowed disabled:opacity-30 sm:p-2";

/**
 * The products ORDERING tab: pick ONE (category, subcategory) group and see it in its real storefront
 * order, with up/down arrows — the same pattern as the Categories screen. Deliberately shows only one group
 * at a time (never a mixed, filtered or searched list): `admin_reorder_products` refuses anything that isn't
 * exactly that group's current products (see supabase/migrations/0006_admin_products.sql), so a product from
 * a different category or subcategory can never end up reordered by mistake, even from here.
 */
export function ProductsOrderingTab({ client, categories, subcategories }: ProductsOrderingTabProps) {
  const { selection, selectGroup, rows, status, loadError, busy, feedback, dismissFeedback, move } = useProductOrdering(client);
  const [categoryId, setCategoryId] = useState("");

  const categorySubs = subcategories.filter((s) => s.category_id === categoryId);
  const categoryHasSubcategories = categorySubs.length > 0;

  const handleCategoryChange = (id: string) => {
    setCategoryId(id);
    if (id === "") {
      selectGroup(null);
      return;
    }
    const subs = subcategories.filter((s) => s.category_id === id);
    // a category with no subcategories at all has exactly one, unambiguous group — jump straight to it
    // (this mirrors CategorySection.tsx: only a category with subcategories groups its products by one)
    selectGroup(subs.length === 0 ? { categoryId: id, subcategoryId: null } : null);
  };
  const handleSubChange = (subId: string) => {
    if (subId === "") {
      selectGroup(null);
      return;
    }
    selectGroup({ categoryId, subcategoryId: subId });
  };

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-brand-text">סדר תצוגה</h2>
      <p className="mb-4 text-sm text-brand-text-muted">בחרו קטגוריה (ותת־קטגוריה, אם יש) כדי לסדר את המוצרים שבה לפי סדר ההצגה באתר.</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="קטגוריה"
          value={categoryId}
          onChange={(e) => handleCategoryChange(e.target.value)}
          className="rounded-md border border-brand-border bg-brand-bg px-2 py-1.5 text-sm text-brand-text"
        >
          <option value="">בחרו קטגוריה</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name_he}
            </option>
          ))}
        </select>
        {categoryHasSubcategories && (
          <select
            aria-label="תת־קטגוריה"
            value={selection?.subcategoryId ?? ""}
            onChange={(e) => handleSubChange(e.target.value)}
            className="rounded-md border border-brand-border bg-brand-bg px-2 py-1.5 text-sm text-brand-text"
          >
            <option value="">בחרו תת־קטגוריה</option>
            {categorySubs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name_he}
              </option>
            ))}
          </select>
        )}
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

      {!selection ? (
        <p className="rounded-lg border border-dashed border-brand-border p-8 text-center text-brand-text-muted">בחרו קטגוריה כדי להתחיל.</p>
      ) : status === "loading" && !rows ? (
        <div role="status" className="flex items-center justify-center gap-2 py-16 text-brand-text-muted">
          <Loader2 size={22} className="animate-spin text-brand-gold" aria-hidden="true" />
          טוען…
        </div>
      ) : status === "error" || !rows ? (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
          <p role="alert" className="mb-4 text-brand-danger">
            {loadError?.message ?? "לא ניתן לטעון את המוצרים כרגע."}
          </p>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-brand-border p-8 text-center text-brand-text-muted">אין עדיין מוצרים בקבוצה הזו.</p>
      ) : (
        <ul data-testid="ordering-list" className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <li key={row.id} data-testid="ordering-row" data-id={row.id} className="flex items-center gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-brand-border bg-brand-bg">
                {row.image_path ? (
                  <img src={productImageUrl(client, row.image_path)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImageOff size={14} className="text-brand-text-muted" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-brand-text">{row.name_he}</p>
                {!row.is_visible && <span className="text-xs text-brand-danger">מוסתר</span>}
              </div>
              <button type="button" className={iconButton} disabled={busy || index === 0} onClick={() => move(row.id, -1)} aria-label={`הזז למעלה: ${row.name_he}`}>
                <ArrowUp size={16} />
              </button>
              <button type="button" className={iconButton} disabled={busy || index === rows.length - 1} onClick={() => move(row.id, 1)} aria-label={`הזז למטה: ${row.name_he}`}>
                <ArrowDown size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

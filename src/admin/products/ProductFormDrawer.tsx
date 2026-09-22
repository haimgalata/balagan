import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import type { CategoryRow, SubcategoryRow } from "@/admin/categories/categoriesApi";
import { ImageUploader } from "@/admin/products/ImageUploader";
import type { ProductRow, ProductWriteFields } from "@/admin/products/productsApi";
import type { AdminError } from "@/admin/products/productErrors";
import { approxPricePerUnit, validateProduct, type ProductDraft, type ProductField } from "@/admin/products/productValidation";

interface ProductFormDrawerProps {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  client: SupabaseClient;
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
  initial?: ProductRow;
  /** create: a category to preselect (e.g. opened from that category's filter). */
  presetCategoryId?: string;
  /** Saves the non-image fields; resolves to the error to show, or null on success (the parent then closes the panel). */
  onSubmit: (values: ProductWriteFields) => Promise<AdminError | null>;
  /** edit only: persists a new/removed image path immediately (see ImageUploader — independent of the rest of the form). */
  onSaveImage?: (path: string | null) => Promise<AdminError | null>;
}

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50";
const checkboxClasses = "h-5 w-5 accent-[rgb(var(--color-gold))]";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-brand-text">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-brand-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Availability status computed the same way the database's generated columns compute it (see 0006_admin_products.sql) — a live preview, purely local, while the admin edits. */
function availabilityNote(available: boolean, trackStock: boolean, stockText: string, requiredUnits: number | null): { text: string; tone: "muted" | "danger" } {
  if (!available) return { text: "כבוי ידנית — לא ניתן לרכישה בכל מצב מלאי.", tone: "danger" };
  if (!trackStock) return { text: "זמין (המלאי אינו נספר עבור מוצר זה).", tone: "muted" };
  const stock = Number(stockText);
  if (!Number.isFinite(stock) || requiredUnits === null) return { text: "יש להזין כמות מלאי תקינה.", tone: "danger" };
  return stock >= requiredUnits
    ? { text: `זמין — המלאי המשותף (${stock}) מספיק.`, tone: "muted" }
    : { text: `אזל מהמלאי המשותף — יש ${stock}, נדרשים ${requiredUnits}.`, tone: "danger" };
}

function ProductForm({
  mode, client, categories, subcategories, initial, presetCategoryId, onSubmit, onSaveImage, onClose,
}: Omit<ProductFormDrawerProps, "open">) {
  const [nameHe, setNameHe] = useState(initial?.name_he ?? "");
  const [nameEn, setNameEn] = useState(initial?.name_en ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [barcode, setBarcode] = useState(initial?.barcode ?? "");
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? presetCategoryId ?? "");
  const [subcategoryId, setSubcategoryId] = useState(initial?.subcategory_id ?? "");
  const [unitPrice, setUnitPrice] = useState(initial ? String(initial.unit_price) : "");
  const [unitSaleEnabled, setUnitSaleEnabled] = useState(initial?.unit_sale_enabled ?? false);
  const [unitSalePrice, setUnitSalePrice] = useState(initial?.unit_sale_price != null ? String(initial.unit_sale_price) : "");
  const [unitAvailable, setUnitAvailable] = useState(initial?.unit_available ?? true);
  const [packageEnabled, setPackageEnabled] = useState(initial?.package_enabled ?? false);
  const [packageLabel, setPackageLabel] = useState(initial?.package_label ?? "");
  const [packageUnitCount, setPackageUnitCount] = useState(initial?.package_unit_count != null ? String(initial.package_unit_count) : "");
  const [packagePrice, setPackagePrice] = useState(initial?.package_price != null ? String(initial.package_price) : "");
  const [packageSaleEnabled, setPackageSaleEnabled] = useState(initial?.package_sale_enabled ?? false);
  const [packageSalePrice, setPackageSalePrice] = useState(initial?.package_sale_price != null ? String(initial.package_sale_price) : "");
  const [packageAvailable, setPackageAvailable] = useState(initial?.package_available ?? true);
  const [trackStock, setTrackStock] = useState(initial?.track_stock ?? false);
  const [stockBaseUnits, setStockBaseUnits] = useState(initial ? String(initial.stock_base_units) : "0");
  const [isVisible, setIsVisible] = useState(initial?.is_visible ?? true);

  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const categorySubcategories = useMemo(() => subcategories.filter((s) => s.category_id === categoryId), [subcategories, categoryId]);
  const categoryHasSubcategories = categorySubcategories.length > 0;

  const draft: ProductDraft = {
    name_he: nameHe, category_id: categoryId, subcategory_id: subcategoryId, barcode,
    unit_price: unitPrice, unit_sale_enabled: unitSaleEnabled, unit_sale_price: unitSalePrice,
    package_enabled: packageEnabled, package_label: packageLabel, package_unit_count: packageUnitCount,
    package_price: packagePrice, package_sale_enabled: packageSaleEnabled, package_sale_price: packageSalePrice,
    track_stock: trackStock, stock_base_units: stockBaseUnits,
  };
  const errors = validateProduct(draft, { categoryHasSubcategories });
  const showError = (field: ProductField) => (submitted ? errors[field] ?? null : null);

  const handleCategoryChange = (id: string) => {
    setCategoryId(id);
    setSubcategoryId(""); // the previous subcategory may belong to a different category
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setGeneralError(null);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    const values: ProductWriteFields = {
      category_id: categoryId,
      subcategory_id: subcategoryId === "" ? null : subcategoryId,
      name_he: nameHe.trim(),
      name_en: nameEn.trim() === "" ? null : nameEn.trim(),
      brand: brand.trim() === "" ? null : brand.trim(),
      description: description.trim() === "" ? null : description.trim(),
      barcode: barcode.trim() === "" ? null : barcode.trim(),
      unit_price: Number(unitPrice),
      unit_sale_enabled: unitSaleEnabled,
      unit_sale_price: unitSaleEnabled ? Number(unitSalePrice) : null,
      unit_available: unitAvailable,
      package_enabled: packageEnabled,
      package_label: packageEnabled ? packageLabel.trim() : null,
      package_unit_count: packageEnabled ? Number(packageUnitCount) : null,
      package_price: packageEnabled ? Number(packagePrice) : null,
      package_sale_enabled: packageEnabled && packageSaleEnabled,
      package_sale_price: packageEnabled && packageSaleEnabled ? Number(packageSalePrice) : null,
      package_available: packageAvailable,
      track_stock: trackStock,
      stock_base_units: trackStock ? Number(stockBaseUnits) : 0,
      is_visible: isVisible,
    };
    const error = await onSubmit(values);
    if (error) {
      setGeneralError(error.message);
      setBusy(false);
    }
  };

  const unitNote = availabilityNote(unitAvailable, trackStock, stockBaseUnits, 1);
  const packageNote = packageEnabled ? availabilityNote(packageAvailable, trackStock, stockBaseUnits, Number(packageUnitCount) || null) : null;
  const perUnitHint = approxPricePerUnit(packagePrice, packageUnitCount);

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5 p-4">
      {mode === "edit" && initial && (
        <ImageUploader
          client={client}
          productId={initial.id}
          imagePath={initial.image_path}
          disabled={busy}
          onSaved={(path) => (onSaveImage ? onSaveImage(path) : Promise.resolve(null))}
        />
      )}

      <Field id="p-name-he" label="שם בעברית" error={showError("name_he")}>
        <input id="p-name-he" type="text" autoFocus autoComplete="off" value={nameHe} onChange={(e) => setNameHe(e.target.value)} className={inputClasses} />
      </Field>
      <Field id="p-name-en" label="שם באנגלית (אופציונלי)">
        <input id="p-name-en" type="text" dir="ltr" autoComplete="off" value={nameEn} onChange={(e) => setNameEn(e.target.value)} className={inputClasses} />
      </Field>
      <Field id="p-brand" label="מותג (אופציונלי)">
        <input id="p-brand" type="text" autoComplete="off" value={brand} onChange={(e) => setBrand(e.target.value)} className={inputClasses} />
      </Field>
      <Field id="p-description" label="תיאור (אופציונלי)">
        <textarea id="p-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClasses} />
      </Field>
      <Field id="p-barcode" label="ברקוד (אופציונלי)">
        <input id="p-barcode" type="text" dir="ltr" autoComplete="off" value={barcode} onChange={(e) => setBarcode(e.target.value)} className={inputClasses} />
      </Field>

      <Field id="p-category" label="קטגוריה" error={submitted && categoryId === "" ? "יש לבחור קטגוריה." : null}>
        <select id="p-category" value={categoryId} onChange={(e) => handleCategoryChange(e.target.value)} className={inputClasses}>
          <option value="">בחרו קטגוריה</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name_he}
            </option>
          ))}
        </select>
      </Field>
      {categoryId !== "" && (
        <Field
          id="p-subcategory"
          label={categoryHasSubcategories ? "תת־קטגוריה" : "תת־קטגוריה (אין לקטגוריה זו תתי־קטגוריות)"}
          error={showError("subcategory_id")}
        >
          <select
            id="p-subcategory"
            value={subcategoryId}
            onChange={(e) => setSubcategoryId(e.target.value)}
            disabled={!categoryHasSubcategories}
            className={inputClasses}
          >
            <option value="">{categoryHasSubcategories ? "בחרו תת־קטגוריה" : "ללא תת־קטגוריה"}</option>
            {categorySubcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name_he}
              </option>
            ))}
          </select>
        </Field>
      )}

      <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border p-3">
        <legend className="px-1 text-sm font-semibold text-brand-text">יחידה</legend>
        <Field id="p-unit-price" label="מחיר יחידה (₪)" error={showError("unit_price")}>
          <input id="p-unit-price" type="number" step="0.01" min="0" dir="ltr" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className={inputClasses} />
        </Field>
        <label className="flex items-center gap-3 text-sm text-brand-text">
          <input type="checkbox" checked={unitSaleEnabled} onChange={(e) => setUnitSaleEnabled(e.target.checked)} className={checkboxClasses} />
          מבצע פעיל על היחידה
        </label>
        {unitSaleEnabled && (
          <Field id="p-unit-sale-price" label="מחיר מבצע ליחידה (₪)" error={showError("unit_sale_price")}>
            <input id="p-unit-sale-price" type="number" step="0.01" min="0" dir="ltr" value={unitSalePrice} onChange={(e) => setUnitSalePrice(e.target.value)} className={inputClasses} />
          </Field>
        )}
        <label className="flex items-center gap-3 text-sm text-brand-text">
          <input type="checkbox" checked={unitAvailable} onChange={(e) => setUnitAvailable(e.target.checked)} className={checkboxClasses} />
          זמינה למכירה כיחידה
        </label>
        <p className={`text-xs ${unitNote.tone === "danger" ? "text-brand-danger" : "text-brand-text-muted"}`}>{unitNote.text}</p>
      </fieldset>

      <label className="flex items-center gap-3 text-sm text-brand-text">
        <input type="checkbox" checked={packageEnabled} onChange={(e) => setPackageEnabled(e.target.checked)} className={checkboxClasses} />
        למוצר יש גם אריזה (למשל פקט / שישייה / מארז)
      </label>

      {packageEnabled && (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border p-3">
          <legend className="px-1 text-sm font-semibold text-brand-text">אריזה</legend>
          <Field id="p-package-label" label="תווית האריזה" hint='למשל "פקט", "שישייה", "מארז"' error={showError("package_label")}>
            <input id="p-package-label" type="text" value={packageLabel} onChange={(e) => setPackageLabel(e.target.value)} className={inputClasses} />
          </Field>
          <Field id="p-package-count" label="כמות יחידות באריזה" error={showError("package_unit_count")}>
            <input id="p-package-count" type="number" step="1" min="2" dir="ltr" value={packageUnitCount} onChange={(e) => setPackageUnitCount(e.target.value)} className={inputClasses} />
          </Field>
          <Field
            id="p-package-price"
            label="מחיר אריזה (₪)"
            hint={perUnitHint !== null ? `≈ ₪${perUnitHint.toFixed(2)} ליחידה בתוך האריזה` : undefined}
            error={showError("package_price")}
          >
            <input id="p-package-price" type="number" step="0.01" min="0" dir="ltr" value={packagePrice} onChange={(e) => setPackagePrice(e.target.value)} className={inputClasses} />
          </Field>
          <label className="flex items-center gap-3 text-sm text-brand-text">
            <input type="checkbox" checked={packageSaleEnabled} onChange={(e) => setPackageSaleEnabled(e.target.checked)} className={checkboxClasses} />
            מבצע פעיל על האריזה
          </label>
          {packageSaleEnabled && (
            <Field id="p-package-sale-price" label="מחיר מבצע לאריזה (₪)" error={showError("package_sale_price")}>
              <input id="p-package-sale-price" type="number" step="0.01" min="0" dir="ltr" value={packageSalePrice} onChange={(e) => setPackageSalePrice(e.target.value)} className={inputClasses} />
            </Field>
          )}
          <label className="flex items-center gap-3 text-sm text-brand-text">
            <input type="checkbox" checked={packageAvailable} onChange={(e) => setPackageAvailable(e.target.checked)} className={checkboxClasses} />
            זמינה למכירה כאריזה
          </label>
          {packageNote && <p className={`text-xs ${packageNote.tone === "danger" ? "text-brand-danger" : "text-brand-text-muted"}`}>{packageNote.text}</p>}
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border p-3">
        <legend className="px-1 text-sm font-semibold text-brand-text">מלאי</legend>
        <label className="flex items-center gap-3 text-sm text-brand-text">
          <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} className={checkboxClasses} />
          לעקוב אחרי כמות במלאי
        </label>
        {trackStock && (
          <Field
            id="p-stock"
            label="כמות במלאי (יחידות בסיס)"
            hint="מלאי משותף ליחידה ולאריזה: מכירת אריזה מפחיתה ממנו את כל היחידות שבה."
            error={showError("stock_base_units")}
          >
            <input id="p-stock" type="number" step="1" min="0" dir="ltr" value={stockBaseUnits} onChange={(e) => setStockBaseUnits(e.target.value)} className={inputClasses} />
          </Field>
        )}
      </fieldset>

      <label className="flex items-center gap-3 text-sm text-brand-text">
        <input type="checkbox" checked={isVisible} onChange={(e) => setIsVisible(e.target.checked)} className={checkboxClasses} />
        מוצג באתר
      </label>

      {generalError && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {generalError}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className="flex-1">
          {busy ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              שומר…
            </>
          ) : (
            "שמירה"
          )}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** Create / edit panel for a product (reuses the shared slide-in `Drawer`). */
export function ProductFormDrawer({ open, onClose, ...formProps }: ProductFormDrawerProps) {
  return (
    <Drawer isOpen={open} onClose={onClose} title={formProps.mode === "create" ? "מוצר חדש" : "עריכת מוצר"} side="right">
      {/* mounted only while open, so every opening starts from a clean form */}
      {open && <ProductForm onClose={onClose} {...formProps} />}
    </Drawer>
  );
}

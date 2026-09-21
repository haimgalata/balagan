import { useState, type FormEvent } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { ERROR_MESSAGES, type AdminError } from "@/admin/categories/categoryErrors";
import { SLUG_MAX_LENGTH, suggestSlug, validateSlug, type SlugProblem } from "@/admin/categories/slug";

export interface CategoryFormValues {
  slug: string;
  name_he: string;
  name_en: string;
  is_visible: boolean;
}

interface CategoryFormDrawerProps {
  open: boolean;
  onClose: () => void;
  kind: "category" | "subcategory";
  mode: "create" | "edit";
  /** Subcategory create: name of the category it is added to (shown as context). */
  parentName?: string;
  initial?: CategoryFormValues;
  /** Slugs already used in the same scope (all categories, or this category's subcategories). */
  takenSlugs: string[];
  /** Category create only: the other categories' slugs, to catch look-alike slugs. */
  otherCategorySlugs?: string[];
  /** Saves; resolves to the error to show, or null on success (the parent then closes the panel). */
  onSubmit: (values: CategoryFormValues) => Promise<AdminError | null>;
}

const SLUG_MESSAGES: Record<SlugProblem, string> = {
  empty: "יש להזין מזהה (slug).",
  format: ERROR_MESSAGES["invalid-slug"],
  "too-long": `המזהה ארוך מדי (עד ${SLUG_MAX_LENGTH} תווים).`,
  taken: ERROR_MESSAGES["duplicate-slug"],
  ambiguous: "המזהה דומה מדי למזהה של קטגוריה אחרת (אחד מהם מתחיל בשני ובמקף) ועלול לפתוח קטגוריה שגויה בקישורים. בחרו מזהה אחר.",
};

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

const TITLES = {
  category: { create: "קטגוריה חדשה", edit: "עריכת קטגוריה" },
  subcategory: { create: "תת־קטגוריה חדשה", edit: "עריכת תת־קטגוריה" },
} as const;

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-brand-text">
        {label}
      </label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-brand-text-muted">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-brand-danger">{error}</p>}
    </div>
  );
}

function CategoryForm({ kind, mode, parentName, initial, takenSlugs, otherCategorySlugs, onSubmit, onClose }: Omit<CategoryFormDrawerProps, "open">) {
  const isCreate = mode === "create";
  const [nameHe, setNameHe] = useState(initial?.name_he ?? "");
  const [nameEn, setNameEn] = useState(initial?.name_en ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(false);
  const [visible, setVisible] = useState(initial?.is_visible ?? true);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<AdminError | null>(null);

  const nameProblem = nameHe.trim() === "";
  const slugProblem = isCreate ? validateSlug(slug, takenSlugs, otherCategorySlugs) : null;
  const showNameError = submitted && nameProblem;
  const showSlugError = isCreate && (submitted || slugEdited) && slugProblem !== null;
  // a duplicate the database reported that the local list did not know about (created in another tab)
  const slugServerError = serverError?.kind === "duplicate-slug" ? serverError.message : null;
  const generalError = serverError && serverError.kind !== "duplicate-slug" ? serverError.message : null;

  const handleEnglishName = (value: string) => {
    setNameEn(value);
    // suggest a slug from the English name until the admin edits the slug by hand
    if (isCreate && !slugEdited) setSlug(suggestSlug(value));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setServerError(null);
    if (nameProblem || slugProblem) return;
    setBusy(true);
    const error = await onSubmit({ slug, name_he: nameHe.trim(), name_en: nameEn.trim(), is_visible: visible });
    if (error) {
      setServerError(error);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5 p-4">
      {parentName && (
        <p className="rounded-md border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text-muted">
          בקטגוריה: <span className="font-medium text-brand-text">{parentName}</span>
        </p>
      )}

      <Field id="cat-name-he" label="שם בעברית" error={showNameError ? ERROR_MESSAGES["blank-name"] : null}>
        <input
          id="cat-name-he"
          name="name_he"
          type="text"
          autoFocus
          autoComplete="off"
          value={nameHe}
          onChange={(event) => setNameHe(event.target.value)}
          aria-invalid={showNameError}
          aria-describedby={showNameError ? "cat-name-he-error" : undefined}
          className={inputClasses}
        />
      </Field>

      <Field id="cat-name-en" label="שם באנגלית (אופציונלי)">
        <input
          id="cat-name-en"
          name="name_en"
          type="text"
          dir="ltr"
          autoComplete="off"
          value={nameEn}
          onChange={(event) => handleEnglishName(event.target.value)}
          className={inputClasses}
        />
      </Field>

      {isCreate ? (
        <Field
          id="cat-slug"
          label="מזהה (slug)"
          hint={`חלק מהקישור באתר (#${kind === "category" ? "מזהה" : "קטגוריה-מזהה"}). אותיות אנגליות קטנות, ספרות, - _ &. לא ניתן לשנות אחרי היצירה.`}
          error={showSlugError ? SLUG_MESSAGES[slugProblem!] : slugServerError}
        >
          <input
            id="cat-slug"
            name="slug"
            type="text"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value.trim().toLowerCase());
            }}
            aria-invalid={showSlugError || slugServerError !== null}
            aria-describedby={showSlugError || slugServerError ? "cat-slug-error" : "cat-slug-hint"}
            className={inputClasses}
          />
        </Field>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-brand-text">מזהה (slug)</span>
          <div className="flex items-center gap-2 rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-brand-text-muted">
            <Lock size={14} aria-hidden="true" />
            <code dir="ltr" data-testid="slug-readonly">{slug}</code>
          </div>
          <p className="text-xs text-brand-text-muted">המזהה הוא חלק מהקישור באתר ולא ניתן לשינוי אחרי היצירה.</p>
        </div>
      )}

      <label className="flex items-center gap-3 text-sm text-brand-text">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
          className="h-5 w-5 accent-[rgb(var(--color-gold))]"
        />
        מוצגת באתר
      </label>
      {!visible && (
        <p className="-mt-3 text-xs text-brand-text-muted">
          {kind === "category" ? "קטגוריה מוסתרת והמוצרים שבה לא יוצגו באתר." : "תת־קטגוריה מוסתרת והמוצרים שבה לא יוצגו באתר."}
        </p>
      )}

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

/** Create / edit panel for a category or subcategory (reuses the shared slide-in `Drawer`). */
export function CategoryFormDrawer({ open, onClose, kind, mode, ...formProps }: CategoryFormDrawerProps) {
  return (
    <Drawer isOpen={open} onClose={onClose} title={TITLES[kind][mode]} side="right">
      {/* mounted only while open, so every opening starts from a clean form */}
      {open && <CategoryForm kind={kind} mode={mode} onClose={onClose} {...formProps} />}
    </Drawer>
  );
}

import { useMemo, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowDown, ArrowUp, ChevronDown, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import {
  createCategory,
  createSubcategory,
  deleteCategory,
  deleteSubcategory,
  reorderCategories,
  reorderSubcategories,
  updateCategory,
  updateSubcategory,
  type CategoryRow,
  type SubcategoryRow,
} from "@/admin/categories/categoriesApi";
import { CategoryFormDrawer, type CategoryFormValues } from "@/admin/categories/CategoryFormDrawer";
import type { AdminError } from "@/admin/categories/categoryErrors";
import { moveId, nextSortOrder } from "@/admin/categories/ordering";
import { useCategoryManager } from "@/admin/categories/useCategoryManager";

type FormTarget =
  | { kind: "category"; mode: "create" }
  | { kind: "category"; mode: "edit"; id: string }
  | { kind: "subcategory"; mode: "create"; categoryId: string }
  | { kind: "subcategory"; mode: "edit"; id: string };

type ItemRef = { kind: "category" | "subcategory"; id: string };

const iconButton =
  "rounded-md p-2.5 text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:cursor-not-allowed disabled:opacity-30 sm:p-2";

interface ItemRowProps {
  /** database id — keeps element ids unique (two categories can share a subcategory slug) */
  itemId: string;
  level: "category" | "subcategory";
  name: string;
  nameEn: string | null;
  slug: string;
  meta: string;
  visible: boolean;
  /** the parent is hidden, so this item is not shown in the shop regardless of its own switch */
  parentHidden?: boolean;
  index: number;
  count: number;
  busy: boolean;
  /** Why this can't be deleted now, or null when it can. */
  deleteBlockedReason: string | null;
  confirmingDelete: boolean;
  showBlockedNote: boolean;
  onToggleVisible: () => void;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  expand?: { expanded: boolean; onToggle: () => void; regionId: string };
  children?: ReactNode;
}

/** One category or subcategory line with all its controls. Shared so both levels behave identically. */
function ItemRow(props: ItemRowProps) {
  const { level, name, visible, parentHidden, index, count, busy, expand } = props;
  const shownInShop = visible && !parentHidden;

  return (
    <li
      data-testid={`${level}-row`}
      data-slug={props.slug}
      className={
        level === "category"
          ? "rounded-lg border border-brand-border bg-brand-bg-elevated"
          : "rounded-md border border-brand-border bg-brand-bg"
      }
    >
      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          {expand ? (
            <button
              type="button"
              onClick={expand.onToggle}
              aria-expanded={expand.expanded}
              aria-controls={expand.regionId}
              className="flex max-w-full items-center gap-2 text-start font-semibold text-brand-text outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
            >
              <ChevronDown size={18} aria-hidden="true" className={`shrink-0 transition-transform ${expand.expanded ? "" : "-rotate-90 rtl:rotate-90"}`} />
              <span className="truncate">{name}</span>
            </button>
          ) : (
            <span className="block truncate text-sm font-medium text-brand-text">{name}</span>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-brand-text-muted">
            {props.nameEn && <span dir="ltr">{props.nameEn}</span>}
            <code dir="ltr">{props.slug}</code>
            <span>{props.meta}</span>
            {!visible && <span className="rounded bg-brand-bg px-1.5 py-0.5 text-brand-danger">מוסתרת</span>}
            {visible && parentHidden && <span className="rounded bg-brand-bg px-1.5 py-0.5 text-brand-danger">בקטגוריה מוסתרת</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={visible}
            aria-label={`${name} — מוצגת באתר`}
            onClick={props.onToggleVisible}
            disabled={busy}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50 ${
              visible ? "border-brand-gold/60 text-brand-gold" : "border-brand-border text-brand-text-muted"
            }`}
          >
            {visible ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
            {visible ? "מוצגת" : "מוסתרת"}
          </button>
          <button type="button" className={iconButton} disabled={busy || index === 0} onClick={() => props.onMove(-1)} aria-label={`הזז למעלה: ${name}`}>
            <ArrowUp size={16} />
          </button>
          <button type="button" className={iconButton} disabled={busy || index === count - 1} onClick={() => props.onMove(1)} aria-label={`הזז למטה: ${name}`}>
            <ArrowDown size={16} />
          </button>
          <button type="button" className={iconButton} disabled={busy} onClick={props.onEdit} aria-label={`עריכה: ${name}`}>
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className={`${iconButton} hover:!text-brand-danger`}
            disabled={busy}
            onClick={props.onAskDelete}
            aria-label={`מחיקה: ${name}`}
            aria-describedby={props.deleteBlockedReason ? `${level}-${props.itemId}-blocked` : undefined}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {!shownInShop && (
        <p className="px-3 pb-2 text-xs text-brand-text-muted">
          {parentHidden && visible
            ? "הקטגוריה מוסתרת — המוצרים שבתת־קטגוריה זו אינם מוצגים באתר."
            : level === "category"
              ? "הקטגוריה מוסתרת — היא והמוצרים שבה אינם מוצגים באתר."
              : "התת־קטגוריה מוסתרת — המוצרים שבה אינם מוצגים באתר."}
        </p>
      )}

      {props.showBlockedNote && props.deleteBlockedReason && (
        <p id={`${level}-${props.itemId}-blocked`} role="alert" className="mx-3 mb-3 rounded-md border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text">
          לא ניתן למחוק: {props.deleteBlockedReason}. אפשר להסתיר במקום למחוק.
        </p>
      )}

      {props.confirmingDelete && (
        <div role="group" aria-label={`אישור מחיקה: ${name}`} className="mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm">
          <span className="flex-1 text-brand-text">למחוק את &quot;{name}&quot;? הפעולה אינה הפיכה.</span>
          <Button size="sm" variant="secondary" onClick={props.onConfirmDelete} disabled={busy} className="!border-brand-danger !text-brand-danger">
            אישור מחיקה
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onCancelDelete} disabled={busy}>
            ביטול
          </Button>
        </div>
      )}

      {expand?.expanded && (
        <div id={expand.regionId} className="border-t border-brand-border p-3">
          {props.children}
        </div>
      )}
    </li>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Manage the shop's categories and subcategories: names (Hebrew / English), visibility, display order (up/down),
 * add and delete. The slug is chosen at creation and then locked. Nothing that still holds products or
 * subcategories can be deleted — hide it instead. Every change is saved straight to the database (which enforces
 * the rules) and the list is reloaded afterwards, so the screen always shows what is really stored.
 */
export function CategoriesPage({ client }: { client: SupabaseClient }) {
  const { data, status, loadError, busy, feedback, dismissFeedback, reload, run } = useCategoryManager(client);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<FormTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemRef | null>(null);
  const [blockedNote, setBlockedNote] = useState<ItemRef | null>(null);

  const subsByCategory = useMemo(() => {
    const map = new Map<string, SubcategoryRow[]>();
    for (const sub of data?.subcategories ?? []) map.set(sub.category_id, [...(map.get(sub.category_id) ?? []), sub]);
    return map;
  }, [data]);

  if (status === "loading" && !data) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-16 text-brand-text-muted">
        <Loader2 size={22} className="animate-spin text-brand-gold" aria-hidden="true" />
        טוען קטגוריות…
      </div>
    );
  }
  if (status === "error" || !data) {
    return (
      <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
        <p role="alert" className="mb-4 text-brand-danger">
          {loadError?.kind === "setup-needed" ? loadError.message : "לא ניתן לטעון את הקטגוריות כרגע."}
        </p>
        <Button onClick={reload}>נסו שוב</Button>
      </div>
    );
  }

  const { categories } = data;
  const findCategory = (id: string) => categories.find((category) => category.id === id);
  const findSub = (id: string) => data.subcategories.find((sub) => sub.id === id);

  const closeForm = () => setForm(null);
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ----- blocking rules (the database enforces them too; this explains them) -----
  const categoryBlockedReason = (category: CategoryRow): string | null => {
    const products = data.productsByCategory[category.id] ?? 0;
    const subs = subsByCategory.get(category.id)?.length ?? 0;
    const reasons = [
      products > 0 ? `יש בה ${plural(products, "מוצר", "מוצרים")}` : null,
      subs > 0 ? `יש בה ${plural(subs, "תת־קטגוריה", "תתי־קטגוריות")} (יש למחוק אותן קודם)` : null,
    ].filter(Boolean);
    return reasons.length ? reasons.join(" ו") : null;
  };
  const subcategoryBlockedReason = (sub: SubcategoryRow): string | null => {
    const products = data.productsBySubcategory[sub.id] ?? 0;
    return products > 0 ? `יש בה ${plural(products, "מוצר", "מוצרים")}` : null;
  };

  // ----- actions -----
  const toggleVisible = (item: ItemRef, visible: boolean, name: string) =>
    run(
      () => (item.kind === "category" ? updateCategory(client, item.id, { is_visible: !visible }) : updateSubcategory(client, item.id, { is_visible: !visible })),
      visible ? `"${name}" הוסתרה` : `"${name}" מוצגת באתר`
    );

  const moveCategory = (id: string, direction: -1 | 1) => {
    const ids = moveId(categories.map((category) => category.id), id, direction);
    if (ids) void run(() => reorderCategories(client, ids), "הסדר עודכן");
  };
  const moveSub = (categoryId: string, id: string, direction: -1 | 1) => {
    const ids = moveId((subsByCategory.get(categoryId) ?? []).map((sub) => sub.id), id, direction);
    if (ids) void run(() => reorderSubcategories(client, categoryId, ids), "הסדר עודכן");
  };

  const askDelete = (item: ItemRef, blockedReason: string | null) => {
    setConfirmDelete(null);
    if (blockedReason) setBlockedNote(item);
    else {
      setBlockedNote(null);
      setConfirmDelete(item);
    }
  };
  const confirmDeletion = async (item: ItemRef, name: string) => {
    setConfirmDelete(null);
    await run(() => (item.kind === "category" ? deleteCategory(client, item.id) : deleteSubcategory(client, item.id)), `"${name}" נמחקה`);
  };

  const submitForm = async (values: CategoryFormValues): Promise<AdminError | null> => {
    if (!form) return null;
    const fields = { name_he: values.name_he, name_en: values.name_en === "" ? null : values.name_en, is_visible: values.is_visible };
    let error: AdminError | null;
    if (form.kind === "category" && form.mode === "create") {
      error = await run(
        () => createCategory(client, { ...fields, slug: values.slug, sort_order: nextSortOrder(categories.map((category) => category.sort_order)) }),
        `הקטגוריה "${values.name_he}" נוספה`
      );
    } else if (form.kind === "category") {
      error = await run(() => updateCategory(client, form.id, fields), "הקטגוריה נשמרה");
    } else if (form.mode === "create") {
      const siblings = subsByCategory.get(form.categoryId) ?? [];
      error = await run(
        () => createSubcategory(client, { ...fields, slug: values.slug, category_id: form.categoryId, sort_order: nextSortOrder(siblings.map((sub) => sub.sort_order)) }),
        `תת־הקטגוריה "${values.name_he}" נוספה`
      );
      if (!error) setExpanded((current) => new Set(current).add(form.categoryId));
    } else {
      error = await run(() => updateSubcategory(client, form.id, fields), "תת־הקטגוריה נשמרה");
    }
    if (!error) closeForm();
    return error;
  };

  // ----- what the form needs -----
  const editingCategory = form?.kind === "category" && form.mode === "edit" ? findCategory(form.id) : undefined;
  const editingSub = form?.kind === "subcategory" && form.mode === "edit" ? findSub(form.id) : undefined;
  const subFormCategoryId = form?.kind === "subcategory" ? (form.mode === "create" ? form.categoryId : editingSub?.category_id) : undefined;
  const editing = editingCategory ?? editingSub;
  const formInitial: CategoryFormValues | undefined = editing
    ? { slug: editing.slug, name_he: editing.name_he, name_en: editing.name_en ?? "", is_visible: editing.is_visible }
    : undefined;
  const takenSlugs =
    form?.kind === "category"
      ? categories.map((category) => category.slug)
      : (subsByCategory.get(subFormCategoryId ?? "") ?? []).map((sub) => sub.slug);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-text">קטגוריות</h1>
        <Button onClick={() => setForm({ kind: "category", mode: "create" })} disabled={busy}>
          <Plus size={16} aria-hidden="true" />
          הוספת קטגוריה
        </Button>
      </div>

      <div aria-live="polite" className="mb-3 min-h-[2.5rem]">
        {feedback && (
          <p
            role={feedback.kind === "error" ? "alert" : "status"}
            className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
              feedback.kind === "error"
                ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger"
                : "border-brand-success/40 bg-brand-success/10 text-brand-success"
            }`}
          >
            <span>{feedback.message}</span>
            <button type="button" onClick={dismissFeedback} aria-label="סגור הודעה" className="rounded p-1 outline-none hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold">
              <X size={14} />
            </button>
          </p>
        )}
      </div>

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-brand-border p-8 text-center text-brand-text-muted">אין קטגוריות עדיין. הוסיפו את הראשונה.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {categories.map((category, index) => {
            const subs = subsByCategory.get(category.id) ?? [];
            const ref: ItemRef = { kind: "category", id: category.id };
            const isRef = (candidate: ItemRef | null) => candidate?.kind === ref.kind && candidate.id === ref.id;
            const blockedReason = categoryBlockedReason(category);
            return (
              <ItemRow
                key={category.id}
                itemId={category.id}
                level="category"
                name={category.name_he}
                nameEn={category.name_en}
                slug={category.slug}
                meta={`${plural(data.productsByCategory[category.id] ?? 0, "מוצר", "מוצרים")} · ${plural(subs.length, "תת־קטגוריה", "תתי־קטגוריות")}`}
                visible={category.is_visible}
                index={index}
                count={categories.length}
                busy={busy}
                deleteBlockedReason={blockedReason}
                confirmingDelete={isRef(confirmDelete)}
                showBlockedNote={isRef(blockedNote)}
                onToggleVisible={() => void toggleVisible(ref, category.is_visible, category.name_he)}
                onMove={(direction) => moveCategory(category.id, direction)}
                onEdit={() => setForm({ kind: "category", mode: "edit", id: category.id })}
                onAskDelete={() => askDelete(ref, blockedReason)}
                onConfirmDelete={() => void confirmDeletion(ref, category.name_he)}
                onCancelDelete={() => setConfirmDelete(null)}
                expand={{ expanded: expanded.has(category.id), onToggle: () => toggleExpanded(category.id), regionId: `subs-${category.id}` }}
              >
                {subs.length === 0 ? (
                  <p className="mb-3 text-sm text-brand-text-muted">אין תתי־קטגוריות עדיין.</p>
                ) : (
                  <ul className="mb-3 flex flex-col gap-2">
                    {subs.map((sub, subIndex) => {
                      const subRef: ItemRef = { kind: "subcategory", id: sub.id };
                      const isSubRef = (candidate: ItemRef | null) => candidate?.kind === subRef.kind && candidate.id === subRef.id;
                      const subBlocked = subcategoryBlockedReason(sub);
                      return (
                        <ItemRow
                          key={sub.id}
                          itemId={sub.id}
                          level="subcategory"
                          name={sub.name_he}
                          nameEn={sub.name_en}
                          slug={sub.slug}
                          meta={plural(data.productsBySubcategory[sub.id] ?? 0, "מוצר", "מוצרים")}
                          visible={sub.is_visible}
                          parentHidden={!category.is_visible}
                          index={subIndex}
                          count={subs.length}
                          busy={busy}
                          deleteBlockedReason={subBlocked}
                          confirmingDelete={isSubRef(confirmDelete)}
                          showBlockedNote={isSubRef(blockedNote)}
                          onToggleVisible={() => void toggleVisible(subRef, sub.is_visible, sub.name_he)}
                          onMove={(direction) => moveSub(category.id, sub.id, direction)}
                          onEdit={() => setForm({ kind: "subcategory", mode: "edit", id: sub.id })}
                          onAskDelete={() => askDelete(subRef, subBlocked)}
                          onConfirmDelete={() => void confirmDeletion(subRef, sub.name_he)}
                          onCancelDelete={() => setConfirmDelete(null)}
                        />
                      );
                    })}
                  </ul>
                )}
                <Button size="sm" variant="secondary" onClick={() => setForm({ kind: "subcategory", mode: "create", categoryId: category.id })} disabled={busy}>
                  <Plus size={14} aria-hidden="true" />
                  הוספת תת־קטגוריה
                </Button>
              </ItemRow>
            );
          })}
        </ul>
      )}

      <CategoryFormDrawer
        open={form !== null}
        onClose={closeForm}
        kind={form?.kind ?? "category"}
        mode={form?.mode ?? "create"}
        parentName={form?.kind === "subcategory" ? findCategory(subFormCategoryId ?? "")?.name_he : undefined}
        initial={formInitial}
        takenSlugs={takenSlugs}
        otherCategorySlugs={form?.kind === "category" ? categories.map((category) => category.slug) : undefined}
        onSubmit={submitForm}
      />
    </div>
  );
}

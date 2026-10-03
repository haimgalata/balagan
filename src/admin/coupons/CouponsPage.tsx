import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { normalizeCouponCode } from "@/storefront/lib/couponCode";
import { loadClubOfferText, saveClubOfferText } from "@/admin/coupons/couponsApi";
import {
  couponStatus, describeCoupon, duplicateForm, EMPTY_FORM, EMPTY_USAGE, formatUsage, formFromCoupon, STATUS_LABEL,
  type CouponFormValues, type CouponRow, type CouponStatus,
} from "@/admin/coupons/couponsModel";
import { CouponFormDrawer } from "@/admin/coupons/CouponFormDrawer";
import { CouponDetailDrawer } from "@/admin/coupons/CouponDetailDrawer";
import { useCouponManager } from "@/admin/coupons/useCouponManager";
import { formatDateTime } from "@/admin/orders/orderModel";
import { MobileLabel, RT_BODY, RT_CELL, RT_HEAD, RT_ROW, RT_TABLE } from "@/admin/shared/responsiveTable";

const inputClasses =
  "rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50";

const STATUS_TONE: Record<CouponStatus, string> = {
  active: "border-brand-gold/60 text-brand-gold",
  scheduled: "border-brand-border text-brand-text",
  expired: "border-brand-border text-brand-text-muted",
  disabled: "border-brand-border text-brand-text-muted",
  exhausted: "border-brand-danger/50 text-brand-danger",
  archived: "border-brand-border text-brand-text-muted",
};

const FILTERS: { value: "all" | CouponStatus; label: string }[] = [
  { value: "all", label: "הכול (בלי ארכיון)" },
  { value: "active", label: "פעילים" },
  { value: "scheduled", label: "מתוזמנים" },
  { value: "expired", label: "פג תוקף" },
  { value: "disabled", label: "מושבתים" },
  { value: "exhausted", label: "מוצים" },
  { value: "archived", label: "ארכיון" },
];

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
      <span>{message}</span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          נסו שוב
        </Button>
      )}
    </div>
  );
}

/** The one public sentence guests see (locked) in checkout. Plain text, public, never derived from the coupons themselves. */
function OfferTextCard({ client }: { client: SupabaseClient }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "loading" | "saving" | "ok" | "error"; message?: string }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadClubOfferText(client).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setText(r.data);
        setSaved(r.data);
        setState({ kind: "idle" });
      } else setState({ kind: "error", message: r.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const save = async () => {
    setState({ kind: "saving" });
    const r = await saveClubOfferText(client, text);
    if (r.ok) {
      setText(r.data);
      setSaved(r.data);
      setState({ kind: "ok", message: r.data === "" ? "ההודעה נוקתה — האורחים יראו את הנוסח הרגיל." : "ההודעה נשמרה ומוצגת עכשיו לאורחים בקופה." });
    } else setState({ kind: "error", message: r.error.message });
  };

  return (
    <section aria-labelledby="offer-title" className="rounded-xl border border-brand-border bg-brand-bg-elevated p-4">
      <h2 id="offer-title" className="text-base font-semibold text-brand-text">
        הודעה לאורחים בקופה
      </h2>
      <p className="mt-1 text-sm text-brand-text-muted">
        משפט אחד שמוצג לגולשים שאינם חברי מועדון, ליד אזור הקופון הנעול (למשל: ״חברי מועדון: 10% הנחה השבוע״). ההודעה <strong>ציבורית</strong> ולא קשורה אוטומטית לקופון כלשהו —
        זכרו לעדכן או לנקות אותה כשהמבצע נגמר. ריק = הנוסח הרגיל.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          aria-label="הודעה לאורחים"
          value={text}
          maxLength={120}
          onChange={(event) => setText(event.target.value)}
          disabled={state.kind === "loading" || state.kind === "saving"}
          className={`${inputClasses} min-w-0 flex-1`}
          placeholder="חברי מועדון: ..."
        />
        <Button type="button" variant="outline" size="sm" disabled={state.kind === "loading" || state.kind === "saving" || text.trim() === (saved ?? "").trim()} onClick={() => void save()}>
          {state.kind === "saving" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : "שמירת הודעה"}
        </Button>
      </div>
      {state.kind === "ok" && <p role="status" className="mt-2 text-xs text-brand-text-muted">{state.message}</p>}
      {state.kind === "error" && <p role="alert" className="mt-2 text-xs text-brand-danger">{state.message}</p>}
    </section>
  );
}

type FormState = { mode: "create" | "edit"; initial: CouponFormValues; coupon: CouponRow | null; financialLocked: boolean } | null;

/**
 * The owner's coupon management (/admin/coupons): create, edit, enable/disable, duplicate, archive — never delete —
 * with who used what and the history of changes. The database enforces every rule (codes locked, terms locked once
 * used, owner-only); this screen only makes them easy to follow.
 */
export function CouponsPage({ client }: { client: SupabaseClient }) {
  const m = useCouponManager(client);
  const [filter, setFilter] = useState<"all" | CouponStatus>("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<FormState>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const data = m.list.status === "ready" ? m.list.data : null;
  const takenCodes = useMemo(() => (data ? data.coupons.map((c) => c.code) : []), [data]);
  const detail = data && detailId ? (data.coupons.find((c) => c.id === detailId) ?? null) : null;

  const visible = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    const normalizedTerm = normalizeCouponCode(search);
    return data.coupons.filter((c) => {
      const status = couponStatus(c, data.usage.get(c.id) ?? EMPTY_USAGE);
      if (filter === "all" ? status === "archived" : status !== filter) return false;
      return term === "" || c.title.toLowerCase().includes(term) || (normalizedTerm !== "" && c.code.includes(normalizedTerm));
    });
  }, [data, filter, search]);

  const openCreate = () => {
    setActionError(null);
    setForm({ mode: "create", initial: EMPTY_FORM, coupon: null, financialLocked: false });
  };
  const openEdit = (c: CouponRow) => {
    setActionError(null);
    const locked = (data?.usage.get(c.id)?.redeemed ?? 0) + (data?.usage.get(c.id)?.reserved ?? 0) + (data?.usage.get(c.id)?.released ?? 0) > 0;
    setForm({ mode: "edit", initial: formFromCoupon(c), coupon: c, financialLocked: locked });
  };
  const openDuplicate = (c: CouponRow) => {
    setActionError(null);
    setDetailId(null);
    setForm({ mode: "create", initial: duplicateForm(c), coupon: null, financialLocked: false });
  };

  const submitForm = async (body: Record<string, unknown>) => {
    if (!form) return null;
    const result = form.mode === "create" ? await m.create(body) : await m.update(form.coupon!.id, body);
    if (result.error) return result.error;
    setForm(null);
    if (form.mode === "create" && result.coupon) setDetailId(result.coupon.id);
    return null;
  };

  const act = async (run: () => Promise<{ error: { message: string } | null }>) => {
    setActionError(null);
    const { error } = await run();
    if (error) setActionError(error.message);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-text">קופונים</h1>
        <Button type="button" onClick={openCreate} disabled={m.list.status !== "ready"}>
          <Plus size={16} aria-hidden="true" />
          קופון חדש
        </Button>
      </div>
      <p className="-mt-3 text-sm text-brand-text-muted">
        קופונים הם הטבה לחברי מועדון פעילים בלבד, והם מומשים בקופה. אפשר להשבית או להעביר לארכיון, אבל לא למחוק — כדי שההיסטוריה של הזמנות ושימושים תישאר אמינה.
      </p>

      <OfferTextCard client={client} />

      {actionError && <ErrorBox message={actionError} />}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-brand-text-muted">
          סינון
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className={inputClasses}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-brand-text-muted">
          חיפוש (קוד או שם)
          <input value={search} onChange={(event) => setSearch(event.target.value)} className={inputClasses} />
        </label>
      </div>

      {m.list.status === "loading" && (
        <div className="flex justify-center py-10" role="status">
          <Loader2 size={24} className="animate-spin text-brand-gold" aria-label="טוען" />
        </div>
      )}
      {m.list.status === "error" && <ErrorBox message={m.list.error.message} onRetry={() => void m.reload()} />}

      {data && visible.length === 0 && (
        <p className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center text-sm text-brand-text-muted">
          {data.coupons.length === 0 ? "עדיין אין קופונים. אפשר ליצור את הראשון בכפתור ״קופון חדש״." : "אין קופונים שמתאימים לסינון."}
        </p>
      )}

      {data && visible.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-brand-border bg-brand-bg-elevated">
          <table className={RT_TABLE}>
            <thead className={`border-b border-brand-border text-start text-xs text-brand-text-muted ${RT_HEAD}`}>
              <tr>
                <th className="px-3 py-2 text-start font-medium">קוד</th>
                <th className="px-3 py-2 text-start font-medium">שם</th>
                <th className="px-3 py-2 text-start font-medium">ההטבה</th>
                <th className="px-3 py-2 text-start font-medium">סטטוס</th>
                <th className="px-3 py-2 text-start font-medium">שימושים</th>
                <th className="px-3 py-2 text-start font-medium">נוצר</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className={RT_BODY}>
              {visible.map((c) => {
                const usage = data.usage.get(c.id) ?? EMPTY_USAGE;
                const status = couponStatus(c, usage);
                return (
                  <tr key={c.id} className={`border-b border-brand-border last:border-0 ${RT_ROW}`} data-testid="coupon-row">
                    <td className={RT_CELL}>
                      <MobileLabel>קוד</MobileLabel>
                      <code dir="ltr" className="font-semibold text-brand-gold">{c.code}</code>
                    </td>
                    <td className={`${RT_CELL} text-brand-text`}>
                      <MobileLabel>שם</MobileLabel>
                      <span>{c.title}</span>
                    </td>
                    <td className={`${RT_CELL} text-brand-text-muted max-md:flex-col max-md:items-start max-md:gap-0.5`}>
                      <MobileLabel>ההטבה</MobileLabel>
                      <span>{describeCoupon(c)}</span>
                    </td>
                    <td className={RT_CELL}>
                      <MobileLabel>סטטוס</MobileLabel>
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
                    </td>
                    <td className={`${RT_CELL} text-brand-text`}>
                      <MobileLabel>שימושים</MobileLabel>
                      <span>{formatUsage(c, usage)}</span>
                    </td>
                    <td className={`${RT_CELL} text-brand-text-muted`}>
                      <MobileLabel>נוצר</MobileLabel>
                      <span>{formatDateTime(c.created_at)}</span>
                    </td>
                    <td className={`${RT_CELL} text-end max-md:justify-end max-md:pt-2`}>
                      <Button type="button" size="sm" variant="outline" onClick={() => setDetailId(c.id)} aria-label={`פרטי הקופון ${c.code}`}>
                        פרטים
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CouponDetailDrawer
        client={client}
        coupon={detail}
        usage={detail && data ? data.usage.get(detail.id) : undefined}
        version={m.version}
        busy={m.busy}
        onClose={() => setDetailId(null)}
        onEdit={openEdit}
        onDuplicate={openDuplicate}
        onToggleActive={(c) => void act(() => m.setActive(c.id, !c.is_active))}
        onToggleArchived={(c) => void act(() => m.setArchived(c.id, !c.archived_at))}
      />

      <CouponFormDrawer
        open={form !== null}
        onClose={() => setForm(null)}
        mode={form?.mode ?? "create"}
        initial={form?.initial ?? EMPTY_FORM}
        takenCodes={takenCodes}
        financialLocked={form?.financialLocked ?? false}
        onSubmit={submitForm}
      />
    </div>
  );
}

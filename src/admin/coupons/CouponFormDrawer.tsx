import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { normalizeCouponCode } from "@/storefront/lib/couponCode";
import type { AdminError } from "@/admin/coupons/couponsErrors";
import {
  describeCoupon, PROBLEM_MESSAGES, toPayload, validateForm,
  type CouponFormValues, type DiscountType, type FormProblem,
} from "@/admin/coupons/couponsModel";

interface CouponFormDrawerProps {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  initial: CouponFormValues;
  /** Normalized codes that exist already (archived ones included — a retired code is never reused). */
  takenCodes: string[];
  /** The coupon has been redeemed: the code, type and value can no longer change (duplicate it instead). */
  financialLocked: boolean;
  /** Saves; resolves to the error to show, or null on success (the parent then closes the panel). */
  onSubmit: (body: Record<string, unknown>) => Promise<AdminError | null>;
}

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-60";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-brand-text">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-brand-text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<DiscountType, string> = { percent: "אחוזים", fixed: "סכום קבוע (₪)", free_delivery: "משלוח חינם" };

function CouponForm({ mode, initial, takenCodes, financialLocked, onSubmit, onClose }: Omit<CouponFormDrawerProps, "open">) {
  const isCreate = mode === "create";
  const [v, setV] = useState<CouponFormValues>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<AdminError | null>(null);

  const set = <K extends keyof CouponFormValues>(key: K, value: CouponFormValues[K]) => setV((current) => ({ ...current, [key]: value }));
  const problems = validateForm(v, { mode, takenCodes, financialLocked });
  const has = (p: FormProblem) => problems.includes(p);
  const show = (p: FormProblem) => (submitted && has(p) ? PROBLEM_MESSAGES[p] : null);
  const codeProblem = (["code-empty", "code-hebrew", "code-format", "code-taken"] as const).find(has);
  // live: show a code problem as soon as something was typed
  const codeError = codeProblem && (submitted || v.code !== "") ? PROBLEM_MESSAGES[codeProblem] : null;
  const normalized = normalizeCouponCode(v.code);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setServerError(null);
    if (problems.length > 0) return;
    setBusy(true);
    const error = await onSubmit(toPayload(v, { mode, financialLocked }));
    if (error) {
      setServerError(error);
      setBusy(false);
    }
  };

  const preview = describeCoupon({
    discount_type: v.discountType,
    discount_value: v.discountType === "percent" ? Number(v.percent) || null : v.discountType === "fixed" ? Math.round(Number(v.fixedShekel) * 100) || null : null,
    max_discount_cents: v.discountType === "percent" && v.maxDiscountShekel.trim() !== "" ? Math.round(Number(v.maxDiscountShekel) * 100) || null : null,
    min_subtotal_cents: v.minSubtotalShekel.trim() === "" ? 0 : Math.round(Number(v.minSubtotalShekel) * 100) || 0,
    max_total_redemptions: v.maxTotal.trim() === "" ? null : Number(v.maxTotal) || null,
    max_per_member: v.maxPerMember.trim() === "" ? null : Number(v.maxPerMember) || null,
    first_order_only: v.firstOrderOnly,
  });

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5 p-4">
      {isCreate ? (
        <Field
          id="coupon-code"
          label="קוד הקופון"
          hint="הקוד שהחבר מקליד בקופה. אותיות אנגליות, ספרות, - ו-_ (3–24 תווים). הקוד לא רגיש לאותיות גדולות/קטנות או לרווחים, ולא ניתן לשנותו אחרי היצירה."
          error={codeError}
        >
          <input
            id="coupon-code"
            type="text"
            dir="ltr"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={v.code}
            onChange={(event) => set("code", event.target.value)}
            aria-invalid={codeError !== null}
            placeholder="CLUB20"
            className={inputClasses}
          />
          {v.code.trim() !== "" && normalized !== v.code && (
            <p className="text-xs text-brand-text-muted">
              יישמר כ: <code dir="ltr">{normalized}</code>
            </p>
          )}
        </Field>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-brand-text">קוד הקופון</span>
          <div className="flex items-center gap-2 rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-brand-text-muted">
            <Lock size={14} aria-hidden="true" />
            <code dir="ltr" data-testid="coupon-code-readonly">{v.code}</code>
          </div>
        </div>
      )}

      <Field id="coupon-title" label="שם הקופון" hint="מוצג ללקוח ולצוות (למשל: הנחת מועדון)." error={show("title")}>
        <input id="coupon-title" type="text" autoComplete="off" value={v.title} onChange={(event) => set("title", event.target.value)} aria-invalid={show("title") !== null} className={inputClasses} />
      </Field>

      <fieldset className="flex flex-col gap-3" disabled={financialLocked}>
        <legend className="mb-1 text-sm font-medium text-brand-text">סוג ההנחה</legend>
        {financialLocked && (
          <p className="flex items-center gap-2 text-xs text-brand-text-muted">
            <Lock size={12} aria-hidden="true" />
            הקופון כבר נוצל, ולכן סוג ההנחה וערכה נעולים. כדי ליצור גרסה חדשה — שכפלו את הקופון.
          </p>
        )}
        <div className="flex flex-wrap gap-4">
          {(Object.keys(TYPE_LABEL) as DiscountType[]).map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm text-brand-text">
              <input type="radio" name="discount-type" checked={v.discountType === type} onChange={() => set("discountType", type)} className="accent-[rgb(var(--color-gold))]" />
              {TYPE_LABEL[type]}
            </label>
          ))}
        </div>
        {v.discountType === "percent" && (
          <>
            <Field id="coupon-percent" label="אחוז הנחה" error={show("percent")}>
              <input id="coupon-percent" type="text" inputMode="numeric" dir="ltr" value={v.percent} onChange={(event) => set("percent", event.target.value)} aria-invalid={show("percent") !== null} placeholder="20" className={inputClasses} />
            </Field>
            <Field id="coupon-max-discount" label="תקרת הנחה ב-₪ (אופציונלי)" hint="למשל 30 = ההנחה לא תעלה על ₪30 גם בהזמנה גדולה." error={show("max-discount")}>
              <input id="coupon-max-discount" type="text" inputMode="decimal" dir="ltr" value={v.maxDiscountShekel} onChange={(event) => set("maxDiscountShekel", event.target.value)} className={inputClasses} />
            </Field>
          </>
        )}
        {v.discountType === "fixed" && (
          <Field id="coupon-fixed" label="סכום ההנחה ב-₪" hint="אם הסכום גדול מסכום ההזמנה, ההנחה תהיה סכום ההזמנה." error={show("fixed")}>
            <input id="coupon-fixed" type="text" inputMode="decimal" dir="ltr" value={v.fixedShekel} onChange={(event) => set("fixedShekel", event.target.value)} aria-invalid={show("fixed") !== null} placeholder="25" className={inputClasses} />
          </Field>
        )}
        {v.discountType === "free_delivery" && <p className="text-sm text-brand-text-muted">דמי המשלוח יבוטלו בהזמנה (ההזמנה תציג את דמי המשלוח המקוריים ואת ההנחה עליהם).</p>}
      </fieldset>

      <Field id="coupon-min" label="מינימום הזמנה ב-₪ (אופציונלי)" hint="סכום המוצרים (אחרי מחירי מבצע, בלי משלוח) שממנו הקופון תקף." error={show("min-subtotal")}>
        <input id="coupon-min" type="text" inputMode="decimal" dir="ltr" value={v.minSubtotalShekel} onChange={(event) => set("minSubtotalShekel", event.target.value)} className={inputClasses} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="coupon-starts" label="תקף מתאריך (אופציונלי)">
          <input id="coupon-starts" type="date" dir="ltr" value={v.startsOn} onChange={(event) => set("startsOn", event.target.value)} className={inputClasses} />
        </Field>
        <Field id="coupon-ends" label="תקף עד תאריך (כולל)" error={show("dates")}>
          <input id="coupon-ends" type="date" dir="ltr" value={v.endsOn} onChange={(event) => set("endsOn", event.target.value)} className={inputClasses} />
        </Field>
      </div>
      <p className="-mt-3 text-xs text-brand-text-muted">התאריכים לפי שעון ישראל. תאריך הסיום כולל את היום עצמו עד חצות.</p>

      <div className="grid grid-cols-2 gap-3">
        <Field id="coupon-max-total" label="מקסימום שימושים בסך הכול" hint="ריק = ללא הגבלה." error={show("max-total")}>
          <input id="coupon-max-total" type="text" inputMode="numeric" dir="ltr" value={v.maxTotal} onChange={(event) => set("maxTotal", event.target.value)} placeholder="100" className={inputClasses} />
        </Field>
        <Field id="coupon-max-member" label="מקסימום שימושים לכל חבר" hint="ריק = ללא הגבלה." error={show("max-per-member")}>
          <input id="coupon-max-member" type="text" inputMode="numeric" dir="ltr" value={v.maxPerMember} onChange={(event) => set("maxPerMember", event.target.value)} placeholder="1" className={inputClasses} />
        </Field>
      </div>

      <label className="flex items-start gap-3 text-sm text-brand-text">
        <input type="checkbox" checked={v.firstOrderOnly} onChange={(event) => set("firstOrderOnly", event.target.checked)} className="mt-0.5 h-5 w-5 accent-[rgb(var(--color-gold))]" />
        <span>
          להזמנה ראשונה בלבד
          <span className="block text-xs text-brand-text-muted">לא יעבוד למי שיש לו (או למספר הטלפון שלו) הזמנה קודמת שלא בוטלה, גם הזמנה כאורח לפני ההצטרפות.</span>
        </span>
      </label>

      <label className="flex items-center gap-3 text-sm text-brand-text">
        <input type="checkbox" checked={v.isActive} onChange={(event) => set("isActive", event.target.checked)} className="h-5 w-5 accent-[rgb(var(--color-gold))]" />
        פעיל (ניתן לממש)
      </label>

      <Field id="coupon-note" label="הערה פנימית (אופציונלי)" hint="לא מוצגת ללקוחות.">
        <textarea id="coupon-note" rows={2} value={v.internalNote} onChange={(event) => set("internalNote", event.target.value)} className={inputClasses} />
      </Field>

      <p className="rounded-md border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text-muted" data-testid="coupon-preview">
        {preview}
      </p>

      {serverError && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {serverError.message}
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

/** Create / edit panel for a coupon (reuses the shared slide-in `Drawer`). */
export function CouponFormDrawer({ open, onClose, mode, ...formProps }: CouponFormDrawerProps) {
  return (
    <Drawer isOpen={open} onClose={onClose} title={mode === "create" ? "קופון חדש" : "עריכת קופון"} side="right">
      {/* mounted only while open, so every opening starts from a clean form */}
      {open && <CouponForm mode={mode} onClose={onClose} {...formProps} />}
    </Drawer>
  );
}

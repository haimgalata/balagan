import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import {
  addDeliveryWindow,
  deleteDeliveryWindow,
  updateBusinessHourDay,
  updateBusinessSettings,
  updateDeliveryWindow,
  type BusinessHourRow,
  type BusinessSettingsRow,
  type DeliveryWindowRow,
} from "@/admin/settings/settingsApi";
import {
  ADVANCE_HOURS_MAX,
  ADVANCE_HOURS_MIN,
  newWindowDraft,
  parseAdvanceHours,
  toWindowDrafts,
  toWindowFields,
  validateWindows,
  type WindowDraft,
} from "@/admin/settings/deliveryWindowsModel";
import { useBusinessSettingsManager, type Feedback } from "@/admin/settings/useBusinessSettingsManager";

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

const inputClasses =
  "rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50";

type DayDraft = { is_open: boolean; open_time: string; close_time: string }; // times are "HH:MM" or ""
type Run = ReturnType<typeof useBusinessSettingsManager>["run"];

/** Postgres `time` comes back as "HH:MM:SS" — `<input type="time">` wants "HH:MM". */
const toTimeInput = (t: string | null): string => (t ? t.slice(0, 5) : "");

function toDayDrafts(rows: BusinessHourRow[]): DayDraft[] {
  const byDay = new Map(rows.map((r) => [r.day_of_week, r]));
  return Array.from({ length: 7 }, (_, day) => {
    const row = byDay.get(day);
    return { is_open: row?.is_open ?? false, open_time: toTimeInput(row?.open_time ?? null), close_time: toTimeInput(row?.close_time ?? null) };
  });
}

/** Mirrors the database's own check constraint (business_hours_times_when_open) so a bad value is caught before saving. */
function validateDayDrafts(draft: DayDraft[]): string | null {
  for (let day = 0; day < 7; day++) {
    const d = draft[day];
    if (d.is_open && (!d.open_time || !d.close_time || d.open_time >= d.close_time)) {
      return `יום ${DAY_NAMES[day]}: יש להזין שעת פתיחה וסגירה תקינות (פתיחה לפני סגירה), או לסמן את היום כסגור.`;
    }
  }
  return null;
}

function FeedbackBanner({ feedback, onDismiss }: { feedback: Feedback | null; onDismiss: () => void }) {
  return (
    <div aria-live="polite" className="mb-3 min-h-[2.5rem]">
      {feedback && (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
            feedback.kind === "error" ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger" : "border-brand-success/40 bg-brand-success/10 text-brand-success"
          }`}
        >
          <span>{feedback.message}</span>
          <button type="button" onClick={onDismiss} aria-label="סגור הודעה" className="rounded p-1 outline-none hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold">
            <X size={14} />
          </button>
        </p>
      )}
    </div>
  );
}

function HoursEditor({ scheduleName, draft, onChange, disabled }: { scheduleName: string; draft: DayDraft[]; onChange: (day: number, patch: Partial<DayDraft>) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      {draft.map((d, day) => (
        <div key={day} className="flex flex-wrap items-center gap-3">
          <label className="flex w-20 shrink-0 items-center gap-2 text-sm text-brand-text">
            <input
              type="checkbox"
              checked={d.is_open}
              disabled={disabled}
              onChange={(e) => onChange(day, e.target.checked ? { is_open: true } : { is_open: false, open_time: "", close_time: "" })}
              className="h-4 w-4 accent-[rgb(var(--color-gold))]"
            />
            {DAY_NAMES[day]}
          </label>
          {d.is_open ? (
            <div className="flex items-center gap-2">
              <input
                type="time"
                dir="ltr"
                aria-label={`${scheduleName} — שעת פתיחה ביום ${DAY_NAMES[day]}`}
                value={d.open_time}
                disabled={disabled}
                onChange={(e) => onChange(day, { open_time: e.target.value })}
                className={`${inputClasses} w-[7.5rem]`}
              />
              <span className="text-xs text-brand-text-muted">עד</span>
              <input
                type="time"
                dir="ltr"
                aria-label={`${scheduleName} — שעת סגירה ביום ${DAY_NAMES[day]}`}
                value={d.close_time}
                disabled={disabled}
                onChange={(e) => onChange(day, { close_time: e.target.value })}
                className={`${inputClasses} w-[7.5rem]`}
              />
            </div>
          ) : (
            <span className="text-sm text-brand-text-muted">סגור</span>
          )}
        </div>
      ))}
    </div>
  );
}

function StoreHoursSection({ client, initial, busy, run }: { client: SupabaseClient; initial: BusinessHourRow[]; busy: boolean; run: Run }) {
  const [draft, setDraft] = useState<DayDraft[]>(() => toDayDrafts(initial));
  const [error, setError] = useState<string | null>(null);
  const patchDay = (day: number, patch: Partial<DayDraft>) => setDraft((prev) => prev.map((d, i) => (i === day ? { ...d, ...patch } : d)));

  const save = async () => {
    const problem = validateDayDrafts(draft);
    setError(problem);
    if (problem) return;
    await run(async () => {
      for (let day = 0; day < 7; day++) {
        const d = draft[day];
        const result = await updateBusinessHourDay(client, "store", day, { is_open: d.is_open, open_time: d.is_open ? d.open_time : null, close_time: d.is_open ? d.close_time : null });
        if (!result.ok) return result;
      }
      return { ok: true, data: null };
    }, "שעות פתיחת החנות נשמרו");
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
      <legend className="px-1 text-base font-semibold text-brand-text">שעות פתיחת החנות</legend>
      <HoursEditor scheduleName="שעות פתיחת החנות" draft={draft} onChange={patchDay} disabled={busy} />
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={busy} className="self-start">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            שומר…
          </>
        ) : (
          "שמירה"
        )}
      </Button>
    </fieldset>
  );
}

/**
 * How orders are received (pickup OR delivery — the storefront offers one at a time) and which payment methods are
 * offered, plus the store address pickup customers see. Migration 0015; the database refuses an order for a method
 * that is off, whatever the client sends.
 */
function FulfillmentSection({ client, initialSettings, busy, run }: { client: SupabaseClient; initialSettings: BusinessSettingsRow; busy: boolean; run: Run }) {
  const [mode, setMode] = useState<"pickup" | "delivery">(() => (initialSettings.pickup_enabled ? "pickup" : "delivery"));
  const [cash, setCash] = useState(() => initialSettings.cash_enabled !== false);
  const [card, setCard] = useState(() => initialSettings.card_enabled === true);
  const [address, setAddress] = useState(() => initialSettings.store_address_text ?? "");
  const [error, setError] = useState<string | null>(null);

  if (initialSettings.pickup_enabled === undefined) {
    return (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
        <legend className="px-1 text-base font-semibold text-brand-text">קבלת הזמנה ותשלום</legend>
        <p role="alert" className="text-sm text-brand-danger">
          יש להריץ את supabase/migrations/0015_pickup.sql במסד הנתונים כדי להגדיר איסוף עצמי ואמצעי תשלום.
        </p>
      </fieldset>
    );
  }

  const save = async () => {
    const trimmed = address.trim();
    const problem =
      trimmed.length > 120 ? "כתובת החנות ארוכה מדי (עד 120 תווים)."
      : mode === "pickup" && trimmed === "" ? "באיסוף עצמי יש להזין את כתובת החנות — הלקוחות יראו אותה."
      : null;
    setError(problem);
    if (problem) return;
    await run(
      () =>
        updateBusinessSettings(client, {
          pickup_enabled: mode === "pickup",
          delivery_enabled: mode === "delivery",
          cash_enabled: cash,
          card_enabled: card,
          store_address_text: trimmed === "" ? null : trimmed,
        }),
      "הגדרות קבלת ההזמנה והתשלום נשמרו"
    );
  };

  const choice = (value: "pickup" | "delivery", label: string, hint: string) => (
    <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${mode === value ? "border-brand-gold bg-brand-gold/10" : "border-brand-border"}`}>
      <input type="radio" name="fulfillment-mode" checked={mode === value} disabled={busy} onChange={() => setMode(value)} className="mt-0.5 accent-[rgb(var(--color-gold))]" />
      <span>
        <span className="block font-medium text-brand-text">{label}</span>
        <span className="block text-xs text-brand-text-muted">{hint}</span>
      </span>
    </label>
  );

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-4" data-testid="fulfillment-settings">
      <legend className="px-1 text-base font-semibold text-brand-text">קבלת הזמנה ותשלום</legend>

      <div role="radiogroup" aria-label="אופן קבלת הזמנה" className="grid gap-2 sm:grid-cols-2">
        {choice("pickup", "איסוף עצמי מהחנות", "בלי כתובת, בלי דמי משלוח ובלי מינימום הזמנה.")}
        {choice("delivery", "משלוח (נתיבות)", "כתובת למשלוח, דמי משלוח ומינימום הזמנה כפי שמוגדר למטה.")}
      </div>

      <label className="flex flex-col gap-1.5 text-sm text-brand-text">
        כתובת החנות (מוצגת ללקוחות באיסוף עצמי)
        <input type="text" value={address} maxLength={120} disabled={busy} onChange={(e) => setAddress(e.target.value)} placeholder="לדוגמה: הרצל 1, נתיבות" className={`${inputClasses} w-full max-w-md`} />
      </label>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-text">אמצעי תשלום באתר</p>
        <label className="flex items-center gap-2 text-sm text-brand-text">
          <input type="checkbox" checked={cash} disabled={busy} onChange={(e) => setCash(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--color-gold))]" />
          מזומן (בעת האיסוף / המסירה)
        </label>
        <label className="flex items-center gap-2 text-sm text-brand-text">
          <input type="checkbox" checked={card} disabled={busy} onChange={(e) => setCard(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--color-gold))]" />
          כרטיס אשראי
        </label>
        <p className="text-xs text-brand-text-muted">תשלום באשראי יופיע ללקוחות רק אחרי חיבור חברת סליקה. עד אז הוא מוצג להם כ״בקרוב״.</p>
        {!cash && !card && <p className="text-xs text-brand-danger">כשכל אמצעי התשלום כבויים, אי אפשר להשלים הזמנה באתר.</p>}
      </div>

      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={busy} className="self-start">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            שומר…
          </>
        ) : (
          "שמירה"
        )}
      </Button>
    </fieldset>
  );
}

/**
 * Delivery windows (migration 0017): the departure slots customers pick at checkout. A window takes orders until its
 * cut-off time, for at most "N hours ahead" of its departure, and — if a capacity is set — until that many orders are in.
 * With no window defined, delivery works as before (no choice at checkout). The database enforces all of it.
 */
function DeliveryWindowsSection({
  client,
  windows,
  initialSettings,
  busy,
  run,
}: {
  client: SupabaseClient;
  windows: DeliveryWindowRow[] | null;
  initialSettings: BusinessSettingsRow;
  busy: boolean;
  run: Run;
}) {
  const [drafts, setDrafts] = useState<WindowDraft[]>(() => toWindowDrafts(windows ?? []));
  const [removed, setRemoved] = useState<string[]>([]);
  const [advance, setAdvance] = useState(() => String(initialSettings.delivery_advance_hours ?? 4));
  const [error, setError] = useState<string | null>(null);

  if (windows === null || initialSettings.delivery_advance_hours === undefined) {
    return (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
        <legend className="px-1 text-base font-semibold text-brand-text">חלונות משלוח</legend>
        <p role="alert" className="text-sm text-brand-danger">
          יש להריץ את supabase/migrations/0017_delivery.sql במסד הנתונים כדי להגדיר חלונות משלוח.
        </p>
      </fieldset>
    );
  }

  const patch = (key: string, fields: Partial<WindowDraft>) => setDrafts((previous) => previous.map((d) => (d.key === key ? { ...d, ...fields } : d)));
  const remove = (draft: WindowDraft) => {
    setDrafts((previous) => previous.filter((d) => d.key !== draft.key));
    if (draft.id) setRemoved((previous) => [...previous, draft.id as string]);
  };

  const save = async () => {
    const problem = validateWindows(drafts, advance);
    setError(problem);
    if (problem) return;
    await run(async () => {
      for (const id of removed) {
        const result = await deleteDeliveryWindow(client, id);
        if (!result.ok) return result;
      }
      for (const draft of drafts) {
        const result = draft.id ? await updateDeliveryWindow(client, draft.id, toWindowFields(draft)) : await addDeliveryWindow(client, toWindowFields(draft));
        if (!result.ok) return result;
      }
      return updateBusinessSettings(client, { delivery_advance_hours: parseAdvanceHours(advance) ?? 4 });
    }, "חלונות המשלוח נשמרו");
    setRemoved([]);
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-4" data-testid="delivery-windows-settings">
      <legend className="px-1 text-base font-semibold text-brand-text">חלונות משלוח</legend>
      <p className="text-xs text-brand-text-muted">
        שעת היציאה היא מתי השליח יוצא עם כל ההזמנות של החלון. הלקוח יכול להזמין לחלון עד שעת הסגירה שלו. קיבולת ריקה = ללא הגבלה. בלי חלונות כלל, המשלוח
        עובד כרגיל וללא בחירה בצ׳קאאוט.
      </p>

      {drafts.length === 0 && <p className="rounded-md border border-dashed border-brand-border p-3 text-center text-sm text-brand-text-muted">עדיין לא הוגדרו חלונות.</p>}

      <div className="flex flex-col gap-3">
        {drafts.map((d, index) => (
          <div key={d.key} data-testid="window-row" className="flex flex-wrap items-end gap-3 rounded-md border border-brand-border p-3">
            <label className="flex flex-col gap-1.5 text-sm text-brand-text">
              שעת יציאה
              <input type="time" dir="ltr" aria-label={`חלון ${index + 1} — שעת יציאה`} value={d.departure} disabled={busy} onChange={(e) => patch(d.key, { departure: e.target.value })} className={`${inputClasses} w-[7.5rem]`} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-brand-text">
              סגירה להזמנה עד
              <input type="time" dir="ltr" aria-label={`חלון ${index + 1} — סגירה להזמנה`} value={d.cutoff} disabled={busy} onChange={(e) => patch(d.key, { cutoff: e.target.value })} className={`${inputClasses} w-[7.5rem]`} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-brand-text">
              קיבולת (אופציונלי)
              <input type="text" inputMode="numeric" dir="ltr" aria-label={`חלון ${index + 1} — קיבולת`} value={d.capacity} disabled={busy} onChange={(e) => patch(d.key, { capacity: e.target.value })} className={`${inputClasses} w-24`} />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-brand-text">
              <input type="checkbox" checked={d.active} disabled={busy} onChange={(e) => patch(d.key, { active: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--color-gold))]" />
              פעיל
            </label>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => remove(d)} className="text-brand-danger">
              מחיקה
            </Button>
          </div>
        ))}
      </div>

      <Button type="button" variant="secondary" disabled={busy} onClick={() => setDrafts((previous) => [...previous, newWindowDraft()])} className="self-start">
        הוספת חלון
      </Button>

      <label className="flex flex-col gap-1.5 text-sm text-brand-text">
        כמה שעות מראש אפשר להזמין לחלון ({ADVANCE_HOURS_MIN}–{ADVANCE_HOURS_MAX})
        <input type="text" inputMode="numeric" dir="ltr" value={advance} disabled={busy} onChange={(e) => setAdvance(e.target.value)} className={`${inputClasses} w-24`} />
      </label>

      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={busy} className="self-start">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            שומר…
          </>
        ) : (
          "שמירה"
        )}
      </Button>
    </fieldset>
  );
}

/** VAT and the "low margin" line used by the owner's costs screen (migration 0016). Not shown to customers. */
function CostsSection({ client, initialSettings, busy, run }: { client: SupabaseClient; initialSettings: BusinessSettingsRow; busy: boolean; run: Run }) {
  const [vat, setVat] = useState(() => String(initialSettings.vat_percent ?? 18));
  const [low, setLow] = useState(() => String(initialSettings.low_margin_percent ?? 5));
  const [error, setError] = useState<string | null>(null);

  if (initialSettings.vat_percent === undefined) {
    return (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
        <legend className="px-1 text-base font-semibold text-brand-text">עלויות</legend>
        <p role="alert" className="text-sm text-brand-danger">יש להריץ את supabase/migrations/0016_costs.sql במסד הנתונים כדי להגדיר מע״מ ורווח נמוך.</p>
      </fieldset>
    );
  }

  const save = async () => {
    const v = Number(vat);
    const l = Number(low);
    const ok = (n: number) => vat.trim() !== "" && Number.isFinite(n) && n >= 0 && n < 100;
    const problem = !ok(v) || low.trim() === "" || !ok(l) ? "יש להזין אחוזים מ-0 עד 99." : null;
    setError(problem);
    if (problem) return;
    await run(() => updateBusinessSettings(client, { vat_percent: v, low_margin_percent: l }), "הגדרות העלויות נשמרו");
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-4" data-testid="costs-settings">
      <legend className="px-1 text-base font-semibold text-brand-text">עלויות</legend>
      <p className="text-xs text-brand-text-muted">משמש רק את מסך "עלויות ורווח". הלקוחות לא רואים את זה.</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1.5 text-sm text-brand-text">
          מע״מ (%)
          <input type="text" inputMode="decimal" dir="ltr" value={vat} disabled={busy} onChange={(e) => setVat(e.target.value)} className={`${inputClasses} w-28`} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-brand-text">
          רווח נמוך — מתחת ל־(%)
          <input type="text" inputMode="decimal" dir="ltr" value={low} disabled={busy} onChange={(e) => setLow(e.target.value)} className={`${inputClasses} w-28`} />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={busy} className="self-start">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            שומר…
          </>
        ) : (
          "שמירה"
        )}
      </Button>
    </fieldset>
  );
}

function OrdersSection({
  client, initialHours, initialSettings, currentOrdersPaused, busy, run,
}: {
  client: SupabaseClient;
  initialHours: BusinessHourRow[];
  initialSettings: BusinessSettingsRow;
  currentOrdersPaused: boolean;
  busy: boolean;
  run: Run;
}) {
  const [draft, setDraft] = useState<DayDraft[]>(() => toDayDrafts(initialHours));
  const [minOrder, setMinOrder] = useState(() => String(initialSettings.min_order_cents / 100));
  const [deliveryFee, setDeliveryFee] = useState(() => String(initialSettings.delivery_fee_cents / 100));
  const [error, setError] = useState<string | null>(null);
  const patchDay = (day: number, patch: Partial<DayDraft>) => setDraft((prev) => prev.map((d, i) => (i === day ? { ...d, ...patch } : d)));

  const minOrderCents = Math.round(Number(minOrder) * 100);
  const deliveryFeeCents = Math.round(Number(deliveryFee) * 100);
  const amountsValid = Number.isFinite(minOrderCents) && minOrderCents >= 0 && Number.isFinite(deliveryFeeCents) && deliveryFeeCents >= 0;

  const save = async () => {
    const problem = validateDayDrafts(draft) ?? (!amountsValid ? "יש להזין סכומים תקינים (0 ומעלה) למינימום הזמנה ולדמי משלוח." : null);
    setError(problem);
    if (problem) return;
    await run(async () => {
      for (let day = 0; day < 7; day++) {
        const d = draft[day];
        const result = await updateBusinessHourDay(client, "orders", day, { is_open: d.is_open, open_time: d.is_open ? d.open_time : null, close_time: d.is_open ? d.close_time : null });
        if (!result.ok) return result;
      }
      return updateBusinessSettings(client, { min_order_cents: minOrderCents, delivery_fee_cents: deliveryFeeCents });
    }, "הגדרות ההזמנות נשמרו");
  };

  const togglePause = () =>
    void run(() => updateBusinessSettings(client, { orders_paused: !currentOrdersPaused }), currentOrdersPaused ? "קבלת הזמנות אונליין הופעלה מחדש" : "הזמנות אונליין הושבתו זמנית");

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated p-4">
      <legend className="px-1 text-base font-semibold text-brand-text">הזמנות אונליין</legend>

      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5 ${currentOrdersPaused ? "border-brand-danger/40 bg-brand-danger/10" : "border-brand-border"}`}>
        <div>
          <p className="text-sm font-medium text-brand-text">השבתת הזמנות זמנית</p>
          <p className="text-xs text-brand-text-muted">
            {currentOrdersPaused
              ? "הזמנות אונליין סגורות כרגע ידנית, גם אם לפי הלו״ז הן צריכות להיות פתוחות."
              : "כשמופעל, ההזמנות נסגרות מיידית — גם אם לפי הלו״ז הן צריכות להיות פתוחות. אין דרך להפעיל הזמנות מעבר ללו״ז המוגדר."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={currentOrdersPaused}
          aria-label="השבתת הזמנות זמנית"
          disabled={busy}
          onClick={togglePause}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${currentOrdersPaused ? "bg-brand-danger" : "bg-brand-border"}`}
        >
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${currentOrdersPaused ? "start-1" : "start-6"}`} />
        </button>
      </div>

      <HoursEditor scheduleName="הזמנות אונליין" draft={draft} onChange={patchDay} disabled={busy} />

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1.5 text-sm text-brand-text">
          מינימום הזמנה למשלוח (₪)
          <input type="number" step="0.01" min="0" dir="ltr" value={minOrder} disabled={busy} onChange={(e) => setMinOrder(e.target.value)} className={`${inputClasses} w-32`} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-brand-text">
          דמי משלוח (₪)
          <input type="number" step="0.01" min="0" dir="ltr" value={deliveryFee} disabled={busy} onChange={(e) => setDeliveryFee(e.target.value)} className={`${inputClasses} w-32`} />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={busy} className="self-start">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            שומר…
          </>
        ) : (
          "שמירה"
        )}
      </Button>
    </fieldset>
  );
}

/**
 * Business Settings: the physical store's weekly opening hours, and everything about online orders (weekly
 * hours, minimum order, delivery fee, and a manual pause) — two clearly separate concepts kept in two
 * sections, backed by supabase/migrations/0008_business_settings.sql. The storefront reads all of it through
 * get_business_settings() (src/lib/businessSettingsApi.ts / src/context/BusinessSettingsContext.tsx).
 */
export function BusinessSettingsPage({ client }: { client: SupabaseClient }) {
  const { data, status, loadError, busy, feedback, dismissFeedback, reload, run } = useBusinessSettingsManager(client);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-brand-text">הגדרות עסק</h1>
      <FeedbackBanner feedback={feedback} onDismiss={dismissFeedback} />

      {status === "loading" && !data ? (
        <div role="status" className="flex items-center justify-center gap-2 py-16 text-brand-text-muted">
          <Loader2 size={22} className="animate-spin text-brand-gold" aria-hidden="true" />
          טוען הגדרות…
        </div>
      ) : status === "error" || !data ? (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
          <p role="alert" className="mb-4 text-brand-danger">
            {loadError?.kind === "setup-needed" ? loadError.message : "לא ניתן לטעון את ההגדרות כרגע."}
          </p>
          <Button onClick={reload}>נסו שוב</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <StoreHoursSection client={client} initial={data.storeHours} busy={busy} run={run} />
          <OrdersSection
            client={client}
            initialHours={data.orderHours}
            initialSettings={data.settings}
            currentOrdersPaused={data.settings.orders_paused}
            busy={busy}
            run={run}
          />
          <DeliveryWindowsSection key={`windows-${JSON.stringify(data.windows)}-${data.settings.delivery_advance_hours ?? "x"}`} client={client} windows={data.windows} initialSettings={data.settings} busy={busy} run={run} />
          <FulfillmentSection client={client} initialSettings={data.settings} busy={busy} run={run} />
          <CostsSection client={client} initialSettings={data.settings} busy={busy} run={run} />
        </div>
      )}
    </div>
  );
}

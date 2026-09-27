import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { updateBusinessHourDay, updateBusinessSettings, type BusinessHourRow, type BusinessSettingsRow } from "@/admin/settings/settingsApi";
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
          מינימום הזמנה (₪)
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
        </div>
      )}
    </div>
  );
}

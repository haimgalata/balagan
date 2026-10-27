import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChevronLeft, ChevronRight, Download, Loader2, Phone } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { downloadTextFile } from "@/admin/customers/downloadFile";
import { formatDateTime } from "@/admin/orders/orderModel";
import { telHref } from "@/admin/orders/runModel";
import {
  buildPayrollCsv,
  centsToInput,
  currentMonth,
  formatShekels,
  monthLabel,
  parseShekels,
  payrollFileName,
  pendingRows,
  remainingCents,
  shiftMonth,
  type CourierPayroll,
  type Payroll,
  type PayrollRow,
} from "@/admin/couriers/couriersModel";
import { deletePayout, loadPayroll, recordPayout, setCourierRate, setDefaultRate, setOrderPay, type PayResult } from "@/admin/couriers/couriersApi";
import type { OrderError } from "@/admin/orders/ordersErrors";

const inputClasses =
  "rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-50";

type Run = (action: () => Promise<PayResult<null>>, success: string) => Promise<boolean>;

function Stat({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-brand-border bg-brand-bg px-3 py-2">
      <dt className="text-xs text-brand-text-muted">{label}</dt>
      <dd className={`mt-0.5 text-lg font-bold ${tone || "text-brand-text"}`}>{value}</dd>
    </div>
  );
}

/** One delivery of the month. A failed one still waiting for the owner offers "pay the rate / pay nothing / another amount". */
function DeliveryRow({ client, row, rate, busy, run }: { client: SupabaseClient; row: PayrollRow; rate: number; busy: boolean; run: Run }) {
  const [amount, setAmount] = useState(row.pay_cents === null ? "" : centsToInput(row.pay_cents));
  const [editing, setEditing] = useState(false);
  const pending = row.outcome === "failed" && row.pay_cents === null;
  const save = (cents: number) => run(() => setOrderPay(client, row.order_id, cents), "התשלום על ההזמנה עודכן").then((ok) => ok && setEditing(false));
  const parsed = parseShekels(amount);

  return (
    <li data-testid="pay-row" data-pending={pending || undefined} className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm ${pending ? "border-brand-gold bg-brand-gold/5" : "border-brand-border"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <a href={`/admin/orders/${row.order_number}`} className="font-semibold text-brand-gold underline underline-offset-2">
            #{row.order_number}
          </a>
          <span className="text-brand-text">{row.address}</span>
          <span className="text-xs text-brand-text-muted">{formatDateTime(row.happened_at)}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${row.outcome === "delivered" ? "bg-brand-success/20 text-brand-success" : "bg-brand-danger/20 text-brand-danger"}`}>
            {row.outcome === "delivered" ? "נמסרה" : "לא נמסרה"}
          </span>
          <strong data-testid="row-pay">{row.pay_cents === null ? "ממתין להחלטה" : formatShekels(row.pay_cents)}</strong>
        </span>
      </div>
      {row.outcome === "failed" && row.reason && <p className="text-xs text-brand-danger">סיבה: {row.reason}</p>}

      {pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save(rate)}>
            לשלם תעריף מלא ({formatShekels(rate)})
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save(0)}>
            בלי תשלום
          </Button>
        </div>
      )}
      {!editing ? (
        <button type="button" onClick={() => setEditing(true)} className="self-start text-xs text-brand-gold underline underline-offset-2">
          {pending ? "סכום אחר" : "שינוי סכום"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            aria-label={`סכום לשליח על הזמנה ${row.order_number} (₪)`}
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
            className={`${inputClasses} w-28`}
          />
          <Button size="sm" disabled={busy || parsed === null} onClick={() => parsed !== null && void save(parsed)}>
            שמירה
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            ביטול
          </Button>
        </div>
      )}
    </li>
  );
}

function CourierCard({ client, courier, month, defaultRate, busy, run }: { client: SupabaseClient; courier: CourierPayroll; month: string; defaultRate: number; busy: boolean; run: Run }) {
  const [rate, setRate] = useState(courier.rate_override_cents === null ? "" : centsToInput(courier.rate_override_cents));
  const [payout, setPayout] = useState("");
  const [note, setNote] = useState("");
  const [armedDelete, setArmedDelete] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = remainingCents(courier);
  const pending = pendingRows(courier);

  const saveRate = (value: string) => {
    if (value.trim() === "") {
      setError(null);
      return void run(() => setCourierRate(client, courier.courier_id, null), "התעריף של השליח חזר לברירת המחדל");
    }
    const cents = parseShekels(value);
    if (cents === null) return setError("יש להזין סכום תקין (למשל 12 או 12.5).");
    setError(null);
    void run(() => setCourierRate(client, courier.courier_id, cents), "התעריף של השליח נשמר");
  };
  const savePayout = () => {
    const cents = parseShekels(payout);
    if (cents === null || cents === 0) return setError("יש להזין סכום תשלום גדול מ-0.");
    setError(null);
    void run(() => recordPayout(client, courier.courier_id, month, cents, note), "התשלום נרשם").then((ok) => {
      if (ok) {
        setPayout("");
        setNote("");
      }
    });
  };

  return (
    <article data-testid="courier-pay" data-courier={courier.name} className="space-y-4 rounded-xl border border-brand-border bg-brand-bg-elevated p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-brand-text">
            {courier.name}
            {!courier.active && <span className="ms-2 text-xs font-normal text-brand-text-muted">(כבר לא שליח)</span>}
          </h2>
          {courier.phone && (
            <a href={telHref(courier.phone)} className="inline-flex items-center gap-1.5 text-sm text-brand-gold">
              <Phone size={14} aria-hidden="true" />
              <span dir="ltr">{courier.phone}</span>
            </a>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => downloadTextFile(payrollFileName(courier, month), buildPayrollCsv(courier))}
          disabled={courier.rows.length === 0}
        >
          <Download size={14} aria-hidden="true" />
          ייצוא CSV
        </Button>
      </header>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="נמסרו" value={courier.delivered} />
        <Stat label="לא נמסרו" value={courier.failed} />
        <Stat label="ריצות" value={courier.runs} />
        <Stat label="ימי עבודה" value={courier.days} />
      </dl>

      <dl className="grid grid-cols-3 gap-2">
        <Stat label="לתשלום" value={formatShekels(courier.pay_cents)} tone="text-brand-gold" />
        <Stat label="שולם" value={formatShekels(courier.paid_cents)} />
        <Stat label={left < 0 ? "שולם עודף" : "נשאר לשלם"} value={formatShekels(Math.abs(left))} tone={left > 0 ? "text-brand-danger" : "text-brand-success"} />
      </dl>

      {pending.length > 0 && (
        <p role="alert" className="rounded-md border border-brand-gold/50 bg-brand-gold/10 px-3 py-2 text-sm text-brand-gold">
          {pending.length === 1 ? "משלוח אחד שנכשל מחכה להחלטה שלך" : `${pending.length} משלוחים שנכשלו מחכים להחלטה שלך`} — הם לא נספרים בסכום עד שתחליט.
        </p>
      )}

      <section aria-label="תעריף" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm text-brand-text">
          תעריף לכל משלוח (₪) — כרגע {formatShekels(courier.rate_cents)}
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            aria-label={`תעריף לכל משלוח של ${courier.name} (₪)`}
            placeholder={`ברירת מחדל: ${centsToInput(defaultRate)}`}
            value={rate}
            disabled={busy}
            onChange={(e) => setRate(e.target.value)}
            className={`${inputClasses} w-40`}
          />
        </label>
        <Button size="sm" disabled={busy} onClick={() => saveRate(rate)}>
          שמירת תעריף
        </Button>
        <p className="basis-full text-xs text-brand-text-muted">התעריף חל על משלוחים שנסגרים מעכשיו. משלוחים שכבר נסגרו נשארים בסכום שהיה בזמנם. ריק = ברירת המחדל.</p>
      </section>

      <section aria-label="משלוחי החודש" className="space-y-2">
        <h3 className="text-sm font-semibold text-brand-text">משלוחי החודש ({courier.rows.length})</h3>
        {courier.rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-brand-border p-3 text-center text-sm text-brand-text-muted">אין משלוחים בחודש הזה.</p>
        ) : (
          <ul className="space-y-2">
            {[...pending, ...courier.rows.filter((r) => !pending.includes(r))].map((row) => (
              <DeliveryRow key={row.order_id} client={client} row={row} rate={courier.rate_cents} busy={busy} run={run} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="תשלומים ששולמו" className="space-y-2">
        <h3 className="text-sm font-semibold text-brand-text">תשלומים ששולמו על החודש</h3>
        {courier.payouts.length > 0 && (
          <ul className="space-y-1.5">
            {courier.payouts.map((p) => (
              <li key={p.id} data-testid="payout-row" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand-border px-3 py-2 text-sm">
                <span>
                  <strong>{formatShekels(p.amount_cents)}</strong> <span className="text-xs text-brand-text-muted">· {formatDateTime(p.created_at)}{p.note ? ` · ${p.note}` : ""}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-brand-danger"
                  disabled={busy}
                  onClick={() => {
                    if (armedDelete === p.id) {
                      setArmedDelete(null);
                      void run(() => deletePayout(client, p.id), "התשלום נמחק מהרישום");
                    } else setArmedDelete(p.id);
                  }}
                >
                  {armedDelete === p.id ? "לחצו שוב למחיקה" : "מחיקה"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5 text-sm text-brand-text">
            סכום ששולם (₪)
            <input type="text" inputMode="decimal" dir="ltr" aria-label={`סכום ששולם ל${courier.name} (₪)`} value={payout} disabled={busy} onChange={(e) => setPayout(e.target.value)} className={`${inputClasses} w-32`} />
          </label>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1.5 text-sm text-brand-text">
            הערה (אופציונלי)
            <input type="text" aria-label={`הערה לתשלום ל${courier.name}`} value={note} maxLength={80} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="העברה / מזומן…" className={inputClasses} />
          </label>
          <Button size="sm" disabled={busy} onClick={savePayout}>
            רישום תשלום
          </Button>
          {left > 0 && (
            <button type="button" onClick={() => setPayout(centsToInput(left))} className="text-xs text-brand-gold underline underline-offset-2">
              כל היתרה ({formatShekels(left)})
            </button>
          )}
        </div>
        <p className="text-xs text-brand-text-muted">הרישום הוא תזכורת שלך בלבד — המערכת לא מעבירה כסף.</p>
      </section>

      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * `/admin/couriers` (owner only): what each courier is owed for a month — deliveries handed over, failed ones, runs and days
 * worked — at the rate the owner set, with the failed deliveries that wait for his decision first, a record of what he already
 * paid and a CSV for the month. The amounts are frozen by the database when a courier closes a stop (see migration 0018).
 */
export function CouriersPage({ client }: { client: SupabaseClient }) {
  const [month, setMonth] = useState(() => currentMonth());
  const [payroll, setPayroll] = useState<Payroll | null>(null);
  const [loadError, setLoadError] = useState<OrderError | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [defaultRate, setDefaultRateText] = useState("");

  const load = useCallback(async () => {
    const result = await loadPayroll(client, month);
    if (result.ok) {
      setPayroll(result.data);
      setLoadError(null);
      setDefaultRateText(centsToInput(result.data.default_rate_cents));
    } else {
      setLoadError(result.error);
    }
  }, [client, month]);

  useEffect(() => {
    setPayroll(null);
    void load();
  }, [load]);

  const run: Run = async (action, success) => {
    setBusy(true);
    const result = await action();
    setFeedback(result.ok ? { ok: true, message: success } : { ok: false, message: result.error.message });
    await load();
    setBusy(false);
    return result.ok;
  };

  const saveDefault = () => {
    const cents = parseShekels(defaultRate);
    if (cents === null) return setFeedback({ ok: false, message: "יש להזין סכום תקין (למשל 12 או 12.5)." });
    void run(() => setDefaultRate(client, cents), "ברירת המחדל לתעריף נשמרה");
  };

  return (
    <div className="space-y-5" data-testid="couriers-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-text">שכר שליחים</h1>
        <div className="flex items-center gap-1" role="group" aria-label="חודש">
          <Button size="sm" variant="secondary" aria-label="החודש הקודם" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
          <span className="min-w-[8rem] text-center text-base font-semibold text-brand-text" data-testid="month-label">
            {monthLabel(month)}
          </span>
          <Button size="sm" variant="secondary" aria-label="החודש הבא" disabled={month >= currentMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {feedback && (
        <p
          role={feedback.ok ? "status" : "alert"}
          className={`rounded-md border px-3 py-2 text-sm ${feedback.ok ? "border-brand-success/40 bg-brand-success/10 text-brand-success" : "border-brand-danger/40 bg-brand-danger/10 text-brand-danger"}`}
        >
          {feedback.message}
        </p>
      )}
      {loadError && !payroll && (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-6 text-center">
          <p role="alert" className="mb-4 text-brand-danger">
            {loadError.message}
          </p>
          <Button onClick={() => void load()}>נסו שוב</Button>
        </div>
      )}
      {!payroll && !loadError && (
        <div role="status" className="flex justify-center p-10 text-brand-gold">
          <Loader2 className="animate-spin" aria-label="טוען" />
        </div>
      )}

      {payroll && (
        <>
          <section aria-label="תעריף ברירת מחדל" className="flex flex-wrap items-end gap-3 rounded-xl border border-brand-border bg-brand-bg-elevated p-4">
            <label className="flex flex-col gap-1.5 text-sm text-brand-text">
              כמה לשלם לשליח על כל משלוח (₪) — ברירת מחדל לכולם
              <input type="text" inputMode="decimal" dir="ltr" aria-label="תעריף ברירת מחדל לכל משלוח (₪)" value={defaultRate} disabled={busy} onChange={(e) => setDefaultRateText(e.target.value)} className={`${inputClasses} w-32`} />
            </label>
            <Button size="sm" disabled={busy} onClick={saveDefault}>
              שמירה
            </Button>
            <p className="basis-full text-xs text-brand-text-muted">
              זה לא תלוי בדמי המשלוח שהלקוח משלם — אתה קובע כמה השליח מקבל. אפשר לתת לשליח מסוים תעריף משלו בכרטיס שלו.
            </p>
          </section>

          {payroll.couriers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-brand-border p-6 text-center text-sm text-brand-text-muted">
              עדיין אין שליחים או משלוחים בחודש הזה. כשמשלוח ייסגר על ידי שליח, הוא יופיע כאן.
            </p>
          ) : (
            payroll.couriers.map((courier) => (
              <CourierCard key={courier.courier_id} client={client} courier={courier} month={month} defaultRate={payroll.default_rate_cents} busy={busy} run={run} />
            ))
          )}
        </>
      )}
    </div>
  );
}

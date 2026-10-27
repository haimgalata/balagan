import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { currentMonth, monthLabel, shiftMonth } from "@/admin/couriers/couriersModel";
import { formatTime } from "@/admin/orders/orderModel";
import type { OrderError } from "@/admin/orders/ordersErrors";
import { loadHistory } from "@/admin/courier/courierApi";
import { shortDate, timeLabel, type CourierHistory } from "@/admin/courier/courierModel";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-brand-border bg-brand-bg px-3 py-2">
      <dt className="text-xs text-brand-text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold text-brand-text">{value}</dd>
    </div>
  );
}

/**
 * "ההיסטוריה שלי" — what this courier did in a month: the totals, and per run when it left and finished with one line per stop
 * (order number, delivered or not, the reason if not). Numbers only: no customer, address or item, and no money (migration 0019).
 */
export function CourierHistoryView({ client }: { client: SupabaseClient }) {
  const [month, setMonth] = useState(() => currentMonth());
  const [history, setHistory] = useState<CourierHistory | null>(null);
  const [error, setError] = useState<OrderError | null>(null);

  const load = useCallback(async () => {
    const result = await loadHistory(client, month);
    if (result.ok) {
      setHistory(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [client, month]);

  useEffect(() => {
    setHistory(null);
    void load();
  }, [load]);

  return (
    <div className="space-y-4" data-testid="courier-history">
      <div className="flex items-center justify-between gap-2" role="group" aria-label="חודש">
        <Button size="sm" variant="secondary" aria-label="החודש הקודם" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        <span className="text-base font-semibold text-brand-text" data-testid="history-month">
          {monthLabel(month)}
        </span>
        <Button size="sm" variant="secondary" aria-label="החודש הבא" disabled={month >= currentMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
          <ChevronLeft size={16} aria-hidden="true" />
        </Button>
      </div>

      {error && !history && (
        <div className="rounded-lg border border-brand-border bg-brand-bg-elevated p-4 text-center">
          <p role="alert" className="mb-3 text-sm text-brand-danger">
            {error.message}
          </p>
          <Button size="sm" onClick={() => void load()}>
            נסו שוב
          </Button>
        </div>
      )}
      {!history && !error && (
        <div role="status" className="flex justify-center p-8 text-brand-gold">
          <Loader2 className="animate-spin" aria-label="טוען" />
        </div>
      )}

      {history && (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="סיכום החודש">
            <Stat label="נמסרו" value={history.delivered} />
            <Stat label="לא נמסרו" value={history.failed} />
            <Stat label="ריצות" value={history.runs} />
            <Stat label="ימי עבודה" value={history.days} />
          </dl>

          {history.run_list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-brand-border p-4 text-center text-sm text-brand-text-muted">אין ריצות בחודש הזה.</p>
          ) : (
            <ul className="space-y-3">
              {history.run_list.map((run) => (
                <li key={run.run_id} data-testid="history-run" className="rounded-xl border border-brand-border bg-brand-bg-elevated p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-bold text-brand-text">
                      {shortDate(run.run_date)} · ריצת {run.departure_time ? timeLabel(run.departure_time) : "—"}
                    </h3>
                    <span className="text-xs text-brand-text-muted">
                      {run.departed_at ? `יצאה ${formatTime(run.departed_at)}` : ""}
                      {run.finished_at ? ` · הסתיימה ${formatTime(run.finished_at)}` : ""}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {run.stops.map((stop) => (
                      <li key={stop.order_number} data-testid="history-stop" data-outcome={stop.outcome} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2 text-brand-text">
                          {stop.outcome === "delivered" ? <Check size={14} className="text-brand-success" aria-hidden="true" /> : <X size={14} className="text-brand-danger" aria-hidden="true" />}
                          הזמנה #{stop.order_number}
                        </span>
                        <span className={`text-xs ${stop.outcome === "delivered" ? "text-brand-success" : "text-brand-danger"}`}>
                          {stop.outcome === "delivered" ? "נמסרה" : `לא נמסרה${stop.reason ? ` — ${stop.reason}` : ""}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

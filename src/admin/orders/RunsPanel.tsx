import { useEffect, useState } from "react";
import { Loader2, Phone } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import type { OrderActions } from "@/admin/orders/useOrderActions";
import { formatTime, type OrderRow } from "@/admin/orders/orderModel";
import { RUN_STATUS_LABEL, runDepartureLabel, runOrders, telHref, type RunRow } from "@/admin/orders/runModel";

function RunRowView({ run, orders, actions }: { run: RunRow; orders: OrderRow[]; actions: OrderActions }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const busy = actions.busyId === run.id;
  const mine = runOrders(run, orders);
  const tone =
    run.status === "open" ? "border-brand-border" : run.status === "claimed" ? "border-brand-gold/60" : "border-brand-success/50";

  return (
    <li data-testid="run-row" data-run-status={run.status} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-brand-bg-elevated px-3 py-2.5 ${tone}`}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-brand-text">
          ריצת {runDepartureLabel(run)} · {mine.length} {mine.length === 1 ? "הזמנה" : "הזמנות"}
        </span>
        <span className="text-xs text-brand-text-muted">
          {RUN_STATUS_LABEL[run.status]}
          {run.status === "claimed" && run.claimed_at ? ` ב-${formatTime(run.claimed_at)}` : ""}
          {run.status === "departed" && run.departed_at ? ` ב-${formatTime(run.departed_at)}` : ""}
        </span>
      </div>

      {run.status !== "open" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-brand-text" data-testid="run-courier">
            {run.courier_name ?? "שליח"}
          </span>
          {run.courier_phone && (
            <a
              href={telHref(run.courier_phone)}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-border px-2.5 py-1.5 text-sm text-brand-gold outline-none hover:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold"
              aria-label={`חיוג ל${run.courier_name ?? "שליח"}`}
            >
              <Phone size={14} aria-hidden="true" />
              <span dir="ltr">{run.courier_phone}</span>
            </a>
          )}
          {run.status === "claimed" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-brand-danger"
              onClick={() => {
                if (armed) {
                  setArmed(false);
                  void actions.releaseRun(run.id);
                } else setArmed(true);
              }}
            >
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {armed ? "לחצו שוב לשחרור השליח" : "שחרור השליח"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Delivery runs that are waiting for a courier, taken, or on the road — who took each one, and a button to ring him. */
export function RunsPanel({ runs, orders, actions }: { runs: RunRow[]; orders: OrderRow[]; actions: OrderActions }) {
  if (runs.length === 0) return null;
  return (
    <section aria-label="ריצות משלוח" data-testid="runs-panel" className="rounded-xl border border-brand-border p-3">
      <h2 className="mb-2 text-base font-semibold text-brand-text">ריצות משלוח ({runs.length})</h2>
      <ul className="space-y-2">
        {runs.map((run) => (
          <RunRowView key={run.id} run={run} orders={orders} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

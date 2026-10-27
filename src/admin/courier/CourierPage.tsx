import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Check, Loader2, MapPin, Phone, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { formatShekel } from "@/admin/orders/orderModel";
import {
  amountToCollectCents,
  callHref,
  canDepart,
  canRelease,
  FAIL_REASONS,
  failPaysCourier,
  isOpenStop,
  runProgress,
  stopAddress,
  stopDetails,
  stopName,
  timeLabel,
  wazeHref,
  type MyRun,
  type OpenRun,
  type Stop,
} from "@/admin/courier/courierModel";
import { claimRun, completeStop, departRun, failStop, releaseRun, type CourierResult } from "@/admin/courier/courierApi";
import { useCourierRuns } from "@/admin/courier/useCourierRuns";
import { CourierHistoryView } from "@/admin/courier/CourierHistoryView";

const STOP_BADGE: Record<Stop["order_status"], { text: string; tone: string }> = {
  ready_for_dispatch: { text: "מוכנה ליציאה", tone: "bg-brand-bg text-brand-text" },
  out_for_delivery: { text: "בדרך", tone: "bg-brand-gold/20 text-brand-gold" },
  completed: { text: "נמסרה", tone: "bg-brand-success/20 text-brand-success" },
  delivery_failed: { text: "לא נמסרה", tone: "bg-brand-danger/20 text-brand-danger" },
};

const linkButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-brand-border px-4 py-2.5 text-sm font-medium text-brand-gold outline-none hover:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold";

function StopCard({
  stop,
  index,
  onRoad,
  isNext,
  busy,
  onDeliver,
  onFail,
}: {
  stop: Stop;
  /** the stop's place in the route (stays the same when it moves to the "done" part of the list) */
  index: number;
  onRoad: boolean;
  /** the next stop to hand over — highlighted so the courier always sees what comes now */
  isNext: boolean;
  busy: boolean;
  onDeliver: (idChecked: boolean) => Promise<boolean>;
  onFail: (reason: string, pay: boolean | null) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"deliver" | "fail" | null>(null);
  const [idChecked, setIdChecked] = useState(false);
  const [reason, setReason] = useState<string>(FAIL_REASONS[0]);
  const [otherText, setOtherText] = useState("");
  const details = stopDetails(stop);
  const owed = amountToCollectCents(stop);
  const badge = STOP_BADGE[stop.order_status];
  const finalReason = reason === "אחר" ? otherText.trim() : reason;

  // A stop that is already handed over shrinks to one line: what is left to do must stand out.
  if (stop.order_status === "completed") {
    return (
      <li data-testid="courier-stop" data-order-number={stop.order_number} data-status={stop.order_status} className="flex items-center justify-between gap-2 rounded-lg border border-brand-border/60 bg-brand-bg px-3 py-2 text-sm text-brand-text-muted">
        <span className="flex items-center gap-2">
          <Check size={16} className="text-brand-success" aria-hidden="true" />
          {index + 1}. {stopAddress(stop)} · #{stop.order_number}
        </span>
        <span className="text-xs text-brand-success">נמסרה</span>
      </li>
    );
  }

  return (
    <li data-testid="courier-stop" data-order-number={stop.order_number} data-status={stop.order_status} data-next={isNext || undefined} className={`rounded-xl border bg-brand-bg-elevated p-3 ${isNext ? "border-brand-gold ring-1 ring-brand-gold/60" : "border-brand-border"}`}>
      {isNext && <p className="mb-1 text-xs font-semibold text-brand-gold">העצירה הבאה</p>}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-border text-xs font-semibold text-brand-text-muted">{index + 1}</span>
          <span className="text-lg font-bold text-brand-text">{stopAddress(stop)}</span>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.tone}`}>{badge.text}</span>
      </div>
      {details.length > 0 && <p className="mt-1 text-sm text-brand-text">{details.join(" · ")}</p>}
      <p className="mt-1 text-sm text-brand-text-muted">
        #{stop.order_number} · {stopName(stop)}
      </p>
      {stop.notes && <p className="mt-1 rounded bg-brand-bg px-2 py-1 text-xs text-brand-text-muted">הערה: {stop.notes}</p>}
      {owed > 0 && <p className="mt-1 text-sm font-semibold text-brand-gold">לגבות במזומן: {formatShekel(owed)}</p>}
      {stop.order_status === "delivery_failed" && stop.failed_reason && <p className="mt-1 text-xs text-brand-danger">{stop.failed_reason}</p>}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <a href={callHref(stop.phone)} className={linkButton} aria-label={`חיוג ל${stopName(stop)}`}>
          <Phone size={16} aria-hidden="true" />
          <span dir="ltr">{stop.phone}</span>
        </a>
        <a href={wazeHref(stop)} target="_blank" rel="noreferrer" className={linkButton}>
          <MapPin size={16} aria-hidden="true" />
          ניווט ב-Waze
        </a>
      </div>

      {onRoad && stop.order_status === "out_for_delivery" && mode === null && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="lg" className="!py-3.5" disabled={busy} onClick={() => setMode("deliver")}>
            <Check size={18} aria-hidden="true" />
            נמסר
          </Button>
          <Button size="lg" variant="secondary" className="!py-3.5" disabled={busy} onClick={() => setMode("fail")}>
            <X size={18} aria-hidden="true" />
            לא נמסר
          </Button>
        </div>
      )}

      {mode === "deliver" && (
        <div className="mt-3 space-y-3 rounded-lg border border-brand-gold/50 bg-brand-gold/5 p-3">
          <label className="flex items-start gap-3 text-sm text-brand-text">
            <input type="checkbox" checked={idChecked} onChange={(event) => setIdChecked(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--color-gold))]" />
            <span>בדקתי תעודה מזהה והמקבל בן/בת 18 ומעלה</span>
          </label>
          <div className="flex gap-2">
            <Button
              size="lg"
              className="flex-1 !py-3"
              disabled={!idChecked || busy}
              onClick={() => void onDeliver(true).then((ok) => ok && setMode(null))}
            >
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              אישור מסירה
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              חזרה
            </Button>
          </div>
        </div>
      )}

      {mode === "fail" && (
        <div className="mt-3 space-y-3 rounded-lg border border-brand-danger/50 bg-brand-danger/5 p-3">
          <label className="flex flex-col gap-1.5 text-sm text-brand-text">
            סיבה
            <select value={reason} onChange={(event) => setReason(event.target.value)} className="rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text">
              {FAIL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {reason === "אחר" && (
            <input
              value={otherText}
              onChange={(event) => setOtherText(event.target.value)}
              aria-label="פירוט הסיבה"
              placeholder="פירוט"
              className="w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text"
            />
          )}
          <p className="text-xs text-brand-text-muted">ההזמנה חוזרת לחנות. יש להחזיר את המוצרים לחנות.</p>
          <div className="flex gap-2">
            <Button
              size="lg"
              variant="secondary"
              className="flex-1 !py-3"
              disabled={finalReason === "" || busy}
              onClick={() => void onFail(finalReason, failPaysCourier(reason)).then((ok) => ok && setMode(null))}
            >
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              אישור — לא נמסר
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              חזרה
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function MyRunCard({
  client,
  run,
  busyKey,
  act,
}: {
  client: SupabaseClient;
  run: MyRun;
  busyKey: string | null;
  act: (key: string, fn: () => Promise<CourierResult<{ changed: boolean }>>) => Promise<boolean>;
}) {
  const [armedRelease, setArmedRelease] = useState(false);
  const progress = runProgress(run);
  const onRoad = run.status === "departed";
  const runBusy = busyKey === run.id;
  // What is left comes first, in route order; what is done sinks to the bottom (numbers keep their route position).
  const numbered = run.stops.map((stop, index) => ({ stop, index }));
  const ordered = [...numbered.filter((s) => isOpenStop(s.stop)), ...numbered.filter((s) => !isOpenStop(s.stop))];
  const nextId = onRoad ? ordered.find((s) => s.stop.order_status === "out_for_delivery")?.stop.order_id : undefined;

  return (
    <section aria-label={`ריצת ${timeLabel(run.departure_time)}`} data-testid="my-run" data-run-status={run.status} className="space-y-3 rounded-2xl border border-brand-gold/50 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-brand-text">ריצת {timeLabel(run.departure_time)}</h3>
          <p className="text-sm text-brand-text-muted">
            {progress.total} עצירות · נמסרו {progress.delivered}
            {progress.failed > 0 ? ` · לא נמסרו ${progress.failed}` : ""}
            {progress.remaining > 0 ? ` · נשארו ${progress.remaining}` : ""}
          </p>
        </div>
        {onRoad && <span className="rounded-full bg-brand-gold/20 px-3 py-1 text-sm font-medium text-brand-gold">בדרך</span>}
        {run.status === "finished" && <span className="rounded-full bg-brand-success/20 px-3 py-1 text-sm font-medium text-brand-success">הסתיימה</span>}
      </header>

      {canDepart(run) && (
        <Button size="lg" className="w-full !py-4 text-base" disabled={runBusy} onClick={() => void act(run.id, () => departRun(client, run.id))}>
          {runBusy && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}
          יצאתי
        </Button>
      )}

      <ol className="space-y-3">
        {ordered.map(({ stop, index }) => (
          <StopCard
            key={stop.order_id}
            stop={stop}
            index={index}
            onRoad={onRoad}
            isNext={stop.order_id === nextId}
            busy={busyKey === stop.order_id}
            onDeliver={(idChecked) => act(stop.order_id, () => completeStop(client, stop.order_id, idChecked))}
            onFail={(reason, pay) => act(stop.order_id, () => failStop(client, stop.order_id, reason, pay))}
          />
        ))}
      </ol>

      {canRelease(run) && (
        <Button
          size="sm"
          variant="ghost"
          className="text-brand-danger"
          disabled={runBusy}
          onClick={() => {
            if (armedRelease) {
              setArmedRelease(false);
              void act(run.id, () => releaseRun(client, run.id));
            } else setArmedRelease(true);
          }}
        >
          {armedRelease ? "לחצו שוב לשחרור הריצה" : "שחרור הריצה (לא אוכל לקחת אותה)"}
        </Button>
      )}
    </section>
  );
}

function OpenRunCard({ run, busy, onClaim }: { run: OpenRun; busy: boolean; onClaim: () => void }) {
  return (
    <li data-testid="open-run" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-border bg-brand-bg-elevated p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-base font-semibold text-brand-text">
          ריצת {timeLabel(run.departure_time)} · {run.order_count} {run.order_count === 1 ? "הזמנה" : "הזמנות"}
        </span>
        {run.streets.length > 0 && <span className="text-sm text-brand-text-muted">{run.streets.join(", ")}</span>}
      </div>
      <Button size="lg" disabled={busy} onClick={onClaim}>
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        אני לוקח
      </Button>
    </li>
  );
}

/**
 * `/admin/courier` — the delivery person's screen. Open runs show only the slot, how many orders and which streets; taking
 * one ("אני לוקח") reveals its stops with names, phones and Waze links. "יצאתי" sends every packed order out at once; each stop
 * is then marked delivered (after an ID check) or not delivered with a reason. Customer details are never shown before a run
 * is taken — the database enforces that, this screen only reflects it.
 */
export function CourierPage({ client }: { client: SupabaseClient }) {
  const { data, error, refresh } = useCourierRuns(client);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<"runs" | "history">("runs");
  const activeRuns = data?.mine.filter((run) => run.status !== "finished") ?? [];
  const finishedRuns = data?.mine.filter((run) => run.status === "finished") ?? [];

  const act = async (key: string, fn: () => Promise<CourierResult<{ changed: boolean }>>): Promise<boolean> => {
    setBusyKey(key);
    const result = await fn();
    setActionError(result.ok ? null : result.error.message);
    await refresh(); // success or "somebody got there first" alike: show what the database says now
    setBusyKey(null);
    return result.ok;
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5" data-testid="courier-page">
      <h1 className="text-xl font-bold text-brand-text">משלוחים</h1>

      <div role="tablist" aria-label="תצוגה" className="grid grid-cols-2 gap-1 rounded-xl border border-brand-border bg-brand-bg-elevated p-1">
        {([["runs", "הריצות"], ["history", "ההיסטוריה שלי"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={`min-h-11 rounded-lg px-3 text-sm font-medium transition-colors ${view === key ? "bg-brand-gold text-brand-bg" : "text-brand-text-muted hover:text-brand-text"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "history" && <CourierHistoryView client={client} />}

      {actionError && (
        <p role="alert" data-testid="courier-error" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {actionError}
        </p>
      )}
      {view === "runs" && error && !data && (
        <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
          {error.message}
        </p>
      )}
      {view === "runs" && !data && !error && (
        <div role="status" className="flex justify-center p-10 text-brand-gold">
          <Loader2 className="animate-spin" aria-label="טוען" />
        </div>
      )}

      {view === "runs" && data && (
        <>
          {activeRuns.length > 0 && (
            <section aria-label="הריצה שלי עכשיו" className="space-y-3">
              <h2 className="text-base font-semibold text-brand-text">הריצה שלי עכשיו</h2>
              {activeRuns.map((run) => (
                <MyRunCard key={run.id} client={client} run={run} busyKey={busyKey} act={act} />
              ))}
            </section>
          )}

          <section aria-label="ריצות פתוחות" className="space-y-3">
            <h2 className="text-base font-semibold text-brand-text">{activeRuns.length === 0 ? "ריצות פתוחות — לקחת" : "ריצות נוספות פתוחות"}</h2>
            {data.open.length === 0 ? (
              <p className="rounded-lg border border-dashed border-brand-border p-4 text-center text-sm text-brand-text-muted">
                {activeRuns.length === 0 ? "אין לך ריצה כרגע, ואין ריצות שמחכות לשליח." : "אין ריצות נוספות שמחכות לשליח."}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.open.map((run) => (
                  <OpenRunCard key={run.id} run={run} busy={busyKey === run.id} onClaim={() => void act(run.id, () => claimRun(client, run.id))} />
                ))}
              </ul>
            )}
          </section>

          {finishedRuns.length > 0 && (
            <details className="rounded-xl border border-brand-border bg-brand-bg-elevated" data-testid="finished-runs">
              <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-brand-text">הושלמו היום ({finishedRuns.length})</summary>
              <div className="space-y-3 p-3 pt-0">
                {finishedRuns.map((run) => (
                  <MyRunCard key={run.id} client={client} run={run} busyKey={busyKey} act={act} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

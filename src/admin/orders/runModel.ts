/**
 * Delivery runs as the back office sees them on the board (migration 0017): which courier took which departure slot,
 * and which runs need a human. Pure — no React, no Supabase — unit-tested. The database enforces everything
 * (`claim_delivery_run`, `release_delivery_run`, ...); this only decides what the screen shows and flags.
 */
import { israelDateToIso, type OrderRow } from "@/admin/orders/orderModel";

export type RunStatus = "open" | "claimed" | "departed" | "finished";

export interface RunRow {
  id: string;
  /** `YYYY-MM-DD` in Israel. */
  run_date: string;
  status: RunStatus;
  courier_name: string | null;
  courier_phone: string | null;
  claimed_at: string | null;
  departed_at: string | null;
  /** The slot (embedded from delivery_windows). */
  delivery_windows: { departure_time: string } | null;
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  open: "ממתינה לשליח",
  claimed: "נלקחה",
  departed: "בדרך",
  finished: "הסתיימה",
};

/** Runs that still matter on the board. */
export const LIVE_RUN_STATUSES = ["open", "claimed", "departed"] as const;

const hhmm = (time: string): string => time.slice(0, 5);

/** "18:00". */
export const runDepartureLabel = (run: Pick<RunRow, "delivery_windows">): string =>
  run.delivery_windows ? hhmm(run.delivery_windows.departure_time) : "—";

/**
 * When the run is due to leave, as an instant. Start of the Israel day + the slot's wall time (a day with a clock change
 * can be an hour off between 00:00 and 02:00 — only the "late" hint is affected).
 */
export function runDepartureAt(run: Pick<RunRow, "run_date" | "delivery_windows">): number | null {
  if (!run.delivery_windows) return null;
  const start = israelDateToIso(run.run_date);
  if (!start) return null;
  const [h, m, s] = run.delivery_windows.departure_time.split(":").map(Number);
  return new Date(start).getTime() + (h * 3600 + m * 60 + (s || 0)) * 1000;
}

export type RunAttentionKind = "late" | "no-courier";
export interface RunAttention {
  run: RunRow;
  kind: RunAttentionKind;
  message: string;
}

/** An unclaimed run is flagged this long before it is due to leave. */
export const NO_COURIER_WARNING_MS = 30 * 60_000;

/**
 * Runs that need the owner / staff: a courier took it but has not left once it is due (the owner decides whether to
 * ring or release him — nothing is released automatically), or nobody has taken it and it is nearly due.
 */
export function runsNeedingAttention(runs: RunRow[], now: number = Date.now()): RunAttention[] {
  const out: RunAttention[] = [];
  for (const run of runs) {
    const due = runDepartureAt(run);
    if (due === null) continue;
    const label = runDepartureLabel(run);
    if (run.status === "claimed" && now >= due) {
      out.push({ run, kind: "late", message: `${run.courier_name ?? "השליח"} לקח את ריצת ${label} אבל עוד לא יצא` });
    } else if (run.status === "open" && now >= due - NO_COURIER_WARNING_MS) {
      out.push({ run, kind: "no-courier", message: `אף שליח לא לקח את ריצת ${label}` });
    }
  }
  return out;
}

/** The orders of a run that are still to be handed over or on their way (the board's count). */
export function runOrders(run: Pick<RunRow, "id">, orders: OrderRow[]): OrderRow[] {
  return orders.filter((o) => o.delivery_run_id === run.id);
}

/** tel: link from a phone as typed ("050-123-4567"). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

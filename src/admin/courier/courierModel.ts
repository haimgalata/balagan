/**
 * Pure model of the courier's screen (migration 0017): what `courier_list_open_runs()` / `courier_my_runs()` return,
 * the links a courier taps (call, Waze), and a run's progress. No React, no Supabase — unit-tested.
 * The database decides who may do what (a courier sees customer details only for a run he has claimed).
 */
import { addressDetails } from "@/admin/orders/orderModel";

export interface OpenRun {
  id: string;
  /** `YYYY-MM-DD`, Israel */
  run_date: string;
  /** "HH:MM:SS" */
  departure_time: string;
  order_count: number;
  streets: string[];
}

export type StopStatus = "ready_for_dispatch" | "out_for_delivery" | "completed" | "delivery_failed";

export interface Stop {
  order_id: string;
  order_number: number;
  order_status: StopStatus;
  first_name: string;
  last_name: string;
  phone: string;
  city: string | null;
  street: string | null;
  house_number: string | null;
  entrance: string | null;
  floor: string | null;
  apartment: string | null;
  intercom_code: string | null;
  notes: string | null;
  payment_method: "cash" | "card";
  payment_status: string;
  total_cents: number;
  failed_reason: string | null;
}

export interface MyRun {
  id: string;
  status: "claimed" | "departed" | "finished";
  run_date: string;
  departure_time: string;
  claimed_at: string | null;
  departed_at: string | null;
  stops: Stop[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STOP_STATUSES: readonly string[] = ["ready_for_dispatch", "out_for_delivery", "completed", "delivery_failed"];

export function parseOpenRuns(value: unknown): OpenRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: OpenRun[] = [];
  for (const row of value) {
    if (!isObj(row) || typeof row.id !== "string" || typeof row.run_date !== "string" || typeof row.departure_time !== "string" || typeof row.order_count !== "number") return null;
    runs.push({
      id: row.id,
      run_date: row.run_date,
      departure_time: row.departure_time,
      order_count: row.order_count,
      streets: Array.isArray(row.streets) ? row.streets.filter((s): s is string => typeof s === "string") : [],
    });
  }
  return runs;
}

function parseStop(row: unknown): Stop | null {
  if (!isObj(row) || typeof row.order_id !== "string" || typeof row.order_number !== "number") return null;
  if (typeof row.order_status !== "string" || !STOP_STATUSES.includes(row.order_status)) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    order_id: row.order_id,
    order_number: row.order_number,
    order_status: row.order_status as StopStatus,
    first_name: str(row.first_name) ?? "",
    last_name: str(row.last_name) ?? "",
    phone: str(row.phone) ?? "",
    city: str(row.city),
    street: str(row.street),
    house_number: str(row.house_number),
    entrance: str(row.entrance),
    floor: str(row.floor),
    apartment: str(row.apartment),
    intercom_code: str(row.intercom_code),
    notes: str(row.notes),
    payment_method: row.payment_method === "cash" ? "cash" : "card",
    payment_status: str(row.payment_status) ?? "",
    total_cents: typeof row.total_cents === "number" ? row.total_cents : 0,
    failed_reason: str(row.failed_reason),
  };
}

export function parseMyRuns(value: unknown): MyRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: MyRun[] = [];
  for (const row of value) {
    if (!isObj(row) || typeof row.id !== "string" || (row.status !== "claimed" && row.status !== "departed" && row.status !== "finished")) return null;
    if (typeof row.run_date !== "string" || typeof row.departure_time !== "string" || !Array.isArray(row.stops)) return null;
    const stops = row.stops.map(parseStop);
    if (stops.some((s) => s === null)) return null;
    runs.push({
      id: row.id,
      status: row.status,
      run_date: row.run_date,
      departure_time: row.departure_time,
      claimed_at: typeof row.claimed_at === "string" ? row.claimed_at : null,
      departed_at: typeof row.departed_at === "string" ? row.departed_at : null,
      stops: stops as Stop[],
    });
  }
  return runs;
}

/** "18:00:00" -> "18:00". */
export const timeLabel = (time: string): string => time.slice(0, 5);

export const stopName = (s: Pick<Stop, "first_name" | "last_name">): string => `${s.first_name} ${s.last_name}`.trim();

/** "הרצל 12". */
export const stopAddress = (s: Pick<Stop, "street" | "house_number">): string => `${s.street ?? ""} ${s.house_number ?? ""}`.trim();

/** Entrance / floor / apartment / intercom code, only the ones present. */
export const stopDetails = (s: Pick<Stop, "entrance" | "floor" | "apartment" | "intercom_code">): string[] => addressDetails(s);

/** tel: link from a phone as typed ("050-123-4567"). */
export const callHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** Waze deep link that starts navigation to the stop's address. */
export function wazeHref(s: Pick<Stop, "street" | "house_number" | "city">): string {
  const query = [stopAddress(s), s.city].filter(Boolean).join(", ");
  return `https://waze.com/ul?q=${encodeURIComponent(query)}&navigate=yes`;
}

export interface RunProgress {
  total: number;
  delivered: number;
  failed: number;
  /** still to hand over (ready to go, or on the road) */
  remaining: number;
}
export function runProgress(run: Pick<MyRun, "stops">): RunProgress {
  const delivered = run.stops.filter((s) => s.order_status === "completed").length;
  const failed = run.stops.filter((s) => s.order_status === "delivery_failed").length;
  return { total: run.stops.length, delivered, failed, remaining: run.stops.length - delivered - failed };
}

/** The "יצאתי" button: a claimed run that has at least one packed order waiting. */
export const canDepart = (run: Pick<MyRun, "status" | "stops">): boolean =>
  run.status === "claimed" && run.stops.some((s) => s.order_status === "ready_for_dispatch");

export const canRelease = (run: Pick<MyRun, "status">): boolean => run.status === "claimed";

/** What a cash order still owes at the door (card orders are paid already). */
export const amountToCollectCents = (s: Pick<Stop, "payment_method" | "payment_status" | "total_cents">): number =>
  s.payment_method === "cash" && s.payment_status !== "paid" ? s.total_cents : 0;

const CUSTOMER_FAULT_REASONS = ["הלקוח לא היה בבית / לא ענה", "לא הוצגה תעודה מזהה", "מקבל המשלוח מתחת לגיל 18", "הלקוח סירב לקבל"] as const;

/** A stop still to be handed over (packed, or on the road). */
export const isOpenStop = (s: Pick<Stop, "order_status">): boolean => s.order_status === "ready_for_dispatch" || s.order_status === "out_for_delivery";

/**
 * Whether a failed delivery is paid, from the reason the courier chose: the customer's fault (not home, no ID, under 18,
 * refused) is paid; the rest ("address not found", "other") is left to the owner (null) — he decides in the payroll screen.
 */
export function failPaysCourier(reason: string): boolean | null {
  return (CUSTOMER_FAULT_REASONS as readonly string[]).includes(reason) ? true : null;
}

export const FAIL_REASONS = [
  "הלקוח לא היה בבית / לא ענה",
  "לא הוצגה תעודה מזהה",
  "מקבל המשלוח מתחת לגיל 18",
  "הכתובת לא נמצאה",
  "הלקוח סירב לקבל",
  "אחר",
] as const;

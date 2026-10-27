/**
 * Pure model of the owner's courier-pay screen (migration 0018): what `admin_courier_payroll()` returns, months, money in
 * shekels <-> agorot, the "left to pay" arithmetic and the monthly CSV. No React, no Supabase — unit-tested. Admin-only.
 * The amounts are decided and frozen by the database when a courier closes a stop; this only shows and sums them.
 */
import { csvCell } from "@/admin/customers/customersModel";

export type PayOutcome = "delivered" | "failed";

export interface PayrollRow {
  order_id: string;
  order_number: number;
  outcome: PayOutcome;
  reason: string | null;
  /** null = a failed delivery the owner has not decided yet */
  pay_cents: number | null;
  /** what the customer paid for delivery (not what the courier earns) */
  fee_cents: number;
  happened_at: string;
  run_date: string | null;
  departure_time: string | null;
  address: string;
}

export interface PayoutRow {
  id: number;
  amount_cents: number;
  note: string | null;
  created_at: string;
}

export interface CourierPayroll {
  courier_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** still a courier today (false = left, but was owed money in this month) */
  active: boolean;
  rate_override_cents: number | null;
  /** what he earns per delivery right now (his own rate, else the default) */
  rate_cents: number;
  delivered: number;
  failed: number;
  /** failed deliveries waiting for the owner's decision */
  pending: number;
  runs: number;
  days: number;
  pay_cents: number;
  paid_cents: number;
  rows: PayrollRow[];
  payouts: PayoutRow[];
}

export interface Payroll {
  /** `YYYY-MM-01` */
  month: string;
  default_rate_cents: number;
  couriers: CourierPayroll[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseRow(v: unknown): PayrollRow | null {
  if (!isObj(v) || typeof v.order_id !== "string" || typeof v.order_number !== "number") return null;
  if (v.outcome !== "delivered" && v.outcome !== "failed") return null;
  return {
    order_id: v.order_id,
    order_number: v.order_number,
    outcome: v.outcome,
    reason: str(v.reason),
    pay_cents: typeof v.pay_cents === "number" ? v.pay_cents : null,
    fee_cents: num(v.fee_cents),
    happened_at: str(v.happened_at) ?? "",
    run_date: str(v.run_date),
    departure_time: str(v.departure_time),
    address: str(v.address) ?? "",
  };
}

export function parsePayroll(value: unknown): Payroll | null {
  if (!isObj(value) || typeof value.month !== "string" || !Array.isArray(value.couriers)) return null;
  const couriers: CourierPayroll[] = [];
  for (const c of value.couriers) {
    if (!isObj(c) || typeof c.courier_id !== "string" || !Array.isArray(c.rows)) return null;
    const rows = c.rows.map(parseRow);
    if (rows.some((r) => r === null)) return null;
    couriers.push({
      courier_id: c.courier_id,
      name: str(c.name) ?? "שליח",
      phone: str(c.phone),
      email: str(c.email),
      active: c.active === true,
      rate_override_cents: typeof c.rate_override_cents === "number" ? c.rate_override_cents : null,
      rate_cents: num(c.rate_cents),
      delivered: num(c.delivered),
      failed: num(c.failed),
      pending: num(c.pending),
      runs: num(c.runs),
      days: num(c.days),
      pay_cents: num(c.pay_cents),
      paid_cents: num(c.paid_cents),
      rows: rows as PayrollRow[],
      payouts: Array.isArray(c.payouts)
        ? c.payouts.filter(isObj).map((p) => ({ id: num(p.id), amount_cents: num(p.amount_cents), note: str(p.note), created_at: str(p.created_at) ?? "" }))
        : [],
    });
  }
  return { month: value.month, default_rate_cents: num(value.default_rate_cents), couriers };
}

// ---- months (Israel) ------------------------------------------------------------------------------------------

/** The first day of the month `now` falls in, in Israel: `YYYY-MM-01`. */
export function currentMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-01`;
}

/** `delta` months from a `YYYY-MM-01` month. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/** "אוקטובר 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15)));
}

// ---- money ----------------------------------------------------------------------------------------------------

export const formatShekels = (cents: number): string =>
  `₪${(cents / 100).toLocaleString("he-IL", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** "12.5" / "12,50" / "₪12" -> 1250 agorot; null for anything that is not a non-negative amount. */
export function parseShekels(input: string): number | null {
  const text = input.replace(/₪/g, "").trim().replace(",", "."); // inner spaces stay, so "12 5" is refused instead of becoming 125
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

/** Agorot as the text of an amount input: 1250 -> "12.5", 1200 -> "12". */
export const centsToInput = (cents: number): string => String(cents / 100);

/** What is still owed for the month (negative = paid more than owed). */
export const remainingCents = (c: Pick<CourierPayroll, "pay_cents" | "paid_cents">): number => c.pay_cents - c.paid_cents;

/** Failed deliveries the owner still has to decide, first. */
export const pendingRows = (c: Pick<CourierPayroll, "rows">): PayrollRow[] => c.rows.filter((r) => r.outcome === "failed" && r.pay_cents === null);

// ---- CSV (what the owner keeps for the month) --------------------------------------------------------------------

const israelDate = (iso: string): string => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(iso)) : "");
const asAmount = (cents: number | null): string => (cents === null ? "" : (cents / 100).toFixed(2));

const CSV_COLUMNS = ["date", "order_number", "run_departure", "address", "outcome", "reason", "courier_pay_ils", "customer_delivery_fee_ils"] as const;

/** UTF-8 with a BOM (Excel shows Hebrew), CRLF, English column names, every cell quoted and formula-safe, a totals line at the end. */
export function buildPayrollCsv(c: CourierPayroll): string {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const r of c.rows) {
    lines.push(
      [
        israelDate(r.happened_at),
        String(r.order_number),
        r.departure_time ? r.departure_time.slice(0, 5) : "",
        r.address,
        r.outcome === "delivered" ? "delivered" : "failed",
        r.reason ?? "",
        asAmount(r.pay_cents),
        asAmount(r.fee_cents),
      ].map(csvCell).join(",")
    );
  }
  lines.push(["", "", "", "", "", "TOTAL", asAmount(c.pay_cents), ""].map(csvCell).join(","));
  lines.push(["", "", "", "", "", "PAID", asAmount(c.paid_cents), ""].map(csvCell).join(","));
  lines.push(["", "", "", "", "", "LEFT", asAmount(remainingCents(c)), ""].map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function payrollFileName(c: Pick<CourierPayroll, "name">, month: string): string {
  const safe = c.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "courier";
  return `balagan-courier-pay-${month.slice(0, 7)}-${safe}.csv`;
}

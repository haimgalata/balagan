/**
 * Pure logic for the owner's customers screen (no React / Supabase — unit-tested in
 * tests/admin/customers/customersModel.unit.spec.ts): parsing what the database functions return, the CSV for the
 * audience exports, and small display helpers. Admin-only: deliberately does not import anything from the storefront.
 */

export type AudienceKind = "sms" | "email" | "suppression";
export type MarketingFilter = "all" | "consenting" | "sms" | "email" | "withdrawn";

export const MARKETING_FILTERS: { value: MarketingFilter; label: string }[] = [
  { value: "all", label: "כל החברים" },
  { value: "consenting", label: "הסכימו לדיוור" },
  { value: "sms", label: "ניתן לשלוח SMS" },
  { value: "email", label: "ניתן לשלוח אימייל" },
  { value: "withdrawn", label: "הסירו הסכמה" },
];

export interface CustomerRow {
  id: string;
  phone: string; // E.164
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  joinedAt: string;
  lastOrderAt: string | null;
  ordersCount: number;
  marketing: boolean;
  marketingChannels: string[];
  marketingChangedAt: string | null;
}

export interface CustomerStats {
  members: number;
  joined30d: number;
  withOrders: number;
  marketingSms: number;
  marketingEmail: number;
  withdrawn: number;
  deleted: number;
  lastExports: Partial<Record<AudienceKind, { at: string; count: number }>>;
}

export interface CustomerList {
  total: number;
  rows: CustomerRow[];
}

/** One row of an audience export, exactly as the database returns it (snake_case, nothing added or hidden). */
export type AudienceRow = Record<string, string | null>;

// ------------------------------------------------------------------ parsing (trust nothing)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseStats(value: unknown): CustomerStats | null {
  if (!isObj(value)) return null;
  const lastExports: CustomerStats["lastExports"] = {};
  if (isObj(value.last_exports)) {
    for (const kind of ["sms", "email", "suppression"] as const) {
      const entry = value.last_exports[kind];
      if (isObj(entry) && typeof entry.at === "string") lastExports[kind] = { at: entry.at, count: num(entry.count) };
    }
  }
  return {
    members: num(value.members),
    joined30d: num(value.joined_30d),
    withOrders: num(value.with_orders),
    marketingSms: num(value.marketing_sms),
    marketingEmail: num(value.marketing_email),
    withdrawn: num(value.withdrawn),
    deleted: num(value.deleted),
    lastExports,
  };
}

export function parseCustomerList(value: unknown): CustomerList | null {
  if (!isObj(value) || !Array.isArray(value.rows)) return null;
  const rows = value.rows.flatMap((row): CustomerRow[] => {
    if (!isObj(row) || typeof row.id !== "string" || typeof row.phone !== "string") return [];
    return [{
      id: row.id,
      phone: row.phone,
      firstName: str(row.first_name),
      lastName: str(row.last_name),
      email: str(row.email),
      joinedAt: str(row.joined_at) ?? "",
      lastOrderAt: str(row.last_order_at),
      ordersCount: num(row.orders_count),
      marketing: row.marketing === true,
      marketingChannels: Array.isArray(row.marketing_channels) ? row.marketing_channels.filter((c): c is string => typeof c === "string") : [],
      marketingChangedAt: str(row.marketing_changed_at),
    }];
  });
  return { total: num(value.total), rows };
}

export function parseAudience(value: unknown): AudienceRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((row): AudienceRow[] =>
    isObj(row) ? [Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? v : v === null ? null : String(v)]))] : []
  );
}

// ------------------------------------------------------------------ display helpers
/** '+972501234567' -> '050-123-4567' (display only; anything else comes back unchanged). */
export function formatPhoneLocal(e164: string): string {
  const m = /^\+9725([0-9])([0-9]{3})([0-9]{4})$/.exec(e164);
  return m ? `05${m[1]}-${m[2]}-${m[3]}` : e164;
}

/** '+972501234567' -> '0501234567' (the digits-only local form many SMS tools expect). */
export function toLocalDigits(e164: string): string {
  const m = /^\+972([0-9]{8,9})$/.exec(e164);
  return m ? `0${m[1]}` : e164;
}

/** d.m.yyyy in ISRAEL time, whatever timezone the browser is in. */
export function formatIsraelDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" }).format(date);
}

/** yyyy-mm-dd in Israel time (for file names). */
export function israelIsoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return parts;
}

export function memberName(row: Pick<CustomerRow, "firstName" | "lastName">): string {
  return [row.firstName, row.lastName].filter(Boolean).join(" ");
}

/** What the "דיוור" column shows for a member. */
export function marketingLabel(row: Pick<CustomerRow, "marketing" | "marketingChannels">): string {
  if (!row.marketing) return "הסיר/ה הסכמה";
  const has = (c: string) => row.marketingChannels.includes(c);
  if (has("sms") && has("email")) return "SMS + אימייל";
  if (has("sms")) return "SMS";
  if (has("email")) return "אימייל";
  return "הסכים/ה";
}

// ------------------------------------------------------------------ CSV
const HEADERS: Record<AudienceKind, string[]> = {
  sms: ["phone", "phone_local", "first_name", "last_name", "consent_at", "wording_version"],
  email: ["email", "first_name", "last_name", "phone", "phone_local", "consent_at", "wording_version"],
  suppression: ["phone", "phone_local", "email", "reason", "at"],
};

/**
 * One CSV cell, always quoted. Anything that a spreadsheet could read as a formula (starts with = + - @ or a control
 * character) gets a leading apostrophe so a hostile name like "=HYPERLINK(...)" typed by a customer can never execute
 * when the owner opens the file — except a plain phone number ("+972…") and plain numbers, which are what they look like.
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";
  if (/^[=+\-@\t\r]/.test(text) && !/^\+\d{6,15}$/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvColumns(kind: AudienceKind): string[] {
  return HEADERS[kind];
}

/** UTF-8 with a BOM (so Excel shows Hebrew correctly), CRLF line ends, English column names (what mailing/SMS tools import). */
export function buildAudienceCsv(kind: AudienceKind, rows: AudienceRow[]): string {
  const columns = HEADERS[kind];
  const cellFor = (row: AudienceRow, column: string): string | null =>
    column === "phone_local" ? (row.phone ? toLocalDigits(row.phone) : null) : (row[column] ?? null);
  const lines = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(cellFor(row, column))).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function exportFileName(kind: AudienceKind, now: Date): string {
  return `balagan-${kind === "suppression" ? "do-not-contact" : `marketing-${kind}`}-${israelIsoDate(now)}.csv`;
}

export const AUDIENCE_LABELS: Record<AudienceKind, string> = {
  sms: "רשימת SMS",
  email: "רשימת אימייל",
  suppression: "רשימת הסרה (אין לפנות)",
};

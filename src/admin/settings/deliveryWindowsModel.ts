/**
 * Pure model of the delivery-windows editor in /admin/settings (migration 0017): the form's draft rows, the checks that
 * mirror the database's own constraints (so a bad value is caught before saving), and the payloads. No React, no Supabase.
 */
import type { DeliveryWindowFields, DeliveryWindowRow } from "@/admin/settings/settingsApi";

export interface WindowDraft {
  /** React key; stable for the life of the form */
  key: string;
  /** null for a window that has not been saved yet */
  id: string | null;
  /** "HH:MM" or "" */
  departure: string;
  cutoff: string;
  /** "" = unlimited */
  capacity: string;
  active: boolean;
}

/** "18:00:00" -> "18:00". */
export const toTimeInput = (time: string): string => time.slice(0, 5);

export function toWindowDrafts(rows: DeliveryWindowRow[]): WindowDraft[] {
  return rows.map((row) => ({
    key: row.id,
    id: row.id,
    departure: toTimeInput(row.departure_time),
    cutoff: toTimeInput(row.order_cutoff_time),
    capacity: row.capacity === null ? "" : String(row.capacity),
    active: row.is_active,
  }));
}

let counter = 0;
/** A blank row for "add a window": a sensible cut-off an hour before departure is left for the owner to type. */
export function newWindowDraft(): WindowDraft {
  counter += 1;
  return { key: `new-${counter}`, id: null, departure: "", cutoff: "", capacity: "", active: true };
}

export const ADVANCE_HOURS_MIN = 1;
export const ADVANCE_HOURS_MAX = 24;

export function parseAdvanceHours(input: string): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const hours = Number(text);
  return hours >= ADVANCE_HOURS_MIN && hours <= ADVANCE_HOURS_MAX ? hours : null;
}

/** First problem found, in Hebrew, or null when every row and the advance hours are valid. */
export function validateWindows(drafts: WindowDraft[], advanceHours: string): string | null {
  if (parseAdvanceHours(advanceHours) === null) {
    return `"כמה שעות מראש" חייב להיות מספר שלם בין ${ADVANCE_HOURS_MIN} ל-${ADVANCE_HOURS_MAX}.`;
  }
  const seen = new Set<string>();
  for (const [index, d] of drafts.entries()) {
    const row = `חלון ${index + 1}`;
    if (!d.departure) return `${row}: יש להזין שעת יציאה.`;
    if (!d.cutoff) return `${row}: יש להזין שעת סגירה להזמנה.`;
    if (d.cutoff > d.departure) return `${row}: שעת הסגירה להזמנה לא יכולה להיות אחרי שעת היציאה.`;
    if (d.capacity.trim() !== "" && !/^[1-9]\d*$/.test(d.capacity.trim())) return `${row}: קיבולת חייבת להיות מספר שלם חיובי (או ריקה = ללא הגבלה).`;
    if (seen.has(d.departure)) return `${row}: כבר יש חלון עם שעת היציאה ${d.departure}.`;
    seen.add(d.departure);
  }
  return null;
}

export function toWindowFields(d: WindowDraft): DeliveryWindowFields {
  return {
    departure_time: d.departure,
    order_cutoff_time: d.cutoff,
    capacity: d.capacity.trim() === "" ? null : Number(d.capacity.trim()),
    is_active: d.active,
  };
}

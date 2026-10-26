/**
 * Delivery windows (migration 0017) as the customer sees them: the owner's departure slots for today, each with a
 * yes/no from `get_delivery_slots()`. Pure helpers — the database decides which window an order may join
 * (cut-off, "how many hours ahead", capacity) and refuses the rest with WINDOW_*; this only shapes and labels.
 */

export interface DeliverySlot {
  id: string;
  /** "HH:MM:SS" as the database sends it. */
  departureTime: string;
  /** False once the window is past its cut-off, too far ahead, full or switched off — never says which. */
  available: boolean;
}

/** "18:00:00" -> "18:00". */
export function formatDepartureTime(time: string): string {
  return time.slice(0, 5);
}

export function slotLabel(slot: DeliverySlot): string {
  return `יציאה ב-${formatDepartureTime(slot.departureTime)}`;
}

/** The slot the form starts on: the earliest one that can still take an order. */
export function firstAvailableSlotId(slots: DeliverySlot[]): string | null {
  return slots.find((slot) => slot.available)?.id ?? null;
}

/** A delivery order must pick a window exactly when the owner has defined any (the database enforces the same). */
export function isWindowRequired(slots: DeliverySlot[] | null): boolean {
  return slots !== null && slots.length > 0;
}

/** Structural check of `get_delivery_slots()`'s answer; null when it is not the expected shape. */
export function parseDeliverySlots(value: unknown): DeliverySlot[] | null {
  if (!Array.isArray(value)) return null;
  const slots: DeliverySlot[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) return null;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.departure_time !== "string" || typeof r.available !== "boolean") return null;
    slots.push({ id: r.id, departureTime: r.departure_time, available: r.available });
  }
  return slots.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

/** A line for the order page / order list: "משלוח יוצא ב-18:00", or null when the order has no window. */
export function departureNote(time: string | null | undefined): string | null {
  return time ? `משלוח יוצא ב-${formatDepartureTime(time)}` : null;
}

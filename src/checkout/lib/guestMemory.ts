/**
 * A guest's delivery details, remembered ONLY in this browser (localStorage) so a repeat order doesn't mean
 * retyping everything. Never sent anywhere except inside an order the guest submits; never contains the age/terms
 * confirmations or the payment method (those start fresh every time); removed by the visible "forget" link, and
 * dropped when the visitor becomes a club member (their profile is the memory then).
 *
 * `storage` is injectable (defaults to `localStorage`) so the parsing/limits are unit-testable without a browser,
 * same as idempotency.ts.
 */
export const GUEST_DETAILS_KEY = "balagan_guest_details_v1";

export interface GuestDetails {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercomCode: string;
  notes: string;
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const FIELDS: readonly (keyof GuestDetails)[] = [
  "firstName", "lastName", "phone", "email", "street", "houseNumber", "entrance", "floor", "apartment", "intercomCode", "notes",
];
const MAX_LENGTH = 300;

/** Defensive parse: only known string fields survive, each capped; anything else (or all-empty) means "nothing remembered". */
export function parseGuestDetails(raw: string | null): GuestDetails | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const details = Object.fromEntries(
      FIELDS.map((field) => [field, typeof record[field] === "string" ? (record[field] as string).trim().slice(0, MAX_LENGTH) : ""])
    ) as unknown as GuestDetails;
    return FIELDS.some((field) => details[field] !== "") ? details : null;
  } catch {
    return null;
  }
}

export function readGuestDetails(storage: KeyValueStorage = window.localStorage): GuestDetails | null {
  try {
    return parseGuestDetails(storage.getItem(GUEST_DETAILS_KEY));
  } catch {
    return null;
  }
}

export function saveGuestDetails(details: GuestDetails, storage: KeyValueStorage = window.localStorage): void {
  try {
    const kept = Object.fromEntries(FIELDS.map((field) => [field, String(details[field] ?? "").trim().slice(0, MAX_LENGTH)]));
    storage.setItem(GUEST_DETAILS_KEY, JSON.stringify(kept));
  } catch {
    // storage unavailable (private mode, quota) — the next order is simply typed again
  }
}

export function clearGuestDetails(storage: KeyValueStorage = window.localStorage): void {
  try {
    storage.removeItem(GUEST_DETAILS_KEY);
  } catch {
    // nothing to clear
  }
}

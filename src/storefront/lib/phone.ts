/**
 * Israeli phone helpers. `normalizeIsraeliPhone` mirrors the database's `normalize_il_phone()`
 * (supabase/migrations/0012_customers.sql) case for case — tests/account/phone.unit.spec.ts pins both to the
 * same examples — so what the form considers a valid club number is exactly what `join_club()` will accept.
 */

/**
 * The guest checkout's phone rule, unchanged: any 9-digit landline or 10-digit mobile in its local form, any of
 * the usual separators. (Deliberately looser than `normalizeIsraeliPhone`: a guest may order with a landline.)
 */
export function isValidIsraeliPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return /^0\d{8,9}$/.test(digits);
}

/**
 * '050-123-4567' / '+972 50 123 4567' / '972501234567' / '00972501234567' / '+972 (0)50…' -> '+972501234567'.
 * Returns null when it is not a valid Israeli number (mobile 05x, landline 02/03/04/08/09, VoIP 07x).
 */
export function normalizeIsraeliPhone(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").replace(/[^0-9+]/g, "");
  const digits = cleaned.replace(/[^0-9]/g, "");
  const local = /^(\+|00)?972/.test(cleaned) ? "0" + digits.replace(/^(00)?972(0)?/, "") : digits;
  return /^0(5[0-9]{8}|[2-489][0-9]{7}|7[0-9]{8})$/.test(local) ? "+972" + local.slice(1) : null;
}

/** Club identity is an SMS-capable number: a mobile (05x) only. Takes a normalized `+972…` number. */
export function isIsraeliMobile(e164: string | null): e164 is string {
  return e164 !== null && /^\+9725[0-9]{8}$/.test(e164);
}

/** '+972501234567' -> '050-123-4567' (display only). Anything else comes back unchanged. */
export function formatLocalPhone(e164: string): string {
  const match = /^\+9725([0-9])([0-9]{3})([0-9]{4})$/.exec(e164);
  return match ? `05${match[1]}-${match[2]}-${match[3]}` : e164;
}

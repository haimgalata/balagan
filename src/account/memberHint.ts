/**
 * The ONLY account code that lives in the customer's main bundle: a tiny, non-sensitive note that this browser
 * is signed in as a club member, so the header can say "היי דנה" without loading any auth code (or touching the
 * network) on every page view. It carries no token and no phone number, and it is never trusted for anything —
 * the real session is verified by the lazily loaded account module, which also keeps this note in sync.
 */
import { useSyncExternalStore } from "react";

export const MEMBER_HINT_KEY = "balagan_member_hint_v1";
const CHANGE_EVENT = "balagan:member-hint";

export interface MemberHint {
  /** null when the member has not given a name yet (it is learned from their first order). */
  firstName: string | null;
}

/** Defensive parse of whatever is in storage. Anything unexpected means "no hint". */
export function parseMemberHint(raw: string | null): MemberHint | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const firstName = (value as Record<string, unknown>).firstName;
    if (firstName === null || firstName === undefined) return { firstName: null };
    if (typeof firstName !== "string") return null;
    const trimmed = firstName.trim().slice(0, 30);
    return { firstName: trimmed === "" ? null : trimmed };
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(MEMBER_HINT_KEY);
  } catch {
    return null;
  }
}

export function readMemberHint(): MemberHint | null {
  return parseMemberHint(readRaw());
}

export function writeMemberHint(hint: MemberHint | null): void {
  try {
    if (hint === null) window.localStorage.removeItem(MEMBER_HINT_KEY);
    else window.localStorage.setItem(MEMBER_HINT_KEY, JSON.stringify({ firstName: hint.firstName }));
  } catch {
    // storage unavailable (private mode, quota) — the header simply keeps showing the guest label
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab signed in/out
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The raw string is the snapshot, so React only re-renders when the stored value actually changes. */
export function useMemberHint(): MemberHint | null {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return parseMemberHint(raw);
}

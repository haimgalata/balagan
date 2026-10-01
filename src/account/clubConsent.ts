/**
 * The one mandatory checkbox shown when someone registers (becomes a club member): 21+ AND agreement to receive
 * written marketing. It is a REGISTRATION checkbox — separate from, and never merged into, the per-order 18+ and
 * terms checkboxes at checkout (see CLAUDE.md). Anyone unwilling simply orders as a guest.
 *
 * The exact wording is stored with the consent (`customer_consents.wording_version`) as proof of what was
 * agreed to. Changing the text means bumping CLUB_CONSENT_WORDING_VERSION. The wording needs the owner's
 * lawyer's sign-off before real use (Israeli Spam Law §30A, Privacy Protection Law amendment 13).
 */
export const CLUB_CONSENT_WORDING_VERSION = "v1";

export const CLUB_CONSENT_TEXT =
  "אני מעל גיל 21 ומאשר/ת קבלת דיוור שיווקי כתוב (קופונים, מבצעים ותכני מוצרי עישון) ב-SMS ו/או במייל. אפשר להסיר את ההסכמה בכל עת.";

export const CLUB_CONSENT_CHANNELS = ["sms", "email"] as const;

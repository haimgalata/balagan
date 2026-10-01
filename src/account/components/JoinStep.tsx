import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { CLUB_CONSENT_CHANNELS, CLUB_CONSENT_TEXT, CLUB_CONSENT_WORDING_VERSION } from "@/account/clubConsent";
import { describeMemberError, MemberApiError } from "@/account/memberApi";

/**
 * The only thing between a verified phone and club membership: ONE mandatory checkbox (21+ and written-marketing
 * consent). Declining is fine — the customer just orders as a guest ("לא עכשיו"), which also signs the half-made
 * session out so nothing is left behind.
 */
export function JoinStep() {
  const { join, signOut } = useCustomerSession();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!agreed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await join({
        age21Confirmed: true,
        marketingConsent: true,
        wordingVersion: CLUB_CONSENT_WORDING_VERSION,
        channels: [...CLUB_CONSENT_CHANNELS],
        source: "registration",
      });
    } catch (caught) {
      setError(describeMemberError(caught instanceof MemberApiError ? caught.code : "NETWORK_ERROR"));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 px-6 py-8">
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-semibold text-brand-text">המספר אומת. עוד אישור אחד ואתם במועדון</p>
        <p className="text-sm text-brand-text-muted">
          חברי המועדון מקבלים הטבות ומבצעים, ובהזמנה הבאה הפרטים והכתובת כבר מחכים להם.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="club-consent" className="flex items-start gap-3 text-sm text-brand-text">
          <input
            id="club-consent"
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--color-gold))]"
          />
          {/* TODO(legal): link the terms / privacy policy here once those pages exist. */}
          <span>{CLUB_CONSENT_TEXT}</span>
        </label>
        {error && (
          <p role="alert" className="text-xs text-brand-danger">
            {error}
          </p>
        )}
      </div>

      <Button type="button" size="lg" disabled={!agreed || busy} onClick={submit}>
        {busy ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : "הצטרפות למועדון"}
      </Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void signOut()}>
        לא עכשיו, אמשיך כאורח
      </Button>
    </div>
  );
}

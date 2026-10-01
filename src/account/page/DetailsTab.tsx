import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { describeMemberError, MemberApiError, updateMyProfile } from "@/account/memberApi";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import type { CustomerProfile } from "@/account/types";
import { Card, Notice, TextField } from "@/account/page/pageUi";
import { useMemberRun } from "@/account/page/useMemberRun";

const config = getCatalogConfig();
const isValidEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());

/** "הפרטים שלי": name and e-mail. The phone is the member's identity — shown, never edited here (changing it means a new login). */
export function DetailsTab({ profile }: { profile: CustomerProfile }) {
  const run = useMemberRun();
  const { refreshProfile } = useCustomerSession();
  const [firstName, setFirstName] = useState(profile.firstName ?? "");
  const [lastName, setLastName] = useState(profile.lastName ?? "");
  const [email, setEmail] = useState(profile.email ?? "");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "danger"; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    if (email.trim() !== "" && !isValidEmail(email)) {
      setEmailError("נא להזין כתובת אימייל תקינה");
      return;
    }
    setEmailError(undefined);
    setBusy(true);
    try {
      await run((token) => updateMyProfile(config, token, profile.id, { firstName, lastName, email }));
      await refreshProfile(); // also refreshes the greeting in the header
      setMessage({ kind: "success", text: "הפרטים נשמרו." });
    } catch (error) {
      setMessage({ kind: "danger", text: describeMemberError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="שם פרטי" id="profile-first-name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <TextField label="שם משפחה" id="profile-last-name" value={lastName} onChange={setLastName} autoComplete="family-name" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-brand-text">טלפון</span>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text">
            <span dir="ltr">{formatLocalPhone(profile.phone)}</span>
            <span className="flex items-center gap-1 text-xs text-brand-text-muted">
              <Lock size={13} aria-hidden="true" />
              מאומת. לא ניתן לשינוי כאן
            </span>
          </div>
        </div>

        <TextField
          label="אימייל (אופציונלי)"
          id="profile-email"
          value={email}
          onChange={setEmail}
          error={emailError}
          type="email"
          inputMode="email"
          dir="ltr"
          autoComplete="email"
          placeholder="לשליחת אישורי הזמנה"
        />

        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "שומרים…" : "שמירה"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

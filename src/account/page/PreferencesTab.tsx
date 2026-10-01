import { useState } from "react";
import { Button } from "@/shared/ui/Button";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { deleteMyAccount, describeMemberError, MemberApiError, setMarketingConsent } from "@/account/memberApi";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import type { CustomerProfile } from "@/account/types";
import { Card, Notice } from "@/account/page/pageUi";
import { useMemberRun } from "@/account/page/useMemberRun";

const config = getCatalogConfig();
type Channel = "sms" | "email";

/**
 * "העדפות": the marketing consent the member gave when joining can be changed any time (this is a legal requirement,
 * and it is as easy to withdraw as it was to give). Withdrawing does NOT delete the account. Below it: sign out and
 * the right to be forgotten.
 */
export function PreferencesTab({ profile, onDeleted }: { profile: CustomerProfile; onDeleted: () => void }) {
  const run = useMemberRun();
  const { refreshProfile, signOut } = useCustomerSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const channels = profile.marketingChannels.filter((c): c is Channel => c === "sms" || c === "email");

  const saveConsent = async (granted: boolean, nextChannels: Channel[]) => {
    setBusy(true);
    setMessage(null);
    try {
      await run((token) => setMarketingConsent(config, token, granted, nextChannels));
      await refreshProfile();
      setMessage({ kind: "success", text: granted ? "ההעדפות נשמרו." : "הסרנו אתכם מרשימת הדיוור השיווקי. החשבון והמועדון נשארים כרגיל." });
    } catch (error) {
      setMessage({ kind: "danger", text: describeMemberError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR") });
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = (channel: Channel) => {
    const next = channels.includes(channel) ? channels.filter((c) => c !== channel) : [...channels, channel];
    if (next.length === 0) return; // at least one channel while consent is on; to stop entirely, switch the main option off
    void saveConsent(true, next);
  };

  const removeAccount = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await run((token) => deleteMyAccount(config, token));
      onDeleted(); // first, so the page shows the confirmation (not the login panel) once the session ends
      await signOut();
    } catch (error) {
      setMessage({ kind: "danger", text: describeMemberError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR") });
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-brand-text">דיוור שיווקי</h2>
        <label htmlFor="pref-marketing" className="flex items-start gap-3 text-sm text-brand-text">
          <input
            id="pref-marketing"
            type="checkbox"
            checked={profile.marketing}
            disabled={busy}
            onChange={(event) => void saveConsent(event.target.checked, event.target.checked ? (channels.length > 0 ? channels : ["sms", "email"]) : [])}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--color-gold))]"
          />
          <span>אני מעוניין/ת לקבל קופונים, מבצעים ותכני מוצרי עישון בהודעות כתובות.</span>
        </label>

        {profile.marketing && (
          <fieldset className="flex flex-wrap gap-x-5 gap-y-2 ps-8">
            <legend className="sr-only">ערוצי דיוור</legend>
            {(["sms", "email"] as const).map((channel) => (
              <label key={channel} htmlFor={`pref-${channel}`} className="flex items-center gap-2 text-sm text-brand-text">
                <input
                  id={`pref-${channel}`}
                  type="checkbox"
                  checked={channels.includes(channel)}
                  disabled={busy || (channels.length === 1 && channels.includes(channel))}
                  onChange={() => toggleChannel(channel)}
                  className="h-4 w-4 accent-[rgb(var(--color-gold))]"
                />
                {channel === "sms" ? "SMS" : "אימייל"}
              </label>
            ))}
          </fieldset>
        )}
        <p className="text-xs text-brand-text-muted">
          ביטול הדיוור לא מוחק את החשבון ולא מונע הזמנות. הודעות על הזמנה שביצעתם (כמו אישור או קבלה) אינן דיוור שיווקי.
        </p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-brand-text">התנתקות</h2>
        <div>
          <Button type="button" variant="outline" onClick={() => void signOut()} disabled={busy}>
            התנתקות מהמכשיר הזה
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-brand-text">מחיקת החשבון</h2>
        <p className="text-sm text-brand-text-muted">
          נמחקים הפרטים האישיים והכתובות השמורות, ומוסרים אתכם מהדיוור. הזמנות שכבר בוצעו נשמרות אצלנו כנדרש לצורכי הנהלת חשבונות, אך אינן מקושרות עוד לחשבון.
        </p>
        {confirmingDelete ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="אישור מחיקת חשבון">
            <span className="text-sm font-medium text-brand-danger">למחוק את החשבון לצמיתות?</span>
            <Button type="button" size="sm" disabled={busy} onClick={() => void removeAccount()}>
              {busy ? "מוחקים…" : "כן, למחוק"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(false)}>
              ביטול
            </Button>
          </div>
        ) : (
          <div>
            <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)}>
              מחיקת החשבון שלי
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

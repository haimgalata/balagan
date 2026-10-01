import { Loader2, User } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { CustomerSessionProvider, useCustomerSession } from "@/account/CustomerSessionContext";
import { LoginPanel } from "@/account/components/LoginPanel";
import { JoinStep } from "@/account/components/JoinStep";
import { describeMemberError } from "@/account/memberApi";

/**
 * The state-driven body shared by the account drawer and checkout's login drawer. `onContinueAsGuest` adds the
 * always-available "no thanks" door to the login step (checkout passes it; closing the drawer is the same thing).
 */
export function AccountPanelBody({ onContinueAsGuest }: { onContinueAsGuest?: () => void }) {
  const { state, retry, signOut } = useCustomerSession();

  switch (state.status) {
    case "loading":
      return (
        <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-brand-text-muted" role="status">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          רגע…
        </div>
      );

    case "needs-join":
      return <JoinStep />;

    case "member": {
      const { profile } = state;
      return (
        <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full border border-brand-border bg-brand-bg-elevated text-brand-gold">
            <User size={26} aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-brand-text">
              {profile.firstName ? `היי ${profile.firstName}` : "היי"}, ברוכים הבאים למועדון בלאגן
            </p>
            <p className="text-sm text-brand-text-muted" dir="ltr">
              {formatLocalPhone(profile.phone)}
            </p>
          </div>
          <p className="max-w-xs text-sm text-brand-text-muted">
            בהזמנה הבאה נמלא עבורכם את הפרטים והכתובת. ההזמנות והכתובות השמורות שלכם נמצאות באזור האישי.
          </p>
          <a
            href="/account"
            className="inline-flex items-center justify-center rounded-lg bg-brand-gold px-4 py-2.5 text-sm font-semibold text-brand-bg transition-colors hover:bg-brand-gold-hover"
          >
            לאזור האישי שלי
          </a>
          <Button type="button" variant="ghost" onClick={() => void signOut()}>
            התנתקות
          </Button>
        </div>
      );
    }

    case "error":
      return (
        <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
          <p role="alert" className="text-sm text-brand-danger">
            {describeMemberError(state.code)}
          </p>
          <Button type="button" onClick={() => void retry()}>
            נסו שוב
          </Button>
          <Button type="button" variant="ghost" onClick={() => void signOut()}>
            התנתקות
          </Button>
        </div>
      );

    case "guest":
    case "unavailable":
    default:
      return <LoginPanel onContinueAsGuest={onContinueAsGuest} />;
  }
}

/**
 * The content of the account drawer when club login is enabled in this build. Lives in its own lazily loaded chunk
 * (see AccountDrawer.tsx), so none of it is in the main bundle.
 */
export default function AccountPanel() {
  return (
    <CustomerSessionProvider>
      <div className="h-1 bg-brand-tobacco" aria-hidden="true" />
      <AccountPanelBody />
    </CustomerSessionProvider>
  );
}

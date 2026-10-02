import { useEffect, useState, type ReactNode } from "react";
import { Loader2, User } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { Drawer } from "@/shared/ui/Drawer";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { AccountPanelBody } from "@/account/AccountPanel";

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-brand-border bg-brand-bg-elevated p-4 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}

/**
 * The one decision shown BEFORE the details form (login/registration always happens before payment): sign in or join
 * the club — or just keep going as a guest, which is the default and needs no click. The login itself reuses the
 * account drawer's panel (phone -> code -> the one mandatory confirmation for a new phone) in a drawer, so a
 * customer never leaves the checkout and the cart/form stay exactly where they were.
 */
export function CheckoutIdentity({ open: openProp, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const { state, signOut, retry } = useCustomerSession();
  // The drawer can also be opened from elsewhere in checkout (the locked coupon box), so the page may own the state.
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = onOpenChange ?? setInnerOpen;

  // Reaching "member" (login finished) closes the drawer; the form behind it then switches to their saved details.
  useEffect(() => {
    if (state.status === "member") setOpen(false);
  }, [state.status]);

  if (state.status === "loading" || state.status === "unavailable") return null;

  let card: ReactNode;
  switch (state.status) {
    case "member":
      card = (
        <Card>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-border bg-brand-bg text-brand-gold">
              <User size={20} aria-hidden="true" />
            </span>
            <div className="flex flex-col">
              <p className="text-sm font-semibold text-brand-text">
                {state.profile.firstName ? `היי ${state.profile.firstName}, ` : ""}מחוברים כחברי מועדון בלאגן
              </p>
              <p className="text-xs text-brand-text-muted" dir="ltr">
                {formatLocalPhone(state.profile.phone)}
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
            התנתקות
          </Button>
        </Card>
      );
      break;

    case "needs-join":
      card = (
        <Card>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-brand-text">המספר אומת, אבל ההצטרפות למועדון לא הושלמה</p>
            <p className="text-xs text-brand-text-muted">אפשר להשלים אותה עכשיו, או להמשיך כאורח למטה.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => setOpen(true)}>
            השלמת הצטרפות
          </Button>
        </Card>
      );
      break;

    case "error":
      card = (
        <Card>
          <p role="alert" className="text-sm text-brand-text-muted">
            לא הצלחנו לטעון את פרטי החבר. אפשר לנסות שוב, או להמשיך כאורח למטה.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void retry()}>
              נסו שוב
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
              התנתקות
            </Button>
          </div>
        </Card>
      );
      break;

    default:
      card = (
        <Card>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-brand-text">חברי מועדון בלאגן מזמינים מהר יותר</p>
            <p className="text-xs text-brand-text-muted">
              קוד ב-SMS ואתם בפנים: הפרטים והכתובת נשמרים להזמנה הבאה. אפשר גם להמשיך כאורח, בלי להירשם.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setOpen(true)}>
            התחברות / הצטרפות למועדון
          </Button>
        </Card>
      );
  }

  return (
    <>
      {card}
      <Drawer isOpen={open} onClose={() => setOpen(false)} title="התחברות למועדון" side="right" id="checkout-login-panel">
        <div className="h-1 bg-brand-tobacco" aria-hidden="true" />
        {open || state.status === "needs-join" ? (
          <AccountPanelBody onContinueAsGuest={() => setOpen(false)} />
        ) : (
          <div className="flex items-center justify-center px-6 py-16" role="status">
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          </div>
        )}
      </Drawer>
    </>
  );
}

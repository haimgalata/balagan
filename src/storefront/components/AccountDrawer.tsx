import { lazy, Suspense, useState } from "react";
import { Bell, MapPin, Package, User } from "lucide-react";
import { Drawer } from "@/shared/ui/Drawer";
import { useMemberHint } from "@/account/memberHint";

/**
 * Club login panel — its own lazily loaded chunk, and only part of builds made with a login adapter
 * (`__CUSTOMER_AUTH__`, see vite.config.ts). With it "off" (production today) this is `null`, the whole account
 * module is dropped from the bundle, and the drawer below is the inert "coming soon" panel.
 */
const AccountPanel = __CUSTOMER_AUTH__ === "off" ? null : lazy(() => import("@/account/AccountPanel"));
/** Same idea: with the login off there is no member hint to read, so that code is not shipped either. The choice is a build-time constant, so the hook is called the same way on every render. */
const useHint = __CUSTOMER_AUTH__ === "off" ? () => null : useMemberHint;

const UPCOMING_FEATURES = [
  { icon: Package, label: "היסטוריית הזמנות" },
  { icon: MapPin, label: "כתובות למשלוח" },
  { icon: Bell, label: "מעקב אחר הזמנה" },
];

/**
 * Account/login entry point — self-contained (trigger button + panel),
 * the same pattern `Search` uses. The panel reuses `Drawer` with
 * `side="right"`, mirroring `CartDrawer`'s `side="left"`, so the
 * header's two icon buttons open symmetric side panels.
 *
 * Until a login adapter is chosen (`__CUSTOMER_AUTH__ === "off"`) this is the
 * on-brand "coming soon" surface that previews what the account area will
 * unlock — entirely inert, no network. With one, it hosts the club login
 * (phone -> code -> join), loaded on first open so the main bundle and the
 * homepage's network traffic are unchanged. A tiny local "member hint" lets
 * the trigger greet a returning member without loading any of that.
 */
export function AccountDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  // Mount the panel once it has been opened (and keep it, so a half-finished login survives closing the drawer).
  const [hasOpened, setHasOpened] = useState(false);
  const memberHint = useHint();
  const greeting = AccountPanel && memberHint ? (memberHint.firstName ? `היי ${memberHint.firstName}` : "היי") : null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setIsOpen(true);
          setHasOpened(true);
        }}
        aria-label={greeting ? `אזור אישי: ${greeting}` : "התחברות / אזור אישי"}
        aria-expanded={isOpen}
        aria-controls="account-drawer-panel"
        className="flex items-center gap-1.5 rounded-md p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-2"
      >
        <User size={20} />
        <span className="hidden text-sm font-medium lg:inline">{greeting ?? "אזור אישי"}</span>
      </button>

      <Drawer
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="אזור אישי"
        side="right"
        id="account-drawer-panel"
      >
        {AccountPanel ? (
          hasOpened && (
            <Suspense
              fallback={
                <div className="px-6 py-16 text-center text-sm text-brand-text-muted" role="status">
                  רגע…
                </div>
              }
            >
              <AccountPanel />
            </Suspense>
          )
        ) : (
          <>
            <div className="h-1 bg-brand-tobacco" aria-hidden="true" />
            <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-brand-border bg-brand-bg-elevated text-brand-gold">
                <User size={26} />
              </span>
              <div className="flex flex-col gap-1.5">
                <p className="text-base font-semibold text-brand-text">בקרוב: התחברות לאזור האישי</p>
                <p className="max-w-xs text-sm text-brand-text-muted">
                  בקרוב תוכלו להתחבר ולנהל כאן את הפרטים וההזמנות שלכם. בינתיים ניתן לרכוש טלפונית או בחנות.
                </p>
              </div>

              <ul className="mt-2 flex w-full max-w-xs flex-col gap-2 text-start">
                {UPCOMING_FEATURES.map(({ icon: Icon, label }) => (
                  <li
                    key={label}
                    className="flex items-center gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated px-4 py-3 text-sm text-brand-text-muted"
                  >
                    <Icon size={18} className="shrink-0 text-brand-gold" aria-hidden="true" />
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

import { useState } from "react";
import { Bell, MapPin, Package, User } from "lucide-react";
import { Drawer } from "@/shared/ui/Drawer";

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
 * No real auth exists yet (see CLAUDE.md) — this replaces the old
 * `alert()` placeholder with an on-brand surface that previews what a
 * real account area will unlock later. Entirely inert.
 */
export function AccountDrawer() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="התחברות / אזור אישי"
        aria-expanded={isOpen}
        aria-controls="account-drawer-panel"
        className="flex items-center gap-1.5 rounded-md p-2.5 text-brand-text outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:p-2"
      >
        <User size={20} />
        <span className="hidden text-sm font-medium lg:inline">אזור אישי</span>
      </button>

      <Drawer
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="אזור אישי"
        side="right"
        id="account-drawer-panel"
      >
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
      </Drawer>
    </>
  );
}

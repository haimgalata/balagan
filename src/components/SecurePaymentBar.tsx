import { ShieldCheck, CreditCard, Smartphone, Banknote } from "lucide-react";

const methods = [
  { icon: ShieldCheck, label: "תשלום מאובטח" },
  { icon: CreditCard, label: "ויזה" },
  { icon: Smartphone, label: "Apple Pay" },
  { icon: Banknote, label: "מזומן" },
];

/**
 * Compact trust strip: secure-payment reassurance + the accepted payment
 * methods. Icons are lucide-react (already the project's only icon
 * library) — no new dependency.
 */
export function SecurePaymentBar() {
  return (
    <section className="border-b border-brand-border bg-brand-bg-secondary">
      <div className="mx-auto flex max-w-container flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-3 sm:gap-x-8 sm:px-6">
        {methods.map(({ icon: Icon, label }) => (
          <span
            key={label}
            className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-brand-text-muted sm:text-sm"
          >
            <Icon size={16} className="shrink-0 text-brand-gold" />
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

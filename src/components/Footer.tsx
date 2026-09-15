import { Facebook, Instagram, Phone } from "lucide-react";

/** Site footer — minimal: business blurb, contact, socials, legal line. */
export function Footer() {
  return (
    <footer className="border-t border-brand-border bg-brand-bg-secondary">
      <div className="mx-auto flex max-w-container flex-col items-center gap-4 px-4 py-6 text-center sm:px-6 sm:py-8">
        <p className="max-w-md text-sm leading-relaxed text-brand-text-muted">
          מרכז הסיגריות והטבק בלגן — חנות ותיקה למוצרי עישון וטבק.
        </p>

        <a
          href="tel:089945190"
          className="flex items-center gap-2 text-sm text-brand-text-muted transition-colors hover:text-brand-gold"
        >
          <Phone size={16} />
          08-994-5190
        </a>

        <div className="flex items-center gap-3">
          <a
            href="#"
            aria-label="פייסבוק"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-border text-brand-text-muted transition-colors hover:border-brand-gold hover:text-brand-gold"
          >
            <Facebook size={15} />
          </a>
          <a
            href="#"
            aria-label="אינסטגרם"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-border text-brand-text-muted transition-colors hover:border-brand-gold hover:text-brand-gold"
          >
            <Instagram size={15} />
          </a>
        </div>
      </div>

      <div className="border-t border-brand-border px-4 py-4 text-center sm:px-6">
        <p className="text-xs text-brand-text-muted">
          המכירה אסורה לבני 21 ומטה. העישון מזיק לבריאות.
        </p>
        <p className="mt-1 text-xs text-brand-text-muted">
          © {new Date().getFullYear()} בלגן - מרכז הסיגריות והטבק. כל הזכויות שמורות.
        </p>
      </div>
    </footer>
  );
}
